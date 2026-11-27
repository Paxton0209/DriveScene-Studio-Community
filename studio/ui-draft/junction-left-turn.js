import {createTrafficFeedback, feedbackOverlap, TRAFFIC_FEEDBACK} from './traffic-feedback.js';
import {carryJunctionTraffic} from './junction-traffic.js';
import {DRIVING_EVENT_SECONDS} from './interaction-duration.js';
import {OPEN_ROAD_CRUISE} from './junction-playback.js';
import {bodyPose,parkingVehicle,setupArc} from './parking-kinematics.js';
// Shared clock for the Junction replay, the timeline captions, and frame export.
export const JUNCTION_LEFT_TURN = 'leftturn';
const stopAt=3.5, signalPeriod=.8, turnAt=stopAt+5*signalPeriod;
const launchSeconds=1.85, exitCheckSeconds=1.1;
const exitAccelerationSeconds=4.9;
export const JUNCTION_EXIT_CRUISE = OPEN_ROAD_CRUISE;
export const JUNCTION_TURN_SPEED = 20.5/3.6;
const replayDuration = accelerateAt => Number.isFinite(accelerateAt)
 ? Math.max(DRIVING_EVENT_SECONDS,Math.ceil(accelerateAt+exitAccelerationSeconds+1))
 : DRIVING_EVENT_SECONDS;
const lane = 1.85, exitZ = -40 - lane, curveStartZ = -32.9, clearX = -14.5;
const defaultAxles=parkingVehicle();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// The front axle and the guidance ribbon share one curve with no inflection.
const taper=.36, quarterTurn=Math.PI/2;
const unitArc=setupArc(quarterTurn,1,taper);
const curve=setupArc(quarterTurn,(exitZ-curveStartZ)/unitArc.end.z,taper);
const curveEndX=lane+curve.end.x;
const frontOnCurve=f=>{
 const {x,z,yaw}=curve.sample(f);
 return {x:lane+x,z:curveStartZ+z,yaw};
};
const yawSteps=256, yawTables=new Map();
function chassisYaw(distance,wheelbase) {
 let yawTable=yawTables.get(wheelbase);
 if(!yawTable){
  // Advancing the front axle turns the chassis while the rear tires roll straight.
  const step=curve.length/yawSteps;
  yawTable=[0];
  let yaw=0;
  for(let i=0;i<yawSteps;i++){
   const rate=Math.sin(curve.sample(i/yawSteps).yaw-yaw)/wheelbase;
   yaw+=step*Math.sin(curve.sample((i+.5)/yawSteps).yaw-yaw-rate*step/2)/wheelbase;
   yawTable.push(yaw);
  }
  yawTables.set(wheelbase,yawTable);
 }
 if(distance>=curve.length){
  const delta=quarterTurn-yawTable[yawSteps];
  return quarterTurn-2*Math.atan(Math.tan(delta/2)*Math.exp((curve.length-distance)/wheelbase));
 }
 const index=distance/curve.length*yawSteps,i=Math.floor(index);
 return yawTable[i]+(yawTable[i+1]-yawTable[i])*(index-i);
}
function turnPose(distance,stopZ,{rearOffset,wheelbase}){
 const frontOffset=rearOffset-wheelbase;
 const s=distance-(stopZ+frontOffset-curveStartZ);
 if(s<=0)return {x:lane,z:stopZ-distance,yaw:0,steer:0,frontX:lane,frontZ:stopZ+frontOffset-distance};
 const front=s<curve.length?frontOnCurve(s/curve.length):{x:curveEndX-(s-curve.length),z:exitZ,yaw:quarterTurn};
 const yaw=chassisYaw(s,wheelbase);
 return {...bodyPose(front,yaw,frontOffset),steer:front.yaw-yaw,frontX:front.x,frontZ:front.z};
}
function turnProfile(stopZ,axles=defaultAxles) {
 const frontOffset=axles.rearOffset-axles.wheelbase;
 const lead=stopZ+frontOffset-curveStartZ;
 // Start adding speed as curvature falls, while the front wheels are unwinding.
 const unwindDistance=lead+curve.length*.85;
 const ramp=Math.min(launchSeconds,unwindDistance/JUNCTION_TURN_SPEED);
 const accelerateAt=unwindDistance/JUNCTION_TURN_SPEED+ramp/2;
 const profile={ramp,accelerateAt};
 let lower=accelerateAt,upper=(lead+curve.length+curveEndX-clearX-frontOffset)/JUNCTION_TURN_SPEED+ramp/2;
 // Locate the physical clearance point on the combined speed profile.
 for(let i=0;i<32;i++){
  const elapsed=(lower+upper)/2;
  if(turnPose(turnPace(elapsed,profile).distance,stopZ,axles).x>clearX)lower=elapsed;
  else upper=elapsed;
 }
 return {...profile,crossing:(lower+upper)/2};
}
const reference=turnProfile(-19.6);
export const JUNCTION_LEFT_TIMING = Object.freeze({
 signalAt:stopAt, yieldAt:2.15, stopAt, turnAt,
 clearAt:turnAt+reference.crossing,duration:replayDuration(turnAt+reference.accelerateAt),
});
export function junctionLeftPath() {
 const points=Array.from({length:96},(_,i)=>{
  const front=frontOnCurve(i/96);
  return [front.x,front.z];
 });
 return [[lane,60], ...points, [curveEndX,exitZ], [-350,exitZ]];
}
function accelerate(elapsed, ramp, cruise) {
 const u=clamp(elapsed/ramp,0,1);
 return {
  speed:cruise*u*u*(3-2*u),
  distance:cruise*(ramp*(u**3-.5*u**4)+Math.max(0,elapsed-ramp)),
 };
}
function turnPace(elapsed,{ramp,accelerateAt}){
 const turn=accelerate(elapsed,ramp,JUNCTION_TURN_SPEED);
 const exit=accelerate(Math.max(0,elapsed-accelerateAt),exitAccelerationSeconds,JUNCTION_EXIT_CRUISE-JUNCTION_TURN_SPEED);
 return {speed:turn.speed+exit.speed,distance:turn.distance+exit.distance};
}
function sampleTurn(seconds, stopZ, {signalAt, turnAt, clearAt, duration}, profile, axles=defaultAxles) {
 const t=clamp(seconds,0,duration), elapsed=Math.max(0,t-turnAt);
 const {speed,distance}=turnPace(elapsed,profile);
 const signal=t>=signalAt&&t<clearAt, phase=(t-signalAt)%signalPeriod, reveal=clamp(elapsed/1.15,0,1);
 const lamp=signal?clamp(phase/.035,0,1)*clamp((signalPeriod/2-phase)/.035,0,1):0;
 return {...turnPose(distance,stopZ,axles),length:axles.length,width:axles.width,speed,distance,signal,lamp,pathRelease:reveal*reveal*(3-2*reveal)};
}

function moveJunctionCar(car,time) {
 return car.axis==='x'
  ? {...car,x:car.x+time*car.speed*car.direction}
  : {...car,z:car.z+time*car.speed*car.direction};
}
export function createJunctionStream(random) {
 const stream=[];
 const draw=(min,max)=>min+(max-min)*random();
 const cross=random()<.5,lane=Math.floor(random()*3);
 const dense=random()<.36,count=dense?4+Math.floor(random()*3):1+Math.floor(random()*2);
 let arrival=draw(2.2,6.1);
 for(let i=0;i<count;i++){
  const speed=draw(10.5,14),direction=cross&&lane%2===0?-1:1;
  stream.push({id:'junction-flow-'+i,axis:cross?'x':'z',x:cross?-direction*speed*arrival:-1.85-3.7*lane,
   z:cross?(direction<0?-45.55:-34.45):-40-speed*arrival,
   yaw:cross?-direction*Math.PI/2:Math.PI,direction,speed});
  arrival+=dense?draw(1.9,2.7):draw(5.3,7.2);
 }
 // Keep sparse Junction runs populated with ~3 vehicles by adding early-passing
 // ambient cross/oncoming traffic that clears before ego's turn window.
 if(stream.length<3){
  const s1=draw(11,13.5), a1=draw(1.6,2.4);
  stream.push({id:'junction-ambient-0',axis:'x',x:-s1*a1,z:-38.15,yaw:-Math.PI/2,direction:1,speed:s1});
 }
 if(stream.length<3){
  const s2=draw(11,13.5), a2=draw(1.1,1.9), altLane=(lane+1)%3;
  stream.push({id:'junction-ambient-1',axis:'z',x:-1.85-3.7*altLane,z:-40-s2*a2,yaw:Math.PI,direction:1,speed:s2});
 }
 return {
  cars:stream,
  sample:time=>stream.map(car=>moveJunctionCar(car,time)),
 };
}

export function createTrafficAfterJunctionCommit(random, time, ego, clearAt, markingEnd) {
 const stream = createJunctionStream(random);
 const turning = time < clearAt;
 const approachX = stream.cars[0].axis === 'z' && stream.cars[0].x === -1.85 ? -5.55 : -1.85;
 // Keep one approach in view as the camera rotates from north to west.
 const approach = {
  id: 'junction-near-approach', x: approachX, z: -66 - random() * 6,
  speed: 9 + random() * 2, direction: 1, yaw: Math.PI,
 };
 const exit = {
  id: 'junction-opposing-exit', axis: 'x', x: turning ? -24 - random() * 6 : ego.x - 28 - random() * 6, z: -38.15,
  speed: 10 + random() * 2, direction: 1, yaw: -Math.PI / 2,
 };
 const streamStart = Math.max(time, clearAt);
 return seconds => {
  if (seconds < time) return [];
  const elapsed = seconds - time;
  const others = stream.sample(seconds - streamStart);
  if (!turning) return [moveJunctionCar(exit, elapsed), ...others];
  return [carryJunctionTraffic(approach, elapsed, Infinity, markingEnd),
   carryJunctionTraffic(exit, elapsed, clearAt - time, markingEnd), ...others];
 };
}
// Retain the current traffic when present. A standalone demonstration draws
// its own stream before ego searches for an opening.
export function planJunctionTurn(random, stopZ, live, markingEnd, departAfter=0, axles=defaultAxles) {
 const stream=live?null:createJunctionStream(random);
 const traffic=time=>live?live.cars.map(car=>{
  const elapsed=time-live.time;
  return car.axis==='x'||elapsed<0?moveJunctionCar(car,elapsed):carryJunctionTraffic(car,elapsed,Infinity,markingEnd);
 }):stream.sample(time-departAfter);
 const profile=turnProfile(stopZ,axles),{crossing,accelerateAt}=profile;
 const throughClearance=Math.abs(clearX)+JUNCTION_EXIT_CRUISE*exitCheckSeconds+12;
 const clearsAt=(car,start=0)=>{
  const station=car.axis==='x'?car.x*car.direction:car.z+40;
  return car.speed>0?start+(throughClearance-station)/car.speed:0;
 };
 const latest=Math.max(DRIVING_EVENT_SECONDS-crossing-1,...(stream?.cars.map(car=>clearsAt(car,departAfter))??[]),
  ...(live?.cars.filter(car=>car.axis==='x').map(car=>clearsAt(car,live.time))??[]));
 const trial={...JUNCTION_LEFT_TIMING,turnAt:0,clearAt:crossing};
 const sampleStep=.05;
 const path=Array.from({length:1+Math.ceil((crossing+exitCheckSeconds)/sampleStep)},(_,i)=>sampleTurn(i*sampleStep,stopZ,trial,profile,axles));
 // Leave clearance for the supported vehicles when switching models mid-turn.
 const sweep=path.map(ego=>({...ego,length:Math.max(ego.length||0,5.5),width:Math.max(ego.width||0,2.6)}));
 const earliest=Math.max(JUNCTION_LEFT_TIMING.turnAt,departAfter);
 const blockingCars=[],searchTraffic=[];
 let turnAt=Infinity;
 for(let i=0;i<=Math.max(0,Math.ceil((latest-earliest)/sampleStep));i++){
  const t=earliest+i*sampleStep;
  const blockers=new Set(),nearConflicts=new Set();
  for(const [j,ego] of path.entries()){
   const cars=searchTraffic[i+j]??=traffic(earliest+(i+j)*sampleStep)
    .map(car=>({car,envelope:{...car,length:6.2,width:2.7}}));
   for(const {car,envelope} of cars){
    // The wider envelope protects the simulated maneuver between samples.
    if(!feedbackOverlap(sweep[j],envelope))continue;
    blockers.add(car.id);
    if(j*sampleStep<=TRAFFIC_FEEDBACK.horizon&&!nearConflicts.has(car.id)&&feedbackOverlap(ego,car,0))nearConflicts.add(car.id);
   }
   if(blockers.size>1&&(nearConflicts.size>0||j*sampleStep>TRAFFIC_FEEDBACK.horizon))break;
  }
  if(!blockers.size){
   turnAt=t;
   break;
  }
  // Mark the first imminent near-conflict car delaying departure (including
  // multi-car platoons so ego never waits in front of all-grey blockers).
  const blocker=blockers.size===1?blockers.values().next().value:nearConflicts.values().next().value;
  blockingCars.push(blocker&&nearConflicts.has(blocker)?blocker:null);
 }
 const clear=turnAt+crossing;
 const timing={...JUNCTION_LEFT_TIMING,turnAt,clearAt:clear,duration:replayDuration(turnAt+accelerateAt)};
 return {timing,sample:(time,frameAxles=axles)=>{
  const ego=sampleTurn(time,stopZ,timing,profile,frameAxles);
  const index=Math.floor((time-earliest)/sampleStep+1e-8);
  const blocker=time<turnAt?blockingCars[index]:null;
  return {...ego,traffic:traffic(time).map(car=>({...car,constraining:car.id===blocker}))};
 }};
}

export function sampleJunctionLeftTurn(seconds,stopZ){
 const profile=turnProfile(stopZ),duration=replayDuration(turnAt+profile.accelerateAt);
 const t=clamp(seconds,0,duration);
 const oncoming=[[-76,11.8],[-213,10]].map(([start,speed],i)=>({
  id:'junction-oncoming-'+(i+1),x:-5.55,z:start+speed*t,yaw:Math.PI,speed,direction:1,
 }));
 return {...sampleTurn(t,stopZ,{...JUNCTION_LEFT_TIMING,clearAt:turnAt+profile.crossing,duration},profile),oncoming};
}

const feedbackRuns=new Map();
export function junctionTrafficFeedback(stopZ){
 if(!feedbackRuns.has(stopZ)){
  if(feedbackRuns.size>8)feedbackRuns.clear();
  feedbackRuns.set(stopZ,createTrafficFeedback(time=>{
   const f=sampleJunctionLeftTurn(time,stopZ);
   return {ego:f,traffic:f.oncoming};
  },{duration:JUNCTION_LEFT_TIMING.duration}));
 }
 return feedbackRuns.get(stopZ);
}
