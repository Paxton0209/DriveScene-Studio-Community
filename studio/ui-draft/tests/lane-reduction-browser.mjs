import test from 'node:test';
import {browserOptions,configureRenderer} from './browser-renderer.mjs';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

test('Reducing Road to two lanes retires completed and in-progress event offsets',{timeout:process.env.CI==='true'?300000:120000},async()=>{
 const out=process.env.DRIVESCENE_TEST_EVIDENCE??'work/free-workbench-fix';
 await mkdir(out,{recursive:true});
 const browser=await chromium.launch(browserOptions());
 try {
  const context=await browser.newContext();
  await configureRenderer(context);
  const p=await context.newPage();
  await p.goto((process.env.DRIVESCENE_TEST_URL??'http://127.0.0.1:8000')+'/studio/ui-draft/pro-prototype.html?scene=road');
  await p.waitForFunction(()=>document.querySelector('iframe[title]')?.contentWindow.layoutEngine?.draft?.get({audit:false}).ready);
  const lanes=async count=>{
   await p.locator(`[data-param=lanes] [data-value="${count}"]`).click();
   await p.waitForFunction(count=>{
    const b=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
    return b.get({audit:false}).ready&&b.audit().laneCount===count&&document.querySelector('#frame-cover').hidden;
   },count);
  };
  for(const event of ['lanechange','cutin'])for(const time of [3.25,10,13]){
   await lanes(6);
   await p.locator(`[data-event=${event}]`).click();
   await p.waitForFunction(event=>document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.get({audit:false}).roadworks?.event===event,event);
   await p.locator('#tl-range').evaluate((el,t)=>{el.value=t*100;el.dispatchEvent(new Event('input',{bubbles:true}))},time);
   await p.waitForFunction(time=>{
    const state=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.get({audit:false});
    return !state.requestedPlaying&&Math.abs(state.roadworks.time-(state.roadworks.eventStart??0)-time)<.02;
   },time);
   await lanes(2);
   const result=await p.evaluate(()=>{
    const b=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
    return{ego:b.capture().pose.carPosition.toArray(),lanes:b.audit().laneCount,event:b.get({audit:false}).roadworks};
   });
   console.log(event,time,result);
   assert.equal(result.lanes,2);
   assert.ok(Math.abs(result.ego[0]-1.85)<.02,'ego must be in remaining lane');
   assert.equal(result.event,null);
  }
  await p.screenshot({path:out+'/road-lane-after.png'});
 }finally{await browser.close();}
});
