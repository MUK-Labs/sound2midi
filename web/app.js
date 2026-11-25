import {noteName} from './dsp.js';
import {MidiRouter, sensitivityThreshold} from './midi.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['start-button','demo-button','audio-access','midi-access','audio-input','midi-output','midi-channel','sensitivity','sensitivity-value','polyphony','level-value','level-meter','level-fill','message','status-badge','status-label','detected-notes','processing-time','analysis-window','empty-state','time-span','piano-roll','roll-container'].map(id=>[id,$(id)]));
const storageKey='sound2midi.browser.v1';
let preferences={};
try { preferences=JSON.parse(localStorage.getItem(storageKey)||'{}'); } catch {}
if (!preferences || typeof preferences!=='object') preferences={};
function remember() {
  preferences={audio:ui['audio-input'].value,midi:ui['midi-output'].value,channel:Number(ui['midi-channel'].value),sensitivity:Number(ui.sensitivity.value),polyphony:Number(ui.polyphony.value),span:Number(ui['time-span'].value)};
  try { localStorage.setItem(storageKey,JSON.stringify(preferences)); } catch {}
}
for(let channel=1;channel<=16;channel++) ui['midi-channel'].add(new Option(String(channel),String(channel)));
ui['midi-channel'].value=String(preferences.channel>=1&&preferences.channel<=16?preferences.channel:1);
ui.sensitivity.value=String(Number.isFinite(preferences.sensitivity)?preferences.sensitivity:75);
ui.polyphony.value=['1','2','4','6','8','12'].includes(String(preferences.polyphony))?String(preferences.polyphony):'6';
ui['time-span'].value=['8','12','20'].includes(String(preferences.span))?String(preferences.span):'12';
ui['sensitivity-value'].value=`${ui.sensitivity.value}%`;

let mode='idle', session=0, context=null, stream=null, source=null, capture=null, worker=null, midiAccess=null;
let active=[], history=[], held=new Map(), frozenTime=0, hasFrames=false, demoTimer=null, demoNodes=new Set(), audioBusy=false, lastResult=0, watchdog=null;
const midi=new MidiRouter(()=>{
  ui['midi-output'].value='';remember();
  message('MIDI output failed and is now off. Check the connection, release any held notes in the receiving app, then select the output again.',true);
});
function message(text,error=false){ui.message.textContent=text;ui.message.classList.toggle('error',error);}
function status(label,state='idle'){ui['status-label'].textContent=label;ui['status-badge'].dataset.state=state;}
function settings(){return {threshold:sensitivityThreshold(Number(ui.sensitivity.value)),polyphony:Number(ui.polyphony.value),attackMs:20,releaseMs:80,gateDb:-48};}
function refreshControls(){
  const busy=mode==='starting';
  ui['start-button'].classList.toggle('stopping',mode!=='idle');
  ui['start-button'].textContent=busy?'Cancel':mode==='idle'?'▶  Start listening':'■  Stop';
  ui['start-button'].disabled=audioBusy;
  ui['demo-button'].disabled=mode!=='idle'||audioBusy;
  ui['audio-input'].disabled=busy||audioBusy||mode==='demo';
  ui['audio-access'].disabled=mode!=='idle'||audioBusy;
}
function readableError(error){
  const texts={NotAllowedError:'Audio access was denied. Allow microphone access for this page in your browser’s site settings, then try again.',NotFoundError:'No audio input was found. Connect an input or install BlackHole, then refresh the devices.',NotReadableError:'The audio input could not be opened. Check that another application is not locking it, then try again.',OverconstrainedError:'The selected audio input is no longer available. Refresh the devices and choose another input.'};
  return texts[error.name]||error.message||'Something went wrong. Please try again.';
}
async function listInputs(actualId){
  if(!navigator.mediaDevices?.enumerateDevices)return;
  const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
  const wanted=actualId||ui['audio-input'].value||preferences.audio;
  ui['audio-input'].replaceChildren(new Option('Default audio input',''));
  for(const [index,device] of devices.entries())ui['audio-input'].add(new Option(device.label||`Audio input ${index+1}`,device.deviceId));
  if(devices.some(d=>d.deviceId===wanted))ui['audio-input'].value=wanted;
  else if(!actualId&&mode==='idle')ui['audio-input'].value=devices.find(d=>/blackhole/i.test(d.label))?.deviceId||'';
  const labelled=devices.some(d=>d.label);
  $('audio-help').textContent=labelled?'For computer audio, choose BlackHole.':'Enable audio to see your input devices.';
  return devices;
}
function constraints(){const id=ui['audio-input'].value;return {video:false,audio:{...(id?{deviceId:{exact:id}}:{}),channelCount:{ideal:2},echoCancellation:false,noiseSuppression:false,autoGainControl:false}};}
ui['audio-access'].onclick=async()=>{
  if(audioBusy||mode!=='idle')return;
  audioBusy=true;refreshControls();let probe;
  try{
    probe=await navigator.mediaDevices.getUserMedia(constraints());
    await listInputs();message('Audio inputs are ready. Choose your source, then start listening.');
    ui['audio-access'].textContent='Audio enabled';
  }catch(error){message(readableError(error),true);}finally{probe?.getTracks().forEach(t=>t.stop());audioBusy=false;refreshControls();}
};

function listMidi(){
  const wanted=ui['midi-output'].value||preferences.midi;
  const outputs=midiAccess?[...midiAccess.outputs.values()].filter(o=>o.state==='connected'):[];
  ui['midi-output'].replaceChildren(new Option('Visual only',''));
  for(const output of outputs)ui['midi-output'].add(new Option(output.name||'MIDI output',output.id));
  if(outputs.some(o=>o.id===wanted))ui['midi-output'].value=wanted;
  if(midi.output&&!outputs.some(o=>o.id===midi.output.id)){
    midi.setDestination(null);message('MIDI output disconnected. The piano roll is still available.',true);
  }
  const selected=outputs.find(o=>o.id===ui['midi-output'].value)||null;
  if(midi.output!==selected){midi.setDestination(selected,Number(ui['midi-channel'].value));if(mode==='live')midi.sync(active);}
  $('midi-help').textContent=outputs.length?'Choose an IAC bus to send notes to Max or a DAW.':'No MIDI ports found. Enable an IAC bus or connect a MIDI device.';
}
function setMidiDestination(){
  const output=midiAccess?.outputs.get(ui['midi-output'].value)||null;
  midi.setDestination(output,Number(ui['midi-channel'].value));
  if(mode==='live')midi.sync(active);
  remember();
}
ui['midi-access'].onclick=async()=>{
  if(!navigator.requestMIDIAccess){message('This browser does not provide Web MIDI. Use Chrome or Edge for MIDI output; visual detection still works.',true);return;}
  ui['midi-access'].disabled=true;
  try{
    midiAccess=await navigator.requestMIDIAccess({sysex:false});
    midiAccess.onstatechange=()=>{listMidi();};listMidi();setMidiDestination();
    ui['midi-access'].textContent='MIDI enabled';message('MIDI access enabled. Select an output, or leave Visual only selected.');
  }catch(error){message('MIDI permission was denied or is unavailable. You can still use the piano roll.',true);}
  finally{ui['midi-access'].disabled=false;}
};
ui['midi-output'].onchange=setMidiDestination;ui['midi-channel'].onchange=setMidiDestination;
$('refresh-button').onclick=async()=>{try{await listInputs();if(midiAccess)listMidi();message('Device lists refreshed.');}catch(error){message(readableError(error),true);}};
ui['audio-input'].onchange=async()=>{remember();if(mode==='live'){await stop();await start('live');}};
for(const id of ['sensitivity','polyphony'])ui[id].addEventListener('input',()=>{
  ui['sensitivity-value'].value=`${ui.sensitivity.value}%`;remember();worker?.postMessage({type:'configure',settings:settings()});
});
ui['time-span'].onchange=()=>{remember();draw();};
$('help-button').onclick=()=>{const guide=$('setup-guide');guide.hidden=!guide.hidden;$('help-button').setAttribute('aria-expanded',String(!guide.hidden));};

function applyEvents(events, stamp){
  for(const event of events){
    const note=Number(event.note);
    if(event.kind==='note_on'&&!held.has(note)){
      const rectangle={note,start:stamp,end:null,velocity:event.velocity};held.set(note,rectangle);history.push(rectangle);
    }else if(event.kind==='note_off'&&held.has(note)){held.get(note).end=stamp;held.delete(note);}
    if(mode==='live')midi.send(event);
  }
  // rAF pauses in background tabs; keep capture history bounded independently.
  history=history.filter(rect=>rect.end===null||rect.end>stamp-21).slice(-2000);
}
function updateNotes(){ui['detected-notes'].textContent=active.length?active.map(n=>noteName(n.note)).join('  ·  '):mode==='idle'?'No notes held':'Listening…';}
function clearHistory(){history=[];held=new Map();const now=clock();for(const n of active){const r={note:n.note,start:now,end:null,velocity:n.velocity};held.set(n.note,r);history.push(r);}draw();}
$('clear-button').onclick=clearHistory;
function clock(){return context?.state==='running'?context.currentTime:frozenTime;}

async function stop(text){
  const stamp=clock();session++;mode='idle';
  clearInterval(demoTimer);clearInterval(watchdog);demoTimer=watchdog=null;
  for(const node of demoNodes){try{node.stop();node.disconnect();}catch{}}demoNodes.clear();
  for(const rect of held.values())rect.end=stamp;held.clear();
  frozenTime=stamp;active=[];const released=midi.release();
  const oldContext=context;context=null;
  stream?.getTracks().forEach(track=>track.stop());stream=null;
  source?.disconnect();source=null;capture?.disconnect();capture=null;
  worker?.terminate();worker=null;
  ui['level-fill'].style.width='0%';ui['level-value'].textContent='— dB';ui['level-meter'].setAttribute('aria-valuenow','-60');
  status(hasFrames?'Stopped':'Ready');refreshControls();updateNotes();draw();
  if(text&&released)message(text);
  if(oldContext)await oldContext.close().catch(()=>{});
}

async function start(kind){
  if(mode!=='idle'||audioBusy)return;
  mode='starting';const token=++session;status('Starting');refreshControls();message(kind==='demo'?'Preparing a silent demo…':'Opening the audio input…');
  history=[];held=new Map();active=[];frozenTime=0;hasFrames=false;ui['empty-state'].hidden=true;
  try{
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)throw Error('Web Audio is unavailable in this browser. Try desktop Chrome or Edge.');
    const ctx=new Audio({latencyHint:'interactive'});context=ctx;
    await ctx.resume();
    if(token!==session){await ctx.close().catch(()=>{});return;}
    if(kind==='live'){
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Audio access requires HTTPS or localhost and a supported browser.');
      const input=await navigator.mediaDevices.getUserMedia(constraints());
      if(token!==session){input.getTracks().forEach(t=>t.stop());return;}
      stream=input;await listInputs(input.getAudioTracks()[0]?.getSettings().deviceId);remember();
      if(token!==session)return;
      for(const track of input.getTracks())track.addEventListener('ended',()=>{if(token===session)stop('Audio input disconnected. Reconnect it and start listening again.');});
      source=ctx.createMediaStreamSource(input);
    }else source=ctx.createGain();
    const engine=new Worker(new URL('./detector-worker.js',import.meta.url),{type:'module'});worker=engine;
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('The detector took too long to start. Reload the page and try again.')),15000);
      engine.onerror=event=>{clearTimeout(timeout);reject(Error(event.message||'Could not start the detector.'));};
      engine.onmessage=({data})=>{if(data.type==='ready'){clearTimeout(timeout);resolve();}else if(data.type==='error'){clearTimeout(timeout);reject(Error(data.message));}};
      engine.postMessage({type:'init',sampleRate:ctx.sampleRate,windowSize:4096,settings:settings()});
    });
    if(token!==session)return;
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js',import.meta.url));
    if(token!==session)return;
    capture=new AudioWorkletNode(ctx,'capture-processor',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:2,channelCountMode:'max',processorOptions:{windowSize:4096}});
    const tap=capture;
    capture.port.onmessage=({data})=>{if(token===session)engine.postMessage(data,[data.left,data.right]);};
    engine.onerror=event=>{if(token===session)fail(Error(event.message||'Audio analysis stopped.'));};
    engine.onmessage=({data})=>{
      if(token!==session)return;
      if(data.type==='error'){fail(Error(data.message));return;}
      if(data.type!=='result')return;
      if(ctx.currentTime-data.audioTime>.25){
        midi.release();for(const rect of held.values())rect.end=ctx.currentTime;held.clear();active=[];updateNotes();
        engine.postMessage({type:'reset'});tap.port.postMessage({type:'ready'});lastResult=performance.now();return;
      }
      lastResult=performance.now();frozenTime=data.audioTime;hasFrames=true;
      applyEvents(data.events,data.audioTime);active=data.active;updateNotes();
      const db=Number.isFinite(data.db)?data.db:-100;
      ui['level-value'].textContent=db<=-90?'−∞ dB':`${db.toFixed(0)} dB`;
      ui['level-fill'].style.width=`${Math.max(0,Math.min(100,(db+60)/60*100))}%`;
      ui['level-meter'].setAttribute('aria-valuenow',String(Math.max(-60,Math.min(0,db))));
      ui['processing-time'].textContent=`${data.processingMs.toFixed(1)} ms analysis`;
      tap.port.postMessage({type:'ready'});
    };
    capture.onprocessorerror=()=>{if(token===session)fail(Error('Audio capture stopped. Start listening again.'));};
    source.connect(capture);capture.connect(ctx.destination);
    mode=kind;lastResult=performance.now();status(kind==='demo'?'Demo':'Listening',kind==='demo'?'demo':'live');refreshControls();
    ui['analysis-window'].textContent=`${(4096/ctx.sampleRate*1000).toFixed(0)} ms window`;
    ui['analysis-window'].title='Analysis window length, not measured end-to-end latency.';
    ui['processing-time'].title='Time spent in the detector worker; excludes capture and MIDI delivery.';
    if(kind==='demo'){
      message('Demo: generated test tones through the detector. Silent, with no external MIDI output.');scheduleDemo(ctx,source,token);
    }else{
      message(`Listening to ${stream.getAudioTracks()[0]?.label||'the selected audio input'}. ${midi.output?'MIDI output is enabled.':'Visual only; enable MIDI to send notes.'}`);
      ui['audio-access'].textContent='Audio enabled';
    }
    ctx.onstatechange=()=>{if(token===session&&ctx.state==='suspended')stop('Audio was suspended by the browser. Start listening again to resume.');};
    watchdog=setInterval(()=>{
      if(token===session&&performance.now()-lastResult>1500)fail(Error('Audio analysis stopped responding. Start listening again to resume.'));
    },500);
  }catch(error){if(token===session)await fail(error);}
}
async function fail(error){const expected=session+1;await stop();if(session===expected){status('Needs attention','error');message(readableError(error),true);}}
function scheduleDemo(ctx,bus,token){
  const chords=[[60,64,67],[57,60,64],[53,57,60],[55,59,62]];let step=0;
  const play=()=>{
    if(token!==session)return;
    const at=ctx.currentTime+.02;
    for(const note of chords[step++%chords.length]){
      const oscillator=ctx.createOscillator(),gain=ctx.createGain();oscillator.type='triangle';oscillator.frequency.value=440*2**((note-69)/12);
      gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.12,at+.03);gain.gain.setValueAtTime(.12,at+1.1);gain.gain.linearRampToValueAtTime(0,at+1.18);
      oscillator.connect(gain);gain.connect(bus);oscillator.start(at);oscillator.stop(at+1.2);demoNodes.add(oscillator);
      oscillator.onended=()=>{demoNodes.delete(oscillator);oscillator.disconnect();gain.disconnect();};
    }
  };play();demoTimer=setInterval(play,1450);
}
ui['start-button'].onclick=()=>mode==='idle'?start('live'):stop('Stopped listening.');
ui['demo-button'].onclick=()=>start('demo');
window.addEventListener('pagehide',()=>{midi.release();stop();});
navigator.mediaDevices?.addEventListener('devicechange',async()=>{
  try{
    const id=stream?.getAudioTracks()[0]?.getSettings().deviceId;
    const devices=await listInputs(id);
    if(mode==='live'&&id&&!devices?.some(d=>d.deviceId===id))await stop('The selected audio input was removed. Choose another input.');
  }catch(error){message(readableError(error),true);}
});

const canvas=ui['piano-roll'],painter=canvas.getContext('2d');
let canvasWidth=0,canvasHeight=0;
function resize(){const rect=ui['roll-container'].getBoundingClientRect();canvasWidth=rect.width;canvasHeight=rect.height;const ratio=window.devicePixelRatio||1;canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio);painter.setTransform(ratio,0,0,ratio,0,0);draw();}
new ResizeObserver(resize).observe(ui['roll-container']);
function draw(){
  const w=canvasWidth,h=canvasHeight;if(!w||!h)return;
  const ctx=painter,keyWidth=61,top=26,bottom=14,noteHeight=(h-top-bottom)/49,right=w-22,span=Number(ui['time-span'].value),now=clock(),scale=(right-keyWidth)/span;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
  const isBlack=n=>[1,3,6,8,10].includes(n%12);
  for(let note=48;note<=96;note++){
    const y=top+(96-note)*noteHeight;
    ctx.fillStyle=isBlack(note)?'#f3f6f4':'#fff';ctx.fillRect(keyWidth,y,w-keyWidth,noteHeight);
    ctx.fillStyle=held.has(note)?'#d5eadd':isBlack(note)?'#e8eeea':'#fafcfb';ctx.fillRect(0,y,keyWidth,noteHeight);
    ctx.strokeStyle=note%12===0?'#cad9d0':'#e8eee9';ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(0,y+noteHeight);ctx.lineTo(w,y+noteHeight);ctx.stroke();
    if(isBlack(note)){ctx.fillStyle=held.has(note)?'#2c8762':'#60756a';ctx.fillRect(0,y+1,keyWidth*.56,Math.max(2,noteHeight-2));}
    if(note%12===0){ctx.fillStyle='#637b6c';ctx.font='10px -apple-system, sans-serif';ctx.textAlign='right';ctx.fillText(noteName(note),keyWidth-8,y+noteHeight*.73);}
  }
  const tick=span===20?4:2;
  ctx.font='10px -apple-system, sans-serif';ctx.textAlign='center';
  for(let offset=0;offset<=span;offset+=tick){
    const x=right-offset*scale;ctx.strokeStyle='#e1e9e3';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,h-bottom);ctx.stroke();ctx.fillStyle='#84998c';ctx.fillText(offset===0?'NOW':`−${offset}s`,x,16);
  }
  ctx.save();ctx.beginPath();ctx.rect(keyWidth,top,right-keyWidth,h-top-bottom);ctx.clip();
  for(const rect of history){
    if(rect.note<48||rect.note>96)continue;
    const start=right-(now-rect.start)*scale,end=right-(now-(rect.end??now))*scale;
    if(end<keyWidth||start>right)continue;
    const y=top+(96-rect.note)*noteHeight+1;
    ctx.fillStyle=mode==='demo'?`rgba(77,117,157,${.50+(rect.velocity||70)/127*.4})`:`rgba(37,133,93,${.50+(rect.velocity||70)/127*.4})`;
    ctx.beginPath();ctx.roundRect(start,y,Math.max(3,end-start),Math.max(2,noteHeight-2),2);ctx.fill();
    if(end-start>35&&noteHeight>10){ctx.fillStyle='#ffffffd9';ctx.font='9px -apple-system, sans-serif';ctx.textAlign='left';ctx.fillText(noteName(rect.note),start+5,y+noteHeight*.73);}
  }
  ctx.restore();ctx.strokeStyle='#82b497';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(right,top);ctx.lineTo(right,h-bottom);ctx.stroke();
  ctx.strokeStyle='#cfded4';ctx.beginPath();ctx.moveTo(keyWidth,top);ctx.lineTo(keyWidth,h-bottom);ctx.stroke();
  ui['empty-state'].hidden=mode!=='idle'||hasFrames;
}
function animate(){if(mode!=='idle')draw();requestAnimationFrame(animate);}requestAnimationFrame(animate);
if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode){
  message('Audio capture needs a modern browser over HTTPS or localhost. Try desktop Chrome or Edge.',true);
  ui['audio-access'].disabled=true;ui['start-button'].disabled=true;
}
if(!navigator.requestMIDIAccess){$('midi-help').textContent='Web MIDI unavailable here. Try Chrome or Edge; visual detection still works.';}
listInputs().catch(()=>{});
