export function sensitivityThreshold(percent) { return 0.55 - Math.max(0,Math.min(100,percent)) / 100 * 0.47; }

export class MidiRouter {
  constructor(onError = () => {}) { this.output=null; this.channel=0; this.owned=new Set(); this.onError=onError; }
  setDestination(output, channel=1) {
    if (!this.release()) return false;
    this.output=output; this.channel=channel-1;
    return true;
  }
  send(event) {
    if (!this.output) return;
    if (this.output.state === 'disconnected') { this.disable(Error('MIDI output disconnected.')); return; }
    const note=Number(event.note);
    if (!Number.isInteger(note) || note<0 || note>127) return;
    try {
      if (event.kind==='note_on') {
        if (this.owned.has(note)) return;
        this.output.send([0x90|this.channel,note,Math.max(1,Math.min(127,Math.round(event.velocity||70)))]);
        this.owned.add(note);
      } else if (event.kind==='note_off' && this.owned.has(note)) {
        this.output.send([0x80|this.channel,note,0]); this.owned.delete(note);
      }
    } catch(error) { this.disable(error); }
  }
  sync(active) { for(const note of active) this.send({kind:'note_on',note:note.note,velocity:note.velocity}); }
  releaseOwned(output, channel) {
    const notes=[...this.owned];
    this.owned.clear();
    let failure=null;
    // Send directly, without recursing through send() or reporting once per note.
    // A failed Note Off does not prevent attempts to release the other voices.
    for(const note of notes) {
      try { output?.send([0x80|channel,note,0]); }
      catch(error) { failure ??= error; }
    }
    return failure;
  }
  disable(error) {
    const oldOutput=this.output, oldChannel=this.channel;
    this.output=null;
    this.releaseOwned(oldOutput,oldChannel);
    this.onError(error);
  }
  release() {
    const failure=this.releaseOwned(this.output,this.channel);
    if(failure) { this.output=null; this.onError(failure); return false; }
    return true;
  }
}
