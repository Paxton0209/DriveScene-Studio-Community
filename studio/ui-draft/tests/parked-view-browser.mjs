import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright';
import sharp from 'sharp';

const base=process.env.DRIVESCENE_TEST_URL ?? 'http://127.0.0.1:8000';
const evidence=process.env.DRIVESCENE_TEST_EVIDENCE;
const entry=new URL('/studio/ui-draft/pro-prototype.html?plan=pro&scene=parking',base);

test('Parked theme changes blend the presented frame in both directions', {timeout:120_000}, async t=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1120,height:760}});
  const url=new URL(entry);
  url.searchParams.set('view','parked');
  const toggle=page.locator('#theme');
  const visual=page.locator('canvas.parked-view[role=img]');
  const overlay=page.locator('canvas.parked-view[aria-hidden=true]');
  for(const scene of ['parking','outdoor']){
    url.searchParams.set('scene',scene);
    await page.goto(url.href);
    await visual.waitFor();
    await page.evaluate(()=>{
      const animate=Element.prototype.animate;
      Element.prototype.animate=function(...args){
        const animation=animate.apply(this,args);
        if(this.matches('canvas.parked-view[aria-hidden=true]')){
          animation.pause();
          animation.currentTime=0;
        }
        return animation;
      };
    });
    const box=await visual.boundingBox();
    const clip={x:Math.round(box.x+box.width*.3),y:Math.round(box.y+box.height*.04),width:8,height:8};
    const pixel=async()=> (await sharp(await page.screenshot({clip})).stats()).channels[0].mean;
    for(const theme of ['dark','light']){
      const source=await pixel();
      await toggle.click();
      await overlay.waitFor({state:'attached'});
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      assert.equal(await overlay.evaluate(layer=>layer.getAnimations()[0].effect.getTiming().duration),400);
      assert.ok(Math.abs(await pixel()-source)<3,`${scene} ${theme} first frame`);
      const samples=[];
      for(const time of [100,200,300]){
        await overlay.evaluate((layer,time)=>{layer.getAnimations()[0].currentTime=time;},time);
        samples.push(await pixel());
      }
      await overlay.evaluate(layer=>layer.getAnimations()[0].finish());
      await overlay.waitFor({state:'detached'});
      const target=await pixel();
      assert.ok(Math.abs(target-source)>25,`${scene} ${theme} needs a distinct sample`);
      for(const [i,amount] of [.15625,.5,.84375].entries()){
        const expected=source+(target-source)*amount;
        assert.ok(Math.abs(samples[i]-expected)<5,`${scene} ${theme} ${samples[i]} versus ${expected}`);
      }
      assert.deepEqual(await visual.boundingBox(),box);
      await page.waitForFunction(theme=>history.state?.parkedPreview?.theme===theme&&history.state.parkedPreview.poster,theme);
      const tones=await visual.evaluate(canvas=>{
        const context=canvas.getContext('2d');
        const width=Math.round(canvas.width*.14), x=Math.round(canvas.width*.04);
        return Array.from({length:21},(_,i)=>{
          const y=Math.round((canvas.height-8)*i/20);
          const pixels=context.getImageData(x,y,width,8).data;
          let total=0;
          for(let p=0;p<pixels.length;p+=4)total+=pixels[p];
          return total/(pixels.length/4);
        });
      });
      const range=tones[0]-tones.at(-1);
      assert.ok(range>(theme==='dark'?6:48),`${scene} ${theme} backdrop retains its tonal range`);
      const largestStep=Math.max(...tones.slice(1).map((tone,i)=>tones[i]-tone));
      assert.ok(largestStep<range*.12,`${scene} ${theme} backdrop concentrates too much contrast in one band`);
    }
    const light=await pixel();
    await toggle.click();
    await overlay.waitFor({state:'attached'});
    const fading=await overlay.elementHandle();
    await fading.evaluate(layer=>{layer.getAnimations()[0].currentTime=200;});
    const reversedFrom=await pixel();
    await toggle.click();
    await page.waitForFunction(layer=>!layer.isConnected,fading);
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    assert.ok(Math.abs(await pixel()-reversedFrom)<3,`${scene} starts the reversal from the visible frame`);
    await overlay.evaluate(layer=>layer.getAnimations()[0].finish());
    await overlay.waitFor({state:'detached'});
    assert.ok(Math.abs(await pixel()-light)<3);
    await page.emulateMedia({reducedMotion:'reduce'});
    await toggle.click();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&history.state?.parkedPreview?.theme==='dark');
    assert.equal(await overlay.count(),0);
    await toggle.click();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
    await page.emulateMedia({reducedMotion:'no-preference'});
  }
});

test('Parked belongs to Parking and exports its live 3D composition', {timeout:240_000}, async t=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&message.text().includes('THREE.'))errors.push(message.text());});
  const requests=[];page.on('request',request=>requests.push(request.url()));
  const radio=name=>page.locator('#scene-properties').getByRole('radio',{name,exact:true});
  const visual=page.locator('canvas.parked-view');
  const artboard=page.locator('.artboard-clip');
  const parked=radio('Parked');
  const transport=page.locator('#scene-transport');
  if(evidence)await mkdir(evidence,{recursive:true});
  const shot=async name=>{if(evidence)await page.screenshot({path:join(evidence,name+'.png')});};
  const ready=()=>page.waitForFunction(()=>document.querySelector('.pro-scene-preview')?.contentWindow?.layoutEngine?.draft?.get({audit:false})?.startup?.ready);
  await page.goto(entry.href);
  await parked.waitFor();
  assert.equal(await parked.isDisabled(),true);
  const controls=await page.locator('#scene-properties .property:has([data-param=camera])').evaluate(row=>{
    const [label,options]=row.children;
    const l=label.getBoundingClientRect(),o=options.getBoundingClientRect(),r=row.getBoundingClientRect();
    return {stacked:o.top>=l.bottom, fullWidth:Math.abs(r.width-o.width)<1,height:o.height};
  });
  assert.deepEqual(controls,{stacked:true,fullWidth:true,height:32});
  assert(!requests.some(url=>url.includes('parked-view.bundle.js')));
  await ready();
  await shot('parking-normal-desktop-light');
  await parked.evaluate(button=>button.click());
  assert.equal(await parked.getAttribute('aria-checked'),'false');
  await transport.click();
  await page.waitForFunction(()=>document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft.get({audit:false}).requestedPlaying);
  assert.equal(await page.locator('#playback-wheel > svg:last-child').isVisible(),true);
  assert.equal(await parked.isDisabled(),true);
  const ordinaryArrival=await page.evaluate(()=>{
    const bridge=document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft;
    window.arrivalPaint=new Promise(resolve=>{
      const observer=new MutationObserver(()=>{
        if(!document.querySelector('canvas.parked-view:not([hidden])'))return;
        observer.disconnect();
        const {parking,requestedPlaying}=bridge.get({audit:false});
        resolve({replayReady:parking.replayReady,playing:requestedPlaying});
      });
      observer.observe(document.querySelector('.artboard-clip'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});
    });
    bridge.advance(.9);bridge.advance(100);
    const arrival=bridge.get({audit:false}).parking;
    const target=bridge.capture().objects.find(entry=>entry.object.name==='Parking target space');
    return {arrived:arrival.complete,canRotate:!!bridge.parkingComposition(),bayVisible:target.visible};
  });
  assert.deepEqual(ordinaryArrival,{arrived:true,canRotate:true,bayVisible:true});
  const before=await artboard.boundingBox();
  await shot('parking-settled-desktop-light');
  await visual.waitFor();
  assert.deepEqual(await page.evaluate(()=>window.arrivalPaint),{replayReady:true,playing:false});
  await page.waitForFunction(()=>!document.querySelector('[data-value=parked]').hasAttribute('aria-busy'));
  assert.equal(await parked.getAttribute('aria-checked'),'true');
  assert.deepEqual(await artboard.boundingBox(),before);
  const pixels=await visual.evaluate(canvas=>{
    const row=canvas.getContext('2d').getImageData(Math.floor(canvas.width/3),0,1,1).data;
    return {width:canvas.width,height:canvas.height,top:[...row]};
  });
  assert(Math.abs(pixels.width/pixels.height-16/9)<.005);
  assert(pixels.top[0]>231 && pixels.top[0]<244,JSON.stringify({pixels,errors}));
  assert(requests.some(url=>url.includes('/vehicles/model-3/model.glb.gz')));
  await shot('parked-desktop-light');

  const size=page.locator('[aria-controls=image-size-options]');
  await size.click();
  await page.getByRole('option',{name:'1920 × 1184',exact:true}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const png=await download;
  assert.equal(png.suggestedFilename(),'parked.png');
  const {width,height}=await sharp(await readFile(await png.path())).metadata();
  assert.deepEqual([width,height],[1920,1184]);
  if(evidence)await png.saveAs(join(evidence,'parked-render-desktop.png'));

  await page.locator('#theme').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&!document.documentElement.classList.contains('theme-changing'));
  const darkSky=await visual.evaluate(canvas=>{
    return canvas.getContext('2d').getImageData(1,0,1,1).data[0];
  });
  assert(darkSky>30&&darkSky<55);
  await shot('parked-desktop-dark');
  await page.evaluate(()=>{
    const bridge=document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft;
    const paint=bridge.paintParkedBlend;
    const draw=CanvasRenderingContext2D.prototype.drawImage;
    let pose, handoff;
    const sample=canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,4,1).data);
    window.departureFrames=[];
    bridge.paintParkedBlend=(next,destination,liveWeight,frameTime)=>{
      pose=next;
      const result=paint(next,destination,liveWeight,frameTime);
      if(destination)handoff=result;
      return result;
    };
    CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
      const result=draw.call(this,source,...args);
      if(!this.canvas.matches('.parked-view'))return result;
      if(pose&&this.globalAlpha<1)window.departureFrames.push({pose,opacity:this.globalAlpha,sky:sample(this.canvas)[0]});
      if(source===handoff){
        const reference=document.createElement('canvas');
        reference.width=this.canvas.width;
        reference.height=this.canvas.height;
        draw.call(reference.getContext('2d'),source,...args);
        window.parkingHandoff={frame:sample(this.canvas),live:sample(reference),destination:bridge.get({audit:false}).parking.manualView};
      }
      return result;
    };
  });
  await transport.click();
  assert.equal(await parked.isDisabled(),true);
  await visual.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft.get({audit:false}).requestedPlaying);
  assert.equal(await radio('Low').getAttribute('aria-checked'),'true');
  const departing=await page.evaluate(()=>{
    const bridge=document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft;
    return {mode:bridge.get({audit:false}).parking.mode,frames:window.departureFrames,handoff:window.parkingHandoff};
  });
  assert.equal(departing.mode,'out');
  const blending=departing.frames.filter(({opacity})=>opacity>.05&&opacity<.95);
  assert(blending.length>=2,JSON.stringify(departing.frames));
  assert.notDeepEqual(blending[0].pose.orientation,blending.at(-1).pose.orientation);
  assert(blending[0].opacity>blending.at(-1).opacity);
  assert.deepEqual(departing.handoff.frame,departing.handoff.live);
  assert.equal(departing.handoff.destination,'default');
  const skySamples=departing.frames.map(frame=>frame.sky).concat(departing.handoff.frame[0]);
  assert(Math.max(...skySamples.slice(1).map((value,i)=>Math.abs(value-skySamples[i])))<9,JSON.stringify(skySamples));
  await page.evaluate(()=>document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft.advance(8));
  await page.waitForFunction(()=>document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft.get({audit:false}).parking.exited);
  assert.equal(await radio('Low').getAttribute('aria-checked'),'true');
  await shot('parking-departed-desktop-dark');
  await page.reload();
  await ready();
  await transport.click();
  await page.waitForFunction(()=>document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft.get({audit:false}).requestedPlaying);
  await page.evaluate(()=>{
    const bridge=document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft;
    bridge.advance(.9);bridge.advance(100);
  });
  await visual.waitFor({timeout:45000}).catch(async error=>{
    const state=await page.evaluate(()=>{
      const bridge=document.querySelector('.pro-scene-preview').contentWindow.layoutEngine.draft;
      const {parking,requestedPlaying}=bridge.get({audit:false});
      return {parking,requestedPlaying,composition:bridge.parkingComposition(),
        assist:document.querySelector('#scene-transport').getAttribute('aria-checked')};
    });
    throw Error(JSON.stringify({state,errors}),{cause:error});
  });
  await radio('High').click();
  await visual.waitFor({state:'hidden'});
  assert.equal(await radio('High').getAttribute('aria-checked'),'true');
  assert(!new URL(page.url()).searchParams.has('view'));
  await shot('parking-normal-desktop-dark');
  await page.locator('[data-event=parking-yield]').click();
  await radio('Auto').waitFor();
  assert.equal(await radio('Auto').getAttribute('aria-checked'),'true');
  assert.equal(await parked.isDisabled(),true);
  const eventControls=await page.locator('#scene-properties [data-param=camera]').evaluate(segment=>{
    const options=[...segment.querySelectorAll('button')].map(button=>{
      const text=document.createRange();text.selectNodeContents(button);
      return button.getBoundingClientRect().width-text.getBoundingClientRect().width;
    });
    return {options,fits:segment.scrollWidth===segment.clientWidth};
  });
  assert.equal(eventControls.options.length,4);
  assert(eventControls.fits&&Math.min(...eventControls.options.slice(0,3))>=15&&eventControls.options[3]>=23,JSON.stringify(eventControls));
  await page.waitForFunction(()=>document.querySelector('#tl-range')?.valueAsNumber>5);
  const range=page.locator('#tl-range');
  await range.fill(await range.getAttribute('max'));
  await page.waitForFunction(()=>document.querySelector('[data-value=parked]').getAttribute('aria-disabled')==='false');
  assert.equal(await parked.getAttribute('aria-checked'),'false','scrubbing to the end keeps the timeline open');
  assert.equal(await range.isVisible(),true);
  await parked.click();
  await visual.waitFor();
  await radio('Low').click();
  await visual.waitFor({state:'hidden'});
  await range.fill('100');
  await page.locator('[data-scene=outdoor]').click();
  await parked.waitFor();
  assert.equal(await parked.isDisabled(),true);
  const road=page.locator('[data-scene=road]');
  await road.click();
  assert.equal(await parked.count(),0);
  await visual.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  await page.close();

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const parkedUrl=new URL(entry);
  parkedUrl.searchParams.set('view','parked');
  await mobile.goto(parkedUrl.href);
  await mobile.locator('canvas.parked-view').waitFor({timeout:90000});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth),390);
  assert.equal(await mobile.locator('#scene-properties [data-param=camera]').evaluate(segment=>segment.offsetHeight),46);
  if(evidence)await mobile.screenshot({path:join(evidence,'parked-mobile-light.png')});
  await mobile.locator('#theme').click();
  await mobile.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  if(evidence)await mobile.screenshot({path:join(evidence,'parked-mobile-dark.png')});
});

for(const [event,turnOff] of [['parking-taken',true],['parking-yield',false]]) {
  test(`${event} turns to Parked on arrival and exits forward with the bay unlit`,{timeout:150_000},async t=>{
    const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&message.text().includes('THREE.'))errors.push(message.text());});
    const toggle=id=>page.locator(`[data-event=${id}]`);
    const parked=page.locator('#scene-properties [data-value=parked]');
    const visual=page.locator('canvas.parked-view');
    const high=page.locator('#scene-properties [data-value=high]');
    const low=page.locator('#scene-properties [data-value=low]');

    await page.goto(entry.href);
    await page.waitForFunction(()=>{
      window.parkingBridge=document.querySelector('.pro-scene-preview')?.contentWindow?.layoutEngine?.draft;
      return window.parkingBridge?.get({audit:false})?.startup?.ready;
    });
    await toggle(event).click();
    await page.waitForFunction(id=>window.parkingBridge.get({audit:false}).event?.event===id,event);
    const result=await page.evaluate(async ()=>{
      const bridge=window.parkingBridge;
      const run=bridge.get({audit:false}).event;
      bridge.seekRoadworks(run.duration-.1);
      bridge.setPlaying(true);
      bridge.advance(.11);
      const objects=bridge.capture().objects.map(item=>item.object);
      const target=objects.find(object=>object.name==='Parking target space');
      const columns=objects.filter(object=>object.userData.draftViewColumn);
      const columnState=()=>JSON.stringify(columns.map(column=>[
        ...column.position.toArray(),...column.scale.toArray(),column.userData.draftOcclusionAlpha,
        column.material.uniforms.overhead.value,column.material.uniforms.capVisibility.value
      ]));
      const arrivalColumns=columnState();
      if(!columns.length)throw Error('No parking columns to verify');
      window.arrivalColumns={read:columnState,value:arrivalColumns};
      const canRotate=!!bridge.parkingComposition(),bayVisible=target.visible;
      window.columnsDuringOrbit=new Promise(resolve=>{
        let held=true,frames=0;
        function sample(){
          const canvas=document.querySelector('canvas.parked-view:not([hidden])');
          held&&=columnState()===arrivalColumns;
          if(canvas)frames++;
          if(canvas&&!document.querySelector('[data-value=parked]').hasAttribute('aria-busy')){
            resolve({held,frames,bayVisible:target.visible});return;
          }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      const {parking,requestedPlaying}=bridge.get({audit:false});
      // The bridge posts its arrival status; let the parent process it.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {complete:parking.complete,replayReady:parking.replayReady,requestedPlaying,target:parking.target,
        finalTarget:run.finalTarget,canRotate,bayVisible,
        parkedSelected:document.querySelector('[data-value=parked]').getAttribute('aria-checked')==='true'};
    });
    assert.deepEqual(result,{complete:true,replayReady:true,requestedPlaying:false,target:result.finalTarget,finalTarget:result.finalTarget,
      canRotate:true,bayVisible:true,parkedSelected:true});
    await visual.waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-value=parked]').hasAttribute('aria-busy'));
    const orbit=await page.evaluate(()=>window.columnsDuringOrbit);
    assert(orbit.held&&orbit.frames>1,'columns retain their world position, height and opacity throughout the orbit');
    assert.equal(orbit.bayVisible,false,'the bay has faded once the orbit settles');
    const parkedPose=await page.evaluate(()=>window.parkingBridge.parkingComposition().ground);
    if(turnOff){
      await toggle(event).click();
      await page.waitForFunction(()=>!window.parkingBridge.get({audit:false}).event);
      assert.equal(await parked.getAttribute('aria-checked'),'true','disabling the demo keeps the Parked view');
      assert.deepEqual(await page.evaluate(()=>window.parkingBridge.parkingComposition().ground),parkedPose);
      assert.deepEqual(await page.evaluate(()=>window.parkingBridge.get({audit:false}).parking.target),result.target);
      await page.locator('#scene-transport').click();
    } else {
      await high.click();
      await visual.waitFor({state:'hidden'});
      assert.equal(await high.getAttribute('aria-checked'),'true');
      assert.equal(await page.getByRole('slider').isVisible(),true,'the completed event can still be scrubbed');
      await page.locator('#playback-wheel').press('Enter');
    }
    await page.waitForFunction(()=>window.parkingBridge.get({audit:false}).parking.mode==='out');
    await visual.waitFor({state:'hidden'});
    assert.equal(await low.getAttribute('aria-checked'),'true');
    for(const id of ['parking-yield','parking-taken'])assert.equal(await toggle(id).getAttribute('aria-disabled'),'true');

    const exit=await page.evaluate(()=>{
      const bridge=window.parkingBridge;
      const actor=()=>bridge.capture().objects.find(entry=>entry.object.userData.parkingActor);
      const target=bridge.capture().objects.find(entry=>entry.object.name==='Parking target space').object;
      const bayLitAtStart=target.visible;
      const start=bridge.capture().pose.carPosition.toArray(),before=actor();
      // A direct request into the bridge must also leave the exit route intact.
      bridge.switchInteraction('parking-taken',{camera:'auto',assist:true,playing:true});
      document.querySelector('[data-event=parking-taken]').click();
      bridge.advance(2);
      const {event,parking}=bridge.get({audit:false});
      const after=actor();
      let paint;
      after?.object.traverse(part=>{
        if(part.material?.userData.trafficRole==='paint')paint=part.material.color.toArray();
      });
      return {event,target:parking.target,mode:parking.mode,start,end:bridge.capture().pose.carPosition.toArray(),
        actorVisible:after?.visible,actorStable:before?.position.equals(after.position),paint,
        bayLitAtStart,bayLitDuringExit:target.visible};
    });
    assert.equal(exit.event,null);
    assert.equal(exit.mode,'out');
    assert.equal(exit.bayLitAtStart,false);
    assert.equal(exit.bayLitDuringExit,false);
    assert.deepEqual(exit.target,result.target);
    assert(Math.hypot(exit.start[0]-parkedPose[0],exit.start[2]-parkedPose[1])<.15);
    assert(Math.sign(parkedPose[0])*(exit.start[0]-exit.end[0])>.25,'the vehicle moves forward from the bay into the aisle');
    assert.equal(exit.actorVisible,turnOff);
    assert(turnOff?exit.actorStable&&Math.max(...exit.paint)-Math.min(...exit.paint)<.09:!exit.paint||!exit.actorVisible);
    assert(await page.evaluate(()=>window.arrivalColumns.read()===window.arrivalColumns.value),'columns retain the arrival pose through the return and exit');
    await page.evaluate(()=>window.parkingBridge.advance(10));
    await page.waitForFunction(()=>window.parkingBridge.get({audit:false}).parking.exited&&
      [...document.querySelectorAll('#interaction-settings [data-event]')].every(row=>!row.hasAttribute('aria-disabled')));
    const next=event==='parking-taken'?'parking-yield':'parking-taken';
    await toggle(next).click();
    await page.waitForFunction(id=>window.parkingBridge.get({audit:false}).event?.event===id,next);
    const restarted=await page.evaluate(()=>{
      const bridge=window.parkingBridge;
      bridge.seekRoadworks(0);
      return bridge.capture().pose.carPosition.toArray();
    });
    assert(Math.hypot(restarted[0],restarted[2])<.001,'the next demo returns to its authored aisle origin');
    assert.deepEqual(errors,[]);
  });
}

test('rapid parking switches and timeline gestures settle on the latest interaction',{timeout:240_000},async t=>{
  const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&message.text().includes('THREE.'))errors.push(message.text());});
  const events=['parking-yield','parking-taken'];
  const toggle=id=>page.locator(`[data-event=${id}]`);
  const selected=()=>page.locator('#interaction-settings [role=switch][aria-checked=true]').getAttribute('data-event');
  const applied=id=>page.waitForFunction(id=>(window.parkingBridge.get({audit:false}).event?.event??null)===id,id);
  const clickBurst=ids=>page.evaluate(ids=>{
    for(const id of ids)document.querySelector(`[data-event=${id}]`).click();
  },ids);
  const frame=()=>page.evaluate(()=>{
    const bridge=window.parkingBridge;
    bridge.seekRoadworks(.8);
    const {event,parking}=bridge.get({audit:false});
    return {car:bridge.capture().pose.carPosition.toArray(),actor:event.actor,target:parking.target,
      camera:parking.camera,phase:event.phase,time:event.time};
  });
  const visual=page.locator('canvas.parked-view');
  const parked=page.locator('#scene-properties [data-value=parked]');
  await page.goto(entry.href);
  await page.waitForFunction(()=>{
    window.parkingBridge=document.querySelector('.pro-scene-preview')?.contentWindow?.layoutEngine?.draft;
    return window.parkingBridge?.get({audit:false})?.startup?.ready;
  });

  const baseline={};
  for(const id of events){
    await toggle(id).click();
    await applied(id);
    baseline[id]=await frame();
    await toggle(id).click();
    await applied(null);
  }

  for(const [i,id] of events.entries()){
    const other=events[1-i];
    await toggle(id).click();
    await applied(id);
    await page.evaluate(()=>{
      const bridge=window.parkingBridge,run=bridge.get({audit:false}).event;
      // Leave an unfinished scrub from the previous timeline.
      const range=document.querySelector('#tl-range');
      range.value=Math.floor(50*(run.forwardEnd+run.duration));
      range.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await clickBurst([other,other,id,other]);
    await applied(other);
    assert.equal(await selected(),other);
    assert.deepEqual(await frame(),baseline[other]);
    await page.locator('#tl-range').dispatchEvent('change');
    assert.equal(await page.evaluate(()=>window.parkingBridge.get({audit:false}).requestedPlaying),false);

    await page.evaluate(id=>{
      const bridge=window.parkingBridge,run=bridge.get({audit:false}).event;
      bridge.seekRoadworks(run.duration-.1);bridge.setPlaying(true);bridge.advance(.11);
      // Replace the interaction before the parent processes the arrival.
      document.querySelector(`[data-event=${id}]`).click();
    },id);
    await applied(id);
    assert.deepEqual(await frame(),baseline[id]);
    assert.equal(await parked.getAttribute('aria-checked'),'false');

    await page.evaluate(()=>{
      const bridge=window.parkingBridge,run=bridge.get({audit:false}).event;
      bridge.seekRoadworks(run.duration-.1);bridge.setPlaying(true);bridge.advance(.11);
    });
    await visual.waitFor();
    if(i)await page.waitForFunction(()=>!document.querySelector('[data-value=parked]').hasAttribute('aria-busy'));
    await clickBurst([other,other,other]);
    await applied(other);
    await visual.waitFor({state:'hidden'});
    assert.equal(await parked.getAttribute('aria-checked'),'false');
    assert.deepEqual(await frame(),baseline[other]);
    await toggle(other).click();
    await applied(null);
  }

  let seed=74381, current=null;
  const random=()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/2**32);
  for(let round=0;round<14;round++){
    if(current)await page.evaluate(({fraction,playing})=>{
      const bridge=window.parkingBridge,run=bridge.get({audit:false}).event;
      bridge.seekRoadworks(run.duration*fraction);
      if(playing)bridge.setPlaying(true);
    },{fraction:random(),playing:random()>.5});
    const clicks=Array.from({length:2+Math.floor(4*random())},()=>events[Math.floor(2*random())]);
    for(const id of clicks)current=current===id?null:id;
    await clickBurst(clicks);
    await applied(current);
    const selectedCount=await page.locator('#interaction-settings [role=switch][aria-checked=true]').count();
    assert.equal(selectedCount,Number(!!current));
    if(current){
      assert.equal(await selected(),current);
      assert.deepEqual(await frame(),baseline[current],`burst ${round+1} [${clicks.join(', ')}]`);
    }
  }
  assert.deepEqual(errors,[]);
});

test('reloading Parked holds its dark frame and inspector while the live renderers load', {timeout:120_000}, async t=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  const url=new URL(entry);
  url.searchParams.set('view','parked');
  await page.goto(url.href);
  const canvas=page.locator('canvas.parked-view:not([hidden])');
  await canvas.waitFor();
  await page.locator('#theme').click();
  await page.waitForFunction(()=>history.state?.parkedPreview?.theme==='dark'&&history.state.parkedPreview.poster);

  const inspector=()=>page.evaluate(()=>{
    const controls=document.querySelector('#inspector-scroll');
    return {
      visible:getComputedStyle(controls).visibility==='visible',
      camera:controls.querySelector('[data-param=camera] [aria-checked=true]')?.dataset.value,
      size:document.querySelector('[aria-controls=image-size-options] span').textContent,
      theme:document.documentElement.dataset.theme
    };
  });
  const before=await inspector();
  assert.deepEqual(before,{visible:true,camera:'parked',size:'3840 × 2369',theme:'dark'});

  let releasePrototype, releaseParked;
  const prototypeReady=new Promise(resolve=>{releasePrototype=resolve;});
  const parkedReady=new Promise(resolve=>{releaseParked=resolve;});
  await page.route('**/pro-prototype/prototype.bundle.js?*',async route=>{await prototypeReady;await route.continue();});
  await page.route('**/parked-view.bundle.js?*',async route=>{await parkedReady;await route.continue();});
  try {
    await page.reload({waitUntil:'commit'});
    await page.waitForFunction(()=>{
      const inspector=document.querySelector('#inspector');
      return inspector&&document.documentElement.dataset.theme==='dark'&&getComputedStyle(inspector).visibility==='hidden';
    });
    assert.equal(await page.locator('#inspector-scroll').isVisible(),false,'the static camera controls must not paint');
    assert.equal(await page.locator('#export-section').isVisible(),false,'the static export controls must not paint');
    releasePrototype();
    await page.waitForFunction(()=>document.querySelector('.pro-scene-preview')?.contentWindow?.layoutEngine?.draft
      ?.get({audit:false})?.startup?.ready);
    assert.deepEqual(await inspector(),before,'the first visible inspector has the saved Parked controls');
    assert.equal(await canvas.count(),0,'the parked renderer is still blocked');
    const pending=await page.locator('.artboard-clip').evaluate(clip=>({
      poster:getComputedStyle(clip).backgroundImage.startsWith('url("data:image/jpeg;base64,'),
      live:getComputedStyle(clip.querySelector('.pro-scene-preview')).visibility
    }));
    assert.deepEqual(pending,{poster:true,live:'hidden'});
    releaseParked();
    await canvas.waitFor();
    assert.deepEqual(await inspector(),before);
    assert.equal(await page.locator('.artboard-clip[data-parked-entry]').count(),0);
  } finally {
    releasePrototype();
    releaseParked();
  }
});
