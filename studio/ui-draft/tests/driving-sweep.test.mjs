import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planLiveCutIn,planAdjacentCutIn} from '../adjacent-cut-in.js';
import {planRoadworksTraffic,coordinateWorkZone,planLiveWorkZone,ROADWORKS_CLEARED_DISTANCE,ROADWORKS_CONE_START,ROADWORKS_CONE_SPACING,ROADWORKS_TAPER_INTERVALS} from '../roadworks-traffic.js';
import {JUNCTION_LEFT_TIMING,planJunctionTurn} from '../junction-left-turn.js';
import {overlaps} from '../parking-kinematics.js';
import {feedbackOverlap} from '../traffic-feedback.js';
import {planRampMerge} from '../ramp-merge.js';

const makeRng = seed => { let state=seed;const rand=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);rand.reset=()=>{state=seed};return rand; };
const body=(x,z,yaw)=>({x,z,yaw,width:2.1,length:4.9});
const boxes=(a,b)=>overlaps({...a,width:2.1,length:4.9},{...b,width:2.1,length:4.9});

for(const scenario of ['road','elevated','junction','ramp']) test(scenario+' rules across 500 reproducible traffic seeds',()=>{
 const fail = {}, coverage = {};
function count(key, label) {const group=coverage[key]??={};group[label]=(group[label]??0)+1;}
function issue(key,seed,t,detail) {const group=fail[key]??={count:0,examples:[]};group.count++;if(group.examples.length<6)group.examples.push({seed,t,detail});}
  function collision(f, ego, seed, t, name) {
 const traffic=f.traffic.filter(c=>(c.growth??1)>.9&&c.direction<0);
 for (const [i,c] of traffic.entries()) {
  if(boxes(c,ego)) {issue(name,seed,t,[ego,c.id,c.x,c.z]);return true;}
  if(traffic.slice(i+1).some(b=>boxes(c,b))) {issue(name+' actors',seed,t,[c.id]);return true;}
 }
 return false;
}

 for (let s=1;s<=500;s++) {
 const random=makeRng(Math.imul(s,123456789));
 if(scenario==='road'){
  const egoX = s%2 ? 5.55 : 1.85, outerLane=egoX+3.7;
  const shape = s%5, speed=22;
  const cars=shape===0?[]:shape===1?[{id:'lead',x:outerLane,z:-27-random()*43,yaw:0,direction:-1,speed:17+random()*6}]
   :shape===2?[{id:'overtaker',x:outerLane,z:6+random()*38,yaw:0,direction:-1,speed:26+random()*6}]
   :shape===3?[{id:'cruise-lead',x:egoX,z:-39-random()*34,yaw:0,direction:-1,speed:15+random()*6},
     {id:'overtaker',x:outerLane,z:6+random()*38,yaw:0,direction:-1,speed:26+random()*6}]
   :[{id:'slower',x:outerLane,z:-23-random()*30,yaw:0,direction:-1,speed:18+random()*6},
     {id:'fast-rear',x:outerLane,z:22+random()*40,yaw:0,direction:-1,speed:25+random()*6}];
  const run=planLiveCutIn(random,{egoX,outerLane,traffic:cars,speed});
  const candidate=run.sample(0).traffic.at(-1);
  if(Number.isFinite(run.timing.merge)) {
   const {impactAt,inLane}=run.timing;
   assert.ok(impactAt<inLane);
   assert.ok(run.sample(impactAt+.3).brakeStrength>0);
  }
  count('road', !Number.isFinite(run.timing.merge)?'cruise with no gap':Number.isFinite(run.timing.impactAt)?'yield':'merge without yield');
  if(Number.isFinite(run.timing.merge) && candidate?.z>0) count('road source','rear');
  else if(Number.isFinite(run.timing.merge)) count('road source','ahead');
  let highestLevel=0;
  for(let tick=0;tick<=300;tick++){
   const t=tick/20,f=run.sample(t);
   if(collision(f,body(egoX,0,f.yaw),s,t,'road'))break;
   const actor=f.traffic.find(car=>car.id===run.timing.actorId);
   const phase=run.timing.phases.findLast(({at})=>at<=t+1e-8)?.phase;
   if(phase==='cut-in'&&t<15&&(!actor?.constraining||actor.trafficFeedback.level!==1))issue('amber without constraint',s,t,phase);
   if(phase==='risk'&&t<15&&actor?.trafficFeedback.level!==2)issue('red timeline mismatch',s,t,phase);
   highestLevel=Math.max(highestLevel,actor?.trafficFeedback.level??0);
   if(!Number.isFinite(run.timing.cameraRiseAt)&&f.lift!==0)issue('unrelated traffic lifted camera',s,t,run.timing);
  }
  count('live road',['gray','amber','red'][highestLevel]);
 }
 if(scenario==='elevated'){
  const offset=[-6,12,72,150,218][s%5];
  const settings={duration:15,width:3.7,offset,clearedDistance:ROADWORKS_CLEARED_DISTANCE+offset,adaptiveTraffic:true,extendUntilClear:true};
  const initial={time:0,distance:0,speed:22,x:0,yaw:0,acceleration:0};
  const fleet=[
    {id:'inside',x:-3.7,station:30+random()*65,speed:16+random()*9,direction:-1},
    {id:'middle',x:0,station:25+random()*42,speed:14+random()*11,direction:-1},
    {id:'outside',x:3.7,station:20+random()*56,speed:15+random()*9,direction:-1},
    {id:'behind',x:-3.7,station:-24-random()*38,speed:19+random()*11,direction:-1},
  ];
  const actual=s%2?planLiveWorkZone(fleet,3.7,offset,15,initial.speed).offset:offset;
  settings.offset=actual;
  settings.clearedDistance=ROADWORKS_CLEARED_DISTANCE+actual;
  const run=s%2?coordinateWorkZone(random,fleet,{...settings,initial})
    :planRoadworksTraffic(random,{...settings,trafficEnabled:s%4!==0});
  const {clearAt,waitAt,endAt}=run.timing;
  count('elevated', Number.isFinite(clearAt)?clearAt>15?'late pass':'pass':Number.isFinite(waitAt)?'wait':'unresolved');
  if(Number.isFinite(clearAt)&&run.sample(endAt).distance<settings.clearedDistance+10)issue('elevated tail',s,endAt,run.timing);
  for(let t=0;t<=endAt;t+=.125){
   const f=run.sample(t), ego=body(f.x,0,f.yaw);
   if(collision(f,ego,s,t,'elevated'))break;
   let hit=false;
   for(const car of [ego,...f.traffic.filter(c=>c.direction<0)]) {
    for(let i=0;i<14;i++){
     const dx=5.23-Math.min(i/ROADWORKS_TAPER_INTERVALS,1)*6.76-car.x;
     const dz=f.distance-ROADWORKS_CONE_START-actual-ROADWORKS_CONE_SPACING*i-car.z;
     const side=dx*Math.cos(car.yaw)-dz*Math.sin(car.yaw);
     const longitudinal=dz*Math.cos(car.yaw)+dx*Math.sin(car.yaw);
     if(Math.abs(longitudinal)<2.8&&Math.abs(side)<1.27) {issue('cones',s,t,[offset,car.id,car.x,car.z]);hit=true;break;}
    }
    if(hit)break;
   }
   if(hit)break;
  }
 }
 if(scenario==='junction'){
  const run=planJunctionTurn(random,-22.3);
  count('junction', !Number.isFinite(run.timing.turnAt)?'wait to end':run.timing.turnAt===JUNCTION_LEFT_TIMING.turnAt?'early':'wait then turn');
  for(let t=3.5;t<=run.timing.duration;t+=.029){
   const f=run.sample(t);
   if(f.traffic.some(c=>feedbackOverlap(c,f))){issue('junction',s,t,run.timing);break;}
  }
 }
 if(scenario==='ramp'){
  const exit=planAdjacentCutIn(random,{layout:'06',egoX:3.7});
  count('exit',Number.isFinite(exit(0).cutInTiming.impactAt)?'yield':'cruise');
  const enter=planRampMerge(random,3.7);
  const timing=enter(0).rampMerge;
  count('entrance',timing.strategy);
  const liveExit=planLiveCutIn(makeRng(Math.imul(s,123456789)),{
   egoX:3.7,outerLane:3.7,innerLane:-3.7,traffic:[],speed:80/3.6,rampExit:true,
  });
  assert.ok(liveExit.timing.impactAt<liveExit.timing.inLane);
  assert.ok(liveExit.sample(liveExit.timing.impactAt+.3).brakeStrength>0);
  let highestLevel=0;
  for(let tick=0;tick<=300;tick++){
   const t=tick/20,f=liveExit.sample(t);
   if(collision(f,body(3.7,0,f.yaw),s,t,'live ramp exit')) break;
   const actor=f.traffic.find(car=>car.id===liveExit.timing.actorId);
   const phase=liveExit.timing.phases.findLast(({at})=>at<=t+1e-8)?.phase;
   if(phase==='cut-in'&&t<15&&(!actor?.constraining||actor.trafficFeedback.level!==1))issue('amber without constraint',s,t,phase);
   if(phase==='risk'&&t<15&&actor?.trafficFeedback.level!==2)issue('red timeline mismatch',s,t,phase);
   highestLevel=Math.max(highestLevel,actor?.trafficFeedback.level??0);
  }
  count('live exit',['gray','amber','red'][highestLevel]);
  if(highestLevel===0&&liveExit.sample(4.9).lift!==0)issue('safe merge lifted camera',s,4.9,liveExit.timing);
  for(const [name,run] of [['exit',exit],['entrance',enter]]) {
   for(let t=0;t<=15;t+=.1) {
    const f=run(t);
    if(collision(f,body(3.7+f.x,0,f.yaw),s,t,name)) break;
   }
  }
 }
}
 const expected = {
  road: {road:['cruise with no gap','yield'],'road source':['ahead','rear'],'live road':['amber','gray','red']},
  elevated: {elevated:['late pass','pass','wait']},
  junction: {junction:['early','wait then turn']},
  ramp: {exit:['yield'],'live exit':['amber','red']},
 };
 for(const [kind,branches] of Object.entries(expected[scenario])) {
  assert.deepEqual(Object.keys(coverage[kind]).sort(),branches);
 }
 console.log(JSON.stringify(coverage));
 assert.deepEqual(fail,{});
});
