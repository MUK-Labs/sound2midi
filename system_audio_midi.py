#!/usr/bin/env python3
"""Experimental, continuous system-audio pitch approximation to MIDI.

Local DSP only. No model downloads, audio recording, or network requests.
See README.md for routing, limits, and controls. Python 3.10+.
"""
from __future__ import annotations

import os
# Small matrix solves work best without a pool of BLAS worker threads.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")

import argparse
import math
import signal
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter
from scipy.optimize import nnls


def note_name(note: int) -> str:
    return ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")[note % 12] + str(note // 12 - 1)


@dataclass
class Event:
    kind: str
    note: int
    velocity: int = 0


class Detector:
    """Joint nonnegative harmonic-template fit, not a trained AMT model."""

    def __init__(self, rate=48000, window=4096, min_note=48, max_note=96, gate_db=-48):
        self.rate, self.window, self.gate_db = rate, window, gate_db
        self.notes = np.arange(min_note, max_note + 1)
        self.taper = np.hanning(window)
        frequencies = np.fft.rfftfreq(window, 1 / rate)
        self.keep = (frequencies >= 65) & (frequencies <= min(8000, rate / 2))
        self.freqs = frequencies[self.keep]
        # Mild frequency weighting; capped to avoid boosting high-frequency noise.
        self.weight = np.clip((self.freqs / 440) ** 0.3, 0.65, 2.0)
        samples = np.arange(window) / rate
        templates, fundamental_bins = [], []
        for note in self.notes:
            f0 = 440 * 2 ** ((note - 69) / 12)
            partials = []
            for harmonic in range(1, 13):
                frequency = f0 * harmonic
                if frequency >= min(8000, rate / 2 - rate / window):
                    break
                # Match the actual Hann-window leakage, including off-bin tones.
                tone = np.cos(2 * np.pi * frequency * samples)
                partials.append(np.abs(np.fft.rfft(tone * self.taper)))
            # Allow bright, soft and near-sinusoidal timbres. One fixed spectral
            # envelope otherwise invents adjacent notes to fit a soft tone.
            for rolloff in (1.0, 2.5, 16.0):
                profile = sum((p / (h + 1) ** rolloff for h, p in enumerate(partials)), np.zeros_like(frequencies))
                profile = profile[self.keep]
                profile = np.maximum(profile - 0.8 * median_filter(profile, size=9, mode="nearest"), 0)
                column = profile * self.weight
                column /= max(np.linalg.norm(column), 1e-12)
                templates.append(column)
            fundamental_bins.append(np.flatnonzero(np.abs(self.freqs - f0) <= 1.5 * rate / window))
        self.templates = np.column_stack(templates)
        # Penalize the sum of coefficients mildly. This favours explaining a
        # harmonic series with one pitch over many weaker octave/partial guesses.
        self.fit_matrix = np.vstack((self.templates, np.full((1, len(templates)), .10)))
        self.fundamental_bins = fundamental_bins

    def analyse(self, audio):
        audio = np.asarray(audio, dtype=np.float64)
        if audio.ndim == 1:
            audio = audio[:, None]
        rms = float(np.sqrt(np.mean(audio * audio)))
        db = 20 * np.log10(max(rms, 1e-12))
        recent_rms = float(np.sqrt(np.mean(audio[-min(512, len(audio)):] ** 2)))
        if db < self.gate_db or 20 * np.log10(max(recent_rms, 1e-12)) < self.gate_db or not np.all(np.isfinite(audio)):
            return {}, float(db)
        # Stereo power combination preserves pitches even in antiphase channels.
        spectra = np.abs(np.fft.rfft(audio * self.taper[:, None], axis=0))
        spectrum = np.sqrt(np.mean(spectra * spectra, axis=1))[self.keep]
        flatness = np.exp(np.mean(np.log(spectrum + 1e-12))) / (spectrum.mean() + 1e-12)
        if flatness > 0.65:
            return {}, float(db)
        # Suppress a local broadband floor (drums/noise), retain tonal ridges.
        floor = median_filter(spectrum, size=9, mode="nearest")
        tonal = np.maximum(spectrum - 0.8 * floor, 0)
        # One spectral lobe should not count as several neighbouring fundamentals.
        # Refine local peaks by log-parabolic interpolation, then assign each to
        # its nearest semitone. Closely spaced unresolved pitches may be missed.
        peaks = np.flatnonzero((spectrum[1:-1] > spectrum[:-2]) & (spectrum[1:-1] >= spectrum[2:])) + 1
        evidence = set()
        for index in peaks:
            if tonal[index] < tonal.max(initial=0) * .025:
                continue
            left, middle, right = np.log(spectrum[index-1:index+2] + 1e-12)
            curvature = left - 2 * middle + right
            shift = np.clip(.5 * (left - right) / curvature, -.5, .5) if abs(curvature) > 1e-12 else 0
            hz = self.freqs[index] + shift * self.rate / self.window
            evidence.add(round(69 + 12 * np.log2(hz / 440)))
        target = tonal * self.weight
        target /= max(np.linalg.norm(target), 1e-12)
        try:
            coefficients, _ = nnls(self.fit_matrix, np.append(target, 0), maxiter=10 * len(self.notes))
            amplitudes = coefficients.reshape(len(self.notes), 3).sum(axis=1)
        except RuntimeError:
            return {}, float(db)
        peak = float(amplitudes.max(initial=0))
        if peak < 0.06:
            return {}, float(db)
        floor_peak = float(tonal.max(initial=0)) * 0.025
        result = {}
        for i, note in enumerate(self.notes):
            bins = self.fundamental_bins[i]
            # Require some fundamental evidence: conservative against subharmonics.
            if int(note) in evidence and bins.size and tonal[bins].max() >= floor_peak and amplitudes[i] > 0:
                result[int(note)] = float(amplitudes[i] / peak)
        return result, float(db)


class NoteTracker:
    def __init__(self, threshold=.20, polyphony=6, attack_ms=20, release_ms=80):
        self.threshold, self.polyphony = threshold, polyphony
        self.attack, self.release = attack_ms / 1000, release_ms / 1000
        self.active = {}
        self.pending = {}

    def clear(self):
        events = [Event("note_off", note) for note in sorted(self.active)]
        self.active.clear()
        self.pending.clear()
        return events

    def update(self, scores, now, db=-20):
        events = []
        # Strong existing notes have a small ranking advantage; release uses a
        # lower threshold, so borderline notes do not repeatedly toggle.
        ranked = sorted(scores, key=lambda n: scores[n] * (1.15 if n in self.active else 1), reverse=True)
        eligible = {n for n in ranked if scores[n] >= self.threshold * (0.65 if n in self.active else 1)}
        selected = [n for n in ranked if n in eligible][:self.polyphony]
        for note in list(self.active):
            if note in selected:
                self.active[note] = now
            elif now - self.active[note] >= self.release:
                events.append(Event("note_off", note))
                del self.active[note]
        for note in list(self.pending):
            if note not in selected:
                del self.pending[note]
        for note in selected:
            if note in self.active:
                continue
            self.pending.setdefault(note, now)
            if now - self.pending[note] + 1e-9 >= self.attack and len(self.active) < self.polyphony:
                loudness = np.clip((db + 48) / 42, 0, 1)
                velocity = int(np.clip(35 + 80 * loudness * np.sqrt(scores[note]), 1, 127))
                events.append(Event("note_on", note, velocity))
                self.active[note] = now
                del self.pending[note]
        return events


class LatestAudio:
    """Bounded ring; consumer always reads the newest complete window."""
    def __init__(self, window, channels):
        self.data = np.zeros((window, channels), dtype=np.float32)
        self.position = self.total = self.filled = self.generation = 0
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.skipped = self.overflows = 0
        self.discontinuity = False

    def push(self, audio, bad=False):
        if not self.lock.acquire(blocking=False):
            self.skipped += 1
            self.discontinuity = True
            return
        try:
            count = len(audio)
            self.total += count
            if bad or self.discontinuity:
                self.filled = 0
                self.generation += 1
                self.discontinuity = False
                if bad:
                    self.overflows += 1
            if count >= len(self.data):
                self.data[:] = audio[-len(self.data):]
                self.position = 0
            else:
                first = min(count, len(self.data) - self.position)
                self.data[self.position:self.position + first] = audio[:first]
                if first < count:
                    self.data[:count - first] = audio[first:]
                self.position = (self.position + count) % len(self.data)
            self.filled = min(len(self.data), self.filled + count)
        finally:
            self.lock.release()
        self.ready.set()

    def snapshot(self):
        with self.lock:
            self.ready.clear()
            if self.filled < len(self.data):
                return None, self.total, self.generation
            frame = np.concatenate((self.data[self.position:], self.data[:self.position]))
            return frame, self.total, self.generation


def make_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--list-devices", action="store_true", help="list audio inputs and exit")
    p.add_argument("--list-midi", action="store_true", help="list MIDI destinations and exit")
    p.add_argument("--device", help="audio input index or substring; auto-selects a unique BlackHole input")
    p.add_argument("--midi-port", help="existing MIDI destination; otherwise create 'System Audio MIDI'")
    p.add_argument("--no-midi", action="store_true", help="display detected notes only")
    p.add_argument("--file", type=Path, help="offline WAV diagnostic; prints events, no MIDI or playback")
    p.add_argument("--sample-rate", type=int, help="live rate; otherwise use input device's default")
    p.add_argument("--window", type=int, choices=[2048,4096,8192], default=4096, help="analysis window, samples")
    p.add_argument("--hop", type=int, default=512, help="audio block/update size, samples")
    p.add_argument("--min-note", type=int, default=48, help="lowest MIDI pitch (48 = C3)")
    p.add_argument("--max-note", type=int, default=96, help="highest MIDI pitch (96 = C7)")
    p.add_argument("--polyphony", type=int, default=6, help="maximum simultaneous MIDI notes")
    p.add_argument("--threshold", type=float, default=.20, help="relative note threshold; higher gives fewer notes")
    p.add_argument("--gate-db", type=float, default=-48, help="silence gate in dBFS")
    p.add_argument("--attack-ms", type=float, default=20, help="note confirmation hold")
    p.add_argument("--release-ms", type=float, default=80, help="missing-note release grace")
    p.add_argument("--channel", type=int, default=1, help="MIDI output channel, 1–16")
    return p


def emit(events, port, channel, stamp=None):
    if port is not None:
        import mido
        for e in events:
            port.send(mido.Message(e.kind, note=e.note, velocity=e.velocity, channel=channel - 1))
    if stamp is not None:
        for e in events:
            print(f"{stamp:8.3f}  {e.kind:8}  {note_name(e.note):4}  MIDI {e.note:3}  velocity {e.velocity:3}")


def finish_output(tracker, port, channel):
    failures = []
    # Only release notes owned by this process. Channel-wide panic controllers
    # on a shared destination could interrupt another performer's notes/pedal.
    for event in tracker.clear():
        try:
            emit([event], port, channel)
        except Exception as exc:
            failures.append(str(exc))
    if port is not None:
        try:
            port.close()
        except Exception as exc:
            failures.append(str(exc))
    return failures


def detector_for(args, rate):
    return Detector(rate, args.window, args.min_note, args.max_note, args.gate_db)


def tracker_for(args):
    return NoteTracker(args.threshold, args.polyphony, args.attack_ms, args.release_ms)


def diagnose_file(args):
    from scipy.io import wavfile
    rate, data = wavfile.read(args.file)
    if data.dtype == np.uint8:
        data = (data.astype(np.float64) - 128) / 128
    elif np.issubdtype(data.dtype, np.integer):
        data = data.astype(np.float64) / max(abs(np.iinfo(data.dtype).min), np.iinfo(data.dtype).max)
    if data.ndim == 1:
        data = data[:, None]
    if data.shape[1] > 2:
        raise ValueError("WAV diagnostic supports mono or stereo audio.")
    data = data.astype(np.float64)
    detector, tracker = detector_for(args, rate), tracker_for(args)
    tail = args.window + math.ceil(args.release_ms / 1000 * rate) + args.hop
    data = np.pad(data, ((0, tail), (0, 0)))
    frame = np.zeros((args.window, data.shape[1]))
    timings = []
    for start in range(0, len(data), args.hop):
        block = data[start:start + args.hop]
        n = len(block)
        frame[:-n] = frame[n:]
        frame[-n:] = block
        began = time.perf_counter()
        scores, db = detector.analyse(frame)
        now = (start + n) / rate
        emit(tracker.update(scores, now, db), None, args.channel, now)
        timings.append((time.perf_counter() - began) * 1000)
    emit(tracker.clear(), None, args.channel, len(data) / rate)
    print(f"DSP + note handling: median {np.median(timings):.2f} ms, p95 {np.percentile(timings,95):.2f} ms per update.")
    print("Offline timings exclude audio capture, MIDI routing and receiving-instrument latency.")


def live(args):
    import sounddevice as sd
    devices = sd.query_devices()
    inputs = [(i, d) for i, d in enumerate(devices) if d['max_input_channels'] > 0]
    if args.list_devices:
        for i, d in inputs:
            print(f"{i:3}: {d['name']} ({d['max_input_channels']} channels, default {d['default_samplerate']:g} Hz)")
        return
    if not inputs:
        raise ValueError("No audio inputs found. Install/configure BlackHole and restart Terminal.")
    if args.device is None:
        matches = [i for i, d in inputs if 'blackhole' in d['name'].lower()]
        if len(matches) == 1:
            device = matches[0]
        else:
            for i, d in inputs:
                print(f"{i:3}: {d['name']}")
            device = int(input("Choose audio INPUT number (BlackHole for system audio): "))
    else:
        device = int(args.device) if args.device.isdigit() else args.device
    info = sd.query_devices(device, 'input')
    rate = args.sample_rate or int(info['default_samplerate'])
    channels = min(2, info['max_input_channels'])
    sd.check_input_settings(device=device, channels=channels, samplerate=rate, dtype='float32')
    detector, tracker = detector_for(args, rate), tracker_for(args)
    ring = LatestAudio(args.window, channels)
    port = None
    stopping = threading.Event()

    def stop(signum, frame):
        stopping.set()

    previous_handlers = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        if not args.no_midi:
            import mido
            mido.set_backend('mido.backends.rtmidi')
            if args.midi_port:
                port = mido.open_output(args.midi_port)
            elif sys.platform == 'win32':
                raise ValueError("On Windows create a loopMIDI port, then pass --midi-port NAME (see README).")
            else:
                port = mido.open_output('System Audio MIDI', virtual=True)
        print(f"Input: {info['name']} | {rate} Hz | {channels} channels")
        print(f"MIDI: {port.name if port else 'display only'} | channel {args.channel}")
        print(f"History {args.window/rate*1000:.1f} ms; block {args.hop/rate*1000:.1f} ms; confirmation {args.attack_ms:g} ms.")
        print("These are processing settings, NOT a measured end-to-end latency. Ctrl-C stops and releases notes.")

        def capture(indata, frames, timing, status):
            ring.push(indata, bool(status))

        with sd.InputStream(device=device, channels=channels, samplerate=rate, dtype='float32',
                            blocksize=args.hop, latency='low', callback=capture) as stream:
            print(f"Reported input latency: {stream.latency*1000:.1f} ms. Play music on the routed output.")
            last_sample, generation, last_ui = 0, 0, 0.0
            last_audio = time.monotonic()
            last_cost = 0.0
            while not stopping.is_set():
                ring.ready.wait(.1)
                frame, samples, new_generation = ring.snapshot()
                if samples == last_sample:
                    if time.monotonic() - last_audio > .5:
                        emit(tracker.clear(), port, args.channel)
                        if not stream.active:
                            raise RuntimeError("Audio input stopped. Check the device and restart.")
                    continue
                last_audio = time.monotonic()
                if new_generation != generation or samples - last_sample > args.window:
                    emit(tracker.clear(), port, args.channel)
                    generation = new_generation
                last_sample = samples
                if frame is None:
                    continue
                start = time.perf_counter()
                scores, db = detector.analyse(frame)
                emit(tracker.update(scores, samples / rate, db), port, args.channel)
                last_cost = (time.perf_counter() - start) * 1000
                if time.monotonic() - last_ui > .2:
                    names = ' '.join(note_name(n) for n in sorted(tracker.active)) or '—'
                    print(f"\r{db:6.1f} dBFS | {names:40} | DSP {last_cost:5.1f} ms | dropped blocks {ring.skipped + ring.overflows}    ", end='', flush=True)
                    last_ui = time.monotonic()
    finally:
        failures = finish_output(tracker, port, args.channel)
        for s, handler in previous_handlers.items():
            signal.signal(s, handler)
        if failures:
            print("\nStopped. MIDI destination disconnected; release notes in the receiving application.", file=sys.stderr)
        else:
            print("\nStopped; MIDI notes released.")


def main():
    parser = make_parser()
    args = parser.parse_args()
    if not (0 <= args.min_note <= args.max_note <= 127):
        parser.error('note range must satisfy 0 <= min-note <= max-note <= 127')
    if not (1 <= args.channel <= 16 and 1 <= args.polyphony <= 32):
        parser.error('channel must be 1–16 and polyphony 1–32')
    if not (0 < args.threshold <= 1 and 0 < args.hop <= args.window):
        parser.error('threshold must be (0,1] and hop must be 1..window')
    if not all(math.isfinite(v) for v in (args.gate_db, args.attack_ms, args.release_ms)):
        parser.error('gate and timing values must be finite')
    if args.attack_ms < 0 or args.release_ms < 0 or (args.sample_rate is not None and args.sample_rate < 16000):
        parser.error('timings cannot be negative; sample-rate must be at least 16000')
    try:
        if args.list_midi:
            import mido
            mido.set_backend('mido.backends.rtmidi')
            for name in mido.get_output_names():
                print(name)
        elif args.file:
            diagnose_file(args)
        else:
            live(args)
    except (KeyboardInterrupt, EOFError):
        return 0
    except Exception as exc:
        print(f"Error: {exc}\nSee README.md for setup, or run --help.", file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
