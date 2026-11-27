import {isParkingEvent} from './parking-event-types.js';
import {applySkyAppearance} from './sky-appearance.js';
import {parkingCameraChoice,MANUAL_CAMERA_MS} from './manual-camera.js';
import {createTrafficReveal,applyTrafficGrowth,trafficEntryOpacity} from './traffic-reveal.js';
import {parkingTargetFragment,parkingPathFragment,parkingStopFragment,syncIndoorVehicleContacts,syncIndoorColumns,updateIndoorContactOpacity,syncParkingCastShadows,syncOutdoorLawns,createParkingSightTarget} from './parking-materials.js';
import * as THREE from 'three';
import {vehicleFrame} from '../engine/framing.js';
import {sampleParkingView,parkingFrame,captureParkingView,parkingViewPose,applyParkingView,parkingManeuverView,parkingRoutePoints,followParkingManeuver,alignParkingManeuver,blendParkingManeuver,orbitParkingManeuver,projectParkingManeuver,PARKING_SETTLE_MS} from './parking-camera.js';
import {updateParkingOcclusion} from './parking-occlusion.js';
import {parkingVehicle} from './parking-kinematics.js';
import {parkingPose,parkingTiming,parkingSegment,parkingPlan,exitPose,PARKING_EXIT_SECONDS,localBay,worldPose,reverseReplan} from './parking-motion.js';
import {createTrafficVehicle,readyTrafficModel,setTrafficAppearance} from '../engine/traffic-model.js';
import {prepareParkingMaterialStructure} from './saved-preview/parking-material-structure.mjs';

const clamp=THREE.MathUtils.clamp, smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t)};
// One slow breath confirms arrival before the complete bay fades away.
const completionRiseMs=900,completionFallMs=900,completionBreathMs=completionRiseMs+completionFallMs,completionCycles=1,completionPulseMs=completionBreathMs*completionCycles,completionFadeMs=600,completionDuration=completionPulseMs+completionFadeMs;
const bayFadeMs=1000,bayFadeLeadMs=300;
const isIndoorParking=id=>['10','14','15','16'].includes(id);
export const isParking=id=>['10','14','15','16','17','18','19'].includes(id);

const groundTrial=[globalThis.location?.href,globalThis.document?.referrer]
 .map(url=>url&&new URL(url).searchParams.get('ground-trial')).find(Boolean);

// One continuous sky shader. Weather never replaces or reloads the scene.
export function weatherFrame(world,weather,material,palette){
 const now=world.draftTime??performance.now(),themeTone=world.draftThemeTone?.value??(world.state.mode==='dark'?1:0);
 let motion=world.draftWeather;
 if(!motion)motion=world.draftWeather={target:'default',from:{default:1,overcast:0,rain:0,snow:0},weights:{default:1,overcast:0,rain:0,snow:0},start:now};
 if(motion.target!==weather){motion.from={...motion.weights};motion.target=weather;motion.start=now;}
 const t=matchMedia('(prefers-reduced-motion: reduce)').matches?1:smooth((now-motion.start)/650);
 for(const key of Object.keys(motion.weights))motion.weights[key]=THREE.MathUtils.lerp(motion.from[key],key===weather?1:0,t);
 world.draftWeatherActive=t<1;const w=motion.weights,u=material.uniforms,original=world.sky.material;
 const rain=w.rain,snow=w.snow,cloud=w.overcast,daylight=1-themeTone;
 const rainDay=daylight*rain,snowDay=daylight*snow;
 const scene=world.state.id,clearDay=daylight*w.default;
 const indoor=isIndoorParking(scene);
 u.daylightHorizon.value=indoor?0:clearDay;
 world.draftDayHorizon.value=isParking(scene)?0:clearDay;
 applySkyAppearance(world,w,palette,u,indoor,themeTone);
 world.draftDayGroundGrade.value=isParking(scene)?0:(1-themeTone)*(1-.55*(rain+w.snow));
 if(groundTrial==='neutral')world.draftDayGroundBalance.value.set(.59,.53,.45);
 if(groundTrial==='warm')world.draftDayGroundBalance.value.set(.576,.493,.40);
 if(world.draftFacadeNeutralize)world.draftFacadeNeutralize.value=groundTrial==='warm'?(1-themeTone)*.46:0;
 (world.draftRoadFogDelay??={value:0}).value=['02','09'].includes(scene)?.55*clearDay:0;
 if(world.draftDarkFacade)world.draftDarkFacade.value=isParking(scene)?0:themeTone;
 if(world.draftFoliageFinish)world.draftFoliageFinish.value=isParking(scene)?0:.33;
 if(world.draftEntranceContact)world.draftEntranceContact.value=w.default+.70*w.overcast+.50*rain+.34*w.snow;
 if(world.draftJunctionFacade)world.draftJunctionFacade.value=['05','08'].includes(world.state.id)?(1-themeTone*.45)*(1-rain*.30-w.snow*.25):0;
 (world.draftReflectionWet??={value:0}).value=rain;
 (world.draftSnowHaze??={value:0}).value=snowDay;
 // Ocean color follows the same continuous cloud cover as sky and lighting.
 (world.draftCoastCloud??={value:0}).value=clamp(rain+cloud*.72+w.snow*.88,0,1);
 u.amount.value=1;
 u.coverage.value=rainDay;
 const fog=world.scene.fog;
 if(fog?.color)fog.color.copy(u.bottom.value);
 world.draftWeatherHorizon=u.bottom.value.clone();
 const horizonBefore=original.uniforms.bottom.value.clone();
 original.uniforms.bottom.value.copy(u.bottom.value);
 // Baselines are captured before each temporary weather pass and restored after it.
 const lights=[world.sun,world.hemi,world.fill],intensities=lights.map(l=>l.intensity);
 world.sun.intensity*=1-.65*rainDay-.45*snowDay-.20*cloud*daylight;
 world.hemi.intensity*=1-.28*rainDay;
 world.fill.intensity*=1-.20*rainDay;
 world.sky.material=material;
 return ()=>{original.uniforms.bottom.value.copy(horizonBefore);world.sky.material=original;lights.forEach((l,i)=>l.intensity=intensities[i]);};
}

// Wheels are often merged into a material mesh. Give only wheel vertices a
// local axle rotation, preserving the prepared materials and body geometry.
export function installRollingWheels(car){
 if(car.userData.draftRolling)return car.userData.draftRolling;
 const wheels=car.userData.vehicleSpec?.wheels||[],distance={value:0},steer={value:0};
 const centres=wheels.map(w=>(w.min[2]+w.max[2])/2),front=centres.filter(z=>z<0),rear=centres.filter(z=>z>0),wheelbase={value:front.length&&rear.length?rear.reduce((a,b)=>a+b,0)/rear.length-front.reduce((a,b)=>a+b,0)/front.length:2.85};
 if(!wheels.length)return null;
 car.updateMatrixWorld(true);const inv=new THREE.Matrix4().copy(car.matrixWorld).invert();let affected=0;
 car.traverse(mesh=>{
  if(!mesh.isMesh||!mesh.geometry?.attributes.position)return;
  const toCar=new THREE.Matrix4().multiplyMatrices(inv,mesh.matrixWorld),fromCar=toCar.clone().invert(),p=new THREE.Vector3(),a=mesh.geometry.attributes.position,data=new Float32Array(a.count*4);
  const named=/wheel|tire|tyre|rim|disc/i.test([mesh.name,...(Array.isArray(mesh.material)?mesh.material:[mesh.material]).map(m=>m.name)].join(' '));let count=0;
  const axles=wheels.map(({min,max})=>({left:min[0]-.025,right:max[0]+.025,cx:(min[0]+max[0])/2,cy:(min[1]+max[1])/2,cz:(min[2]+max[2])/2,radius:(max[1]-min[1])/2*(named?1.035:.86)}));
  for(let i=0;i<a.count;i++){
   p.fromBufferAttribute(a,i).applyMatrix4(toCar);
   for(const axle of axles){
    if(p.x>=axle.left&&p.x<=axle.right&&Math.hypot(p.y-axle.cy,p.z-axle.cz)<axle.radius){const offset=i*4;data[offset]=axle.cx;data[offset+1]=axle.cy;data[offset+2]=axle.cz;data[offset+3]=1;count++;break;}
   }
  }
  if(!count)return;affected+=count;mesh.geometry=mesh.geometry.clone();mesh.geometry.setAttribute('draftAxle',new THREE.BufferAttribute(data,4));
  const patch=material=>{const copy=material.clone(),compile=material.onBeforeCompile,key=material.customProgramCacheKey();copy.onBeforeCompile=(shader,renderer)=>{compile.call(copy,shader,renderer);Object.assign(shader.uniforms,{draftWheelDistance:distance,draftWheelSteer:steer,draftWheelbase:wheelbase,draftToCar:{value:toCar},draftFromCar:{value:fromCar}});
   shader.vertexShader='attribute vec4 draftAxle;uniform float draftWheelDistance;uniform float draftWheelSteer;uniform float draftWheelbase;uniform mat4 draftToCar;uniform mat4 draftFromCar;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nfloat wheelAngle=-draftWheelDistance/max(.25,draftAxle.y);float wc=cos(wheelAngle),ws=sin(wheelAngle);mat3 wheelTurn=mat3(1.,0.,0.,0.,wc,ws,0.,-ws,wc);if(draftAxle.z<0.){float tangent=tan(draftWheelSteer);float wheelSteer=atan(draftWheelbase*tangent/(draftWheelbase+draftAxle.x*tangent));float sc=cos(wheelSteer),ss=sin(wheelSteer);wheelTurn=mat3(sc,0.,-ss,0.,1.,0.,ss,0.,sc)*wheelTurn;}if(draftAxle.w>.5)objectNormal=mat3(draftFromCar)*wheelTurn*mat3(draftToCar)*objectNormal;');
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nif(draftAxle.w>.5){vec3 wheelP=(draftToCar*vec4(transformed,1.)).xyz;wheelP=wheelTurn*(wheelP-draftAxle.xyz)+draftAxle.xyz;transformed=(draftFromCar*vec4(wheelP,1.)).xyz;}');};copy.customProgramCacheKey=()=>key+'-rolling-ackermann-v2';return copy;};
  mesh.material=Array.isArray(mesh.material)?mesh.material.map(patch):patch(mesh.material);
 });
 return car.userData.draftRolling={distance,steer,affected};
}


export function createParkingMotion(world,{parkedHandoff=false}={}){
 const trafficReveal=createTrafficReveal(),preparedGroups=new WeakMap();
 const axis=new THREE.Vector3(0,1,0),raised=new THREE.Vector3(0,22,14),bev=new THREE.Vector3(0,32,.015);
 let root,group,target=null,highlight,paths=[],stops=[],cars=[],occupied=[],active=false,elapsed=0,done=false,origin=null,modelReady=false,trafficVisible=false,cameraTween=null,ownedOffset=null,mode='in',exitChoice=0,exited=false,assistOn=false,lastPath='',routeYaw=0,cameraHeading=0,view='default',cameraState=null,cameraGoal=null,lastCameraTime=0,cameraVelocity={position:new THREE.Vector3(),aim:new THREE.Vector3(),anchor:0},replan=null,paused=false,resumeView='raised',badges=[],selectedAt=0,completionAt=null,completedInPlayback=false;
 let riseStart=.4,riseDuration=1,manualView=null,playbackReturn=null,routeOptions=null;
 let interactionRun=null,takenRun=null,eventCar=null,eventCamera='auto',interactionStart;
 let bayFadeStartedAt=null;
 const arrivalCameras=new WeakMap();
 const cameraOffset=kind=>kind==='bev'?bev:kind==='raised'?raised:new THREE.Vector3(0,11,22);
 let interactionTools;
 let readyPromise,modelError=null;function ensureReady(){return readyPromise??=Promise.all([readyTrafficModel(null,'model-y'),prepareParkingMaterialStructure(),import(new URL('./parking-interactions.bundle.js?v=20261127-parking-speed',import.meta.url).href).then(module=>{interactionTools=module.createInteractionTools({THREE:{Vector3:THREE.Vector3,Color:THREE.Color},parkingViewPose,parkingCameraChoice,sampleParkingView,MANUAL_CAMERA_MS,applyParkingView,createTrafficVehicle,installRollingWheels,setTrafficAppearance,applyTrafficGrowth,meshRibbon});})]).then(()=>{modelReady=true;modelError=null;}).catch(error=>{readyPromise=null;modelError=error.message;throw error})}
 const now=()=>world.draftTime??0;
 const reducedMotion=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 const completionAge=()=>done&&mode==='in'&&completionAt!==null?Math.max(0,now()-completionAt):null;
 const bayFadeActive=()=>parkedHandoff&&completedInPlayback&&done&&mode==='in'&&bayFadeStartedAt!=null;
 function bayFadeOpacity(frameTime=performance.now()){
  if(mode!=='in')return 0;
  if(reducedMotion())return done?0:1;
  if(done&&!bayFadeActive())return 0;
  if(!done&&(!target||!elapsed))return 1;
  // Use the maneuver clock before arrival so pausing also pauses the fade.
  const arrivalAge=done?frameTime-bayFadeStartedAt:(elapsed-(interactionRun?.parkAt??timing().total))*1000;
  const progress=clamp((arrivalAge+bayFadeLeadMs)/bayFadeMs,0,1);
  return (1+Math.cos(Math.PI*progress))/2;
 }
 function recordArrival(time){
  completionAt=time;
  bayFadeStartedAt=parkedHandoff?performance.now():null;
 }
 function paintHandoffBay(assist,liveWeight=1,frameTime){
  if(!highlight||!parkedHandoff)return;
  const {uniforms}=highlight.material;
  const fade=bayFadeOpacity(frameTime);
  uniforms.success.value=0;
  uniforms.celebrate.value=0;
  // The composite also dims the live frame. Preserve the bay's fade curve in the final image.
  uniforms.completion.value=liveWeight>0?Math.min(1,fade/liveWeight):0;
  highlight.visible=!!target&&uniforms.completion.value>0&&(assist||done);
 }
 const completionAnimating=()=>{
  // Render the final zero-alpha frame even if time has already passed the endpoint.
  if(parkedHandoff)return bayFadeActive()&&(highlight?.visible||bayFadeOpacity()>0);
  const age=completionAge();
  return age!==null&&age<(reducedMotion()?200:completionDuration);
 };
 const own=mesh=>{mesh.userData.draftOwned=true;group.add(mesh);return mesh;};
 function currentCamera(){
  // Replay restores the camera before framing metadata is refreshed. Start
  // each transition at the projected pose rather than the previous BEV anchor.
  const frame=parkingFrame(world.car,world.camera);
  return {...captureParkingView(world.camera,world.car,world.cameraAim),anchor:(frame.top+frame.bottom)/2};
 }
 function goalFor(kind){
  // Keep the selected elevation and align the vehicle nose with screen up.
  if(manualView||kind==='default'||!target||cameraState?.reference)
   return parkingViewPose(world.camera,world.car,manualView??kind,world.car.rotation.y,world.draftParkingLowShift);
  const reverse=mode==='in'&&!done?(replan?clamp(elapsed/replan.duration,0,1):clamp((elapsed-timing().forward-timing().shift)/timing().reverse,0,1)):0;
  const points=done?[]:parkingRoutePoints(pose,elapsed,mode==='out'?PARKING_EXIT_SECONDS:timing().total);
  return parkingManeuverView(world.camera,world.car.position,world.car.rotation.y,target,kind,reverse,points,cameraHeading);
 }
 function moveCamera(offset,duration=650,manual=false){
  view=offset.y>30?'bev':offset.y>15?'raised':'default';
  if(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)duration=1;
  world.finishCameraMotion();cameraState=currentCamera();cameraState.reference=manual;cameraGoal=goalFor(view);cameraTween={from:{...cameraState,position:cameraState.position.clone(),aim:cameraState.aim.clone(),velocity:cameraVelocity.position.clone()},velocity:{position:cameraVelocity.position.clone(),aim:cameraVelocity.aim.clone(),anchor:cameraVelocity.anchor},start:now(),duration,manual};ownedOffset=offset.clone();lastCameraTime=now();
 }
 function camera(){
  if(interactionRun){
   // Keep the exact arrival frame through the Parked handoff.
   if(!parkedHandoff||!completedInPlayback||cameraTween)interactionCamera();
   return;
  }
  if(!ownedOffset)return;
  if(paused&&(!cameraTween?.manual||playbackReturn!==null)){lastCameraTime=now();return;}
  const time=now(),dt=clamp((time-lastCameraTime)/1000,0,.1);lastCameraTime=time;
  cameraGoal=goalFor(view);
  const previous={position:cameraState.position.clone(),aim:cameraState.aim.clone(),anchor:cameraState.anchor};
  if(manualView||cameraTween?.manual||!cameraTween&&(cameraState.reference||!target)){
   cameraState=cameraTween?sampleParkingView(cameraTween.from,cameraGoal,globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?10000:time-cameraTween.start,world.car.position.clone().add(new THREE.Vector3(0,.85,0))):cameraGoal;
   if(cameraState.complete)cameraTween=null;
   if(dt>0){cameraVelocity.position.copy(cameraState.position).sub(previous.position).divideScalar(dt);cameraVelocity.aim.copy(cameraState.aim).sub(previous.aim).divideScalar(dt);cameraVelocity.anchor=(cameraState.anchor-previous.anchor)/dt;}
   applyParkingView(world.camera,world.car,cameraState);world.cameraAim.copy(cameraState.aim);
   const actual=vehicleFrame(world.car,world.camera);world.framing={group:view==='default'?'low':'high',targetCenter:cameraState.anchor,targetBottom:actual.bottom,vehicleFrame:actual};
   return;
  }
  if(cameraTween){const u=clamp(cameraTween.legEnd!==undefined?(elapsed-cameraTween.legStart)/Math.max(.001,cameraTween.legEnd-cameraTween.legStart):(time-cameraTween.start)/cameraTween.duration,0,1);
   const {t,v}=blendParkingManeuver(cameraState,cameraTween.from,cameraGoal,cameraTween.velocity,u,cameraTween.duration);
   // Lift around a single vehicle pivot; avoid a diagonal dolly during rise.
   if((cameraTween.legEnd!==undefined||cameraTween.duration===1000)&&!cameraTween.manual){
    const pivot=world.car.position.clone().add(new THREE.Vector3(0,.85,0)),startPivot=cameraTween.pivot||pivot,a=new THREE.Spherical().setFromVector3(cameraTween.from.position.clone().sub(startPivot)),b=new THREE.Spherical().setFromVector3(cameraGoal.position.clone().sub(pivot));
    if(cameraTween.legEnd!==undefined)a.theta+=cameraHeading-cameraTween.heading;
    b.theta=a.theta+Math.atan2(Math.sin(b.theta-a.theta),Math.cos(b.theta-a.theta));
    cameraState.position.setFromSpherical(new THREE.Spherical(THREE.MathUtils.lerp(a.radius,b.radius,t),THREE.MathUtils.lerp(a.phi,b.phi,t),THREE.MathUtils.lerp(a.theta,b.theta,t))).add(pivot);
    // Position and aim follow the same translating pivot. A stationary aim
    // crosses the overhead pole as the vehicle starts, causing a half-turn.
    cameraState.aim.copy(cameraTween.from.aim).add(pivot.clone().sub(startPivot)).lerp(cameraGoal.aim,t);
   }
   // Return behind a reversed car by orbiting the aim, avoiding the lookAt pole.
   orbitParkingManeuver(cameraState,cameraTween.from,cameraGoal,cameraTween.velocity,t,v);
   if(u>=1)cameraTween=null;
  }else followParkingManeuver(cameraState,cameraGoal,dt);
  if(active&&!cameraTween)alignParkingManeuver(cameraState,cameraHeading);
  if(dt>0){cameraVelocity.position.copy(cameraState.position).sub(previous.position).divideScalar(dt);cameraVelocity.aim.copy(cameraState.aim).sub(previous.aim).divideScalar(dt);cameraVelocity.anchor=(cameraState.anchor-previous.anchor)/dt;}
  const before=projectParkingManeuver(world.camera,world.car,cameraState,world.car.children.some(o=>o.isMesh||o.children.length));
  world.cameraAim.copy(cameraState.aim);
  if(before){
   const anchor=cameraState.anchor,actual=vehicleFrame(world.car,world.camera);
   world.framing={group:view==='default'?'low':'high',targetCenter:anchor,targetBottom:anchor+before.height/2,vehicleFrame:actual};
  }
 }
 function ensure(){
  if(!isParking(world.state?.id)){if(group)group.visible=false;return false;}
  if(root===world.root)return true;
  interactionStart=world.car.position.clone();
  if(group&&root)preparedGroups.set(root,{group,highlight,paths,stops,cars,occupied,badges,eventCar});group?.removeFromParent();
  interactionRun=null;takenRun=null;eventCar=null;routeOptions=null;playbackReturn=null;manualView=null;view=['14','19'].includes(world.state.id)?'bev':['16','18'].includes(world.state.id)?'raised':'default';root=world.root;group=new THREE.Group();group.name='Parking maneuver';world.scene.add(group);world.draftParkingGroup=group;delete world.car.userData.draftIndoorContact;cars=[];target=null;active=false;elapsed=0;done=false;origin=null;ownedOffset=null;cameraTween=null;mode='in';exited=false;exitChoice=0;lastPath='';cameraState=null;cameraGoal=null;cameraVelocity={position:new THREE.Vector3(),aim:new THREE.Vector3(),anchor:0};replan=null;paused=false;badges=[];selectedAt=0;completionAt=null;bayFadeStartedAt=null;completedInPlayback=false;
  const cached=preparedGroups.get(root);
  if(cached){group.removeFromParent();({group,highlight,paths,stops,cars,occupied,badges,eventCar}=cached);world.scene.add(group);world.draftParkingGroup=group;ownedOffset=view==='bev'?bev.clone():view==='raised'?raised.clone():new THREE.Vector3(0,11,22);cameraState=goalFor(view);cameraGoal=cameraState;lastCameraTime=now();camera();return true;}
  const bays=world.parkingBays||[];occupied=bays.filter((b,i)=>[3,7,11,14,16].includes(i));const b=bays[0];if(!b)return true;
  highlight=own(new THREE.Mesh(new THREE.PlaneGeometry(8,b.depth),new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,polygonOffset:true,polygonOffsetFactor:-4,uniforms:{tone:{value:0},celebrate:{value:0},alternate:{value:0},completion:{value:1},success:{value:0},selected:{value:0}},vertexShader:'varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:parkingTargetFragment})));
  for(const [i,bay]of bays.entries()){const badge=createParkingSightTarget(i+1);if(badge){badge.userData.bay=bay;badge.position.set(bay.x,.055,bay.z);group.add(badge);badges.push(badge);}}
  highlight.name='Parking target space';highlight.renderOrder=2;highlight.rotation.x=-Math.PI/2;highlight.position.y=.032;
  paths=[0,1].map(i=>own(new THREE.Mesh(new THREE.BufferGeometry(),new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide,uniforms:{tone:{value:0},opacity:{value:i?.40:.84},startFade:{value:i?0:1},endFade:{value:i?1:0}},vertexShader:'attribute vec2 uv;varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'.replace('attribute vec2 uv;',''),fragmentShader:parkingPathFragment}))));
  // Composite the future reverse leg first: its pale rim must not cross the
  // current approach ribbon. Keep both below stop markers and ground shadows (4).
  paths.forEach((p,i)=>{p.name=i?'Parking reverse path':'Parking approach path';p.renderOrder=i?3:3.5});
  stops=[0,1].map(i=>{const m=own(new THREE.Mesh(new THREE.PlaneGeometry(1,.065),new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,toneMapped:false,vertexShader:'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:parkingStopFragment})));m.name=i?'Reverse stop line':'Approach stop line';m.rotation.x=-Math.PI/2;m.renderOrder=4;return m;});
  ownedOffset=view==='bev'?bev.clone():view==='raised'?raised.clone():new THREE.Vector3(0,11,22);cameraState=goalFor(view);cameraGoal=cameraState;lastCameraTime=now();camera();
  return true;
 }
 const boundsCache=new WeakMap();
 function vehicleBounds(car){
  if(boundsCache.has(car))return boundsCache.get(car);
  car.updateMatrixWorld(true);const inverse=new THREE.Matrix4().copy(car.matrixWorld).invert(),bounds=new THREE.Box3();
  car.traverse(o=>{if(!o.isMesh||o.userData.trafficShadow||!o.geometry?.attributes.position)return;o.geometry.computeBoundingBox();bounds.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse,o.matrixWorld)));});
  const size=bounds.getSize(new THREE.Vector3()),spec=car.userData.vehicleSpec||{};
  const result={...spec,width:size.x||spec.width||2.1,length:spec.length||size.z||4.72,frontOffset:Number.isFinite(bounds.min.z)?bounds.min.z:-(spec.length||4.72)/2};boundsCache.set(car,result);return result;
 }
 function planningOptions(){
  // A layer reveal must never change the route underneath a moving vehicle.
  if(routeOptions)return routeOptions;
  const start=origin?.carPosition||world.car.position,base=routeYaw;
  const parkedCars=trafficVisible?cars.filter(c=>c.userData.bay!==target):[];
  if(takenRun&&eventCar)parkedCars.push(eventCar);
  const obstacles=parkedCars.map(c=>({x:c.position.x,z:c.position.z,width:vehicleBounds(c).width,length:vehicleBounds(c).length,yaw:c.rotation.y}))
   .concat((world.parkingColumns||[]).map(c=>({x:c.position.x,z:c.position.z,width:.78,length:.78,yaw:0})))
   .map(o=>({...o,...localBay(o,start,base),yaw:o.yaw-base}));
  return {vehicle:vehicleBounds(world.car),obstacles};
 }
 function timing(){if(interactionRun)return {forward:interactionRun.releaseAt,shift:0,reverse:interactionRun.duration-interactionRun.releaseAt,total:interactionRun.duration};if(replan)return {forward:0,shift:0,reverse:replan.duration,total:replan.duration};if(!target)return {forward:5,shift:.3,reverse:7.5,total:12.8};return parkingTiming(localBay(target,origin?.carPosition||world.car.position,routeYaw),0,planningOptions());}
 function pose(t){
  if(interactionRun)return interactionRun.sample(t).ego;
  if(mode==='out')return exitPose(t,target,exitChoice||-1);
  if(replan)return replan.sample(t);
  const start=origin?.carPosition||world.car.position,local=localBay(target,start,routeYaw),p=parkingPose(t,local,0,planningOptions());return worldPose(p,start,routeYaw);
 }
 function meshRibbon(mesh,points){
  const count=points.length;
  let geometry=mesh.geometry,position=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
  if(position?.count!==count*2||uv?.count!==count*2){
   geometry.dispose();geometry=mesh.geometry=new THREE.BufferGeometry();
   position=new THREE.BufferAttribute(new Float32Array(count*6),3);uv=new THREE.BufferAttribute(new Float32Array(count*4),2);
   geometry.setAttribute('position',position);geometry.setAttribute('uv',uv);
   const indices=[];for(let i=0;i<count-1;i++){const n=i*2;indices.push(n,n+1,n+2,n+1,n+3,n+2);}geometry.setIndex(indices);
  }
  let total=0;for(let i=1;i<count;i++)total+=points[i].distanceTo(points[i-1]);total=Math.max(.00001,total);
  let length=0;
  for(let i=0;i<count;i++){
   if(i)length+=points[i].distanceTo(points[i-1]);
   const p=points[i],next=points[Math.min(i+1,count-1)],previous=points[Math.max(0,i-1)];
   const dx=next.x-previous.x,dy=next.y-previous.y,dz=next.z-previous.z,inverse=1/(Math.sqrt(dx*dx+dy*dy+dz*dz)||1),sx=dz*inverse*.5,sz=-dx*inverse*.5;
   const left=p.edges?.[0],right=p.edges?.[1];
   position.setXYZ(i*2,left?.x??p.x+sx,p.y,left?.z??p.z+sz);position.setXYZ(i*2+1,right?.x??p.x-sx,p.y,right?.z??p.z-sz);
   const v=p.routeV??length/total;uv.setXY(i*2,0,v);uv.setXY(i*2+1,1,v);
  }
  position.needsUpdate=true;uv.needsUpdate=true;geometry.computeBoundingSphere();
 }
 function ribbon(){
  if(interactionRun){interactionTools.ribbon({run:interactionRun,elapsed,assistOn,paths,stops});return;}
  const key=[elapsed,mode,exitChoice,target.x,target.z].join('|');if(key===lastPath)return;lastPath=key;
  const {forward,shift,total}=timing(),reverseStart=forward+shift,half=(world.car.userData.vehicleSpec?.length||4.85)/2;
  // Follow the leading axle in each gear. The one-metre ribbon shares the
  // tangent of the leading axle, including front-wheel steering.
  const spec=world.car.userData.vehicleSpec||{},vehicle=parkingVehicle(spec),front=vehicle.rearOffset-vehicle.wheelbase;
  const guideHalfWidth=.5;
  const pointAt=(time,offset)=>{const p=pose(time),s=Math.sin(p.yaw),c=Math.cos(p.yaw),point=new THREE.Vector3(p.x+s*offset,.036,p.z+c*offset);point.time=time;if(mode==='in'){const heading=p.yaw+(offset<0?p.steer||0:0);point.edges=[-guideHalfWidth,guideHalfWidth].map(x=>({x:point.x+Math.cos(heading)*x,z:point.z-Math.sin(heading)*x}));}return point;};
  const sample=(begin,end,offset=0,count=144)=>Array.from({length:count+1},(_,i)=>pointAt(begin+(end-begin)*i/count,offset));
  // Anchor colour and fade coordinates to the complete leg. Only its travelled
  // prefix changes; future vertices never slide along or repaint the route.
  const anchor=points=>{let length=0;points[0].routeV=0;for(let i=1;i<points.length;i++){length+=points[i].distanceTo(points[i-1]);points[i].routeV=length;}for(const p of points)p.routeV/=Math.max(length,.00001);return points;};
  const remaining=(points,time,offset)=>{if(time<=points[0].time)return points;const index=points.findIndex(p=>p.time>time);if(index<0)return [points.at(-1)];const head=pointAt(time,offset),a=points[index-1],b=points[index];head.routeV=THREE.MathUtils.lerp(a.routeV,b.routeV,(time-a.time)/Math.max(b.time-a.time,.00001));return [head,...points.slice(index)];};
  const trim=(points,length)=>{while(points.length>2&&length>0){const d=points[0].distanceTo(points[1]);if(d>=length){points[0].lerp(points[1],length/Math.max(d,.00001));break;}length-=d;points.shift();}return points;};
  const stopAt=(index,points,yaw,front=0)=>{const cap=points.at(-1).clone();cap.x-=Math.sin(yaw)*front;cap.z-=Math.cos(yaw)*front;cap.y=.039;stops[index].position.copy(cap);stops[index].rotation.z=yaw;};
  if(mode==='out'){const points=trim(sample(elapsed,PARKING_EXIT_SECONDS),half);stopAt(0,points,pose(PARKING_EXIT_SECONDS).yaw);meshRibbon(paths[0],points);paths[1].visible=false;stops[1].visible=false;return;}
  let first=sample(0,forward,front),second=sample(reverseStart,total,vehicle.rearOffset);
  // The stop marker and zero-speed pose share the nose's ground projection.
  // Extend only the final cap; the moving ribbon still follows the front axle.
  first.push(pointAt(forward,vehicleBounds(world.car).frontOffset));
  // Finish the fade at the parked rear bumper, next to the bay's wheel stop.
  const finish=pose(total),tail=(spec.length||4.72)/2,endpoint=new THREE.Vector3(finish.x+Math.sin(finish.yaw)*tail,.036,finish.z+Math.cos(finish.yaw)*tail);
  endpoint.edges=[-guideHalfWidth,guideHalfWidth].map(x=>({x:endpoint.x+Math.cos(finish.yaw)*x,z:endpoint.z-Math.sin(finish.yaw)*x}));second.push(endpoint);
  // The front/rear axle handover lies entirely beneath the stationary chassis.
  const seam=first.at(-1).clone();seam.edges=first.at(-1).edges;seam.time=reverseStart;second.unshift(seam);
  endpoint.time=total;anchor(first);anchor(second);first=remaining(first,Math.min(elapsed,forward),front);second=remaining(second,Math.max(reverseStart,elapsed),vehicle.rearOffset);
  // The next leg is visible from selection. Both legs meet at the same
  // direction-change point; the vehicle naturally masks the seam.
  // Keep the route under the chassis; AO and the body mask its exact origin.
  const approach=pose(forward);
  stopAt(0,first,approach.yaw);meshRibbon(paths[0],first);meshRibbon(paths[1],second);
 }
 function interactionCamera(){
  if(!interactionRun)return;
  let arrival=arrivalCameras.get(interactionRun);
  if(!arrival){arrival=interactionTools.arrivalCamera(world.camera,interactionRun,origin.carPosition.y);arrivalCameras.set(interactionRun,arrival);}
  const state=interactionTools.camera({run:interactionRun,elapsed,world,eventCamera,cameraTween,arrival,time:now()});
  ({cameraState,cameraGoal,cameraTween,cameraHeading}=state);
 }
 function configureEvent(event){
  if(!isParkingEvent(event)){if(interactionRun){reset({replay:true});target=null;}return;}
  ensure();
  reset({replay:true});
  // Each authored encounter owns the approach pose, actor and target layout.
  world.car.position.copy(interactionStart);
  origin=world.captureCamera();
  interactionRun=interactionTools.configure(event,{world,cars,occupied,vehicleBounds,arrivalHold:parkedHandoff?0:undefined});
  eventCamera='auto';target=interactionRun.originalTarget;manualView=null;assistOn=true;
  seekEvent(0);return interactionRun;
 }
 function detachEvent(){
  if(!interactionRun)return;
  if(!done){
   reset({replay:true});
   target=null;
   return;
  }
  const pose=currentCamera();
  if(interactionRun.event==='parking-taken')takenRun=interactionRun;
  interactionRun=null;
  if(eventCar&&!takenRun)eventCar.visible=false;
  active=false;paused=false;
  if(parkedHandoff)completedInPlayback=false;
  routeOptions=null;replan=null;lastPath='';cameraTween=null;ownedOffset=null;
  cameraState=pose;cameraGoal=pose;cameraHeading=world.car.rotation.y;
  applyParkingView(world.camera,world.car,pose);world.cameraAim.copy(pose.aim);
 }
 function seekEvent(seconds,{playing=false,advance=false}={}){
  if(!interactionRun)return false;
  const time=now();
  const state=interactionTools.seek({run:interactionRun,seconds,playing,world,origin,highlight,time});
  const arrival=advance&&state.done;
  if(arrival){if(!completedInPlayback)recordArrival(time);}
  else completionAt=state.completionAt;
  completedInPlayback=arrival;
  ({elapsed,target,done,active,paused,selectedAt}=state);assistOn=true;lastPath='';interactionCamera();
  if(parkedHandoff&&done){
   syncIndoorColumns(world);
   if(arrival)cameraTween=null;
  }
  return true;
 }
 const occupiedBay=bay=>bay===takenRun?.originalTarget||trafficVisible&&occupied.includes(bay);
 function departingBayAvailability(bay){
  const {position,rotation,userData:{vehicleSpec}}=world.car;
  const side=Math.sign(bay.x)||1;
  const lateral=side*Math.cos(rotation.y),longitudinal=side*Math.sin(rotation.y);
  const clearance=side*(bay.x-position.x)-bay.width/2;
  // The rear tire contact patches define when the bay is fully open.
  let lastContact=-Infinity;
  for(const {min,max} of vehicleSpec?.wheels??[]){
   if(min[2]+max[2]<=0)continue;
   lastContact=Math.max(lastContact,(lateral*(min[0]+max[0])+longitudinal*(min[2]+max[2]))/2);
  }
  if(lastContact===-Infinity){
   const {rearOffset,width}=parkingVehicle(vehicleSpec);
   lastContact=longitudinal*rearOffset+Math.abs(lateral)*width*.4;
  }
  const distance=lastContact-clearance;
  return reducedMotion()?Number(distance<=0):smooth(1-distance/.25);
 }
 function prepareExit(){
  if(!done)return false;
  detachEvent();
  mode='out';done=false;completionAt=null;bayFadeStartedAt=null;completedInPlayback=false;elapsed=0;
  exitChoice=0;origin=null;routeOptions=null;replan=null;paused=false;lastPath='';
  return true;
 }
 function sync({traffic=false,assist=false}={}){
  const first=root!==world.root;if(!ensure())return;if(traffic&&!modelReady)void ensureReady().catch(error=>console.error(error));trafficReveal.set(traffic&&modelReady,{snap:first||world.draftInitialFrameReady!==true});const growth=trafficReveal.sample();group.visible=true;trafficVisible=traffic;assistOn=assist;if(!assist&&active)pause();
  // Leave the foreground-left bay empty; retain the other vehicles' original offsets.
  if(modelReady&&!cars.length)for(const [index,bay]of occupied.entries()){const i=index+1,car=createTrafficVehicle('model-y');car.position.set(bay.x+(i%2?.10:-.10),.02,bay.z+(i%3-1)*.10);car.rotation.y=(bay.x>0?Math.PI/2:-Math.PI/2)+(i%2?.014:-.012);car.userData.bay=bay;group.add(car);cars.push(car);}
  if(interactionTools)eventCar=interactionTools.actor({eventCar,run:interactionRun??takenRun,
   elapsed:interactionRun?elapsed:takenRun?.duration,stationary:!interactionRun,world,group});
  if(traffic&&target&&occupied.includes(target)&&!elapsed&&!active)target=null;
  const indoorTraffic=isIndoorParking(world.state.id), dark=world.state.mode==='dark';
  const tone=world.draftThemeTone?.value??Number(dark);
  cars.forEach(car=>{
   car.userData.draftPaintBrightness=(indoorTraffic?(world.draftParkingFinish?.traffic?.value??1):1)*(1+.22*(1-tone));
   car.visible=trafficReveal.present&&car.userData.bay!==target;
   setTrafficAppearance(car,dark,trafficEntryOpacity(growth),tone,.6*(1-tone),world.draftParkingFinish?.trafficGray?.value,indoorTraffic);
   applyTrafficGrowth(car,growth,world);
  });
  const targetAvailability=mode==='out'&&target?departingBayAvailability(target):0;
  for(const bay of world.parkingBays||[]){
   const available=bay.tile?.material.uniforms.available;
   if(!available)continue;
   const taken=interactionRun?.event==='parking-taken'&&elapsed>=interactionRun.switchAt&&bay===interactionRun.originalTarget;
   available.value=occupiedBay(bay)||taken?0:bay===target?targetAvailability:1;
  }
  // Hide markers during material review; preserve their sight targets and occlusion behavior.
  badges.forEach(b=>{b.userData.parkingSightTarget=!active&&!done&&mode==='in'&&!occupiedBay(b.userData.bay);b.visible=false;});
  const sightPoints=badges.filter(b=>b.userData.parkingSightTarget).flatMap(b=>[-.24,0,.24].map(dx=>b.position.clone().add(new THREE.Vector3(dx,0,0))));
  if(target&&!done&&(elapsed===0||assist)){
   const end=mode==='out'?PARKING_EXIT_SECONDS:timing().total;
   for(let i=0;i<=12;i++){const p=pose(elapsed+(end-elapsed)*i/12);for(const side of [-.82,.82])sightPoints.push(new THREE.Vector3(p.x+Math.cos(p.yaw)*side,.1,p.z-Math.sin(p.yaw)*side));}
  }
  const indoor=isIndoorParking(world.state.id);
  const vehicles=syncIndoorVehicleContacts(group,world.car,eventCar?[...cars,eventCar]:cars,indoor,world.draftParkingFinish,world.draftThemeTone?.value??(world.state.mode==='dark'?1:0));
  camera();
  // Preserve the arrival height and visibility as the live scene hands off to Parked.
  const holdColumns=parkedHandoff&&(done||mode==='out'||exited);
  if(!holdColumns)syncIndoorColumns(world);
  if(!indoor)syncOutdoorLawns(world);
  updateParkingOcclusion(world,group,target,sightPoints,{holdColumns});
  updateIndoorContactOpacity(vehicles,world.draftParkingFinish?.trafficShadow??world.draftParkingFinish?.shadow,world.draftParkingFinish?.egoShadow??world.draftParkingFinish?.shadow,world.car);syncParkingCastShadows(world,vehicles,indoor);
  if(!highlight)return;
  const alternate=interactionRun?.event==='parking-taken'&&target===interactionRun.finalTarget;
  highlight.material.uniforms.alternate.value=alternate?smooth((elapsed-interactionRun.switchAt)/.42)*(1-smooth((elapsed-interactionRun.forwardEnd)/.5)):0;
  highlight.material.uniforms.selected.value=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?1:smooth((now()-selectedAt)/850);
  const {uniforms}=highlight.material;
  uniforms.tone.value=world.draftThemeTone?.value??(world.state.mode==='dark'?1:0);
  if(parkedHandoff)paintHandoffBay(assist);
  else{
   const reduced=reducedMotion(),age=completionAge();
   const cycleAge=age===null||age>=completionPulseMs?null:age%completionBreathMs;
   const breath=cycleAge===null?0:cycleAge<completionRiseMs?cycleAge/completionRiseMs:1-(cycleAge-completionRiseMs)/completionFallMs;
   uniforms.success.value=age===null?0:reduced?1:smooth(age/200);
   uniforms.celebrate.value=reduced?0:Math.sin(Math.PI/2*clamp(breath,0,1))**2;
   uniforms.completion.value=age===null?1:1-smooth(reduced?age/200:(age-completionPulseMs)/completionFadeMs);
   highlight.visible=!!target&&assist;
  }
  const visible=!!target&&!done&&assist;
  paths.forEach((path,i)=>{
   path.visible=visible&&(mode==='out'?i===0:timing().forward>0&&elapsed<timing().forward+timing().shift||i===1);
   const u=path.material.uniforms;
   u.tone.value=uniforms.tone.value;
   u.opacity.value=i?(mode==='out'||timing().forward===0?.75:THREE.MathUtils.lerp(.4,.75,smooth((elapsed-timing().forward)/timing().shift))):1;
   u.endFade.value=mode==='out'||i===1?1:0;
   stops[i].visible=i===0&&path.visible&&mode==='in'&&!replan;
  });
  if(visible)ribbon();
 }
 function hitBay(x,y){
  const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(x,y),world.camera);const badge=ray.intersectObjects(badges.filter(b=>b.visible))[0]?.object;if(badge)return badge.userData.bay;const p=ray.ray.intersectPlane(new THREE.Plane(axis,-.03),new THREE.Vector3());
  return p?(world.parkingBays||[]).find(b=>Math.abs(p.x-b.x)<b.width/2&&Math.abs(p.z-b.z)<b.depth/2&&!occupiedBay(b)):null;
 }
 function hover(x,y){if(!ensure())return false;const bay=!interactionRun&&assistOn&&!active&&!done&&mode==='in'&&x!==null?hitBay(x,y):null;let changed=false;for(const b of world.parkingBays||[]){const uniform=b.tile?.material.uniforms.hover;if(!uniform)continue;const value=b===bay&&b!==target?1:0;if(uniform.value!==value){uniform.value=value;changed=true;}}return changed;}
 function selectBay(bay){
  if(!bay||occupiedBay(bay))return false;selectedAt=now();completionAt=null;
  routeOptions=null;const retarget=elapsed>0;target=bay;routeYaw=world.car.rotation.y;origin=world.captureCamera();if(!retarget&&!parkingPlan(localBay(target,origin.carPosition,routeYaw),0,planningOptions())){target=null;origin=null;return false;}replan=retarget&&Math.abs(Math.sin(routeYaw))>.02?reverseReplan({x:world.car.position.x,z:world.car.position.z,yaw:routeYaw},bay):null;elapsed=0;paused=false;exited=false;cameraHeading=pose(timing().total).yaw-Math.sign(bay.x)*Math.PI/2;lastPath='';highlight.position.set(bay.x,.032,bay.z);if(!manualView&&view==='default')moveCamera(raised,1000);return true;
 }
 function pick(x,y){
  if(!ensure()||interactionRun||active||done||mode==='out')return false;
  return selectBay(hitBay(x,y));
 }
 function selectDefault(){
  if(!ensure()||interactionRun||active||done||mode==='out')return false;
  if(target)return true;
  const bays=[...(world.parkingBays||[])].sort((a,b)=>Math.abs(a.z+3.6)-Math.abs(b.z+3.6)||a.x-b.x);
  return bays.some(selectBay);
 }
 function progress(){
  const dt=.02;
  if(interactionRun){
   const f=interactionRun.sample(elapsed),next=interactionRun.sample(Math.min(interactionRun.duration,elapsed+dt));
   const speed=active&&!paused&&!f.complete&&elapsed<interactionRun.duration?Math.hypot(next.ego.x-f.ego.x,next.ego.z-f.ego.z)/dt:0;
   return {gear:f.gear,remaining:f.remaining??(f.complete?0:null),distance:Math.abs(f.ego.distance||0),speed};
  }
  if(!target)return {gear:null,remaining:null,distance:0,speed:0};
  if(done)return {gear:'P',remaining:0,distance:Math.abs(world.draftWheelDistance||0),speed:0};
  if(mode==='out'){
   if(!exitChoice)return {gear:'P',remaining:null,distance:0,speed:0};
   const p=pose(elapsed),next=pose(Math.min(PARKING_EXIT_SECONDS,elapsed+dt));
   const speed=active&&!paused&&playbackReturn===null&&elapsed<PARKING_EXIT_SECONDS?Math.hypot(next.x-p.x,next.z-p.z)/dt:0;
   return {gear:'D',remaining:Math.max(0,Math.abs(target.x)*Math.PI/2-p.distance),distance:Math.abs(p.distance||0),speed};
  }
  if(replan){
   const p=pose(elapsed),next=pose(Math.min(replan.duration,elapsed+dt));
   const speed=active&&!paused&&playbackReturn===null&&elapsed<replan.duration?Math.hypot(next.x-p.x,next.z-p.z)/dt:0;
   return {gear:'R',remaining:replan.remaining(elapsed),distance:Math.abs(p.distance||0),speed};
  }
  const p=pose(elapsed),total=timing().total,next=pose(Math.min(total,elapsed+dt));
  const speed=active&&!paused&&playbackReturn===null&&elapsed<total?Math.hypot(next.x-p.x,next.z-p.z)/dt:0;
  return {...parkingSegment(elapsed,localBay(target,origin?.carPosition||world.car.position,routeYaw),0,planningOptions()),distance:Math.abs(p.distance||0),speed};
 }
 function automaticRise(){
  if(cameraState)cameraState.reference=false;
  const end=mode==='in'&&!replan?riseStart+(riseDuration??timing().forward):0;
  moveCamera(raised,elapsed<end?(end-elapsed)*1000:1000);
  if(elapsed<end&&!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){Object.assign(cameraTween,{legStart:Math.max(elapsed,riseStart),legEnd:end,pivot:world.car.position.clone().add(new THREE.Vector3(0,.85,0)),heading:cameraHeading});}
 }
 function start(){
  if(interactionRun){seekEvent(elapsed,{playing:true});return active;}
  ensure();if(!target||mode==='out'&&!exitChoice||done)return false;if(active)return true;
  if(!origin)origin=world.captureCamera();routeOptions??=planningOptions();const restoring=paused;paused=false;
  cameraHeading=pose(elapsed).yaw;
  if(restoring){if(playbackReturn!==null&&cameraTween)cameraTween.start=now()-playbackReturn*1000;lastCameraTime=now();active=true;assistOn=true;return true;}
  // High already begins at the assisted elevation. Join the automatic camera
  // from that pose; only the end-stage BEV needs the return through Low.
  if(manualView==='raised'&&mode==='in'){
   manualView=null;automaticRise();
  }else if(manualView&&mode==='in'){
   manualView=null;playbackReturn=0;moveCamera(cameraOffset('default'),650,true);
  }else if(mode==='in'||!manualView)automaticRise();
  active=true;assistOn=true;return true;
 }
 function pause(){if(active){resumeView=view;active=false;paused=true;lastCameraTime=now();}}
 function configureCamera(values={}){
  const nextStart=Number.isFinite(values.start)?clamp(values.start,0,8):riseStart,nextDuration=values.duration===null?null:Number.isFinite(values.duration)?clamp(values.duration,.2,8):riseDuration;
  const changed=nextStart!==riseStart||nextDuration!==riseDuration;riseStart=nextStart;riseDuration=nextDuration;
  if(changed&&!manualView&&target&&!done&&mode==='in'&&!replan&&(active||paused)){
   const end=riseStart+(riseDuration??timing().forward);moveCamera(raised,Math.max(.001,end-Math.max(elapsed,riseStart))*1000);
   Object.assign(cameraTween,{legStart:Math.max(elapsed,riseStart),legEnd:Math.max(elapsed+.001,end),pivot:world.car.position.clone().add(new THREE.Vector3(0,.85,0)),heading:cameraHeading});
  }
  return {start:riseStart,duration:riseDuration};
 }
 function reset({replay=false}={}){
  interactionRun=null;takenRun=null;if(eventCar)eventCar.visible=false;
  const from=currentCamera(),previous=world.car.position.clone(),previousView=view,previousManual=manualView;
  active=false;elapsed=0;done=false;completionAt=null;bayFadeStartedAt=null;completedInPlayback=false;exited=false;mode='in';exitChoice=0;world.draftWheelDistance=0;world.draftWheelSteer=0;
  if(origin)world.applyCamera(origin);world.car.rotation.y=0;origin=null;routeOptions=null;ownedOffset=null;cameraTween=null;cameraState=null;replan=null;paused=false;playbackReturn=null;lastPath='';cameraVelocity={position:new THREE.Vector3(),aim:new THREE.Vector3(),anchor:0};
  if(replay){view='default';manualView=null;cameraHeading=world.car.rotation.y;}
  else if(isParking(world.state?.id)&&root===world.root){
   // Replay resets the car while retaining the current viewing direction;
   // start() then eases that view to Low instead of snapping the camera.
   const shift=world.car.position.clone().sub(previous);from.position.add(shift);from.aim.add(shift);
   view=previousView;manualView=previousView;cameraHeading=world.car.rotation.y;ownedOffset=cameraOffset(view).clone();cameraState=from;cameraGoal=from;lastCameraTime=now();
   applyParkingView(world.camera,world.car,from);world.cameraAim.copy(from.aim);manualView=previousManual==='raised'?'raised':'default';moveCamera(cameraOffset(manualView),650,true);
  }
 }

 // The broad setup arc lets the camera turn with the chassis continuously,
 // keeping the final parked vehicle facing up in the frame.
 function step(dt){if(interactionRun){if(!active||!assistOn)return false;return seekEvent(elapsed+dt,{playing:true,advance:true});}if(!active||!target||!assistOn)return false;if(playbackReturn!==null){playbackReturn+=dt;camera();if(playbackReturn>=.85||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){playbackReturn=null;cameraVelocity.position.set(0,0,0);cameraVelocity.aim.set(0,0,0);cameraVelocity.anchor=0;automaticRise();}return true;}elapsed=Math.min(mode==='out'?PARKING_EXIT_SECONDS:timing().total,elapsed+dt);const p=pose(elapsed);cameraHeading=p.yaw;world.car.position.set(p.x,origin.carPosition.y,p.z);world.car.rotation.y=p.yaw;world.draftWheelDistance=p.distance;world.draftWheelSteer=p.complete?0:(p.steer??0);camera();if(p.complete){active=false;done=true;world.draftWheelSteer=0;if(mode==='in'){completedInPlayback=true;recordArrival(now());if(parkedHandoff){syncIndoorColumns(world);ownedOffset=cameraTween=null;}else if(!manualView)moveCamera(bev,PARKING_SETTLE_MS);}else{exited=true;target=null;elapsed=0;done=false;mode='in';exitChoice=0;origin=null;routeOptions=null;routeYaw=world.car.rotation.y;cameraHeading=routeYaw;replan=null;}}return true;}
 return {configureEvent,detachEvent,seekEvent,paintHandoffBay,eventCamera(value,{animate=false}={}){if(!interactionRun)return;eventCamera=value;manualView=value==='auto'?null:parkingCameraChoice(value);cameraTween=animate?{from:currentCamera(),start:now(),manual:true,velocity:{position:cameraVelocity.position.clone(),aim:cameraVelocity.aim.clone(),anchor:cameraVelocity.anchor}}:null;interactionCamera();},get ready(){return ensureReady()},revealTraffic(){trafficReveal.set(false);trafficReveal.set(true)},sync,start,pick,selectDefault,hover,step,reset,configureCamera,finishPreview(){if(done&&mode==='in'){completionAt=now()-completionDuration;bayFadeStartedAt=null;}if(cameraTween){cameraState=goalFor(view);cameraTween=null;camera();}},previewCamera(value){ensure();const kind=parkingCameraChoice(value);manualView=kind;moveCamera(cameraOffset(kind),MANUAL_CAMERA_MS,true);return true;},pause,useCamera(){ownedOffset=null;cameraTween=null},animating:()=>completionAnimating()||trafficReveal.active||!!world.draftOcclusionActive||(!paused||cameraTween?.manual)&&(!!cameraTween||!!ownedOffset&&!!cameraState&&!!cameraGoal&&cameraState.position.distanceTo(cameraGoal.position)>.003),prepareExit,chooseExit(direction){if(mode!=='out'||active)return false;exitChoice=direction<0?-1:1;lastPath='';if(!manualView)moveCamera(raised);return true},get:()=>({...progress(),interaction:interactionRun?interactionTools.status(interactionRun,elapsed):null,traffic:{enabled:trafficVisible,modelReady,modelError,count:cars.length,visible:cars.filter(car=>group?.visible&&car.visible&&car.userData.modelReady&&car.userData.draftTrafficEntryOpacity>.98).length,inView:cars.filter(car=>{if(!group?.visible||!car.visible||!car.userData.modelReady||car.userData.draftTrafficEntryOpacity<=.98)return false;const p=car.getWorldPosition(new THREE.Vector3()).project(world.camera);return Math.abs(p.x)<1&&Math.abs(p.y)<1&&Math.abs(p.z)<1}).length},active,elapsed,selectedAt,complete:done,completedInPlayback,replayReady:done&&completionAt!==null&&(parkedHandoff||now()-completionAt>=(reducedMotion()?200:completionPulseMs)),target:target?{x:target.x,z:target.z}:null,phase:interactionRun?interactionRun.sample(elapsed).phase:mode==='out'&&!exitChoice?'exit-select':done?'parked':target?pose(elapsed).phase:'select',mode,exitChoice,exited,cameraLocked:active,view,manualView,paused,camera:{position:world.camera.position.toArray(),aim:world.cameraAim.toArray(),heading:cameraHeading,tween:!!cameraTween},occupied:[...occupied,...(takenRun?[takenRun.originalTarget]:[])].map(b=>({x:b.x,z:b.z}))}),capture:()=>({interactionRun,takenRun,eventCamera,routeOptions,playbackReturn,trafficReveal:trafficReveal.capture(),elapsed,active,done,selectedAt,completionAt,bayFadeStartedAt,completedInPlayback,origin,target,ownedOffset:ownedOffset?.clone(),cameraTween:cameraTween?{...cameraTween,from:{...cameraTween.from,position:cameraTween.from.position.clone(),aim:cameraTween.from.aim.clone()},velocity:{position:cameraTween.velocity.position.clone(),aim:cameraTween.velocity.aim.clone(),anchor:cameraTween.velocity.anchor}}:null,mode,exitChoice,exited,assistOn,routeYaw,cameraHeading,view,manualView,cameraState:cameraState?{...cameraState,position:cameraState.position.clone(),aim:cameraState.aim.clone()}:null,cameraGoal:cameraGoal?{...cameraGoal,position:cameraGoal.position.clone(),aim:cameraGoal.aim.clone()}:null,replan,paused,resumeView,lastCameraTime,cameraVelocity:{position:cameraVelocity.position.clone(),aim:cameraVelocity.aim.clone(),anchor:cameraVelocity.anchor}}),restore(s){if(s.trafficReveal)trafficReveal.restore(s.trafficReveal);({interactionRun,takenRun,eventCamera,routeOptions,playbackReturn,elapsed,active,done,selectedAt,completionAt,bayFadeStartedAt,completedInPlayback,origin,target,ownedOffset,cameraTween,mode,exitChoice,exited,assistOn,routeYaw,cameraHeading,view,manualView,cameraState,cameraGoal,replan,paused,resumeView,lastCameraTime,cameraVelocity}=s);lastPath=''}};
}
