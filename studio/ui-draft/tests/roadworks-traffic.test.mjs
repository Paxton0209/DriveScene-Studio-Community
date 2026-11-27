import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createInteractionTraffic, sampleFollowingEvent, planFollowingFeedback} from '../elevated-following.js';
import {planAdjacentCutIn} from '../adjacent-cut-in.js';
import {planRampMerge} from '../ramp-merge.js';
import {mergeRampLaneX} from '../ramp-lanes.js';
import {CUT_IN_TIMING} from '../cut-in-timing.js';
import {
 coordinateWorkZone, planLiveWorkZone, ROADWORKS_CLEARED_DISTANCE, planRoadworksTraffic, ROADWORKS_CONE_START, ROADWORKS_CONE_SPACING, ROADWORKS_TAPER_INTERVALS,
} from '../roadworks-traffic.js';

function randomForSeed(seed) {
 let state = seed;
 return () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
 };
}

const config = {duration:10, width:3.7, clearedDistance:ROADWORKS_CONE_START + 13 * ROADWORKS_CONE_SPACING + 6};

test('At 2.7 seconds of Roadworks approach a passing left car stays grey until it delays a signaled merge',()=>{
 const leftCar={id:'passing',direction:-1,xAt:()=>-3.7,speedAt:()=>19,distanceAt:t=>12+19*t};
 const run=planRoadworksTraffic(()=>.15,{...config,duration:15,adaptiveTraffic:true,extendUntilClear:true,liveFleet:[leftCar]});
 const at=time=>run.sample(time);
 const passing=frame=>frame.traffic.find(car=>car.id==='passing');
 const approach=at(2.7);
 assert.equal(approach.x,0);
 assert.equal(approach.waitAt,undefined);
 assert.equal(passing(approach).trafficFeedback.yellow,0);
 assert.ok(run.timing.waitAt>=run.timing.signalAt+.55&&run.timing.waitAt<run.timing.mergeAt);
 assert.equal(passing(at(run.timing.waitAt+.06)).trafficFeedback.yellow,1);
 assert.equal(passing(at(run.timing.mergeAt+.06)).trafficFeedback.yellow,0);
});
test('Reported live yellow car keeps a continuous heading and one amber interval at 120 Hz',()=>{
 const fleet=[
 ['z:3.7:-1:0',3.7,47.12596418598692,21.58604279245829,-1],
 ['z:3.7:-1:1',3.7,80.60923448050349,23.22407422640309,-1],
 ['z:-3.7:-1:0',-3.7,82.58776471349006,23.650175632624368,-1],
 ['z:0:-1:0',0,116.39112591281044,21.953376910998486,-1],
 ['z:-12.7:1:0',-12.7,-32.53950030273275,22.818366228408802,1],
 ['z:-16.4:1:0',-16.4,110.69041126913376,22.547706931519013,1],
 ].map(([id,x,station,speed,direction])=>({id,x,station,speed,direction}));
 const speed=80/3.6,offset=(5.3219675516589655-1.4)*speed;
 const random=()=>.5;random.reset=()=>{};
 const run=coordinateWorkZone(random,fleet,{width:3.7,duration:15,offset,initial:{speed,entryX:0},
  adaptiveTraffic:true,extendUntilClear:true,clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset});
 let previous,started=null,intervals=[];
 for(let i=0;i<=run.timing.endAt*120;i++){
  const time=i/120,frame=run.sample(time),car=frame.traffic.find(c=>c.id==='z:3.7:-1:1');
  checkClearance(frame,offset);
  if(time>=7&&time<=10&&previous)assert.ok(Math.abs(car.yaw-previous.yaw)<.01,'body snapped at '+time);
  if(car.cutInTint&&started===null)started=time;
  if(!car.cutInTint&&started!==null){intervals.push([started,time]);started=null;}
  previous=car;
 }
 assert.ok(intervals.length<=1,'do not flash amber in multiple short pulses');
 for(const [from,to] of intervals)assert.ok(to-from>.4,'amber interval must reflect sustained conflict');
 const reference=run.sample(9.825).traffic;
 for(const t of [0,15,8.76,9.9,4.4])run.sample(t);
 assert.deepEqual(run.sample(9.825).traffic,reference);
});

test('Reported Elevated 4.4s and 9.9s fleet clears before encounter without false braking or amber pulses',()=>{
 const carried=[
  ['z:3.7:-1:0',3.7,65.56808478476613,23.118357525504972,-1],
  ['z:3.7:-1:1',3.7,105.65737832827139,23.315145066771137,-1],
  ['z:-3.7:-1:0',-3.7,89.28150094952278,23.267631211964826,-1],
  ['z:0:-1:0',0,145.169576874217,21.862819852423854,-1],
 ].map(([id,x,station,speed,direction])=>({id,x,station,speed,direction}));
 const speed=80/3.6,width=3.7,duration=15;
 const {offset}=planLiveWorkZone(carried,width,0,duration,speed);
 const random=()=>.5;random.reset=()=>{};
 const run=coordinateWorkZone(random,carried,{width,duration,offset,initial:{speed,entryX:0},
  adaptiveTraffic:true,extendUntilClear:true,clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset});
 assert.equal(run.sample(4.4).speed,speed,'no traffic-induced braking before the work-zone slowdown');
 assert.ok(run.sample(9.9).speed>=60/3.6,'do not brake behind a car in the lane ego is clearing');
 for(let i=0;i<=Math.floor(run.timing.endAt*120);i++){
  const frame=run.sample(i/120);checkClearance(frame,offset);
  assert.ok(frame.traffic.every(car=>!car.cutInTint),'amber pulse at '+i/120);
 }
 const at=run.sample(9.9);
 for(const t of [run.timing.endAt,4.4,0,9.9,4.39,9.91])run.sample(t);
 assert.deepEqual(run.sample(9.9).traffic,at.traffic,'backward scrubbing cannot change feedback');
});

test('Traffic queued at a right-hand work zone keeps a renderable pose through a stop and a backward seek', () => {
 // Initial lane positions, speeds and stations from the reported Elevated replay.
 const carried = [
  [3.7, 23.53, 45.99], [3.7, 23.61, 88.99], [-3.7, 23.29, 98.82], [0, 22.17, 105.90],
  [-12.7, 22.69, 1.70], [-16.4, 22.65, 141.15],
 ].map(([x, speed, station], index) => ({
  id: String(index), x: index < 4 ? -x : x, speed, station, direction: index < 4 ? -1 : 1,
 }));
 const width = 3.7, speed = 80 / 3.6, duration = 15;
 const {offset} = planLiveWorkZone(carried, width, 0, duration, speed);
 const random = () => .5;
 random.reset = () => {};
 const run = coordinateWorkZone(random, carried, {width, duration, offset, initial: {speed, entryX: 0},
  adaptiveTraffic: true, extendUntilClear: true, clearedDistance: ROADWORKS_CLEARED_DISTANCE + offset});
 const atMid = run.sample(9.8).traffic;
 // With an open gap after the passing left-lane cars, middle/right cars smoothly
 // zipper-merge out instead of stalling nose-to-cones.
 assert.ok(atMid.filter(car => car.direction < 0 && car.speed > 2).length >= 3);
 for (const time of [7.4, 8.5, 9.8, 14, 9.8, 7.4, 0]) {
  const fleet = run.sample(time).traffic;
  assert.deepEqual(fleet.map(car => car.id), carried.map(car => car.id));
  for (const car of fleet) assert.ok([car.x, car.z, car.yaw].every(Number.isFinite),
   'Unrenderable vehicle ' + car.id + ' at ' + time + ' s');
 }
 assert.deepEqual(run.sample(9.8).traffic, atMid);
 // A genuinely occupied open lane still holds closed-lane traffic with finite poses.
 const blocked = [
  [-3.7, 15, 40], [-3.7, 15, 62], [-3.7, 15, 84], [-3.7, 15, 106], [-3.7, 15, 128],
  [0, 18, 92],
 ].map(([x, speed, station], index) => ({id: 'b' + index, x, speed, station, direction: -1}));
 const {offset: blockedOffset} = planLiveWorkZone(blocked, width, 0, duration, speed);
 const blockedRun = coordinateWorkZone(random, blocked, {width, duration, offset: blockedOffset, initial: {speed, entryX: 0},
  adaptiveTraffic: true, extendUntilClear: true, clearedDistance: ROADWORKS_CLEARED_DISTANCE + blockedOffset});
 const stoppedFrame = blockedRun.sample(6.5).traffic;
 assert.ok(stoppedFrame.some(car => car.id === 'b5' && car.speed < .5));
 for (const time of [4, 6.5, 10, 6.5, 0]) {
  for (const car of blockedRun.sample(time).traffic) {
   assert.ok([car.x, car.z, car.yaw].every(Number.isFinite), 'Unrenderable queued car ' + car.id + ' at ' + time);
  }
 }
});

test('Elevated Roadworks Auto camera lifts when a vehicle triggers yellow or red alert and still lifts only once', () => {
 let yellowRuns = 0, redRuns = 0;
 for (let seed = 1; seed <= 48; seed++) {
  let s = seed * 79271;
  const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  rng.reset = () => { s = seed * 79271; };
  const fleet = Array.from({length: 5}, (_, id) => ({
   id: 'c' + id, direction: -1, speed: 17 + rng() * 8, station: 31 * id - 38 + rng() * 12,
   x: 3.7 * (Math.floor(3 * rng()) - 1),
  })).filter(c => c.x !== 0 || Math.abs(c.station) > 14);
  const {offset} = planLiveWorkZone(fleet, 3.7, 0, 15, 22);
  const run = coordinateWorkZone(rng, fleet, {
   duration: 15, width: 3.7, offset, initial: {speed: 22, entryX: 0},
   adaptiveTraffic: true, extendUntilClear: true, clearedDistance: ROADWORKS_CLEARED_DISTANCE + offset,
  });
  const riseAt = run.sample(0).cameraRiseAt;
  let sawYellow = false, sawRed = false;
  for (let t = 0; t <= run.timing.endAt; t += .05) {
   const frame = run.sample(t);
   if (!sawYellow && frame.traffic.some(car => car.trafficFeedback?.level === 1)) {
    sawYellow = true;
    yellowRuns++;
    assert.ok(riseAt <= t + 1e-6, `seed ${seed}: yellow alert at ${t}s before cameraRiseAt ${riseAt}s`);
   }
   if (!sawRed && frame.traffic.some(car => car.trafficFeedback?.level === 2)) {
    sawRed = true;
    redRuns++;
    assert.ok(riseAt <= t + 1e-6, `seed ${seed}: red alert at ${t}s before cameraRiseAt ${riseAt}s`);
   }
  }
 }
 assert.ok(yellowRuns > 0, 'exercise at least one live yellow-alert work-zone run');
 assert.ok(redRuns > 0, 'exercise at least one live red-alert work-zone run');
});

test('Elevated Roadworks cone-blocked vehicle randomly either merges ahead of ego or yields until ego passes', () => {
 const fleet = [
  {id: 'left-1', x: -3.7, station: 85, speed: 21, direction: -1},
  {id: 'left-2', x: -3.7, station: 55, speed: 21, direction: -1},
  {id: 'mid-stuck', x: 0, station: 72, speed: 16, direction: -1},
  {id: 'right-stuck', x: 3.7, station: 64, speed: 17, direction: -1},
 ];
 const {offset} = planLiveWorkZone(fleet, 3.7, 0, 15, 22);
 let ahead = 0, behind = 0;
 for (let seed = 1; seed <= 32; seed++) {
  let s = seed * 99991;
  const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  rng.reset = () => { s = seed * 99991; };
  const run = coordinateWorkZone(rng, fleet, {
   duration: 15, width: 3.7, offset, initial: {speed: 22, entryX: 0},
   adaptiveTraffic: true, extendUntilClear: true, clearedDistance: ROADWORKS_CLEARED_DISTANCE + offset,
  });
  for (const id of ['mid-stuck', 'right-stuck']) {
   for (let t = 0; t <= run.timing.endAt; t += .1) {
    const c = run.sample(t).traffic.find(x => x.id === id);
    if (c && c.x < -1.85) {
     if (c.z < 0) ahead++;
     else behind++;
     break;
    }
   }
  }
 }
 assert.ok(ahead > 0 && behind > 0, `expected both merge-ahead (${ahead}) and yield-behind (${behind}) outcomes across seeds`);
});

test('Ramp Merge keeps cameraYaw and inner-ramp merge yaw smooth without single-frame snaps', () => {
 for (let seed = 0; seed < 32; seed++) {
  const run = planRampMerge(randomForSeed(Math.imul(seed, 123456789)), 3.7);
  let prev = null;
  for (let i = 0; i <= 600; i++) {
   const frame = run(i / 60);
   if (prev) {
    assert.ok(Math.abs(frame.cameraYaw - prev.cameraYaw) < .006, `seed ${seed}: cameraYaw jumped at ${i / 60}s`);
    const comp = frame.traffic.find(c => c.id === 'merge-companion');
    const prevComp = prev.traffic.find(c => c.id === 'merge-companion');
    if (comp && prevComp) {
     assert.ok(Math.abs(comp.yaw - prevComp.yaw) < .016, `seed ${seed}: inner ramp car yaw snapped at ${i / 60}s`);
    }
   }
   prev = frame;
  }
 }
});

test('Roadworks traffic yields to both conflicts, varies on a new seed and can be scrubbed', () => {
 const samples = new Set(), counts = new Set(), conflicts = new Set();
 for (let i = 0; i < 96; i++) {
  const seed = Math.imul(i, 123456789);
  const plan = planRoadworksTraffic(randomForSeed(seed), config);
  const initial = plan.sample(0);
  const cars = initial.traffic;
  const passing = cars.find(car => car.id === 'passing');
  const right = cars.find(car => car.id === 'right');
  const conflict = passing ? 'left' : right.z > -30 ? 'right' : 'clear';
  conflicts.add(conflict);
  counts.add(cars.length);
  samples.add(JSON.stringify(cars));
  let firstTurn, slowest = initial.speed;
  for (let frame = 0; frame <= 200; frame++) {
   const pose = plan.sample(frame / 20);
   if (pose.x < -.05) firstTurn ??= pose;
   slowest = Math.min(slowest, pose.speed);
   assert.ok(Math.abs(pose.yaw) <= 5.55 * Math.PI / 180, 'ego must merge at a shallow angle');
   checkClearance(pose);
  }
  assert.ok(firstTurn);
  if (conflict === 'right') assert.ok(slowest < 16.5);
  if (conflict === 'left') assert.ok(firstTurn.speed < initial.speed - 1);
  if (conflict === 'left') assert.ok(firstTurn.traffic.find(car => car.id === 'passing').z < -13);
  if (conflict === 'right') assert.equal(firstTurn.traffic.find(car => car.id === 'right').x, -config.width);
  const end = plan.sample(10);
  assert.equal(end.x, -config.width);
  assert.ok(Math.abs(end.yaw) < .001, 'ego must be aligned after the merge');
  assert.ok(end.distance > config.clearedDistance);
  assert.ok(end.traffic.filter(car => car.direction < 0).every(car => car.x === -config.width));
  const {pathX, ...mid} = plan.sample(3.437);
  const {pathX: repeatPath, ...repeat} = plan.sample(3.437);
  assert.deepEqual(repeat, mid);
  assert.equal(repeatPath(-18), pathX(-18));
 }
 assert.deepEqual([...conflicts].sort(), ['clear', 'left', 'right']);
 assert.ok(counts.size >= 3);
 assert.equal(samples.size, 96);
});

test('Near and Far leave enough space to merge and clear the taper', () => {
 for (const [offset, duration] of [[-6, 10], [12, 11]]) {
  const clearedDistance = config.clearedDistance + offset;
  for (let i = 0; i < 96; i++) {
   const plan = planRoadworksTraffic(randomForSeed(Math.imul(i, 123456789)), {...config, offset, duration, clearedDistance});
   for (let frame = 0; frame <= duration * 20; frame++) checkClearance(plan.sample(frame / 20), offset);
   const end = plan.sample(duration);
   assert.equal(end.x, -config.width);
   assert.ok(end.distance > clearedDistance);
  }
 }
});

test('Mid-run traffic changes carry ego state forward and keep a clear route through repeated toggles', () => {
 const conflicts = new Set();
 for (let i = 0; i < 36; i++) {
  const seed = Math.imul(i, 123456789);
  for (const [offset, duration] of [[-6, 10], [0, 10], [12, 11]]) {
   const options = {...config, offset, duration, clearedDistance:config.clearedDistance + offset, adaptiveTraffic:true};
   const initial = planRoadworksTraffic(randomForSeed(seed), {...options, trafficEnabled:false});
   let plan = initial;
   for (const [time, enabled, until] of [[1.137, true, 2.815], [2.815, false, 3.623], [3.623, true, 7.917], [7.917, false, 8.147], [8.147, true, duration]]) {
    const before = plan.sample(time);
    plan = planRoadworksTraffic(randomForSeed(seed), {...options, initial:{...before, time}, trafficEnabled:enabled});
    const after = plan.sample(time);
    for (const key of ['distance', 'speed', 'acceleration', 'x', 'yaw']) assert.ok(Math.abs(after[key] - before[key]) < 1e-7, key);
    if (before.merge) assert.deepEqual(after.merge, before.merge);
    if (time === 1.137 && offset === 0) {
     const right = after.traffic.find(car => car.id === 'right');
     const front = after.traffic.find(car => car.id === 'middle');
     const conflict = after.traffic.some(car => car.id === 'passing') ? 'left' : right?.z < 0 && right.z > -30 ? 'right' : front?.z < 0 && front.z > -45 ? 'front' : 'clear';
     conflicts.add(conflict);
    }
    for (let t = time; t <= until; t += .05) checkClearance(plan.sample(t), offset);
   }
   assert.equal(plan.sample(duration).x, -config.width);
  }
 }
 assert.deepEqual([...conflicts].sort(), ['clear', 'front', 'left', 'right']);
});

test('The ribbon and speed yield to a close merging lead, then recover when traffic is removed', () => {
 const options = {...config, adaptiveTraffic:true};
 const time = 1.2;
 const normal = planRoadworksTraffic(null, {...options, trafficEnabled:false});
 const initial = {...normal.sample(time), time};
 const close = planRoadworksTraffic(() => .7, {...options, initial});
 const clear = planRoadworksTraffic(() => .93, {...options, initial});
 assert.ok(clear.sample(time).traffic.length > 0);
 for (const t of [2, 3, 4, 5]) {
  assert.ok(Math.abs(clear.sample(t).speed - normal.sample(t).speed) < .05);
  assert.ok(Math.abs(clear.sample(t).pathX(-25) - normal.sample(t).pathX(-25)) < .05);
 }
 const holding = close.sample(3.6);
 const leading = holding.traffic.find(car => car.id === 'middle');
 assert.ok(leading.z < -6 && leading.x < -config.width / 2);
 assert.ok(holding.speed < normal.sample(3.6).speed - 3);
 assert.equal(holding.pathX(-25), 0);

 const releaseAt = 2.45;
 const before = close.sample(releaseAt);
 const release = planRoadworksTraffic(null, {...options, initial:{...before, time:releaseAt}, trafficEnabled:false});
 assert.equal(release.sample(releaseAt).speed, before.speed);
 assert.equal(release.sample(releaseAt).distance, before.distance);
 assert.ok(release.sample(3.6).speed > holding.speed + 2);
 assert.ok(release.sample(3.6).pathX(-25) < -1);
 assert.equal(release.sample(10).x, -config.width);
});

test('Roadworks keeps causal yellow until the actor stops constraining ego', () => {
 const options = {...config, adaptiveTraffic:true};
 for (const [roll, id] of [[.45, 'right'], [.7, 'middle']]) {
  const plan = planRoadworksTraffic(() => roll, options);
  const frames = Array.from({length:501}, (_, index) => plan.sample(index / 50));
  const actor = frame => frame.traffic.find(car => car.id === id);
  const signal = frames.find(frame => actor(frame).rearIndicator);
  const yellow = frames.find(frame => actor(frame).cutInColor === 'yellow');
  const raised = frames.find(frame => frame.cutInLift > .7);
  assert.equal(actor(signal).rearIndicator, 'left');
  if(actor(signal).constraining)assert.ok(actor(signal).cutInTint>0);
  assert.ok(actor(yellow).constraining);
  assert.ok(raised.cutInLift > yellow.cutInLift);
  assert.ok(frames.every(frame => actor(frame).cutInColor !== 'red'));
  for (const time of [3.5, 4.1]) {
   const clearing = plan.sample(time);
   assert.equal(actor(clearing).trafficFeedback.red,0);
   assert.ok(clearing.cutInLift > .7);
  }
  assert.ok(frames.every(frame => frame.traffic.every(car => car.direction<0 || (!car.cutInTint && !car.rearIndicator))));
  assert.equal(actor(frames.at(-1)).cutInColor, actor(frames.at(-1)).constraining ? 'yellow' : undefined);
  assert.equal(frames.at(-1).cutInLift, 0);
  assert.equal(plan.sampleTraffic(id === 'right' ? 1 : 2.6, yellow.distance, false).find(car => car.id === id).cutInColor, undefined);
 }
 const entering = planRoadworksTraffic(() => .45, options);
 const enteringAt = time => entering.sample(time).traffic.find(car => car.id === 'right');
 assert.equal(enteringAt(.8).corridorInfluence, 0);
 assert.ok(enteringAt(1.5).corridorInfluence > 0 && enteringAt(1.5).corridorInfluence < 1);
 assert.equal(enteringAt(2.25).corridorInfluence, 1);
 assert.equal(enteringAt(3.2).corridorInfluence, undefined);
 for (const roll of [.15, .93]) {
  const plan = planRoadworksTraffic(() => roll, options);
  for (let time = 0; time <= 10; time += .1) {
   const frame = plan.sample(time);
   assert.equal(frame.cutInLift, 0);
   assert.ok(frame.traffic.filter(car=>car.direction>0).every(car=>!car.cutInTint));
  }
 }
});

test('Roadworks uses the shared body prediction and keeps causal feedback through the yield',()=>{
 const options={...config,adaptiveTraffic:true};
 const empty=planRoadworksTraffic(null,{...options,trafficEnabled:false}),time=1.25;
 const plan=planRoadworksTraffic(()=>.45,{...options,initial:{...empty.sample(time),time}});
 const frames=Array.from({length:176},(_,i)=>plan.sample(time+i*.05));
 assert.ok(frames.some(f=>f.traffic.some(c=>c.constraining&&c.cutInTint>0)));
 for(const f of frames)for(const c of f.traffic){
  assert.ok(!c.cutInTint||c.trafficFeedback.yellow+c.trafficFeedback.red>0);
  if(c.direction>0)assert.equal(c.cutInTint,undefined);
 }
 const last=plan.sample(10);assert.ok(last.traffic.every(c=>!c.cutInTint));
});

test('Roadworks marks an active closing correction and clears steady following below cruise speed', () => {
 const plan = planRoadworksTraffic(() => .7, {...config, duration: 15, adaptiveTraffic: true});
 const actor = frame => frame.traffic.find(car => car.id === 'middle');
 const approach = plan.sample(1), follow = plan.sample(15);
 assert.ok(approach.acceleration < -1 && approach.speed - actor(approach).speed > 4);
 assert.equal(actor(approach).trafficFeedback.yellow, 1);
 assert.ok(follow.distance > config.clearedDistance && follow.speed < 17);
 assert.ok(Math.abs(follow.speed - actor(follow).speed) < .05);
 assert.deepEqual(actor(follow).trafficFeedback, {level: 0, yellow: 0, red: 0});
 assert.deepEqual(plan.sample(1).traffic, approach.traffic, 'seeking back restores the active feedback');
});

test('Cut-in merges ahead and Collision warning brakes to a stop behind the lead', () => {
 for (const event of ['cutin', 'collision']) {
  for (let frame = 0; frame <= 200; frame++) {
   const pose = sampleFollowingEvent(event, frame / 20, config.width);
   assert.ok(pose.speed >= 0);
   assert.ok(pose.traffic[0].z < -9, 'maintain space between the vehicle centers');
   assert.equal(pose.x, 0);
  }
 }
 assert.equal(sampleFollowingEvent('cutin', 0, config.width).traffic[0].x, config.width);
 assert.equal(sampleFollowingEvent('cutin', 5.55, config.width).traffic[0].x, 0);
 assert.ok(sampleFollowingEvent('collision', 4.7, config.width).warning > 0);
 assert.equal(sampleFollowingEvent('collision', 8, config.width).speed, 0);
});

test('AES steers into the clear lane, passes the lead car, and returns with clearance', () => {
 const width = config.width, at = time => sampleFollowingEvent('aes', time, width);
 assert.ok(Math.abs(at(0).x) < .01);
 assert.ok(at(1.95).warning > 0);
 assert.equal(at(3.8).x, -width);
 assert.ok(at(5.1).traffic[0].z > 15);
 assert.ok(Math.abs(at(7.1).x) < .01);
 assert.ok(at(10).speed > at(3.8).speed);
 for (let frame = 0; frame <= 600; frame++) {
  const {x, traffic: [lead]} = at(frame / 60);
  if (Math.abs(lead.z) < 6) assert.ok(Math.abs(x - lead.x) > 2.25, 'lateral clearance while passing');
 }
});

test('Cut-in accelerates left to pass and ego yields when the lane gap tightens', () => {
 const {merge, nearLine, halfIn, inLane, resume} = CUT_IN_TIMING;
 const {width} = config;
 const at = planFollowingFeedback('cutin',width);
 const approach = at(0);
 const before = at(nearLine - .01);
 const near = at(nearLine);
 const braking = at(nearLine + .1);
 const half = at(halfIn);
 const [actor, slowerCar] = approach.traffic;
 assert.equal(actor.x, width);
 assert.equal(slowerCar.x, width);
 assert.ok(slowerCar.z < actor.z && slowerCar.speed < actor.speed);
 assert.equal(at(2).traffic[0].cutInColor,undefined);
 assert.equal(at(2.4).traffic[0].rearIndicator, 'left');
 assert.equal(at(2.4).traffic[0].trafficFeedback.level, 0);
 assert.equal(at(3.2).traffic[0].trafficFeedback.level, 0);
 assert.equal(at(merge).lift, 0);
 assert.ok(before.lift > 0, 'the camera follows the lateral move before the ego starts braking');
 assert.equal(before.speed, 20);
 assert.equal(before.brakeStrength, 0);
 const lead = near.traffic[0];
 assert.ok(lead.cutInTint>0);
 const cornerX = lead.x - .95 * Math.cos(lead.yaw) - 2.38 * Math.abs(Math.sin(lead.yaw));
 assert.ok(cornerX > width / 2 && cornerX < width / 2 + .25);
 assert.ok(braking.lift > 0 && braking.speed < 20 && braking.brakeStrength > 0);
 assert.ok(half.traffic[0].speed > lead.speed && lead.speed > at(merge).traffic[0].speed);
 assert.ok(half.traffic[0].z > lead.z && half.traffic[0].speed < half.speed);
 assert.ok(at(halfIn-.01).traffic[0].cutInTint>0);
 assert.ok(half.traffic[0].cutInTint>0);
 assert.ok(Math.abs(half.traffic[0].x - width / 2) < 1e-9);
 assert.equal(at(inLane).traffic[0].cutInTint, 1);
 const opening = at(inLane + .2);
 assert.ok(opening.traffic[0].speed > opening.speed && opening.brakeStrength === 0);
 assert.equal(opening.traffic[0].constraining, false, 'the lead is pulling away and ego has finished yielding');
 assert.equal(opening.traffic[0].trafficFeedback.red, 1, 'red prediction and its hold are independent of yellow');
 assert.equal(at(7.2).traffic[0].cutInTint, undefined);
 assert.equal(at(resume+.9).traffic[0].cutInColor,undefined);
 assert.ok(at(10).traffic[0].z < at(resume).traffic[0].z);
 assert.ok(at(10).traffic[0].z < 0 && at(10).traffic[0].z < at(10).traffic[1].z);
 assert.equal(at(10).speed, at(10).traffic[0].speed);
});

test('Cut-in and AES select one actor from a varied fleet and preserve clearance', () => {
 const {width} = config;
 for (const event of ['cutin', 'aes']) {
  const counts = new Set(), actors = new Set();
  for (let i = 0; i < 48; i++) {
   const {actor, ambient} = createInteractionTraffic(randomForSeed(Math.imul(i, 123456789)), width, event);
   const at = time => sampleFollowingEvent(event, time, width, ambient, actor);
   const first = at(0).traffic;
   const ids = first.map(car => car.id);
   counts.add(first.length);
   actors.add(actor.id);
   if (event === 'cutin') {
    const slowerCar = first.find(car => car.id !== actor.id && car.direction === -1);
    assert.equal(first[0].x, width);
    assert.equal(slowerCar.x, width);
    assert.ok(slowerCar.z < first[0].z && slowerCar.speed < first[0].speed);
    const finish = at(10).traffic;
    assert.ok(finish[0].z < finish.find(car => car.id === slowerCar.id).z);
   }
   assert.equal(new Set(ids).size, ids.length);
   assert.ok(first[0].z < -20);
   assert.ok(first.slice(1).some(car => car.direction === -1));
   assert.ok(first.slice(1).some(car => car.direction === 1));
   const merge = at(event === 'cutin' ? 5.55 : 1.7);
   assert.equal(merge.traffic[0].id, actor.id);
   assert.equal(Math.abs(merge.traffic[0].x), 0);
   if (event === 'aes') assert.equal(at(4).traffic[0].speed, 0);
   for (let frame = 0; frame <= 200; frame++) {
    const {x, traffic} = at(frame / 20);
    assert.deepEqual(traffic.map(car => car.id), ids);
    const sameDirection = [{id:'ego', x, z:0}, ...traffic.filter(car => car.direction < 0)];
    for (const [index, car] of sameDirection.entries()) {
     for (const next of sameDirection.slice(index + 1)) {
      if (Math.abs(car.x - next.x) < 2.25) {
       assert.ok(Math.abs(car.z - next.z) > 6, `${event}: ${car.id} is too close to ${next.id}`);
      }
     }
    }
   }
  }
  assert.deepEqual([...counts].sort(), [3, 4]);
  assert.ok(actors.size >= 3);
 }
});

function checkClearance(pose, offset = 0) {
 const {distance, x, yaw, traffic} = pose;
 const sameDirection = [{id:'ego', x, yaw, z:0}, ...traffic.filter(car => car.direction < 0)];
 for (const [index, car] of sameDirection.entries()) {
  for (const next of sameDirection.slice(index + 1)) {
   if (Math.abs(car.x - next.x) < 2.25) {
    assert.ok(Math.abs(car.z - next.z) > 6, `${car.id} is too close to ${next.id}`);
   }
  }
  for (let i = 0; i < 14; i++) {
   const dx = 5.23 - Math.min(i / ROADWORKS_TAPER_INTERVALS, 1) * 6.76 - car.x;
   const dz = distance - ROADWORKS_CONE_START - offset - ROADWORKS_CONE_SPACING * i - car.z;
   const side = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw);
   const longitudinal = dz * Math.cos(car.yaw) + dx * Math.sin(car.yaw);
   assert.ok(Math.abs(longitudinal) >= 2.8 || Math.abs(side) >= 1.27, `${car.id} intersects a cone`);
  }
 }
 const opposite = traffic.filter(car => car.direction > 0);
 assert.ok(opposite.every(car => car.x >= -16.4 && car.x <= -9));
}


for (const {name, layout, egoX, signal} of [
 {name: 'Road', layout: '02', egoX: 1.85, signal: 'left'},
 {name: 'Ramp Exit', layout: '06', egoX: 3.7, signal: 'right'},
]) {
 test(`${name} Cut-in varies traffic while yielding and warning at the planned gap`, () => {
  const counts = new Set(), gaps = new Set(), redRuns = new Set();
  for (let seed = 0; seed < 64; seed++) {
   const run = planAdjacentCutIn(randomForSeed(Math.imul(seed, 123456789)), {layout, egoX});
   const start = run(0), approach = run(CUT_IN_TIMING.nearLine), end = run(10);
   const [actor, leader] = start.traffic;
   assert.equal(actor.cutInColor, undefined);
   assert.equal(run(2.4).traffic[0].rearIndicator, signal);
   assert.equal(run(2.4).traffic[0].trafficFeedback.level, 0, 'signalling alone keeps the car neutral');
   assert.equal(run(3.2).traffic[0].trafficFeedback.level, 0, 'early lateral motion still leaves room at the divider');
   const {impactAt,inLane}=start.cutInTiming;
   assert.ok(impactAt<inLane);
   assert.equal(approach.traffic[0].trafficFeedback.level,0);
   assert.ok(run(impactAt).traffic[0].trafficFeedback.level>0);

   assert.equal(run(2.25).traffic[0].rearIndicator, signal);
   assert.equal(end.traffic[0].rearIndicator, undefined);
   assert.ok(run(5.7).speed < start.speed);
   if (layout === '06') {
    assert.ok(end.traffic[0].speed < actor.speed, 'both cars slow for the exit');
    assert.ok(end.x > 4 && end.traffic[0].x > egoX + end.x, 'both follow the exit curve');
   } else {
    assert.equal(end.traffic[0].speed,actor.speed);
    assert.ok(Math.abs(end.distance-end.traffic[0].z-(-actor.z+actor.speed*10))<1e-8);
    assert.equal(end.traffic[0].x, egoX);
    assert.equal(end.x, 0, 'ego stays in the mainline lane');
    assert.ok(leader.speed < actor.speed && leader.z < actor.z);
   }
   let red = false;
   for (let index = 0; index <= 200; index++) {
    const frame = run(index / 20);
    const [other, ...ambient] = frame.traffic;
    if (Math.abs(frame.pathX(other.z) - other.x) < 2.25) assert.ok(-other.z >= 8);
    if (other.trafficFeedback.red > 0 && !red) {
     assert.equal(other.intentKnown, true, 'a new red warning starts at or after the actor footprint reaches the divider');
     red = true;
    }
    for (const car of ambient) assert.equal(car.cutInColor, undefined);
   }
   counts.add(start.traffic.length);
   gaps.add(actor.z);
   redRuns.add(red);
   assert.deepEqual(run(4).traffic, run(4).traffic, 'seeking keeps the same traffic');
  }
  assert.deepEqual([...counts].sort(), [3, 4]);
  assert.equal(gaps.size, 64);
  assert.equal(redRuns.size, 2, 'only short projected gaps warrant red');
 });
}


const mergeCar = (pose, id) => pose.traffic.find(car => car.id === id);
const mergePriority = pose => mergeCar(pose, 'merge-priority');

test('Ramp Merge stays upstream when existing traffic leaves no usable opening', () => {
 const car={id:'slow-mainline',x:3.7,start:24,speed:3,direction:-1};
 const run=planRampMerge(()=>.5,3.7,{mainlineTraffic:car});
 assert.equal(run(0).rampMerge.strategy,'wait');
 for(let frame=0;frame<=300;frame++){
  const t=frame/20, ego=run(t), lead=mergeCar(ego,car.id);
  assert.equal(lead.speed,car.speed);
  assert.equal(lead.x,car.x);
  assert.ok(Math.abs(ego.distance-lead.z-(car.start+car.speed*t))<1e-8);
  assert.ok(ego.x>2.25);
  assert.equal(ego.lift,0);
 }
 assert.equal(run(15).speed,0);
 assert.equal(run(15).distance,run(10).distance);
});

test('Ramp Merge checks independent ramp and mainline traffic before committing', () => {
 const counts = new Set(), gaps = new Set(), strategies = new Set();
 const pairedStrategies = new Set(), soloStrategies = new Set();
 const yieldActors = new Set(), passingOrders = new Set();
 const egoX = 3.7;
 for (let seed = 0; seed < 128; seed++) {
  const run = planAdjacentCutIn(randomForSeed(Math.imul(seed, 123456789)), {layout: '07', egoX});
  const start = run(0), end = run(10);
  const {strategy, decisionAt, releaseAt, mergeAt, settledAt, cameraHomeAt, yieldTo} = start.rampMerge;
  const companion = start.traffic.find(car => car.id === 'merge-companion');
  let signaled = false;
  if (companion) {
   pairedStrategies.add(strategy);
   assert.equal(companion.x, mergeRampLaneX(57 + companion.z, 'inner'));
   assert.equal(end.traffic.find(car => car.id === companion.id).x, egoX);
   if (strategy === 'accelerate') passingOrders.add(Math.sign(end.traffic.find(car => car.id === companion.id).z));
  } else soloStrategies.add(strategy);
  strategies.add(strategy);
  counts.add(start.traffic.length);
  gaps.add(start.traffic.map(({z}) => z).join(','));
  assert.ok(run(15).distance > end.distance && run(15).speed > 0, 'the demo keeps moving after it joins');
  assert.ok(start.x > 20 && run(settledAt).x === 0, 'ego joins the outer lane before any passing move');
  assert.ok(decisionAt <= releaseAt && releaseAt < mergeAt && mergeAt < settledAt && settledAt < 10);
  assert.ok(run(cameraHomeAt - .1).lift > 0);
  assert.equal(run(cameraHomeAt).lift, 0);
  assert.equal(run(cameraHomeAt).cameraYaw, 0);
  assert.equal(run(Math.max(decisionAt, releaseAt - .65) + .01).lamp, 1);
  assert.equal(start.lampSide, 'left');
  if (!start.rampMerge.passAt || start.rampMerge.passAt + 3.6 <= 10) assert.equal(end.lamp, 0);
  if (strategy === 'yield') {
   const yielding = run(2), passing = run(releaseAt);
   assert.ok(yielding.x > 2.25 && yielding.speed < start.speed && yielding.holdWeight > .9);
   yieldActors.add(yieldTo);
   const id = yieldTo === 'ramp' ? 'merge-companion' : 'merge-priority';
   assert.ok(passing.traffic.find(car => car.id === id).z <= -4.8, 'the blocking vehicle clears before ego accelerates');
   assert.ok(run(mergeAt).speed > passing.speed && run(settledAt).traffic.find(car => car.id === id).z < 0);
  } else {
   assert.equal(releaseAt, decisionAt);
   assert.ok(run(mergeAt).speed > start.speed);
   assert.equal(run(2).holdWeight, 0);
  }
  for (let frame = 0; frame <= 600; frame++) {
   const time = frame / 60, pose = run(time), mainline = mergePriority(pose);
   if (mainline) {
    assert.equal(mainline.x, egoX);
   }
   if (mainline && Math.abs(pose.x) < 2.25) {
    const followingSpeed = mainline.z < 0 ? pose.speed : mainline.speed;
    assert.ok(Math.abs(mainline.z) >= 6 + .58 * followingSpeed - .001, 'both cars have room through the merge');
   }
   if (companion) {
    const lead = pose.traffic.find(car => car.id === companion.id);
    if (Math.abs(lead.x - egoX - pose.x) < 2.25) {
     const followingSpeed = lead.z < 0 ? pose.speed : lead.speed;
     assert.ok(Math.abs(lead.z) >= 6 + .58 * followingSpeed - .001, 'the two ramp cars keep a gap where their paths converge');
    }
    signaled ||= lead.rearIndicator === 'left';
    if (mainline && Math.abs(lead.x - mainline.x) < 2.25) {
     const followingSpeed = lead.z < mainline.z ? mainline.speed : lead.speed;
     assert.ok(Math.abs(lead.z - mainline.z) >= 6 + .58 * followingSpeed - .001);
    }
   }
  }
  if (companion) assert.ok(signaled);
  const seek = run(4.2);
  run(8);
  assert.deepEqual(run(4.2).traffic, seek.traffic, 'seeking preserves the generated traffic');
  assert.equal(run(4.2).distance, seek.distance);
 }
 assert.deepEqual([...counts].sort(), [3, 4]);
 assert.deepEqual([...strategies].sort(), ['accelerate', 'yield']);
 assert.ok(pairedStrategies.has('accelerate') && pairedStrategies.has('yield'));
 assert.ok(soloStrategies.has('accelerate') && soloStrategies.has('yield'));
 assert.deepEqual([...yieldActors].sort(), ['mainline', 'ramp']);
 assert.deepEqual([...passingOrders].sort(), [-1, 1]);
 assert.equal(gaps.size, 128);
});

test('Ramp Entrance keeps a distant fast rear arrival gray before it reaches the merge',()=>{
 const run=planAdjacentCutIn(randomForSeed(Math.imul(63,123456789)),{layout:'07',egoX:3.7});
 const early=run(1),rear=mergePriority(early);
 assert.equal(early.rampMerge.strategy,'yield');
 assert.equal(Boolean(rear.constraining),false);
 assert.ok(rear.z>44);
 assert.equal(rear.trafficFeedback.yellow,0);
 assert.ok(mergePriority(run(3)).trafficFeedback.yellow>0);
 assert.equal(mergePriority(run(early.rampMerge.releaseAt)).trafficFeedback.yellow,0);
});

test('Ramp Entrance keeps a nearby passing car gray when the taper still separates the paths', () => {
 const run = planRampMerge(randomForSeed(0), 3.7);
 const frame = run(3.5), passing = mergePriority(frame);
 assert.equal(frame.rampMerge.strategy, 'yield');
 assert.ok(frame.rampMerge.releaseAt > 3.5 && Math.abs(passing.z) < 2);
 assert.ok(frame.x > 7);
 assert.equal(passing.trafficFeedback.level, 0);
});

test('Ramp Merge keeps accelerating with an empty lane, a clear lead, or a distant faster rear car', () => {
 for (const seed of [3703703670, 3086419725, 2962962936]) {
  const run = planAdjacentCutIn(randomForSeed(seed), {layout: '07', egoX: 3.7});
  const start = run(0), {strategy, decisionAt, releaseAt, mergeAt} = start.rampMerge;
  const entry = run(mergeAt), mainline = mergePriority(entry);
  assert.equal(mergeCar(entry, 'merge-companion'), undefined);
  if (seed === 3703703670) assert.equal(mainline, undefined);
  if (seed === 3086419725) assert.ok(mainline.z < -20);
  if (seed === 2962962936) assert.ok(mainline.z > 30 && mainline.speed > entry.speed);
  assert.equal(strategy, 'accelerate');
  assert.equal(releaseAt, decisionAt);
  assert.ok(run(2.6).speed > start.speed);
  for (let t = 0; t <= 10; t += .25) {
   const {speed, brakeStrength, holdWeight, traffic} = run(t);
   assert.ok(speed >= start.speed && brakeStrength === 0 && holdWeight === 0);
   assert.ok(traffic.filter(car => seed !== 3086419725 || car.id !== 'merge-priority')
    .every(car => car.trafficFeedback.yellow === 0));
  }
 }
});

test('Ramp Merge recovers cruise speed and passes only with a clear left lane', () => {
 const egoX = 3.7;
 const clear = planRampMerge(randomForSeed(3703703670), egoX);
 const following = planRampMerge(randomForSeed(3086419725), egoX);
 const passing = planRampMerge(randomForSeed(1358024679), egoX);
 const pass = passing(0).rampMerge;

 assert.equal(clear(15).speed, 80 / 3.6);
 assert.ok(clear(8).speed > clear(clear(0).rampMerge.settledAt).speed);
 assert.equal(following(15).rampMerge.passAt, undefined);
 assert.equal(following(15).x, 0);
 assert.ok(following(15).speed < clear(15).speed - 4);
 assert.equal(mergePriority(following(15)).cutInColor, 'yellow');
 assert.ok(pass.passAt > pass.settledAt);
 assert.equal(passing(pass.passAt - .3).lamp, 1);
 assert.equal(passing(pass.passAt).x, 0);
 assert.equal(passing(15).x, -3.7);
 assert.ok(mergeCar(passing(15), 'merge-companion').z > 14);
 assert.equal(passing(15).speed, clear(15).speed);
 for (let t = pass.passAt; t <= 15; t += .05) {
  const frame = passing(t);
  const dx = passing(t + .001).distance - passing(t - .001).distance;
  assert.ok(Math.abs(dx / .002 - frame.speed) < .01, 'speed matches the displacement on screen');
  assert.equal(frame.cameraYaw, 0);
  for (const car of frame.traffic.filter(car => car.direction < 0)) {
   if (Math.abs(egoX + frame.x - car.x) < 2.25) assert.ok(Math.abs(car.z) > 12);
   if (car.id !== 'merge-companion') {
    const initial = mergeCar(passing(0), car.id);
    assert.ok(Math.abs(frame.distance - car.z - (initial.speed * t - initial.z)) < 1e-8);
   }
  }
 }
});

test('Ramp Merge highlights only the pace-setting car during the speed match', () => {
 for (const [seed, time, lead] of [[3086419725, 3.25, 'merge-priority'], [1358024679, 2.1, 'merge-companion']]) {
  const run = planAdjacentCutIn(randomForSeed(seed), {layout: '07', egoX: 3.7});
  const matching = run(time);
  assert.equal(matching.rampMerge.strategy, 'accelerate');
  assert.deepEqual(matching.traffic.filter(car => car.trafficFeedback.yellow > 0).map(car => car.id), [lead]);
  assert.ok(run(4.5).traffic.filter(car => car.trafficFeedback.yellow > 0).every(car => car.id === lead));
 }
});

test('Ramp Merge holds back when a mainline car closes from behind after the ramp neighbor passes', () => {
 const run = planAdjacentCutIn(randomForSeed(396390686), {layout: '07', egoX: 3.7});
 const approach = run(4), alongside = run(4.6), cleared = run(5.3);
 const {releaseAt, settledAt, rearAlsoPassed} = approach.rampMerge;
 assert.ok(rearAlsoPassed);
 const mainline = mergePriority;
 const neighbor = approach.traffic.find(car => car.id === 'merge-companion');
 assert.ok(neighbor.z < -20 && mainline(approach).z > 0 && mainline(approach).speed > approach.speed);
 assert.ok(approach.speed < 4 && alongside.speed <= approach.speed, 'ego slows before the cars draw level');
 assert.ok(Math.abs(mainline(alongside).z) < 6 && alongside.x >= 4.5, 'ego stays clear of the narrowing lane while the rear car passes');
 assert.ok(mainline(cleared).z < -6 && cleared.x > 6, 'the passing car pulls ahead while ego is still on the ramp');
 const release = run(releaseAt);
 assert.ok(mainline(release).z < -(6 + release.speed * .58), 'ego accelerates only once the rear car has opened a lead gap');
 assert.ok(run(releaseAt + .5).speed > release.speed);
 assert.equal(run(settledAt).x, 0);
});

test('Live traffic clears the cone envelope or holds upstream when the open lane is occupied',async()=>{
 const {coordinateWorkZone,planLiveWorkZone,workZoneEdge,ROADWORKS_CLEARED_DISTANCE}=await import('../roadworks-traffic.js');
 let waits=0, merges=0;
 for(const side of [-1,1]) for(let seed=1;seed<=64;seed++){
  let state=seed*79271;
  const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
  const fleet=Array.from({length:5},(_,id)=>({id,direction:-1,speed:17+random()*8,station:31*id-36+random()*15,
   x:side*3.7*(Math.floor(3*random())-1)}));
  const {cars,offset}=planLiveWorkZone(fleet.map(car=>({...car,x:car.x*side})),3.7,0,15);
  for(const car of cars){
   assert.equal(car.distanceAt(0),fleet[car.id].station);
   assert.equal(car.xAt(0)*side,fleet[car.id].x);
   if(car.speedAt(10)<.3)waits++;
   if(car.xAt(0)!==car.xAt(15))merges++;
   for(let t=0;t<15;t+=1/60){
    const station=car.distanceAt(t)-offset;
    if(station>90&&station<163)assert.ok(car.xAt(t)+1.2<workZoneEdge(station+3.1,3.7),`seed ${seed}, car ${car.id}, ${t}s`);
    for(const peer of cars) if(peer.id<car.id)
     assert.ok(Math.abs(peer.xAt(t)-car.xAt(t))>2.15||Math.abs(peer.distanceAt(t)-car.distanceAt(t))>5.3);
   }
  }
 }
 assert.ok(waits>0&&merges>0);
 for(let seed=1;seed<=96;seed++){
  let state=seed*79271;
  const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
  random.reset=()=>{};
  const fleet=Array.from({length:5},(_,id)=>({id,direction:-1,speed:17+random()*8,station:31*id-38+random()*12,
   x:3.7*(Math.floor(3*random())-1)})).filter(c=>c.x!==0||Math.abs(c.station)>14);
  const {offset}=planLiveWorkZone(fleet,3.7,0,15,22);
  const run=coordinateWorkZone(random,fleet,{duration:15,width:3.7,offset,initial:{speed:22},adaptiveTraffic:true,
   clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset});
  for(let t=0;t<15;t+=1/30){
   const f=run.sample(t), station=f.distance-offset;
   if(station>90&&station<163)assert.ok(f.x+1.2<workZoneEdge(station+3.1,3.7));
   for(const car of f.traffic)if(car.direction<0)
    assert.ok(Math.abs(car.x-f.x)>2.1||Math.abs(car.z)>4.9,`seed ${seed} at ${t}s`);
  }
 }
});

test('A vehicle waiting in the outer lane stops before that lane closes', () => {
 const random = randomForSeed(2789 * 31337);
 const speed = 12 + 10 * random();
 // Consume the same initial-traffic choices as the randomized replay.
 for (let i=0; i<6; i++) { random(); random(); }
 const run = planRoadworksTraffic(random, {duration:15,width:3.7,initial:{speed,entryX:3.7},
  clearedDistance:ROADWORKS_CLEARED_DISTANCE,trafficEnabled:true,adaptiveTraffic:true,extendUntilClear:true});
 for (let tick=0; tick<=Math.ceil(run.timing.endAt*60); tick++) {
  const frame = run.sample(tick/60);
  if (!frame.merge) assert.ok(frame.distance-frame.holdZ<94, 'Ribbon stop point must precede the outer taper');
  if (frame.distance<94 || frame.distance>145) continue;
  const edge = 5.23 + (-1.53-5.23)*Math.min(1,Math.max(0,(frame.distance-94)/(4.6*11)));
  assert.ok(frame.x+1.05<=edge, 'Outer-lane body crosses the taper at '+tick+'/60 s');
 }
});
