import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {patchApp} from '../runtime-patches.mjs';

const source=patchApp(await readFile(new URL('../../engine/app.js',import.meta.url),'utf8'));
const method=source.match(/async prepareDraftScene\(key,values,commitMotion\)\{[\s\S]*?\n \},/)[0];
function fixture(){
 const events=[],preferences=new Map([['parking',{id:'10'}]]);
 let resolve,reject;
 const pending=new Promise((a,b)=>{resolve=a;reject=b;});
 const world={root:{},initializingScene:false,continuousDrive:{rebind(){events.push('rebind');}},async prepareInitialScene(state){
  assert.equal(this.initializingScene,true);assert.equal(state.id,'16');assert.equal(state.trees,false);
  events.push('build');await pending;this.root={};events.push('built');
 }};
 const api=new Function('world','preferences','events','let selected;const environmentIds=["trees"],cancelDriveArming=()=>{},continuousDrive={reset(){}},versionFeatures={set(){}},trafficSystem={setEnabled(){}},state=(scene,preference)=>preference,render=()=>{if(world.initializingScene)throw Error("rendered partial scene");events.push("render");};return ({'+method+'});')(world,preferences,events);
 return {world,api,events,resolve,reject};
}

test('Scene preparation holds its initialization guard through async construction and renders once before rebinding',async()=>{
 const f=fixture(),pending=f.api.prepareDraftScene('parking',{camera:'raised',trees:false},()=>f.events.push('commit'));
 assert.equal(f.world.initializingScene,true);assert.deepEqual(f.events,['build']);
 f.resolve();await pending;
 assert.equal(f.world.initializingScene,false);assert.deepEqual(f.events,['build','built','commit','render','rebind']);
});

test('A failed scene build restores the guard without rendering or rebinding an incomplete root',async()=>{
 const f=fixture(),pending=f.api.prepareDraftScene('parking',{camera:'raised',trees:false},()=>f.events.push('commit'));
 f.reject(Error('construction failed'));await assert.rejects(pending,/construction failed/);
 assert.equal(f.world.initializingScene,false);assert.deepEqual(f.events,['build']);
});

test('Scene construction failure restores the rendered root and allows the same request again',async()=>{
 const road={id:'02'},root={},partial={},parking={},preferences=new Map([['road',road],['parking',{id:'10'}]]);
 const world={root,state:road,initializingScene:false,sceneCache:new Map(),disposeSceneRoot(value){assert.equal(value,partial)},async prepareInitialScene(state){
  if(state===road){this.root=root;return}
  if(this.root===root&&!this.failed){this.failed=true;this.root=partial;throw Error('interrupted')}
  this.root=parking;
 }};
 const api=new Function('world','preferences',`let selected='road';const environmentIds=[],cancelDriveArming=()=>{},continuousDrive={reset(){}},versionFeatures={set(){}},trafficSystem={setEnabled(){}},state=(scene,preference)=>preference,render=()=>{};return ({${method} get scene(){return selected}});`)(world,preferences);
 await assert.rejects(api.prepareDraftScene('parking',{camera:'raised'}),/interrupted/);
 assert.equal(api.scene,'road');assert.equal(world.root,root);assert.equal(preferences.get('parking').id,'10');
 await api.prepareDraftScene('parking',{camera:'raised'});
 assert.equal(api.scene,'parking');assert.equal(world.root,parking);assert.equal(preferences.get('parking').id,'16');
});

test('Layout choices use asynchronous construction and never draw a partial root',async()=>{
 const method=source.match(/async prepareDraftLayout\(value\)\{[\s\S]*?\n \},/)[0];
 for(const fail of [false,true]){
  const events=[],preferences=new Map([['ramp',{id:'06',cameraView:'high'}]]);let release,reject;
  const pending=new Promise((a,b)=>{release=a;reject=b});
  const world={root:{},initializingScene:false,continuousDrive:{rebind(){events.push('rebind')}},async prepareInitialScene(state){
   assert.equal(this.initializingScene,true);assert.deepEqual(state,{id:'07',cameraView:'high'});events.push('prepare');await pending;this.root={};
  }};
  const api=new Function('world','preferences','events',`const selected='ramp',state=()=>preferences.get(selected),render=()=>{assertReady();events.push('render')};function assertReady(){if(world.initializingScene)throw Error('partial layout')}return ({${method}})`)(world,preferences,events);
  const run=api.prepareDraftLayout('07');assert.deepEqual(events,['prepare']);
  if(fail){reject(Error('layout failed'));await assert.rejects(run,/layout failed/);assert.deepEqual(events,['prepare']);}
  else{release();await run;assert.deepEqual(events,['prepare','render','rebind']);}
  assert.equal(world.initializingScene,false);
 }
});

test('Scene transition cancels prior animation frames and keeps the scheduler closed through asynchronous preparation',async()=>{
 const bridge=await readFile(new URL('../engine-bridge.js',import.meta.url),'utf8');
 const start=bridge.indexOf('async scene(key,seed,values,entryBottom,interaction){');
 const end=bridge.indexOf(',\n finishScene(',start);
 assert.ok(start>=0&&end>start);
 const method=bridge.slice(start,end);
 const scheduler=bridge.slice(bridge.indexOf(' function schedule(){'),bridge.indexOf('\n let lastPublish='));
 let release;const pending=new Promise(resolve=>release=resolve),events=[];
 const api={prepareDraftScene:()=>pending},world={draftSceneryRandom:{reset(){}},draftPrepareStartup:async()=>{},draftTrafficEnabled:false,suspended:false};
 const make=new Function('api','world','events','requestAnimationFrame','cancelAnimationFrame',`
 let scenePreparing=false,frame=7,playing=true,audioHeld=false,loopTime=0,junctionPoses=null,exporting=false,themeHeld=false;
 const drivingEvent=null,current=()=> 'road',capture=()=>({}),stopIndicatorSound=()=>{};
 const document={hidden:false},visualMotion=()=>true,tick=()=>{},resetIndicatorSound=()=>{},appearance={finish(){}},parking={reset(){}},settle=()=>{},drive={reset(){}},waitForRender=async()=>{},seekJunction=()=>{},restartJunctionPath=()=>{},prepareSceneThemes=()=>{},sync=()=>{};
 ${scheduler}
 return {${method},schedule,get preparing(){return scenePreparing}};
 `);
 const controller=make(api,world,events,()=>{events.push('frame');return 9},id=>events.push(['cancel',id]));
 const transition=controller.scene('parking',114,{traffic:false},.776);await Promise.resolve();assert.equal(controller.preparing,true);assert.equal(world.draftParkingEntryBottom,.776);assert.deepEqual(events,[['cancel',7]]);controller.schedule();assert.equal(events.length,1,'a traffic animation cannot render the incoming scene while shaders are pending');
 release();await transition;assert.equal(controller.preparing,false);assert.equal(world.draftParkingEntryBottom,undefined);assert.deepEqual(events,[['cancel',7],'frame']);
});
