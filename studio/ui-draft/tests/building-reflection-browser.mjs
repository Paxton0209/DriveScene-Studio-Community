import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';

const base=process.env.DRIVESCENE_TEST_URL??'http://127.0.0.1:8884';
test('building shadows stay off while blurred mirrors survive scene, theme, camera and layer changes',{timeout:180_000},async t=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[],records=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',entry=>{if(entry.type()==='error')errors.push(entry.text());});
 const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.layoutEngine?.draft?.get({audit:false})?.startup?.ready,undefined,{timeout:90_000});
 for(const scene of ['road','elevated','ramp','junction']){
  await page.goto(base+'/studio/ui-draft/pro-prototype.html?plan=free&scene='+scene,{waitUntil:'domcontentloaded'});
  await ready();
  for(const theme of ['light','dark']){
   if(await page.locator('html').getAttribute('data-theme')!==theme){await page.locator('#theme').click();await page.waitForTimeout(650);}
   for(const camera of ['Low','High']){
    await page.getByRole('radio',{name:camera,exact:true}).click();await ready();
    const audit=await page.evaluate(()=>document.querySelector('iframe').contentWindow.layoutEngine.draft.audit());
    assert.equal(audit.buildingShadowCasters,0,scene+' '+theme+' '+camera);
    assert.equal(audit.buildingVSMParticipants,0);
    if(scene==='ramp')assert.equal(audit.groundReflection.buildings,0);
    else assert.ok(audit.groundReflection.buildings>0,scene+' '+theme+' '+camera);
    assert.equal(audit.groundReflection.vehiclePassSeparate,true);
    records.push({scene,theme,camera,shadows:0,reflectionBuildings:audit.groundReflection.buildings});
   }
  }
  if(scene==='ramp')continue;
  await page.locator('[data-layer=buildings]').click();
  await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.layoutEngine.draft.audit().groundReflection.buildings===0);
  await page.locator('[data-layer=buildings]').click();
  await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.layoutEngine.draft.audit().groundReflection.buildings>0);
  records.push({scene,layerOffClearsReflection:true,layerOnRestoresReflection:true});
 }
 assert.deepEqual(errors,[]);
 if(process.env.DRIVESCENE_TEST_EVIDENCE){await mkdir(process.env.DRIVESCENE_TEST_EVIDENCE,{recursive:true});await writeFile(process.env.DRIVESCENE_TEST_EVIDENCE+'/building-reflection.json',JSON.stringify({records,errors},null,2));}
});
