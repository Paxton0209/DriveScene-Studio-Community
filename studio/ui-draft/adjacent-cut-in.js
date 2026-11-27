import {DRIVING_EVENT_SECONDS} from './interaction-duration.js';
import {FEEDBACK_SPEED_DEADBAND, TRAFFIC_FEEDBACK, withDrivingFeedback} from './traffic-feedback.js';
import {MathUtils} from 'three';
import {drivingHeading, rampCameraHeading} from './driving-heading.js';
import {followLeaderTransition, sampleCutInMotion, speedTransition} from './elevated-following.js';
import {CUT_IN_TIMING} from './cut-in-timing.js';
import {cutInTouchesDivider} from './cut-in-risk.js';
import {rampRightLaneX} from './ramp-lanes.js';
import {planRampMerge} from './ramp-merge.js';
import {INTERACTION_CAMERA, interactionCameraLift} from './interaction-camera.js';
import {continueTraffic} from './road-lane-change.js';

const {clamp, lerp, smootherstep} = MathUtils;
const laneWidth = 3.7;
const duration = DRIVING_EVENT_SECONDS;
const projectedGap = (gap, speed, leaderSpeed, horizon = TRAFFIC_FEEDBACK.horizon) => {
 const closing = speed - leaderSpeed;
 return gap - closing * (closing > 0 ? horizon : 1);
};

// The same evidence drives the Cut-in phase and the need for a wider view.
function withCutInFeedback(sample, egoX, timing) {
 const colored = withDrivingFeedback(sample, {egoX, duration});
 let marked = false;
 let riseAt = Infinity;
 let returnAt = Infinity;
 return time => {
  if (!marked) {
   const phases = [];
   const step = TRAFFIC_FEEDBACK.step;
   for (let tick = 0; tick * step < duration - 1e-8; tick++) {
    const t = tick * step;
    const frame = colored(t);
    const car = frame.traffic.find(car => car.id === timing.actorId);
    const risk = car?.trafficFeedback.level === 2;
    const yieldNow = car?.constraining && car.trafficFeedback.level === 1;
    const cutting = yieldNow && t < timing.inLane;
    const following = frame.traffic.some(car => car.constraining);
    const approaching = t >= timing.merge - .35 && t < timing.impactAt;
    const phase = risk ? 'risk' : cutting ? 'cut-in' : approaching ? 'approach' : following ? 'follow' : 'cruise';
    if (phase !== phases.at(-1)?.phase) phases.push({phase, at:t});
    if ((cutting || risk) && t < timing.inLane) riseAt = Math.min(riseAt, t);
   }
   timing.phases = phases;
   returnAt = Math.max(riseAt + INTERACTION_CAMERA.rise, timing.inLane);
   timing.cameraRiseAt = riseAt;
   timing.cameraReturnAt = returnAt;
  }
  marked = true;
  const frame = colored(time);
  frame.lift = interactionCameraLift(time, riseAt, returnAt);
  for (const car of frame.traffic) {
   // The ribbon describes today's planned route. A nearby vehicle in the
   // source lane can be relevant to the camera without blocking that route.
   car.corridorInfluence = Number(Boolean(car.constraining));
  }
  return frame;
 };
}

// Live Road starts with the cars already in the scene. The selected car
// keeps its pose and velocity. A faster car can also approach from behind.
export function planLiveCutIn(random, {egoX, outerLane, traffic, speed, innerLane = laneWidth / 2, rampExit = false}) {
 const range = (lo, hi) => lerp(lo, hi, random());
 const ahead = range(1.6, 3.3);
 const duration = range(2.65, 3.65);
 const sides = [-1, 1].filter(side => egoX + side * laneWidth >= innerLane - .01
  && egoX + side * laneWidth <= outerLane + .01);
 traffic = traffic.filter(car => (car.growth ?? 1) > .001 && (car.opacity ?? 1) > .001);
 const nearby = traffic.filter(car => car.direction < 0 && (car.opacity ?? 1) > .8);
 const leader = nearby.filter(car => Math.abs(car.x-egoX)<1.5 && car.speed < speed &&
  car.z<0 && -car.z+(car.speed-speed)*DRIVING_EVENT_SECONDS<6+speed)
  .sort((a,b) => a.speed-b.speed || b.z-a.z)[0];
 const lanePace = leader?.speed ?? speed;
 const paceDrop = speed - lanePace;
 const {start:followAt,sample:follow}=followLeaderTransition(leader ? -leader.z : Infinity,speed,lanePace,TRAFFIC_FEEDBACK.horizon);
 const cruiseDistance = time => speed*time-(speed-lanePace)*follow(time).distance;
 const source = sides.map(side => ({side, x: egoX + side * laneWidth}));
 const projectedStation = (car, time) => -car.z + car.speed * time;
 const followingGap = 6 + lanePace * (rampExit ? .9 : .8);
 const responseHorizon = rampExit ? TRAFFIC_FEEDBACK.horizon : 1;
 const step = TRAFFIC_FEEDBACK.step;
 const planYield = ({x, car, pace, station, merge}) => {
  const inLane = merge + duration;
  const nearLine = merge + duration * .27;
  const actorDistance = time => station + pace * time;
  const xAt = time => lerp(car?.x ?? x, egoX, smootherstep(time, merge, inLane));
  const nearDivider = (time, x = xAt(time), yaw = drivingHeading(xAt, time, pace)) =>
   time >= merge && cutInTouchesDivider(x - egoX, yaw, laneWidth);
  for (let tick = Math.ceil(nearLine / step); tick * step < inLane; tick++) {
   const time = tick * step;
   if (!nearDivider(time)) continue;
   const nominalSpeed = speed - paceDrop * follow(time).speed;
   const currentGap = actorDistance(time) - cruiseDistance(time);
   const predicted = projectedGap(currentGap, nominalSpeed, pace, responseHorizon);
   if (currentGap <= 0 || predicted >= followingGap || !rampExit && currentGap >= followingGap) continue;
   const drop = Math.min(lanePace, nominalSpeed, Math.max(0, nominalSpeed - pace) +
    clamp((followingGap - predicted) * .2 + Math.max(0, nominalSpeed - pace) * .35, 0, 2.5));
   if (drop <= FEEDBACK_SPEED_DEADBAND) continue;
   const brakeSeconds=Math.max(2,drop*.5);
   let safe=true;
   for(let t=time;t<=time+brakeSeconds+.1;t+=.1){
    const ego=cruiseDistance(t)-drop*speedTransition(t,time,brakeSeconds).distance;
    if(actorDistance(t)-ego<7){safe=false;break;}
   }
   if(safe)return {yieldAt:time, drop, actorDistance, xAt, nearDivider};
  }
 };
 const canMerge = (stationAt, merge, ignore, minimumGap = 10) => {
  // A car must be able to follow through on the merge at its own speed.
  // Check the receiving lane both while crossing and after settling.
  for (let t = merge + duration * .30; t <= DRIVING_EVENT_SECONDS + .1; t += .2) {
   const station = stationAt(t);
   if (t <= merge + duration + .11 && station - cruiseDistance(t) < minimumGap) return false;
   if (nearby.some(car => car !== ignore && Math.abs(car.x - egoX) < 1.5
     && Math.abs(projectedStation(car, t) - station) < 10)) return false;
  }
  return true;
 };
 const sourceIsClear = (x, stationAt, until, ignore) => {
  for (let t = 0; t <= until; t += .15) {
   if (nearby.some(car => car !== ignore && Math.abs(car.x-x)<1.5
     && Math.abs(projectedStation(car,t)-stationAt(t))<8)) return false;
  }
  return true;
 };
 const candidates = source.flatMap(lane => nearby
  .filter(car => Math.abs(car.x - lane.x) < .22 && Math.abs(car.yaw) < .06 && Math.abs(car.z) < 78)
  .map(car => {
   const closing = car.speed - speed;
   // Start the approach while an overtaker is still close. canMerge
   // checks the larger clearance required when it reaches the lane.
   const passingLead = rampExit ? 12 : 5;
   const earliestPass = rampExit ? ahead : Math.max(1.6, ahead - .6);
   const merge = car.z > 0 && closing > 0 ? Math.max(earliestPass, (car.z + passingLead) / closing) : ahead;
   return {...lane, car, merge, pace:car.speed, station:-car.z,
    score: range(0, 22) - Math.abs(projectedStation(car, merge) - cruiseDistance(merge) - 20)};
  }))
  .filter(({x, car, merge}) => (car.z <= 0 || car.speed > speed) && merge < 9
   && projectedStation(car,merge+duration)-cruiseDistance(merge+duration)<=44
   && sourceIsClear(x,t=>projectedStation(car,t),merge+duration*.7,car)
   && canMerge(t => projectedStation(car, t), merge, car))
  .sort((a, b) => b.score - a.score);
 if (!source.length) return null;
 let route, response;
 for (const candidate of candidates) {
  response = planYield(candidate);
  if (!response) continue;
  route = candidate;
  break;
 }
 const trafficVariant = route ? 0 : random();
 const behind = !rampExit && trafficVariant > .74;
 const tightMerge = trafficVariant > .08 && trafficVariant < .24;
 if (!route) {
  const approachPace = Math.max(3, lanePace - range(2.2, 4.8));
  const gap = tightMerge ? range(8.5, 11.5) : range(14, 20);
  const alternatives = [{pace:approachPace, station:cruiseDistance(ahead+duration)-approachPace*(ahead+duration)+gap,
   merge:ahead, minimumGap:tightMerge ? 8.4 : 10}];
  if (behind) {
   const pace = speed + range(2.5, 3.5);
   const station = -range(4, 10);
   alternatives.unshift({pace, station, merge:Math.max(ahead,(8-station)/(pace-speed))});
  }
  const ordered = random() < .5 ? source : source.reverse();
  for (const merge of [ahead,1.3,2.2,3.2,4.2,5.2,6.2,7.2]) for (const gap of [13,16,19,22]) {
   const pace = Math.max(2, lanePace - 1.6);
   alternatives.push({pace,merge,station:cruiseDistance(merge+duration)+gap-pace*(merge+duration)});
  }
  // A faster neighbor may already be pulling away. Look for room behind it
  // for a car travelling close to ego's pace before abandoning the request.
  for (const merge of [ahead,3.5,5.5,7.5]) for (const gain of [0,.6,-.6]) {
   for (const station of [10.5,13,16]) alternatives.push({pace:Math.max(2,lanePace+gain),merge,station});
  }
  for (const option of alternatives) {
   const projected = t => option.station+option.pace*t;
   const lane = ordered.find(lane => sourceIsClear(lane.x,projected,option.merge+duration*.7)
    && canMerge(projected,option.merge,undefined,option.minimumGap));
   if (!lane) continue;
   const candidate = {...lane,...option};
   response = planYield(candidate);
   if (!response) continue;
   route = candidate;
   break;
  }
 }
 let guidesAt=time=>[{x:egoX,station:cruiseDistance(time),speed:speed-paceDrop*follow(time).speed,direction:-1}];
 const trafficAt = continueTraffic(traffic.filter(car => car !== route?.car),time=>guidesAt(time));
 const ambient = (time,distance,actorConstrained = false) => trafficAt(time,distance)
  .filter(car => car.z < 120 && car.z > -360)
  .map(car => ({...car, constraining: car.id === leader?.id && !actorConstrained && time >= followAt &&
   car.z < 0 && paceDrop * (1 - follow(time).speed) > FEEDBACK_SPEED_DEADBAND}));
 if (!route) {
  const timing = {merge:Infinity,inLane:Infinity,impactAt:Infinity};
  const sample = time => {
   const distance = cruiseDistance(time);
   return {distance,speed:speed-(speed-lanePace)*follow(time).speed,x:0,yaw:0,pathX:()=>egoX,
    brakeStrength:follow(time).braking,lift:0,lamp:0,cutInTiming:timing,traffic:ambient(time,distance)};
  };
  return {timing,sample:withCutInFeedback(sample,egoX,timing)};
 }
 const {merge,pace,station:start} = route;
 const nearLine = merge + duration * .27;
 const halfIn = merge + duration / 2;
 const inLane = merge + duration;
 const resume = inLane + range(.65, 1.5);
 const id = route.car?.id ?? 'live-cut-in-' + Math.floor(random() * 0x100000000);
 const {yieldAt, drop, actorDistance, xAt, nearDivider} = response;
 const brakeDuration = Math.max(2, drop * .5);
 const recoverAt = Math.max(resume, yieldAt + brakeDuration + .5);
 // Use the base speed at the start of recovery. Any later slowdown for an
 // existing leader can lower the speed further without closing on this car.
 const regain = drop > 0 ? Math.min(drop, Math.max(0, pace - speed + paceDrop * follow(recoverAt).speed + drop)) : 0;
 const timing = {merge, nearLine, halfIn, inLane, resume, impactAt: yieldAt, actorId:id};
 const motionAt = time => {
  const brake = speedTransition(time, yieldAt, brakeDuration);
  const recover = speedTransition(time, recoverAt, Math.max(2.5,regain*.75));
  const distance = cruiseDistance(time) - drop * brake.distance + regain * recover.distance;
  const velocity = speed - paceDrop * follow(time).speed - drop * brake.speed + regain * recover.speed;
  return {distance,velocity,brake};
 };
 // Ensure ~3 total vehicles (actor + 2 non-interfering ambient cars)
 // when Cut-in is triggered with Traffic off (empty road).
 const extraAmbient = [];
 if (traffic.length === 0) {
  const freeAt = (cx, cStart, cSpeed, cDir) => {
   for (let t = 0; t <= DRIVING_EVENT_SECONDS; t += .25) {
    const st = cStart - cDir * cSpeed * t;
    const ego = motionAt(t);
    if (Math.abs(cx - egoX) < 2.5 && Math.abs(st - ego.distance) < 12) return false;
    if (Math.abs(cx - xAt(t)) < 2.5 && Math.abs(st - actorDistance(t)) < 12) return false;
   }
   return true;
  };
  const sameDirectionLanes = [];
  for (let lx = innerLane; lx <= outerLane + .01; lx += laneWidth) {
   if (Math.abs(lx - egoX) > .5 && Math.abs(lx - route.x) > .5) sameDirectionLanes.push(lx);
  }
  const sameCandidates = [
   ...sameDirectionLanes.map(lx => ({
    id: 'live-cutin-ambient-same', x: lx, start: range(20, 44),
    speed: clamp(lanePace + range(-1.5, 2.2), 10, 24), direction: -1,
   })),
   {
    id: 'live-cutin-ambient-same', x: route.x, start: Math.max(start, 6) + range(26, 36),
    speed: pace + range(.3, 1.5), direction: -1,
   },
  ];
  for (const cand of sameCandidates) {
   if (extraAmbient.length >= 1) break;
   if (freeAt(cand.x, cand.start, cand.speed, cand.direction)) extraAmbient.push(cand);
  }
  const oppX = rampExit
   ? -12.7 - laneWidth * Math.floor(random() * 2)
   : -laneWidth / 2 - (outerLane > laneWidth ? laneWidth * Math.floor(random() * 2) : 0);
  const opp = {
   id: 'live-cutin-ambient-opp', x: oppX, start: range(48, 108),
   speed: range(15, 21), direction: 1,
  };
  if (freeAt(opp.x, opp.start, opp.speed, opp.direction)) extraAmbient.push(opp);
 }
 guidesAt=time=>{
  const {distance,velocity}=motionAt(time);
  return [{x:egoX,station:distance,speed:velocity,direction:-1},{x:xAt(time),station:actorDistance(time),speed:pace,direction:-1}];
 };
 const sample=time=>{
  const {distance,velocity,brake}=motionAt(time);
  const {rearIndicator} = sampleCutInMotion(time, timing, route.side > 0 ? 'left' : 'right');
  const actorSpeed = pace;
  const x = xAt(time);
  const yaw = drivingHeading(xAt, time, actorSpeed);
  const actualGap = actorDistance(time) - distance;
  const withinGap = actualGap > 0 && (rampExit || actualGap < followingGap) &&
   projectedGap(actualGap, velocity, pace, responseHorizon) < followingGap;
  const intentKnown = nearDivider(time, x, yaw);
  const closing = velocity - pace;
  const tightGap = actualGap < 10;
  const stillMerging = time < inLane;
  const constraining = time >= yieldAt - 1e-8 && intentKnown && withinGap &&
   (time <= yieldAt + 1e-8 || closing > FEEDBACK_SPEED_DEADBAND || (brake.braking > 0 && (stillMerging || closing > -FEEDBACK_SPEED_DEADBAND || tightGap)));
  return {distance, speed: velocity, brakeStrength: Math.max(brake.braking, follow(time).braking),
   x: 0, yaw: 0, pathX: () => egoX, lamp: 0,
   cutInTiming: timing, traffic: [...ambient(time,distance,constraining), {
    rearIndicator, id, direction: -1, speed: actorSpeed, x, z: distance - actorDistance(time), yaw,
    growth: route.car || start<0 ? 1 : smootherstep(time, 0, .6),
    constraining, intentKnown,
   }, ...extraAmbient.map(car => ({
    ...car, z: distance - car.start + car.direction * car.speed * time,
    yaw: car.direction > 0 ? Math.PI : 0,
    growth: smootherstep(time, 0, .6),
    constraining: false, intentKnown: false,
   }))],
  };
 };
 return {timing, sample: withCutInFeedback(sample, egoX, timing)};
}

export function planAdjacentCutIn(random, {layout, egoX, sourceSide = 1}) {
 if (layout === '07') return planRampMerge(random, egoX);
 const exit = layout === '06';
 const timing = CUT_IN_TIMING;
 const {merge, nearLine, halfIn, inLane, resume} = timing;
 const range = (min, max) => lerp(min, max, random());
 const sourceX = egoX + (exit ? -laneWidth : sourceSide * laneWidth);
 const cruise = exit ? range(18.5, 20) : range(16, 18);
 const actorCruise = cruise - range(4.4, 5.5);
 const actorGain = exit ? range(9.4, 10.5) - actorCruise : 0;
 const targetGap = exit ? range(13.5, 24) : range(8.3, 18.5);
 const speedChange = time => exit ? speedTransition(time, merge - .45, 4.6) : speedTransition(time, merge, inLane - merge);
 const actorProgress = time => actorCruise * time + actorGain * speedChange(time).distance;
 let actorStart = targetGap + cruise * halfIn - actorProgress(halfIn);
 const actorDistance = time => actorStart + actorProgress(time);
 // The exit starts farther upstream so the lateral move ends before the fork.
 const roadOffset = exit ? -105 : 0;
 const laneX = exit ? distance => rampRightLaneX(roadOffset + distance - 8) : () => egoX;
 const actor = {
  xAt: time => lerp(sourceX, laneX(actorDistance(time)), smootherstep(time, merge, inLane)),
  speedAt: time => actorCruise + actorGain * speedChange(time).speed,
  distanceAt: actorDistance,
 };
 const extraYield = clamp((16 - targetGap) * .21, 0, 2);
 const followingSpeed = actorCruise + actorGain - .25;
 const followingDrop = Math.max(1.25, cruise - actor.speedAt(halfIn) + .55 + extraYield);
 const brakeDrop = exit ? cruise - followingSpeed + extraYield : followingDrop;
 const recoverGain = Math.min(cruise, followingSpeed) - (cruise - brakeDrop);
 let yieldAt = Infinity;
 const brakeDuration = exit ? 3.3 : 2;
 const ego = time => {
  const brake = speedTransition(time, yieldAt, brakeDuration);
  const recovery = speedTransition(time, resume, 3);
  return {
   distance: cruise * time - brakeDrop * brake.distance + recoverGain * recovery.distance,
   speed: cruise - brakeDrop * brake.speed + recoverGain * recovery.speed,
   brakeStrength: brakeDrop > FEEDBACK_SPEED_DEADBAND ? brake.braking : 0,
  };
 };
 const opposite = exit ? -12.7 : -laneWidth / 2;
 const oppositeLaneCount = exit ? 3 : 2;
 const opposingLane = Math.floor(random() * oppositeLaneCount);
 const opposingX = lane => opposite + laneWidth * ((exit ? 1 : 0) - lane);
 const ambient = [
  // On Road the actor is passing the slower vehicle in its source lane.
  // At the ramp this car stays on the mainline while the actor changes routes.
  {id: 'mainline', x: exit ? 0 : sourceX, start: actorStart + range(22, 28),
   speed: exit ? cruise + range(-1, 1) : actorCruise - range(1.4, 2.4), direction: -1},
  {id: 'opposing-0', x: opposingX(opposingLane), start: range(36, 122), speed: range(cruise - 2, cruise + 2), direction: 1},
 ];
 if (random() < .5) {
  ambient.push({id: 'opposing-1', x: opposingX((opposingLane + 1) % oppositeLaneCount), start: range(146, 203), speed: range(cruise - 2, cruise + 2), direction: 1});
 }
 const followingGap = 6 + cruise * (exit ? .9 : 1.1);
 const touchesLane = time => {
  const station = actor.distanceAt(time), laneYaw = drivingHeading(laneX, station);
  const offset = (actor.xAt(time) - laneX(station)) * Math.cos(laneYaw);
  const yaw = drivingHeading(actor.xAt, time, actor.speedAt(time)) - laneYaw;
  return time >= merge && cutInTouchesDivider(offset, yaw, laneWidth);
 };
 for (let i = Math.round(nearLine / TRAFFIC_FEEDBACK.step); i * TRAFFIC_FEEDBACK.step < inLane; i++) {
  const time = i * TRAFFIC_FEEDBACK.step;
  if (!touchesLane(time) || projectedGap(actor.distanceAt(time) - cruise * time, cruise, actor.speedAt(time)) >= followingGap) continue;
  yieldAt = time;
  break;
 }
 if (Number.isFinite(yieldAt)) {
  let clearance = Infinity;
  for (let time = yieldAt; time <= duration; time += TRAFFIC_FEEDBACK.step) clearance = Math.min(clearance, actor.distanceAt(time) - ego(time).distance);
  const correction = Math.max(0, 8.1 - clearance);
  actorStart += correction;
  if (!exit) ambient[0].start += correction;
 }
 const cutInTiming = {...timing, impactAt: yieldAt, actorId:'cutin'};
 const sample = time => {
  const motion = ego(time);
  const actorSpeed = actor.speedAt(time);
  const station = actor.distanceAt(time);
  const actorX = actor.xAt(time);
  const actorYaw = drivingHeading(actor.xAt, time, actorSpeed);
  const intentKnown = touchesLane(time);
  const {rearIndicator} = sampleCutInMotion(time, timing, (exit || sourceSide < 0) ? 'right' : 'left');
  const {distance} = motion;
  return {
   ...motion, roadOffset, cutInTiming, x: laneX(distance) - egoX,
   yaw: drivingHeading(laneX, distance), cameraYaw: rampCameraHeading(laneX, distance),
   pathX: z => laneX(distance - z), lamp: 0,
   traffic: [{
    id: 'cutin', direction: -1, speed: actorSpeed, x: actorX,
    z: distance - station, yaw: actorYaw,
    rearIndicator,
    constraining: time >= yieldAt && intentKnown && station > distance &&
     projectedGap(station - distance, motion.speed, actorSpeed) < followingGap &&
     (time === yieldAt || motion.brakeStrength > 0 || motion.speed > actorSpeed + FEEDBACK_SPEED_DEADBAND),
    intentKnown,
   }, ...ambient.map(car => ({
    ...car, z: distance - car.start + car.direction * car.speed * time,
    yaw: car.direction > 0 ? Math.PI : 0,
   }))],
  };
 };
 return withCutInFeedback(sample,egoX,cutInTiming);
}
