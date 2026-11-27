import {OPEN_ROAD_CRUISE} from './junction-playback.js';
import {DRIVING_EVENT_SECONDS} from './interaction-duration.js';
import {INTERACTION_CAMERA, maneuverCameraLift} from './interaction-camera.js';
import {FEEDBACK_SPEED_DEADBAND, TRAFFIC_FEEDBACK, withDrivingFeedback} from './traffic-feedback.js';
import {MathUtils} from 'three';
import {drivingHeading, rampCameraHeading} from './driving-heading.js';
import {speedTransition} from './elevated-following.js';
import {cutInClearance} from './cut-in-risk.js';
import {mergeRampLaneX} from './ramp-lanes.js';

const {lerp, smootherstep} = MathUtils;
const duration = DRIVING_EVENT_SECONDS;
const step = .05;
const times = Array.from({length: duration / step + 1}, (_, index) => index * step);
const laneWidth = 3.7;
const roadOffset = 3;
const taperEnd = 60 - roadOffset;
const samplingMargin = .55;
const rearLookahead = 2.5;
const mainlinePassingRoom = laneWidth + .8;
const mainlineCruise = OPEN_ROAD_CRUISE;
const passSeconds = 3.6;
const recoverySeconds = 2.65;

const leadGap = speed => cutInClearance.longitudinal + speed * .58 + samplingMargin;
const hasClearance = (a, b) => Math.abs(a.x - b.x) >= cutInClearance.lateral ||
 Math.abs(a.distance - b.distance) >= leadGap(a.distance < b.distance ? a.speed : b.speed);
const fleetsHaveClearance = (a, b) => a.every((pose, index) => hasClearance(pose, b[index]));

function closesYieldGap(ego, cars, index, receivingLaneX) {
 const startGap = cars[index].distance - ego.distance;
 const end = Math.min(index + Math.round(rearLookahead / step), times.length - 1);
 for (let i = index; i <= end; i++) {
  const car = cars[i];
  if (car.x - receivingLaneX >= laneWidth) continue;
  const gap = car.distance - (ego.distance + ego.speed * (times[i] - times[index]));
  const approachingFromBehind = car.speed > ego.speed && gap >= -leadGap(car.speed);
  if (gap < leadGap(ego.speed) && (startGap >= 0 || approachingFromBehind)) return true;
 }
 return false;
}

function leavesPassingRoom(ego, mainline, entry) {
 for (let i = 0; i < entry; i++) {
  const car = mainline[i], pose = ego[i];
  if (car.speed > pose.speed && Math.abs(car.distance - pose.distance) < cutInClearance.longitudinal &&
      pose.x - car.x < mainlinePassingRoom) return false;
 }
 return true;
}

function planMainline(sample, laneX, settledAt, fleetAt) {
 const start = settledAt + .45;
 const tail = times.filter(time => time >= start).map(time => ({time, traffic: fleetAt(time, 0)}));
 if (!tail.length) return null;

 const gain = Math.max(0, mainlineCruise - sample(duration).speed);
 const accelerateFrom = at => time => {
  const motion = sample(time);
  if (time <= at) return motion;
  const change = speedTransition(time, at, 3.8);
  return {distance: motion.distance + gain * change.distance, speed: motion.speed + gain * change.speed, brakeStrength: 0};
 };
 const conflict = (motionAt, path) => {
  for (const {time, traffic} of tail) {
   const motion = motionAt(time);
   const ego = {...motion, x: path(motion.distance)};
   const car = traffic.find(car => car.direction < 0 &&
    !hasClearance(ego, {x: car.x, distance: -car.z, speed: car.speed}));
   if (car) return car;
  }
 };
 const cruise = accelerateFrom(start);
 const blocker = conflict(cruise, laneX);
 if (!blocker) return {sample: cruise, laneX};
 const lead = fleetAt(start, sample(start).distance).find(car => car.id === blocker.id);
 if (lead.z >= 0 || lead.speed >= mainlineCruise - 1) return null;

 for (let passAt = start; passAt + passSeconds < duration; passAt += .35) {
  const pass = accelerateFrom(passAt + .65);
  const begin = pass(passAt).distance, end = pass(passAt + passSeconds).distance;
  const path = distance => laneX(distance) - laneWidth * smootherstep(distance, begin, end);
  const finish = pass(duration);
  const passed = fleetAt(duration, finish.distance).find(car => car.id === lead.id);
  if (passed.z < leadGap(passed.speed) || conflict(pass, path)) continue;
  return {sample: pass, laneX: path, passAt, passSettledAt: passAt + passSeconds, blocker: lead.id};
 }
 return {sample, laneX, blocker: lead.id};
}

export function planRampMerge(random, egoX, {mainlineTraffic} = {}) {
 const range = (min, max) => lerp(min, max, random());
 const startSpeed = range(10.7, 12.1);
 const joinSpeed = range(17.2, 18.4);
 const slowSpeed = range(4.5, 5.5);
 const decisionAt = .8;
 const laneX = (distance, lane = 'outer') => mergeRampLaneX(taperEnd - distance, lane, egoX);
 const innerLaneX = distance => laneX(distance, 'inner');
 const approachAt = targetSpeed => time => {
  const acceleration = speedTransition(time, decisionAt, 3.2);
  return {
   distance: startSpeed * time + (targetSpeed - startSpeed) * acceleration.distance,
   speed: startSpeed + (targetSpeed - startSpeed) * acceleration.speed,
   brakeStrength: 0,
  };
 };
 const approach = approachAt(joinSpeed);
 const framesFor = (sample, lane) => times.map(time => {
  const motion = sample(time);
  return {...motion, x: laneX(motion.distance, lane)};
 });
 const firstOverlap = frames => frames.findIndex(({x}) => x - egoX < cutInClearance.lateral);
 const approachFrames = framesFor(approach);
 const firstEntry = firstOverlap(approachFrames);
 const mainlineFrames = ({start, speed}) => times.map(time => ({distance: start + speed * time, speed, x: egoX}));
 const createCompanion = () => {
  const start = range(-24, 23), initial = range(10.5, 13.7), final = range(13.5, 20);
  const sample = time => {
   const acceleration = speedTransition(time, .45, 3.5);
   return {distance: start + initial * time + (final - initial) * acceleration.distance,
    speed: initial + (final - initial) * acceleration.speed};
  };
  const frames = framesFor(sample, 'inner');
  const entryAt = times[firstOverlap(frames)] ?? duration;
  return {sample, frames, final, signalAt: Math.max(0, entryAt - 1.15)};
 };
 const plan = (primary, mainline, adjacent) => {
  const ramp = adjacent?.frames;
  const clear = (frames, entry) =>
   (!mainline || (fleetsHaveClearance(frames, mainline) && leavesPassingRoom(frames, mainline, entry))) &&
   (!ramp || fleetsHaveClearance(frames, ramp));
  // A vehicle can already be well ahead, well behind, or absent. In all
  // three cases a usable gap should keep the normal approach.
  if (clear(approachFrames, firstEntry)) {
   return {sample: approach, frames: approachFrames, releaseAt: decisionAt};
  }
  // Match a slower lead's pace when the gap is open at entry and would only
  // close later. Keep accelerating on the ramp instead of braking to yield.
  const leads = [[primary?.id, mainline], ['merge-companion', ramp]].filter(([, fleet]) => fleet &&
   fleet[firstEntry].distance - approachFrames[firstEntry].distance >= leadGap(approachFrames[firstEntry].speed));
  const matchSpeed = Math.min(joinSpeed, ...leads.map(([, fleet]) => fleet.at(-1).speed));
  if (matchSpeed < joinSpeed && matchSpeed >= startSpeed) {
   const sample = approachAt(matchSpeed);
   const frames = framesFor(sample), entry = firstOverlap(frames);
   if (entry >= 0 && frames.at(-1).distance >= taperEnd + 8 && clear(frames, entry)) {
    const [id] = leads.find(([, fleet]) => fleet.at(-1).speed === matchSpeed);
    return {sample, frames, releaseAt: decisionAt, matchedLead: {id, speed: matchSpeed}};
   }
  }
  const yieldAt = (release, holdSpeed, followSpeed) => time => {
   const brake = speedTransition(time, decisionAt, 2.05);
   const recovery = speedTransition(time, release, recoverySeconds);
   return {
    distance: startSpeed * time - (startSpeed - holdSpeed) * brake.distance + (followSpeed - holdSpeed) * recovery.distance,
    speed: startSpeed - (startSpeed - holdSpeed) * brake.speed + (followSpeed - holdSpeed) * recovery.speed,
    brakeStrength: brake.braking,
   };
  };
  // A lower coasting speed keeps ego farther back in the taper when
  // a faster mainline car needs room to pass.
  for (const holdSpeed of [slowSpeed, slowSpeed - 2]) {
   const coast = yieldAt(duration, holdSpeed, holdSpeed);
   for (let index = 60; index <= 132; index += 3) {
    const releaseAt = times[index], ego = coast(releaseAt);
    const gap = leadGap(ego.speed);
    const mainlineGap = mainline ? mainline[index].distance - ego.distance : -Infinity;
    const rampGap = ramp ? ramp[index].distance - ego.distance : -Infinity;
    const mainlinePassed = mainlineGap >= gap;
    const rampPassed = rampGap >= gap;
    if ((!mainlinePassed && !rampPassed) || (mainline && closesYieldGap(ego, mainline, index, egoX)) ||
        (ramp && closesYieldGap(ego, ramp, index, egoX))) continue;
    const followSpeed = Math.min(joinSpeed, mainlinePassed ? primary.speed - .3 : Infinity,
     rampPassed ? adjacent.final - .3 : Infinity);
    const sample = yieldAt(releaseAt, holdSpeed, followSpeed);
    const frames = framesFor(sample);
    if (frames.at(-1).distance < taperEnd + 8 ||
        !clear(frames, firstOverlap(frames))) continue;
    return {sample, frames, releaseAt, rampPassed, mainlinePassed, yielding: true};
   }
  }
  return null;
 };
 const useAdjacent = random() < .48;
 const useMainline = random() >= .24;
 let primary, companion, chosen, yieldTo, rearAlsoPassed = false;
 // Keep drawing demo arrivals until they leave ego a safe way to merge.
 const maxArrivalAttempts = mainlineTraffic ? 1 : 32;
 for (let attempt = 0; attempt < maxArrivalAttempts; attempt++) {
  companion = !mainlineTraffic && useAdjacent && attempt < 26 ? createCompanion() : null;
  const speed = range(12.5, 23.5);
  const start = approachFrames[firstEntry].distance - speed * times[firstEntry] + range(-41, 23);
  primary = mainlineTraffic ?? (useMainline ? {id: 'merge-priority', x: egoX, start, speed, direction: -1} : null);
  const mainline = primary && mainlineFrames(primary);
  if (companion && mainline && !fleetsHaveClearance(companion.frames, mainline)) continue;
  chosen = plan(primary, mainline, companion);
  if (!chosen) continue;
  if (chosen?.yielding) {
   const alone = companion && plan(primary, mainline);
   // Compare the same arrivals without the second ramp car. Report a
   // neighbor conflict only if it blocks an earlier usable merge.
   const rampClosesGap = chosen.rampPassed && (!chosen.mainlinePassed ||
    (alone && alone.releaseAt < chosen.releaseAt && !fleetsHaveClearance(alone.frames, companion.frames)));
   yieldTo = rampClosesGap ? 'ramp' : 'mainline';
   const beforeRelease = Math.round((chosen.releaseAt - rearLookahead) / step);
   rearAlsoPassed = rampClosesGap && chosen.mainlinePassed &&
    mainline[beforeRelease].distance < chosen.frames[beforeRelease].distance;
  }
  break;
 }
 if (!chosen && !mainlineTraffic) {
  primary = companion = null;
  chosen = plan(null, null, null);
 }
 // When the available traffic does not leave a usable gap, stop on the ramp.
 if (!chosen) {
  const sample = time => {
   const brake = speedTransition(time,decisionAt,3);
   return {distance:startSpeed*(time-brake.distance),speed:startSpeed*(1-brake.speed),brakeStrength:brake.braking};
  };
  chosen = {sample, frames:framesFor(sample), releaseAt:duration, waiting:true, yielding:true};
  yieldTo = primary ? 'mainline' : 'ramp';
 }
 const {sample, frames, releaseAt, matchedLead} = chosen;
 const passing = !chosen.yielding;
 const mergeAt = times[firstOverlap(frames)] ?? duration;
 const settledAt = times[frames.findIndex(({distance}) => distance >= taperEnd)] ?? duration;
 const cameraHomeAt = Math.max(settledAt, mergeAt + INTERACTION_CAMERA.fall,
  decisionAt + INTERACTION_CAMERA.rise + INTERACTION_CAMERA.fall);
 // Keep the remaining replay for continued driving after the camera returns.
 const endAt = duration;
 const ambientLane = Math.floor(random() * 2);
 const traffic = [
  ...(primary ? [primary] : []),
  {id: 'merge-through', x: -ambientLane * laneWidth, start: range(-3, 23), speed: range(15, 24), direction: -1},
  {id: 'opposing-0', x: -9 - laneWidth * Math.floor(random() * 3), start: range(74, 115), speed: range(15, 23), direction: 1},
 ];
 if ((!companion && !primary) || (!companion && random() < .5)) {
  traffic.push({id: 'opposing-1', x: -9, start: range(129, 179), speed: range(17, 24), direction: 1});
 }
 if (companion && !primary) {
  traffic.push({id: 'merge-through-2', x: -(1 - ambientLane) * laneWidth, start: range(26, 47), speed: range(15, 24), direction: -1});
 }
 const fleetAt = (time, distance) => {
  const poses = traffic.map(car => ({
   ...car, z: distance - car.start + car.direction * car.speed * time, yaw: car.direction > 0 ? Math.PI : 0,
  }));
  if (companion) {
   const {distance: station, speed} = companion.sample(time);
   poses.push({
    id: 'merge-companion', direction: -1, x: laneX(station, 'inner'), z: distance - station,
    yaw: drivingHeading(innerLaneX, station), speed,
    rearIndicator: time >= companion.signalAt && laneX(station, 'inner') > egoX + .06 &&
     (time - companion.signalAt) % .8 < .4 ? 'left' : undefined,
   });
  }
  return poses;
 };
 const mainline = planMainline(sample, laneX, settledAt, fleetAt);
 const path = mainline?.laneX ?? laneX;
 const affectsMerge = (motion, time, sampleCar) => {
  // Check whether committing from the current pose would actually close
  // the gap in the taper. Nearby traffic can pass while ego is still clear.
  for (let elapsed = 0; elapsed <= TRAFFIC_FEEDBACK.horizon + 1e-8; elapsed += .1) {
   const recovery = speedTransition(elapsed, 0, recoverySeconds);
   const gain = joinSpeed - motion.speed;
   const distance = motion.distance + motion.speed * elapsed + gain * recovery.distance;
   const speed = motion.speed + gain * recovery.speed;
   const car = sampleCar(time + elapsed);
   if (!hasClearance({distance, speed, x: laneX(distance)}, car)) return true;
  }
  return false;
 };
 const priorityAt = time => ({distance: primary.start + primary.speed * time, speed: primary.speed, x: egoX});
 const companionAt = time => {
  const pose = companion.sample(time);
  return {...pose, x: innerLaneX(pose.distance)};
 };
 const rampMerge = {cameraHomeAt:chosen.waiting ? endAt : cameraHomeAt, endAt, strategy: chosen.waiting ? 'wait' : passing ? 'accelerate' : 'yield',
  decisionAt, releaseAt, mergeAt, settledAt, yieldTo, rearAlsoPassed, passAt: mainline?.passAt, passSettledAt: mainline?.passSettledAt,
  followsLead: Boolean(mainline?.blocker ?? matchedLead)};
 const raw = time => {
  const motion = (mainline?.sample ?? sample)(time);
  const {distance} = motion;
  const poses = fleetAt(time, distance);
  const signalAt = Math.max(decisionAt, releaseAt - .65);
  const passAt = mainline?.passAt ?? Infinity;
  if (!passing && time >= decisionAt && time < releaseAt) {
   if (primary && affectsMerge(motion, time, priorityAt)) poses.find(car => car.id === primary.id).constraining = true;
   if (companion && affectsMerge(motion, time, companionAt)) poses.find(car => car.id === 'merge-companion').constraining = true;
  }
  if (matchedLead && time < settledAt && motion.speed < matchedLead.speed - FEEDBACK_SPEED_DEADBAND &&
      motion.speed < approach(time).speed - FEEDBACK_SPEED_DEADBAND) {
   const lead = poses.find(pose => pose.id === matchedLead.id);
   if (lead.z < 0) lead.constraining = true;
  }
  if (mainline?.blocker && time >= settledAt && Math.abs(path(distance) - egoX) < cutInClearance.lateral) {
   const lead = poses.find(car => car.id === mainline.blocker);
   // Only mark the mainline leader once ego is actually pace-limited or closing
   // on it, not while the leader is faster and pulling away far ahead.
   const paceCapped = motion.speed >= lead.speed - FEEDBACK_SPEED_DEADBAND || -lead.z < 6 + motion.speed * 1.1;
   if (lead.z < 0 && -lead.z < 8 + motion.speed * 2.4 && paceCapped) lead.constraining = true;
  }
  const signal = time < settledAt ? signalAt : passAt - .4;
  const signalEnd = time < settledAt ? settledAt : passAt + passSeconds;
  return {
   ...motion, roadOffset, rampMerge, x: path(distance) - egoX,
   yaw: drivingHeading(path, distance), cameraYaw: rampCameraHeading(laneX, distance),
   pathX: z => path(distance - z),
   lamp: Number(time >= signal && time < signalEnd && (time - signal) % .8 < .4),
   lampSide: 'left',
   lift: chosen.waiting ? 0 : maneuverCameraLift(time, decisionAt, settledAt, mergeAt),
   holdZ: distance - approachFrames[firstEntry].distance,
   holdWeight: passing ? 0 : smootherstep(time, decisionAt, decisionAt + 1.25) * (1 - smootherstep(time, releaseAt, mergeAt)),
   traffic: poses,
  };
 };
 return withDrivingFeedback(raw,{egoX,duration:endAt});
}
