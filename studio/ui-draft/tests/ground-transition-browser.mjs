import test from 'node:test';
import {browserOptions,configureRenderer} from './browser-renderer.mjs';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';import sharp from 'sharp';import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
test('Indoor and outdoor ground texture stays bounded throughout both theme transitions',{timeout:process.env.CI==='true'?300000:120000},async()=>{
const out=process.env.DRIVESCENE_TEST_EVIDENCE??'work/free-workbench-fix';await mkdir(out,{recursive:true});
const browser=await chromium.launch(browserOptions());const records=[];try{
const context=await browser.newContext({viewport:{width:1440,height:900}});await configureRenderer(context);const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
for(const scene of ['parking','outdoor']){await p.goto((process.env.DRIVESCENE_TEST_URL??'http://127.0.0.1:8000')+'/studio/ui-draft/pro-prototype.html?scene='+scene);await p.waitForFunction(()=>document.querySelector('iframe[title]')?.contentWindow.layoutEngine?.draft?.get({audit:false}).startup?.ready&&document.querySelector('#frame-cover').hidden);
for(const theme of ['dark','light']){
await p.evaluate(async target=>{const w=document.querySelector('iframe[title]').contentWindow,b=w.layoutEngine.draft;b.setPlaying(false);const now=w.performance.now.bind(w.performance),at=now();window.reviewClock={at,elapsed:0,restore:()=>Object.defineProperty(w.performance,'now',{value:now,configurable:true})};Object.defineProperty(w.performance,'now',{value:()=>window.reviewClock.at+window.reviewClock.elapsed,configurable:true});await b.theme(target,{animate:true,deferBlend:true});b.startThemeBlend()},theme);
const noise=[];for(const elapsed of [0,100,200,300,400]){
const url=await p.evaluate(t=>{window.reviewClock.elapsed=t;const b=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;b.advance(0);return b.canvas.toDataURL()},elapsed);const bytes=Buffer.from(url.split(',')[1],'base64');await writeFile(`${out}/ground-${scene}-${theme}-${elapsed}.png`,bytes);
const meta=await sharp(bytes).metadata();const crop=sharp(bytes).extract({left:Math.floor(meta.width*.12),top:Math.floor(meta.height*.85),width:50,height:35}).greyscale();const a=await crop.clone().raw().toBuffer(),blur=await crop.blur(1).raw().toBuffer();const rms=Math.sqrt(a.reduce((s,v,i)=>s+(v-blur[i])**2,0)/a.length);noise.push(rms);
}
await p.evaluate(()=>window.reviewClock.restore());console.log(scene,theme,noise);assert.ok(Math.max(...noise.slice(1,-1))<=Math.max(noise[0],noise.at(-1))*1.25+.25,'transition must not amplify ground texture');records.push({scene,theme,highFrequencyRms:noise});}
}assert.deepEqual(errors,[]);await writeFile(out+'/ground-transition.json',JSON.stringify(records,null,2));}finally{await browser.close()}

});
