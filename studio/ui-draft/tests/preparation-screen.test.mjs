import test from 'node:test';
import assert from 'node:assert/strict';
import {preservePreparationScreen} from '../preparation-screen.js';
import {installAppearancePreparation} from '../appearance-preparation.js';

function fixture(){
 let target=null,mask=true,locked=false;
 const screen={value:123},offscreen={value:234},color={setMask(next){if(!locked)mask=next},setLocked(next){locked=next}};
 const renderer={state:{buffers:{color}},getContext:()=>({COLOR_WRITEMASK:1,getParameter:()=>[mask,mask,mask,mask]}),getRenderTarget:()=>target,setRenderTarget(next){target=next},
  clear(colour=true){if(colour&&mask)(target||screen).value=0},
  renderBufferDirect(){color.setMask(true);if(mask)(target||screen).value=255}
 };
 return {renderer,screen,offscreen,color,isLocked:()=>locked};
}

test('Preparation preserves screen colour through clears and material draws while offscreen passes still render',()=>{
 const f=fixture(),clear=f.renderer.clear,draw=f.renderer.renderBufferDirect,restore=preservePreparationScreen(f.renderer);
 f.renderer.clear();f.renderer.renderBufferDirect();assert.equal(f.screen.value,123);
 f.renderer.setRenderTarget(f.offscreen);f.renderer.clear();assert.equal(f.offscreen.value,0);f.renderer.renderBufferDirect();assert.equal(f.offscreen.value,255);
 f.renderer.setRenderTarget(null);restore();assert.equal(f.renderer.clear,clear);assert.equal(f.renderer.renderBufferDirect,draw);assert.equal(f.isLocked(),false);
 f.renderer.clear();assert.equal(f.screen.value,0);f.renderer.renderBufferDirect();assert.equal(f.screen.value,255);
});

for(const failure of [null,'warm','handoff'])test(`Parking appearance keeps its last frame across asynchronous warmup and restores live output (failure=${failure})`,async()=>{
 const f=fixture(),render=()=>{f.renderer.clear();f.renderer.renderBufferDirect()},clear=f.renderer.clear,draw=f.renderer.renderBufferDirect;
 const world={root:{},car:{uuid:'ego'},renderer:f.renderer,suspended:false,initializingScene:false,renderPreparedFrame(){render();if(failure==='handoff')throw Error('handoff')}};
 let release;installAppearancePreparation(world,async()=>{render();await new Promise(resolve=>release=resolve);render();if(failure==='warm')throw Error('warm')});
 const pending=world.draftPrepareAppearance({preserveScreen:true});assert.equal(world.suspended,true);assert.equal(f.screen.value,123);release();
 if(failure)await assert.rejects(pending,new RegExp(failure));else await pending;
 assert.equal(f.screen.value,123,'no black or fully expanded fleet frame reaches the screen');assert.equal(world.suspended,false);assert.equal(world.initializingScene,false);
 assert.equal(f.renderer.clear,clear);assert.equal(f.renderer.renderBufferDirect,draw);assert.equal(f.isLocked(),false);
 render();assert.equal(f.screen.value,255,'next live entry frame can draw normally');
});

test('A failed screen warm draw restores the colour mask and unlocks material writes',()=>{
 const f=fixture();f.renderer.renderBufferDirect=()=>{throw Error('GPU draw')};const restore=preservePreparationScreen(f.renderer);
 assert.throws(()=>f.renderer.renderBufferDirect(),/GPU draw/);assert.equal(f.isLocked(),false);f.renderer.clear();assert.equal(f.screen.value,123);
 restore();f.renderer.clear();assert.equal(f.screen.value,0);
});
