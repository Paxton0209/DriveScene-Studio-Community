import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JUNCTION_LEFT_TIMING as timing, JUNCTION_EXIT_CRUISE, JUNCTION_TURN_SPEED, createJunctionStream, createTrafficAfterJunctionCommit, junctionLeftPath, planJunctionTurn, sampleJunctionLeftTurn} from '../junction-left-turn.js';
import {createTrafficFeedback,feedbackOverlap} from '../traffic-feedback.js';

const stopZ=-19.6;
const sample=t=>sampleJunctionLeftTurn(t,stopZ);
function seeded(seed){
 let state=seed*79271;
 return ()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
}

test('Junction holds its pose for five left indicator pulses at the stop line',()=>{
 const run=planJunctionTurn(()=>.45,stopZ,{time:0,cars:[]});
 const start=run.sample(timing.stopAt);
 assert.equal(run.timing.turnAt,7.5);
 assert.equal(run.sample(timing.stopAt-.01).lamp,0);
 let pulses=0,lastLit=false;
 for(let i=0;i<400;i++){
  const frame=run.sample(timing.stopAt+i/100);
  const lit=frame.lamp>.5;
  if(lit&&!lastLit)pulses++;
  lastLit=lit;
  assert.deepEqual([frame.x,frame.z,frame.yaw,frame.speed,frame.pathRelease],[start.x,start.z,0,0,0]);
 }
 assert.equal(pulses,5);
 assert.equal(lastLit,false);
 assert.ok(run.sample(timing.turnAt+.1).distance>0);
 assert.ok(planJunctionTurn(()=>.45,stopZ,{time:0,cars:[]},undefined,5).timing.turnAt>=timing.turnAt);
});

test('Junction front-axle path curves left throughout and merges straight into the exit lane',()=>{
 const path=junctionLeftPath();
 let lastHeading=0;
 for(let i=1;i<path.length;i++){
  const [x,z]=path[i],[px,pz]=path[i-1];
  const heading=Math.atan2(px-x,pz-z);
  assert.ok(heading>=lastHeading-1e-8&&z>=-41.85-1e-8);
  lastHeading=heading;
 }
 assert.equal(lastHeading,Math.PI/2);
});

test('junction ego holds for the first oncoming car and crosses ahead of the second',()=>{
 // Check an envelope for each vehicle, with extra space beyond its body.
 const halfLength=2.65,halfWidth=1.18;
 const turn=sample(timing.turnAt);
 assert.equal(turn.z,stopZ);
 assert.equal(turn.speed,0);
 assert.ok(turn.oncoming[0].z-halfLength>-27,'first car has cleared the near crosswalk at release');
 let sawCrossing=false;
 for(let t=timing.turnAt;t<=timing.clearAt;t+=.01){
  const {x,z,yaw,oncoming}=sample(t);
  const dx=halfWidth*Math.abs(Math.cos(yaw))+halfLength*Math.abs(Math.sin(yaw));
  const dz=halfLength*Math.abs(Math.cos(yaw))+halfWidth*Math.abs(Math.sin(yaw));
  for(const car of oncoming) if(Math.abs(x-car.x)<=dx+halfWidth){
   sawCrossing=true;
   assert.ok(Math.abs(z-car.z)>dz+halfLength+3,`insufficient separation at ${t}`);
  }
 }
 assert.ok(sawCrossing);
 const clear=sample(timing.clearAt);
 assert.ok(clear.x+halfLength<-11.1,'the entire ego has cleared the cross street');
 assert.equal(clear.signal,false);
 assert.ok(Math.abs(clear.yaw-Math.PI/2)<.03);
 assert.ok(sample(timing.duration).oncoming[1].z>-40,'the following car continues through');
 assert.ok(sample(timing.duration).x < clear.x - 40,'ego continues down the new road through the extended tail');
});

test('Junction gains speed while steering unwinds and accelerates through the exit without a hold',()=>{
 assert.equal(sample(timing.turnAt).speed,0);
 assert.ok(sample(timing.turnAt+1).speed>0);
 assert.ok(sample(timing.turnAt+1).speed<JUNCTION_TURN_SPEED);
 const normal=planJunctionTurn(()=>.45,stopZ,{time:0,cars:[]});
 const exit=normal.timing.clearAt, unwinding=normal.sample(exit-1);
 assert.ok(unwinding.steer>0&&unwinding.steer<normal.sample(exit-2).steer);
 assert.ok(unwinding.speed>normal.sample(exit-2).speed&&normal.sample(exit-.5).speed>unwinding.speed);
 const run=planJunctionTurn(()=>.45,-24.36,{time:0,cars:[]});
 const {clearAt,duration}=run.timing, dt=.001;
 assert.ok(run.sample(clearAt-1).steer>.01&&run.sample(clearAt-1).speed>JUNCTION_TURN_SPEED);
 assert.ok(run.sample(clearAt-.25).speed*3.6>30);
 for(let t=clearAt-.4;t<duration-dt;t+=.02){
  const before=run.sample(t-dt),after=run.sample(t+dt),current=run.sample(t);
  assert.ok(Math.abs((after.distance-before.distance)/(2*dt)-current.speed)<.001);
  assert.ok(current.speed>=before.speed-1e-12&&current.speed<=after.speed+1e-12);
  if(Math.abs(t-clearAt)<.45)assert.ok((after.speed-before.speed)/(2*dt)>1.5);
 }
 assert.equal(run.sample(duration-1).speed,JUNCTION_EXIT_CRUISE);
});

test('The Junction ribbon follows the front axle and both steering angles follow their wheel tracks',()=>{
 for(const axles of [{rearOffset:1.38,wheelbase:2.85},{rearOffset:1.48,wheelbase:3.06}]){
  const run=planJunctionTurn(()=>.45,stopZ,{time:0,cars:[]},undefined,0,axles);
  const ribbon=junctionLeftPath();
  const frontOffset=axles.rearOffset-axles.wheelbase;
  const wheel=(pose,x)=>({
   x:pose.x+x*Math.cos(pose.yaw)+frontOffset*Math.sin(pose.yaw),
   z:pose.z-x*Math.sin(pose.yaw)+frontOffset*Math.cos(pose.yaw),
  });
  let lastSteer=0,peakSteer=0,lastYaw=0;
  for(let t=run.timing.turnAt+.2;t<run.timing.clearAt+.2;t+=.0125){
   const pose=run.sample(t),dt=.001;
   const before=run.sample(t-dt),after=run.sample(t+dt);
   const error=Math.min(...ribbon.slice(1).map(([bx,bz],i)=>{
    const [ax,az]=ribbon[i],dx=bx-ax,dz=bz-az;
    const u=Math.max(0,Math.min(1,((pose.frontX-ax)*dx+(pose.frontZ-az)*dz)/(dx*dx+dz*dz)));
    return Math.hypot(ax+u*dx-pose.frontX,az+u*dz-pose.frontZ);
   }));
   assert.ok(error<.002,'ribbon aligns to the front axle within 2 mm');
   assert.ok(pose.yaw>=lastYaw&&pose.steer>=0,'the car never counter-steers or overshoots the exit');
   lastYaw=pose.yaw;
   assert.ok(Math.abs(pose.steer-lastSteer)<.012,'steering eases in and unwinds across frames');
   lastSteer=pose.steer;
   peakSteer=Math.max(peakSteer,pose.steer);
   for(const x of [-.86,.86]){
    const a=wheel(before,x),b=wheel(after,x),tangent=Math.tan(pose.steer);
    const angle=pose.yaw+Math.atan(axles.wheelbase*tangent/(axles.wheelbase+x*tangent));
    assert.ok(Math.abs(Math.atan2(a.x-b.x,a.z-b.z)-angle)<.002,'front tire points along its track');
   }
  }
  const radius=axles.wheelbase/Math.tan(peakSteer);
  assert.ok(radius>=6&&radius<6.3,'rear axle follows the tighter turn radius');
  assert.ok(run.sample(run.timing.clearAt).steer<.013);
  assert.ok(run.sample(run.timing.clearAt+1).steer<.001);
 }
});

test('Junction completes the turn for finite through traffic and keeps the live cross traffic moving',()=>{
 const openings=new Set();
 for(let seed=1;seed<=96;seed++){
  const run=planJunctionTurn(seeded(seed),stopZ),{turnAt,duration}=run.timing;
  openings.add(turnAt);
  assert.ok(Number.isFinite(turnAt),`seed ${seed} never turns`);
  assert.equal(run.sample(duration-1).speed,JUNCTION_EXIT_CRUISE);
  for(let t=timing.stopAt;t<duration;t+=.043){
   const frame=run.sample(t);
   if(t<turnAt){assert.equal(frame.distance,0);continue;}
   const replaced=run.sample(t,{rearOffset:1.48,wheelbase:3.06,length:4.95,width:2.12});
   for(const car of frame.traffic){
    assert.equal(feedbackOverlap(frame,car),false,`seed ${seed} at ${t}`);
    assert.equal(feedbackOverlap(replaced,car),false,`seed ${seed} after vehicle replacement at ${t}`);
   }
  }
  assert.deepEqual(run.sample(6),run.sample(6));
 }
 assert.ok(openings.size>=6);
 const cross={id:'live',axis:'x',direction:1,speed:9,x:-47,z:-34.45,yaw:-Math.PI/2};
 const run=planJunctionTurn(()=>assert.fail('live traffic must not draw a synthetic stream'),stopZ,{time:2,cars:[cross]});
 for(const t of [1.9,2,2.5,3,3.5,7,12]){
  const [pose]=run.sample(t).traffic;
  assert.deepEqual(run.sample(t).traffic.map(car=>car.id),['live']);
  assert.equal(pose.x,cross.x+(t-2)*cross.speed);
  assert.equal(pose.speed,cross.speed);
 }
});

test('Traffic enabled mid-signal approaches from its entry road',()=>{
 const enabledAt=5;
 for(let seed=1;seed<=32;seed++){
  const run=planJunctionTurn(seeded(seed),stopZ,null,undefined,enabledAt);
  const [first]=run.sample(enabledAt).traffic;
  const [entry]=createJunctionStream(seeded(seed)).cars;
  assert.deepEqual([first.x,first.z],[entry.x,entry.z]);
  assert.ok(first.axis==='x'?Math.abs(first.x)>23:Math.abs(first.z+40)>23);
 }
});

test('Late Junction traffic can enter during the turn and on the exit without intercepting ego', () => {
 for (const stop of [-19.6, -24.36]) {
  const run = planJunctionTurn(seeded(1), stop, {time: 0, cars: []});
  const {turnAt, clearAt, duration} = run.timing;
  for (let seed = 1; seed <= 96; seed++) {
   for (const enabledAt of [turnAt, turnAt + 2, clearAt - .1, clearAt, duration - .25]) {
    const traffic = createTrafficAfterJunctionCommit(seeded(seed), enabledAt, run.sample(enabledAt), clearAt);
    assert.deepEqual(traffic(enabledAt - .01), []);
    assert.match(traffic(enabledAt)[0].id, /^junction-(near-approach|opposing-exit)$/);
    for (let t = enabledAt; t <= duration; t += .1) {
     assert.ok(traffic(t).every(car => !feedbackOverlap(run.sample(t), car)), `seed ${seed}, enabled at ${enabledAt}, t=${t}`);
    }
   }
  }
 }
});

test('Junction reaches the turn speed inside the curve for different stop lines',()=>{
 for(const stop of [-18.4,-24.36,-25.5]){
  const run=planJunctionTurn(()=>.45,stop),clear=run.sample(run.timing.clearAt);
  assert.ok(Number.isFinite(run.timing.clearAt));
  assert.ok(Math.abs(clear.x+14.5)<1e-8,'clearAt still marks the physical curve exit');
  assert.equal(clear.frontZ,-41.85);
  assert.ok(Math.abs(clear.z+41.85)<.02);
  assert.ok(clear.speed>JUNCTION_TURN_SPEED);
  assert.ok(run.sample(run.timing.clearAt-.15).speed<clear.speed);
 }
});

test('Junction marks only the crossing car that delays departure after the signal hold',()=>{
 const car=(id,x)=>({id,x,z:-34.45,axis:'x',direction:1,yaw:-Math.PI/2,speed:12});
 const time=timing.turnAt, follower=car('follower',-26), lead=car('lead',-7);
 const run=planJunctionTurn(()=>.45,-24.36,{time,cars:[follower,lead]});
 const feedback=createTrafficFeedback(t=>{const ego=run.sample(t);return {ego,traffic:ego.traffic};},{duration:run.timing.duration});
 assert.equal(run.sample(time+.15).speed,0);
 assert.equal(feedback('lead',time+.15).level,0);
 assert.equal(feedback('follower',time+.15).yellow,1);
 assert.equal(feedback('follower',run.timing.turnAt+.1).level,0);
 assert.equal(planJunctionTurn(()=>.45,-24.36,{time,cars:[follower]}).timing.turnAt,run.timing.turnAt);
 assert.ok(planJunctionTurn(()=>.45,-24.36,{time,cars:[lead]}).timing.turnAt<run.timing.turnAt);
});

test('Junction waits past the old cutoff and extends the replay to show the completed turn',()=>{
 const run=planJunctionTurn(seeded(38),-24.36);
 const {turnAt,clearAt,duration}=run.timing;
 assert.ok(Number.isFinite(turnAt)&&turnAt>10);
 assert.equal(run.sample(10).speed,0);
 assert.ok(duration>=clearAt+4);
 assert.ok(run.sample(clearAt).speed>JUNCTION_TURN_SPEED);
});

test('Junction holds at the line when a stopped vehicle occupies the turning path',()=>{
 const obstacle={id:'stopped-cross',axis:'x',x:1.85,z:-34.45,direction:1,yaw:-Math.PI/2,speed:0};
 const run=planJunctionTurn(()=>.45,stopZ,{time:0,cars:[obstacle]});
 assert.equal(run.timing.turnAt,Infinity);
 assert.equal(run.sample(run.timing.duration).speed,0);
 assert.equal(run.sample(run.timing.duration).z,stopZ);
});
