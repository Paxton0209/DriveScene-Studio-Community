import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFile} from 'node:fs/promises';
import {INTERACTION_CAMERA} from '../interaction-camera.js';
// Use a loaded fleet with real footprints, without network or browser-only asset imports.
const url=new URL('../scene-experience.js',import.meta.url);
const source=(await readFile(url,'utf8')).replace(/from '(\.[^']+)'/g,(_,path)=>`from '${new URL(path,url).href}'`)
 .replace(/import \{createTrafficVehicle,readyTrafficModel,setTrafficAppearance\} from '[^']+';/,`const readyTrafficModel=async()=>{};function createTrafficVehicle(){const car=new THREE.Group();const material=new THREE.MeshStandardMaterial();material.userData.trafficRole='rubber';car.add(new THREE.Mesh(new THREE.BoxGeometry(1.9,1.65,4.7),material));car.userData={trafficVehicle:true,modelReady:true};return car;}const setTrafficAppearance=()=>{};`)
 .replace(/import \{prepareParkingMaterialStructure\} from '[^']+';/,'const prepareParkingMaterialStructure=async()=>{};')
 .replace(/new URL\('(\.\/parking-interactions\.bundle\.js[^']*)',import\.meta\.url\)\.href/g,(_,path)=>JSON.stringify(new URL(path,url).href))
 .replace("from 'three'",`from '${import.meta.resolve('three')}'`);
const {createParkingMotion}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function fixture(options){
 const camera=new THREE.PerspectiveCamera(40,16/9,.1,1000);camera.position.set(0,22,14);camera.lookAt(0,.85,0);camera.updateMatrixWorld(true);
 const world={state:{id:'10',mode:'light'},root:new THREE.Group(),scene:new THREE.Scene(),car:new THREE.Group(),camera,renderer:{shadowMap:{}},cameraAim:new THREE.Vector3(0,.85,0),parkingBays:[-5.9,5.9].flatMap(x=>[10.8,7.2,3.6,0,-3.6,-7.2,-10.8,-14.4,-18].map(z=>({x,z,width:4.9,depth:2.8}))),renderFrame(){},finishCameraMotion(){},captureCamera(){return {position:camera.position.clone(),carPosition:this.car.position.clone(),aim:this.cameraAim.clone()}},applyCamera(p){this.car.position.copy(p.carPosition);camera.position.copy(p.position);this.cameraAim.copy(p.aim);camera.lookAt(p.aim)}};
 world.draftTime=0;const motion=createParkingMotion(world,options);motion.sync();
 const tick=(seconds,assist=true)=>{for(let t=0;t<seconds-1e-8;t+=1/30){const dt=Math.min(1/30,seconds-t);world.draftTime+=dt*1000;motion.step(dt);motion.sync({assist});}};
 const pick=bay=>{const p=new THREE.Vector3(bay.x,.03,bay.z).project(camera);return motion.pick(p.x,p.y)};
 return {world,motion,pick,tick};
}


for(const scene of ['10','17'])for(const event of ['parking-yield','parking-taken'])test(`${scene}/${event} pauses, seeks, resumes, restores and replays without changing the run`,async()=>{
 const {world,motion}=fixture();world.state.id=scene;world.car.add(new THREE.Mesh(new THREE.BoxGeometry(1.85,1.45,4.72)));await motion.ready;
 motion.sync({traffic:true,assist:true});motion.configureEvent(event);motion.sync({traffic:true,assist:true});
 const run=motion.get().interaction;assert.doesNotThrow(()=>structuredClone(motion.get()),'status contains no scene objects or functions');assert.equal(run.event,event);assert.equal(motion.get().elapsed,0);
 assert.equal(motion.pick(0,0),false,'the event owns target selection even when paused');
 const actor=world.draftParkingGroup.children.find(o=>o.userData.parkingActor);assert.ok(actor.visible);
 if(event==='parking-yield'){
  motion.eventCamera('high');
  const heightAt=time=>{
   motion.seekEvent(time);motion.sync({traffic:true,assist:true});
   return world.camera.position.y-world.car.position.y;
  };
  assert.ok(Math.abs(heightAt(run.decisionAt)-26)<.04);
  assert.ok(heightAt(run.decisionAt+.8)<33,'BEV has not arrived at the old .8 second deadline');
  assert.ok(heightAt(run.decisionAt+INTERACTION_CAMERA.rise)>=33.96,'BEV arrives on the shared Auto camera clock');
  motion.seekEvent((run.decisionAt+run.yieldEnd)/2);motion.sync({traffic:true,assist:true});
  assert.ok(Math.abs(world.camera.position.x-world.car.position.x)<1e-6);
  assert.ok(Math.abs(world.camera.position.z-world.car.position.z)<.11,'High lifts to a fixed-axis BEV during the pass');
  const p=actor.position.clone().project(world.camera);
  assert.ok(Math.abs(p.x)<1&&Math.abs(p.y)<1,'the BEV contains the oncoming car');
  for(const [offset,min,max] of [[0,34,34.04],[.5,29,33],[.8,26.04,29],[1,26,26.04]]){
   motion.seekEvent(run.releaseAt+offset*INTERACTION_CAMERA.fall);motion.sync({traffic:true,assist:true});
   assert.ok(world.camera.position.y>=min&&world.camera.position.y<=max,'BEV returns smoothly to High on the shared Auto camera clock');
  }
  motion.eventCamera('auto');
 }
 const time=run.releaseAt+.5;motion.seekEvent(time);motion.sync({traffic:true,assist:true});
 const forward=world.draftParkingGroup.children.find(o=>o.name==='Parking approach path');
 const reverse=world.draftParkingGroup.children.find(o=>o.name==='Parking reverse path');
 if(forward.visible&&reverse.visible){
  const a=forward.geometry.getAttribute('position'),b=reverse.geometry.getAttribute('position');
  for(let i=0;i<2;i++){
   const join=new THREE.Vector3().fromBufferAttribute(a,a.count-2+i);
   assert.ok(join.distanceTo(new THREE.Vector3().fromBufferAttribute(b,i))<1e-6,'the blue ribbons meet without a gap');
  }
 }
 const pose=world.car.position.clone(),yaw=world.car.rotation.y,camera=world.camera.position.clone(),quaternion=world.camera.quaternion.clone(),actorPose=actor.position.clone();
 const saved=motion.capture();motion.seekEvent(run.duration);motion.sync({traffic:true,assist:true});assert.equal(motion.get().complete,true);assert.equal(motion.get().gear,'P');
 motion.seekEvent(0);motion.sync({traffic:true,assist:true});assert.equal(motion.get().complete,false);assert.equal(motion.get().elapsed,0);
 motion.seekEvent(time);motion.sync({traffic:true,assist:true});assert.ok(world.car.position.distanceTo(pose)<1e-8);assert.equal(world.car.rotation.y,yaw);assert.ok(world.camera.position.distanceTo(camera)<1e-8);assert.ok(world.camera.quaternion.angleTo(quaternion)<1e-7);assert.ok(actor.position.distanceTo(actorPose)<1e-8);
 motion.start();world.draftTime+=1000/60;motion.step(1/60);motion.sync({traffic:true,assist:true});const stepped=world.car.position.clone();motion.seekEvent(time+1/60);assert.ok(world.car.position.distanceTo(stepped)<1e-8,'playback matches seek at the same time');
 motion.pause();const paused=world.car.position.clone();motion.step(1);assert.ok(world.car.position.equals(paused),'pause freezes event progress');
 motion.seekEvent(run.duration);motion.restore(saved);motion.seekEvent(saved.elapsed);motion.sync({traffic:true,assist:true});assert.ok(world.car.position.distanceTo(pose)<1e-8);assert.ok(actor.position.distanceTo(actorPose)<1e-8);
 motion.eventCamera('low',{animate:true});world.draftTime+=250;motion.sync({traffic:true,assist:true});assert.equal(motion.get().camera.tween,true);const cameraSaved=motion.capture();assert.ok(cameraSaved.cameraTween,'a mid-transition export can capture the camera');motion.restore(cameraSaved);world.draftTime+=250;motion.sync({traffic:true,assist:true});assert.equal(motion.get().camera.tween,false);
 motion.eventCamera('high',{animate:true});world.draftTime+=500;motion.sync({traffic:true,assist:true});assert.equal(motion.get().manualView,'raised');
 motion.eventCamera('auto');
 const parkAt=run.duration-run.phases.at(-1)[1];
 const arrival=t=>{
  motion.seekEvent(t);motion.sync({traffic:true,assist:true});
  return {height:world.camera.position.y-world.car.position.y,reach:Math.hypot(world.camera.position.x-world.cameraAim.x,world.camera.position.z-world.cameraAim.z),distance:world.camera.position.distanceTo(world.car.position.clone().add(new THREE.Vector3(0,.85,0))),position:world.camera.position.clone(),orientation:world.camera.quaternion.clone(),complete:motion.get().complete};
 };
 const reverseStart=run.forwardEnd,reverseDuration=parkAt-reverseStart;
 const raised=arrival(reverseStart),mid=arrival(reverseStart+reverseDuration*.5),nearBEV=arrival(reverseStart+reverseDuration*.95);
 const stopped=arrival(parkAt),settled=arrival(parkAt+.66),held=arrival(run.duration);
 if(scene==='10'){
  for(const t of [reverseStart-.9,reverseStart-.5,reverseStart-.1,reverseStart]){
   const setup=arrival(t);
   assert.ok(Math.abs(setup.height-26)<1e-8&&Math.abs(setup.reach-27)<1e-8,'Reposition holds the regular High view through the gear change');
  }
  for(let i=1;event==='parking-yield'&&i<=24;i++){
   const reverse=arrival(reverseStart+reverseDuration*i/25);
   assert.ok(reverse.distance<=raised.distance+1e-7,'Indoor Oncoming car keeps its camera scale through the reverse');
  }
 }
 assert.ok(raised.reach>15&&mid.reach>2&&mid.reach<raised.reach*.9,'the normal parking lift progresses through the reverse instead of cutting to overhead');
 assert.ok(nearBEV.reach<1&&!nearBEV.complete,'the camera is almost overhead while the vehicle is still backing in');
 assert.ok(nearBEV.position.distanceTo(stopped.position)>.005,'the overhead camera continues following the car into the bay');
 assert.equal(stopped.complete,true);
 assert.ok(settled.reach<.1&&settled.position.distanceTo(held.position)<1e-8&&settled.orientation.angleTo(held.orientation)<1e-7,'the final camera settles into BEV and holds');
 const handoff=arrival(reverseStart-.01);
 assert.ok(handoff.position.distanceTo(raised.position)<.15&&handoff.orientation.angleTo(raised.orientation)<.02,'forward setup flows continuously into the shared reverse camera');
 motion.seekEvent(reverseStart+reverseDuration*.5-1/60,{playing:true});world.draftTime+=1000/60;motion.step(1/60);
 assert.ok(world.camera.position.distanceTo(mid.position)<1e-7&&world.camera.quaternion.angleTo(mid.orientation)<1e-7,'direct scrubbing and playing land on the same reverse camera frame');
 motion.configureEvent(null);motion.sync({traffic:false,assist:false});assert.equal(motion.get().interaction,null);assert.equal(motion.get().target,null);assert.equal(actor.visible,false);assert.equal(motion.get().active,false);
});

for(const scene of ['10','17'])test(`${scene} can start either demo after parking in the other one`,async()=>{
 const {world,motion}=fixture();world.state.id=scene;
 world.car.add(new THREE.Mesh(new THREE.BoxGeometry(1.85,1.45,4.72)));
 await motion.ready;
 motion.sync({traffic:true,assist:true});
 const start=world.car.position.clone();
 for(const event of ['parking-yield','parking-taken','parking-yield']){
  motion.configureEvent(event);
  assert.equal(motion.get().interaction.event,event);
  assert.equal(motion.get().elapsed,0);
  assert.ok(world.car.position.distanceTo(start)<1e-8);
  motion.seekEvent(motion.get().interaction.duration);
  assert.equal(motion.get().complete,true);
 }
});

for(const scene of ['10','17'])test(`${scene} parking events keep their own approach across interrupted runs`,async()=>{
 const {world,motion}=fixture({parkedHandoff:true});world.state.id=scene;
 world.car.add(new THREE.Mesh(new THREE.BoxGeometry(1.85,1.45,4.72)));
 await motion.ready;
 const sync=()=>motion.sync({traffic:true,assist:true});
 sync();
 const frame=()=>{
  motion.seekEvent(.8);sync();
  const {camera,target,interaction:{actor,originalTarget,finalTarget}}=motion.get();
  const paths=world.draftParkingGroup.children.filter(object=>object.name.endsWith(' path'));
  return {car:world.car.position.toArray(),yaw:world.car.rotation.y,camera,target,actor,originalTarget,finalTarget,
   routes:paths.map(({visible,geometry})=>visible?Array.from(geometry.attributes.position.array):null)};
 };
 const switches=['parking-yield','parking-taken'];
 const baseline=switches.map(event=>{motion.configureEvent(event);return frame();});
 for(const [i,event] of switches.entries()){
  const checkpoints=[
   ['first frame',()=>0], ['approach',()=>.8],
   ['wait',run=>(run.decisionAt+run.releaseAt)/2],
   ['forward setup',run=>(run.releaseAt+run.forwardEnd)/2],
   ['reverse',run=>(run.forwardEnd+run.duration)/2],
   ['last moving frame',run=>run.duration-.01], ['parked',run=>run.duration]
  ];
  for(const [label,time] of checkpoints){
   for(const turningOff of [false,true]){
    const run=motion.configureEvent(event);
    motion.seekEvent(time(run),{playing:true});sync();
    if(turningOff){
     motion.pause();motion.detachEvent();sync();
     assert.equal(motion.get().complete,label==='parked');
     assert.equal(motion.get().interaction,null);
    }
    motion.configureEvent(switches[1-i]);
    assert.deepEqual(frame(),baseline[1-i],label+' / '+event+' / off '+turningOff);
   }
  }
 }
});

for(const event of ['parking-yield','parking-taken'])test(`${event} can rotate on arrival, fades the bay and keeps it unlit through exit`,async t=>{
 let wallTime=100;
 t.mock.method(performance,'now',()=>wallTime);
 const {world,motion,tick}=fixture({parkedHandoff:true});
 world.car.add(new THREE.Mesh(new THREE.BoxGeometry(1.85,1.45,4.72)));
 await motion.ready;
 const sync=()=>motion.sync({traffic:true,assist:true});
 sync();
 const run=motion.configureEvent(event);
 const target=world.draftParkingGroup.children.find(o=>o.name==='Parking target space');
 const route=world.draftParkingGroup.children.find(o=>o.name==='Parking approach path');
 const {uniforms}=target.material;
 assert.equal(run.duration,run.parkAt);
 motion.seekEvent(run.duration);
 sync();
 assert.equal(motion.get().completedInPlayback,false);
 assert.equal(motion.get().replayReady,true);
 assert.equal(target.visible,false);
 motion.seekEvent(run.duration-.05);
 assert(motion.start());
 tick(.04);
 assert.equal(motion.get().complete,false);
 assert.equal(target.visible,true);
 tick(.02);
 const status=motion.get();
 assert.equal(status.complete,true);
 assert.equal(status.completedInPlayback,true);
 assert.equal(status.active,false);
 assert.equal(status.replayReady,true);
 assert.equal(target.visible,true);
 assert.deepEqual([uniforms.celebrate.value,uniforms.success.value],[0,0]);
 assert.ok(Math.abs(uniforms.completion.value-.793893)<1e-6);
 wallTime+=700;
 sync();
 assert.equal(target.visible,false);
 assert(motion.prepareExit());
 sync();
 assert.equal(target.visible,false);
 assert(motion.previewCamera('low'));
 assert(motion.chooseExit(-1));
 assert(motion.start());
 tick(.5);
 assert.equal(target.visible,false);
 assert.equal(route.visible,true);
});

for(const event of ['parking-yield','parking-taken'])test(`${event} separates scrubbed and played arrival and retains its bay for exit`,async()=>{
 const {world,motion,tick}=fixture();
 world.car.add(new THREE.Mesh(new THREE.BoxGeometry(1.85,1.45,4.72)));
 await motion.ready;
 motion.sync({traffic:true,assist:true});
 motion.configureEvent(event);
 const run=motion.get().interaction;
 const parkAt=run.duration-run.phases.at(-1)[1];
 const target=world.draftParkingGroup.children.find(o=>o.name==='Parking target space');
 const actor=world.draftParkingGroup.children.find(o=>o.userData.parkingActor);
 if(event==='parking-taken'){
  motion.seekEvent(run.switchAt+.5);
  motion.sync({traffic:true,assist:true});
  assert.equal(target.material.uniforms.alternate.value,1);
  assert.deepEqual(motion.get().target,run.finalTarget);
  assert([target.position.x,target.position.z].every(Number.isFinite));
  const projection=target.position.clone().project(world.camera);
  assert(Math.abs(projection.x)<.9&&Math.abs(projection.y)<.9);
 }
 motion.seekEvent(run.duration);
 assert.equal(motion.get().completedInPlayback,false);
 motion.seekEvent(parkAt-.05);
 assert(motion.start());
 tick(.12);
 assert.equal(motion.get().completedInPlayback,true);
 assert.equal(motion.get().replayReady,false);
 tick(1.8);
 assert.equal(motion.get().replayReady,true);
 const pose=world.car.position.clone();
 const camera=world.camera.position.clone();
 const actorPose=actor.position.clone();
 if(event==='parking-taken')motion.detachEvent();
 assert.equal(motion.get().complete,true);
 assert.deepEqual(motion.get().target,run.finalTarget);
 assert(world.car.position.equals(pose)&&world.camera.position.equals(camera));
 assert(motion.prepareExit());
 motion.previewCamera('low');
 assert(motion.chooseExit(-1));
 assert(motion.start());
 tick(2);
 assert.equal(motion.get().interaction,null);
 assert.deepEqual(motion.get().target,run.finalTarget);
 assert(Math.abs(world.car.position.x)<Math.abs(pose.x)-.25);
 assert.equal(actor.visible,event==='parking-taken');
 if(actor.visible)assert(actor.position.equals(actorPose));
 tick(6);
 assert.equal(motion.get().exited,true);
 assert.equal(motion.get().target,null);
});
