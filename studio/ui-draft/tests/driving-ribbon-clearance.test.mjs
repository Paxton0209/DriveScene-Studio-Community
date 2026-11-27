import assert from 'node:assert/strict';
import {test} from 'node:test';
import {drivingRibbonEnd} from '../driving-ribbon-clearance.js';
import {planLiveCutIn} from '../adjacent-cut-in.js';

const path = {plan:{x:0}};
const length = (cars, pathX = () => 0, end = 42) =>
 drivingRibbonEnd(path, 0, .5, cars, pathX, 2, end, (_, __, ___, z) => -z);
const lead = {x:0,z:-26,yaw:0,direction:-1,constraining:false};

test('The ribbon leaves a 1.8 m gap behind a grey leader at any yaw', () => {
 for (const yaw of [0,.25,Math.PI/4,Math.PI/2]) {
  const rear = -lead.z - 2.45 * Math.cos(yaw) - 1.05 * Math.sin(yaw);
  assert.ok(Math.abs(length([{...lead,yaw}]) - (rear - 1.8)) < 1e-9);
 }
 assert.equal(length([{...lead,x:3.7}]),42,'a parallel car in the next lane leaves the ribbon at full length');
 assert.equal(length([{...lead,opacity:0}]),42);
 assert.equal(length([{...lead,z:-65}]),42);
});

test('A crossing car moves the ribbon endpoint smoothly as its body approaches and leaves the path', () => {
 const samples = Array.from({length:371},(_,i) => length([{...lead,x:i/100}]));
 assert.equal(samples[0],length([lead]));
 assert.equal(samples.at(-1),42);
 assert.ok(samples.some(end => end > samples[0] && end < 42));
 for (let i=1;i<samples.length;i++){
  assert.ok(samples[i]>=samples[i-1]);
  assert.ok(samples[i]-samples[i-1]<.35);
 }
 const angled = {...lead,x:3.5,yaw:.3};
 assert.ok(length([angled],z => z < -24 ? 3.7 : 2)<30,'look along the changing path across the entire car');
});

test('Road Cut-in keeps the ribbon clear of the grey car after settling and seeks deterministically', () => {
 const adjacent = {...lead,id:'adjacent',x:9.25,z:-24,speed:15};
 const {sample,timing}=planLiveCutIn(()=>.5,{egoX:5.55,outerLane:9.25,speed:16,traffic:[adjacent]});
 const ribbonAt = time => {
  const frame=sample(time);
  return length(frame.traffic,frame.pathX,2+2.5*frame.speed);
 };
 sample(0);
 const times=[0,timing.impactAt-.02,timing.impactAt+.02,timing.inLane,11.3,15];
 const ends=times.map(ribbonAt);
 for (const time of [15,0,11.3,timing.impactAt]) ribbonAt(time);
 assert.deepEqual(times.map(ribbonAt),ends);
 assert.ok(Math.abs(ends[2]-ends[1])<1,'feedback activation does not snap the endpoint');
 const car=sample(11.3).traffic[0];
 assert.equal(car.trafficFeedback.level,0);
 assert.ok(-car.z-2.45-ends[4]>=1.8-1e-9);
});
