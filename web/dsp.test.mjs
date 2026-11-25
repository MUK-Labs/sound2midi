import assert from 'node:assert/strict';
import test from 'node:test';
import {Detector, NoteTracker, noteName} from './dsp.js';

function synth(notes, {size = 4096, sampleRate = 48000, rolloff = 1.7, phase = .7} = {}) {
  const audio = new Float32Array(size);
  for (const note of notes) {
    const f = 440 * 2 ** ((note - 69) / 12);
    for (let harmonic = 1; harmonic <= 15 && f * harmonic < sampleRate / 2; harmonic++) {
      for (let i = 0; i < size; i++) audio[i] += .12 / notes.length * Math.sin(2 * Math.PI * f * harmonic * i / sampleRate + phase * harmonic) / harmonic ** rolloff;
    }
  }
  return audio;
}

const detector = new Detector();
const detected = (left, right) => Object.entries(detector.analyse(left, right).scores).filter(([, s]) => s >= .2).map(([n]) => +n);

test('names use C4 = MIDI 60', () => { assert.equal(noteName(60), 'C4'); assert.equal(noteName(69), 'A4'); });
test('silence produces no notes', () => assert.deepEqual(detected(new Float32Array(4096)), []));
test('broadband noise produces no notes', () => {
  let state = 123;
  const noise = Float32Array.from({length: 4096}, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296 - .5) * .2;
  });
  assert.deepEqual(detected(noise), []);
});
test('single notes with soft and bright spectra retain their fundamentals', () => {
  for (const note of [52, 60, 69, 84]) {
    for (const rolloff of [1, 1.8, 5]) assert.deepEqual(detected(synth([note], {rolloff})), [note], `${note}, rolloff=${rolloff}`);
  }
});
test('triad and stereo antiphase preserve pitches', () => {
  const audio = synth([60, 64, 67]);
  assert.deepEqual(detected(audio), [60, 64, 67]);
  assert.deepEqual(detected(audio, Float32Array.from(audio, x => -x)), [60, 64, 67]);
});
test('an actual octave pair is allowed', () => assert.deepEqual(detected(synth([60, 72], {rolloff: 1.8})), [60, 72]));
test('streamed chord attack and stop do not invent neighbouring pitches', () => {
  const audio = new Float32Array(60000);
  audio.set(synth([60, 64, 67], {size: 38400}), 9600);
  const tracker = new NoteTracker(), events = [];
  for (let end = 512; end <= audio.length; end += 512) {
    const frame = new Float32Array(4096);
    frame.set(audio.subarray(Math.max(0, end - 4096), end), Math.max(0, 4096 - end));
    const {scores, db} = detector.analyse(frame);
    events.push(...tracker.update(scores, end / 48000, db));
  }
  const notes = kind => events.filter(e => e.kind === kind).map(e => e.note).sort((a,b) => a-b);
  assert.deepEqual(notes('note_on'), [60, 64, 67]);
  assert.deepEqual(notes('note_off'), [60, 64, 67]);
  assert.equal(tracker.active.size, 0);
});
test('nonfinite input is rejected without poisoning subsequent frames', () => {
  const broken = synth([69]); broken[8] = NaN;
  assert.deepEqual(detected(broken), []);
  assert.deepEqual(detected(synth([69])), [69]);
});
test('a brief impulse does not survive onset confirmation', () => {
  const tracker = new NoteTracker();
  assert.deepEqual(tracker.update({60: 1}, 0), []);
  assert.deepEqual(tracker.update({}, .01), []);
  assert.equal(tracker.active.size, 0);
});
test('chord change preserves common tone and silence releases every note', () => {
  const tracker = new NoteTracker();
  tracker.update({60: 1, 64: .9, 67: .8}, 0);
  assert.equal(tracker.update({60: 1, 64: .9, 67: .8}, .021).length, 3);
  tracker.update({60: 1, 65: .9, 69: .8}, .03);
  const changed = tracker.update({60: 1, 65: .9, 69: .8}, .12);
  assert.ok(changed.every(e => e.note !== 60));
  assert.deepEqual([...tracker.active.keys()].sort((a,b)=>a-b), [60,65,69]);
  assert.equal(tracker.update({}, .21).filter(e => e.kind === 'note_off').length, 3);
  assert.equal(tracker.active.size, 0);
});
test('reducing polyphony releases excess notes immediately', () => {
  const tracker = new NoteTracker({attackMs: 0});
  tracker.update({60: 1, 64: .9, 67: .8}, 0);
  const events = tracker.configure({polyphony: 1});
  assert.equal(events.filter(e => e.kind === 'note_off').length, 2);
  assert.equal(tracker.active.size, 1);
  assert.equal(tracker.clear().length, 1);
});
