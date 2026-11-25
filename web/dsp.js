/** Local, approximate polyphonic pitch detection. No network or model dependency. */
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = note => `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;

/** Reusable radix-two FFT. Magnitudes include the real-signal Nyquist bin. */
class FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1))) throw new Error('FFT size must be a power of two.');
    this.size = size;
    this.real = new Float64Array(size);
    this.imag = new Float64Array(size);
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let value = i, reversed = 0;
      for (let bit = 0; bit < bits; bit++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
      this.reverse[i] = reversed;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / size);
      this.sin[i] = Math.sin(-2 * Math.PI * i / size);
    }
  }

  magnitude(input, taper) {
    const {size, real, imag, reverse, cos, sin} = this;
    for (let i = 0; i < size; i++) {
      real[reverse[i]] = input[i] * taper[i];
      imag[i] = 0;
    }
    for (let length = 2; length <= size; length *= 2) {
      const half = length / 2, stride = size / length;
      for (let base = 0; base < size; base += length) {
        for (let j = 0; j < half; j++) {
          const a = base + j, b = a + half, k = j * stride;
          const tr = real[b] * cos[k] - imag[b] * sin[k];
          const ti = real[b] * sin[k] + imag[b] * cos[k];
          real[b] = real[a] - tr; imag[b] = imag[a] - ti;
          real[a] += tr; imag[a] += ti;
        }
      }
    }
    const result = new Float64Array(size / 2 + 1);
    for (let i = 0; i < result.length; i++) result[i] = Math.hypot(real[i], imag[i]);
    return result;
  }
}

function removeFloor(values) {
  const result = new Float64Array(values.length);
  const neighbourhood = new Float64Array(9);
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < 9; j++) neighbourhood[j] = values[clamp(i + j - 4, 0, values.length - 1)];
    // Insertion sort of nine values is faster than allocating/sorting arrays.
    for (let j = 1; j < 9; j++) {
      const value = neighbourhood[j]; let k = j - 1;
      while (k >= 0 && neighbourhood[k] > value) { neighbourhood[k + 1] = neighbourhood[k]; k--; }
      neighbourhood[k + 1] = value;
    }
    result[i] = Math.max(0, values[i] - .8 * neighbourhood[4]);
  }
  return result;
}

export class Detector {
  constructor({sampleRate = 48000, windowSize = 4096, minNote = 48, maxNote = 96, gateDb = -48} = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate < 16000 || ![2048, 4096, 8192].includes(windowSize)) {
      throw new Error('Unsupported sample rate or analysis window.');
    }
    if (!Number.isInteger(minNote) || !Number.isInteger(maxNote) || minNote < 0 || maxNote > 127 || minNote > maxNote) {
      throw new Error('Invalid note range.');
    }
    this.sampleRate = sampleRate; this.windowSize = windowSize;
    this.minNote = minNote; this.maxNote = maxNote; this.gateDb = gateDb;
    this.fft = new FFT(windowSize);
    this.taper = Float64Array.from({length: windowSize}, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (windowSize - 1)));
    this.firstBin = Math.ceil(65 * windowSize / sampleRate);
    this.lastBin = Math.floor(Math.min(8000, sampleRate / 2) * windowSize / sampleRate);
    this.binCount = this.lastBin - this.firstBin + 1;
    this.weight = Float64Array.from({length: this.binCount}, (_, i) => clamp((((i + this.firstBin) * sampleRate / windowSize) / 440) ** .3, .65, 2));
    this.templates = [];
    const tone = new Float64Array(windowSize);
    const rolloffs = [1, 2.5, 16];
    for (let note = minNote; note <= maxNote; note++) {
      const fundamental = 440 * 2 ** ((note - 69) / 12);
      const profiles = rolloffs.map(() => new Float64Array(this.binCount));
      for (let harmonic = 1; harmonic <= 12; harmonic++) {
        const frequency = fundamental * harmonic;
        if (frequency >= Math.min(8000, sampleRate / 2 - sampleRate / windowSize)) break;
        for (let i = 0; i < windowSize; i++) tone[i] = Math.cos(2 * Math.PI * frequency * i / sampleRate);
        const magnitude = this.fft.magnitude(tone, this.taper);
        for (let model = 0; model < profiles.length; model++) {
          const gain = 1 / harmonic ** rolloffs[model];
          for (let bin = 0; bin < this.binCount; bin++) profiles[model][bin] += magnitude[bin + this.firstBin] * gain;
        }
      }
      for (const profile of profiles) {
        const column = removeFloor(profile);
        let sum = 0;
        for (let bin = 0; bin < this.binCount; bin++) { column[bin] *= this.weight[bin]; sum += column[bin] ** 2; }
        const norm = Math.max(1e-12, Math.sqrt(sum));
        for (let bin = 0; bin < this.binCount; bin++) column[bin] /= norm;
        this.templates.push(column);
      }
    }
    // The Gram matrix avoids repeating long spectral dot products in each solve.
    // +.01 is the same squared coefficient-sum penalty used by the Python core.
    const count = this.templates.length;
    this.gram = Array.from({length: count}, () => new Float64Array(count));
    for (let i = 0; i < count; i++) {
      for (let j = 0; j <= i; j++) {
        let dot = .01;
        for (let bin = 0; bin < this.binCount; bin++) dot += this.templates[i][bin] * this.templates[j][bin];
        this.gram[i][j] = this.gram[j][i] = dot;
      }
    }
  }

  analyse(left, right = null) {
    const n = this.windowSize;
    if (left.length !== n || (right && right.length !== n)) throw new Error('Incorrect audio frame length.');
    let power = 0, recentPower = 0;
    const recentLength = Math.min(512, n), channels = right ? 2 : 1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(left[i]) || (right && !Number.isFinite(right[i]))) return {scores: {}, db: -120};
      const p = left[i] ** 2 + (right ? right[i] ** 2 : 0);
      power += p;
      if (i >= n - recentLength) recentPower += p;
    }
    const db = Math.max(-120, 10 * Math.log10(Math.max(1e-12, power / (n * channels))));
    const recentDb = 10 * Math.log10(Math.max(1e-12, recentPower / (recentLength * channels)));
    if (db < this.gateDb || recentDb < this.gateDb) return {scores: {}, db};
    const lm = this.fft.magnitude(left, this.taper);
    const rm = right ? this.fft.magnitude(right, this.taper) : null;
    const spectrum = new Float64Array(this.binCount);
    let sum = 0, logSum = 0;
    for (let i = 0; i < spectrum.length; i++) {
      const bin = i + this.firstBin;
      const value = rm ? Math.sqrt((lm[bin] ** 2 + rm[bin] ** 2) / 2) : lm[bin];
      spectrum[i] = value; sum += value; logSum += Math.log(value + 1e-12);
    }
    if (Math.exp(logSum / spectrum.length) / (sum / spectrum.length + 1e-12) > .65) return {scores: {}, db};
    const tonal = removeFloor(spectrum);
    let maxTonal = 0;
    for (const value of tonal) maxTonal = Math.max(value, maxTonal);
    const evidence = new Set();
    for (let i = 1; i < spectrum.length - 1; i++) {
      if (spectrum[i] <= spectrum[i - 1] || spectrum[i] < spectrum[i + 1] || tonal[i] < maxTonal * .025) continue;
      const a = Math.log(spectrum[i - 1] + 1e-12), b = Math.log(spectrum[i] + 1e-12), c = Math.log(spectrum[i + 1] + 1e-12);
      const curvature = a - 2 * b + c;
      const shift = Math.abs(curvature) > 1e-12 ? clamp(.5 * (a - c) / curvature, -.5, .5) : 0;
      const hz = (i + this.firstBin + shift) * this.sampleRate / n;
      evidence.add(Math.round(69 + 12 * Math.log2(hz / 440)));
    }
    const target = new Float64Array(this.binCount);
    let norm = 0;
    for (let i = 0; i < target.length; i++) { target[i] = tonal[i] * this.weight[i]; norm += target[i] ** 2; }
    norm = Math.max(1e-12, Math.sqrt(norm));
    for (let i = 0; i < target.length; i++) target[i] /= norm;
    const count = this.templates.length, projection = new Float64Array(count);
    for (let j = 0; j < count; j++) {
      const column = this.templates[j]; let dot = 0;
      for (let i = 0; i < target.length; i++) dot += column[i] * target[i];
      projection[j] = dot;
    }
    // Bounded cyclic coordinate descent: no unbounded optimisation in live input.
    const coefficients = new Float64Array(count);
    for (let iteration = 0; iteration < 32; iteration++) {
      let changed = 0;
      for (let j = 0; j < count; j++) {
        const row = this.gram[j]; let fitted = 0;
        for (let k = 0; k < count; k++) fitted += row[k] * coefficients[k];
        const next = Math.max(0, coefficients[j] + (projection[j] - fitted) / row[j]);
        changed = Math.max(changed, Math.abs(next - coefficients[j]));
        coefficients[j] = next;
      }
      if (changed < .0001) break;
    }
    const strengths = new Float64Array(this.maxNote - this.minNote + 1);
    let peak = 0;
    for (let i = 0; i < strengths.length; i++) {
      strengths[i] = coefficients[i * 3] + coefficients[i * 3 + 1] + coefficients[i * 3 + 2];
      peak = Math.max(peak, strengths[i]);
    }
    if (peak < .06) return {scores: {}, db};
    const scores = {};
    for (let i = 0; i < strengths.length; i++) {
      const note = i + this.minNote;
      if (evidence.has(note) && strengths[i] > 0) scores[note] = strengths[i] / peak;
    }
    return {scores, db};
  }
}

/** Hysteresis and bounded voice count. All event timestamps use the audio clock. */
export class NoteTracker {
  constructor(settings = {}) {
    this.active = new Map();
    this.pending = new Map();
    this.configure({threshold: .2, polyphony: 6, attackMs: 20, releaseMs: 80, ...settings});
  }

  configure(settings = {}) {
    const ranges = {threshold: [.01, 1], polyphony: [1, 32], attackMs: [0, 2000], releaseMs: [0, 5000]};
    for (const [key, [low, high]] of Object.entries(ranges)) {
      if (settings[key] !== undefined) {
        const value = Number(settings[key]);
        if (!Number.isFinite(value) || value < low || value > high) throw new Error(`Invalid ${key}.`);
        this[key] = key === 'polyphony' ? Math.round(value) : value;
      }
    }
    const events = [];
    // If the user reduces voice count, end the least recently supported voices.
    const oldest = [...this.active].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (this.active.size > this.polyphony) {
      const [note] = oldest.shift();
      this.active.delete(note); events.push({kind: 'note_off', note, velocity: 0});
    }
    return events;
  }

  clear() {
    const events = [...this.active.keys()].sort((a, b) => a - b).map(note => ({kind: 'note_off', note, velocity: 0}));
    this.active.clear(); this.pending.clear();
    return events;
  }

  update(scores, now, db = -20) {
    if (!Number.isFinite(now)) return this.clear();
    const events = [];
    const ranked = Object.entries(scores)
      .map(([note, score]) => [Number(note), Number(score)])
      .filter(([note, score]) => Number.isInteger(note) && note >= 0 && note <= 127 && Number.isFinite(score) && score > 0)
      .sort(([a, av], [b, bv]) => bv * (this.active.has(b) ? 1.15 : 1) - av * (this.active.has(a) ? 1.15 : 1));
    const selected = new Map(ranked.filter(([note, score]) => score >= this.threshold * (this.active.has(note) ? .65 : 1)).slice(0, this.polyphony));
    for (const [note, state] of this.active) {
      if (selected.has(note)) state.lastSeen = now;
      else if (now - state.lastSeen >= this.releaseMs / 1000) {
        events.push({kind: 'note_off', note, velocity: 0}); this.active.delete(note);
      }
    }
    for (const note of this.pending.keys()) if (!selected.has(note)) this.pending.delete(note);
    for (const [note, strength] of selected) {
      if (this.active.has(note)) continue;
      if (!this.pending.has(note)) this.pending.set(note, now);
      if (now - this.pending.get(note) + 1e-9 >= this.attackMs / 1000 && this.active.size < this.polyphony) {
        const loudness = clamp((db + 48) / 42, 0, 1);
        const velocity = Math.round(clamp(35 + 80 * loudness * Math.sqrt(strength), 1, 127));
        events.push({kind: 'note_on', note, velocity});
        this.active.set(note, {lastSeen: now, velocity}); this.pending.delete(note);
      }
    }
    return events;
  }
}
