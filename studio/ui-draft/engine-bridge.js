import {feedbackFields} from './traffic-feedback.js';
import {isParkingEvent} from './parking-event-types.js';
import {prepareRenderer} from '../engine/prepare-renderer.js';
import {vehicleFrame} from '../engine/framing.js';
import {installAppearancePreparation,prepareSceneThemes} from './appearance-preparation.js';
import {syncVehicleCastFade} from './vehicle-cast-shadow.js';
import {indoorShadowLimits,syncIndoorShadowLight,syncIndoorReflectionResolution} from './indoor-shadow-settings.js';
import {syncDrivingSunShadow,syncRoadShadow} from './road-shadow-settings.js';
import {createIndoorDither} from './indoor-dither.js';
import {unlockIndicatorSound,stopIndicatorSound,resetIndicatorSound} from './assist-sound.js';
import {createVehicleWeather} from './vehicle-weather.js';
import {softenVehicleRoof} from './vehicle-roof-finish.js';
import {createTrafficFeedback} from './traffic-feedback.js';
import {createJunctionFeedback} from './junction-feedback.js';
import {JUNCTION_LEFT_TURN,JUNCTION_LEFT_TIMING,createTrafficAfterJunctionCommit,junctionLeftPath,planJunctionTurn} from './junction-left-turn.js';
import {parkingVehicle} from './parking-kinematics.js';
import * as THREE from 'three';
import {createParkingMotion,installRollingWheels,isParking} from './scene-experience.js';
import {previewPixels} from './pixel-resolution.js';
import {exportSize} from './export-size.js';
import {pathSoundStatus} from '../engine/theme-sound.js';
import {isAdjacentCutInScene} from './cut-in-timing.js';
import {advanceRampPassage} from './ramp-passage.js';
import {frameStep} from './frame-clock.js';
import {MANUAL_CAMERA_MS,manualCameraBlend,parkingCameraChoice} from './manual-camera.js';
import {parkingViewPose} from './parking-camera.js';
import {appearanceSnapshot,createAppearanceBlend} from './theme-blend.js';

globalThis.__draftTHREE=THREE;
const DRIVING_EVENTS=['roadworks','cutin','lanechange'];

export function makeRandom(seed){
 let value=seed>>>0;
 const next=()=>{value=(value+0x6d2b79f5)>>>0;let mixed=value;mixed=Math.imul(mixed^(mixed>>>15),mixed|1);mixed^=mixed+Math.imul(mixed^(mixed>>>7),mixed|61);return ((mixed^(mixed>>>14))>>>0)/4294967296};
 next.state=()=>value;next.restore=state=>{value=state>>>0};next.reset=nextSeed=>{if(Number.isFinite(nextSeed))seed=nextSeed;value=seed>>>0};return next;
}

let videoModule,videoRetry=0;
function loadVideoModule(){
 const request=()=>videoRetry
  ?import(new URL('./video.bundle.js?v=20261106&retry='+videoRetry,import.meta.url).href)
  :import('./video.js');
 return videoModule??=request().catch(error=>{videoModule=null;videoRetry++;throw error;});
}

let exportModule,exportRetry=0;
export function loadExportModule(){
 const request=()=>exportRetry
  ?import(new URL('./export.bundle.js?retry='+exportRetry,import.meta.url).href)
  :import('./export-runtime.js');
 return exportModule??=request().catch(error=>{exportModule=null;exportRetry++;throw error;});
}

let drivingEventsModule,drivingEventsRetry=0;
function loadDrivingEventsModule(){
 const request=()=>drivingEventsRetry
  ?import(new URL('./driving-events.bundle.js?retry='+drivingEventsRetry,import.meta.url).href)
  :import('./elevated-roadworks.js');
 return drivingEventsModule??=request().catch(error=>{drivingEventsModule=null;drivingEventsRetry++;throw error;});
}

export function installDraftBridge({world,features,drive,traffic,api,current,updateURL}){
 const query=new URLSearchParams(globalThis.__draftSearch??location.search);
 const embedded=query.has('scene-preview');
 (world.draftVehicleMirror??={value:0}).value=Number(embedded);
 world.draftParkingGray={value:query.has('neutral-parking') ? .65 : 0};
 let parkedBlendCamera=null;
 const adaptiveTraffic=embedded&&query.get('adaptive-roadworks-traffic')==='1';
 const interaction=(embedded?query:new URLSearchParams(window.parent.location.search)).get('interaction');
 let drivingEvent=DRIVING_EVENTS.includes(interaction)||embedded&&(interaction===JUNCTION_LEFT_TURN||isParkingEvent(interaction))?interaction:null;
 let roadworks=null,roadworksPromise=null;
 const entrySeed=query.get('cut-in-seed');
 async function ensureRoadworks(){
  if(roadworks)return roadworks;
  if(!embedded&&!drivingEvent)return null;
  roadworksPromise??=loadDrivingEventsModule().then(({createElevatedRoadworks})=>{
   roadworks??=createElevatedRoadworks(world,drive,traffic,seed=>makeRandom(seed??crypto.getRandomValues(new Uint32Array(1))[0]),{adaptiveTraffic});
   if(DRIVING_EVENTS.includes(drivingEvent))roadworks.configure(drivingEvent,entrySeed===null?undefined:{cutInSeed:Number(entrySeed)>>>0});
   return roadworks;
  }).catch(error=>{roadworksPromise=null;throw error;});
  return roadworksPromise;
 }
 let roadworksCamera=null,cameraHandoff=null,junctionCamera='auto',junctionCameraMotion=null;
 let junctionSceneCamera=query.get('view')==='high'?'high':null,junctionEventVisible=true,junctionFleet=null,junctionRun=null,junctionDepartAfter=0;
 let savedJunctionTurn=null;
 const junctionTiming=()=>junctionRun?.timing??JUNCTION_LEFT_TIMING;
 const eventScene=scene=>scene==='elevated'||adaptiveTraffic&&isAdjacentCutInScene(scene);
 const supportsEvent=(scene,event)=>isParkingEvent(event)?['parking','outdoor'].includes(scene):event==='lanechange'
  ? adaptiveTraffic&&scene==='road'
  : !!event&&(scene==='elevated'||event==='cutin'&&eventScene(scene));
 const roadworksActive=()=>{
  const scene=current(),{id,laneCount}=world.state??{};
  if(eventScene(scene)&&roadworks?.cruisingRoad)return true;
  if(isParkingEvent(drivingEvent)||drivingEvent===JUNCTION_LEFT_TURN||!supportsEvent(scene,drivingEvent))return false;
  if(scene==='elevated')return id==='03';
  if(scene==='road')return id==='02'&&laneCount>=4;
  return ['06','07'].includes(id);
 };
 const junctionTurnActive=()=>embedded&&drivingEvent===JUNCTION_LEFT_TURN&&current()==='junction'&&world.state?.id==='05';
 world.draftJunctionTurnActive=junctionTurnActive;
 const junctionVehicleAxles=new WeakMap();
 function junctionAxles(){
  const car=world.car;
  if(!junctionVehicleAxles.has(car))junctionVehicleAxles.set(car,parkingVehicle(car.userData.vehicleSpec));
  return junctionVehicleAxles.get(car);
 }
 world.draftJunctionPath=junctionLeftPath;
 const parkingEventActive=()=>embedded&&isParkingEvent(drivingEvent)&&isParking(world.state?.id);
 const eventDuration=()=>parkingEventActive()?parking.get().interaction?.duration??1:junctionTurnActive()?junctionTiming().duration:roadworks?.duration;
 if(embedded||drivingEvent)world.draftRoadworksPlayback={active:roadworksActive,reset:()=>roadworks?.reset(),get duration(){return roadworks?.duration??0}};
 let playing=['road','elevated','ramp'].includes(current())&&!matchMedia('(prefers-reduced-motion: reduce)').matches,frame=0,last=0,accumulator=0,exporting=false,idlePaused=false,lastInput=performance.now(),loopTime=0,junctionPoses=null,origin=null,originRoot=null,themeHeld=false,audioHeld=false,scenePreparing=false;
 // Only the most recently operated preview may own the indicator cue.
 let indicatorOwnsAudio=false;
 const indicatorChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('drivescene-indicator-audio'):null;
 function claimIndicatorAudio(){indicatorOwnsAudio=true;indicatorChannel?.postMessage('claim');}
 if(indicatorChannel)indicatorChannel.onmessage=()=>{indicatorOwnsAudio=false;stopIndicatorSound()};
 if(query.get('paused')==='1'||drivingEvent)playing=false;
 world.draftManaged=true;world.draftJunctionFreeTraffic=embedded;world.draftTrafficEnabled=traffic.audit().enabled;world.draftTime=performance.now();drive.pause();
  // The sampled junction camera does not own world.cameraMotion.
  world.draftJunctionPlaying=()=>playing&&!themeHeld&&current()==='junction';
 const parking=createParkingMotion(world,{parkedHandoff:embedded}),junctionFeedback=createJunctionFeedback(world);const appearance=createAppearanceBlend(),draw=world.renderFrame;let renderedFrames=0,themeTarget;world.draftThemeTone={value:(world.state?.mode||query.get('mode'))==='dark'?1:0};
 world.draftEnsureRoadworks=ensureRoadworks;
 world.draftScheduleIdleWarmup=()=>{if(embedded&&!navigator.connection?.saveData)setTimeout(()=>{if(!document.hidden&&!themeHeld)void ensureRoadworks().catch(()=>{});},1500);};
 world.draftPrepareStartup=async(scene=current(),enabled=world.draftTrafficEnabled,event=drivingEvent)=>{
  if(world.draftEnsureRoadworks&&['roadworks','cutin','lanechange'].includes(event))await world.draftEnsureRoadworks();
  if(!enabled&&!supportsEvent(scene,event))return;
  await (['parking','outdoor'].includes(scene)?parking.ready:traffic.ready);
 };
 world.draftPrepareInitialTraffic=()=>world.draftPrepareStartup().catch(error=>{
  if(embedded||drivingEvent)throw error;
  world.draftTrafficEnabled=false;traffic.setEnabled(false);
 });
 // Capture the layer entry and retraction variants in the same renderer batch.
 // On default Pro startup with both path and traffic off, defer inactive variant
 // recording until idle after the first visible frame to shorten time-to-3D.
 world.draftRecordStartupVariants=record=>{
  if(world.draftStartupReadiness?.ready)return;
  const saved=features.get(),trafficEnabled=world.draftTrafficEnabled,initializing=world.initializingScene,ready=world.draftInitialFrameReady;
  const trafficState=traffic.draftCapture(),parkingState=parking.capture();
  try{
   world.initializingScene=false;world.draftInitialFrameReady=true;
   features.set({path:false},{animate:false,render:false});world.draftTrafficEnabled=false;traffic.setEnabled(false);record();
   if(!embedded||trafficEnabled||saved.path||drivingEvent){
    features.set({path:true},{animate:false,render:false});world.draftTrafficEnabled=true;traffic.setEnabled(true);record();record();
   }
  }finally{
   features.set(saved,{animate:false,render:false});world.draftTrafficEnabled=trafficEnabled;
   traffic.draftRestore(trafficState);parking.restore(parkingState);world.initializingScene=initializing;world.draftInitialFrameReady=ready;
  }
 };
 const vehicleWeather=createVehicleWeather(world),indoorDither=createIndoorDither();world.composer.addPass(indoorDither);world.draftIndoorDither=indoorDither;
 // Prepare the final shader variants before the existing offscreen vehicle warmup.
 world.draftPrepareVehicle=car=>{installRollingWheels(car);vehicleWeather.install(car);softenVehicleRoof(car);};
 softenVehicleRoof(world.car);
 world.renderFrame=function(...args){syncIndoorReflectionResolution(world,world.width>=1920);syncRoadShadow(current(),world.draftRoadShadowStrength??1);syncIndoorShadowLight(world,isParking(world.state?.id));syncDrivingSunShadow(world,current());indoorDither.enabled=true;if(world.state&&!world.suspended&&!document.hidden){const now=performance.now();sampleElevatedFrame(now);sampleJunctionEvent(now);advanceRampPassage(world.root,world.drivingDistance||0);appearance.sample(now);junctionFeedback.update(features.get().path);parking.sync({traffic:world.draftTrafficEnabled??false,assist:features.get().path});const rolling=installRollingWheels(world.car);if(rolling){rolling.steer.value=world.draftJunctionTurnFrame?.steer??world.draftWheelSteer??0;rolling.distance.value=isParking(world.state.id)?(world.draftWheelDistance||0):current()==='junction'?(world.draftJunctionTurnFrame?.wheelDistance??-world.car.position.z):world.drivingDistance||0;}vehicleWeather.update();renderedFrames++}syncVehicleCastFade(world);return draw.apply(this,args)};
 const get=({audit=true}={})=>{const driving=drive.audit();return ({ready:!!world.root&&!world.initializingScene,startup:world.draftStartupReadiness,playing:playing&&!document.hidden,requestedPlaying:playing,exporting,distance:driving.distance,originEpoch:Math.floor(driving.distance/1000),loopTime,cameraHandoff:!!(cameraHandoff||junctionCameraMotion),event:parkingEventActive()?parking.get().interaction:junctionTurnActive()&&junctionEventVisible?{event:drivingEvent,time:loopTime,duration:eventDuration(),timing:junctionTiming()}:null,roadworks:drivingEvent&&roadworks&&world.draftRoadworksPlayback?.active()?{event:drivingEvent,time:loopTime,duration:world.draftRoadworksPlayback.duration,eventStart:roadworks.eventStart,handoff:roadworks.eventHandoff,cutInTiming:world.draftRoadworksFrame?.cutInTiming,options:roadworks.options,workZoneTiming:roadworks.workZoneTiming,rampMerge:world.draftRoadworksFrame?.rampMerge,laneChange:world.draftRoadworksFrame?.laneChange}:null,scene:current(),features:features.get(),...(audit?{wheels:world.car.userData.draftRolling?.affected||0}:{}),...(audit?{path:features.audit().path,objects:world.scene.getObjectsByProperty('isObject3D',true).length}:{}),parking:isParking(world.state?.id)?parking.get():null,junction:current()==='junction'?{liftDistance:25,complete:!!junctionPoses&&loopTime>=(junctionTurnActive()?eventDuration():junctionPoses.motion.duration/1000),speed:world.draftSpeed??0,feedback:world.draftJunctionFeedback}:null,sound:pathSoundStatus(),pooledObjects:driving.pooledObjects,logicalTime:world.draftTime,vehicleSnow:world.draftVehicleSnow,raster:{width:world.renderer.domElement.width,height:world.renderer.domElement.height,cssWidth:world.renderer.domElement.clientWidth,cssHeight:world.renderer.domElement.clientHeight,viewportScale:window.parent.visualViewport?.scale??1,devicePixelRatio}});};
 function publish(){window.parent.postMessage({type:'ui-draft-status',value:get({audit:false})},window.parent.location.origin)}
 function settle(){world.finishLayoutTransition();world.finishCameraMotion();world.finishEnvironmentMotion();world.finishLayoutMotion()}
 installAppearancePreparation(world,prepareRenderer);
 function renderOnce(){if(world.initializingScene)return;const held=world.suspended;world.suspended=false;world.renderFrame();world.suspended=held}
 function localParkingCamera(camera){
  const {position,quaternion,fov,view}=camera;
  const inverse=world.car.quaternion.clone().invert();
  const pivot=world.car.position.clone().add(new THREE.Vector3(0,.85,0)).project(camera);
  return {position:position.clone().sub(world.car.position).applyQuaternion(inverse).toArray(),
   orientation:inverse.multiply(quaternion).toArray(),fov,
   ground:[world.car.position.x,world.car.position.z,world.car.rotation.y],
   offset:view?.enabled?[view.offsetX/view.fullWidth,view.offsetY/view.fullHeight]:[0,0],
   anchor:[pivot.x,pivot.y]};
 }
 function sync(){world.suspended=themeHeld||document.hidden||!!world.initializingScene;drive.setPlaying(!world.draftRoadworksPlayback?.active()&&!themeHeld&&playing&&['road','elevated','ramp'].includes(current()));last=0;accumulator=0;publish()}
 async function waitForRender(){
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const started=performance.now();
  while(world.initializingScene||api.get().busy||document.getElementById('preview').dataset.renderPending==='true'){
   if(performance.now()-started>15000)throw Error('Scene preparation timed out');
   await new Promise(resolve=>setTimeout(resolve,16));
  }
 }
 function setPlaying(value,{newRun=false}={}){
  if(value){
   claimIndicatorAudio();unlockIndicatorSound();
   if(adaptiveTraffic&&roadworksActive())roadworks?.resumeAt(loopTime,{newRun});
   if(newRun&&junctionTurnActive()){junctionRun=null;junctionDepartAfter=0;seekJunction();}
  }
  if(isParking(world.state?.id)){if(value&&(!features.get().path||!parking.start()))value=false;else if(!value)parking.pause();}
  playing=!!value;idlePaused=false;lastInput=performance.now();sync();schedule();
 }
 function seekRoadworks(seconds){
  if(!(roadworksActive()||junctionTurnActive()||parkingEventActive())||exporting||!Number.isFinite(seconds))return;
  cameraHandoff=null;
  loopTime=THREE.MathUtils.clamp(seconds,0,eventDuration());
  setPlaying(false);if(parkingEventActive()){parking.seekEvent(loopTime);renderOnce();}else if(junctionTurnActive())seekJunction();else renderOnce();publish();schedule();
 }
 function toggleRoadworks(){
  if(!(roadworksActive()||junctionTurnActive()||parkingEventActive())||exporting)return;
  const replay=!playing&&loopTime>=eventDuration();
  if(replay)seekRoadworks(0);
  setPlaying(!playing,{newRun:replay});
 }
 function startCameraHandoff(fromRoadworks=null,duration=720){
  cameraHandoff=matchMedia('(prefers-reduced-motion: reduce)').matches?null:{
   from:world.captureCamera(),fromRoadworks,start:null,duration
  };
 }
 function sampleElevatedFrame(now){
  const handoff=exporting?null:cameraHandoff;
  if(handoff)handoff.start??=now;
  const progress=handoff?THREE.MathUtils.clamp((now-handoff.start)/handoff.duration,0,1):1;
  const weight=THREE.MathUtils.smootherstep(progress,0,1);
  if(roadworksActive()&&!world.initializingScene){
   roadworks?.sample(loopTime,roadworksCamera??undefined,handoff?.fromRoadworks,weight);
  }
  if(!handoff)return;
  if(handoff.resting)world.applyCamera({...handoff.resting,carPosition:null});
  if(progress===1){cameraHandoff=null;return;}
  const {from}=handoff;
  const pose=world.captureCamera();
  pose.position.lerp(from.position,1-weight);
  pose.aim.lerp(from.aim,1-weight);
  pose.offset.lerp(from.offset,1-weight);
  pose.quaternion=null;
  pose.carPosition=null;
  world.applyCamera(pose);
  // Keep the vehicle on the same screen path as the two composed endpoints.
  const anchor=pose.anchor.clone().lerp(from.anchor,1-weight);
  const actual=world.car.position.clone().add(new THREE.Vector3(0,.85,0)).project(world.camera);
  world.camera.setViewOffset(1920,1080,pose.offset.x+((actual.x+1)/2-anchor.x)*1920,pose.offset.y+((1-actual.y)/2-anchor.y)*1080,1920,1080);
  world.camera.updateMatrixWorld(true);
 }
 function switchInteraction(event,{params,camera,time,overlay,assist,playing:requested,trafficEnabled,animateCamera=true,liveRoad=false}){
  if(!embedded||exporting)return;
  const scene=current();
  if(scene==='junction'){switchJunctionInteraction(event,{camera,assist,requested});return;}
  if(isParking(world.state?.id)){switchParkingInteraction(event,{camera,assist,requested});return;}
  if(!eventScene(scene))return;
  if(liveRoad&&drivingEvent===event){setPlaying(requested);return;}
  const rampEntrance=scene==='ramp'&&world.state.id==='07';
  const continuous=liveRoad&&drivingEvent!==event&&(!rampEntrance||!event);
  const switchTime=loopTime;
  const view=continuous?world.captureCamera():null;
  const previousRun=continuous&&roadworks?(roadworks.captureRoadRun()
   ?? roadworks.captureRoadCruise(switchTime,drive.draftCapture())):null;
  const outgoingCamera=roadworksCamera??'auto';
  setPlaying(false);
  if(continuous||rampEntrance)world.stopCameraMotion();
  const previous=roadworks?.options;
  const sameSide=drivingEvent==='roadworks'&&event==='roadworks'&&previous?.side===params?.side;
  const blendRoadworks=sameSide&&(previous?.distance!==params.distance||cameraHandoff?.fromRoadworks);
  if(animateCamera)startCameraHandoff(blendRoadworks?world.draftRoadworksFrame:null);
  else cameraHandoff=null;
  const handoff=cameraHandoff;
  setDrivingEvent(event,params);
  roadworksCamera=previousRun&&!event?outgoingCamera:camera;
  if(previousRun)roadworks?.continueRoad(previousRun,switchTime,{camera:roadworksCamera,outgoingCamera,view,trafficEnabled});
  if(typeof trafficEnabled==='boolean'&&world.draftTrafficEnabled!==trafficEnabled){
   world.draftTrafficEnabled=trafficEnabled;
   traffic.setEnabled(trafficEnabled);
  }
  roadworks?.setOverlay(!!overlay);
  features.set({path:!!event||assist},{animate:!!event,render:false});
  loopTime=previousRun?switchTime:event?THREE.MathUtils.clamp(time,0,roadworks?.duration??0):0;
  if(!event&&!previousRun){
   const cameraView=camera==='high'?'high':'low';
   api.setDraftCameraView(cameraView);
   world.configureCamera(world.state.id,{cameraView});
   if(handoff)handoff.resting=world.captureCamera();
  }
  setPlaying(event||previousRun?requested:!matchMedia('(prefers-reduced-motion: reduce)').matches);
  renderOnce();
 }
 function captureJunctionFleet(){
  const {enabled,lanes,positions}=traffic.audit();
  if(!enabled)return null;
  const cars=lanes.map((car,i)=>({...car,z:positions[i][2]})).filter(car=>car.alpha>.02);
  return cars.length?{time:loopTime,cars}:null;
 }
 function updateJunctionTrafficPlan(enabled){
  if(!junctionRun||!junctionTurnActive())return;
  if(loopTime<junctionTiming().turnAt){
   junctionFleet=junctionRun=null;
   junctionDepartAfter=loopTime;
  }else if(!enabled)junctionRun.lateTraffic=null;
 }
 function switchJunctionInteraction(event,{camera,assist,requested}){
  const wasTurning=junctionTurnActive();
  const alreadyStopped=!!junctionPoses&&loopTime*1000>=junctionPoses.motion.duration;
  if(!event&&wasTurning&&loopTime>=junctionTiming().turnAt){
   // Once committed to the turn, keep driving the selected route. Remove
   // event feedback immediately and let the current steering finish.
   junctionEventVisible=false;
   features.set({path:assist},{animate:false,render:false});
   setPlaying(requested||playing);renderOnce();return;
  }
  if(event&&wasTurning){
   if(junctionEventVisible||loopTime>=eventDuration()){seekRoadworks(0);}
   junctionEventVisible=true;
  }else if(event){
   junctionEventVisible=true;
   junctionCamera=camera;
   // Start from the live approach and retain the visible fleet.
   setDrivingEvent(event);
   if(junctionPoses)junctionPoses.key=[world.state.id,world.state.laneCount,true].join('|');
   loopTime=Math.min(loopTime,JUNCTION_LEFT_TIMING.stopAt);
   junctionRun=null;junctionDepartAfter=0;
   junctionFleet=captureJunctionFleet();
  }else{
   junctionSceneCamera=junctionCamera==='auto'?junctionSceneCamera:camera;
   setDrivingEvent(null);
   if(junctionPoses)junctionPoses.key=[world.state.id,world.state.laneCount,false].join('|');
  }
  junctionCameraMotion=null;
  features.set({path:!!event||assist},{animate:!!event&&!alreadyStopped,render:false});
  setPlaying(event?requested:playing||!matchMedia('(prefers-reduced-motion: reduce)').matches);
  if(junctionPoses)seekJunction();else renderOnce();
 }
 function switchParkingInteraction(event,{camera,assist,requested}){
  const state=parking.get();
  if(state.mode==='out')return;
  if(event){
   world.finishCameraMotion();
   setDrivingEvent(event);
   if(camera!=='auto')parking.eventCamera(camera);
  }else{
   parking.detachEvent();
   if(state.interaction&&!state.complete){
    parking.previewCamera(camera);
    parking.finishPreview();
   }
   drivingEvent=null;
   loopTime=0;
  }
  features.set({path:!!event||assist},{animate:false,render:false});
  setPlaying(event?requested:false);
  renderOnce();
 }
 function setRoadworksCamera(camera,{animate=false}={}){
  if(parkingEventActive()&&!exporting&&['auto','low','high'].includes(camera)){
   parking.eventCamera(camera,{animate});renderOnce();publish();schedule();return;
  }
  if(junctionTurnActive()&&!exporting&&['auto','low','high'].includes(camera)){
   if(junctionCamera===camera)return;
   junctionCamera=camera;
   moveJunctionCamera(animate);
   return;
  }
  if(!roadworksActive()||exporting||!['auto','low','high'].includes(camera))return;
  if(animate&&camera===roadworksCamera)return;
  if(animate)startCameraHandoff(cameraHandoff?.fromRoadworks?world.draftRoadworksFrame:null,MANUAL_CAMERA_MS);
  roadworksCamera=camera;
  renderOnce();schedule();
 }
 function setDrivingEvent(event, options){
  if(!embedded||exporting)return;
  const next=DRIVING_EVENTS.includes(event)||event===JUNCTION_LEFT_TURN||isParkingEvent(event)?event:null;
  if(drivingEvent!==next){
   roadworks?.reset();
   junctionCameraMotion=null;
   if(drivingEvent===JUNCTION_LEFT_TURN){
    junctionEventVisible=true;
    junctionFleet=junctionRun=null;junctionDepartAfter=0;
    world.draftJunctionTurnFrame=null;
    world.car.rotation.y=0;
   }
   drivingEvent=next;
   roadworksCamera=null;
  }
  if(roadworks)roadworks.configure(DRIVING_EVENTS.includes(next)?next:null, options);
  else if(DRIVING_EVENTS.includes(next))void ensureRoadworks().then(r=>{if(drivingEvent===next)r?.configure(next,options);});
  if(isParking(world.state?.id)){parking.sync({traffic:world.draftTrafficEnabled,assist:features.get().path});parking.configureEvent(isParkingEvent(next)?next:null);loopTime=0;}
 }
 function setRoadworksMode(enabled){setDrivingEvent(enabled?'roadworks':null);}
 function cutRoadworksSide(side){
  if(!embedded||exporting||drivingEvent!=='roadworks'||!roadworks||side===roadworks.options.side)return;
  cameraHandoff=null;
  world.stopCameraMotion();
  roadworks.configure('roadworks',{...roadworks.options,side});
  renderOnce();publish();schedule();
 }
 function setEventOverlay(value){
  if(drivingEvent!=='collision'||exporting)return;
  roadworks?.setOverlay(!!value);
  renderOnce();
 }
 function restartJunctionPath(){if(current()!=='junction'||!features.get().path)return;features.set({path:false},{animate:false,render:false});features.set({path:true},{animate:true,render:false});renderOnce();}
 let junctionExportCamera=null;
 const junctionView={position:new THREE.Vector3(),aim:new THREE.Vector3(),offset:new THREE.Vector2()};
 const junctionAnchor=new THREE.Vector2(),junctionProjected=new THREE.Vector3();
 const junctionHighAim=new THREE.Vector3();
 function junctionCameraHeight(mode,motion,turn){
  if(mode==='low')return 0;
  if(mode==='high')return 1;
  if(!turn||loopTime*1000<motion.duration)return motion.liftAt(loopTime*1000);
  const t=THREE.MathUtils.clamp((loopTime-junctionTiming().clearAt)/1.5,0,1);
  // Keep the former lift and return timing; the view rotates with the ego.
  if(t<.2)return 1-t*t/.32;
  if(t>.8)return (1-t)**2/.32;
  return 1-(t-.1)/.8;
 }
 function moveJunctionCamera(animate){
  junctionCameraMotion=null;
  if(animate&&junctionPoses&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
   const from=world.captureCamera(), yaw=-world.car.rotation.y;
   for(const key of ['position','aim'])from[key].sub(from.carPosition).applyAxisAngle(THREE.Object3D.DEFAULT_UP,yaw);
   junctionCameraMotion={from,start:performance.now()};
   lastInput=junctionCameraMotion.start;
  }
  seekJunction();schedule();
 }
 function sampleJunctionCamera(now){
  if(junctionExportCamera||!embedded)return;
  const {motion}=junctionPoses,{from,to}=motion,turn=junctionTurnActive();
  const mode=turn?junctionCamera:junctionSceneCamera;
  const height=junctionCameraHeight(mode,motion,turn),{position,aim,offset}=junctionView;
  const car=world.car;
  position.copy(from.position).sub(from.carPosition);
  aim.copy(from.aim).sub(from.carPosition);
  offset.copy(from.offset);
  junctionAnchor.copy(from.anchor);
  if(height>0){
   // Sample the original lift arc around the ego's screen anchor.
   motion.liftPosition(position,height).y+=.85;
   aim.lerp(junctionHighAim.copy(to.aim).sub(to.carPosition),height);
   offset.lerp(to.offset,height);
   junctionAnchor.lerp(to.anchor,height);
  }
  const handoff=exporting?null:junctionCameraMotion;
  let manual=1;
  if(handoff){
   manual=manualCameraBlend(now-handoff.start);
   position.lerp(handoff.from.position,1-manual);
   aim.lerp(handoff.from.aim,1-manual);
   offset.lerp(handoff.from.offset,1-manual);
   if(manual===1)junctionCameraMotion=null;
  }
  const yaw=car.rotation.y, up=THREE.Object3D.DEFAULT_UP;
  position.applyAxisAngle(up,yaw).add(car.position);
  aim.applyAxisAngle(up,yaw).add(car.position);
  world.applyCamera(junctionView);
  world.framing=(height===0?from:to).framing;
  if(height>0&&height<1||manual<1){
   if(manual<1)junctionAnchor.lerp(handoff.from.anchor,1-manual);
   junctionProjected.copy(car.position);junctionProjected.y+=.85;junctionProjected.project(world.camera);
   world.camera.setViewOffset(1920,1080,offset.x+((junctionProjected.x+1)/2-junctionAnchor.x)*1920,offset.y+((1-junctionProjected.y)/2-junctionAnchor.y)*1080,1920,1080);
  }
 }
 function sampleJunctionEvent(now){
  if(current()!=='junction'||world.initializingScene||!world.root||!junctionPoses){
   world.draftJunctionTurnFrame=null;
   return;
  }
  if(!junctionTurnActive()){
   world.draftJunctionTurnFrame=null;
   sampleJunctionCamera(now);
   return;
  }
  const base=junctionPoses.motion.to;
  const stop=base.carPosition;
  const trafficEnabled=world.draftTrafficEnabled,axles=junctionAxles();
  if(junctionRun&&trafficEnabled&&loopTime<junctionTiming().turnAt){
   const previous=junctionRun.axles;
   if(previous!==axles&&(previous.wheelbase!==axles.wheelbase||previous.rearOffset!==axles.rearOffset||previous.length!==axles.length||previous.width!==axles.width)){
    junctionFleet={time:loopTime,cars:junctionRun.sample(loopTime).traffic};
    junctionRun=null;junctionDepartAfter=loopTime;
   }
  }
  if(!junctionRun){
   const fleet=trafficEnabled?(junctionFleet??captureJunctionFleet()):{time:loopTime,cars:[]};
   const run=planJunctionTurn(makeRandom(crypto.getRandomValues(new Uint32Array(1))[0]),stop.z,fleet,world.junctionDimensions?.markingEnd,junctionDepartAfter,axles);
   run.axles=axles;
   run.trafficEnabled=trafficEnabled;
   run.feedback=createTrafficFeedback(time=>{const ego=run.sample(time);return {ego,traffic:ego.traffic};},{duration:run.timing.duration});
   junctionRun=run;
  }
  const sample=junctionRun.sample(loopTime,axles);
  const atStop=loopTime>=JUNCTION_LEFT_TIMING.stopAt;
  if(atStop){
   world.car.position.set(sample.x,stop.y,sample.z);
   world.car.rotation.y=sample.yaw;
   world.draftSpeed=sample.speed;
  }
  sampleJunctionCamera(now);
  const ego={x:world.car.position.x,z:world.car.position.z,yaw:world.car.rotation.y,speed:world.draftSpeed??0};
  // Once a turn has started, keep its trajectory. Newly enabled cross traffic
  // approaches after the ego clears instead of spawning into its path.
  const cars=!trafficEnabled?[]:junctionRun.trafficEnabled?sample.traffic:
   (junctionRun.lateTraffic??=createTrafficAfterJunctionCommit(makeRandom(crypto.getRandomValues(new Uint32Array(1))[0]),
    loopTime,ego,junctionTiming().clearAt,world.junctionDimensions?.markingEnd))(loopTime);
  const frontOffset=axles.rearOffset-axles.wheelbase;
  world.draftJunctionTurnFrame={...sample,stopLineZ:(world.junctionDimensions?.markingEnd??-22.55)+.24,
   frontX:atStop?sample.frontX:ego.x+Math.sin(ego.yaw)*frontOffset,
   frontZ:atStop?sample.frontZ:ego.z+Math.cos(ego.yaw)*frontOffset,
   wheelDistance:atStop?-stop.z+sample.distance:-ego.z,
   liveTraffic:true,
   traffic:cars.map(car=>({...car,z:car.z-ego.z,
    ...(junctionEventVisible&&junctionRun.trafficEnabled?feedbackFields(junctionRun.feedback(car.id,loopTime)):{}),
   }))};
 }
 function seekJunction(){
  if(current()!=='junction'||!world.state||!world.root||world.initializingScene)return;
  world.car.rotation.y=0;
  const key=[world.state.id,world.state.laneCount,junctionTurnActive()].join('|');
  if(!junctionPoses||junctionPoses.key!==key){
   if(world.state.id==='05')world.car.position.x=1.85;
   const state={...world.state};world.update({...state,junctionPosition:'approaching',cameraView:'low'},{deferRender:true});const from=world.captureCamera();world.update({...state,junctionPosition:'near',cameraView:'high'},{deferRender:true});
   world.startCameraMotion(from);
   const motion=world.cameraMotion;cancelAnimationFrame(motion.frame);motion.paused=true;world.cameraMotion=null;junctionPoses={key,motion};
  }
  const complete=loopTime*1000>=junctionPoses.motion.duration;
  world.draftSpeed=complete?0:junctionPoses.motion.speedAt(loopTime*1000);
  world.draftJunctionBraking=true;world.draftJunctionElapsed=loopTime;
  junctionPoses.motion.sample(Math.min(loopTime*1000,junctionPoses.motion.duration),0,embedded);
  // Ego stop does not end the cross-traffic simulation.
 }
 function step(seconds){if(!world.state||!world.root||world.initializingScene)return;world.draftTime+=seconds*1000;const demo=world.draftRoadworksPlayback;if(demo?.active()){loopTime=Math.min(demo.duration,loopTime+seconds);if(loopTime>=demo.duration)playing=false;world.renderFrame();return;}loopTime+=seconds;drive.advance(seconds);if(isParking(world.state.id)){parking.step(seconds);const parked=parking.get();if(parkingEventActive())loopTime=parked.elapsed;if(!parked.active)playing=false;world.renderFrame();}else if(current()==='junction'){if(world.draftJunctionTurnActive?.()){const end=eventDuration();if(loopTime>=end){loopTime=end;playing=false;}}else if(!world.draftJunctionFreeTraffic&&junctionPoses&&loopTime*1000>=junctionPoses.motion.duration)playing=false;seekJunction();}else if(!world.cameraMotion&&!world.layoutMotion&&!world.environmentMotion&&!world.structureMotion)world.renderFrame()}
 const visualMotion=()=>!!cameraHandoff||!!junctionCameraMotion||traffic.animating?.()||!!world.layoutMotion||!!world.environmentMotion||!!world.cameraMotion||(world.draftIndicatorActive&&!junctionTurnActive())||parking.animating()||appearance.active()||world.draftWeatherActive||features.animating()||world.activationSweep?.active();
 function schedule(){if(scenePreparing||world.initializingScene||frame||!playing&&!visualMotion()||document.hidden||exporting||themeHeld||world.draftParkedBlend)return;frame=requestAnimationFrame(tick)}
 for(const hook of ['onEnvironmentFrame','onCameraFrame']){const prev=world[hook];world[hook]=active=>{prev?.(active);if(active)schedule();};}
 let lastPublish=0,lastReplayReady=false;
 function tick(now){
  frame=0;if(scenePreparing||!playing&&!visualMotion()||document.hidden||exporting||themeHeld||world.draftParkedBlend)return;
  if(!world.state||!world.root||world.initializingScene){last=0;schedule();return}
  if(originRoot!==world.root&&traffic.audit().modelReady){drive.rebind();if(!world.layoutMotion)world.renderFrame();origin=capture();originRoot=world.root}
  if(now-lastInput>=300000&&!(embedded&&!drivingEvent&&(eventScene(current())||current()==='junction'))){idlePaused=true;playing=false;sync();return}
  // Seekable runs sample the route and fleet at a timestamp. Keep their
  // playback clock independent of the display's render cadence.
  const elapsed=last?(now-last)/1000:0;last=now;
  // Lane morphing and scenery share one timestamp, including paused edits.
  const laneMotion=world.layoutMotion,envMotion=world.environmentMotion,camMotion=world.cameraMotion;
  accumulator+=Math.min(.1,elapsed);
  // Junction samples the ego and camera together. Do not alternate held
  // and doubled steps when the display changes cadence during the approach.
  const seekable=playing&&(junctionTurnActive()||world.draftRoadworksPlayback?.active());
  const next=laneMotion?{seconds:Math.min(.1,elapsed),remaining:0}
   :seekable?{seconds:elapsed,remaining:0}:frameStep(accumulator,elapsed,playing&&current()==='junction');
  accumulator=next.remaining;
  const wasPlaying=playing;
  if(next.seconds>0){if(playing)step(next.seconds);else{world.draftTime+=next.seconds*1000;if(junctionCameraMotion)seekJunction();else if(!laneMotion&&!envMotion&&!camMotion)renderOnce()}}
  if(laneMotion&&!laneMotion.paused)laneMotion.tick(now);
  if(envMotion&&world.environmentMotion===envMotion)envMotion.tick(now);
  if(camMotion&&world.cameraMotion===camMotion&&!camMotion.paused)camMotion.tick(now);
  // A retained bay belongs to the parking scene. Reading its progress here
  // would replan against the moving Junction ego on every animation frame.
  const replayReady=isParking(world.state.id)&&!!parking.get().replayReady;
  if(wasPlaying!==playing||replayReady!==lastReplayReady||now-lastPublish>200||!playing&&!visualMotion()){lastPublish=now;lastReplayReady=replayReady;publish()}
  schedule();
 }
 function capture(){const objects=[];world.scene.traverse(object=>objects.push({object,position:object.position.clone(),rotation:object.rotation.clone(),scale:object.scale.clone(),visible:object.visible,growthBaseY:object.userData.growthBaseY,growthHeight:object.userData.growthHeight}));return {objects,parking:parking.capture(),wheelDistance:world.draftWheelDistance,drive:drive.draftCapture(),traffic:traffic?.draftCapture(),time:world.draftTime,loopTime,speed:world.draftSpeed,sceneryRandom:world.draftSceneryRandom.state(),trafficRandom:world.draftTrafficRandom.state(),width:world.width,height:world.height,pose:world.captureCamera()}}
 function restore(saved){for(const item of saved.objects){const {object}=item;object.position.copy(item.position);object.rotation.copy(item.rotation);object.scale.copy(item.scale);object.visible=item.visible;for(const key of ['growthBaseY','growthHeight'])if(item[key]===undefined)delete object.userData[key];else object.userData[key]=item[key]}
  if(saved.parking)parking.restore(saved.parking);world.draftWheelDistance=saved.wheelDistance;drive.draftRestore(saved.drive);if(saved.traffic)traffic.draftRestore(saved.traffic);world.draftTime=saved.time;loopTime=saved.loopTime;world.draftSpeed=saved.speed;world.draftSceneryRandom.restore(saved.sceneryRandom);world.draftTrafficRandom.restore(saved.trafficRandom);world.applyCamera(saved.pose);world.setResolution(saved.width,saved.height);world.renderer.shadowMap.needsUpdate=true;world.shadowKey='';world.groundReflectionKey='';world.carReflectionKey='';}
 async function exportScene({format='png',width=3840,duration=10,onProgress=()=>{},cameraPose=null,signal}={}){
  const eventVideo=format==='video'&&!!drivingEvent&&(roadworksActive()||junctionTurnActive()||parkingEventActive());
  const startTime=eventVideo&&roadworksActive()?(roadworks?.eventStart??0):0;
  if(eventVideo)duration=Math.ceil((eventDuration()-startTime)*30-1e-8)/30;
  const size=exportSize(format,width);
  if(exporting)throw Error('An export is already running');
  while(features.animating()||world.activationSweep?.active()){
   signal?.throwIfAborted();
   if(!playing)break;
   await new Promise(resolve=>requestAnimationFrame(resolve));
  }
  signal?.throwIfAborted();
  await api.ensureFullVehicle?.();
  signal?.throwIfAborted();
  const exportTools=format==='video'?null:await loadExportModule();
  signal?.throwIfAborted();
  settle();exporting=true;const saved=capture(),wasPlaying=playing;drive.pause();world.suspended=false;cancelAnimationFrame(frame);frame=0;
  let result;
  try{
   junctionExportCamera=!eventVideo&&cameraPose;
   world.setResolution(size.width,size.height);if(cameraPose)world.applyCamera(cameraPose);if(eventVideo)loopTime=startTime;if(parkingEventActive()&&eventVideo)parking.seekEvent(0);if(junctionTurnActive()&&eventVideo)seekJunction();else world.renderFrame();
   if(format==='png')result={blob:await exportTools.stillPng(world,size),extension:'png'};
   else if(format==='camera')result={blob:new Blob([JSON.stringify(exportTools.cameraMetadata(world,{sceneName:current(),sourceUrl:location.href}),null,2)],{type:'application/json'}),extension:'json'};
   else if(format==='depth'){const depth=exportTools.renderDepth(world);result={blob:await exportTools.depthPng(depth,size.width,size.height),extension:'png'}}
   else if(format==='kit'){
    const metadata=exportTools.cameraMetadata(world,{sceneName:current(),sourceUrl:location.href}),image=await exportTools.stillPng(world,size);
    signal?.throwIfAborted();
    const depth=exportTools.renderDepth(world),depthImage=await exportTools.depthPng(depth,size.width,size.height);
    signal?.throwIfAborted();
    result={blob:await exportTools.zipFiles([['scene.png',image],['perspective.svg',exportTools.perspectiveSvg(world)],['camera.json',JSON.stringify(metadata,null,2)],['depth.png',depthImage]]),extension:'zip'};
   }
   else{
    const {encodeVideo}=await loadVideoModule();
    signal?.throwIfAborted();
    if(!eventVideo)drive.setPlaying(true);if(isParking(world.state?.id)&&features.get().path)parking.start();
    result=await encodeVideo(world.renderer.domElement,{duration,signal,render(index){if(eventVideo){loopTime=startTime+Math.min(duration,index/30);if(parkingEventActive()){parking.seekEvent(loopTime);world.renderFrame();}else if(junctionTurnActive())seekJunction();else world.renderFrame();}else if(index>0)step(1/30);onProgress(Math.round((index+1)/(duration*30)*100))}});
   }
   signal?.throwIfAborted();
   result.audit={format,...size,duration:format==='video'?duration:0,frames:format==='video'?duration*30:1,startDistance:saved.drive.distance,exportEndDistance:drive.audit().distance,extension:result.extension,wasPlaying};
   return result;
  }finally{junctionExportCamera=null;restore(saved);exporting=false;playing=wasPlaying;lastInput=performance.now();sync();renderOnce();schedule()}
 }
 const bridge={get,parkingEntryBottom(){
  if(!world.state||isParking(world.state.id)||world.framing?.group!=='low'||world.cameraMotion||cameraHandoff||world.draftRoadworksFrame||junctionTurnActive())return;
  const {bottom}=vehicleFrame(world.car,world.camera);
  return Number.isFinite(bottom)?bottom:undefined;
 },
 clearRoadRun:()=>roadworks?.clearRoadRun(),seekRoadworks,toggleRoadworks,cutRoadworksSide,setRoadworksCamera,setRoadworksMode,setDrivingEvent,setEventOverlay,switchInteraction,parkingCamera(values,{render=true}={}){const settings=parking.configureCamera(values);if(render)renderOnce();publish();schedule();return settings;},roadShadow(value,{render=true}={}){const stored=world.draftRoadShadowStrength??={ego:1,traffic:1};const setting=Number.isFinite(value)?{ego:value,traffic:value}:value||{};for(const key of ['ego','traffic'])if(Number.isFinite(setting[key]))stored[key]=Math.max(0,Math.min(key==='ego'?4:2,setting[key]));if(render)renderOnce();return {...stored};},parkingFinish(values={},{render=true}={}){const finish=world.draftParkingFinish??={bay:{value:1},column:{value:1}};const repaint=['traffic','trafficGray'].some(key=>Number.isFinite(values[key])&&values[key]!==finish[key]?.value);for(const key of ['bay','column','traffic','trafficGray','blue','ground','shadow',...Object.keys(indoorShadowLimits)])if(Number.isFinite(values[key])){const [min,max]=indoorShadowLimits[key]??[0,['blue','trafficGray'].includes(key)?1:2];(finish[key]??={value:1}).value=Math.max(min,Math.min(max,values[key]));}if(repaint){world.carReflectionKey=null;world.groundReflectionKey=null;}if(render)renderOnce();return Object.fromEntries(Object.entries(finish).map(([key,u])=>[key,u.value]));},suspendIndicator(){audioHeld=true;stopIndicatorSound()},audit:()=>({...world.audit(),indoorLighting:{reflectionRaster:world.carMirror?{width:world.carMirror.getRenderTarget().width,height:world.carMirror.getRenderTarget().height}:null,contactProfile:1,settings:Object.fromEntries(Object.entries(world.draftParkingFinish||{}).map(([k,u])=>[k,u.value])),receiver:world.parkingShadow?{opacity:world.parkingShadow.material.opacity,visible:world.parkingShadow.visible,position:world.parkingShadow.position.toArray(),order:world.parkingShadow.renderOrder}:null,light:{position:world.sun.position.toArray(),target:world.sun.target.position.toArray(),radius:world.sun.shadow.radius,intensity:world.sun.shadow.intensity},contacts:world.draftParkingGroup?.children.filter(o=>o.userData.indoorContact).map(o=>({ego:o.userData.egoContact,visible:o.visible,ambientScale:o.children[0].scale.toArray(),strength:o.children[0].material.uniforms.shadowStrength.value,coverage:o.children[0].material.uniforms.coverage.value}))},occluders:world.draftOccluders||0,parkingCamera:world.captureCamera().position.toArray(),parkingBays:(world.parkingBays||[]).map(b=>{const p=new THREE.Vector3(b.x,.03,b.z).project(world.camera);return {x:b.x,z:b.z,width:b.width,depth:b.depth,screen:[(p.x+1)/2,(1-p.y)/2]}})}),resources(){const info=world.renderer.info;return {geometries:info.memory.geometries,textures:info.memory.textures,programs:info.programs?.length??0,...(new URLSearchParams(window.parent.location.search).has('qa')?{programKeys:info.programs?.map(p=>p.cacheKey)}:{}),drawCalls:info.render.calls,triangles:info.render.triangles,heapBytes:performance.memory?.usedJSHeapSize??null}},setPlaying,toggle(){if(current()==='junction')bridge.junctionPlay();else setPlaying(!playing)},async param(key,value,{sound=false}={}){
  if(exporting)return;
  if(key==='camera'&&eventScene(current())&&roadworks?.cruisingRoad){
   api.setDraftCameraView(value);setRoadworksCamera(value,{animate:true});return;
  }
  if(key==='camera'&&current()==='junction'&&embedded&&!junctionTurnActive()){
   junctionSceneCamera=value;moveJunctionCamera(true);publish();return;
  }
  if(key==='camera'&&isParking(world.state?.id)){
   if(parking.get().active)return;
   lastInput=performance.now();idlePaused=false;last=0;accumulator=0;parking.previewCamera(value);renderOnce();publish();schedule();return;
  }
  // A narrower road cannot retain a completed maneuver's old lane offset.
  const resetCruise=key==='lanes'&&current()==='road'&&!drivingEvent&&roadworks?.cruisingRoad;
  if(resetCruise){roadworks?.reset();cameraHandoff=null;roadworksCamera=null;}
  const parkedPose=key==='model'&&isParking(world.state?.id)&&parking.get().elapsed>0?{position:world.car.position.clone(),rotation:world.car.rotation.clone()}:null;if(parkedPose)setPlaying(false);
  const parkingRunBefore=key==='model'&&parkingEventActive()?parking.capture():null;
  const previousTraffic=world.draftTrafficEnabled;if(key==='traffic'){
   if(previousTraffic!==!!value&&world.draftRoadworksFrame&&drivingEvent==='roadworks'&&roadworksActive()&&!adaptiveTraffic)startCameraHandoff(world.draftRoadworksFrame);
   if(current()!=='junction')world.draftTrafficEnabled=!!value;
  }if(current()==='junction'&&key==='layout'){playing=false;loopTime=0;junctionPoses=null}
  const held=world.suspended;world.suspended=false;
  try {
   if(key==='traffic'&&value)try{await world.draftPrepareStartup(current(),true);if(isParking(world.state?.id)){await world.draftPrepareAppearance?.({preserveScreen:true});if(!previousTraffic)parking.revealTraffic?.();}}catch(error){world.draftTrafficEnabled=previousTraffic;traffic.setEnabled(previousTraffic);renderOnce();publish();throw error;}
   if(key==='traffic'&&previousTraffic!==!!value&&world.draftRoadworksFrame&&(drivingEvent==='roadworks'||roadworks?.cruisingRoad)&&roadworksActive()&&adaptiveTraffic){
    roadworks?.setTrafficAt(loopTime,!!value);
   }
   if(key==='layout'&&current()==='ramp')await api.prepareDraftLayout(value);else await api.param(key,value,{sound,animate:key!=='path'||!isParking(world.state?.id)});
  }finally{world.suspended=held;}
  // Model selection already awaits preparation and renders the committed car.
  if(!['path','weather','traffic','autoplay','model'].includes(key))await waitForRender();
  if(key==='model'&&api.get().vehicle!==value)throw Error('Could not switch vehicle. Please try again.');
  if(parkedPose){world.car.position.copy(parkedPose.position);world.car.rotation.copy(parkedPose.rotation);}
  if(parkingRunBefore){parking.configureEvent(drivingEvent);parking.eventCamera(parkingRunBefore.eventCamera);parking.seekEvent(parkingRunBefore.elapsed);loopTime=parking.get().elapsed;}
  if(key==='weather')world.draftWeatherActive=true;if(key==='path'&&isParking(world.state?.id)){if(!value)setPlaying(false);}
  if(current()==='junction'){
   if(key==='traffic'){
    world.draftTrafficEnabled=!!value;
    if(previousTraffic!==!!value)updateJunctionTrafficPlan(!!value);
   }
   if(key==='layout')prepareSceneThemes(world);
   seekJunction();if(key==='layout')restartJunctionPath();
  }else if(!playing||key==='traffic')renderOnce();
  if(resetCruise)sync();
  publish();schedule();
 },async scene(key,seed,values,entryBottom,interaction){
  const targetTraffic=!!values?.traffic;
  const leavingJunction=current()==='junction'&&key!=='junction';
  // Keep the current route and fleet plan, including traffic added after commitment.
  const outgoingTurn=leavingJunction&&junctionTurnActive()&&junctionEventVisible&&junctionRun?
   {run:junctionRun,fleet:junctionFleet,departAfter:junctionDepartAfter,time:loopTime,camera:junctionCamera,traffic:world.draftTrafficEnabled}:null;
  const returningTurn=key==='junction'&&interaction?.event===JUNCTION_LEFT_TURN?savedJunctionTurn:null;
  scenePreparing=true;cancelAnimationFrame(frame);frame=0;audioHeld=true;stopIndicatorSound();
  world.suspended=true;
  try{
   await world.draftPrepareStartup(key,targetTraffic,interaction?interaction.event:drivingEvent);
   appearance.finish();settle();
   const saved=values?capture():null;
   world.draftParkingEntryBottom=entryBottom;
   const commitMotion=()=>{
    const entry=saved&&world.captureCamera(),rotation=entry&&world.car.rotation.clone();
    parking.reset();world.draftRoadworksPlayback?.reset();drive.reset();playing=false;resetIndicatorSound();
    if(entry){world.applyCamera(entry);world.car.rotation.copy(rotation);}
    cameraHandoff=null;junctionCameraMotion=null;junctionSceneCamera=values?.camera==='high'?'high':null;
    junctionEventVisible=true;junctionCamera='auto';
    world.draftSceneryRandom.reset(seed);junctionPoses=junctionFleet=junctionRun=null;junctionDepartAfter=0;loopTime=0;world.draftTrafficEnabled=targetTraffic;
   };
   if(values){
    try{await api.prepareDraftScene(key,values,commitMotion);}
    catch(error){
     if(error.sceneUnrecoverable){world.initializingScene=true;playing=false;}
     else {if(originRoot!==world.root){drive.rebind();originRoot=world.root;}restore(saved);world.framing=saved.pose.framing;renderOnce();}
     throw error;
    }
   }else{commitMotion();api.scene(key);}
   if(interaction)setDrivingEvent(interaction.event,interaction.params);
   if(leavingJunction)savedJunctionTurn=outgoingTurn;
   if(returningTurn){
    junctionRun=returningTurn.run;
    junctionFleet=returningTurn.fleet;
    junctionDepartAfter=returningTurn.departAfter;
    loopTime=returningTurn.time;
    junctionCamera=returningTurn.camera;
    if(returningTurn.traffic!==targetTraffic)updateJunctionTrafficPlan(targetTraffic);
   }
   world.suspended=false;await waitForRender();
   if(['road','junction','ramp','parking'].includes(key))prepareSceneThemes(world);
   if(key==='junction'){
    seekJunction();
    if(!returningTurn)restartJunctionPath();
   }
   return !!returningTurn;
  }finally{
   world.draftParkingEntryBottom=undefined;audioHeld=false;scenePreparing=false;sync();schedule();
  }
 },
 finishScene({playing:requested}={}){settle();parking.finishPreview?.();if(current()==='junction')seekJunction();setPlaying(!isParking(world.state?.id)&&(typeof requested==='boolean'?requested:(['road','elevated','ramp'].includes(current())||embedded&&current()==='junction')&&!matchMedia('(prefers-reduced-motion: reduce)').matches));renderOnce()},
 parkingComposition(destination){
  if(!isParking(world.state?.id)||playing||world.initializingScene)return null;
  const state=parking.get();
  if(!state.complete||state.camera.tween||world.cameraMotion)return null;
  if(destination){
   const pose=parkingViewPose(world.camera,world.car,parkingCameraChoice(destination),world.car.rotation.y,world.draftParkingLowShift);
   const camera=world.camera.clone();
   camera.position.copy(pose.position);camera.quaternion.copy(pose.quaternion);
   camera.setViewOffset(1920,1080,pose.offset.x,pose.offset.y,1920,1080);
   camera.updateMatrixWorld(true);
   return localParkingCamera(camera);
  }
  return localParkingCamera(world.camera);
 },
 paintParkedBlend(pose,destination,liveWeight=1,frameTime){
  if(!pose){
   if(!world.draftParkedBlend&&!destination)return world.renderer.domElement;
   world.draftParkedBlend=false;
   if(destination&&isParking(world.state?.id)){
    if(parkingEventActive())parking.eventCamera(destination);
    else {parking.previewCamera(destination);parking.finishPreview();}
   }
   last=0;renderOnce();schedule();return world.renderer.domElement;
  }
  if(!isParking(world.state?.id)||playing||world.initializingScene)return;
  world.draftParkedBlend=true;
  const liveFrameTime=frameTime===undefined?undefined:frameTime-performance.timeOrigin;
  parking.paintHandoffBay(features.get().path,liveWeight,liveFrameTime);
  parkedBlendCamera??=world.camera.clone();
  const camera=parkedBlendCamera.copy(world.camera,false),orientation=world.car.quaternion;
  camera.position.fromArray(pose.position).applyQuaternion(orientation).add(world.car.position);
  camera.quaternion.fromArray(pose.orientation).premultiply(orientation);
  camera.fov=pose.fov;
  camera.setViewOffset(world.width,world.height,pose.offset[0]*world.width,pose.offset[1]*world.height,world.width,world.height);
  camera.updateMatrixWorld(true);
  // Keep the same exposure, antialiasing and output conversion as the live preview.
  const pass=world.composer.passes[0];
  pass.camera=camera;
  try{world.composer.render();}
  finally{pass.camera=world.camera;}
  return world.renderer.domElement;
 },
 restoreParkedPreview(){
  if(!isParking(world.state?.id)||drivingEvent||world.initializingScene||playing)return false;
  parking.sync({traffic:world.draftTrafficEnabled,assist:false});
  if(!parking.get().complete){
   if(!parking.selectDefault()||!parking.start())return false;
   parking.step(.9);
   parking.step(120);
  }
  parking.finishPreview();
  renderOnce();
  publish();
  return !!bridge.parkingComposition();
 },
 beginTheme(){themeHeld=true;cancelAnimationFrame(frame);frame=0;sync()},
 endTheme(){themeHeld=false;last=0;sync();schedule()},
 theme(value,{animate=false,deferBlend=false}={}){
  if(deferBlend){themeTarget=value;return;}
  themeTarget=undefined;
  if(!animate)appearance.finish();
  const from=animate?appearanceSnapshot(world):null;
  api.setDraftTheme(value);
  world.draftRememberSkyAppearance?.();
  world.draftThemeTone.value=value==='dark'?1:0;
  if(from)appearance.start(from,appearanceSnapshot(world),performance.now());
  if(!playing&&!animate)renderOnce();
  publish();schedule();
 },
 prepareParkingAssets(){return parking.ready},
 prepareEventTraffic(){return Promise.all([traffic.ready,ensureRoadworks()])},
 startThemeBlend(){if(themeTarget)bridge.theme(themeTarget,{animate:true});},
 themeStatus(){return {blending:appearance.active(),renderedFrames,held:themeHeld}},
 prepareExit(){setPlaying(false);parking.prepareExit();renderOnce();publish();schedule()},chooseExit(direction){parking.chooseExit(direction);renderOnce();publish();schedule()},
 replay(){audioHeld=true;resetIndicatorSound();try{settle();if(isParking(world.state?.id)){parking.reset({replay:true});renderOnce();publish();return;}traffic.setEnabled(false);traffic.setEnabled(!!world.draftTrafficEnabled);loopTime=0;const held=world.suspended;world.suspended=false;seekJunction();restartJunctionPath();renderOnce();world.suspended=held;publish();schedule()}finally{audioHeld=false}},
 async parkingPlay({depart=false}={}){
  if(exporting||world.initializingScene)return;
  if(playing){setPlaying(false);await bridge.param('path',false,{sound:true});return;}
  try{
   if(depart){
    if(!parking.prepareExit())return;
    drivingEvent=null;loopTime=0;
    parking.previewCamera('low');
    parking.chooseExit(-1);
   }else if(parking.get().complete)bridge.replay();
   parking.sync({traffic:world.draftTrafficEnabled??false,assist:features.get().path});
   if(parking.get().mode!=='out'&&!parking.selectDefault())throw Error('No reachable empty space. Turn off Traffic and try again.');
   if(!features.get().path)await bridge.param('path',true,{sound:true});
   parking.sync({traffic:world.draftTrafficEnabled??false,assist:true});setPlaying(true);
  }catch(error){setPlaying(false);if(features.get().path)await bridge.param('path',false,{sound:false});throw error;}
 },
 junctionPlay(){if(junctionTurnActive()){toggleRoadworks();return;}if(playing){setPlaying(false);return}if(junctionPoses&&loopTime*1000>=junctionPoses.motion.duration)bridge.replay();setPlaying(true)},
 renderReplayFrame(){renderOnce();publish()},
 completeStartup(){sync();renderOnce();world.draftInitialFrameReady=true;document.getElementById('preview').setAttribute('aria-busy','false');schedule();publish();world.draftScheduleFullVehicle?.();world.draftScheduleIdleWarmup?.()},
 export:exportScene,async videoFormat(){return (await loadVideoModule()).videoType()},resize(width){if(exporting)return;const raster=previewPixels(width,devicePixelRatio,window.parent.visualViewport?.scale??1,globalThis.__draftPreviewLimit);if(world.width===raster.width&&world.height===raster.height)return;world.setResolution(raster.width,raster.height);renderOnce();publish()},
 capture,restore,canvas:world.renderer.domElement,restart(){if(!origin)return false;const held=world.suspended;world.suspended=false;restore(origin);world.renderFrame();world.suspended=held;publish();return true},advance(seconds){const held=world.suspended;world.suspended=false;step(seconds);world.suspended=held;publish()},
 async snapshot(){const {canvasPng}=await loadExportModule();return canvasPng(world.renderer.domElement)},
 input(){claimIndicatorAudio();lastInput=performance.now();if(idlePaused)setPlaying(true)}
 };
 api.draft=bridge;

 document.addEventListener('visibilitychange',()=>{if(document.hidden){stopIndicatorSound();cancelAnimationFrame(frame);frame=0;world.suspended=true;drive.pause()}else{lastInput=performance.now();sync();if(!scenePreparing&&!themeHeld)renderOnce();schedule()}},true);
 window.parent.addEventListener('blur',()=>{indicatorOwnsAudio=false;stopIndicatorSound()});window.addEventListener('pagehide',stopIndicatorSound);
 for(const event of ['pointerdown','wheel'])window.parent.addEventListener(event,bridge.input,{passive:true});
 matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{if(event.matches)setPlaying(false)});
 sync();schedule();
}
