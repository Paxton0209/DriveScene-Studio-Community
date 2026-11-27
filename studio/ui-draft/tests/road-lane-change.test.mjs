import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planRoadLaneChange} from '../road-lane-change.js';
import {LANE_CHANGE_TIMING} from '../lane-change-timing.js';

const road = {egoX: 5.55, laneWidth: 3.7};
const sampledRun = (...values) => planRoadLaneChange(() => values.shift() ?? .5, road);

test('The stable target becomes selected as ego approaches', () => {
 const sample = sampledRun(.9);
 const {steerAt, settledAt} = sample(0).laneChange;
 const {signalAt} = LANE_CHANGE_TIMING;
 const low = sample(signalAt).targetSlot, high = sample(signalAt + 1).targetSlot;
 for (const offset of [.5, 1, 1.5]) {
  assert.equal(sample(signalAt + offset).targetSlot.opacity, 1);
 }
 assert.equal(low.selected, 0);
 assert.equal(low.x, high.x);
 for (const time of [signalAt + .5, steerAt, settledAt - .5]) {
  const pose = sample(time);
  assert.ok(pose.targetSlot.z < 0);
  assert.ok(pose.laneHighlight <= pose.targetSlot.opacity);
 }
 for (const [offset, opacity] of [[-.1, 0], [0, 0], [.25, .25], [.5, .5], [.75, .75], [1, 1], [1.2, 1]]) {
  assert.ok(Math.abs(sample(signalAt + offset).laneHighlight - opacity) < 1e-8);
 }
 assert.equal(sample(steerAt + .5).targetSlot.selected, 1);
 assert.equal(sample(steerAt + .5).targetSlot.rim, 1);
 const approaching = sample(settledAt - .8).targetSlot;
 assert.ok(approaching.rim > 0 && approaching.rim < 1);
 const aligned = sample(settledAt - .35).targetSlot;
 assert.equal(aligned.rim, 0);
 assert.ok(aligned.opacity > 0);
 assert.deepEqual(sample(signalAt + 1).targetSlot, high);
});

test('Ego catches the advancing target at settlement, including delayed entry', () => {
 const {signalAt} = LANE_CHANGE_TIMING;
 for (const values of [[.9], [.9, .99, .99], [.1, 0], [.1, .99]]) {
  const sample = sampledRun(...values);
  const {steerAt, settledAt} = sample(0).laneChange;
  const initial = sample(signalAt);
  const targetX = road.egoX + road.laneWidth;
  assert.ok(initial.targetSlot.z < 0);
  assert.equal(sample(steerAt).targetSlot.z, initial.targetSlot.z);
  let previous = sample(steerAt);
  for (let time = steerAt + 1 / 60; time < settledAt; time += 1 / 60) {
   const pose = sample(time);
   const {z} = pose.targetSlot;
   assert.ok(z < 0 && z > previous.targetSlot.z);
   assert.equal(pose.targetSlot.x, targetX);
   assert.ok(pose.distance - z > previous.distance - previous.targetSlot.z);
   previous = pose;
  }
  const arrived = sample(settledAt);
  assert.ok(Math.abs(arrived.targetSlot.z) < 1e-8);
  assert.ok(Math.abs(arrived.targetSlot.x - (road.egoX + arrived.x)) < 1e-8);
 }
});

test('At alignment the slot fades from its current fill to zero over one second', () => {
 for (const sample of [sampledRun(.9), sampledRun(.1, 0)]) {
  const {settledAt} = sample(0).laneChange;
  const arrived = sample(settledAt);
  assert.ok(Math.abs(arrived.x - road.laneWidth) < 1e-8);
  assert.ok(Math.abs(arrived.targetSlot.z) < 1e-8);
  assert.equal(sample(settledAt - .001).targetSlot.opacity, 1);
  for (const [offset, opacity] of [[0, 1], [.25, .75], [.5, .5], [.75, .25], [1, 0], [1.1, 0]]) {
   const pose = sample(settledAt + offset);
   const slot = pose.targetSlot;
   assert.equal(pose.laneHighlight, slot.opacity);
   assert.ok(Math.abs(slot.opacity - opacity) < 1e-8);
   assert.deepEqual(slot, {...arrived.targetSlot, opacity: slot.opacity});
   assert.equal(slot.rim, 0);
  }
 }
});

test('A projected cut-in blocks the target only while the gap is too short', () => {
 const sample = sampledRun(.1, 0);
 const {conflictAt, clearAt, steerAt, settledAt} = sample(0).laneChange;
 assert.ok(conflictAt < clearAt && clearAt < steerAt && settledAt < 10);
 const conflict = sample(conflictAt + .4);
 assert.equal(conflict.targetSlot.opacity, 0);
 assert.ok(conflict.traffic.find(car => car.id === 'lane-change-intruder').trafficFeedback.level > 0);
 assert.equal(conflict.x, 0);
 assert.ok(sample(clearAt).speed < conflict.speed);
 assert.equal(conflict.laneHighlight, 0);
 assert.equal(conflict.pathX(-50), road.egoX);
 assert.equal(conflict.traffic.length, 4);
 assert.ok(sample(steerAt + .4).x > 0);
 assert.equal(sample(settledAt + .2).targetSlot.rim, 0);
 for (let t = 0; t <= 15; t += .05) {
  const frame = sample(t), car = frame.traffic.find(car => car.id === 'lane-change-intruder');
  assert.equal(car.speed, 16);
  assert.ok(Math.abs(frame.distance - car.z - (9 + 16 * t)) < 1e-8);
  if (frame.x > 0) assert.ok(-car.z >= 20);
 }

 const roomyCutIn = sampledRun(.1, .99);
 assert.equal(roomyCutIn(2).traffic.length, 4);
 assert.equal(roomyCutIn(2).laneChange.conflictAt, Infinity);
 assert.equal(roomyCutIn(2).traffic.find(car => car.id === 'lane-change-intruder').trafficFeedback.level, 0);
});

test('Lane change retains the Cut-in fleet and adjusts to the existing target-lane leader', () => {
 const traffic = [
  {id:'cutin', x:1.85, z:-13, yaw:0, speed:15, direction:-1},
  {id:'mainline', x:5.55, z:-22, yaw:0, speed:9, direction:-1},
  {id:'oncoming', x:-1.85, z:45, yaw:Math.PI, speed:15, direction:1},
 ];
 const sample = planRoadLaneChange(() => .1, {egoX:1.85, laneWidth:3.7, live:{traffic, speed:14}});
 const initial = sample(0);
 assert.equal(initial.speed,14);
 assert.deepEqual(initial.traffic.map(car => car.z),traffic.map(car => car.z));
 assert.equal(initial.laneChange.waiting,false);
 assert.ok(Math.abs(sample(15).x - 3.7) < 1e-8);
 for (let time = 0; time <= 15; time += .1) {
  const frame = sample(time);
  assert.deepEqual(frame.traffic.map(car => car.id),traffic.map(car => car.id));
  assert.ok(frame.traffic.every(car => car.opacity === 1));
  if (frame.x > 1.7) assert.ok(Math.abs(frame.traffic[1].z) > 7);
 }
});

test('Lane change holds its lane if a side-by-side car never leaves a usable gap', () => {
 const traffic = [{id:'alongside', x:5.55, z:0, yaw:0, speed:16, direction:-1}];
 const sample = planRoadLaneChange(() => .1, {egoX:1.85, laneWidth:3.7, live:{traffic, speed:16}});
 const frame = sample(15);
 assert.equal(frame.laneChange.waiting,true);
 assert.equal(frame.x,0);
 assert.equal(frame.speed,14);
 assert.ok(frame.distance<240);
 assert.ok(Math.abs(frame.distance-frame.traffic[0].z-240)<1e-8);
 assert.equal(frame.traffic[0].opacity,1);
});

test('A fast target-lane follower passes first and keeps its original speed and trajectory', () => {
 for (const laneWidth of [-3.7, 3.7]) {
  const egoX = 5.55;
  const traffic = [{id:'follower', x:egoX+laneWidth, z:15, yaw:0, speed:22, direction:-1}];
  const sample = planRoadLaneChange(() => .1, {egoX, laneWidth, live:{traffic, speed:16}});
  const {steerAt,settledAt} = sample(0).laneChange;
  assert.ok(steerAt > 4 && settledAt < 15);
  for (let t = 0; t <= 15; t += .05) {
   const frame = sample(t), [car] = frame.traffic;
   assert.equal(car.speed, 22);
   assert.ok(Math.abs(car.z - (15 + frame.distance - 22*t)) < 1e-8);
   if (t >= 1.1 && t < frame.laneChange.clearAt) {
    assert.equal(frame.targetSlot.opacity, 0);
    assert.equal(frame.pathX(-50), egoX);
    assert.equal(frame.x, 0);
   }
   if (frame.x !== 0) assert.ok(car.z <= -19);
  }
  assert.ok(Math.abs(sample(15).x - laneWidth) < 1e-8);
 }
});

test('Waiting holds the intended direction and marks the blocker while keeping the slot hidden', () => {
 const traffic = [{id:'alongside', x:9.25, z:0, yaw:0, speed:16, direction:-1}];
 const sample = planRoadLaneChange(() => .1, {egoX:5.55, laneWidth:3.7, live:{traffic, speed:16}});
 for (const time of [1.2, 3, 8, 14, 15]) {
  const frame = sample(time);
  assert.equal(frame.laneChange.side,'right');
  assert.equal(frame.x,0);
  assert.equal(frame.targetSlot.x,9.25);
  if (time <= 8) assert.equal(frame.traffic[0].trafficFeedback.yellow,1);
  assert.equal(frame.targetSlot.opacity,0);
  assert.equal(frame.laneHighlight,0);
  assert.ok(Math.abs(frame.distance-frame.traffic[0].z-16*time)<1e-8);
 }
});

test('Random traffic stays on its own world-space routes while ego waits or changes lanes', () => {
 let opened = 0, waited = 0;
 for (let seed = 1; seed <= 128; seed++) {
  let n = seed;
  const random = () => (n = (Math.imul(n,1664525) + 1013904223) >>> 0) / 4294967296;
  const egoX = 5.55, laneWidth = seed % 2 ? -3.7 : 3.7, target = egoX + laneWidth;
  const speed = 12 + 9 * random();
  const traffic = [
   {id:'target-leader', x:target, z:-19-57*random(), speed:9+14*random(), direction:-1},
   {id:'target-follower', x:target, z:5+45*random(), speed:13+15*random(), direction:-1},
   {id:'current-leader', x:egoX, z:-27-45*random(), speed:12+10*random(), direction:-1},
   {id:'oncoming', x:-1.85, z:-67, speed:19, direction:1},
  ].map(car => ({...car,yaw:car.direction===1?Math.PI:0}));
  const run = planRoadLaneChange(random,{egoX,laneWidth,live:{traffic,speed}});
  const {waiting,steerAt,settledAt} = run(0).laneChange;
  if (waiting) waited++;
  else opened++;
  for (let frame = 0; frame <= 300; frame++) {
   const t = frame / 20, pose = run(t);
   assert.ok(pose.speed > 0 && pose.speed <= speed, 'ego may hold speed or yield');
   if (t <= steerAt) assert.equal(pose.x,0);
   if (t >= settledAt) assert.equal(pose.x,laneWidth);
   for (const [i,car] of pose.traffic.entries()) {
    const initial = traffic[i];
    assert.equal(car.id,initial.id);
    assert.equal(car.x,initial.x);
    const station = car.z-pose.distance;
    const expected = initial.z+initial.direction*initial.speed*t;
    if (i!==1) assert.ok(Math.abs(station-expected)<1e-8);
    // The follower can slow for its own leader, even if ego never changes lanes.
    else assert.ok(station>=expected-1e-8 && car.speed<=initial.speed);
    if (t>steerAt && car.direction<0 && car.x===target) {
     assert.ok(Math.abs(car.z)>12,`seed ${seed} at ${t}`);
    }
   }
  }
 }
 assert.ok(waited>0 && opened>0);
});
