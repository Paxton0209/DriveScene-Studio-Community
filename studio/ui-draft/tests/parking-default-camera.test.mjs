import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {isolatedRuntimePlugin} from '../runtime-patches.mjs';
import {parkingLowShift,parkingViewPose,applyParkingView} from '../parking-camera.js';
import {anchorVehicle,vehicleFrame} from '../../engine/framing.js';

let load;isolatedRuntimePlugin().setup({onLoad(_options,handler){load=handler}});
const {contents}=await load({path:new URL('../../engine/world.js',import.meta.url).pathname});
const begin=contents.indexOf(' configureCamera(id,options){'),end=contents.indexOf('\n update({id,mode,trees,vehicle',begin);
assert.ok(begin>=0&&end>begin);
const configureCamera=new Function('THREE','parkingLowShift','parkingViewPose','applyParkingView','vehicleFrame','anchorVehicle','parkingIds','ELEVATED_DECK_HEIGHT',`return function ${contents.slice(begin,end).trim()}`)(THREE,parkingLowShift,parkingViewPose,applyParkingView,vehicleFrame,anchorVehicle,['10','14','15','16','17','18','19'],8.5);
function world(){
 const car=new THREE.Group();car.position.set(0,.02,0);car.add(new THREE.Mesh(new THREE.BoxGeometry(2,1.7,4.85)));
 const camera=new THREE.PerspectiveCamera(40,16/9,.1,1000);
 return {car,camera,root:new THREE.Group(),cameraAim:new THREE.Vector3(),roadCameraCache:new Map(),captureCamera(){return {framing:this.framing}},configureCamera};
}
for(const scene of ['10','17'])test(`Built ${scene} initial/default camera shares Driving Low geometry and the manual endpoint`,()=>{
 const road=world();road.configureCamera('02',{cameraView:'low'});
 const parking=world();parking.configureCamera(scene,{cameraView:'low'});
 assert.ok(parking.camera.position.clone().sub(parking.car.position).distanceTo(road.camera.position.clone().sub(road.car.position))<1e-12);
 assert.ok(parking.cameraAim.clone().sub(parking.car.position).distanceTo(road.cameraAim.clone().sub(road.car.position))<1e-12);
 assert.ok(parking.camera.quaternion.angleTo(road.camera.quaternion)<1e-7);
 const viewPose=kind=>parkingViewPose(parking.camera,parking.car,kind,parking.car.rotation.y,parking.draftParkingLowShift);
 const expected=viewPose('default'),initialMatrix=parking.camera.projectionMatrix.clone();
 applyParkingView(parking.camera,parking.car,expected);
 assert.deepEqual(parking.camera.projectionMatrix.elements,initialMatrix.elements,'initialization and the parking controller agree on framing');
 for(const view of ['raised','bev','default'])applyParkingView(parking.camera,parking.car,viewPose(view));
 assert.deepEqual(parking.camera.projectionMatrix.elements,initialMatrix.elements,'view return uses the same endpoint');
 parking.configureCamera(scene,{cameraView:'low'});
 assert.deepEqual(parking.camera.projectionMatrix.elements,initialMatrix.elements,'reconfiguration cannot restore the old high endpoint');
});

for(const [id,length] of [['model-3',4.72],['x6',null],['ix',4.95],['xc90',4.95]])test(`${id} keeps its vertical framing from Road to both Parking Low scenes`,async()=>{
 const bytes=gunzipSync(await readFile(new URL(`../vehicles/${id}/model.glb.gz`,import.meta.url)));
 const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
 loader.register(parser=>({name:'geometry-only',beforeRoot(){
  const get=parser.getDependency;
  parser.getDependency=function(type,index){return type==='texture'?Promise.resolve(null):get.call(this,type,index);};
 }}));
 const {scene}=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=id==='x6'?scene.children[0]:scene;
 if(length){
  const size=new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  model.rotation.y+=id==='model-3'?Math.PI/2:(size.x>size.z?Math.PI/2:Math.PI)+Math.PI;
  model.scale.multiplyScalar(length/Math.max(size.x,size.z));
  const box=new THREE.Box3().setFromObject(model),center=box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(center.x,box.min.y,center.z));
 }
 for(const keepPreviousCamera of [false,true]){
  const layout=world();
  if(keepPreviousCamera)layout.configureCamera('02',{cameraView:'low'});
  layout.car.clear().add(model);
  if(!keepPreviousCamera)layout.configureCamera('02',{cameraView:'low'});
  const road=vehicleFrame(layout.car,layout.camera);
  layout.draftParkingEntryBottom=keepPreviousCamera?road.bottom:undefined;
  for(const scene of ['10','17']){
   layout.root=new THREE.Group();
   layout.configureCamera(scene,{cameraView:'low'});
   const parked=vehicleFrame(layout.car,layout.camera);
   for(const edge of ['top','bottom'])assert.ok(Math.abs(road[edge]-parked[edge])<1e-7,`${scene} ${edge}: ${road[edge]} vs ${parked[edge]}`);
  }
 }
});
