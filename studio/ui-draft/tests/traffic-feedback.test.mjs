import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createTrafficFeedback,feedbackOverlap,createFeedbackPainter,TRAFFIC_FEEDBACK} from '../traffic-feedback.js';
import {planRoadLaneChange} from '../road-lane-change.js';
import {planAdjacentCutIn} from '../adjacent-cut-in.js';

const ego={x:0,z:0,yaw:0,speed:10};
const row=(time,constraining=false)=>({ego,traffic:[{id:'actor',x:4,z:-10,yaw:0,speed:10,constraining},{id:'ambient',x:-8,z:-2,yaw:0,speed:10}]});
test('Constraint ownership keeps a safely stopped ego yellow while unrelated nearby traffic stays neutral',()=>{
 const sample=t=>{const f=row(t,t>=1&&t<3);f.ego={...ego,speed:0};return f};
 const feedback=createTrafficFeedback(sample,{duration:5});
 assert.equal(feedback('actor',.9).level,0);assert.equal(feedback('actor',1).level,1);assert.equal(feedback('actor',2.5).yellow,1);
 assert.equal(feedback('ambient',2).level,0);
 assert.equal(feedback('actor',2.99).yellow,1);assert.equal(feedback('actor',3).yellow,0);
 assert.equal(feedback('actor',3.9).yellow,0);
});
test('Yellow follows a constraint that clears briefly and then returns',()=>{
 const feedback=createTrafficFeedback(t=>row(t,t>=1&&(t<2||t>=2.35)&&t<3),{duration:5});
 for(const t of [1,1.99,2.36,2.99])assert.equal(feedback('actor',t).yellow,1);
 for(const t of [2,2.2,2.34,3])assert.equal(feedback('actor',t).yellow,0);
});
test('A distant planning constraint stays neutral until the vehicle is within reach',()=>{
 const feedback=createTrafficFeedback(t=>({ego:{...ego,speed:0},traffic:[
  {id:'approaching',x:-8,z:-64+10*t,speed:10,constraining:true},
  {id:'parked',x:-8,z:-46,speed:0,constraining:true},
 ]}),{duration:5});
 assert.equal(feedback('approaching',1).yellow,0);
 assert.equal(feedback('approaching',4).yellow,1);
 assert.equal(feedback('parked',5).yellow,0);
});
test('Complete rotated body footprints and a speed margin detect overlap away from the centres',()=>{
 assert.equal(feedbackOverlap(ego,{x:3.1,z:0,yaw:Math.PI/2,speed:2}),true);
 assert.equal(feedbackOverlap(ego,{x:7,z:0,yaw:Math.PI/2,speed:2}),false);
 assert.equal(feedbackOverlap({...ego,speed:0},{x:0,z:5,yaw:0,speed:0}),false,'stationary adjacency is not an urgent collision');
 assert.equal(feedbackOverlap({...ego,speed:2},{x:0,z:-10,yaw:0,speed:2}),false);
 assert.equal(feedbackOverlap({...ego,speed:20},{x:0,z:-10,yaw:0,speed:20}),true);
});
test('Red predicts at most 2.5 seconds ahead and downgrades through the same hold and fade',()=>{
 const feedback=createTrafficFeedback(t=>({ego,traffic:[{id:'actor',x:t>=4&&t<=4.2?0:5,z:-5,yaw:0,speed:10,constraining:t>=1&&t<6}]}),{duration:8});
 assert.equal(feedback('actor',1.4).level,1);assert.equal(feedback('actor',1.5).level,2);
 assert.equal(feedback('actor',4.65).red,1);assert.ok(feedback('actor',4.9).red>0&&feedback('actor',4.9).yellow>0);
 assert.equal(feedback('actor',5.1).red,0);assert.equal(feedback('actor',5.1).yellow,1);
});
test('An unannounced future manoeuvre cannot trigger an early prediction from hidden intent',()=>{
 const feedback=createTrafficFeedback(t=>({ego,traffic:[{id:'actor',x:t>=3?0:5,z:-5,yaw:0,speed:10,intentKnown:t>=2}]}),{duration:5});
 assert.equal(feedback('actor',1).level,0);assert.equal(feedback('actor',2).level,2);
});
test('Seeking in any order preserves the same warning, release hold and colour mixture',()=>{
 const feedback=createTrafficFeedback(t=>row(t,t>=1&&t<3),{duration:5});
 const expected=[0,1,2,3.6,4.5].map(t=>feedback('actor',t));
 for(const t of [4,2,0,3.6,1,4.5])feedback('actor',t);
 assert.deepEqual([0,1,2,3.6,4.5].map(t=>feedback('actor',t)),expected);
 assert.deepEqual(TRAFFIC_FEEDBACK,{horizon:2.5,clearHold:.5,fade:.35,step:.05});
});
test('Lane change marks the actual intruder while an open gap and ordinary flank cars stay neutral',()=>{
 const values=[.1,0],run=planRoadLaneChange(()=>values.shift()??.5,{egoX:1.85,laneWidth:3.7});
 const {conflictAt,clearAt}=run(0).laneChange;
 for(let t=conflictAt+.1;t<clearAt;t+=.1){const cars=run(t).traffic;assert.ok(cars.find(c=>c.id==='lane-change-intruder').cutInTint>0);assert.ok(cars.filter(c=>c.id!=='lane-change-intruder').every(c=>!c.cutInTint));}
 const open=planRoadLaneChange(()=>.9,{egoX:1.85,laneWidth:3.7});for(let t=0;t<=10;t+=.1)assert.ok(open(t).traffic.every(c=>!c.cutInTint));
});
test('Cut-in warning matches planned braking and neutral traffic without mandatory yellow/red stages',()=>{
 for(const layout of ['02','06']){const run=planAdjacentCutIn(()=>.8,{layout,egoX:layout==='02'?1.85:3.7});
  assert.ok(run(3.6).traffic[0].cutInTint>0);assert.ok(run(3.6).speed<run(0).speed);
  assert.ok(run(3.6).traffic.slice(1).every(c=>!c.cutInTint));
  const cleared = run(15).traffic[0];
  assert.equal(Boolean(cleared.cutInTint),cleared.constraining);
 }
});
test('The shared painter supports nested multi-material vehicles and a continuous red/yellow downgrade',()=>{
 const car=new THREE.Group(),paint=new THREE.MeshStandardMaterial({color:'white'});paint.userData.trafficRole='paint';const mesh=new THREE.Mesh(new THREE.BoxGeometry(),[paint]);car.add(new THREE.Group().add(mesh));
 const apply=createFeedbackPainter(THREE.Color);apply(car,{yellow:1,red:0},0);const yellow=paint.color.clone();paint.color.set('white');apply(car,{yellow:0,red:1},0);const red=paint.color.clone();
 paint.color.set('white');apply(car,{yellow:.5,red:.5},0);assert.ok(Math.abs(paint.color.r-yellow.r)>.001);assert.notDeepEqual(paint.color.toArray(),red.toArray());
});

test('red returns to neutral when both the conflict and the driving constraint clear',()=>{
 const feedback=createTrafficFeedback(t=>({ego,traffic:[{id:'actor',x:t<2?0:8,z:-4,yaw:0,speed:10}]}),{duration:3});
 assert.ok(feedback('actor',1.9).red>0);
 assert.deepEqual(feedback('actor',2),{level:0,yellow:0,red:0});
});
