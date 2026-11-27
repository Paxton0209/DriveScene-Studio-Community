import assert from 'node:assert/strict';
import test from 'node:test';
import {planLiveCutIn} from '../adjacent-cut-in.js';
import {planRoadLaneChange} from '../road-lane-change.js';
import {coordinateWorkZone,planLiveWorkZone,ROADWORKS_CLEARED_DISTANCE} from '../roadworks-traffic.js';
import {overlaps} from '../parking-kinematics.js';

for(const mode of ['cutin','lanechange'])test(mode+' handles faster rear traffic and keeps every body clear',()=>{
 for(let seed=1;seed<=120;seed++){
  let state=seed*31337;
  const rand=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
  const egoX=5.55,speed=12+10*rand();
  const traffic=[-1,0,1].flatMap(lane=>[1,-1].map(side=>({
   id:lane+'-'+side,x:egoX+lane*3.7,z:side*(35+rand()*80),yaw:0,direction:-1,speed:13+rand()*13,
  })));
  const run=mode==='cutin'?planLiveCutIn(rand,{speed,egoX,outerLane:9.25,traffic}).sample
   :planRoadLaneChange(rand,{egoX,laneWidth:seed%2?-3.7:3.7,live:{traffic,speed,cruiseSpeed:80/3.6}});
  for(let frame=0;frame<=300;frame++){
   const f=run(frame/20);
   const bodies=[{x:egoX+f.x,z:0,yaw:f.yaw},...f.traffic.filter(c=>(c.growth??1)>.9)]
    .map(c=>({...c,width:2.1,length:4.9}));
   assert.ok(f.speed>=0);
   for(const [i,body] of bodies.entries())for(const other of bodies.slice(i+1)){
    assert.ok(!overlaps(body,other,0),JSON.stringify({mode,seed,frame,body,other}));
   }
  }
 }
});

test('a late work-zone merge reserves room for the turning vehicle corners',()=>{
 for(const seed of [40,94]){
  let state=seed*33247;
  const random=()=>((state=(Math.imul(1664525,state)+1013904223)>>>0)/2**32);
  random.reset=()=>{state=seed*33247;};
  const width=3.7,speed=16+random()*6;
  const cars=[-1,0,1].flatMap(lane=>[-1,1].map(side=>({
   id:lane+'-'+side,x:width*lane,station:side*(25+random()*65),speed:13+random()*12,direction:-1,
  })));
  const offset=planLiveWorkZone(cars,width,0,15,speed).offset;
  const run=coordinateWorkZone(random,cars,{
   width,offset,duration:15,initial:{speed,entryX:0},clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset,
   adaptiveTraffic:true,extendUntilClear:true,
  });
  for(let t=0;t<=run.timing.endAt;t+=.05){
   const f=run.sample(t),ego={x:f.x,z:0,yaw:f.yaw,width:2.1,length:4.9};
   for(const car of f.traffic)assert.ok(!overlaps(ego,{...car,width:2.1,length:4.9},0),seed+' at '+t);
  }
 }
});

test('a slow or stopped leader leaves braking distance in either road interaction',()=>{
 const egoX=5.55,speed=22;
 for(const pace of [0,6])for(const gap of [53,85]){
  const traffic=[{id:'leader',x:egoX,z:-gap,yaw:0,speed:pace,direction:-1}];
  const live={speed,cruiseSpeed:speed,traffic};
  const runs=[planLiveCutIn(()=>.5,{egoX,speed,outerLane:9.25,traffic}).sample,
   planRoadLaneChange(()=>.5,{egoX,laneWidth:3.7,live})];
  for(const run of runs)for(let t=0;t<=15;t+=.05){
   const f=run(t),lead=f.traffic.find(c=>c.id==='leader');
   if(lead&&Math.abs(egoX+f.x-lead.x)<2.1)assert.ok(lead.z<=-4.9);
  }
 }
});

test('a fully hidden handoff car cannot constrain the lane change',()=>{
 const traffic=[{id:'hidden',x:5.55,z:-23,speed:4,opacity:0,direction:-1,yaw:0}];
 const at=planRoadLaneChange(()=>.5,{egoX:5.55,laneWidth:3.7,live:{traffic,speed:22,cruiseSpeed:22}});
 assert.equal(at(10).speed,22);
});

test('a lane change responds to a slow leader and releases it once the new lane is clear',()=>{
 const egoX=5.55,speed=22;
 const traffic=[{id:'old',direction:-1,x:egoX,z:-32,yaw:0,speed:11}];
 const at=planRoadLaneChange(()=>.5,{egoX,laneWidth:3.7,live:{traffic,speed,cruiseSpeed:speed}});
 assert.ok(at(1).traffic[0].constraining);
 const end=at(0).laneChange.settledAt;
 assert.equal(at(end+1).traffic[0].constraining,false);
 assert.ok(at(15).speed>at(end).speed+5);
});

for (const [name, entryX, speed, initialOffset, entries] of [
 ['ego yields to a slow car merging across two lanes', 0, 21.186, 12, [
  [-1,-103.77,24.26], [0,51.06,20.27], [0,-33.75,16.70], [1,40.75,13.49], [1,-118.23,17.08],
 ]],
 ['rear traffic brakes behind a slowing work-zone queue', 3.7, 16.566, -6, [
  [-1,105.19,13.35], [0,44.17,17.20], [0,-95.69,23.95], [1,114.66,15.03], [1,-50.71,21.86],
 ]],
]) test(name, () => {
 const width = 3.7, duration = 15, random = () => .5;
 random.reset = () => {};
 const cars = entries.map(([lane, station, speed], index) => ({id:String(index), x:lane*width, station, speed, direction:-1}));
 const {offset} = planLiveWorkZone(cars, width, initialOffset, duration, speed);
 const run = coordinateWorkZone(random, cars, {width, offset, duration, initial:{speed,entryX},
  clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset, adaptiveTraffic:true, extendUntilClear:true});
 for (let tick=0; tick<=Math.ceil(run.timing.endAt*60); tick++) {
  const frame = run.sample(tick/60);
  const bodies = [{x:frame.x,z:0,yaw:frame.yaw}, ...frame.traffic].map(car => ({...car,width:2.1,length:4.9}));
  for (const [i, body] of bodies.entries()) {
   assert.ok([body.x,body.z,body.yaw].every(Number.isFinite));
   for (const other of bodies.slice(i+1)) assert.ok(!overlaps(body,other,0), name+' at '+tick+'/60 s');
  }
 }
});
