import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {mkdir,writeFile} from 'node:fs/promises';
import {browserOptions,configureRenderer} from './browser-renderer.mjs';
const base=process.env.DRIVESCENE_TEST_URL??'http://127.0.0.1:8000';
const evidence=process.env.DRIVESCENE_TEST_EVIDENCE??'work/free-workbench-fix';
const policy=()=>{
 let hidden=window.top===window?false:true;
 Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
 window.setReviewVisibility=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
};
const ready=page=>page.waitForFunction(()=>{
 const f=document.querySelector('iframe[title]'),b=f?.contentWindow?.layoutEngine?.draft;
 return b?.get({audit:false}).startup?.ready&&b.get({audit:false}).ready;
},null,{timeout:90000});
const visible=page=>page.evaluate(()=>{window.setReviewVisibility(false);document.querySelector('iframe[title]').contentWindow.setReviewVisibility(false);});
async function pixels(page,label){
 const image=await page.frameLocator('iframe[title]').locator('#scene-canvas').screenshot();
 const {data,info}=await sharp(image).resize(160,90).removeAlpha().raw().toBuffer({resolveWithObject:true});
 let lit=0,max=0;for(let i=0;i<data.length;i+=info.channels){const v=Math.max(...data.subarray(i,i+3));if(v>16)lit++;max=Math.max(max,v);}
 const fraction=lit/(info.width*info.height);
 assert.ok(fraction>.15&&max>80,`${label}: black frame (${fraction}, max ${max})`);
 await writeFile(evidence+'/'+label+'.png',image);
 return {label,litFraction:fraction,max};
}
test('Cold background preparation, parked visibility return, unrestricted events and 4K export',{timeout:process.env.CI==='true'?1800000:360000},async t=>{
 await mkdir(evidence,{recursive:true});
 const browser=await chromium.launch(browserOptions());t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 await configureRenderer(context);
 await context.addInitScript(policy);
 const page=await context.newPage(),errors=[],apiRequests=[],records=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(/\/api\/pro\/|stripe|paddle|lemonsqueezy/.test(request.url()))apiRequests.push(request.url());});
 // Startup runs with the embedded document hidden. Returning must work without Reload.
 for(const entry of ['index.html','pro-prototype.html']){
  await page.goto(base+'/studio/ui-draft/'+entry+'?qa=free-background');await ready(page);
  await visible(page);
  await page.waitForFunction(()=>document.querySelector('iframe[title]')?.contentWindow?.layoutEngine?.draft?.themeStatus().renderedFrames>0);
  if(entry==='index.html')await page.waitForFunction(()=>document.body.dataset.ready==='true');
  records.push(await pixels(page,entry+'-cold-return'));
  console.log('cold return',entry);
 }
 assert.equal(await page.locator('#proto-bar,#account-actions,.pro-tag,#sign-in,#upgrade-top').count(),0);
 // Old plan/checkout links must also remain open and generate no account requests.
 await page.goto(base+'/studio/ui-draft/pro-prototype.html?scene=parking&plan=free&checkout=success&session_id=old');
 await ready(page);await visible(page);await page.waitForFunction(()=>document.querySelector('#frame-cover').hidden);
 assert.equal(new URL(page.url()).searchParams.has('plan'),false);
 for(const theme of ['light','dark']){
  if(await page.locator('html').getAttribute('data-theme')!==theme){await page.locator('#theme').click();await page.waitForTimeout(650);}
  for(const scene of ['parking','outdoor','road','elevated','ramp','junction']){
   await page.locator(`[data-scene="${scene}"]`).click();
   await page.waitForFunction(scene=>{const b=document.querySelector('iframe[title]')?.contentWindow?.layoutEngine?.draft;return b?.get({audit:false}).scene===scene&&document.querySelector('#frame-cover').hidden;},scene,{timeout:60000});
   await page.evaluate(()=>{const b=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;b.setPlaying(false);});
   records.push(await pixels(page,theme+'-'+scene));
   // A paused canvas has no motion loop to repair a discarded/cleared back buffer.
   // Visibility return must explicitly submit a fresh draw.
   const before=await page.evaluate(()=>{const f=document.querySelector('iframe[title]').contentWindow,b=f.layoutEngine.draft;f.setReviewVisibility(true);return b.themeStatus().renderedFrames;});
   await visible(page);
   const after=await page.evaluate(()=>document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.themeStatus().renderedFrames);
   assert.ok(after>before,theme+'/'+scene+' redraws on visibility return');
   records.push({theme,scene,before,after});
   console.log('scene and visibility return',theme,scene);
  }
 }
 // Real asynchronous vehicle load while the preview becomes hidden.
 await page.route('**/vehicles/ix/model.glb.gz*',async route=>{await page.evaluate(()=>document.querySelector('iframe[title]').contentWindow.setReviewVisibility(true));await route.continue();});
 await page.evaluate(async()=>{await document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.param('model','ix');});
 await visible(page);
 assert.equal(await page.evaluate(()=>document.querySelector('iframe[title]').contentWindow.layoutEngine.get().vehicle),'ix');
 await page.unroute('**/vehicles/ix/model.glb.gz*');
 await page.locator('[data-scene=elevated]').click();
 await page.waitForFunction(()=>document.querySelector('iframe[title]')?.contentWindow?.layoutEngine?.draft?.get({audit:false}).scene==='elevated'&&document.querySelector('#frame-cover').hidden);
 await page.locator('[data-event=roadworks]').click();
 await page.waitForFunction(()=>document.querySelector('[data-event=roadworks]').getAttribute('aria-checked')==='true');
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.locator('[data-event=roadworks]').click();
 await page.waitForFunction(()=>document.querySelector('[data-event=roadworks]').getAttribute('aria-checked')==='false');
 // Export must create a real 3840px PNG without a session, even with old plan=free URLs.
 await page.locator('.format-trigger[aria-controls=format-options]').click();
 await page.locator('#format-options [data-value=png]').click();
 console.log('starting real 4K export');
 const exportTimeout=process.env.CI==='true'?600000:90000;
 const download=page.waitForEvent('download',{timeout:exportTimeout}).catch(async error=>{
  console.log('export feedback',await page.locator('#export,#toast,[role=status],[role=alert]').allTextContents());
  throw error;
 });
 await page.locator('#export').click({timeout:exportTimeout});
 const file=await download;const path=await file.path();const metadata=await sharp(path).metadata();assert.equal(metadata.width,3840);
 records.push({exportWidth:metadata.width,exportHeight:metadata.height});
 console.log('export dimensions',metadata.width,metadata.height);
 await page.locator('.format-trigger[aria-controls=format-options]').click();
 const video=page.locator('#format-options [data-value=video]');assert.equal(await video.getAttribute('aria-disabled'),null);await video.click();
 assert.equal(await page.getByRole('dialog').count(),0);
 assert.deepEqual(apiRequests,[]);assert.deepEqual(errors,[]);
 await writeFile(evidence+'/free-workbench-browser.json',JSON.stringify({records,apiRequests,errors},null,2));
});

test('A nine-second foreground stall during cold startup does not stop the real preview', {timeout:120000},async t=>{
 const browser=await chromium.launch(browserOptions());t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1240,height:840},reducedMotion:'reduce'});
 await configureRenderer(context);
 await context.addInitScript(policy);
 const page=await context.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/studio/ui-draft/index.html?qa=foreground-stall');
 await page.waitForFunction(()=>!!performance.getEntriesByName('draft-resources-ready').length);

 const timing=await page.evaluate(()=>new Promise(resolve=>{
  const engine=document.querySelector('iframe[title]').contentWindow;
  const bridge=engine.layoutEngine.draft;
  const requestFrame=engine.requestAnimationFrame.bind(engine);
  const distance=()=>bridge.get({audit:false}).distance;
  const samples=[];
  let stall;
  engine.requestAnimationFrame=callback=>requestFrame(stamp=>{
   if(!stall){
    const before=distance(),start=performance.now();
    while(performance.now()-start<9100){}
    stall={duration:performance.now()-start,before,after:distance()};
   }
   callback(stamp);
   samples.push(distance());
   if(samples.length===8){engine.requestAnimationFrame=requestFrame;resolve({stall,samples});}
  });
  engine.setReviewVisibility(false);
 }));
 await page.waitForFunction(()=>document.body.dataset.ready==='true'||!document.querySelector('#feedback').hidden);
 assert.equal(await page.locator('body').getAttribute('data-ready'),'true');
 assert.deepEqual(errors,[]);
 assert.ok(timing.stall.duration>=9000);
 assert.equal(timing.stall.after,timing.stall.before);
 assert.ok(timing.samples.at(-1)>timing.stall.after);
 for(let i=0;i<timing.samples.length;i++){
  const previous=i===0?timing.stall.after:timing.samples[i-1];
  assert.ok(timing.samples[i]-previous<5,'the resume step does not advance by the blocked wall time');
 }
});
