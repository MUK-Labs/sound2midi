import test from 'node:test';
import assert from 'node:assert/strict';
import {MidiRouter,sensitivityThreshold} from './midi.js';
function port(){return {state:'connected',sent:[],send(message){this.sent.push(message);}};}
test('higher sensitivity lowers the threshold',()=>{assert.ok(sensitivityThreshold(90)<sensitivityThreshold(20));});
test('changing output releases old notes on old channel first',()=>{
 const a=port(),b=port(),router=new MidiRouter();router.setDestination(a,3);router.send({kind:'note_on',note:60,velocity:90});router.setDestination(b,6);router.sync([{note:64,velocity:80}]);
 assert.deepEqual(a.sent,[[0x92,60,90],[0x82,60,0]]);assert.deepEqual(b.sent,[[0x95,64,80]]);router.release();assert.deepEqual(b.sent.at(-1),[0x85,64,0]);
});
test('release is idempotent, sends only owned notes and never global panic',()=>{
 const p=port(),router=new MidiRouter();router.setDestination(p);router.send({kind:'note_on',note:60});router.send({kind:'note_on',note:60});router.send({kind:'note_off',note:70});router.release();router.release();assert.equal(p.sent.length,2);assert.ok(p.sent.every(m=>(m[0]&0xf0)!==0xb0));
});
test('failure on one release still attempts the other notes',()=>{
 const p=port(),errors=[],router=new MidiRouter(e=>errors.push(e));router.setDestination(p);router.sync([{note:60},{note:64}]);p.send=message=>{p.sent.push(message);if(message[1]===60)throw Error('gone');};router.release();assert.equal(errors.length,1);assert.equal(p.sent.at(-1)[1],64);assert.equal(router.owned.size,0);
 assert.equal(router.output,null);
});
test('failed Note Off releases all owned voices and disables output with one error',()=>{
 const p=port(),errors=[],router=new MidiRouter(e=>errors.push(e));router.setDestination(p,4);router.sync([{note:60},{note:64},{note:67}]);
 const sentBefore=p.sent.length;
 p.send=message=>{p.sent.push(message);throw Error('MIDI transport failed');};
 router.send({kind:'note_off',note:60});
 assert.deepEqual(p.sent.slice(sentBefore),[[0x83,60,0],[0x83,60,0],[0x83,64,0],[0x83,67,0]]);
 assert.equal(errors.length,1);assert.equal(router.output,null);assert.equal(router.owned.size,0);
 const attempts=p.sent.length;
 router.send({kind:'note_on',note:72,velocity:90});router.sync([{note:76,velocity:80}]);router.release();
 assert.equal(p.sent.length,attempts);assert.equal(errors.length,1);
 const recovered=port();router.setDestination(recovered,2);router.sync([{note:72,velocity:90}]);
 assert.deepEqual(recovered.sent,[[0x91,72,90]]);
});
test('a disconnect observed before sending releases owned notes best-effort once',()=>{
 const p=port(),errors=[],router=new MidiRouter(e=>errors.push(e));router.setDestination(p);router.send({kind:'note_on',note:60,velocity:90});p.state='disconnected';
 router.send({kind:'note_off',note:60});router.send({kind:'note_off',note:60});
 assert.deepEqual(p.sent.at(-1),[0x80,60,0]);assert.equal(errors.length,1);assert.equal(router.output,null);
});
