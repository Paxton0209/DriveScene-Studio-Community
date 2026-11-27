import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForEngine,waitForStartupMotion} from '../engine-ready.js';

function frameClock(host){
 let time=0;
 host.performance={now:()=>time};
 return (callbacks,now=time,frameTime=now)=>{time=now;callbacks.shift()(frameTime);};
}

function fixture(){
 const host=new EventTarget();host.location={origin:'https://example.test'};
 const frame={contentWindow:{}};
 const signal=(overrides={})=>{const event=new Event('message');Object.assign(event,{source:frame.contentWindow,origin:host.location.origin,data:{type:'ui-draft-ready'},...overrides});host.dispatchEvent(event);};
 return {host,frame,signal};
}
test('Ready signal completes without waiting for the polling interval',async()=>{
 const f=fixture();let ready=false,complete=false;
 const pending=waitForEngine({...f,ready:()=>ready}).then(()=>{complete=true});
 ready=true;f.signal();await Promise.resolve();assert.equal(complete,true);await pending;
});
test('Unrelated frames and origins cannot publish readiness',async()=>{
 const f=fixture();let ready=false,complete=false;
 const pending=waitForEngine({...f,ready:()=>ready}).then(()=>{complete=true});ready=true;
 f.signal({source:{}});f.signal({origin:'https://other.test'});await Promise.resolve();assert.equal(complete,false);
 f.signal();await pending;
});
test('Already ready engines resolve, unavailable engines time out',async()=>{
 const f=fixture();await waitForEngine({...f,ready:()=>true});
 await assert.rejects(waitForEngine({...f,ready:()=>false,timeout:5}),/timed out/);
});
test('An alternative startup asset error rejects immediately instead of reporting ready',async()=>{
 const f=fixture(),pending=waitForEngine({...f,ready:()=>false});
 f.signal({data:{type:'ui-draft-error',message:'Alternative vehicle failed'}});
 await assert.rejects(pending,/Alternative vehicle failed/);
});

test('Driving handoff waits for a changed rendered frame, without restarting or pausing the scene',async()=>{
 const {waitForStartupMotion}=await import('../engine-ready.js');
 let distance=0,renderedFrames=5,playing=true,done=false;const pending=[];
 const host={document:{hidden:false},requestAnimationFrame:fn=>pending.push(fn)},bridge={get:()=>({scene:'elevated',playing,distance}),themeStatus:()=>({renderedFrames})};
 const frame=frameClock(host);
 const ready=waitForStartupMotion({host,bridge}).then(()=>done=true);
 frame(pending);await Promise.resolve();assert.equal(done,false);
 distance=.2;frame(pending);await Promise.resolve();assert.equal(done,false);
 distance=.3;renderedFrames++;frame(pending);await Promise.resolve();assert.equal(done,false);
 frame(pending);await Promise.resolve();assert.equal(done,false);
 distance=.4;renderedFrames++;frame(pending);await ready;assert.equal(done,true);
 for(const state of [{scene:'road',playing:false},{scene:'parking',playing:false},{scene:'junction',playing:true}])await waitForStartupMotion({host:{document:{hidden:false},requestAnimationFrame:fn=>fn()},bridge:{get:()=>state,themeStatus:()=>({renderedFrames:0})}});
});

 test('Background preparation cannot complete a visible moving-scene handoff',async()=>{
 let distance=0,renderedFrames=0,done=false;const pending=[],doc={hidden:true};
 const bridge={get:()=>({scene:'road',playing:!doc.hidden,requestedPlaying:true,distance}),themeStatus:()=>({renderedFrames})};
 const {waitForStartupMotion}=await import('../engine-ready.js');
 const host={document:doc,requestAnimationFrame:fn=>pending.push(fn)};
 const frame=frameClock(host);
 const ready=waitForStartupMotion({host,bridge}).then(()=>done=true);
 distance=10;renderedFrames=10;frame(pending);await Promise.resolve();assert.equal(done,false);
 doc.hidden=false;frame(pending);await Promise.resolve();assert.equal(done,false);
 for(let i=0;i<2;i++){distance++;renderedFrames++;frame(pending);}await ready;assert.equal(done,true);
});

test('A renderer without advancing frames rejects instead of locking the workbench indefinitely',async()=>{
 const {waitForStartupMotion}=await import('../engine-ready.js');
 const pending=[],state={scene:'road',playing:true,distance:0};
 const host={document:{hidden:false},requestAnimationFrame:fn=>pending.push(fn)};
 const frame=frameClock(host);
 const waiting=waitForStartupMotion({host,bridge:{get:()=>state,themeStatus:()=>({renderedFrames:1})},timeout:100});
 frame(pending,0);frame(pending,101);
 await assert.rejects(waiting,/stopped before it was ready/);
 assert.equal(pending.length,0);
});

test('Slow initial GPU frames renew the handoff deadline while the scene is advancing',async()=>{
 const {waitForStartupMotion}=await import('../engine-ready.js');
 const callbacks=[];let distance=0,renderedFrames=0;
 const host={document:{hidden:false},requestAnimationFrame:fn=>callbacks.push(fn)};
 const bridge={get:()=>({scene:'road',playing:true,distance}),themeStatus:()=>({renderedFrames})};
 const frame=frameClock(host);
 const waiting=waitForStartupMotion({host,bridge,timeout:8000});
 frame(callbacks,0);
 distance=1;renderedFrames++;frame(callbacks,9000);
 if(callbacks.length){distance=2;renderedFrames++;frame(callbacks,18000);}
 await waiting;
});


test('Repeated static redraws cannot indefinitely extend the moving-scene handoff',async()=>{
 const {waitForStartupMotion}=await import('../engine-ready.js');
 const callbacks=[];let renderedFrames=0;
 const host={document:{hidden:false},requestAnimationFrame:fn=>callbacks.push(fn)};
 const bridge={get:()=>({scene:'road',playing:true,distance:0}),themeStatus:()=>({renderedFrames})};
 const frame=frameClock(host);
 const waiting=waitForStartupMotion({host,bridge,timeout:100});
 frame(callbacks,0);renderedFrames++;frame(callbacks,101);
 await assert.rejects(waiting,/stopped before it was ready/);
});


test('A frame timestamp captured before a slow visibility redraw does not expire the handoff',async()=>{
 const {waitForStartupMotion}=await import('../engine-ready.js');
 const pending=[],doc={hidden:true};let distance=0,renderedFrames=0,done=false;
 const host={document:doc,requestAnimationFrame:fn=>pending.push(fn)};
 const frame=frameClock(host);
 const bridge={get:()=>({scene:'road',requestedPlaying:true,distance}),themeStatus:()=>({renderedFrames})};
 const ready=waitForStartupMotion({host,bridge}).then(()=>done=true);
 frame(pending,0);
 doc.hidden=false;renderedFrames++;
 frame(pending,9000,1);frame(pending,9001,9000);
 await Promise.resolve();assert.equal(done,false);
 for(let i=0;i<2;i++){distance++;renderedFrames++;frame(pending,9002+i);}
 await ready;assert.equal(done,true);
});

test('The first resumed draw may exceed the watchdog with zero simulation progress',async()=>{
 const callbacks=[],doc=new EventTarget();doc.hidden=true;
 let distance=12,renderedFrames=1;
 const host={document:doc,requestAnimationFrame:fn=>callbacks.push(fn)};
 const bridge={get:()=>({scene:'road',requestedPlaying:true,distance}),themeStatus:()=>({renderedFrames})};
 const frame=frameClock(host),ready=waitForStartupMotion({host,bridge});
 frame(callbacks,0);doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
 frame(callbacks,1);renderedFrames++;frame(callbacks,9151);
 distance+=.2;renderedFrames++;frame(callbacks,9168);
 distance+=.2;renderedFrames++;frame(callbacks,9185);
 await ready;
});

test('A long first foreground frame may complete before the engine submits its next draw',async()=>{
 const pending=[],doc=new EventTarget();doc.hidden=true;
 let distance=0,renderedFrames=1;
 const host={document:doc,requestAnimationFrame:fn=>pending.push(fn)};
 const frame=frameClock(host);
 const bridge={get:()=>({scene:'road',requestedPlaying:true,distance}),themeStatus:()=>({renderedFrames})};
 const result=waitForStartupMotion({host,bridge}).then(()=>true,()=>false);
 frame(pending,0);doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
 frame(pending,1);frame(pending,9101);
 for(let i=0;i<2&&pending.length;i++){distance++;renderedFrames++;frame(pending,9117+i*16);}
 assert.equal(await result,true);
});

test('A resume stall allows only one overdue frame with no renderer progress',async()=>{
 const pending=[],doc=new EventTarget();doc.hidden=true;
 const host={document:doc,requestAnimationFrame:fn=>pending.push(fn)};
 const frame=frameClock(host);
 const bridge={get:()=>({scene:'road',requestedPlaying:true,distance:0}),themeStatus:()=>({renderedFrames:1})};
 const rejected=assert.rejects(waitForStartupMotion({host,bridge}),/stopped before it was ready/);
 frame(pending,0);doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
 frame(pending,1);frame(pending,9101);assert.equal(pending.length,1);
 frame(pending,17102);await rejected;assert.equal(pending.length,0);
});
