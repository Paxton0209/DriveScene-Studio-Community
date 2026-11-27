import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {browserOptions,configureRenderer} from './browser-renderer.mjs';
const base=process.env.DRIVESCENE_TEST_URL??'http://127.0.0.1:8000',out=process.env.DRIVESCENE_TEST_EVIDENCE??'work/free-workbench-fix';
const ready=page=>page.waitForFunction(()=>{const f=document.querySelector('iframe[title]'),b=f?.contentWindow?.layoutEngine?.draft,c=f?.contentDocument?.querySelector('#scene-canvas');return b?.get({audit:false}).startup?.ready&&b.get({audit:false}).ready&&c&&!c.getContext('webgl2').isContextLost()&&(document.body.dataset.ready==='true'||document.querySelector('#frame-cover')?.hidden);},null,{timeout:90000});
test('Actual context loss during startup and after parking automatically rebuilds the renderer',{timeout:process.env.CI==='true'?600000:360000},async t=>{
 const browser=await chromium.launch(browserOptions());t.after(()=>browser.close());await mkdir(out,{recursive:true});const records=[];
 for(const entry of ['index.html','pro-prototype.html'])for(const duringStartup of [true,false]){
  const context=await browser.newContext({viewport:{width:1280,height:900}});await configureRenderer(context);const page=await context.newPage();page.on('console',m=>{if(m.type()==='error')console.log('console',entry,duringStartup,m.text());});page.on('pageerror',e=>console.log('pageerror',e.message));console.log('opening',entry,duringStartup);let navigations=0;page.on('framenavigated',f=>{if(f===page.mainFrame())navigations++;});
  if(duringStartup)await context.addInitScript(()=>{
   if(window===window.top)return;
   const get=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(kind,...args){const gl=get.call(this,kind,...args);if(kind==='webgl2'&&gl&&!sessionStorage.getItem('review-initial-loss')){sessionStorage.setItem('review-initial-loss','yes');setTimeout(()=>gl.getExtension('WEBGL_lose_context')?.loseContext(),80);}return gl;};
  });
  await page.goto(base+'/studio/ui-draft/'+entry+'?scene=parking&qa=context-loss');try{await ready(page);}catch(e){await page.screenshot({path:out+'/context-failed.png'});console.log(await page.evaluate(()=>({text:document.body.innerText,recovery:sessionStorage.getItem('drivescene-context-recovery:'+location.pathname),scene:document.querySelector('iframe[title]')?.contentWindow?.layoutEngine?.draft?.get({audit:false}).scene})));throw e;}console.log('ready',entry,duringStartup);
  if(!duringStartup){
   await page.locator('[data-scene=parking]').click();await page.waitForFunction(()=>document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.get({audit:false}).scene==='parking');
   await page.evaluate(()=>{const c=document.querySelector('iframe[title]').contentDocument.querySelector('#scene-canvas');c.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();});
   await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('drivescene-context-recovery:'+location.pathname)||'[]').length>0);
   await page.waitForTimeout(300);await ready(page);
  }
  const value=await page.evaluate(()=>({attempts:JSON.parse(sessionStorage.getItem('drivescene-context-recovery:'+location.pathname)||'[]').length,scene:document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.get({audit:false}).scene,feedback:document.querySelector('#feedback-message')?.textContent}));
  assert.equal(value.attempts,1);if(!duringStartup)assert.equal(value.scene,'parking');assert.ok(!value.feedback?.includes('could not load'));
  records.push({entry,duringStartup,navigations,...value});await page.screenshot({path:out+'/'+entry+'-context-'+(duringStartup?'startup':'parking')+'.png'});await context.close();
 }
 await writeFile(out+'/context-recovery-browser.json',JSON.stringify(records,null,2));
});

test('Repeated context loss during an Interaction offers a working Reload action', {timeout:120000},async t=>{
 const browser=await chromium.launch(browserOptions());t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1280,height:860}});await configureRenderer(context);
 const page=await context.newPage();
 await page.goto(base+'/studio/ui-draft/pro-prototype.html?scene=elevated');await ready(page);
 await page.locator('[data-event=roadworks]').click();
 await page.waitForFunction(()=>document.querySelector('#tl-range').max!=='1000');

 const loseContext=()=>page.evaluate(()=>{
  const frame=document.querySelector('iframe[title]');
  window.lostReviewFrame=frame;
  const gl=frame.contentDocument.querySelector('#scene-canvas').getContext('webgl2');
  gl.getExtension('WEBGL_lose_context').loseContext();
 });
 for (let i=0;i<2;i++) {
  await loseContext();
  await page.waitForFunction(()=>document.querySelector('iframe[title]')!==window.lostReviewFrame);
  await ready(page);
 }
 await page.clock.install();
 await loseContext();
 const reload=page.getByRole('button',{name:'Reload',exact:true});
 await reload.waitFor({timeout:5000});
 assert.equal(await page.locator('iframe[title]').count(),0);
 await page.clock.fastForward(6500);
 assert.equal(await reload.isVisible(),true);
 await Promise.all([page.waitForEvent('framenavigated',frame=>frame===page.mainFrame()),reload.click()]);
 await ready(page);
 assert.equal(new URL(page.url()).searchParams.get('scene'),'elevated');
});
