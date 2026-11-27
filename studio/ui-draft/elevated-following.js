import {interactionCameraLift, maneuverCameraLift} from './interaction-camera.js';
import {FEEDBACK_SPEED_DEADBAND, withDrivingFeedback} from './traffic-feedback.js';
import {MathUtils} from 'three';
import {drivingHeading} from './driving-heading.js';
import {CUT_IN_TIMING} from './cut-in-timing.js';
import {cutInTouchesDivider} from './cut-in-risk.js';

const {clamp, lerp, smoothstep, smootherstep} = MathUtils;

// Integrate the same speed curve used by the ribbon so braking, road motion,
// and following distance agree at any seek time.
export function speedTransition(time, start, duration) {
 const u = clamp((time - start) / duration, 0, 1);
 return {
  speed: u * u * (3 - 2 * u),
  distance: duration * u ** 3 * (1 - u / 2) + Math.max(0, time - start - duration),
  braking: 4 * u * (1 - u),
 };
}

// Integrating the relative speed over the braking interval must leave room
// between both bodies. At larger closing speeds use steady emergency braking.
export function followLeaderTransition(gap, speed, leaderSpeed, horizon) {
 const closing=speed-leaderSpeed;
 if (!(closing>0) || !Number.isFinite(gap)) return {start:Infinity,sample:()=>({speed:0,distance:0,braking:0})};
 const reserve=Math.min(7.25+.8*leaderSpeed,Math.max(7.25,gap-closing*closing/8));
 const available=Math.max(0,gap-reserve);
 const duration=Math.max(closing/8, Math.min(Math.max(2,closing*.5),2*available/closing));
 const start=Math.max(0,Math.min((gap-6-speed)/closing-horizon,available/closing-duration/2));
 if(1.5*closing/duration<=5)return {start,sample:t=>speedTransition(t,start,duration)};
 return {start,sample:t=>{
  const elapsed=Math.max(0,t-start),u=clamp(elapsed/duration,0,1);
  return {speed:u,distance:.5*duration*u*u+Math.max(0,elapsed-duration),braking:Number(elapsed>0&&u<1)};
 }};
}

export function sampleCutInMotion(time, {merge, nearLine, halfIn, inLane}, side = 'left') {
 const signalStart = merge - .35;
 return {
  lift: halfIn === undefined
   ? interactionCameraLift(time, nearLine, inLane)
   : maneuverCameraLift(time, merge, inLane, halfIn),
  rearIndicator: time >= signalStart && time < inLane && (time - signalStart) % .9 < .4 ? side : undefined,
  corridorInfluence: smoothstep(time, nearLine, nearLine + 1.3),
 };
}

// The lead car stops in the middle lane. Ego completes the move left before
// the cars overlap lengthwise, then returns only after clearing the lead.
export const AES_PHASE_START = {closing: 1.35, steer: 1.95, pass: 3.15, return: 5.1, resume: 7.1};
const aesDistance = time => 20 * time - 5 * speedTransition(time, 1.8, 1.6).distance
 + 5 * speedTransition(time, AES_PHASE_START.return, 2.4).distance;

function sampleAmbient(ambient, time, distance) {
 return ambient.map(car => {
  const direction = car.direction ?? 1;
  return {...car, direction, yaw: direction > 0 ? Math.PI : 0, z: distance - car.start + direction * car.speed * time};
 });
}

function sampleAES(time, width, ambient, actor) {
 const {closing, steer, pass, return: returnAt, resume} = AES_PHASE_START;
 const brake = speedTransition(time, 1.8, 1.6);
 const recovery = speedTransition(time, returnAt, 2.4);
 const distance = aesDistance(time);
 const laneX = d => -width * smootherstep(d, aesDistance(steer), aesDistance(pass))
  * (1 - smootherstep(d, aesDistance(returnAt), aesDistance(resume)));
 const leadBrake = speedTransition(time, closing, 2.4);
 const leadDistance = (actor?.start ?? 25) + 18 * (time - leadBrake.distance);
 const leadSpeed = 18 * (1 - leadBrake.speed);
 const leadX = t => actor ? width * (1 - smootherstep(t, actor.enter, actor.arrive)) : 0;
 const signal = time < pass ? steer - .3 : returnAt - .25;
 const signalEnd = time < pass ? pass : resume;
 return {
  distance, speed: 20 - 5 * brake.speed + 5 * recovery.speed,
  x: laneX(distance), yaw: drivingHeading(laneX, distance),
  pathX: z => laneX(distance - z), brakeStrength: brake.braking,
  lift: maneuverCameraLift(time, closing, resume, returnAt),
  lamp: Number(time >= signal && time < signalEnd && (time - signal) % .8 < .4),
  lampSide: time < pass ? 'left' : 'right',
  warning: smootherstep(time, closing + .2, steer) * (1 - smootherstep(time, steer + .4, pass)),
  traffic: [
   {id: actor?.id ?? 'aes', constraining:time>=closing&&time<pass, direction: -1, speed: leadSpeed, x: leadX(time), z: distance - leadDistance,
    yaw: drivingHeading(leadX, time, Math.max(1, leadSpeed))},
   ...sampleAmbient(ambient, time, distance),
  ],
 };
}

export function sampleFollowingEvent(event, time, width, ambient = [], actor) {
 if (event === 'aes') return sampleAES(time, width, ambient, actor);
 const cutIn = event === 'cutin';
 const {merge, nearLine, halfIn, inLane, resume} = CUT_IN_TIMING;
 const brake = cutIn ? speedTransition(time, nearLine, 1.75) : speedTransition(time, 2.2, 5.2);
 const recovery = cutIn ? speedTransition(time, resume, 3) : {speed: 0, distance: 0};
 const speedDrop = cutIn ? 3 : 20;
 const speed = 20 - speedDrop * brake.speed + 2 * recovery.speed;
 const distance = 20 * time - speedDrop * brake.distance + 2 * recovery.distance;
 const leadBrake = speedTransition(time, 1.65, 3.6);
 const acceleration = cutIn ? speedTransition(time, merge, inLane - merge) : null;
 const actorStart = actor?.start ?? 30;
 const leadSpeed = cutIn ? 15 + 4 * acceleration.speed : 18 * (1 - leadBrake.speed);
 const leadDistance = cutIn ? actorStart + 15 * time + 4 * acceleration.distance : 43 + 18 * (time - leadBrake.distance);
 const laneX = t => width * (1 - smootherstep(t, merge, inLane));
 const {lift, ...motion} = cutIn ? sampleCutInMotion(time, CUT_IN_TIMING) : {};
 const x = cutIn ? laneX(time) : 0;
 const yaw = cutIn ? drivingHeading(laneX, time, leadSpeed) : 0;
 const lead = {
  id: actor?.id ?? event,
  ...motion,
  constraining: cutIn ? time >= nearLine && (brake.braking > 0 || speed > leadSpeed + FEEDBACK_SPEED_DEADBAND) : time >= 1.65,
  intentKnown: !cutIn || (time >= merge && cutInTouchesDivider(x, yaw, width)),
  direction: -1, speed: leadSpeed, x, z: distance - leadDistance, yaw,
 };
 // The standalone Cut-in also needs the slower car that motivates the pass.
 const otherCars = cutIn && !actor ? [cutInLeader('cutin-leader', width, actorStart, 20, 13), ...ambient] : ambient;
 return {
  distance, speed, x: 0, yaw: 0, pathX: () => 0, lamp: 0, brakeStrength: brake.braking,
  lift: lift ?? interactionCameraLift(time, 1.65, 5.8),
  warning: cutIn ? 0 : smootherstep(time, 2.18, 2.38) * (1 - smootherstep(time, 6.25, 7.15)),
  traffic: [lead, ...sampleAmbient(otherCars, time, distance)],
 };
}

export function createFollowingTraffic(random, width) {
 // Keep ambient cars on the opposite deck so the two event actors keep
 // their scripted gap. Traffic adds variation without changing the trigger.
 const lane = Math.floor(random() * 3);
 return Array.from({length: 1 + Number(random() > .35)}, (_, index) => ({
  id: 'opposing-' + index, x: -12.7 + ((lane + index) % 3 - 1) * width,
  start: 34 + 81 * index + 32 * random(), speed: lerp(16, 24, random()),
 }));
}

function cutInLeader(id, width, actorStart, gap, speed) {
 return {id, x: width, direction: -1, start: actorStart + gap, speed};
}

export function createInteractionTraffic(random, width, event) {
 const range = (min, max) => lerp(min, max, random());
 const lane = () => width * (Math.floor(random() * 3) - 1);
 const count = random() < .55 ? 3 : 4;
 const ids = Array.from({length:count}, (_, index) => 'traffic-' + index);
 const [id] = ids.splice(Math.floor(random() * count), 1);
 const actor = event === 'cutin'
  ? {id, start:range(28, 35)}
  : {id, start:range(25, 31), enter:range(.18, .4), arrive:range(1.45, 1.7)};
 const ambient = [
  {id:ids[0], x:-12.7 + lane(), direction:1, start:range(62, 110), speed:range(17, 23)},
  event === 'cutin'
   ? cutInLeader(ids[1], width, actor.start, range(18.5, 22), range(12.7, 13.5))
   : {id:ids[1], x:lane(), direction:-1, start:range(63, 93), speed:range(18, 23)},
 ];
 if (ids[2]) ambient.push({id:ids[2], x:-12.7 + lane(), direction:1, start:range(139, 178), speed:range(16, 21)});
 return {actor, ambient};
}

export function planFollowingFeedback(event,width,ambient=[],actor){
 return withDrivingFeedback(time=>sampleFollowingEvent(event,time,width,ambient,actor));
}
