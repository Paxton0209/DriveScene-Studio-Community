import test from 'node:test';
import assert from 'node:assert/strict';
import {DRIVING_EVENT_SECONDS} from '../interaction-duration.js';
import {sampleRoadworks,roadworksDuration,createElevatedRoadworks} from '../elevated-roadworks.js';
import {planRoadworksTraffic,ROADWORKS_CLEARED_DISTANCE} from '../roadworks-traffic.js';
import {planRoadLaneChange} from '../road-lane-change.js';
import {planAdjacentCutIn} from '../adjacent-cut-in.js';
import {overlaps} from '../parking-kinematics.js';
import {readFile} from 'node:fs/promises';

const seeded=seed=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const body=p=>({...p,width:2.1,length:4.94});
test('Driving duration is 15s for all Roadworks distances and the scene player',()=>{
 assert.equal(DRIVING_EVENT_SECONDS,15);
 for(const distance of ['near','mid','far'])assert.equal(roadworksDuration(distance),15);
 const previous=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:false});
 try{const player=createElevatedRoadworks({},null,null,()=>seeded(1));for(const event of ['roadworks','lanechange','cutin','collision','aes']){player.configure(event);assert.equal(player.duration,15)}}
 finally{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;}
});
test('After Roadworks the base and traffic routes continue moving through 15s without freezing at 10s',()=>{
 for(const offset of [-6,0,12]){
  const a=sampleRoadworks(10,false,offset),b=sampleRoadworks(15,false,offset);
  assert.ok(b.distance>a.distance+70);assert.equal(b.lift,0);assert.ok(Math.abs(b.yaw)<1e-8);
  for(let seed=1;seed<=32;seed++){
   const run=planRoadworksTraffic(seeded(seed),{duration:15,width:3.7,clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset,offset,adaptiveTraffic:true});
   assert.ok(run.sample(15).distance>run.sample(10).distance+40);
   for(let t=10;t<=15;t+=.1){const f=run.sample(t),ego=body({x:f.x,z:0,yaw:f.yaw});for(const car of f.traffic)assert.equal(overlaps(ego,body(car),.1),false,`Roadworks seed ${seed} at ${t}`)}
   assert.deepEqual(run.sample(12).traffic,run.sample(12).traffic);
  }
 }
});
test('Lane change, Cut-in and Merge keep moving in the new tail and avoid ego body overlap',()=>{
 for(let seed=1;seed<=32;seed++)for(const layout of ['lanechange','02','06','07']){
  const egoX=layout==='06'||layout==='07'?3.7:1.85;
  const run=layout==='lanechange'?planRoadLaneChange(seeded(seed),{egoX,laneWidth:3.7}):planAdjacentCutIn(seeded(seed),{layout,egoX});
  if(run(0).rampMerge?.strategy==='wait')assert.equal(run(15).distance,run(10).distance);
  else assert.ok(run(15).distance>run(10).distance+35);
  for(let t=10;t<=15;t+=.1){const f=run(t),ego=body({x:egoX+f.x,z:0,yaw:f.yaw});assert.equal(f.lift,0);for(const car of f.traffic)assert.equal(overlaps(ego,body(car),.1),false,`${layout} seed ${seed} at ${t}`)}
  const later=run(14).traffic;run(2);assert.deepEqual(run(14).traffic,later);
 }
});
test('The prototype timeline and event video export consume the event duration',async()=>{
 const ui=await readFile(new URL('../pro-prototype/prototype.js',import.meta.url),'utf8');
 assert.match(ui,/const TOTAL = DRIVING_EVENT_SECONDS/);
 assert.match(ui,/S.event === JUNCTION_LEFT_TURN \? S.junctionTiming\?\.duration \?\? junctionDuration : TOTAL/);
 assert.match(ui,/range.max = Math.round\(total\(\) \* 100\)/);
 const bridge=await readFile(new URL('../engine-bridge.js',import.meta.url),'utf8');
 assert.match(bridge,/if\(eventVideo\)duration=Math.ceil\(\(eventDuration\(\)-startTime\)\*30/);
});
