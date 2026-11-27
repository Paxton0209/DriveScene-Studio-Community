import test from 'node:test';
import assert from 'node:assert/strict';
import {installContextRecovery} from '../context-recovery.js';
function fixture(){
 const host=new EventTarget(),doc=new EventTarget(),storage=new Map(),jobs=[];
 doc.hidden=false;Object.assign(host,{document:doc,location:{origin:'https://example.test',pathname:'/studio/'},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimeout:f=>(jobs.push(f),jobs.length),clearTimeout(){}});
 const frame={contentWindow:{}};let rebuilt=0,failed=0;
 const recovery=installContextRecovery({host,frame:()=>frame,rebuild:()=>rebuilt++,onFailure:()=>failed++});
 function loss(overrides={}){const e=new Event('message');Object.assign(e,{source:frame.contentWindow,origin:host.location.origin,data:{type:'ui-draft-context-lost'},...overrides});host.dispatchEvent(e);}
 return {host,doc,jobs,recovery,loss,get rebuilt(){return rebuilt},get failed(){return failed}};
}
test('Only its own renderer can request automatic recovery; duplicate notifications share one rebuild',()=>{
 const f=fixture();f.loss({source:{}});f.loss({origin:'https://other.test'});assert.equal(f.jobs.length,0);
 f.loss();f.loss();assert.equal(f.recovery.pending,true);assert.equal(f.jobs.length,1);f.jobs.shift()();assert.equal(f.rebuilt,1);assert.equal(f.recovery.pending,false);
});
test('Background context loss waits for foreground before allocating a replacement renderer',()=>{
 const f=fixture();f.doc.hidden=true;f.loss();assert.equal(f.jobs.length,0);assert.equal(f.recovery.pending,true);
 f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.jobs.length,1);f.jobs.shift()();assert.equal(f.rebuilt,1);
});
test('A tab hidden again during the recovery delay waits for its next foreground frame',()=>{
 const f=fixture();f.loss();
 f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));f.jobs.shift()();
 assert.equal(f.rebuilt,0);assert.equal(f.recovery.pending,true);
 f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));f.jobs.shift()();
 assert.equal(f.rebuilt,1);assert.equal(f.recovery.pending,false);
});
test('Persistent context loss stops after two automatic rebuilds rather than looping',()=>{
 const f=fixture();for(let i=0;i<2;i++){f.loss();f.jobs.shift()();}f.loss();assert.equal(f.rebuilt,2);assert.equal(f.failed,1);assert.equal(f.recovery.pending,false);
});
