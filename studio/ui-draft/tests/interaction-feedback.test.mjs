import test from 'node:test';
import assert from 'node:assert/strict';
import {JUNCTION_LEFT_TIMING, junctionTrafficFeedback, sampleJunctionLeftTurn} from '../junction-left-turn.js';
import {planRoadLaneChange} from '../road-lane-change.js';

test('Left turn: the safe gap replay never warns on traffic that has passed or is still clear', () => {
 const stopZ = -20;
 const feedback=junctionTrafficFeedback(stopZ);
 for (let frame = 0; frame <= JUNCTION_LEFT_TIMING.duration * 40; frame++) {
  const time = frame / 40;
  const ego = sampleJunctionLeftTurn(time, stopZ);
  for (const car of ego.oncoming) assert.equal(feedback(car.id,time).level,0,car.id+' at '+time);
 }
});

test('Lane change: the target gap is bounded by cars close enough to read in frame', () => {
 for (let seed = 1; seed <= 200; seed++) {
  let x = seed * 9301 % 233280;
  const random = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  const run = planRoadLaneChange(random, {egoX: 1.85, laneWidth: 3.7});
  const start = run(0), intruder = start.traffic.some(car => car.id === 'lane-change-intruder') || run(3).traffic.some(car => car.id === 'lane-change-intruder');
  const ahead = start.traffic.find(car => car.id === 'lane-change-ahead');
  const behind = start.traffic.find(car => car.id === 'lane-change-behind');
  assert.ok(behind.z >= 22 && behind.z <= 39, 'a trailing car bounds the gap');
  if (!intruder) assert.ok(-ahead.z >= 32 && -ahead.z <= 38, 'a car closes the gap ahead');
  for (let t = 0; t <= 10; t += .05) {
   const frame = run(t), ego = 1.85 + frame.x;
   for (const car of frame.traffic) if (car.direction < 0 && Math.abs(car.x - ego) < 2.25) assert.ok(Math.abs(car.z) > 8, car.id + ' keeps room from the vehicle');
  }
 }
});

test('Merge: all runs last 15 seconds with continued movement after the camera returns', async () => {
 const {planAdjacentCutIn} = await import('../adjacent-cut-in.js');
 for (let seed = 1; seed <= 64; seed++) {
  let x = seed * 7919 % 233280;
  const random = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  const run = planAdjacentCutIn(random, {layout: '07', egoX: 3.7}), {rampMerge} = run(0);
  assert.equal(rampMerge.endAt, 15);
  if(rampMerge.strategy==='wait'){
   assert.equal(run(15).speed,0);
   assert.ok(run(15).x>2.25);
   continue;
  }
  assert.ok(15-rampMerge.cameraHomeAt>=3,'a complete camera return leaves time to drive');
  assert.ok(run(15).distance>run(12).distance+20,'the tail drives instead of freezing the last pose');
  assert.ok(run(15).speed>0);assert.equal(run(15).lift,0);
  assert.deepEqual(run(12).traffic,run(12).traffic,'seeking the tail stays deterministic');
 }
});

test('Live Cut-in uses the current lane, keeps a suitable car on its existing trajectory, and varies timing', async () => {
 const {planLiveCutIn} = await import('../adjacent-cut-in.js');
 const sourceCar = {id:'right-lane-car', x:9.25, z:-23, direction:-1, yaw:0, speed:15};
 const other = {id:'opposing', x:-1.85, z:-70, direction:1, yaw:Math.PI, speed:16};
 const timings = new Set(), usedSides = new Set();
 for (let seed = 1; seed <= 18; seed++) {
  let value = seed;
  const random = () => ((value = (value * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const {sample, timing} = planLiveCutIn(random, {egoX:5.55, outerLane:9.25, speed:16, traffic:[sourceCar, other]});
  const actor = time => sample(time).traffic.find(car => car.id === sourceCar.id);
  assert.equal(actor(0).x, sourceCar.x);
  assert.equal(actor(0).z, sourceCar.z);
  assert.equal(actor(0).speed, sourceCar.speed);
  assert.ok(Math.abs(actor(timing.inLane).x - 5.55) < 1e-9);
  for (let t = 0; t < 15; t += .25) {
   const frame = sample(t), car = actor(t);
   assert.equal(frame.x, 0);
   assert.equal(frame.pathX(-20), 5.55);
   assert.equal(car.speed,sourceCar.speed);
   assert.ok(Math.abs(frame.distance-car.z-(-sourceCar.z+sourceCar.speed*t))<1e-8);
   if (Math.abs(car.x - 5.55) < 2) assert.ok(car.z < -8);
  }
  assert.ok(sample(timing.inLane).speed < 16);
  assert.ok(actor(timing.impactAt).trafficFeedback.yellow > 0);
  timings.add(timing.merge);
  const fallback = planLiveCutIn(random, {egoX:5.55, outerLane:9.25, speed:16, traffic:[]});
  const incoming = fallback.sample(0).traffic[0];
  assert.equal(incoming.growth,incoming.z>0?1:0);
  assert.equal(fallback.sample(.6).traffic[0].growth,1);
  assert.equal(fallback.sample(12).traffic[0].speed,incoming.speed);
  usedSides.add(Math.round(incoming.x * 100));
 }
 assert.ok(timings.size > 1);
 assert.deepEqual([...usedSides].sort((a,b)=>a-b), [185,925]);
 const outside = planLiveCutIn(() => .5, {egoX:5.55, outerLane:5.55, speed:16, traffic:[]});
 assert.ok(Math.abs(outside.sample(0).traffic[0].x - 1.85) < 1e-9);
});

test('Live Cut-in also yields to a slow leader that was already in the current lane', async () => {
 const {planLiveCutIn} = await import('../adjacent-cut-in.js');
 const leader = {id:'leader',x:5.55,z:-32,yaw:0,speed:11,direction:-1};
 const {sample} = planLiveCutIn(() => .5,{egoX:5.55,outerLane:9.25,speed:21,traffic:[leader]});
 assert.equal(sample(0).speed,21);
 for (let frame=0;frame<=300;frame++){
  const time=frame/20, pose=sample(time), car=pose.traffic.find(car=>car.id===leader.id);
  assert.equal(car.speed,11);
  assert.ok(Math.abs(pose.distance-car.z-(32+11*time))<1e-8);
  assert.ok(car.z<=-7);
  assert.equal(pose.x,0);
 }
 assert.ok(sample(15).speed<=11);
});

test('Cut-in keeps a distant car in its lane and uses another car to slow ego', async () => {
 const {planLiveCutIn} = await import('../adjacent-cut-in.js');
 const actor = {id:'adjacent', x:9.25, direction:-1, yaw:0, speed:15};
 for (const [gap, selected] of [[46,false],[24,true]]) {
  const {sample,timing} = planLiveCutIn(() => .5, {
   egoX:5.55, outerLane:9.25, speed:16, traffic:[{...actor,z:-gap}],
  });
  assert.equal(timing.actorId === actor.id, selected);
  assert.ok(timing.impactAt<timing.inLane);
  const frame = sample(timing.inLane), car = frame.traffic.find(car => car.id === actor.id);
  assert.ok(frame.speed < 16);
  assert.equal(car.trafficFeedback.yellow > 0, Boolean(car.constraining));
  if (selected) assert.ok(sample(timing.impactAt).traffic.find(c=>c.id===actor.id).trafficFeedback.yellow>0);
  assert.equal(car.speed,actor.speed);
  assert.equal(sample(timing.merge).lift,0);
  const before=sample(timing.impactAt-.05);
  const merging=before.traffic.find(car => car.id === timing.actorId);
  assert.equal(before.speed,16);
  assert.equal(merging.trafficFeedback.level,0);
  assert.equal(merging.corridorInfluence,0);
  assert.ok(sample(timing.cameraRiseAt+.75).lift>.49);
  assert.equal(sample(timing.cameraReturnAt+1.4).lift,0);
  assert.equal(car.x,selected ? 5.55 : actor.x);
  assert.ok(Math.abs(frame.distance-car.z-gap-actor.speed*timing.inLane)<1e-8);
 }
});

test('A carried yellow flank car releases its warning when the new plan has no constraint',async()=>{
 const {planLiveCutIn} = await import('../adjacent-cut-in.js');
 const flank={id:'flank',x:9.25,z:-75,direction:-1,yaw:0,speed:16,constraining:true,corridorInfluence:1};
 const {sample}=planLiveCutIn(()=>.5,{egoX:5.55,outerLane:9.25,traffic:[flank],speed:16});
 for(const time of [0,2,5,12]){
  const frame=sample(time),car=frame.traffic.find(car=>car.id===flank.id);
  assert.equal(car.trafficFeedback.level,0);
  assert.equal(car.corridorInfluence,0);
 }
});
