import test from 'node:test';
import assert from 'node:assert/strict';
import {INTERACTION_CAMERA,interactionCameraLift} from '../interaction-camera.js';
import {sampleFollowingEvent} from '../elevated-following.js';
import {sampleRoadworks,createElevatedRoadworks} from '../elevated-roadworks.js';
import * as THREE from 'three';
import {ROADWORKS_MERGE_DISTANCE,ROADWORKS_CLEARED_DISTANCE,planRoadworksTraffic,roadworksCameraInRange} from '../roadworks-traffic.js';
import {planRoadLaneChange} from '../road-lane-change.js';
import {planAdjacentCutIn,planLiveCutIn} from '../adjacent-cut-in.js';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} versus ${expected}`);
test('Auto rises to the full High endpoint in 1.5s and returns in 1.4s with stationary endpoints',()=>{
 assert.deepEqual(INTERACTION_CAMERA,{rise:1.5,fall:1.4});
 const f=t=>interactionCameraLift(t,2,5);
 for(const [t,lift]of [[2,0],[2.75,.5],[3.5,1],[5,1],[5.7,.5],[6.4,0]])close(f(t),lift);
 for(const t of [2,3.5,5,6.4])assert.ok(Math.abs(f(t+.0001)-f(t-.0001))/.0002<.00001);
});
test('Fixed Cut-in and AES retain alignment timing, while live Cut-in uses the full transition after evidence',()=>{
 for(const [event,rise,fall,settled]of [['cutin',2.55,4.15,5.55],['aes',1.35,5.7,7.1]]){
  const f=t=>sampleFollowingEvent(event,t,3.7).lift;
  close(f(rise),0);close(f(rise+1.5),1);close(f(fall),1);
  close(f((fall+settled)/2),.5);close(f(settled),0);close(f(settled+.2),0);
 }
 const collision=t=>sampleFollowingEvent('collision',t,3.7).lift;
 close(collision(3.15),1);close(collision(6.5),.5);close(collision(7.2),0);
 const live=planLiveCutIn(()=>.3,{egoX:1.85,outerLane:9.25,traffic:[],speed:16});
 live.sample(0);
 const {cameraRiseAt:riseAt,cameraReturnAt:returnAt,inLane}=live.timing;
 assert.ok(Number.isFinite(riseAt) && returnAt >= inLane);
 for(const [t,lift]of [[riseAt,0],[riseAt+.75,.5],[riseAt+1.5,1],[returnAt,1],[returnAt+.7,.5],[returnAt+1.4,0]]){
  close(live.sample(t).lift,lift);
 }
});
test('Road Cut-in at 5.1 seconds keeps a distant car grey and the camera Low until it affects cruise',()=>{
 let seed=79271;
 const run=planLiveCutIn(()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32),{
  egoX:1.85,outerLane:5.55,traffic:[],speed:80/3.6,
 });
 const distant=run.sample(5.1);
 const actor=distant.traffic.find(car=>car.id===run.timing.actorId);
 assert.ok(actor.intentKnown&&-actor.z>24);
 assert.equal(actor.trafficFeedback.yellow,0);
 assert.equal(distant.lift,0);
 assert.equal(distant.speed,80/3.6);
 const reacting=run.sample(run.timing.cameraRiseAt+.2);
 assert.ok(reacting.traffic.some(car=>car.id===actor.id&&car.trafficFeedback.yellow>0));
 assert.ok(reacting.speed<distant.speed&&reacting.lift>0);
});
test('Lane change and Merge keep High through gap selection and return within the maneuver',()=>{
 for(let seed=1;seed<=32;seed++){
  let n=seed;const random=()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/4294967296);
  const lane=planRoadLaneChange(random,{egoX:1.85,laneWidth:3.7}),{settledAt,steerAt,cameraHomeAt}=lane(0).laneChange;
  close(cameraHomeAt,settledAt);close(lane(steerAt).lift,1);close(lane(settledAt-.7).lift,.5);
  close(lane(cameraHomeAt).lift,0);close(lane(cameraHomeAt+.5).lift,0);close(lane(cameraHomeAt).targetBias,0);
  const merge=planAdjacentCutIn(random,{layout:'07',egoX:3.7}),m=merge(0).rampMerge;
  if(m.strategy==='wait'){close(merge(5).lift,0);close(merge(15).speed,0);continue;}
  assert.ok(m.cameraHomeAt>=m.settledAt);close(merge(m.decisionAt+1.5).lift,1);close(merge(m.mergeAt).lift,1);
  const fallAt=m.cameraHomeAt-INTERACTION_CAMERA.fall;
  close(merge(fallAt+.7).lift,.5);close(merge(m.cameraHomeAt).lift,0);
  assert.ok(m.cameraHomeAt<=10,'the entire return fits the run');
 }
});
test('Roadworks rises after approach and holds High until the work zone and merge are clear',()=>{
 for(const offset of [-6,0,12]){
  const {cameraRiseAt:riseAt}=sampleRoadworks(0,false,offset);
  const before=sampleRoadworks(riseAt-.02,false,offset),after=sampleRoadworks(riseAt+.02,false,offset);
  assert.equal(roadworksCameraInRange(before.distance,before.speed,offset),false);
  assert.equal(roadworksCameraInRange(after.distance,after.speed,offset),true);
  close(sampleRoadworks(riseAt,false,offset).lift,0);
  close(sampleRoadworks(riseAt+.75,false,offset).lift,.5);
  close(sampleRoadworks(riseAt+1.5,false,offset).lift,1);
  close(sampleRoadworks(6,false,offset).lift,1);
  const releaseDistance=Math.max(52+ROADWORKS_MERGE_DISTANCE,ROADWORKS_CLEARED_DISTANCE)+offset;
  let lo=0,hi=11;for(let i=0;i<40;i++){const m=(lo+hi)/2;if(sampleRoadworks(m,true,offset).distance<releaseDistance)lo=m;else hi=m;}
  const returnAt=(lo+hi)/2;
  close(sampleRoadworks(returnAt,false,offset).lift,1);
  close(sampleRoadworks(returnAt+.7,false,offset).lift,.5);
  close(sampleRoadworks(returnAt+1.4,false,offset).lift,0);
  close(sampleRoadworks(riseAt+.75,true,offset).lift,0);
 }
});


test('Roadworks traffic returns only after actual clearance and retains release timing across Traffic edits',()=>{
 for(const offset of [-6,0,12])for(let seed=1;seed<=32;seed++){
  let n=seed;const random=()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/4294967296);
  const options={duration:15,width:3.7,offset,clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset,adaptiveTraffic:true};
  const run=planRoadworksTraffic(random,options),release=run.sample(0).cameraReturnAt;
  assert.ok(Number.isFinite(release));
  const f=run.sample(release);
  assert.ok(f.distance>=Math.max(f.mergeEnd,options.clearedDistance)-1e-6);
  close(f.x,-3.7);assert.ok(Math.abs(f.yaw)<1e-5,'finite-difference heading is aligned');
  assert.ok(run.sample(release-.02).distance<Math.max(f.mergeEnd,options.clearedDistance));
  assert.ok(release+1.4<=12,'at least three seconds of driving remain after return');
  const time=release+.5,anchor=run.sample(time);
  const edited=planRoadworksTraffic(null,{...options,initial:{...anchor,time},trafficEnabled:false});
  close(edited.sample(time).cameraReturnAt,release);
  close(edited.sample(14).cameraReturnAt,release);
  assert.deepEqual(run.sample(0).cameraReturnAt,release);
 }
});

test('The rendered Auto endpoint equals manual High and Traffic edits invalidate cached feedback evidence',()=>{
 const previous=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:false});
 try{
  const car=new THREE.Mesh(new THREE.BoxGeometry(2,1.6,4.8),new THREE.MeshBasicMaterial()),root=new THREE.Group(),camera=new THREE.PerspectiveCamera(45,1920/1080,.1,500);
  root.add(car);const world={root,car,camera,cameraAim:new THREE.Vector3(),state:{id:'03',cameraView:'low'},dividedRoad:{egoCenter:0},draftTrafficEnabled:false,
   configureCamera(id,{cameraView}){camera.position.set(0,cameraView==='high'?26:8.5,cameraView==='high'?32:23);this.cameraAim.set(0,0,-15);camera.lookAt(this.cameraAim);camera.setViewOffset(1920,1080,0,0,1920,1080)},
   captureCamera(){return {position:camera.position.clone(),aim:this.cameraAim.clone(),carPosition:car.position.clone(),offset:{x:camera.view.offsetX,y:camera.view.offsetY}}}
  };
  const event=createElevatedRoadworks(world,{seekDraftDistance(){}},{enabled:true},()=>()=>.5);
  event.configure('collision');event.sample(3.2,'auto');const auto=camera.position.clone();
  assert.equal(world.draftRoadworksFrame.traffic.length,1);
  event.sample(3.2,'high');assert.ok(camera.position.distanceTo(auto)<1e-8);
  world.draftTrafficEnabled=true;event.sample(3.2,'auto');assert.ok(world.draftRoadworksFrame.traffic.length>1,'newly enabled ambient traffic appears without replay');
  world.draftTrafficEnabled=false;event.sample(3.2,'auto');assert.equal(world.draftRoadworksFrame.traffic.length,1,'disabled ambient traffic is removed without replay');
 }finally{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;}
});

test('A live Roadworks run joins and removes traffic at the current pose across repeated edits',()=>{
 const previous=globalThis.matchMedia;
 globalThis.matchMedia=()=>({matches:false});
 try{
  const root=new THREE.Group(), car=new THREE.Object3D(), assembly=new THREE.Group();
  const camera=new THREE.PerspectiveCamera(45,16/9,.1,500), aim=new THREE.Vector3(0,8.5,-24);
  assembly.name='elevated-roadworks-cones';root.add(car,assembly);car.position.y=8.52;
  const world={root,car,camera,cameraAim:aim,state:{id:'03',laneCount:6,cameraView:'low'},dividedRoad:{egoCenter:0},draftTrafficEnabled:false,
   configureCamera(_, {cameraView}){camera.position.set(0,cameraView==='high'?34.5:17,23);camera.lookAt(aim);camera.setViewOffset(1920,1080,0,0,1920,1080)},
   captureCamera(){return {position:camera.position.clone(),aim:aim.clone(),carPosition:car.position.clone(),offset:new THREE.Vector2()}}
  };
  const traffic={enabled:false,audit:()=>({positions:[],lanes:[]})};
  const random=()=>.5;random.reset=()=>{};
  const controller=createElevatedRoadworks(world,{seekDraftDistance(){}},traffic,()=>random,{adaptiveTraffic:true});
  const start=6;
  controller.configure('roadworks');
  controller.continueRoad(controller.captureRoadCruise(start,{distance:100,speed:22}),start,{camera:'auto',trafficEnabled:false});
  for(const time of [6,7,10,15,21]){
   controller.sample(time);
   const {x,distance,speed,lift}=world.draftRoadworksFrame;
   controller.setTrafficAt(time,true);world.draftTrafficEnabled=traffic.enabled=true;
   controller.sample(time);
   const enabled=world.draftRoadworksFrame;
   assert.ok(enabled.visibleTraffic.some(car=>(car.growth??1)>0));
   for(const [a,b] of [[enabled.x,x],[enabled.distance,distance],[enabled.speed,speed],[enabled.lift,lift]])close(a,b);
   controller.setTrafficAt(time,false);world.draftTrafficEnabled=traffic.enabled=false;
   controller.sample(time);
   assert.equal(world.draftRoadworksFrame.visibleTraffic.length,0);
   close(world.draftRoadworksFrame.distance,distance);
  }
 }finally{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;}
});

test('Cut-in waits for the lane change and slot fade, including rapid switches and scrubbing',()=>{
 const originalMatchMedia = globalThis.matchMedia;
 try {
  for (const reduced of [false,true]) for (const laneCount of [4,6]) for (const cameraView of ['auto','low','high']) {
   globalThis.matchMedia = () => ({matches:reduced});
   for (const seed of [.1,.9]) for (const event of ['cutin',null]) {
    for (const boundary of ['signal','steering','before alignment','alignment','fade','done']) {
     const root = new THREE.Group();
     const car = new THREE.Mesh(new THREE.BoxGeometry(2,1.6,4.8));
     const camera = new THREE.PerspectiveCamera(45,16/9,.1,500);
     const cameraAim = new THREE.Vector3(0,0,-15);
     root.add(car);
     const world = {root,car,camera,cameraAim,state:{id:'02',laneCount,cameraView},
      configureCamera(_, {cameraView}) {
       camera.position.set(0,cameraView==='high'?26:8.5,23);
       camera.lookAt(cameraAim);
       camera.setViewOffset(1920,1080,0,0,1920,1080);
      },
      captureCamera() {
       return {position:camera.position.clone(),aim:cameraAim.clone(),carPosition:car.position.clone(),
        offset:new THREE.Vector2(0,camera.view.offsetY)};
      },
      applyCamera() {},
     };
     const controller = createElevatedRoadworks(world,{seekDraftDistance(){}},{enabled:false},()=>()=>seed);
     controller.configure('lanechange');
     controller.sample(0,cameraView);
     const outgoing = controller.captureRoadRun();
     const {steerAt,settledAt} = outgoing.sample(0).laneChange;
     const at = {signal:1.2,steering:steerAt+.3,'before alignment':settledAt-.001,
      alignment:settledAt,fade:settledAt+.5,done:settledAt+1.1}[boundary];
     const slot = root.getObjectByName('lane-change-target');
     const lane = root.getObjectByName('lane-change-lane');
     controller.sample(at,cameraView);
     assert.equal(slot.visible,outgoing.sample(at).targetSlot.opacity>0);
     const before = world.draftRoadworksFrame;
     controller.reset();
     controller.configure(event);
     const options = {camera:cameraView,outgoingCamera:cameraView,trafficEnabled:true};
     controller.continueRoad(outgoing,at,options);
     controller.sample(at,cameraView);
     const after = world.draftRoadworksFrame;
     for (const key of ['x','yaw','distance','speed']) close(after[key],before[key]);
     close(after.pathX(-18),before.pathX(-18));
     const pending = controller.captureRoadRun();
     if (event === 'cutin' && !outgoing.sample(at).laneChange.waiting) assert.ok(pending.start >= settledAt+1);
     for (const time of [at,pending.start,pending.start+.03,pending.start+.5,pending.start+1.8,at-.05]) {
      controller.sample(time,cameraView);
      const retained = event === 'cutin' && time < pending.start ? outgoing.sample(time) : null;
      assert.equal(slot.visible,(retained?.targetSlot.opacity ?? 0)>0);
      assert.equal(lane.visible,(retained?.laneHighlight ?? 0)>0);
      assert.deepEqual(world.draftRoadworksFrame.targetSlot,retained?.targetSlot);
     }
     if (event === 'cutin' && pending.start>at+.02) {
      controller.reset();
      controller.configure('lanechange');
      controller.continueRoad(pending,at+.01,options);
      controller.sample(at+.01,cameraView);
      assert.equal(controller.captureRoadRun(),outgoing);
      assert.equal(slot.visible,outgoing.sample(at+.01).targetSlot.opacity>0);
     }
    }
   }
  }
 } finally {
  if (originalMatchMedia===undefined) delete globalThis.matchMedia;
  else globalThis.matchMedia = originalMatchMedia;
 }
});
