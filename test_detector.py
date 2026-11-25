"""Synthetic regression checks. These do NOT establish real-music accuracy."""
import unittest
from unittest.mock import patch
import numpy as np
from system_audio_midi import Detector, LatestAudio, NoteTracker, finish_output


def synth(notes, seconds=4096/48000, rate=48000, rolloff=1.7):
    t = np.arange(round(seconds * rate)) / rate
    rng = np.random.default_rng(27)
    audio = np.zeros_like(t)
    for note in notes:
        frequency = 440 * 2 ** ((note - 69) / 12)
        for harmonic in range(1, 16):
            if frequency * harmonic < rate / 2:
                audio += np.sin(2*np.pi*frequency*harmonic*t + rng.uniform(0, 2*np.pi)) / harmonic**rolloff
    return .12 * audio / max(1, len(notes))


class DetectionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.detector = Detector()

    def notes(self, audio):
        scores, _ = self.detector.analyse(audio)
        return {n for n, strength in scores.items() if strength >= .20}

    def test_silence_and_broadband_noise(self):
        self.assertEqual(self.notes(np.zeros(4096)), set())
        noise = np.random.default_rng(99).normal(0, .1, 4096)
        self.assertEqual(self.notes(noise), set())

    def test_single_notes_with_different_spectra_and_levels(self):
        for pitch in (52, 60, 69, 84):
            for rolloff in (1.0, 1.8, 5.0):
                for gain in (.2, 1.0):
                    with self.subTest(pitch=pitch, rolloff=rolloff, gain=gain):
                        self.assertEqual(self.notes(synth([pitch], rolloff=rolloff)*gain), {pitch})

    def test_triad_and_antiphase_stereo(self):
        chord = synth([60, 64, 67])
        self.assertEqual(self.notes(chord), {60, 64, 67})
        self.assertEqual(self.notes(np.column_stack((chord, -chord))), {60, 64, 67})

    def test_actual_octave_is_not_unconditionally_removed(self):
        self.assertEqual(self.notes(synth([60, 72], rolloff=1.8)), {60, 72})

    def test_below_gate_is_quiet(self):
        self.assertEqual(self.notes(synth([69])*.001), set())

    def test_streamed_chord_attack_and_stop_do_not_invent_neighbours(self):
        audio = np.concatenate((np.zeros(9600), synth([60,64,67], seconds=.8), np.zeros(12000)))
        frame = np.zeros(4096)
        tracker = NoteTracker()
        events = []
        for start in range(0, len(audio)-512, 512):
            frame[:-512] = frame[512:]
            frame[-512:] = audio[start:start+512]
            scores, db = self.detector.analyse(frame)
            events.extend(tracker.update(scores, (start+512)/48000, db))
        self.assertEqual(sorted(e.note for e in events if e.kind == 'note_on'), [60,64,67])
        self.assertEqual(sorted(e.note for e in events if e.kind == 'note_off'), [60,64,67])
        self.assertFalse(tracker.active)


class LifecycleChecks(unittest.TestCase):
    def test_short_transient_never_opens_note(self):
        t = NoteTracker()
        self.assertEqual(t.update({60:1}, 0), [])
        self.assertEqual(t.update({}, .01), [])
        self.assertFalse(t.active)

    def test_chord_change_preserves_shared_pitch_and_releases(self):
        t = NoteTracker()
        t.update({60:1,64:.9,67:.8}, 0)
        opened = t.update({60:1,64:.9,67:.8}, .021)
        self.assertEqual({e.note for e in opened}, {60,64,67})
        t.update({60:1,65:.9,69:.8}, .03)
        changed = t.update({60:1,65:.9,69:.8}, .12)
        self.assertNotIn(60, {e.note for e in changed})
        self.assertEqual(set(t.active), {60,65,69})
        released = t.update({}, .21)
        self.assertEqual({e.note for e in released}, {60,65,69})
        self.assertFalse(t.active)

    def test_polyphony_is_bounded_during_replacement(self):
        t = NoteTracker(polyphony=2, attack_ms=0)
        t.update({60:1,64:.8,67:.6}, 0)
        t.update({72:1,76:.9}, .01)
        self.assertEqual(len(t.active), 2)
        t.update({72:1,76:.9}, .1)
        self.assertEqual(set(t.active), {72,76})

    def test_cleanup_attempts_every_owned_note_even_if_first_send_fails(self):
        t = NoteTracker(attack_ms=0)
        t.update({60:1,64:1,67:1}, 0)
        class Port:
            closed = False
            def close(self): self.closed = True
        port = Port()
        with patch('system_audio_midi.emit', side_effect=[OSError('disconnected'), None, None]) as send:
            failures = finish_output(t, port, 1)
            self.assertEqual(send.call_count, 3)
        self.assertTrue(failures)
        self.assertTrue(port.closed)
        self.assertFalse(t.active)


class CaptureChecks(unittest.TestCase):
    def test_long_backlog_only_returns_latest_window(self):
        ring = LatestAudio(8, 1)
        for i in range(100):
            ring.push(np.full((2, 1), i))
        frame, total, _ = ring.snapshot()
        self.assertEqual(total, 200)
        np.testing.assert_array_equal(frame[:,0], [96,96,97,97,98,98,99,99])
        self.assertEqual(ring.data.shape, (8,1))

    def test_dropped_callback_invalidates_history(self):
        ring = LatestAudio(8, 1)
        ring.push(np.ones((8,1)))
        ring.lock.acquire()
        try: ring.push(np.ones((2,1)))
        finally: ring.lock.release()
        ring.push(np.full((2,1), 2))
        frame, _, generation = ring.snapshot()
        self.assertIsNone(frame)
        self.assertEqual(generation, 1)
        ring.push(np.full((6,1), 2))
        frame, _, _ = ring.snapshot()
        np.testing.assert_array_equal(frame, np.full((8,1), 2))


if __name__ == '__main__':
    unittest.main()
