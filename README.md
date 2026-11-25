# sound2midi

A small Python prototype that listens continuously to an audio input and sends approximate polyphonic MIDI notes. On macOS, BlackHole can feed it whatever your computer is playing: browser audio, a music player, or a recording.

This is a reactive pitch detector for experimentation, live electronics, and visuals. It will miss notes and sometimes interpret harmonics as notes. It does not reconstruct separate instrumental parts or produce a polished transcription.

## Quick start on macOS

You need Python 3.10 or later and [BlackHole 2ch](https://existential.audio/blackhole/). Install these separately if necessary. The launcher installs the Python packages into a virtual environment inside this folder; it does not change your audio routing or install BlackHole.

1. Set up the audio routing below.
2. Open Terminal and enter your clone's folder. For your current checkout:

   ```bash
   cd ~/Documents/PROJECTS/LABS/BPLab/sound2midi
   git pull --ff-only
   ```
3. Run:

   ```bash
   bash Start.command
   ```

4. Start playing music. The script selects BlackHole when there is a unique matching input; otherwise it asks you to choose a device.
5. In Max or your DAW, select **System Audio MIDI** as a MIDI input. Stop the script with **Ctrl+C**.

You can also double-click `Start.command` if macOS allows it to run. The Terminal command above is an alternative when double-clicking does not work.

### Route computer audio into the detector

In **Audio MIDI Setup**, create a **Multi-Output Device** using the `+` button. Include your speakers or audio interface and **BlackHole 2ch**. Use the physical output as the clock source, enable drift correction for BlackHole, and use the same sample rate on both devices, preferably 48 kHz. Select the new Multi-Output Device as the Mac's sound output. The detector must receive **BlackHole 2ch**, not the Multi-Output Device. You should now hear your music while the detector receives it.

See the [official BlackHole setup guide](https://github.com/ExistentialAudio/BlackHole/wiki/Getting-Started:-Creating-a-Multi-Output-Device).

### Receive the MIDI

- **Max:** enable/select the **System Audio MIDI** input in MIDI Setup, then receive notes with `notein`.
- **Ableton Live:** enable **Track** for the input port in MIDI settings, choose it under the instrument track's **MIDI From**, and set monitoring to **In**.
- **Other software:** choose **System Audio MIDI** as its MIDI input. The script sends on channel 1 by default.

If the MIDI drives a software synthesizer, route that application's audio **directly to your physical speakers/interface**, while the source music goes through the Multi-Output Device. Otherwise the detector will hear the sound it generates and can form a feedback loop. For a first check, use a MIDI monitor or a visual display without synthesized audio.

The script itself does not play, record, or upload audio. It listens to the chosen input and generates MIDI. Apps that use a different output device will not be captured by this routing.

## Controls

Pass options to the launcher; they are forwarded to the Python script:

```bash
bash Start.command --list-devices
bash Start.command --device "BlackHole 2ch" --no-midi
bash Start.command --device "BlackHole 2ch" --polyphony 4 --threshold 0.30
bash Start.command --window 2048 --attack-ms 10
```

| Option | Default | Effect |
| --- | --- | --- |
| `--device NAME_OR_ID` | Find BlackHole or ask | Select an audio input. |
| `--list-devices` | — | Show audio devices and exit. |
| `--no-midi` | Off | Display detections without opening a MIDI port. |
| `--midi-port NAME` | Create **System Audio MIDI** | Send to an existing MIDI output instead. |
| `--list-midi` | — | Show existing MIDI output ports and exit. |
| `--polyphony N` | `6` | Limit the number of simultaneous output notes. |
| `--threshold VALUE` | `0.20` | Relative fitted-amplitude threshold. Increase it to keep fewer, stronger detections. |
| `--gate-db DB` | `-48` | Ignore audio below this input level. A less negative value rejects more quiet material. |
| `--min-note N` / `--max-note N` | `48` / `96` | Restrict detection to MIDI pitches C3–C7. C4 is MIDI 60. |
| `--window N` | `4096` | Analysis window: `2048`, `4096`, or `8192` samples. Shorter reacts sooner; longer distinguishes low pitches better. |
| `--hop N` | `512` | Samples between analysis updates. Smaller values increase CPU use. |
| `--attack-ms MS` | `20` | Required persistence before starting a note. Shorter reacts sooner but can admit more false notes. |
| `--release-ms MS` | `80` | Hold a temporarily missing note before sending Note Off. Shorter releases sooner but can chatter. |
| `--channel N` | `1` | MIDI channel, 1–16. |
| `--sample-rate HZ` | Device default | Request an input sample rate supported by the selected device. |
| `--file WAV` | — | Run an offline diagnostic through the same analysis core; print events without audio hardware or MIDI output. |

Use `bash Start.command --help` for the complete command reference. After installation you can invoke `.venv/bin/python system_audio_midi.py` directly with the same options.

## Timing and musical limits

At 48 kHz, the default 4096-sample window spans approximately **85 ms**, and a 512-sample hop produces an update approximately every **11 ms**. The attack setting adds a persistence requirement of **20 ms**. These are configuration values, **not measured end-to-end latency**. Audio-device buffering, the signal itself, computation, MIDI delivery, and the receiving application also affect response time. A shorter hop alone does not eliminate the analysis window.

Start with the defaults. For quicker visual reactions, try `--window 2048 --attack-ms 10`; expect less reliable pitch separation. For steadier notes, raise `--threshold` or lower `--polyphony` before increasing the window.

The detector uses spectral harmonic matching, not a trained instrument-separation model. Dense mixes, percussion, distortion, reverberation, quiet inner voices, and deep bass can confuse it. Its default pitch range deliberately omits deep bass. Extending that range does not guarantee that low notes will be resolved. Output uses equal-tempered semitone pitches; there are no pitch bends or separate instrument channels. Repeated strikes of a pitch that remains active are generally treated as one sustained note.

## Troubleshooting

- **No input level:** check the Mac's output routing and select BlackHole as the script's input. If macOS requests microphone access for Terminal/Python, allow it so the input stream can open.
- **No audible source music:** ensure the Multi-Output Device includes your physical output. To return to normal routing, select your usual speakers/interface in Sound settings.
- **Detected notes but no MIDI in the destination:** start the script before refreshing/selecting MIDI inputs in the receiving application. Check its input channel and monitoring.
- **Too many notes:** increase `--threshold`, reduce `--polyphony`, or narrow the pitch range.
- **Wrong notes on drums or overtones:** this is a limitation of the approximation. Filtering or restricting the range may help; a larger window does not make arbitrary mixes unambiguous.
- **Virtual port unavailable:** use `--list-midi` and pass an existing output with `--midi-port`. On Windows, a separate virtual MIDI driver is required; system-audio capture also needs platform-specific routing.
- **Installation fails:** ensure the selected `python3` is version 3.10 or newer. The launcher prints dependency errors; resolve those before trying to capture audio.
- **Linux reports `PortAudio library not found`:** install the system PortAudio library (for example `libportaudio2` on Ubuntu). The macOS sounddevice distribution normally bundles PortAudio. This guide's system-audio routing instructions target macOS.

## Validation

Twelve automated checks cover synthetic pitches with different timbres/levels, a triad, octave pairs, silence/noise, antiphase stereo, streamed chord attacks/stops, note persistence/release, polyphony limits, cleanup after a failed MIDI send, and bounded capture buffering. Run them with:

```bash
.venv/bin/python -m unittest discover -v
```

These are regression checks, not a real-music accuracy benchmark. This prototype has not been tested on your Mac or with its live audio/MIDI routing. Detection quality and end-to-end delay should be assessed with the music and receiving application you intend to use.

Implementation: stereo spectral-power combination; Hann-windowed FFT; joint nonnegative fitting of three harmonic profiles per pitch with a small coefficient penalty; interpolated spectral peaks to support fundamentals; a recent-audio RMS gate and broadband-noise rejection; separate note-on/off thresholds and time holds. The capture ring has fixed size and always serves the latest window. Overruns reset note state instead of accumulating delayed work. On exit, the script sends Note Off for its owned notes without resetting unrelated notes/controllers on a shared MIDI destination.

## Dependencies and reference documentation

- [NumPy](https://numpy.org/) and [SciPy](https://scipy.org/): numerical analysis.
- [python-sounddevice](https://python-sounddevice.readthedocs.io/): continuous audio input.
- [Mido / RtMidi](https://mido.readthedocs.io/en/stable/backends/rtmidi.html): MIDI output and virtual ports.

No model download is required. Dependencies are listed in `requirements.txt`.
