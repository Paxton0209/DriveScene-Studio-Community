import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {feedbackOverlap} from '../traffic-feedback.js';
import {planRoadworksTraffic, ROADWORKS_CLEARED_DISTANCE, ROADWORKS_CRUISE} from '../roadworks-traffic.js';
import {planRoadLaneChange} from '../road-lane-change.js';
import {planRampMerge} from '../ramp-merge.js';
import {planJunctionTurn, createJunctionStream} from '../junction-left-turn.js';
import {planLiveCutIn} from '../adjacent-cut-in.js';

function makeRandom(seed) {
  let value = seed >>> 0;
  const next = () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  next.reset = () => { value = seed >>> 0; };
  return next;
}

test('feedbackOverlap extends speed safety margin forward only, not symmetrically behind a leading car', () => {
  const ego = {x: 0, z: 0, yaw: 0, speed: 18};
  // At 15 m center-to-center (10.1 m bumper-to-bumper) behind a same-speed/faster leader,
  // ego's forward margin should not collide with a nonexistent backward margin from the leader.
  assert.equal(feedbackOverlap(ego, {x: 0, z: -15, yaw: 0, speed: 20}), false);
  // Close tailgating at high speed still triggers urgent overlap.
  assert.equal(feedbackOverlap({...ego, speed: 20}, {x: 0, z: -10, yaw: 0, speed: 20}), true);
});

test('Roadworks never highlights an unmoved outer-lane car at t=0 before it begins merging', () => {
  for (const seed of [6, 10, 11]) {
    const run = planRoadworksTraffic(makeRandom(seed), {
      duration: 15, width: 3.7, clearedDistance: ROADWORKS_CLEARED_DISTANCE,
      offset: 0, trafficEnabled: true, adaptiveTraffic: true, extendUntilClear: true,
    });
    const f0 = run.sample(0);
    const right = f0.traffic.find(c => c.id === 'right');
    assert.ok(right && Math.abs(right.x - 3.7) < 0.01);
    assert.equal(right.trafficFeedback.level, 0, `seed ${seed}: right car still in outer lane at t=0 must stay grey`);
  }
});

test('Road Lane Change does not highlight a slower trailing car falling further behind', () => {
  const traffic = [
    {id: 'slow-rear', x: 5.55, z: 11.5, yaw: 0, speed: 14, direction: -1},
    {id: 'alongside', x: 5.55, z: 0, yaw: 0, speed: 22, direction: -1},
  ];
  const sample = planRoadLaneChange(() => 0.1, {
    egoX: 1.85, laneWidth: 3.7,
    live: {speed: ROADWORKS_CRUISE, cruiseSpeed: ROADWORKS_CRUISE, traffic},
  });
  const f = sample(1.2);
  assert.equal(f.traffic.find(c => c.id === 'slow-rear').trafficFeedback.level, 0);
  assert.equal(f.traffic.find(c => c.id === 'alongside').trafficFeedback.yellow, 1);
});

test('Ramp Merge does not highlight a faster mainline leader far ahead after settling', () => {
  const sample = planRampMerge(makeRandom(2), 3.7);
  const f = sample(6.2);
  const lead = f.traffic.find(c => c.id === 'merge-priority');
  assert.ok(lead && lead.speed > f.speed + 1 && -lead.z > 30);
  assert.equal(lead.trafficFeedback.level, 0);
});

test('Junction Left Turn highlights an imminent blocker even in a multi-car platoon', () => {
  const car = (id, x) => ({id, x, z: -34.45, axis: 'x', direction: 1, yaw: -Math.PI / 2, speed: 12});
  const run = planJunctionTurn(() => 0.45, -24.36, {time: 7.5, cars: [car('c1', -26), car('c2', -50)]});
  assert.ok(run.timing.turnAt > 10);
  assert.ok(run.sample(7.65).traffic.some(c => c.constraining), 'first imminent blocker should be marked');
});

test('Static packager emits Cloudflare Pages _headers with immutable asset caching', async () => {
  const packager = await readFile(new URL('../../../scripts/package-static.mjs', import.meta.url), 'utf8');
  assert.match(packager, /'_headers'/);
  assert.match(packager, /max-age=31536000, immutable/);
  assert.match(packager, /\/sw\.js/);
});

test('Interactions spawn around 3 vehicles even when triggered from empty road', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const cutIn = planLiveCutIn(makeRandom(seed), {egoX: 1.85, outerLane: 9.25, speed: 18, traffic: []});
    const frame = cutIn.sample(1);
    assert.ok(frame.traffic.length >= 3, `seed ${seed}: Cut-in expected >= 3 cars, got ${frame.traffic.length}`);
    const junction = createJunctionStream(makeRandom(seed));
    assert.ok(junction.cars.length >= 3 && junction.cars.length <= 6, `seed ${seed}: Junction expected 3..6 cars, got ${junction.cars.length}`);
  }
});
