import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Mesh,MeshBasicMaterial,PlaneGeometry,BoxGeometry} from 'three';
import {installRampPassage,advanceRampPassage,paintRampMerge} from '../ramp-passage.js';
import {rampSection,mergeRampSection,mergeRampLaneX} from '../ramp-lanes.js';
import {RAMP_SPEED} from '../road-mark-motion.js';
import * as THREE from 'three';
import {isolatedRuntimePlugin} from '../runtime-patches.mjs';
import {installRampCurbs,rampCurbSteps,rampNose,rampInset,RAMP_PAINT_INSET} from '../road-boundaries.js';

function fixture(id){
 const root=new Group(),roadMaterial=new MeshBasicMaterial(),whitePaint=new MeshBasicMaterial();
 const world={root,mat:{whitePaint},drivingDistance:0,
  box(w,h,d,x,y,z){const mesh=new Mesh(new BoxGeometry(w,h,d),roadMaterial);mesh.position.set(x,y,z);root.add(mesh);return mesh},
  road(offset,width,near,far,height){const mesh=new Mesh(new PlaneGeometry(width,near-far),roadMaterial);mesh.position.set(offset,height+.015,(near+far)/2);root.add(mesh)},
  line(offset,near,far){const mesh=new Mesh(new PlaneGeometry(.93,near-far+.8),whitePaint);mesh.position.set(offset,.028,(near+far)/2);mesh.rotation.x=-Math.PI/2;root.add(mesh)}
 };
 const branch=new Mesh(new PlaneGeometry(20,330),roadMaterial);branch.geometry.type='BufferGeometry';root.add(branch);
 world.line(-3.45,70,-260);const leftEdge=root.children.at(-1);
 world.line(1.85,70,-260);const dash=root.children.at(-1);dash.userData.laneDash=true;
 world.line(8,0,-30);world.line(12,-30,-60);
 installRampPassage(world,id,7.4,0,34);
 return {root,branch,leftEdge,dash,payload:root.getObjectByName('ramp-passage'),edges:root.getObjectByName('ramp-mainline-edge')};
}

test('A passed ramp leaves a continuous main road and does not translate ordinary lane dashes',()=>{
 for(const id of ['06','07']){
  const {root,branch,leftEdge,dash,payload,edges}=fixture(id);
  assert.equal(branch.parent,payload);assert.equal(leftEdge.parent,root);assert.equal(dash.parent,root);
  assert.ok(payload.getObjectByName('ramp-passage-paint'));
  advanceRampPassage(root,10*RAMP_SPEED);
  assert.equal(payload.visible,false);assert.equal(dash.position.z,-95);
  const visibleEdges=edges.children.filter(mesh=>mesh.visible);
  assert.equal(visibleEdges.length,1);assert.equal(visibleEdges[0].position.z,-415);assert.equal(visibleEdges[0].scale.y,1);
 }
});

test('Ramp passages reuse their meshes and return to the same placement after 25 seconds',()=>{
 for(const id of ['06','07']){
  const {root,payload,edges}=fixture(id),meshes=[];
  root.traverse(object=>meshes.push(object.uuid));
  for(let frame=0;frame<=7500;frame++)advanceRampPassage(root,frame*RAMP_SPEED/30);
  assert.ok(Math.abs(payload.position.z)<1e-9);assert.equal(payload.visible,true);
  const after=[];root.traverse(object=>after.push(object.uuid));assert.deepEqual(after,meshes);
  advanceRampPassage(root,20*RAMP_SPEED);assert.ok(payload.position.z<0);
  assert.equal(edges.children.filter(mesh=>mesh.visible).length,2);
  advanceRampPassage(root,0);assert.equal(payload.position.z,0);
 }
});

test('Actual Exit/Merge asphalt keeps upward normals along densely sampled straight boundaries',async()=>{
 let load;
 isolatedRuntimePlugin().setup({onLoad(_options,handler){load=handler}});
 const {contents}=await load({path:new URL('../../engine/world.js',import.meta.url).pathname});
 const body=contents.slice(contents.indexOf('*rampSteps(id,w){')+'*rampSteps(id,w){'.length,contents.indexOf('\n parking(id){'));
 const makeRamp=new Function('THREE','rampNose','rampInset','RAMP_PAINT_INSET','rampCurbSteps','installRampPassage','rampSection','mergeRampSection','paintRampMerge','globalThis',`return function*(id,w){${body.slice(0,body.lastIndexOf('}'))}}`);
 for(const [id,width,dual] of [['06',7.4],['06',11.1],['07',7.4],['07',11.1],['07',11.1,true]]){
  const ramp=makeRamp(THREE,rampNose,rampInset,RAMP_PAINT_INSET,rampCurbSteps,installRampPassage,rampSection,mergeRampSection,paintRampMerge,
   {__draftSearch:dual?'?scene-preview=1&adaptive-roadworks-traffic=1':''});
  const root=new Group(),road=new MeshBasicMaterial(),whitePaint=new MeshBasicMaterial(),curb=new MeshBasicMaterial();
  const ribbons=[];
  let asphalt,badBefore=0;
  const world={root,mat:{road,whitePaint,curb},drivingDistance:3252.6,
   flatShape(shape,y){
    const geometry=new THREE.ShapeGeometry(shape,24);geometry.rotateX(Math.PI/2);
    const indices=Array.from(geometry.index.array);for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]];
    geometry.setIndex(indices);geometry.computeVertexNormals();
    const normal=geometry.getAttribute('normal');for(let i=0;i<normal.count;i++)if(normal.getY(i)<.99)badBefore++;
    asphalt=new Mesh(geometry,road);asphalt.position.y=y;root.add(asphalt);
   },
   line(offset,near,far){const mesh=new Mesh(new PlaneGeometry(.93,near-far+.8),whitePaint);mesh.position.set(offset,.028,(near+far)/2);mesh.rotation.x=-Math.PI/2;root.add(mesh)},
   dashed(){},pathRibbon(points,weight){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('paintSize',new THREE.Float32BufferAttribute(new Float32Array(points.length*8),4));
    ribbons.push({points,weight});return {geometry};
   },prepareStructurePaint(){},
   road(offset,width,near,far,height){const mesh=new Mesh(new PlaneGeometry(width,near-far),road);mesh.position.set(offset,height+.015,(near+far)/2);root.add(mesh)},box(w,h,d,x,y,z){const mesh=new Mesh(new BoxGeometry(w,h,d),curb);mesh.position.set(x,y,z);root.add(mesh);return mesh}
  };
  const stages=ramp.call(world,id,width);let stageCount=0;for(const stage of stages)stageCount++;assert.ok(stageCount>=7,'Ramp preparation yields between independent geometry stages');
  if(id==='07'){
   const edge=width/2-RAMP_PAINT_INSET;
   const guideWidth=dual?.24:.13;
   const guide=ribbons.find(({points,weight})=>weight===guideWidth&&points.every(([x])=>x===edge));
   const paint=root.getObjectByName('ramp-passage');
   const chevron=paint.getObjectByName('ramp-passage-paint')??paint.children.find(mesh=>mesh.geometry.hasAttribute('paintSize'));
   const dashes=ribbons.filter(({points,weight})=>weight===(dual?.13:.15)&&points.every(([x])=>x===edge));
   assert.ok(guide&&chevron&&dashes.length>1,'the solid guides outline the chevrons before the dashed merge');
   const positions=chevron.geometry.getAttribute('position');
   const nose=rampNose(width/2,dual?rampSection:mergeRampSection,u=>u-60).nose;
   const tip=Math.min(...Array.from({length:193},(_,i)=>nose.getPoint(i/192).z));
   for(let i=0;i<positions.count;i++)assert.ok(positions.getZ(i)<tip,'chevrons stay clear of the physical nose');
   assert.ok(dashes.every(({points})=>points[0][1]<guide.points[0][1]));
   assert.equal(world.rampDimensions.branchLanes,dual?2:1);
   if(dual){
    const rampGuide=ribbons.find(({points,weight})=>weight===guideWidth&&points.length>2);
    assert.deepEqual(rampGuide.points[0],guide.points[0],'the two solid lines meet at the same painted nose');
    assert.ok(dashes.at(-1).points[1][1] < -57,'short dashes continue through the acceleration taper');
    assert.equal(positions.count,6,'one complete chevron fits before the raised curb');
    const center=index=>[(positions.getX(index)+positions.getX(index+1))/2,(positions.getZ(index)+positions.getZ(index+1))/2];
    const [left,point,right]=[0,2,4].map(center);
    assert.ok(Math.abs(left[0]-edge)<1e-5);
    assert.ok(Math.abs(right[0]-rampSection(right[1]+60).l-RAMP_PAINT_INSET)<1e-5);
    assert.ok(point[1]>left[1]&&point[1]>right[1],'the chevron faces approaching traffic and touches both guides');
    const divider=ribbons.filter(({points})=>points.length===9&&points.every(([x,z])=>Math.abs(x-rampSection(z+60).x)<1e-6));
    assert.ok(divider.length>10,'the approach divider follows the center of the curved ramp');
    assert.ok(divider.every(({points})=>points.every(([x])=>x>edge+.5)),'the divider stops short of the mainline marking');
    advanceRampPassage(root,0);
    root.updateMatrixWorld(true);
    const ray=new THREE.Raycaster(new THREE.Vector3(),new THREE.Vector3(0,-1,0));
    for(const lane of ['inner','outer'])for(let u=-10;u<=90;u+=.5)for(const side of [-1,1]){
     const x=mergeRampLaneX(u,lane)+side;
     ray.ray.origin.set(x,4,u-60);
     assert.ok(ray.intersectObject(asphalt).length,`${lane} lane footprint stays on the pavement at station ${u}`);
    }
   }
  }
  assert.ok(badBefore>100,'fixture reproduces collinear triangulation normal corruption');
  const normal=asphalt.geometry.getAttribute('normal');
  for(let i=0;i<normal.count;i++)assert.deepEqual([normal.getX(i),normal.getY(i),normal.getZ(i)],[0,1,0]);
  const positions=asphalt.geometry.getAttribute('position').array.slice(),normals=normal.array.slice();
  for(const distance of [0,180,300,420,840,3252.6])advanceRampPassage(root,distance);
  assert.deepEqual(asphalt.geometry.getAttribute('position').array,positions,'translation preserves approved outline');
  assert.deepEqual(normal.array,normals,'recycling preserves planar lighting');
 }
});
