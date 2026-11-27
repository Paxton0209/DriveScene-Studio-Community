import {OPEN_ROAD_CRUISE} from './junction-playback.js';
import {createTrafficFeedback, feedbackFields, FEEDBACK_SPEED_DEADBAND, TRAFFIC_FEEDBACK} from './traffic-feedback.js';
import {MathUtils} from 'three';
import {overlaps} from './parking-kinematics.js';
import {drivingHeading,trafficHeading} from './driving-heading.js';
import {sampleCutInMotion, speedTransition} from './elevated-following.js';
import {CUT_IN_TIMING} from './cut-in-timing.js';
import {cutInClearance} from './cut-in-risk.js';

const {clamp, lerp, smootherstep} = MathUtils;
const step = 1 / 60;
export const ROADWORKS_CRUISE = OPEN_ROAD_CRUISE;
const cruise = ROADWORKS_CRUISE;
const workSpeed = 60 / 3.6;
// A full lane change spans several seconds at elevated-road speeds.
export const ROADWORKS_MERGE_DISTANCE = 72;
export const ROADWORKS_CONE_START = 94;
export const ROADWORKS_CONE_SPACING = 4.6;
export const ROADWORKS_TAPER_INTERVALS = 11;
export const ROADWORKS_CLEARED_DISTANCE = ROADWORKS_CONE_START + 13 * ROADWORKS_CONE_SPACING + 6;
const holdDistance = 104;
const cruiseTail = 2.5;
const gapConfirmationSeconds = .55;
const roadworksHorizon = (duration, offset, extend) => extend ? Math.max(duration, 30 + Math.max(0, offset) / 12) : duration;
const {longitudinal: longitudinalClearance, lateral: lateralClearance} = cutInClearance;

export const roadworksCameraInRange = (distance, speed, offset) =>
 ROADWORKS_CONE_START + offset - distance <= clamp(speed * 1.5, 18, 32);

const brakeStart = 1.4, brakeDuration = 4, recoveryDuration = 5.5;
const distanceAtBrakeEnd = cruise * brakeStart + (cruise + workSpeed) * brakeDuration / 2;
const resumeTime = brakeStart + brakeDuration + (ROADWORKS_CLEARED_DISTANCE - distanceAtBrakeEnd) / workSpeed;
export function sampleRoadworksSpeed(time, offset, cleared = true) {
 const brake = speedTransition(time, brakeStart + offset / cruise, brakeDuration);
 const resume = speedTransition(time, cleared ? resumeTime + offset / workSpeed : Infinity, recoveryDuration);
 const speedDifference = cruise - workSpeed;
 return {
  speed: cruise + speedDifference * (resume.speed - brake.speed),
  distance: cruise * time + speedDifference * (resume.distance - brake.distance),
  acceleration: 1.5 * speedDifference * (resume.braking / recoveryDuration - brake.braking / brakeDuration),
  brakeStrength: brake.braking,
 };
}

function laneChange(from, to, start, end) {
 return value => lerp(from, to, smootherstep(value, start, end));
}

function sweptEncounter(at,end,closing){
 const inside=(a,b,lo,hi,range)=>{
  const delta=b-a;if(Math.abs(delta)<1e-10)return a>=lo&&a<=hi;
  const x=(lo-a)/delta,y=(hi-a)/delta;
  range[0]=Math.max(range[0],Math.min(x,y));range[1]=Math.min(range[1],Math.max(x,y));
  return range[0]<=range[1];
 };
 let a=at(0);
 for(let t=.2;t<end+.2;t+=.2){
  const b=at(Math.min(t,end)),range=[0,1];
  if(inside(a.x,b.x,-2.35,2.35,range)&&inside(a.z,b.z,-7,7+closing*.6,range))return true;
  a=b;
 }
 return false;
}

function approachingCars(random, width, adaptiveTraffic, extendUntilClear) {
 const range = (min, max) => lerp(min, max, random());
 const roll = random();
 const leftPass = roll < (adaptiveTraffic ? .30 : .40);
 const rightMerge = !leftPass && roll < (adaptiveTraffic ? .58 : .80);
 const closeLead = adaptiveTraffic && roll >= .58 && roll < .84;
 const left = -width;
 const cars = [];
 function add(id, start, speed, xAt, direction = -1) {
  const car = {id, direction, speedAt: () => speed, xAt, distanceAt: time => start - direction * speed * time};
  cars.push(car);
  return car;
 }
 function fromRight(id, start, speed, enter, reachMiddle, leaveMiddle, reachLeft) {
  const enterMiddle = laneChange(width, 0, enter, reachMiddle);
  const enterLeft = laneChange(0, left, leaveMiddle, reachLeft);
  return add(id, start, speed, time => enterMiddle(time) + enterLeft(time));
 }

 // Offset the two closures longitudinally. Each driver starts with room to
 // change lanes upstream of the taper, and the right lane merges one lane at a time.
 const frontMerge = closeLead ? range(1.25, 1.65) : range(.15, .55);
 const frontStart = closeLead ? range(29, 38) : range(75, 83);
 const frontSpeed = closeLead ? range(13.8, 16.2) : range(16.9, 18.4);
 const frontMergedAt = frontMerge + range(2.2, 2.55);
 const front = add('middle', frontStart, frontSpeed, laneChange(0, left, frontMerge, frontMergedAt));
 const enter = rightMerge ? range(.2, .48) : range(.12, .36);
 const reachMiddle = enter + range(1.95, 2.15);
 const leaveMiddle = reachMiddle + range(.15, .28);
 const reachLeft = leaveMiddle + range(2.1, 2.35);
 const right = fromRight('right', rightMerge ? range(23, 29) : leftPass || adaptiveTraffic ? range(-47, -35) : range(44, 48),
  rightMerge ? range(16, 17.2) : range(16.4, 17.4), enter, reachMiddle, leaveMiddle, reachLeft);
 if (extendUntilClear) {
  const closing = right.speedAt(0) - frontSpeed;
  if (closing > 0) {
   const pace = right.speedAt(0), start = right.distanceAt(0);
   const brakeDuration = closing / 2.4;
   const brakeAt = Math.max(0,(frontStart-start-10-closing*brakeDuration/2)/closing);
   right.speedAt = time => pace - closing * clamp((time-brakeAt)/brakeDuration,0,1);
   right.distanceAt = time => {
    const braking = clamp(time-brakeAt,0,brakeDuration);
    return start + pace*time - 1.2*braking**2 - closing*Math.max(0,time-brakeAt-brakeDuration);
   };
  }
 }
 if (leftPass) {
  const start = range(-15, -6), speed = range(25.8, 28.2), closing = speed - frontSpeed;
  const passing = add('passing', start, speed, () => left);
  // After passing ego, the driver eases down to the speed of the car ahead.
  const brakeAt = (frontStart - start - 46) / closing;
  const brakeDuration = closing / 2.4;
  passing.speedAt = time => speed - closing * clamp((time - brakeAt) / brakeDuration, 0, 1);
  passing.distanceAt = time => {
   const braking = clamp(time - brakeAt, 0, brakeDuration);
   return start + speed * time - 1.2 * braking ** 2 - closing * Math.max(0, time - brakeAt - brakeDuration);
  };
 }
 if (random() < .6) add('far', range(139, 179), range(20, 24), () => left);
 if (!leftPass && random() < .55) {
  const start = range(4.35, 4.9);
  const distance = adaptiveTraffic && !rightMerge ? range(-108, -89) : range(-66, -50);
  fromRight('following', distance, range(16, 18), start, start + 2.2, start + 2.55, start + 4.85);
 }
 // The median separates opposing traffic from this work zone. Vary which
 // lanes are populated and where each car first enters the view.
 const opposite = -12.7;
 const oppositeLane = Math.floor(random() * 3);
 add('opposite', range(30, 125), range(18, 25), () => opposite + width * (1 - oppositeLane), 1);
 if (random() < .6) add('opposite-2', range(146, 244), range(16, 24), () => opposite + width * (1 - (oppositeLane + 1) % 3), 1);

 return {
  cars, front, frontMerge, frontMergedAt, right, enter, reachMiddle, leaveMiddle, reachLeft,
  cutInCandidate: rightMerge ? right : closeLead ? front : undefined,
  passing: cars.find(car => car.id === 'passing'),
 };
}

// The rendered taper starts at the outside edge and narrows to the open lane.
export const workZoneEdge = (station, width) => lerp(1.5 * width - .32, .5 * width - 3.38,
 clamp((station - ROADWORKS_CONE_START) / (ROADWORKS_CONE_SPACING * ROADWORKS_TAPER_INTERVALS), 0, 1));

// A cone closes a lane as soon as it reaches the car's lateral envelope.
function closureLimit(lane,width) {
 const edge=1.5*width-.32, end=.5*width-3.38;
 const progress=clamp((edge-lane*width-1.35)/(edge-end),0,1);
 return ROADWORKS_CONE_START+progress*ROADWORKS_CONE_SPACING*ROADWORKS_TAPER_INTERVALS-7;
}

export function planLiveWorkZone(fleet, width, offset, duration, egoSpeed, egoAt, styles) {
 const same = fleet.filter(car => car.direction < 0);
 // Place a newly enabled closure clear of vehicles already inside its footprint.
 for (const car of [...same].sort((a,b) => b.station - a.station)) {
  if (car.x < -width/2 || car.station > ROADWORKS_CLEARED_DISTANCE + offset + 9) continue;
  const laneEnd=closureLimit(Math.round(car.x/width),width);
  offset=Math.max(offset,car.station+car.speed**2/6+5-laneEnd);
 }
 const cars = fleet.map((car, idx) => {
  const assertiveness = styles ? styles[idx] : .5;
  const yieldToEgo = assertiveness < .5;
  return {
   ...car, frames:[], lane:Math.round(car.x / width), transition:null, pace:car.speed,
   assertiveness,
   yieldToEgo,
   mergeLookahead: 125 + (assertiveness - .5) * 40,
   baseMergeSeconds: 2.6 - (assertiveness - .5) * .5,
   frontEgoMargin: yieldToEgo ? 11 : 15 - (assertiveness - .5) * 10,
   yieldMargin: 44 - assertiveness * 20,
  };
 });
 const taperStart = ROADWORKS_CONE_START + offset;
 for (let tick = 0; tick <= Math.ceil((duration+5) / step); tick++) {
  const t=tick*step;
  const ego=egoAt?.(Math.min(t,duration));
  for (const car of cars) {
   if (car.transition && t >= car.transition.end) {
    car.lane--;
    car.transition=null;
   }
   const m=car.transition;
   if(m)car.x=lerp(m.x,(car.lane-1)*width,smootherstep(t,m.start,m.end));
   car.frames.push({x:car.x, speed:car.speed, station:car.station});
  }
  const next=cars.map(car => {
   if(car.direction>0)return car.speed;
   const closed=car.lane>=0&&car.station<taperStart+ROADWORKS_CLEARED_DISTANCE-ROADWORKS_CONE_START+8;
   if (closed && !car.transition && car.station > taperStart-car.mergeLookahead) {
    const lane=(car.lane-1)*width;
    const enteringOpen=car.lane===0;
    const speedFactor=clamp(car.speed/10,0,1);
    const seconds=lerp(4.2,car.baseMergeSeconds,speedFactor),end=t+seconds;
    const mergeCruise=Math.min(car.pace,workSpeed);
    const accel=car.speed<mergeCruise?(enteringOpen?2.0:1.5):0;
    const speedAtDt=dt=>Math.min(mergeCruise,car.speed+accel*dt);
    const stationAtDt=dt=>{
     if(accel<=0)return car.station+car.speed*dt;
     const tCap=(mergeCruise-car.speed)/accel;
     if(dt<=tCap)return car.station+car.speed*dt+.5*accel*dt*dt;
     return car.station+car.speed*tCap+.5*accel*tCap*tCap+mergeCruise*(dt-tCap);
    };
    const canMoveForward=car.speed>=.5||enteringOpen||closureLimit(0,width)+offset-car.station>8;
    const clearsTaper=canMoveForward&&Array.from({length:25},(_,i)=>seconds*i/24).every(dt=>{
     const x=lerp(car.x,lane,smootherstep(dt,0,seconds));
     const station=stationAtDt(dt);
     return x+1.35<workZoneEdge(station+2.45-offset,width);
    })&&(enteringOpen||stationAtDt(seconds)<closureLimit(0,width)+offset-1);
    const open=clearsTaper&&cars.every(other=>{
     if(other===car||other.direction>0)return true;
     const otherInLane=Math.abs(other.x-lane)<=2.0||(other.transition&&Math.abs((other.lane-1)*width-lane)<=2.0);
     if(!otherInLane)return true;
     return [0,.25,.5,.75,1].every(u=>{
      const dt=seconds*u;
      const gap=other.station+other.speed*dt-stationAtDt(dt);
      const closing=gap<0?Math.max(0,other.speed-speedAtDt(dt)):Math.max(0,speedAtDt(dt)-other.speed);
      return Math.abs(gap)>8+Math.max(other.speed,speedAtDt(dt))*.55+closing*.6;
     });
    });
    let egoClear=(!ego&&car.lane===0)||!Number.isFinite(egoSpeed);
    if(open&&!egoClear){
     const egoDistNow=ego?.distance??Math.min(t*egoSpeed,taperStart+10);
     const egoSpdNow=ego?.speed??egoSpeed;
     const gapFromEgo=car.station-egoDistNow;
     const samples=Array.from({length:13},(_,i)=>{
      const dt=seconds*i/12;
      const e=egoAt?.(Math.min(t+dt,duration));
      const ex=e?e.x:0, ed=e?e.distance:Math.min((t+dt)*egoSpeed,taperStart+10+egoSpeed*dt), es=e?e.speed:egoSpdNow;
      return {dt, ex, ed, es, cx:lerp(car.x,lane,smootherstep(dt,0,seconds)), cd:stationAtDt(dt), cs:speedAtDt(dt)};
     });
     const egoUsesPath=samples.some(s=>Math.abs(s.ex-lane)<2.35||Math.abs(s.ex-s.cx)<2.35);
     if(!egoUsesPath){
      egoClear=true;
     }else if(gapFromEgo>0){
      // Ahead of ego: randomly split between assertive drivers who merge ahead
      // of ego when physically safe, and yielding drivers who hold until ego
      // passes (unless ego has already stopped behind them, preventing deadlock).
      const trappedAheadOfEgo=car.lane===0&&Math.abs((ego?.x??0)-car.x)<1.5&&car.station>taperStart-45;
      const canYieldToEgo=car.yieldToEgo&&!trappedAheadOfEgo&&egoSpdNow>=6&&(car.lane>0||(ego?.x??0)<-.5||egoSpdNow>car.speed+1.5);
      if(canYieldToEgo&&gapFromEgo<car.yieldMargin){
       egoClear=false;
      }else{
       const deadlocked=egoSpdNow<6;
       const effectiveFrontMargin=deadlocked?5.5:Math.min(car.frontEgoMargin,Math.max(8.5,car.frontEgoMargin*clamp((egoSpdNow-car.speed+6)/10,.4,1)));
       const leadBuffer=deadlocked?5.5:8.5;
       egoClear=gapFromEgo>=effectiveFrontMargin&&samples.every(s=>
        Math.abs(s.ex-s.cx)>2.35&&Math.abs(s.ex-lane)>2.35||
        s.cd-s.ed>=leadBuffer+Math.max(0,s.es-s.cs)*(deadlocked?.35:.55));
      }
     }else{
      // Behind ego: once ego passes, smoothly pull out behind ego without
      // clipping ego's rear corner while still overlapping laterally.
      const requiredPass=9.5+Math.max(0,car.speed-egoSpdNow)*1.1;
      egoClear=-gapFromEgo>=requiredPass&&samples.every(s=>
       Math.abs(s.ex-s.cx)>2.35||(s.ed-s.cd>=8.5+Math.max(0,s.cs-s.es)*.65))&&
       samples.every(s=>Math.abs(s.ex-lane)>2.35||(s.ed-s.cd>=8.5+Math.max(0,s.cs-s.es)*.65));
     }
    }
    if(open&&egoClear){
     car.transition={x:car.x,start:t,end};
    }
   }
   const m=car.transition;
   const targetClosed=closed&&(!m||car.lane===1);
   let target=closed?Math.min(car.pace,workSpeed):car.pace;
   if(targetClosed){
    // Brake toward the physical cone boundary for the car's current lateral position.
    const effectiveLane=m?clamp(car.x/width,0,1):car.lane;
    const limit=closureLimit(effectiveLane,width)+offset;
    target=Math.min(target,Math.sqrt(2*2.9*Math.max(0,limit-car.station)));
   }
   if(ego&&ego.distance>car.station&&
    Math.min(Math.abs(car.x-ego.x),m?Math.abs((car.lane-1)*width-ego.x):99)<2.35){
    target=Math.min(target,ego.speed+(ego.distance-car.station-10-car.speed*.8)/1.2);
   }
   for(const other of cars){
    if(other===car||other.direction>0||other.station<=car.station)continue;
    if(Math.abs(car.x-other.x)>2.2&&(!m||Math.abs((car.lane-1)*width-other.x)>1.9))continue;
    const gap=other.station-car.station;
    // Leave enough distance for the leader to brake behind a stationary queue.
    target=Math.min(target,other.speed+(gap-7-car.speed*1.25)/1.3,
     Math.sqrt(other.speed**2+6*Math.max(0,gap-7)));
   }
   const maxAccel=m&&car.lane===0&&car.speed<workSpeed?2.1:1.5;
   return Math.max(0,car.speed+clamp(target-car.speed,-5*step,maxAccel*step));
  });
  cars.forEach((car,i)=>{
   car.station+=car.direction*(car.speed+next[i])*(-.5*step);
   car.speed=next[i];
  });
 }
 const sample=(car,time,key)=>{
  const u=clamp(time/step,0,car.frames.length-1),i=Math.floor(u);
  return lerp(car.frames[i][key],(car.frames[i+1]??car.frames[i])[key],u-i);
 };
 return {offset, cars:cars.map(car=>({id:car.id,direction:car.direction,
  speedAt:t=>sample(car,t,'speed'),distanceAt:t=>sample(car,t,'station'),xAt:t=>sample(car,t,'x')}))};
}

export function coordinateWorkZone(random, carried, settings) {
 const {duration,width,offset,initial}=settings;
 // Sample each driver's assertiveness once so every coordination pass uses
 // consistent per-car behaviour even if the caller's RNG does not rewind.
 const styles=carried.map(()=>random?random():.5);
 const build=(ego,holdLane=false)=>{
  const horizon=roadworksHorizon(duration,offset,settings.extendUntilClear);
  const {cars}=planLiveWorkZone(carried,width,offset,horizon,initial.speed,ego?.sample,styles);
  random.reset();
  return planRoadworksTraffic(random,{...settings,liveFleet:cars,holdLane});
 };
 const first=build();
 const next=build(first);
 const valid=run=>{
  for(let t=step;t<=(run.timing?.endAt??duration);t+=step){
   const f=run.sample(t);
   const ego={x:f.x,z:0,yaw:f.yaw,length:4.9,width:2.1};
   if(f.traffic.some(c=>c.direction<0 && Math.abs(c.z)<7 &&
    (overlaps(ego,{...c,length:4.9,width:2.1},.25) || Math.abs(c.x-f.x)<2.15 && Math.abs(c.z)<5)))return false;
  }
  return true;
 };
 if(valid(next))return next;
 const corrected=build(next);
 if(valid(corrected))return corrected;
 const stopped=build(null,true);
 return build(stopped,true);
}

export function planRoadworksTraffic(random, {duration, width, clearedDistance, offset = 0, initial, liveFleet, holdLane = false, trafficEnabled = true, adaptiveTraffic = false, extendUntilClear = false}) {
 const fleet = trafficEnabled ? liveFleet ? {cars:liveFleet} : approachingCars(random, width, adaptiveTraffic, extendUntilClear) : {cars: []};
 const start = initial?.time ?? 0;
 const entryX = initial?.entryX ?? 0;
 const stopDistance = Math.min(holdDistance, closureLimit(Math.round(entryX / width), width) - 3) + offset;
 const horizon = roadworksHorizon(duration,offset,extendUntilClear);
 let cars = fleet.cars;
 let simulation = simulate();
 if (initial && trafficEnabled && !liveFleet) {
  // A mid-run reveal may place a car in a gap ego has already occupied.
  // Keep the seed and omit only actors that cannot safely join this route.
  while (true) {
   const safe = cars.filter(car => car.direction > 0 || simulation.frames.every(({distance}, index) => {
    const time = start + index * step;
    return Math.abs(car.distanceAt(time) - distance) > longitudinalClearance
     || Math.abs(car.xAt(time) - simulation.xAt(distance)) > lateralClearance;
   }));
   if (safe.length === cars.length) break;
   cars = safe;
   simulation = simulate();
  }
 }

 function simulate() {
  const {enter, reachLeft, frontMergedAt} = fleet;
  const front = adaptiveTraffic && cars.includes(fleet.front) ? fleet.front : null;
  const right = cars.includes(fleet.right) ? fleet.right : null;
  const passing = cars.includes(fleet.passing) ? fleet.passing : null;
  const frames = [];
  let {distance = 0, speed = cruise, acceleration = 0, merge = null} = initial ?? {};
  // Re-entering the event from the open lane needs no new merge gap.
  if (!merge && Math.abs(entryX + width) < .01) merge = {time:start, distance, length:0};
  let followingMerge = false;
  let steerDistance = merge?.length ?? ROADWORKS_MERGE_DISTANCE;
  let cutInCar, waitAt=initial?.waitAt??Infinity, signalAt=initial?.signalAt??merge?.time??Infinity;
  let checkingLeftAt=initial?.checkingLeftAt??Infinity;
  // Reserve the target lane over the lane change, including a faster car that
  // would catch ego from behind partway through the manoeuvre.
  function leftGapBlocker(time, candidate) {
   const mergeSeconds = steerDistance / Math.max(10, speed);
   for (const car of candidate ? [candidate] : cars) {
    if (car.direction > 0) continue;
    for (let offset = mergeSeconds * .35; offset <= mergeSeconds + (liveFleet?2:.15); offset += .15) {
     if (car.xAt(time + offset) > -width / 2) continue;
     const gap = car.distanceAt(time + offset) - (distance + speed * offset);
     const required = 6 + (gap >= 0 ? speed : car.speedAt(time + offset)) * (liveFleet?1.05:.66);
     if (Math.abs(gap) < required) return car;
    }
   }
  }
  for (let index = 0; index <= Math.ceil((horizon - start) / step); index++) {
   const time = start + index * step;
   const rightGap = right ? right.distanceAt(time) - distance : Infinity;
   const frontGap = front ? front.distanceAt(time) - distance : Infinity;
   const frontFollowingGap = 6 + speed * 1.05;
   const yieldingToFront = frontGap > 0 && frontGap < frontFollowingGap && time < frontMergedAt;
   if (time + .9 >= enter && time < reachLeft && rightGap > 0 && rightGap < 6 + speed * 1.22) followingMerge = true;
   const yieldingToRight = followingMerge && time < reachLeft;
   const mergeDecision = (trafficEnabled && !adaptiveTraffic ? 49 : 52) + offset;
   if (!holdLane && !merge && distance >= mergeDecision - speed * .4) signalAt = Math.min(signalAt,time);
   const checkingLeft = !holdLane && !merge && distance >= mergeDecision;
   if (checkingLeft) checkingLeftAt = Math.min(checkingLeftAt,time);
   const passingTooClose = passing && passing.distanceAt(time) - distance < 13;
   const leftBlocker = !merge && distance >= 33 + offset && (passingTooClose ? passing : leftGapBlocker(time));
   const leftHolding = checkingLeft && leftBlocker && !yieldingToFront && !yieldingToRight &&
    (!adaptiveTraffic || time >= checkingLeftAt + gapConfirmationSeconds &&
     (!passingTooClose || leftGapBlocker(time, passing)));
   if (checkingLeft && !yieldingToFront && !yieldingToRight && !leftBlocker) {
    steerDistance=extendUntilClear||liveFleet?clamp(2*(closureLimit(0,width)+offset-distance),18,ROADWORKS_MERGE_DISTANCE):ROADWORKS_MERGE_DISTANCE;
    if (liveFleet) {
     // A queue in the closing lane can stop ego before a long lane change
     // clears it. Clear that lane with room behind the stationary leader.
     for (const car of cars) {
      if (car.direction > 0 || Math.abs(car.xAt(time + 2.6) - entryX) > 1.25 || car.speedAt(time + 2.6) > 1) continue;
      const gap = car.distanceAt(time + 2.6) - distance;
      if (gap > 0) steerDistance = Math.min(steerDistance, Math.max(18, (gap - 10) / .65));
     }
    }
    merge={time,distance,...(steerDistance!==ROADWORKS_MERGE_DISTANCE&&{length:steerDistance})};
   }
   if (right && adaptiveTraffic && right === fleet.cutInCandidate && yieldingToRight) cutInCar = right;
   if (front && front === fleet.cutInCandidate && (yieldingToFront || (leftBlocker === front && time < frontMergedAt))) cutInCar = front;

   const freeFlow = adaptiveTraffic ? sampleRoadworksSpeed(time, offset, distance >= clearedDistance) : null;
   const workLimit = freeFlow?.speed ?? (distance < clearedDistance
    ? lerp(cruise, workSpeed, smootherstep(time, 1.4 + offset / cruise, 5.4 + offset / cruise)) : cruise);
   let target = workLimit, limitingCar;
   function applySpeedLimit(limit, car) {
    if (limit >= target) return;
    target = limit;
    limitingCar = car;
   }
   // Track the merging vehicle before it crosses the divider. Once it has
   // cleared the lane, the left-gap check still accounts for it as a leader.
   if (right && time + .9 >= enter && time < reachLeft && rightGap > 0) {
    applySpeedLimit(right.speedAt(time) + (rightGap - (6 + speed * 1.05)) / 1.25, right);
   }
   if (front && frontGap > 0 && time < frontMergedAt) {
    applySpeedLimit(front.speedAt(time) + (frontGap - frontFollowingGap) / 1.25, front);
   }
   if (((initial || adaptiveTraffic) && merge || liveFleet) && cars.length) {
    const lane = merge ? lerp(entryX, -width, smootherstep(distance + speed * .75, merge.distance, merge.distance + steerDistance)) : entryX;
    for (const car of cars) {
     const gap = car.distanceAt(time) - distance;
     if (car.direction < 0 && gap > 0 && (Math.abs(car.xAt(time + (liveFleet ? 1.6 : .75)) - lane) < (liveFleet?2.7:2.25) ||
       liveFleet&&Math.abs(car.xAt(time)-lane)<2.7)) {
      const pace=car.speedAt(time);
      // A car can clear the lane well before ego reaches it. Check the
      // longitudinal encounter against both actual lateral trajectories,
      // rather than treating either endpoint of a wide lane mask as occupied.
      const closing=Math.max(0,speed-pace);
      let encounter=!liveFleet;
      if(liveFleet)encounter=sweptEncounter(dt=>{
       const station=distance+speed*dt;
       const egoX=merge?lerp(entryX,-width,smootherstep(station,merge.distance,merge.distance+steerDistance)):entryX;
       return {x:car.xAt(time+dt)-egoX,z:car.distanceAt(time+dt)-station};
      },Math.max(2.5,closing/3.6+1),closing);
      if(encounter)applySpeedLimit(liveFleet?Math.min(pace+(gap-10-speed*1.35)/1.5,
       Math.sqrt(pace*pace+5*Math.max(0,gap-7))):pace+(gap-6-speed*.85)/1.5,car);
     }
    }
   }
   if (!merge && checkingLeft && (leftHolding || yieldingToRight || yieldingToFront)) waitAt=Math.min(waitAt,time);
   if (leftBlocker) applySpeedLimit(13.2, leftHolding ? leftBlocker : undefined);
   const needsStop = distance + speed * speed / 5.6 + speed * .9 >= stopDistance;
   if (!merge && (distance >= 78 + offset || extendUntilClear && (holdLane || checkingLeft || needsStop))) {
    // If a gap stays closed, stop upstream with space left to steer around
    // the end of the taper when the lane opens.
    applySpeedLimit(Math.sqrt(2 * 2.8 * Math.max(0, stopDistance - distance)));
   }
   const constraints = new Set();
   const egoClosing = car => car && (speed > car.speedAt(time) + FEEDBACK_SPEED_DEADBAND || car.distanceAt(time) - distance < 10);
   const rightEntering = right && time >= enter && right.xAt(time) < width - .15;
   if (checkingLeft) {
    if (yieldingToFront && egoClosing(front)) constraints.add(front.id);
    if (yieldingToRight && rightEntering && egoClosing(right)) constraints.add(right.id);
    if (leftHolding) constraints.add(leftBlocker.id);
   }
   // A stable lead may cap cruise speed without asking ego to slow further.
   // Never mark an adjacent outer-lane car before it starts moving toward ego's lane,
   // or a faster leader whose gap is already opening comfortably.
   const validLimitCar = limitingCar && !(limitingCar === right && !rightEntering);
   if (validLimitCar && target < Math.min(speed, workLimit) - FEEDBACK_SPEED_DEADBAND) constraints.add(limitingCar.id);
   frames.push({distance, speed, acceleration,constraints:[...constraints]});
   const feedforward = freeFlow && target === workLimit ? freeFlow.acceleration : 0;
   const requested = clamp((Math.max(0, target) - speed) / .6 + feedforward, -3.6, 1.7);
   acceleration += clamp(requested - acceleration, -4.2 * step, 4.2 * step);
   const nextSpeed = Math.max(0, speed + acceleration * step);
   distance += (speed + nextSpeed) * .5 * step;
   speed = nextSpeed;
  }

  const mergeEnd = merge ? merge.distance + steerDistance : Infinity;
  const xAt = merge ? laneChange(entryX, -width, merge.distance, mergeEnd) : () => entryX;
  return {frames, xAt, merge, mergeEnd, cutInCar, waitAt, signalAt, checkingLeftAt};
 }

 const {frames, xAt, merge, mergeEnd, cutInCar, waitAt, signalAt, checkingLeftAt} = simulation;
 const entersCurrentLane = cutInCar?.id === 'right';
 let cutInTiming;
 if (cutInCar) {
  const changeStart = entersCurrentLane ? fleet.enter : fleet.frontMerge;
  const end = entersCurrentLane ? fleet.reachMiddle : fleet.frontMergedAt;
  const nearLineProgress = (CUT_IN_TIMING.nearLine - CUT_IN_TIMING.merge) / (CUT_IN_TIMING.inLane - CUT_IN_TIMING.merge);
  cutInTiming = {
   merge: changeStart, nearLine: lerp(changeStart, end, nearLineProgress),
   inLane: entersCurrentLane ? fleet.reachLeft : end,
  };
 }
 const normalMerge = adaptiveTraffic && merge?.distance <= 52 + offset + cruise * step;
 // Keep spatial context until both the lane change and the work zone are clear.
 const releaseDistance = Math.max(mergeEnd, clearedDistance);
 const firstAt = predicate => {
  const index = frames.findIndex(predicate);
  return index < 0 ? Infinity : start + index * step;
 };
 const passAt = merge ? initial?.passAt ?? firstAt(f => f.distance >= mergeEnd) : Infinity;
 const clearAt = initial?.cameraReturnAt <= start ? initial.cameraReturnAt : firstAt(f => f.distance >= releaseDistance);
 const workZoneRiseAt = firstAt(f => roadworksCameraInRange(f.distance, f.speed, offset));
 const stopAt = firstAt(f => f.distance >= Math.max(0, 52 + offset) && f.speed < .01);
 const endAt = extendUntilClear ? Math.round(100 * Math.min(horizon,
  Math.max(duration,start,Number.isFinite(clearAt) ? clearAt + cruiseTail : stopAt + 2))) / 100 : duration;
 const timing = {brakeAt:brakeStart+offset/cruise, signalAt, mergeAt:merge?.time??Infinity, passAt, clearAt, waitAt: merge ? waitAt : Math.min(waitAt,stopAt), endAt};
 const cameraReturnAt = clearAt;
 function cutInAt(time) {
  if (!cutInTiming) return {};
  const {lift, rearIndicator, corridorInfluence} = sampleCutInMotion(time, cutInTiming);
  return {lift,rearIndicator,corridorInfluence};
 }
 const sampleFleet = (time, distance, {lift, corridorInfluence, ...feedback}) => cars.map(car => ({
  id: car.id, direction: car.direction, speed: car.speedAt(time),
  x: car.xAt(time), z: distance - car.distanceAt(time),
  yaw: car.direction > 0 ? Math.PI : trafficHeading(car,time),
  ...(car === cutInCar && {
   ...feedback,
   // Once it starts leaving ego's lane, the normal lateral mask releases
   // the ribbon. A leader already in ego's lane keeps that mask throughout.
   ...(entersCurrentLane && time <= fleet.reachMiddle && {corridorInfluence}),
  }),
 }));
 const sampleRaw = time => {
  time = clamp(time, start, endAt);
  const index = (time - start) / step;
  const before = frames[Math.floor(index)], after = frames[Math.ceil(index)] ?? before;
  const ratio = index % 1;
  const distance = lerp(before.distance, after.distance, ratio);
  const acceleration = lerp(before.acceleration, after.acceleration, ratio);
  const x = xAt(distance);
  const cutIn = cutInAt(time);
  const reveal = merge ? (trafficEnabled && !normalMerge ? smootherstep(time, merge.time, merge.time + .48)
   : smootherstep(time, 1.9 + offset / cruise, 2.8 + offset / cruise)) : 0;
  return {
   distance, speed: lerp(before.speed, after.speed, ratio), x, yaw: drivingHeading(xAt, distance, 1, merge?.distance),
   brakeStrength: clamp(-acceleration / 2.2, 0, 1), acceleration,
   cameraReturnAt, signalAt:signalAt<=time?signalAt:undefined, checkingLeftAt:checkingLeftAt<=time?checkingLeftAt:undefined,
   passAt:passAt<=time?passAt:undefined, waitAt:timing.waitAt<=time?timing.waitAt:undefined, mergeEnd, merge: merge && time >= merge.time ? merge : null,
   pathX: z => lerp(x, xAt(distance - z), reveal),
   holdZ: distance - stopDistance, holdWeight: 1 - reveal,
   cutInLift: cutIn.lift ?? 0,
   traffic: sampleFleet(time, distance, cutIn).map(car=>({...car,constraining:before.constraints.includes(car.id)})),
  };
 };
 let feedback, cameraRiseAt = initial?.cameraRiseAt <= start ? initial.cameraRiseAt : null;
 function ensureFeedback() {
  if (feedback) return;
  feedback = createTrafficFeedback(time => {
   const row = sampleRaw(time);
   return {
    ego: {x: row.x, z: -row.distance, yaw: row.yaw || 0, speed: row.speed},
    traffic: row.traffic.map(car => ({...car, z: car.z - row.distance})),
   };
  }, {start, duration: endAt});
  if (cameraRiseAt === null) {
   let firstAlertAt = Infinity;
   const scanEnd = Math.min(endAt, clearAt);
   for (let t = start; t <= scanEnd + 1e-8; t += TRAFFIC_FEEDBACK.step) {
    const sampleTime = Math.min(endAt, t);
    const row = sampleRaw(sampleTime);
    if (row.traffic.some(car => {
     const cue = feedback(car.id, sampleTime);
     return cue.red > 0 || (car.constraining && cue.yellow > 0);
    })) {
     firstAlertAt = sampleTime;
     break;
    }
   }
   cameraRiseAt = Math.min(workZoneRiseAt, firstAlertAt);
  }
 }
 const run={
  timing,
  sampleTraffic(time,distance,warn=true){
   if(!warn)return sampleFleet(time,distance,{});
   const frame=run.sample(time);
   return frame.traffic.map(car=>({...car,z:car.z+distance-frame.distance}));
  },
  sample(time){
   ensureFeedback();
   const row = sampleRaw(time);
   return {
    ...row,
    cameraRiseAt,
    traffic: row.traffic.map(({cutInColor,cutInTint,...car}) => {
     const cue = feedback(car.id, time);
     const current = !car.constraining && cue.yellow > 0 ? {...cue, level: cue.red > 0 ? 2 : 0, yellow: 0} : cue;
     return {...car, ...feedbackFields(current)};
    }),
   };
  },
 };
 return run;
}
