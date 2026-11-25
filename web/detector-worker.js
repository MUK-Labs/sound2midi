import {Detector, NoteTracker} from './dsp.js';

let detector = null, tracker = null, previousTime = null;
let pendingEvents = [];
const describeActive = () => [...tracker.active].map(([note, state]) => ({note, velocity: state.velocity}));

self.onmessage = ({data}) => {
  try {
    if (data.type === 'init') {
      detector = new Detector({sampleRate: data.sampleRate, windowSize: data.windowSize, gateDb: data.settings?.gateDb ?? -48});
      tracker = new NoteTracker(data.settings);
      previousTime = null; pendingEvents = [];
      self.postMessage({type: 'ready'});
    } else if (data.type === 'configure') {
      if (!tracker) return;
      pendingEvents.push(...tracker.configure(data.settings));
      if (data.settings?.gateDb !== undefined) {
        const value = Number(data.settings.gateDb);
        if (!Number.isFinite(value) || value < -120 || value > 0) throw new Error('Invalid silence gate.');
        detector.gateDb = value;
      }
    } else if (data.type === 'reset') {
      const events = tracker ? [...pendingEvents, ...tracker.clear()] : [];
      pendingEvents = []; previousTime = null;
      self.postMessage({type: 'reset', events});
    } else if (data.type === 'frame') {
      if (!detector || !tracker) throw new Error('Detector has not been initialized.');
      const started = performance.now();
      const {audioTime, sequence} = data;
      const events = pendingEvents.splice(0);
      // A long discontinuity must not preserve stale notes or onset candidates.
      if (previousTime !== null && (audioTime < previousTime || audioTime - previousTime > .25)) events.push(...tracker.clear());
      previousTime = audioTime;
      const left = new Float32Array(data.left);
      const right = data.right ? new Float32Array(data.right) : null;
      const {scores, db} = detector.analyse(left, right);
      events.push(...tracker.update(scores, audioTime, db));
      self.postMessage({type: 'result', events, active: describeActive(), db, audioTime, sequence, processingMs: performance.now() - started});
    }
  } catch (error) {
    self.postMessage({type: 'error', message: error instanceof Error ? error.message : String(error)});
  }
};
