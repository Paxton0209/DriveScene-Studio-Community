import {maneuverCameraLift} from './interaction-camera.js';
import {TRAFFIC_FEEDBACK, withDrivingFeedback} from './traffic-feedback.js';
import {MathUtils} from 'three';
import {drivingHeading} from './driving-heading.js';
import {LANE_CHANGE_TIMING} from './lane-change-timing.js';
import {DRIVING_EVENT_SECONDS} from './interaction-duration.js';
import {followLeaderTransition, speedTransition} from './elevated-following.js';

const {clamp, smootherstep, lerp} = MathUtils;
const speed = 16;
const laneFadeInSeconds = 1;
const {slotFadeSeconds} = LANE_CHANGE_TIMING;
const slotLead = 16;
const safeGap = 22;
const slotClearance = 5.5;

function planCutIn(random, egoX, laneWidth) {
 const start = lerp(9, 27, random());
 const enter = lerp(.85, 1.12, random());
 const duration = lerp(2.4, 2.75, random());
 const xAt = time => egoX + laneWidth * smootherstep(time, enter, enter + duration);
 // At the divider the two swept vehicle footprints already share a corridor.
 // Warn ahead of that crossing only if the predicted gap is too short.
 const overlapAt = enter + duration / 2;
 const conflictAt = start < safeGap ? overlapAt - .65 : Infinity;
 const drop = start < safeGap ? clamp((safeGap - start) * .8, 1.5, 4.6) : 0;
 const clearAt = drop ? conflictAt + 1 + (safeGap - start) / drop : 0;
 return {
  conflictAt, clearAt, drop, enter, end:enter+duration,
  sample(time, distance) {
   const signaling = time >= enter - .45 && time < enter + duration && (time - enter + .45) % .8 < .4;
   return {
    id: 'lane-change-intruder', direction: -1, speed, x: xAt(time), z: distance - (start + speed * time),
    yaw: drivingHeading(xAt, time, speed),
    rearIndicator: signaling ? (laneWidth > 0 ? 'right' : 'left') : null,intentKnown:time>=enter-.45,
   };
  },
 };
}

export function continueTraffic(traffic, guidesAt) {
 const cars=traffic.filter(car=>(car.opacity??1)>0);
 const step=.1;
 const initial=cars.map(car=>({station:-car.z,speed:car.speed}));
 let frames=[initial], origin=0;
 function advance(index) {
  const before=frames.at(-1), guides=guidesAt?.(index*step)??[];
  const lanes=cars.map((car,i)=>({...before[i],x:car.x,direction:car.direction}));
  const obstacles=lanes.concat(guides);
  return cars.map((car,i)=>{
   const {speed,station}=before[i], sign=-car.direction;
   let target=car.preferredSpeed??car.speed;
   for(const lead of obstacles){
    if(lead.direction!==car.direction||Math.abs(car.x-lead.x)>2.2)continue;
    const gap=(lead.station-station)*sign;
    if(gap<=0)continue;
    const buffer=7+.6*speed;
    const safe=Math.sqrt(lead.speed**2+5*Math.max(0,gap-buffer));
    target=Math.min(target,safe,lead.speed+(gap-buffer)/1.4);
   }
   const nextSpeed=Math.max(0,speed+clamp(target-speed,-5*step,1.6*step));
   return {speed:nextSpeed,station:station+sign*(speed+nextSpeed)*step/2};
  });
 }
 return (time,distance)=>{
  const pos=Math.max(0,time)/step, i=Math.floor(pos);
  if(i<origin){frames=[initial];origin=0;}
  while(origin+frames.length<=i+1){
   frames.push(advance(origin+frames.length-1));
   if(frames.length>1200){frames=frames.slice(600);origin+=600;}
  }
  return cars.map((car,j)=>{
   const a=frames[i-origin][j],b=frames[i-origin+1][j];
   return {...car,speed:lerp(a.speed,b.speed,pos-i),z:distance-lerp(a.station,b.station,pos-i),opacity:1,
    rearIndicator:null,constraining:false,corridorInfluence:undefined,intentKnown:undefined};
  });
 };
}

export function planRoadLaneChange(random, {egoX, laneWidth, live}) {
 const {signalAt, steerAt, settledAt} = LANE_CHANGE_TIMING;
 const targetX = egoX + laneWidth;
 const intruder = !live && random() < .42 ? planCutIn(random, egoX, laneWidth) : null;
 const carried=live?.traffic.filter(car=>(car.growth??1)>.001 && (car.opacity??1)>.001);
 const trafficAt = carried?.length ? continueTraffic(carried) : null;
 const desired=live?.cruiseSpeed??live?.speed;
 const leader = carried?.filter(car => car.direction < 0 && car.z < 0 && Math.abs(car.x - egoX) < 1.5 &&
   -car.z + (car.speed - desired) * DRIVING_EVENT_SECONDS < 6 + desired && car.speed < desired)
  .sort((a,b) => a.speed-b.speed || b.z-a.z)[0];
 const cruise = leader?.speed ?? live?.cruiseSpeed ?? live?.speed ?? speed;
 const following=leader ? followLeaderTransition(-leader.z,live.speed,cruise,TRAFFIC_FEEDBACK.horizon) : null;
 const targetCruise = live ? Math.min(cruise, ...carried
  .filter(car => car.direction < 0 && car.z < 0 && Math.abs(car.x - targetX) < 1.5)
  .map(car => car.speed)) : speed;
 const motionFor = (time, pace, releaseAt) => {
  if (!live) {
   if (!intruder?.drop) return {speed, distance: speed * time};
   const ease = speedTransition(time, intruder.conflictAt, 2);
   const recover = speedTransition(time, intruder.clearAt, 2);
   return {speed: speed - intruder.drop * (ease.speed - recover.speed),
    distance: speed * time - intruder.drop * (ease.distance - recover.distance)};
  }
  const delta = pace - live.speed;
  const change = following && delta<0 && pace===cruise ? following.sample(time) :
   speedTransition(time, delta>=0 ? 0 : signalAt, Math.max(2, -delta / 2, delta / .6));
  if (releaseAt === undefined) {
   return {speed: live.speed + delta * change.speed, distance: live.speed * time + delta * change.distance,
    brakeStrength: delta<0 ? change.braking : 0};
  }
  const coast = speedTransition(time, signalAt, 2.2);
  const recover = speedTransition(time, releaseAt, 3);
  const drop = Math.min(2, pace * .16);
  return {speed: live.speed + delta * change.speed - drop * (coast.speed - recover.speed),
   distance: live.speed * time + delta * change.distance - drop * (coast.distance - recover.distance),
   brakeStrength: coast.braking};
 };
 const inTargetLane = car => car.direction < 0 && Math.abs(car.x - targetX) < 1.5;
 const slotBlockedBy = (car, z) => inTargetLane(car) && Math.abs(car.z - z) < slotClearance;
 const slotZAt = (time, start, end) => -slotLead * smootherstep(end - time, 0, end - start);
 const conflictsWithGap = (car, ego) => inTargetLane(car) &&
  Math.abs(car.z) < 5 + Math.max(8, car.z < 0 ? ego.speed : car.speed);
 const canSteerAt = (previewAt, start, pace, releaseAt) => {
  // Check the reserved slot through settlement, and the traffic gap through the run.
  const end = start + settledAt - steerAt;
  for (let time = previewAt; time <= DRIVING_EVENT_SECONDS; time += .1) {
   const ego = motionFor(time, pace, releaseAt);
   if (trafficAt(time, ego.distance).some(car =>
    (time < end && slotBlockedBy(car, slotZAt(time, start, end))) ||
    (time >= start && conflictsWithGap(car, ego)))) return false;
  }
  return true;
 };
 const initiallyOccupied = trafficAt?.(signalAt, motionFor(signalAt, cruise).distance)
  .some(car => slotBlockedBy(car, -slotLead));
 let liveSteerAt = steerAt;
 let pace = cruise;
 let previewStart = signalAt;
 const latestSteer = DRIVING_EVENT_SECONDS - (settledAt - steerAt) - 1.35;
 if (trafficAt) for (; liveSteerAt <= latestSteer; liveSteerAt += .15) {
  const yielding = initiallyOccupied || liveSteerAt > steerAt;
  const release = yielding ? liveSteerAt + .35 : undefined;
  previewStart = yielding ? liveSteerAt : signalAt;
  const start = release ?? liveSteerAt;
  if (canSteerAt(previewStart, start, cruise, release)) break;
  if (targetCruise < cruise && canSteerAt(previewStart, start, targetCruise, release)) {
   pace = targetCruise;
   break;
  }
 }
 const waiting = liveSteerAt > latestSteer;
 const conflictAt = live && (liveSteerAt > steerAt || initiallyOccupied) ? signalAt : intruder?.conflictAt ?? Infinity;
 const blocked = Number.isFinite(conflictAt);
 const previewAt = blocked ? (live ? previewStart : Math.max(intruder.clearAt, signalAt)) : signalAt;
 const clearAt = live ? (waiting ? DRIVING_EVENT_SECONDS : liveSteerAt) : blocked ? intruder.clearAt : 0;
 const startSteering = live ? liveSteerAt + (blocked ? .35 : 0) : blocked ? Math.max(steerAt, clearAt + .35) : steerAt;
 const delay = startSteering - steerAt;
 const settle = settledAt + delay;
 const cameraRiseAt = signalAt + delay;
 const laneChange = {steerAt: waiting ? Infinity : startSteering, settledAt: waiting ? Infinity : settle,
  conflictAt, clearAt, cameraHomeAt: waiting ? DRIVING_EVENT_SECONDS : settle,
  side: laneWidth > 0 ? 'right' : 'left', liveTraffic: !!live, waiting,
  intruder: intruder && {enter:intruder.enter,end:intruder.end}};
 const laneX = time => {
  if (waiting) return egoX;
  const progress = clamp((time - startSteering) / (settle - startSteering), 0, 1);
  const shoulders = 8 * (progress * (1 - progress)) ** 3 * (1 - 2 * progress);
  // Keep zero lateral velocity and acceleration at both ends while spreading
  // more of the move across the shoulders of the curve.
  return egoX + laneWidth * (smootherstep(progress, 0, 1) + shoulders);
 };
 const release=live&&blocked?(waiting?Infinity:startSteering):undefined;
 const exit=motionFor(settle,pace,release);
 const newLeader=leader && !waiting && trafficAt(settle,exit.distance).some(car=>inTargetLane(car) && car.z<0);
 const recover=leader && !waiting && !newLeader && desired>exit.speed;
 function drivingMotion(time){
  if(!recover || time<=settle)return motionFor(time,pace,release);
  const gain=desired-exit.speed, change=speedTransition(time,settle,Math.max(2,gain));
  return {speed:exit.speed+gain*change.speed,distance:exit.distance+exit.speed*(time-settle)+gain*change.distance,brakeStrength:0};
 }
 const renderedTraffic=trafficAt&&continueTraffic(carried,time=>{
  const motion=drivingMotion(time);
  return [{x:laneX(time),station:motion.distance,speed:motion.speed,direction:-1}];
 });
 const fleet = trafficAt ? [] : [
  // The target gap is bounded by a car ahead and a car behind, both close
  // enough to read in frame, so "Gap detected" shows a real opening.
  // A car cutting into the gap needs the original room ahead of it.
  {id:'lane-change-ahead', x:targetX, start:intruder ? lerp(56, 68, random()) : lerp(32, 38, random()), speed:cruise+lerp(1.5, 3, random()), direction:-1},
  {id:'lane-change-behind', x:targetX, start:lerp(-26,-22,random())-(intruder?.drop?13:0), speed:Math.max(2,cruise-lerp(2, .5, random())), direction:-1},
  {id:'lane-change-opposing', x:-egoX, start:lerp(58, 92, random()), speed:lerp(14, 17, random()), direction:1},
 ];
 const sample = time => {
  const x = laneX(time);
  const {distance, speed, brakeStrength} = drivingMotion(time);
  const framing = waiting ? 0 : maneuverCameraLift(time, cameraRiseAt, settle, startSteering);
  const waitingForGap = blocked && time >= conflictAt && time < clearAt;
  const slotZ = waiting ? -slotLead : slotZAt(time, startSteering, settle);
  const selected = waiting ? 0 : smootherstep(time, startSteering, startSteering + .24);
  const fade = waiting ? 0 : 1 - clamp((time - settle) / slotFadeSeconds, 0, 1);
  const fleetFrame = renderedTraffic ? renderedTraffic(time, distance) : fleet.map(car => ({
   ...car, z:distance - car.start + car.direction * car.speed * time,
   yaw:car.direction > 0 ? Math.PI : 0,
  }));
  const enteringCar = intruder?.sample(time, distance);
  if (enteringCar) fleetFrame.push(enteringCar);
  const showGap = !waiting && !waitingForGap;
  const targetOpacity = showGap ? smootherstep(time, previewAt, previewAt + .3) * fade : 0;
  const laneOpacity = showGap ? clamp((time - previewAt) / laneFadeInSeconds, 0, 1) * fade : 0;
  const preview = showGap || time >= startSteering ? smootherstep(time, previewAt, startSteering) : 0;
  if (waitingForGap) for (const car of fleetFrame) {
   const ahead = car.z < 0;
   const closing = ahead ? speed - car.speed : car.speed - speed;
   const buffer = 5 + Math.max(8, ahead ? speed : car.speed);
   const predictedGap = Math.abs(car.z) - Math.max(0, closing) * TRAFFIC_FEEDBACK.horizon;
   // A slower trailing car falling further behind or a faster leading car
   // pulling away cannot block the lane change unless physically alongside ego.
   const receding = closing < -.5;
   const blocks = inTargetLane(car) && (receding
    ? Math.abs(car.z) < 8.5 || (ahead && slotBlockedBy(car, -slotLead))
    : slotBlockedBy(car, -slotLead) || predictedGap < buffer);
   car.constraining = car === enteringCar || blocks;
  }
  if(leader && pace===cruise && following && time>=following.start && brakeStrength>0 && speed>cruise+.5 &&
   Math.abs(x-leader.x)<2.1){
   const lead=fleetFrame.find(car=>car.id===leader.id);
   if(lead && lead.z<0)lead.constraining=true;
  }
  const signalStart = time >= clearAt && blocked ? clearAt : signalAt;
  return {
   laneChange, distance, speed, brakeStrength, x:x - egoX,
   yaw:drivingHeading(laneX, time, speed, startSteering),
   pathX:z => lerp(x, laneX(time - z / Math.max(1, speed)), preview),
   lamp:Number(time >= signalStart && time < settle && !(time >= conflictAt && time < clearAt) && (time - signalStart) % .8 < .4),
   lampSide:laneWidth > 0 ? 'right' : 'left',
   lift:framing, targetBias:(targetX - x) * .24 * framing,
   laneHighlight:laneOpacity,
   targetSlot:{
    x:targetX,
    // Advance with ego during preview. While steering, ego catches up
    // to the moving slot and both centers meet at settlement.
    z:slotZ,
    opacity:targetOpacity,
    rim:smootherstep((targetX - x) / laneWidth, .02, .12),
    selected,
   },
   traffic:fleetFrame,
  };
 };
 return withDrivingFeedback(sample,{egoX});
}
