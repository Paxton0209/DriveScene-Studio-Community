import test from 'node:test';
import assert from 'node:assert/strict';
import {planLiveCutIn} from '../adjacent-cut-in.js';
import {JUNCTION_LEFT_TIMING,junctionLeftPath,planJunctionTurn} from '../junction-left-turn.js';
import {planRoadworksTraffic,ROADWORKS_CLEARED_DISTANCE} from '../roadworks-traffic.js';

test('an early Junction release never runs out of rendered road at cruise speed',()=>{
 const run=planJunctionTurn(()=>.45,-22.3);
 assert.equal(run.timing.turnAt,JUNCTION_LEFT_TIMING.turnAt);
 const [end]=junctionLeftPath().at(-1);
 for(let t=run.timing.duration-1;t<=run.timing.duration;t+=.05){
  const {x,speed}=run.sample(t);
  assert.equal(speed*3.6,80);
  assert.ok(x-end-3>=2.15*speed,'room for the ribbon plus vehicle nose and renderer margin');
 }
});

test('Road reuses a faster adjacent car starting behind ego, without teleporting or changing its speed',()=>{
 const actor={id:'overtaker',x:9.25,z:10,yaw:0,direction:-1,speed:29};
 const {sample,timing}=planLiveCutIn(()=>.5,{egoX:5.55,outerLane:9.25,speed:22,traffic:[actor]});
 assert.ok(timing.merge>actor.z/(actor.speed-22));
 assert.equal(sample(0).traffic.length,1);
 assert.equal(sample(0).traffic[0].z,10);
 for(let t=0;t<=15;t+=.05){
  const frame=sample(t), car=frame.traffic[0];
  assert.equal(car.id,actor.id);
  assert.equal(car.speed,actor.speed);
  assert.ok(Math.abs(frame.distance-car.z-(actor.speed*t-10))<1e-9);
  if(Math.abs(car.x-5.55)<2)assert.ok(car.z<=-8);
 }
 assert.ok(Math.abs(sample(timing.inLane).traffic[0].x-5.55)<1e-9);
});

test('a late safe Roadworks pass extends the timeline with a visible cruise tail',()=>{
 const offset=180, clear=ROADWORKS_CLEARED_DISTANCE+offset;
 const run=planRoadworksTraffic(()=>.5,{
  duration:15,width:3.7,offset,clearedDistance:clear,
  adaptiveTraffic:true,trafficEnabled:false,extendUntilClear:true,
 });
 const {mergeAt,passAt,clearAt,endAt}=run.timing;
 assert.ok(mergeAt<passAt&&passAt<clearAt&&clearAt>15);
 assert.ok(endAt-clearAt>=2);
 assert.ok(run.sample(clearAt).distance>=clear);
 assert.ok(run.sample(endAt).distance>clear+20);
});

test('a closed gap keeps the Roadworks replay waiting upstream at the end',()=>{
 const run=planRoadworksTraffic(()=>.5,{
  duration:15,width:3.7,clearedDistance:ROADWORKS_CLEARED_DISTANCE,
  adaptiveTraffic:true,trafficEnabled:false,holdLane:true,extendUntilClear:true,
 });
 assert.equal(run.timing.clearAt,Infinity);
 assert.ok(Number.isFinite(run.timing.waitAt));
 const last=run.sample(run.timing.endAt);
 assert.ok(last.speed<.01);
 assert.ok(last.distance<ROADWORKS_CLEARED_DISTANCE);
});

test('reactivating Roadworks in the open lane does not yield a merge to a rear vehicle',()=>{
 const speed=80/3.6, width=3.7;
 const rear={id:'rear',direction:-1,speedAt:()=>speed,xAt:()=>-width,distanceAt:t=>speed*t-15};
 const run=planRoadworksTraffic(()=>.5,{
  duration:15,width,clearedDistance:ROADWORKS_CLEARED_DISTANCE,
  initial:{speed,entryX:-width},liveFleet:[rear],adaptiveTraffic:true,extendUntilClear:true,
 });
 assert.equal(run.timing.mergeAt,0);
 assert.equal(run.timing.waitAt,Infinity);
 assert.ok(Number.isFinite(run.timing.clearAt));
 assert.equal(run.sample(6).x,-width);
});
