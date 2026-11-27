import test from 'node:test';
import assert from 'node:assert/strict';
import {junctionTrafficPlan,stoppedApproachZ,advanceJunctionTraffic,carryJunctionTraffic} from '../junction-traffic.js';
const world={junctionDimensions:{markingEnd:-22.55}};
test('Cross and T traffic never drive longitudinally through their stop lines',()=>{
 for(const id of ['05','08'])for(const dt of [1/60,.1])for(const route of junctionTrafficPlan(id)){
  const slot={route,desiredSpeed:route.speed,speed:route.speed,car:{position:{x:route.x,z:route.z},userData:{}}};
  for(let time=0;time<90;time+=dt){advanceJunctionTraffic(slot,dt,world);if(route.axis!=='x'){
   const front=slot.car.position.z+route.direction*2.6,edge=route.direction<0?-22.46:-57.54;
   assert.ok((front-edge)*route.direction<=-.49);
  }}
  if(route.axis!=='x'){assert.equal(slot.speed,0);assert.equal(slot.car.position.z,stoppedApproachZ(route.direction));}
 }
});
test('T junction has no vehicle approaching from the missing road; no car starts ahead of ego in its turn lane',()=>{
 assert.equal(junctionTrafficPlan('08').some(route=>route.axis!=='x'&&route.direction>0),false);
 for(const id of ['05','08'])assert.equal(junctionTrafficPlan(id).some(route=>route.axis!=='x'&&route.x===1.85),false);
 assert.equal(junctionTrafficPlan('02'),null);
});


test('A left-turn switch preserves live traffic poses and lets crossing traffic clear or yield',()=>{
 const approach={x:5.55,z:9,yaw:0,direction:-1,speed:9};
 assert.deepEqual(carryJunctionTraffic(approach,0,8.9),approach);
 assert.equal(carryJunctionTraffic(approach,8.9,8.9).z,stoppedApproachZ(-1));
 for(const direction of [-1,1]){
  const cross={axis:'x',x:-direction*43,z:-34.45,yaw:-direction*Math.PI/2,direction,speed:11};
  assert.deepEqual(carryJunctionTraffic(cross,0,8.9),cross);
  const waiting=carryJunctionTraffic(cross,8.9,8.9);
  assert.equal(waiting.x,-direction*17);
  assert.equal(waiting.speed,0);
  assert.ok((carryJunctionTraffic(cross,10,8.9).x-waiting.x)*direction>0);
  assert.equal(carryJunctionTraffic({...cross,x:0},1,8.9).x,direction*11);
 }
});
