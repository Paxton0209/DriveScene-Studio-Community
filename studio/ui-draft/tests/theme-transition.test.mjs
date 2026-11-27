import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {patchApp} from '../runtime-patches.mjs';

test('Theme commits while view transitions have suspended iframe animation callbacks',async()=>{
 const source=patchApp(await readFile(new URL('../../engine/app.js',import.meta.url),'utf8'));
 const body=source.match(/async theme\(value\)\{([^\n]+)\},/)[1];
 let renders=0;
 const commit=new Function('render','requestAnimationFrame',`let mode='light',requestedTheme='light';return async function(value){${body}}`)(animate=>{assert.equal(animate,false);renders++},()=>{throw Error('Frame callbacks are suspended during capture')});
 await commit('dark');await commit('light');assert.equal(renders,2);
});

test('Theme updates restore the button-origin reveal without remounting the live renderer',async()=>{
 const source=await readFile(new URL('../draft.js',import.meta.url),'utf8');
 const theme=source.slice(source.indexOf('async function setTheme('),source.indexOf("$('theme').addEventListener"));
 assert.match(theme,/document\.startViewTransition/);
 assert.match(theme,/document\.startViewTransition\(\(\)=>commit\(target,liveScene\)\)/);
 assert.doesNotMatch(theme,/protectThemeFrame|toDataURL|raster\?\.update/);
 assert.doesNotMatch(theme,/srcdoc|replaceChildren|innerHTML|location\.reload/);
 for(const page of ['index.html','skill.html']){
  const html=await readFile(new URL('../'+page,import.meta.url),'utf8');
  assert.match(html,/soft-radial-live/,page+' ships the live scene reveal');
  assert.match(html,/soft-radial-unified/,page+' ships the unified paused scene reveal');
 }
});

test('Palette changes preserve the current pose and avoid an extra render while playing',async()=>{
 const source=await readFile(new URL('../engine-bridge.js',import.meta.url),'utf8');
 const method=source.match(/\n theme(\(value,[\s\S]+?\n \}),\n/)[1];
 for(const playing of [false,true])for(const animate of [false,true]){
  const world={suspended:false,draftThemeTone:{value:0},pose:{carZ:20,cameraY:8}};
  const snapshots=[];let frames=0,scheduled=0;
  const theme=new Function('world','api','playing','appearance','appearanceSnapshot','renderOnce','publish','schedule',`let themeTarget;return function${method}`)(
   world,{setDraftTheme(value){assert.equal(value,'dark');assert.equal(world.suspended,false)}},playing,
   {finish(){},start(from,to){snapshots.push(from,to)}},w=>({...w.pose}),
   ()=>{frames++},()=>{},()=>{scheduled++}
  );
  theme('dark',{animate});
  assert.equal(frames,!playing&&!animate?1:0);
  assert.equal(scheduled,1);
  if(animate)assert.deepEqual(snapshots,[world.pose,world.pose]);
  assert.equal(world.draftThemeTone.value,1);
 }
});

test('Junction replay reuses the prepared route after an appearance update',async()=>{
 const source=await readFile(new URL('../engine-bridge.js',import.meta.url),'utf8');
 const body=source.match(/ replay\(\)\{([^\n]+)\},/)[1];
 let elapsed=3.5;const preparedRoute={duration:3500};let sampledRoute=null;
 const replay=new Function('route','world','current','isParking','traffic','parking','resetIndicatorSound','settle','seek','restartJunctionPath','publish','schedule',`let junctionPoses=route,loopTime=3.5,audioHeld=false;const renderOnce=()=>{};const seekJunction=()=>seek(junctionPoses,loopTime);return function(){${body}}`)(
  preparedRoute,{state:{id:'08'},suspended:false,draftTrafficEnabled:true},()=> 'junction',()=>false,
  {setEnabled(){}},{},()=>{},()=>{},(route,time)=>{sampledRoute=route;elapsed=time},()=>{},()=>{},()=>{}
 );
 replay();assert.equal(sampledRoute,preparedRoute);assert.equal(elapsed,0);
});
