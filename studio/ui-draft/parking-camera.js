import * as THREE from 'three';
import {framingTargets,vehicleFrame} from '../engine/framing.js';
import {MANUAL_CAMERA_MS,manualCameraBlend} from './manual-camera.js';


// Stable world-space envelope: replacing a mesh must not pan the environment.
export function parkingFrame(car,camera){
 const axis=new THREE.Vector3(0,1,0),points=[-1.05,1.05].flatMap(x=>[-1.74,1.74].flatMap(z=>[0,1.9].map(y=>new THREE.Vector3(x,y,z).applyAxisAngle(axis,car.rotation.y).add(car.position).project(camera))));
 const xs=points.map(p=>(1+p.x)/2),ys=points.map(p=>(1-p.y)/2),left=Math.min(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
 return {left,top,bottom,width:Math.max(...xs)-left,height:bottom-top};
}

// Fit the maneuver after applying the same lower vehicle anchor as the live view.
// This keeps a distant/behind bay visible without allowing the car to drift up.
export function fitParkingCamera(camera,car,yaw,focus,direction,distance,points,anchor,centered=false){
 const probe=new THREE.PerspectiveCamera(camera.fov,camera.aspect,camera.near,camera.far),axis=new THREE.Vector3(0,1,0);
 const corners=[-1.1,1.1].flatMap(x=>[-2.65,2.65].flatMap(z=>[0,1.9].map(y=>new THREE.Vector3(x,y,z).applyAxisAngle(axis,yaw).add(car))));
 const fits=length=>{
  probe.position.copy(focus).addScaledVector(direction,length);probe.lookAt(focus);probe.updateMatrixWorld(true);probe.clearViewOffset();
  const projections=corners.map(p=>p.clone().project(probe)),ys=projections.map(p=>(1-p.y)/2),xs=projections.map(p=>(1+p.x)/2);
  const bottom=Math.max(...ys),centerY=(Math.min(...ys)+bottom)/2,centerX=(Math.min(...xs)+Math.max(...xs))/2;
  probe.setViewOffset(1920,1080,centered?(centerX-.5)*1920:0,((centered?centerY:bottom)-anchor)*1080,1920,1080);probe.updateMatrixWorld(true);
  const projected=[...corners,...points].map(p=>p.clone().project(probe));
  return projected.every(p=>Math.abs(p.x)<.90&&p.y>-.84&&p.y<.88&&p.z<1)||!points.length;
 };
 let length=distance;
 if(!fits(length)){
  let low=length,high=length;
  for(let n=0;n<24&&!fits(high);n++)high*=1.25;
  // Solve the framing boundary continuously; geometric steps caused visible
  // camera distance jumps as a moving route crossed a screen margin.
  for(let n=0;n<22;n++){const mid=(low+high)/2;if(fits(mid))high=mid;else low=mid;}
  length=high;
 }
 return {position:focus.clone().addScaledVector(direction,length),aim:focus,anchor};
}

// Camera scheduling from release 0b10710 (v0.18, 2026-10-13).
// Preserve one vehicle pivot, one spring, quaternion rotation and screen anchor.
export function captureParkingView(camera,car,aim){
 camera.updateMatrixWorld(true);
 const pivot=car.position.clone().add(new THREE.Vector3(0,.85,0)),p=pivot.clone().project(camera);
 return {position:camera.position.clone(),aim:aim.clone(),quaternion:camera.quaternion.clone(),offset:new THREE.Vector2(camera.view?.enabled?camera.view.offsetX:0,camera.view?.enabled?camera.view.offsetY:0),screenAnchor:new THREE.Vector2((p.x+1)/2,(1-p.y)/2),anchor:.5,reference:true};
}

export function parkingViewPose(camera,car,kind,heading=car.rotation.y,lowShift=0){
 const probe=camera.clone(),axis=new THREE.Vector3(0,1,0);
 // Default shares Driving Low's camera-to-car offset and forward aim. Keep
 // this endpoint shared by initial configuration, scene return and view picks.
 const position=kind==='bev'?[0,34,.1]:kind==='raised'?[0,26,22]:[0,8.48,23];
 const aim=kind==='bev'?[0,0,0]:kind==='raised'?[0,0,-5]:[0,-.02,-24];
 probe.clearViewOffset();probe.up.set(0,1,0);
 probe.position.fromArray(position).applyAxisAngle(axis,heading).add(car.position);
 const target=new THREE.Vector3(...aim).applyAxisAngle(axis,heading).add(car.position);
 probe.lookAt(target);probe.updateMatrixWorld(true);
 const low=kind==='default';
 const frame=parkingFrame(car,probe);
 const bottom=framingTargets[low?'low':'high'];
 const shift=low?lowShift:0;
 probe.setViewOffset(1920,1080,0,(frame.bottom-bottom)*1080+shift,1920,1080);probe.updateMatrixWorld(true);
 return {...captureParkingView(probe,car,target),anchor:bottom-frame.height/2-shift/1080};
}

export function parkingLowShift(camera,car,targetBottom=framingTargets.low){
 const probe=camera.clone();
 applyParkingView(probe,car,parkingViewPose(probe,car,'default'));
 const {bottom}=vehicleFrame(car,probe);
 return Number.isFinite(bottom)?(bottom-targetBottom)*1080:0;
}

export function applyParkingView(camera,car,pose){
 camera.position.copy(pose.position);camera.quaternion.copy(pose.quaternion);
 camera.setViewOffset(1920,1080,pose.offset.x,pose.offset.y,1920,1080);camera.updateMatrixWorld(true);
 const actual=car.position.clone().add(new THREE.Vector3(0,.85,0)).project(camera);
 camera.setViewOffset(1920,1080,pose.offset.x+((actual.x+1)/2-pose.screenAnchor.x)*1920,pose.offset.y+((1-actual.y)/2-pose.screenAnchor.y)*1080,1920,1080);camera.updateMatrixWorld(true);
}

export function sampleParkingView(from,to,elapsed,focus=new THREE.Vector3(0,.87,0)){
 const complete=elapsed>=MANUAL_CAMERA_MS-1e-7,phase=manualCameraBlend(elapsed);
 const a=new THREE.Spherical().setFromVector3(from.position.clone().sub(focus)),b=new THREE.Spherical().setFromVector3(to.position.clone().sub(focus));
 b.theta=a.theta+Math.atan2(Math.sin(b.theta-a.theta),Math.cos(b.theta-a.theta));
 const position=phase===0?from.position.clone():complete?to.position.clone():new THREE.Vector3().setFromSpherical(new THREE.Spherical(THREE.MathUtils.lerp(a.radius,b.radius,phase),THREE.MathUtils.lerp(a.phi,b.phi,phase),THREE.MathUtils.lerp(a.theta,b.theta,phase))).add(focus);
 return {position,aim:from.aim.clone().lerp(to.aim,phase),quaternion:from.quaternion.clone().slerp(to.quaternion,phase),offset:from.offset.clone().lerp(to.offset,phase),screenAnchor:from.screenAnchor.clone().lerp(to.screenAnchor,phase),anchor:THREE.MathUtils.lerp(from.anchor,to.anchor,phase),reference:true,complete,phase};
}

// Shared by the one-click maneuver and the final reverse in event playback.
const yAxis=new THREE.Vector3(0,1,0),clamp01=t=>THREE.MathUtils.clamp(t,0,1),smooth=t=>t*t*(3-2*t);
export const PARKING_SETTLE_MS=650;

export function parkingManeuverView(camera,car,yaw,bay,kind,reverse,points=[],heading=yaw){
 const focus=car.clone().add(new THREE.Vector3(0,.85,0));
 const distance=THREE.MathUtils.clamp(30+Math.hypot(bay.x-car.x,bay.z-car.z)*.35,30,50);
 const top=kind==='bev'?1:kind==='raised'?smooth(clamp01((reverse-.14)/.72)):0;
 const elevation=THREE.MathUtils.lerp(.91,Math.PI/2-.001,top);
 const direction=new THREE.Vector3(0,Math.sin(elevation),Math.cos(elevation)).applyAxisAngle(yAxis,heading);
 const bounds=[-.5,.5].flatMap(x=>[-.5,.5].map(z=>new THREE.Vector3(bay.x+x*bay.width,.05,bay.z+z*bay.depth)));
 return fitParkingCamera(camera,car,yaw,focus,direction,distance,bounds.concat(points),.5,true);
}

export function parkingRoutePoints(sample,start,end){
 const points=[];
 for(let t=start;t<=end;t+=(end-start)/12||1){const p=sample(t);points.push(new THREE.Vector3(p.x,.25,p.z));}
 return points;
}

export function followParkingManeuver(state,goal,dt,heading){
 const weight=1-Math.exp(-dt*4.5);
 state.position.lerp(goal.position,weight);state.aim.lerp(goal.aim,weight);state.anchor=goal.anchor;
 if(heading!==undefined)alignParkingManeuver(state,heading);
}

export function alignParkingManeuver(state,heading){
 const radius=Math.hypot(state.position.x-state.aim.x,state.position.z-state.aim.z);
 state.position.x=state.aim.x+Math.sin(heading)*radius;state.position.z=state.aim.z+Math.cos(heading)*radius;
}

export function blendParkingManeuver(state,from,goal,velocity,u,duration){
 const t=smooth(u),v=u*(1-u)*(1-u)*duration/1000;
 for(const key of ['position','aim'])state[key].copy(from[key]).lerp(goal[key],t).addScaledVector(velocity[key],v);
 state.anchor=THREE.MathUtils.lerp(from.anchor,goal.anchor,t)+velocity.anchor*v;
 return {t,v};
}

export function orbitParkingManeuver(state,from,goal,velocity,t,v){
 const a=from.position.clone().sub(from.aim),b=goal.position.clone().sub(goal.aim);
 const heading=Math.atan2(a.x,a.z),delta=Math.atan2(b.x,b.z)-heading,turn=Math.atan2(Math.sin(delta),Math.cos(delta));
 if(Math.abs(turn)<=Math.PI/2)return;
 const radius=THREE.MathUtils.lerp(Math.hypot(a.x,a.z),Math.hypot(b.x,b.z),t);
 state.position.x=state.aim.x+Math.sin(heading+turn*t)*radius+(velocity.position.x-velocity.aim.x)*v;
 state.position.z=state.aim.z+Math.cos(heading+turn*t)*radius+(velocity.position.z-velocity.aim.z)*v;
}

export function projectParkingManeuver(camera,car,view,center=true){
 camera.position.copy(view.position);camera.clearViewOffset();camera.up.set(0,1,0);camera.lookAt(view.aim);camera.updateMatrixWorld(true);
 if(!center)return;
 const frame=parkingFrame(car,camera),centerY=(frame.top+frame.bottom)/2,centerX=frame.left+frame.width/2;
 camera.setViewOffset(1920,1080,(centerX-.5)*1920,(centerY-view.anchor)*1080,1920,1080);camera.updateMatrixWorld(true);
 return frame;
}

const copyManeuver=({position,aim,anchor})=>({position:position.clone(),aim:aim.clone(),anchor});
export function createParkingArrivalCamera(camera,run,carY){
 const {forwardEnd,parkAt,finalTarget}=run,step=1/60;
 const sample=t=>run.sample(t).ego;
 const goalAt=(time,kind='raised',reverse=clamp01((time-forwardEnd)/(parkAt-forwardEnd)))=>{
  const {x,z,yaw}=sample(time);
  return parkingManeuverView(camera,new THREE.Vector3(x,carY,z),yaw,finalTarget,kind,reverse,
   kind==='bev'?[]:parkingRoutePoints(sample,time,parkAt));
 };
 const start=run.releaseAt,frames=[goalAt(start)];
 const advance=(previous,time,dt)=>{
  const state=copyManeuver(previous);
  followParkingManeuver(state,goalAt(time),dt,sample(time).yaw);
  return state;
 };
 // Sample from a fixed clock so scrubbing and exporting see the same pose,
 // independent of the last frame the viewer happened to render.
 const frameAt=time=>{
  const elapsed=time-start,index=Math.floor(elapsed/step+1e-8);
  for(let i=frames.length;i<=index;i++)frames.push(advance(frames[i-1],start+i*step,step));
  const remainder=elapsed-index*step;
  return remainder>1e-8?advance(frames[index],time,remainder):frames[index];
 };
 let arrival;
 const stateAt=time=>{
  if(time<=parkAt)return frameAt(time);
  if(!arrival){
   const from=frameAt(parkAt),previous=frameAt(Math.max(start,parkAt-step)),dt=Math.min(step,parkAt-start);
   const velocity={position:from.position.clone().sub(previous.position).divideScalar(dt),aim:from.aim.clone().sub(previous.aim).divideScalar(dt),anchor:0};
   arrival={from,goal:goalAt(parkAt,'bev'),velocity};
  }
  const {from,goal,velocity}=arrival,state=copyManeuver(from),u=clamp01((time-parkAt)*1000/PARKING_SETTLE_MS);
  const {t,v}=blendParkingManeuver(state,from,goal,velocity,u,PARKING_SETTLE_MS);
  orbitParkingManeuver(state,from,goal,velocity,t,v);
  return state;
 };
 return (time,car)=>{
  const state=stateAt(time),probe=camera.clone();
  projectParkingManeuver(probe,car,state);
  return {...captureParkingView(probe,car,state.aim),anchor:state.anchor};
 };
}
