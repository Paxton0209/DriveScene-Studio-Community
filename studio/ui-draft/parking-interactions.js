import {createTrafficFeedback,feedbackOverlap,TRAFFIC_FEEDBACK} from './traffic-feedback.js';
import {parkingVehicle,bodyPose,overlaps} from './parking-kinematics.js';
import {parkingPlan,parkingPose,parkingSegment,parkingTiming,localBay,worldPose} from './parking-motion.js';
import {parkingTravel,parkingLegDuration} from './parking-speed.js';

import {isParkingEvent} from './parking-event-types.js';
export {PARKING_EVENTS,isParkingEvent} from './parking-event-types.js';
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const smooth=u=>{u=clamp(u);return u*u*u*(10+u*(-15+6*u))};
const shape=(pose,vehicle)=>({...pose,width:vehicle.width,length:vehicle.length});

// A lane shift follows a rear-axle curve. Heading and Ackermann steering come
// from its tangent/curvature; the body never translates sideways at fixed yaw.
function shiftLeg(start,dx,length,vehicle){
 const sample=u=>{
  u=clamp(u);const d=30*u*u*(1-u)*(1-u),dd=60*u*(1-u)*(1-2*u),vx=dx*d,vz=-length;
  const yaw=Math.atan2(-vx,-vz),curvature=-length*dx*dd/Math.pow(vx*vx+vz*vz,1.5);
  return {...bodyPose({x:start.x+dx*smooth(u),z:start.z+vehicle.rearOffset-length*u},yaw,vehicle.rearOffset),steer:Math.atan(vehicle.wheelbase*curvature)};
 };
 let distance=0,previous=sample(0);const rows=[0];
 for(let i=1;i<=512;i++){const p=sample(i/512);distance+=Math.hypot(p.x-previous.x,p.z-previous.z);rows.push(distance);previous=p;}
 const duration=parkingLegDuration(distance),at=time=>{
  const f=parkingTravel(time,duration),s=f*distance;let lo=0,hi=512;
  while(hi-lo>1){const m=(hi+lo)>>1;if(rows[m]<s)lo=m;else hi=m;}
  return {...sample((lo+(s-rows[lo])/Math.max(1e-9,rows[hi]-rows[lo]))/512),distance:s,gear:'D'};
 };
 return {duration,distance,at,end:at(duration)};
}

function routeTo(bay,start,vehicle,obstacles,forwardSetup){
 const options={vehicle,forwardSetup,obstacles:obstacles.map(o=>({...o,...localBay(o,start,0)}))},local=localBay(bay,start,0);
 const plan=parkingPlan(local,0,options);if(!plan)return null;
 const timing=parkingTiming(local,0,options),at=time=>worldPose(parkingPose(time,local,0,options),start,0);
 const legs=[
  {gear:'R',begin:0,end:plan.align,sample:at},
  {gear:'D',begin:plan.align?plan.align+plan.shift:0,end:timing.forward,sample:at},
  {gear:'R',begin:timing.forward+timing.shift,end:plan.total,sample:at}
 ].filter(leg=>leg.end-leg.begin>.001);
 return {duration:plan.total,timing,at,segment:time=>parkingSegment(time,local,0,options),legs};
}

function clearRun(run,vehicle,actorVehicle,obstacles){
 // 60 Hz and < 4 cm of travel between samples cover the complete body sweep.
 for(let t=0;t<=run.duration+1e-6;t+=1/60){
  const f=run.sample(Math.min(t,run.duration));
  if(Math.abs(f.ego.steer||0)>vehicle.maxSteer+.005)return false;
  if(overlaps(shape(f.ego,vehicle),shape(f.actor,actorVehicle),.20))return false;
  for(const o of obstacles)if(overlaps(shape(f.ego,vehicle),o,.12)||overlaps(shape(f.actor,actorVehicle),o,.12))return false;
  // The scene's clear aisle is 6.9 m wide. Turning into a bay is checked
  // against the parked fleet/columns above, including the final bay footprint.
  if(f.phase==='make-room'&&Math.abs(f.ego.x)+Math.abs(Math.cos(f.ego.yaw))*vehicle.width/2+Math.abs(Math.sin(f.ego.yaw))*vehicle.length/2>3.42)return false;
 }
 return true;
}

function routeBlocked(route,actor,start,vehicle,actorVehicle,until){
 const {step}=TRAFFIC_FEEDBACK,end=Math.min(until,route.duration);
 const movingBody=(at,time,spec)=>{
  const p=at(time),next=at(time+step);
  return {...p,...spec,speed:Math.hypot(next.x-p.x,next.z-p.z)/step};
 };
 for(let t=0;t<=end+1e-8;t+=step){
  if(feedbackOverlap(movingBody(route.at,t,vehicle),movingBody(actor,start+t,actorVehicle)))return true;
 }
 return false;
}

function oncomingConstrains(time,frame,next,{actor,finalRoute,yieldEnd,vehicle,actorVehicle}){
 const {ego,actor:other}=frame;
 const gap=other.z-ego.z,nextGap=next.actor.z-next.ego.z;
 const egoTail=ego.z+(Math.abs(Math.cos(ego.yaw))*vehicle.length+Math.abs(Math.sin(ego.yaw))*vehicle.width)/2;
 const otherNose=other.z+actorVehicle.length/2;
 // The oncoming car travels toward +z. Its nose must pass ego's tail and
 // separation must be growing before the trailing overlap can be ignored.
 if(nextGap<=gap||otherNose<egoTail+.35)return true;

 // Check the actual next manoeuvre at the earliest pose from which it can
 // start. Omit the scripted pause so it cannot keep an already clear car amber.
 return routeBlocked(finalRoute,actor,Math.max(time,yieldEnd),vehicle,actorVehicle,TRAFFIC_FEEDBACK.horizon);
}

function rearAxle(pose,vehicle){
 return {x:pose.x+Math.sin(pose.yaw)*vehicle.rearOffset,z:pose.z+Math.cos(pose.yaw)*vehicle.rearOffset};
}

function parkingIntent(bay,actor,actorVehicle,from,until){
 const {step,horizon}=TRAFFIC_FEEDBACK,side=Math.sign(bay.x);
 const footprint={...bay,width:bay.depth,length:bay.width,yaw:Math.PI/2};
 for(let t=from;t<=until;t+=step){
  if(!overlaps(shape(actor(t),actorVehicle),footprint,0))continue;
  for(let candidate=Math.max(from,t-horizon);candidate<t;candidate+=step){
   const pose=actor(candidate),rear=rearAxle(pose,actorVehicle),previous=rearAxle(actor(candidate-.2),actorVehicle);
   // Confirm sustained lateral reverse motion towards this bay before taking it off the plan.
   if(pose.phase==='reverse'&&side*(rear.x-previous.x)>=.05)return candidate;
  }
  return t;
 }
 return Infinity;
}

function parkingClearance(bay,actor,actorVehicle,finalRoute,vehicle,from,parkedAt){
 const side=Math.sign(bay.x),mouth=Math.abs(bay.x)-bay.width/2;
 let clearSince;
 for(let time=from;time<parkedAt;time+=TRAFFIC_FEEDBACK.step){
  const rear=rearAxle(actor(time),actorVehicle);
  const inBay=rear.x*side>=mouth&&Math.abs(rear.z-bay.z)<bay.depth/2;
  if(!inBay||routeBlocked(finalRoute,actor,time,vehicle,actorVehicle,parkedAt-time)){
   clearSince=undefined;
   continue;
  }
  clearSince??=time;
  if(time-clearSince>=.25-1e-8)return {clearAt:clearSince,releaseAt:time};
 }
 return {clearAt:parkedAt,releaseAt:parkedAt};
}

export function planParkingInteraction(event,{bays,occupied=[],obstacles=[],vehicle:spec={},actorVehicle:actorSpec={width:2.1,length:4.94},start={x:0,z:0},arrivalHold=.9}={}){
 if(!isParkingEvent(event))return null;
 // World positions are mutable Three vectors. A run owns its initial pose;
 // playback and seeking must never move the source of its own trajectory.
 start={x:start.x,z:start.z};
 const vehicle=parkingVehicle(spec),actorVehicle=parkingVehicle(actorSpec),free=bays.filter(b=>!occupied.some(o=>o.x===b.x&&o.z===b.z));
 const approach=shiftLeg(start,0,1,vehicle),decisionAt=approach.duration,stop=approach.end;
 const candidates=free.filter(b=>b.x<0).sort((a,b)=>Math.abs(a.z-(event==='parking-yield'?-3.6:-7.2))-Math.abs(b.z-(event==='parking-yield'?-3.6:-7.2)));
 for(const originalTarget of candidates){
  const originalRoute=routeTo(originalTarget,stop,vehicle,obstacles);if(!originalRoute)continue;
  let actor,finalRoute,finalTarget=originalTarget,releaseAt,clearAt,switchAt=Infinity,yieldEnd=decisionAt,shift;
  if(event==='parking-yield'){
   // Search legal clear-aisle positions. A conflicting original turn is
   // replaced by this forward shift, then replanned from its stopped pose.
   shift=shiftLeg(stop,-1.5,6.8,vehicle);yieldEnd=decisionAt+shift.duration;
   const speed=1.45,actorX=1.65,actorZ=start.z-17;
   actor=time=>({x:start.x+actorX,z:actorZ+speed*time,yaw:Math.PI,steer:0,distance:speed*time,gear:'D'});
   let conflict=false;
   for(let t=0;t<=originalRoute.duration;t+=.1)if(overlaps(shape(originalRoute.at(t),vehicle),shape(actor(t+decisionAt),actorVehicle),.5)){conflict=true;break;}
   if(!conflict)continue;
   releaseAt=Math.max(yieldEnd+.8,(shift.end.z+vehicle.length/2+actorVehicle.length/2+1.4-actorZ)/speed);
   finalRoute=routeTo(finalTarget,shift.end,vehicle,obstacles,{minAngle:Math.PI*24/180});if(!finalRoute)continue;
  }else{
   const actorStart={x:start.x,z:originalTarget.z-5.6},actorRoute=routeTo(originalTarget,actorStart,actorVehicle,obstacles);
   if(!actorRoute)continue;
   actor=time=>{
    const pose=actorRoute.at(clamp(time,0,actorRoute.duration));
    return {...pose,gear:time>=actorRoute.duration?'P':pose.phase==='forward'?'D':'R'};
   };
   switchAt=parkingIntent(originalTarget,actor,actorVehicle,decisionAt,actorRoute.duration);
   if(!Number.isFinite(switchAt))continue;
   const taken=shape(actor(actorRoute.duration),actorVehicle),remaining=free.filter(b=>b!==originalTarget).sort((a,b)=>Math.hypot(a.x-originalTarget.x,a.z-originalTarget.z)-Math.hypot(b.x-originalTarget.x,b.z-originalTarget.z));
   for(const bay of remaining){const route=routeTo(bay,stop,vehicle,[...obstacles,taken]);if(route){finalTarget=bay;finalRoute=route;break;}}
   if(!finalRoute)continue;
   ({clearAt,releaseAt}=parkingClearance(originalTarget,actor,actorVehicle,finalRoute,vehicle,switchAt,actorRoute.duration));
  }
  const parkAt=releaseAt+finalRoute.duration,duration=parkAt+arrivalHold;
  const originalStart=originalRoute.segment(0);
  const approachForwardTail=originalStart.gear==='D'&&Number.isFinite(originalStart.remaining)?originalStart.remaining:0;
  const sample=time=>{
   const t=clamp(time,0,duration),parking=t>=releaseAt,complete=t>=parkAt;
   let ego=t<decisionAt?approach.at(t):event==='parking-yield'&&t<yieldEnd?shift.at(t-decisionAt):{...(shift?.end||stop),steer:0};
   if(parking)ego=finalRoute.at(Math.min(t-releaseAt,finalRoute.duration));
   const seg=parking?finalRoute.segment(Math.min(t-releaseAt,finalRoute.duration)):null;
   const phase=complete?'parked':parking?ego.phase:event==='parking-yield'?t<decisionAt?'approach':t<yieldEnd?'make-room':'yield':t<decisionAt?'approach':t<switchAt?'space-taken':'find-space';
   const distance=t<decisionAt?ego.distance:parking?approach.distance+(shift?.distance||0)+ego.distance:event==='parking-yield'?approach.distance+ego.distance:approach.distance;
   const gear=complete?'P':parking?seg.gear:'D';
   const remaining=complete?0:parking?seg.remaining:t<decisionAt?Math.max(0,approach.distance-ego.distance)+approachForwardTail:event==='parking-yield'&&t<yieldEnd?Math.max(0,shift.distance-ego.distance):null;
   return {ego:{...ego,complete,distance},actor:actor(t),target:t<switchAt?originalTarget:finalTarget,phase,gear,remaining,complete,finished:t>=duration,yielding:t>=decisionAt&&t<releaseAt};
  };
  const route=time=>{
   if(time>=parkAt)return [];
   if(time<decisionAt)return [{gear:'D',begin:time,end:decisionAt,sample:approach.at},...originalRoute.legs];
   if(time<releaseAt)return event==='parking-yield'?[{gear:'D',begin:clamp(time-decisionAt,0,shift.duration),end:shift.duration,sample:shift.at}]:[];
   const local=time-releaseAt;
   return finalRoute.legs.filter(leg=>leg.end>local).map(leg=>({...leg,begin:Math.max(local,leg.begin)}));
  };
  const forwardEnd=releaseAt+finalRoute.timing.forward+finalRoute.timing.shift;
  const phases=event==='parking-yield'?[
   ['Approach',decisionAt,'An oncoming car needs the aisle.'],['Make room',yieldEnd-decisionAt,'The vehicle moves left and forward to leave a passing corridor.'],['Pause',releaseAt-yieldEnd,'The vehicle comes to a stop before turning back into the aisle.'],
  ]:[['Approach',decisionAt,'Another car is setting up to park ahead.'],['Wait',switchAt-decisionAt,'The vehicle stops to give the other car room to manoeuvre.'],['Find space',releaseAt-switchAt,'The vehicle selects an empty space and waits for its path to clear.']];
  phases.push(['Reposition',forwardEnd-releaseAt,event==='parking-yield'?'The vehicle turns forward to set up the reverse into the space.':'The vehicle lines up with the new space.'],['Reverse',parkAt-forwardEnd,'The vehicle reverses along the adjusted route.'],['Parked',duration-parkAt,'The vehicle is fully inside the space.']);
  const run={event,duration,decisionAt,yieldEnd,releaseAt,switchAt,forwardEnd,parkAt,originalTarget,finalTarget,vehicle,phases:phases.filter(([,d])=>d>.001),sample,route};
  if(clearRun(run,vehicle,actorVehicle,obstacles)){
   const pass={actor,finalRoute,yieldEnd,vehicle,actorVehicle};
   run.feedback=createTrafficFeedback(t=>{
    const f=sample(t),next=sample(Math.min(duration,t+.02)),dt=Math.max(.0001,Math.min(.02,duration-t));
    const speed=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z)/dt;
    const constraining=f.yielding&&(event==='parking-yield'?oncomingConstrains(t,f,next,pass):t<clearAt);
    return {ego:{...f.ego,...vehicle,speed:speed(f.ego,next.ego)},traffic:[{...f.actor,...actorVehicle,id:'parking-actor',speed:speed(f.actor,next.actor),constraining}]};
   },{duration});
   return run;
  }
 }
 throw Error('No clear parking interaction is available for this vehicle and layout.');
}
