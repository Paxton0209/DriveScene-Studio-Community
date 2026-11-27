import {createFeedbackPainter} from './traffic-feedback.js';
import {planParkingInteraction} from './parking-interactions.js';
import {INTERACTION_CAMERA} from './interaction-camera.js';
import {createParkingArrivalCamera} from './parking-camera.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function createInteractionTools({THREE,parkingViewPose,parkingCameraChoice,sampleParkingView,MANUAL_CAMERA_MS,applyParkingView,createTrafficVehicle,installRollingWheels,setTrafficAppearance,applyTrafficGrowth,meshRibbon}){
 const paintFeedback=createFeedbackPainter(THREE.Color);
 function camera({run:interactionRun,elapsed,world,eventCamera,cameraTween,arrival,time}){
  const f=interactionRun.sample(elapsed),car=world.car,pivot=car.position.clone().add(new THREE.Vector3(0,.85,0));
  let goal;
  if(eventCamera!=='auto')goal=parkingViewPose(world.camera,car,parkingCameraChoice(eventCamera),car.rotation.y,world.draftParkingLowShift);
  else{
   const {forwardEnd,parkAt,releaseAt,event}=interactionRun;
   const indoor=['10','14','15','16'].includes(world.state.id);
   if(indoor&&elapsed>=forwardEnd){
    // Hold the raised rig through the gear change, then pick up the fitted
    // framing as the car starts reversing along the path.
    const transition=(elapsed-forwardEnd)/((parkAt-forwardEnd)*.45);
    const reverseView=arrival(elapsed,car);
    const raised=parkingViewPose(world.camera,car,'raised');
    if(event==='parking-yield'&&elapsed<parkAt){
     // Keep the established scale as the camera pitches into the reverse.
     const offset=reverseView.position.clone().sub(pivot);
     const reach=raised.position.distanceTo(pivot);
     if(offset.length()>reach)reverseView.position.copy(pivot).add(offset.setLength(reach));
    }
    goal=transition>=1?reverseView:sampleParkingView(raised,reverseView,transition*MANUAL_CAMERA_MS,pivot);
   }else if(elapsed>=forwardEnd)goal=arrival(elapsed,car);
   else{
    const low=parkingViewPose(world.camera,car,'default');
    const high=parkingViewPose(world.camera,car,'raised');
    goal=sampleParkingView(low,high,(elapsed-.3)/INTERACTION_CAMERA.rise*MANUAL_CAMERA_MS,pivot);
    const start=Math.min(forwardEnd-.001,Math.max(releaseAt+(event==='parking-yield'?1:0),forwardEnd-1));
    if(!indoor&&elapsed>start)goal=sampleParkingView(goal,arrival(elapsed,car),(elapsed-start)/(forwardEnd-start)*MANUAL_CAMERA_MS,pivot);
   }
  }
  if(interactionRun.event==='parking-yield'&&eventCamera!=='low'){
   const enter=clamp((elapsed-interactionRun.decisionAt)/INTERACTION_CAMERA.rise,0,1);
   // Return to High during the forward setup, before the final reverse begins.
   const leave=clamp((elapsed-interactionRun.releaseAt)/INTERACTION_CAMERA.fall,0,1);
   const overheadWeight=enter*(1-leave);
   if(overheadWeight>0){
    // Keep the aisle axis fixed on screen while both vehicles steer past.
    const overhead=parkingViewPose(world.camera,car,'bev',0);
    goal=sampleParkingView(goal,overhead,overheadWeight*MANUAL_CAMERA_MS,pivot);
   }
  }
  const cameraState=cameraTween?sampleParkingView(cameraTween.from,goal,time-cameraTween.start,pivot):goal;
  if(cameraState.complete)cameraTween=null;
  const cameraGoal=goal;applyParkingView(world.camera,car,cameraState);world.cameraAim.copy(cameraState.aim);const cameraHeading=f.ego.yaw;
  return {cameraState,cameraGoal,cameraTween,cameraHeading};
 }
 function ribbon({run:interactionRun,elapsed,assistOn,paths,stops}){
  const legs=interactionRun.route(elapsed).filter(leg=>leg.end-leg.begin>.001);
  // A later leg of the same gear must never create a straight shortcut.
  const changes=legs.findIndex((leg,index)=>index>0&&leg.gear!==legs[index-1].gear&&leg.gear===legs[0].gear);
  const visibleLegs=changes<0?legs:legs.slice(0,changes);
  const {rearOffset,wheelbase}=interactionRun.vehicle,frontOffset=rearOffset-wheelbase;
  const pointAt=(p,offset,heading=p.yaw)=>{
   const point=new THREE.Vector3(p.x+Math.sin(p.yaw)*offset,.036,p.z+Math.cos(p.yaw)*offset);
   point.edges=[-.5,.5].map(x=>({x:point.x+Math.cos(heading)*x,z:point.z-Math.sin(heading)*x}));
   return point;
  };
  for(const [index,gear]of ['D','R'].entries()){
   const points=[],gearLegs=visibleLegs.filter(leg=>leg.gear===gear);
   for(const leg of gearLegs)for(let i=0;i<=96;i++){
    const p=leg.sample(leg.begin+(leg.end-leg.begin)*i/96);
    points.push(gear==='D'?pointAt(p,frontOffset,p.yaw+(p.steer||0)):pointAt(p,rearOffset));
   }
   const previous=visibleLegs[visibleLegs.indexOf(gearLegs[0])-1];
   if(previous){
    // The link spans only the wheelbase at the stopped gear-change pose.
    const stopped=previous.sample(previous.end);
    points.unshift(pointAt(stopped,previous.gear==='D'?frontOffset:rearOffset,stopped.yaw+(previous.gear==='D'?stopped.steer||0:0)));
   }
   paths[index].visible=assistOn&&points.length>1;stops[index].visible=paths[index].visible&&gear==='D';
   if(points.length>1){
    meshRibbon(paths[index],points);
    const last=gearLegs.at(-1),end=points.at(-1);
    stops[index].position.copy(end);stops[index].rotation.z=last.sample(last.end).yaw;
   }
  }
 }
 function actor({eventCar,run:interactionRun,elapsed,stationary=false,world,group}){
  if(!eventCar){eventCar=createTrafficVehicle('model-y');eventCar.name='Parking interaction car';eventCar.userData.parkingActor=true;installRollingWheels(eventCar);group.add(eventCar);}
  eventCar.visible=!!interactionRun;if(!interactionRun)return eventCar;
  const f=interactionRun.sample(elapsed);eventCar.position.set(f.actor.x,.02,f.actor.z);eventCar.rotation.y=f.actor.yaw;
  const tone=world.draftThemeTone?.value??(world.state.mode==='dark'?1:0);
  const indoor=['10','14','15','16'].includes(world.state.id);
  setTrafficAppearance(eventCar,world.state.mode==='dark',1,tone,.6*(1-tone),world.draftParkingFinish?.trafficGray?.value,indoor);
  applyTrafficGrowth(eventCar,1,world);
  const rolling=installRollingWheels(eventCar);if(rolling){rolling.distance.value=f.actor.distance||0;rolling.steer.value=f.actor.steer||0;}
  if(!stationary)paintFeedback(eventCar,interactionRun.feedback('parking-actor',elapsed),tone);
  return eventCar;
 }
 function configure(event,{world,cars,occupied,vehicleBounds,arrivalHold}){
  const obstacles=cars.map(c=>({x:c.position.x,z:c.position.z,width:vehicleBounds(c).width,length:vehicleBounds(c).length,yaw:c.rotation.y}))
   .concat((world.parkingColumns||[]).map(c=>({x:c.position.x,z:c.position.z,width:.78,length:.78,yaw:0})));
  const vehicle=car=>({...car.userData.vehicleSpec,...vehicleBounds(car)});
  return planParkingInteraction(event,{bays:world.parkingBays,occupied,obstacles,vehicle:vehicle(world.car),actorVehicle:cars[0]?vehicle(cars[0]):undefined,start:world.car.position,arrivalHold});
 }
 function seek({run,seconds,playing,world,origin,highlight,time}){
  const elapsed=clamp(seconds,0,run.duration),f=run.sample(elapsed),target=f.target,done=f.complete,active=playing&&!f.finished;
  highlight.position.set(target.x,.032,target.z);
  const completionAt=done?time-Math.max(0,elapsed-run.parkAt)*1000:null,selectedAt=time-Math.max(0,elapsed-(target===run.originalTarget?0:run.switchAt))*1000;
  world.car.position.set(f.ego.x,origin.carPosition.y,f.ego.z);world.car.rotation.y=f.ego.yaw;world.draftWheelDistance=f.ego.distance;world.draftWheelSteer=f.ego.steer||0;
  return {elapsed,target,done,active,paused:!active,completionAt,selectedAt};
 }
 function status(run,time){return {event:run.event,time,duration:run.duration,phase:run.sample(time).phase,phases:run.phases,decisionAt:run.decisionAt,yieldEnd:run.yieldEnd,releaseAt:run.releaseAt,forwardEnd:run.forwardEnd,switchAt:Number.isFinite(run.switchAt)?run.switchAt:null,originalTarget:{x:run.originalTarget.x,z:run.originalTarget.z},finalTarget:{x:run.finalTarget.x,z:run.finalTarget.z},actor:{...run.sample(time).actor,trafficFeedback:run.feedback('parking-actor',time)}};}
 return {configure,seek,status,camera,ribbon,actor,arrivalCamera:createParkingArrivalCamera};
}
