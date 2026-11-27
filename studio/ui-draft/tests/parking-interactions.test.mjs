import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {planParkingInteraction,PARKING_EVENTS} from '../parking-interactions.js';
import {overlaps} from '../parking-kinematics.js';
const bays=[-5.9,5.9].flatMap(x=>[10.8,7.2,3.6,0,-3.6,-7.2,-10.8,-14.4,-18].map(z=>({x,z,width:4.9,depth:2.8})));
const occupied=[3,7,11,14,16].map(i=>bays[i]);
const obstacles=occupied.map((b,i)=>({...b,x:b.x+(i%2?.10:-.10),z:b.z+(i%3-1)*.10,width:2.10,length:4.94,yaw:Math.PI/2+(i%2?.014:-.012)})).concat([-7.45,7.45].flatMap(x=>[-1.8,-12.6].map(z=>({x,z,width:.78,length:.78,yaw:0}))));
const actorVehicle={width:2.10,length:4.94};
for(const event of PARKING_EVENTS)for(const vehicle of [{width:1.85,length:4.72},{width:2.01,length:4.94},{width:1.97,length:4.95},{width:1.92,length:4.96}])test(`${event}: ${vehicle.length}m vehicle clears bodies and columns and parks successfully`,()=>{
 const run=planParkingInteraction(event,{bays,occupied,obstacles,vehicle,actorVehicle});
 assert.ok(run.duration>15&&run.duration<35);assert.ok(run.releaseAt>run.decisionAt);
 let previous=run.sample(0),peakSpeed=0,peakAcceleration=0,previousSpeed=0;
 for(let i=1;i<=Math.ceil(run.duration*120);i++){
  const time=Math.min(i/120,run.duration),f=run.sample(time),ego={...f.ego,...vehicle},actor={...f.actor,...actorVehicle};
  assert.equal(overlaps(ego,actor,.19),false,`vehicles overlap at ${time}`);
  for(const o of obstacles){assert.equal(overlaps(ego,o,.11),false,`ego hits parked car/column at ${time}`);assert.equal(overlaps(actor,o,.11),false,`actor hits parked car/column at ${time}`);}
  const speed=Math.hypot(f.ego.x-previous.ego.x,f.ego.z-previous.ego.z)*120;
  peakSpeed=Math.max(peakSpeed,speed);if(time<run.duration-1/120)peakAcceleration=Math.max(peakAcceleration,Math.abs(speed-previousSpeed)*120);
  assert.ok(Math.abs(f.ego.yaw-previous.ego.yaw)<.025,'no heading jump');assert.ok(Math.abs(f.ego.distance-previous.ego.distance)<.025,'wheel distance stays continuous');
  assert.ok(Math.abs(f.ego.steer)<=.565,'steering stays inside the bicycle limit');previous=f;previousSpeed=speed;
 }
 assert.ok(peakSpeed<=2.24,`parking speed ${peakSpeed}`);assert.ok(peakAcceleration<2.5,`parking acceleration ${peakAcceleration}`);
 const end=run.sample(run.duration);assert.equal(end.finished,true);assert.equal(end.complete,true);assert.equal(end.gear,'P');
 assert.ok(Math.hypot(end.ego.x-run.finalTarget.x,end.ego.z-run.finalTarget.z)<1e-6);assert.ok(Math.abs(end.ego.yaw-Math.sign(run.finalTarget.x)*Math.PI/2)<1e-8);
 assert.ok(vehicle.length<=run.finalTarget.width+.08&&vehicle.width<run.finalTarget.depth);
 assert.ok(Math.abs(run.phases.reduce((sum,[,d])=>sum+d,0)-run.duration)<1e-8);
 for(const time of [run.duration,0,run.releaseAt,run.decisionAt,run.duration/2])assert.deepEqual(run.sample(time),run.sample(time),'seeking is deterministic');
 if(event==='parking-yield'){
  assert.equal(run.originalTarget,run.finalTarget);const a=run.sample(run.yieldEnd+.1),b=run.sample(run.releaseAt-.1);assert.equal(a.ego.x,b.ego.x);assert.equal(a.ego.z,b.ego.z);assert.notEqual(a.actor.z,b.actor.z);
  const resume=run.sample(run.releaseAt).ego,stop=run.sample(run.forwardEnd).ego;
  assert.ok(stop.x>resume.x+.9&&stop.z<resume.z-2,'ego sets up forward and to the right before backing left');
  assert.ok(stop.yaw<=-24*Math.PI/180+1e-8,'the nose turns away from the selected space');
  const [drive,reverse]=run.route(run.releaseAt);
  assert.equal(drive.gear,'D');assert.equal(reverse.gear,'R');
  const d=drive.sample(drive.end),r=reverse.sample(reverse.begin);
  assert.ok(Math.hypot(d.x-r.x,d.z-r.z)<1e-8&&Math.abs(d.yaw-r.yaw)<1e-8,'both legs share the stopped gear-change pose');
 }else{
  const bay=run.originalTarget,atSwitch=run.sample(run.switchAt),atRelease=run.sample(run.releaseAt);
  assert.notEqual(bay,run.finalTarget);assert.equal(run.sample(run.switchAt-.001).target,bay);assert.equal(atSwitch.target,run.finalTarget);
  assert.equal(atSwitch.actor.phase,'reverse');
  assert.equal(overlaps({...atSwitch.actor,...actorVehicle},{...bay,width:bay.depth,length:bay.width,yaw:Math.PI/2},0),false);
  assert.equal(atRelease.actor.gear,'R','ego can begin while the other vehicle is still reversing');
  assert.ok(Math.hypot(end.actor.x-run.originalTarget.x,end.actor.z-run.originalTarget.z)<1e-8,'other car remains parked in the original bay');
 }
});

test('Unreachable interactions report a planning error instead of claiming success',()=>{
 assert.throws(()=>planParkingInteraction('parking-yield',{bays,occupied:bays}),/No clear/);
});

test('A run owns its origin when the live vehicle position changes',()=>{
 const start={x:0,z:0},run=planParkingInteraction('parking-yield',{bays,occupied,obstacles,start}),before=run.sample(0),later=run.sample(6);
 start.x=-4;start.z=-12;assert.deepEqual(run.sample(0),before);assert.deepEqual(run.sample(6),later);assert.equal(run.sample(run.duration).actor.x,1.65);
});

for(const event of PARKING_EVENTS)test(`${event}: only active constraints stay coloured and seeking preserves feedback`,()=>{
 const run=planParkingInteraction(event,{bays,occupied,obstacles});
 const feedback=t=>run.feedback('parking-actor',t);
 const stopped=(run.yieldEnd+run.releaseAt)/2;
 assert.equal(run.sample(stopped).yielding,true);
 const grey={level:0,yellow:0,red:0};
 if(event==='parking-yield'){
  const amber={level:1,yellow:1,red:0};
  for(const time of [2.6,5.0,6.5])assert.deepEqual(feedback(time),amber);
  assert.deepEqual(feedback(7.8),grey,'the departing car no longer affects the maneuver');
  assert.equal(run.sample(8.5).phase,'make-room');
  assert.deepEqual(feedback(8.5),grey,'a separating car does not inherit the phase colour');
  assert.deepEqual(feedback(stopped),grey,'the scripted pause does not prolong amber');
 }else{
  assert.ok(feedback(stopped).yellow+feedback(stopped).red>.99);
  assert.ok(run.switchAt<5.0&&run.releaseAt<8.5);
  assert.equal(run.sample(8.5).actor.gear,'R');
  assert.ok(run.sample(8.5).ego.distance>run.sample(run.releaseAt).ego.distance);
  assert.deepEqual(feedback(4.8),{level:1,yellow:1,red:0});
  assert.deepEqual(feedback(run.releaseAt+.4),grey);
  assert.deepEqual(feedback(run.releaseAt+.7),grey);
 }
 assert.deepEqual(feedback(run.duration),grey);
 const times=[0,5.0,8.5,stopped,run.releaseAt+.7,run.duration],expected=times.map(feedback);
 for(const t of [...times].reverse())feedback(t);
 assert.deepEqual(times.map(feedback),expected);
});

for(const event of PARKING_EVENTS)test(`${event}: reports leg-by-leg gear and remaining distance`,()=>{
 const run=planParkingInteraction(event,{bays,occupied,obstacles});
 const approachStart=run.sample(0),approachMid=run.sample(run.decisionAt*.5),approachEnd=run.sample(run.decisionAt-.01);
 assert.equal(approachMid.gear,'D');
 assert.ok(approachStart.remaining>approachMid.remaining&&approachMid.remaining>approachEnd.remaining&&approachEnd.remaining>2,'approach remaining covers the full displayed forward path');
 if(event==='parking-yield'){
  const early=run.sample(run.decisionAt+1),late=run.sample(run.yieldEnd-1);
  assert.equal(early.gear,'D');assert.equal(late.gear,'D');
  assert.ok(early.remaining>late.remaining&&late.remaining>0,'make-room counts down metres remaining');
 }
 const wait=run.sample((run.yieldEnd+run.releaseAt)/2);
 assert.equal(wait.remaining,null,'stationary wait has no remaining travel');
 const revEarly=run.sample(run.forwardEnd+1),revLate=run.sample(run.parkAt-1);
 assert.equal(revEarly.gear,'R');assert.equal(revLate.gear,'R');
 assert.ok(revEarly.remaining>revLate.remaining&&revLate.remaining>0,'reverse leg counts down metres remaining');
 const done=run.sample(run.duration);
 assert.equal(done.gear,'P');assert.equal(done.remaining,0);
});

test('Pro parking HUD appears immediately on toggle and tracks remaining distance 1:1 with vehicle speed',async()=>{
 const source=await readFile(new URL('../pro-prototype/prototype.js',import.meta.url),'utf8');
 const start=source.indexOf('let parkingStatusRenderKey = null;');
 const end=source.indexOf('\nfunction renderParkedControls()');
 const block=source.slice(start,end);
 const parts={'.parking-gear text':{textContent:''},'.parking-instruction':{textContent:''},'.parking-reminder':{textContent:''}};
 const node={hidden:true,dataset:{},attributes:{},querySelector:sel=>parts[sel],setAttribute(k,v){this.attributes[k]=v;}};
 const render=new Function('$','S','isParkingScene','parkedView',`${block}\nreturn renderParkingStatus;`)(
  id=>id==='parking-status'?node:null,{scene:'parking'},s=>s==='parking'||s==='outdoor',()=>false
 );
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:8.45,distance:0,speed:0,elapsed:0,active:true,paused:false,phase:'approach'}});
 assert.equal(node.hidden,false,'appears immediately when toggled on');
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20098.4 m');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:8.42,distance:0.03,speed:0.03,elapsed:.15,active:true,paused:false,phase:'approach'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20098.4 m','stays frozen while effectively stationary');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:8.2,distance:0.25,speed:0.7,elapsed:.7,active:true,paused:false,phase:'approach'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20098.2 m','tracks true remaining distance 1:1 as car rolls');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:7.8,distance:0.65,speed:0.85,elapsed:1.15,active:true,paused:false,phase:'approach'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20097.8 m','no artificial catch-up jump while rolling');
 assert.equal(node.dataset.executing,'true');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:7.5,distance:0.95,speed:0.35,elapsed:1.65,active:true,paused:false,phase:'approach'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20097.5 m','slows down proportionally as car brakes');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:7.45,distance:1.0,speed:0.02,elapsed:2.0,active:true,paused:false,phase:'approach'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20097.5 m','freezes once speed drops to rest');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:7.13,distance:1.0,speed:0.01,elapsed:2.15,active:true,paused:false,phase:'make-room'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20097.5 m','stays frozen while stopped between legs');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:7.0,distance:1.15,speed:0.55,elapsed:2.55,active:true,paused:false,phase:'make-room'}});
 assert.equal(parts['.parking-instruction'].textContent,'Continue\u20097.0 m','resumes 1:1 countdown once car rolls again');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:7.0,distance:1.15,speed:0,elapsed:2.8,active:false,paused:true,phase:'make-room'}});
 assert.equal(node.hidden,false);assert.equal(parts['.parking-instruction'].textContent,'Paused');assert.equal(node.dataset.executing,'false');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'D',remaining:null,distance:8.1,speed:0,elapsed:8.2,active:true,paused:false,phase:'yield'}});
 assert.equal(parts['.parking-instruction'].textContent,'Waiting');assert.equal(node.dataset.executing,'false');
 render({features:{path:true},parking:{target:{x:-5.9,z:-3.6},gear:'P',remaining:0,distance:10,speed:0,elapsed:20.2,active:false,paused:false,complete:true,phase:'parked'}});
 assert.equal(parts['.parking-instruction'].textContent,'Parked');assert.equal(node.dataset.complete,'true');assert.equal(node.dataset.executing,'false');
});
