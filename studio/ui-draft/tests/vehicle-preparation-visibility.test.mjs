import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {patchVehiclePreparation} from '../runtime-patches.mjs';
const source=await readFile(new URL('../../engine/prepare-vehicle-choice.js',import.meta.url),'utf8');
const create=code=>new Function('THREE',code.replace(/^import .*;\n/gm,'').replace('export async function','async function')+';return prepareVehicleChoice;')(THREE);
function fixture({suspended=true,lost=false,interrupt=false}={}){
 let drawn=0,contextLost=lost;
 const scene=new THREE.Scene(),car=new THREE.Group(),camera=new THREE.PerspectiveCamera();scene.add(car);
 const world={scene,car,camera,suspended,composer:{renderTarget1:{texture:{type:THREE.UnsignedByteType,colorSpace:THREE.SRGBColorSpace}}}};
 world.renderer={shadowMap:{autoUpdate:true,needsUpdate:false},getContext:()=>({isContextLost:()=>contextLost}),getRenderTarget:()=>null,setRenderTarget(){},getViewport:v=>v.set(0,0,800,450),setViewport(){},initTexture(){},async compileAsync(){world.suspended=true;if(interrupt)contextLost=true;},render(){drawn++;}};
 return {world,car,get drawn(){return drawn}};
}
test('The reported background interruption reproduces in the shared preparation baseline',async()=>{
 const f=fixture();await assert.rejects(create(source)(f.world,f.car),/interrupted/);assert.equal(f.drawn,0);
});
test('Hidden or scene-preparing suspension permits offscreen preparation and preserves ownership',async()=>{
 for(const suspended of [true,false]){
  const f=fixture({suspended});const parent=f.car.parent;
  await create(patchVehiclePreparation(source))(f.world,f.car);
  assert.equal(f.drawn,1);assert.equal(f.car.parent,parent);assert.equal(f.world.suspended,true);
 }
});
test('Actual context loss before or during preparation still rejects and restores the vehicle',async()=>{
 for(const options of [{lost:true},{interrupt:true}]){
  const f=fixture(options),parent=f.car.parent;
  await assert.rejects(create(patchVehiclePreparation(source))(f.world,f.car),/interrupted/);
  assert.equal(f.drawn,0);assert.equal(f.car.parent,parent);
 }
});
