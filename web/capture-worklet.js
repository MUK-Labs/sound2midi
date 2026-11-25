// Capture only. The detector runs in a separate Worker. One frame at a time
// prevents an analysis backlog; while busy we keep replacing the ring contents.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions?.windowSize || 4096;
    this.hop = 512;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.position = this.filled = this.since = this.sequence = 0;
    this.busy = false;
    this.port.onmessage = ({data}) => { if (data.type === 'ready') this.busy = false; };
  }
  process(inputs, outputs) {
    // Never monitor input back to speakers: the source is already audible.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels?.[0]?.length) return true;
    const a = channels[0], b = channels[1] || a;
    for (let i=0; i<a.length; i++) {
      this.left[this.position] = a[i]; this.right[this.position] = b[i];
      this.position = (this.position + 1) % this.size;
    }
    this.filled = Math.min(this.size, this.filled + a.length);
    this.since += a.length;
    if (this.filled === this.size && this.since >= this.hop && !this.busy) {
      this.since = 0; this.busy = true;
      const left = new Float32Array(this.size), right = new Float32Array(this.size);
      left.set(this.left.subarray(this.position)); left.set(this.left.subarray(0,this.position),this.size-this.position);
      right.set(this.right.subarray(this.position)); right.set(this.right.subarray(0,this.position),this.size-this.position);
      this.port.postMessage({type:'frame',left:left.buffer,right:right.buffer,audioTime:currentTime+a.length/sampleRate,sequence:++this.sequence},[left.buffer,right.buffer]);
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
