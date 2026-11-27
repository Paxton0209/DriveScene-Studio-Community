import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.DRIVESCENE_TEST_URL??'http://127.0.0.1:8884';
const evidence=process.env.DRIVESCENE_TEST_EVIDENCE??'work/theme-traffic-fix';
test('Actual sky draw frames and Traffic recovery across scene, weather and rapid input combinations',{timeout:360000},async t=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],records=[];
 page.on('pageerror',e=>errors.push(e.message));
 const ready=()=>page.waitForFunction(()=>{const b=document.querySelector('iframe')?.contentWindow?.layoutEngine?.draft;return b?.get({audit:false}).startup?.ready&&document.querySelector('#frame-cover')?.hidden;},null,{timeout:90000});
 async function open(scene){await page.goto(base+'/studio/ui-draft/pro-prototype.html?plan=pro&scene='+scene);await ready();}
 for(const scene of ['road','elevated','ramp','junction','parking','outdoor']){
  await open(scene);
  for(const weather of ['Clear','Rain','Snow']){
   const control=page.getByRole('radio',{name:weather,exact:true});
   if(await control.isVisible())await control.click();
   await page.waitForTimeout(700);
   await page.evaluate(()=>{
    const b=document.querySelector('iframe').contentWindow.layoutEngine.draft;
    const sky=b.capture().objects.find(o=>o.object.material?.uniforms?.top&&o.object.material?.uniforms?.bottom).object;
    window.skySamples=[];const original=sky.onBeforeRender;
    sky.onBeforeRender=function(...args){original.apply(this,args);const u=args[4].uniforms;window.skySamples.push({at:performance.now(),shell:document.documentElement.dataset.theme,blend:b.themeStatus().blending,bottom:u.bottom.value.toArray(),top:u.top.value.toArray(),weatherTop:u.weatherTop?.value.toArray()});};
    window.restoreSky=()=>{sky.onBeforeRender=original;};
   });
   for(let direction=0;direction<2;direction++){
    const from=await page.locator('html').getAttribute('data-theme');
    await page.evaluate(()=>{window.skySamples=[];});
    await page.locator('#theme').click();await page.waitForTimeout(650);
    const samples=await page.evaluate(()=>window.skySamples);
    assert.ok(samples.length>5,scene+' must draw during theme change');
    const channels=['top','bottom','weatherTop'];
    for(const key of channels)for(let c=0;c<3;c++){
     const start=samples[0][key]?.[c],end=samples.at(-1)[key]?.[c];if(start===undefined)continue;
     const lo=Math.min(start,end)-.003,hi=Math.max(start,end)+.003;
     for(const f of samples)assert.ok(f[key][c]>=lo&&f[key][c]<=hi,`${scene}/${weather}/${from}: ${key} overshoots ${f[key][c]} outside ${lo}..${hi}`);
    }
    const a=samples[0],z=samples.at(-1),diff=z.bottom.reduce((n,v,i)=>n+Math.abs(v-a.bottom[i]),0);
    const moving=samples.find(f=>f.bottom.some((v,i)=>Math.abs(v-a.bottom[i])>diff*.02));
    const committed=samples.find(f=>f.shell!==from);
    assert.ok(diff>.001,'theme changes actual sky');
    assert.ok(moving&&committed&&moving.at-committed.at<100,'sky begins with shell');
    records.push({scene,weather,from,frames:samples.length,skyStartFromShellMs:moving.at-committed.at,start:a,end:z});
   }
   await page.evaluate(()=>window.restoreSky());
  }
 }
 await open('elevated');
 // Force a real rejected engine operation to exercise the UI rollback, then retry
 // through the same user control with the normal engine implementation.
 await page.evaluate(()=>{const b=document.querySelector('iframe').contentWindow.layoutEngine.draft;const native=b.param.bind(b);let fail=true;b.param=async(k,v,...args)=>{if(k==='traffic'&&v&&fail){fail=false;throw Error('Traffic test load failure');}return native(k,v,...args);};});
 const traffic=page.locator('[data-layer=traffic]');
 assert.equal(await traffic.getAttribute('aria-pressed'),'false');
 await traffic.click();await page.waitForFunction(()=>document.querySelector('#feedback-message').textContent.includes('Traffic test load failure'));
 assert.equal(await traffic.getAttribute('aria-pressed'),'false','failed load rolls back toggle');
 await traffic.click();
 await page.waitForFunction(()=>{const a=document.querySelector('iframe').contentWindow.layoutEngine.draft.audit().traffic;return a.enabled&&a.visible>0;},null,{timeout:30000});
 records.push({trafficFailureRollback:true,retryActualCars:true});
 for(const actions of [ ['traffic','theme','traffic','roadworks'],['roadworks','traffic','theme','traffic'],['theme','theme','roadworks','traffic'] ]){
  for(const action of actions)await page.locator(action==='theme'?'#theme':action==='traffic'?'[data-layer=traffic]':'[data-event=roadworks]').click();
  await page.waitForTimeout(700);
  const state=await page.evaluate(()=>({pressed:document.querySelector('[data-layer=traffic]').getAttribute('aria-pressed')==='true',audit:document.querySelector('iframe').contentWindow.layoutEngine.draft.audit().traffic}));
  assert.equal(state.audit.enabled,state.pressed);if(state.pressed)assert.ok(state.audit.visible>0);
  records.push({actions,traffic:state.pressed,visible:state.audit.visible});
 }
 assert.deepEqual(errors,[]);await mkdir(evidence,{recursive:true});await writeFile(evidence+'/theme-traffic-browser.json',JSON.stringify({records,errors},null,2));
 await page.screenshot({path:evidence+'/theme-traffic-browser.png'});
});

test('An aborted Traffic model request leaves the toggle off and a subsequent click loads visible cars',{timeout:90000},async t=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
 const page=await browser.newPage();let blocked=0;
 await page.route('**/traffic-model-y.prepared.bin.gz*',route=>{blocked++;return route.abort('failed');});
 await page.goto(base+'/studio/ui-draft/pro-prototype.html?plan=pro&scene=elevated');
 await page.waitForFunction(()=>{const b=document.querySelector('iframe')?.contentWindow?.layoutEngine?.draft;return b?.get({audit:false}).startup?.ready&&document.querySelector('#frame-cover')?.hidden;},null,{timeout:60000});
 await page.waitForTimeout(300);
 const traffic=page.locator('[data-layer=traffic]');await traffic.click();
 await page.waitForFunction(()=>!document.querySelector('#feedback').hidden);
 assert.ok(blocked>0,'exercise an actual asset request failure');
 assert.equal(await traffic.getAttribute('aria-pressed'),'false');
 assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentWindow.layoutEngine.draft.audit().traffic.enabled),false);
 await page.unroute('**/traffic-model-y.prepared.bin.gz*');await traffic.click();
 await page.waitForFunction(()=>{const a=document.querySelector('iframe').contentWindow.layoutEngine.draft.audit().traffic;return a.enabled&&a.modelReady&&a.count>0&&a.lanes.some(c=>c.alpha>.9);},null,{timeout:30000});
 await mkdir(evidence,{recursive:true});await writeFile(evidence+'/traffic-network-retry.json',JSON.stringify({blocked,recovered:true}));
});
