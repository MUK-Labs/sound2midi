export function sensitivityThreshold(percent) { return 0.55 - Math.max(0,Math.min(100,percent)) / 100 * 0.47; }

export class MidiRouter {
  constructor(onError = () => {}) { this.output=null; this.channel=0; this.owned=new Set(); this.onError=onError; }
  setDestination(output, channel=1) { this.release(); this.output=output; this.channel=channel-1; }
  send(event) {
    if (!this.output || this.output.state === 'disconnected') return;
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
    } catch(error) { this.onError(error); }
  }
  sync(active) { for(const note of active) this.send({kind:'note_on',note:note.note,velocity:note.velocity}); }
  release() {
    for(const note of [...this.owned]) {
      try { this.output?.send([0x80|this.channel,note,0]); }
      catch(error) { this.onError(error); }
    }
    this.owned.clear();
  }
}
