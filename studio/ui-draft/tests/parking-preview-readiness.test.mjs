import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../pro-prototype/scene-preview.js',import.meta.url),'utf8'))
 .replace(/^import .*;\n/gm,'').replace('export function createScenePreview','function createScenePreview')
 .replace('import.meta.url',JSON.stringify(new URL('../pro-prototype/scene-preview.js',import.meta.url).href));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
function fixture(engineRevision){
 const calls=[];let release,frame;
 const preparation=new Promise(resolve=>release=resolve);
 const engine={resize(){},completeStartup(){},canvas:{width:800,height:450},prepareParkingAssets(){calls.push('prepare');return preparation},switchInteraction(event){calls.push(event)},async scene(){calls.push('scene')}};
 const document={createElement:tag=>tag==='iframe'?{contentWindow:{layoutEngine:{draft:engine}},remove(){}}:{hidden:true,setAttribute(){},getContext:()=>({drawImage(){}})}};
 const clip={clientWidth:800,append(){},prepend(node){frame=node}};
 const create=new Function('document','window','ResizeObserver','createArtboard','waitForEngine','revealScene','matchMedia','isParkingEvent','installContextRecovery',source+';return createScenePreview;')(
  document,{},class{observe(){}},()=>({seed:1,params:{layout:'10'}}),async()=>{},()=>{},()=>({matches:false}),event=>event?.startsWith('parking-'),()=>({pending:false}));
 const preview=create({clip,engineRevision,onReady(_,event){calls.push('ready:'+event)},onError(error){throw error}});
 const show=event=>preview.show('parking',event,{camera:'low',layers:{},t:0,playing:false});
 return {calls,release,show,frameURL:()=>frame?.src};
}
test('A new engine build mounts a new URL for the same parking scene',async()=>{
 const previous=fixture('previous'),current=fixture('current');
 previous.show(null);current.show(null);await flush();
 assert.equal(previous.frameURL().searchParams.get('engine-v'),'previous');
 assert.equal(current.frameURL().searchParams.get('engine-v'),'current');
 assert.equal(previous.frameURL().pathname,current.frameURL().pathname);
 assert.equal(previous.frameURL().searchParams.get('scene'),current.frameURL().searchParams.get('scene'));
});
test('First parking event waits for the lazy module before configuring the existing preview',async()=>{
 const h=fixture();h.show(null);await flush();h.calls.length=0;
 h.show('parking-yield');await flush();assert.deepEqual(h.calls,['prepare']);
 h.release();await flush();assert.deepEqual(h.calls,['prepare','parking-yield','ready:parking-yield']);
});
test('Turning the event off while its module loads discards the stale configuration',async()=>{
 const h=fixture();h.show(null);await flush();h.calls.length=0;
 h.show('parking-taken');await flush();h.show(null);h.release();await flush();
 assert.deepEqual(h.calls,['prepare',null,'ready:null']);
});
