import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {PerspectiveCamera, Vector3} from 'three';
import {browserOptions,configureRenderer} from './browser-renderer.mjs';

const base = process.env.DRIVESCENE_TEST_URL ?? 'http://127.0.0.1:8000';
const evidence = process.env.DRIVESCENE_TEST_EVIDENCE;
const entry = new URL('/studio/ui-draft/pro-prototype.html?plan=pro', base);

test('Pro prototype driving and parking regressions', {timeout: 900_000}, async t => {
 const browser = await chromium.launch(browserOptions());
 t.after(() => browser.close());
 const context = await browser.newContext({viewport: {width: 1280, height: 860}});
 await configureRenderer(context);
 const page = await context.newPage();
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 page.setDefaultTimeout(process.env.CI==='true'?90_000:45_000);

 if (evidence) await mkdir(evidence, {recursive:true});
 async function shot(name) {
  if (!evidence) return;
  await page.screenshot({path:join(evidence,name+'.png'),animations:'disabled'});
 }

 await page.addInitScript(() => {
  const nativeRandom = Crypto.prototype.getRandomValues;
  let seed = 1;
  Crypto.prototype.getRandomValues = function(array) {
   if (array instanceof Uint32Array && array.length === 1) {
    array[0] = window === window.top ? (window.reviewCutInSeed ?? seed++) : (window.top.reviewTrafficSeed ?? Math.imul(seed++, 79271));
    return array;
   }
   return nativeRandom.call(this,array);
  };
  if (window !== window.top) return;
  window.reviewFrame = (withPose = false) => {
   const api = document.querySelector('iframe[title]')?.contentWindow?.layoutEngine;
   const bridge = api?.draft;
   const state = bridge?.get({audit: withPose});
   if (!state?.startup?.ready || !state.ready) return null;
   const cover = !document.querySelector('#frame-cover').hidden;
   const data = {
    state, cover, model:api.get().vehicle,
    phase:document.querySelector('#tl-range')?.getAttribute('aria-valuetext'),
    guide:document.querySelector('#tl-guide')?.textContent,
   };
     if (!withPose) return {...data, lanes:api.get().state.laneCount};
   const frame = bridge.capture(), audit = bridge.audit();
   const zone = frame.objects.find(item => item.visible && item.object.name.startsWith('elevated-roadworks-'));
   const target = frame.objects.find(item => item.object.name === 'lane-change-target');
   const ribbon = frame.objects.find(item => item.object.name === 'version-path');
   return Object.assign(data,{
    ego:frame.pose.carPosition.toArray(), speed:frame.drive.speed, camera:audit.camera,
    center:audit.center, cameraAim:frame.pose.aim.toArray(), cameraRotation:frame.pose.quaternion.toArray(), cameraOffset:frame.pose.offset.toArray(),
    lanes:audit.laneCount, laneVisual:audit.laneVisual,
    zone:zone?.position.toArray(), slot:target?.visible,
    ribbon:{visible:ribbon?.visible??false,brake:ribbon?.object.material.uniforms.roadworksBrake.value??0},
    fleet:audit.traffic?.positions.map((position,i) => ({position,...audit.traffic.lanes[i]})) ?? [],
   });
  };
 });

 const wait = (fn,arg,options={timeout:60_000}) => page.waitForFunction(fn,arg,options);
 const read = () => page.evaluate(() => window.reviewFrame(true));
 const inFrame = (frame, car) => {
  const camera = new PerspectiveCamera(38,16/9,1,2000);
  camera.position.fromArray(frame.camera);
  camera.quaternion.fromArray(frame.cameraRotation);
  camera.setViewOffset(1920,1080,...frame.cameraOffset,1920,1080);
  camera.updateMatrixWorld(true);
  const center = new Vector3(...car.position).add(new Vector3(0,.8,0)).project(camera);
  return Math.abs(center.x)<1 && Math.abs(center.y)<1 && Math.abs(center.z)<1;
 };
 const button = name => page.getByRole('button',{name,exact:true});
 const control = name => page.locator(name).click();
 const eventControl = name => page.locator('[data-event='+name+']');
 const laneControl = n => control('[data-param=lanes] [data-value="'+n+'"]');
 const scope=process.env.DRIVESCENE_TEST_SCOPE;
 const group=Number(process.env.DRIVESCENE_TEST_GROUP||0);
 if(![0,1,2,3,4].includes(group))throw new Error('Unknown browser test group');
 let checkIndex=0;
 const check=(name,run)=>{
  const index=checkIndex++;
  return t.test(name,{skip:!!(scope&&!name.startsWith(scope)||group&&index%4!==group-1)},run);
 };
 const changeScene = async name => {
  await control('[data-scene='+name+']');
  await wait(name => {
   const f = window.reviewFrame();
   return f?.state.scene===name && !f.cover;
  },name);
 };
 const open = async name => {
  const url = new URL(entry);
  url.searchParams.set('scene',name);
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await wait(name => window.reviewFrame()?.state.scene===name,name);
 };
 const event = async name => {
  await eventControl(name).click();
  await wait(name => {
   const f=window.reviewFrame();
   return f && !f.cover && (f.state.event??f.state.roadworks)?.event===name;
  },name);
  return read();
 };
 async function seek(t) {
  const range=page.locator('#tl-range');
  const local=await range.evaluate((el,time) => {
   el.value=Number.isFinite(time)?Math.round(time*100):el.max;
   el.dispatchEvent(new Event('input',{bubbles:true}));
   return Number(el.value)/100;
  },t);
  await wait(time => {
   const f=window.reviewFrame(), run=f?.state.event??f?.state.roadworks;
   return run && !f.state.requestedPlaying && Math.abs(run.time-(run.eventStart??0)-time)<.02;
  },local);
  return read();
 }

 await check('Theme keeps the scene live and restores dark before the engine mounts', async () => {
  await open('road');
  await wait(() => window.reviewFrame()?.state.playing && !window.reviewFrame().cover);
  await page.evaluate(() => {
   const bridge = document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
   const releaseBlend = bridge.startThemeBlend.bind(bridge);
   bridge.startThemeBlend = () => {
    window.reviewBlendStart = performance.now();
    releaseBlend();
   };
   const setTheme = bridge.theme.bind(bridge);
   const hold = new Promise(resolve => { window.releaseReviewTheme = resolve; });
   bridge.theme = async (...args) => {
    if (!args[1]?.deferBlend) return setTheme(...args);
    window.reviewThemePending = true;
    await hold;
    await setTheme(...args);
   };
   const start = document.startViewTransition.bind(document);
   document.startViewTransition = update => {
    const layer = getComputedStyle(document.querySelector('.artboard-clip')).viewTransitionName;
    window.reviewSceneThemeAtCapture = bridge.themeStatus().blending;
    window.reviewEngineToneAtCapture = document.querySelector('iframe[title]').contentWindow.layoutEngine.get().mode;
    window.reviewBlendAtCapture = window.reviewBlendStart;
    const transition = start(update);
    void transition.ready.then(() => { window.reviewThemeLayer = layer; }, () => {});
    return transition;
   };
  });
  await control('#theme');
  try {
   await page.waitForFunction(() => window.reviewThemePending, null, {timeout:12000});
   assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
   const initial = await page.evaluate(() => window.reviewFrame().state.distance);
   await wait(distance => window.reviewFrame()?.state.distance > distance,initial);
  } finally {
   await page.evaluate(() => window.releaseReviewTheme());
  }
  await wait(() => document.querySelector('iframe[title]').contentWindow.layoutEngine.get().mode === 'dark');
  await wait(() => window.reviewThemeLayer === 'live-scene' && document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => window.reviewSceneThemeAtCapture),false);
  assert.equal(await page.evaluate(() => window.reviewEngineToneAtCapture),'light');
  assert.ok(await page.evaluate(() => window.reviewBlendAtCapture === undefined && Number.isFinite(window.reviewBlendStart)),
   'the shell commit must release the prepared scene after snapshot capture');
  let initialTheme;
  await page.route('**/pro-prototype/prototype.bundle.js?*',async route => {
   initialTheme = await page.locator('html').getAttribute('data-theme');
   await route.continue();
  });
  await page.reload({waitUntil:'domcontentloaded'});
  await page.unroute('**/pro-prototype/prototype.bundle.js?*');
  assert.equal(initialTheme,'dark');
  await wait(() => window.reviewFrame() && document.querySelector('iframe[title]').contentWindow.layoutEngine.get().mode === 'dark', null, {timeout:120_000});
  assert.equal(await page.locator('#theme').getAttribute('aria-label'),'Switch to light theme');
  await control('#theme');
  await wait(() => document.querySelector('iframe[title]').contentWindow.layoutEngine.get().mode === 'light');
 });

 await check('Vehicle menu applies all four models and survives a scene switch in flight', async () => {
  await open('road');
  const card = page.locator('.shell-vehicle-card');
  const model = id => wait(id => window.reviewFrame()?.model===id,id);
  for (const [id,name] of [['x6','BMW X6'],['ix','BMW iX'],['xc90','Volvo XC90'],['model-3','Tesla Model 3']]) {
   await card.click();
   await page.getByRole('menuitemradio',{name,exact:true}).click();
   await model(id);
   await card.getByText(name,{exact:true}).waitFor();
   if (id==='ix') {
    await button('Elevated').click();
    await wait(() => window.reviewFrame()?.state.scene==='elevated');
    await button('Road').click();
    await wait(() => {
     const f=window.reviewFrame();
     return f?.state.scene==='road' && !f.cover;
    });
    await model(id);
   }
  }
  await card.focus();
  await page.keyboard.press('ArrowDown');
  const menu=page.getByRole('menu',{name:'Vehicle'});
  await menu.waitFor();
  await shot('vehicle-menu');
  await page.keyboard.press('Escape');
  assert.equal(await card.getAttribute('aria-expanded'),'false');
  assert.ok(await card.evaluate(el => document.activeElement===el));
 });

 await check('Road moves with Assist off, and Cut-in follows the lane and handoff', async () => {
  await open('road');
  const initial=(await read()).state.distance;
  await wait(distance => window.reviewFrame()?.state.distance>distance+3,initial);
  assert.equal((await read()).state.features.path,false);
  await laneControl(2);
  await wait(()=>window.reviewFrame()?.lanes===2);
  assert.equal(await eventControl('cutin').getAttribute('aria-disabled'),'true');
  await laneControl(4);
  await wait(()=>window.reviewFrame()?.lanes===4);
  let {state}=await event('lanechange');
  await wait(() => Number.isFinite(window.reviewFrame()?.state.roadworks?.laneChange?.settledAt));
  state=(await read()).state;
  const lane=state.roadworks;
  const before=await seek(lane.handoff+lane.laneChange.settledAt-.06);
  assert.ok(before.slot);
  const queued=await event('cutin');
  const handoff=queued.state.roadworks.handoff;
  assert.ok(queued.slot && handoff>=1);
  assert.ok(Math.abs(queued.ego[0]-before.ego[0])<.08);
  const cutin=await seek(handoff+.05);
  assert.ok(!cutin.slot);
  await laneControl(6);
  await wait(() => window.reviewFrame()?.lanes===6);
  const run=(await seek(handoff+4.25)).state.roadworks;
  assert.ok(Number.isFinite(run.cutInTiming?.merge));
  await control('[data-weather=rain]');
  await control('[data-weather=snow]');
  await control('[data-weather=default]');
 });

 await check('Cancel Cut-in during braking and restore the Driving assist ribbon', async () => {
  for (const assist of [false,true]) {
   await open('road');
   if (assist) {
    await control('#scene-transport');
    await wait(() => window.reviewFrame(true)?.ribbon.visible);
   }
   const started = await event('cutin');
   const {handoff,cutInTiming} = started.state.roadworks;
   assert.ok(Number.isFinite(cutInTiming.impactAt));
   await wait(() => window.reviewFrame(true)?.state.path?.reveal === 1);
   const paused = await seek(handoff+cutInTiming.impactAt+.4);
   assert.equal(paused.state.requestedPlaying,false);
   assert.ok(paused.ribbon.visible && paused.ribbon.brake>0);
   await eventControl('cutin').click();
   await wait(() => {
    const frame = window.reviewFrame();
    return frame?.state.requestedPlaying && !frame.state.roadworks &&
     document.querySelector('#event-timeline').getAttribute('aria-hidden')==='true';
   });
   const cancelled = await read();
   assert.equal(await eventControl('cutin').getAttribute('aria-checked'),'false');
   assert.equal(await page.locator('#scene-transport').getAttribute('aria-checked'),String(assist));
   assert.equal(cancelled.ribbon.visible,assist,'visible ribbon must match the Driving assist switch');
   assert.equal(cancelled.ribbon.brake,0,'no braking marks after cancellation');
   assert.ok(cancelled.fleet.every(car=>!car.feedback),'no event highlighting after cancellation');
   await wait(distance => window.reviewFrame()?.state.distance>distance+5,cancelled.state.distance);
   const cruising = await read();
   assert.equal(cruising.ribbon.visible,assist);
   assert.equal(cruising.ribbon.brake,0);
  }
 });

 await check('Road Cut-in expands and collapses the Driving assist bar', async () => {
  await open('road');
  await wait(() => !window.reviewFrame()?.cover);
  await page.evaluate(() => {
   const playback = document.querySelector('#canvas-playback');
   const surface = playback.querySelector('.playback-surface');
   const leading = playback.querySelector('.playback-leading');
   window.reviewPlaybackMotion = [];
   document.addEventListener('click', e => {
    if (!e.target.closest('[data-event=cutin]')) return;
    const animations = playback.getAnimations({subtree:true});
    window.reviewPlaybackMotion.push({
     mode:playback.dataset.mode,
     plate:animations.some(a => a.transitionProperty === 'clip-path' && a.effect.target === surface),
     wheel:animations.some(a => a.transitionProperty === 'transform' && a.effect.target === leading),
    });
   });
  });
  await event('cutin');
  await page.locator('#canvas-playback').evaluate(el =>
   Promise.allSettled(el.getAnimations({subtree:true}).map(animation => animation.finished)));
  await eventControl('cutin').click();
  assert.deepEqual(await page.evaluate(() => window.reviewPlaybackMotion),[
   {mode:'timeline',plate:true,wheel:true},
   {mode:'assist',plate:true,wheel:true},
  ]);
 });

 await check('Road keeps its approach speed and recovers after cancelling Cut-in', async () => {
  await open('road');
  await wait(() => {
   const frame = window.reviewFrame();
   return frame?.state.playing && !frame.cover && frame.state.distance > 1;
  });
  const cruise = await read();
  assert.ok(Number.isFinite(cruise.speed));
  await event('cutin');
  const {cutInTiming, handoff} = (await seek(0)).state.roadworks;
  const approach = await seek(handoff + (cutInTiming.merge + cutInTiming.impactAt) / 2);
  assert.match(approach.phase, /, Approach$/);
  assert.ok(Math.abs(approach.speed - cruise.speed) < .02, 'switching on must keep the cruise pace until the cut-in poses a conflict');
  const braking = await seek(handoff + cutInTiming.impactAt + 1.5);
  assert.ok(braking.speed < cruise.speed - .5);
  await eventControl('cutin').click();
  await wait(() => {
   const frame = window.reviewFrame();
   return frame && !frame.state.roadworks?.event && frame.state.playing;
  });
  const first = await read();
  assert.ok(Math.abs(first.speed - braking.speed) < .4, 'cancelling must preserve speed at the transition');
  await wait(speed => window.reviewFrame(true)?.speed >= speed - .08, cruise.speed);
  const recovered = await read();
  assert.ok(Math.abs(recovered.speed - cruise.speed) < .1);
  assert.equal(recovered.fleet.length, 0);
 });

 await check('Lane change renders Traffic after cancelling Cut-in and keeps existing cars', async () => {
  const nearby = frame => frame.fleet.filter(car => car.alpha > .9 &&
   car.position[2] < frame.ego[2] - 8 && car.position[2] > frame.ego[2] - 85);
  const traffic = page.locator('[data-layer=traffic]');
  await open('road');
  await event('cutin');
  const {cutInTiming, handoff} = (await seek(0)).state.roadworks;
  await seek(handoff + Math.max(cutInTiming.inLane + .03, cutInTiming.impactAt + 1.5));
  await eventControl('cutin').click();
  await wait(() => {
   const frame = window.reviewFrame(true);
   return frame && !frame.state.roadworks?.event && frame.fleet.length === 0;
  });
  // Cruise may accelerate between the automation request and a slow renderer's
  // next click. Compare the first replay frame to the actual activation frame.
  await eventControl('lanechange').evaluate(el=>el.addEventListener('click',()=>{
   window.laneChangeEntrySpeed=window.reviewFrame(true).speed;
  },{capture:true,once:true}));
  await event('lanechange');
  const start = await seek(0);
  const entrySpeed=await page.evaluate(()=>window.laneChangeEntrySpeed);
  assert.ok(Math.abs(start.speed-entrySpeed)<.25);
  assert.equal(await traffic.getAttribute('aria-pressed'), 'true');
  assert.equal(await traffic.isDisabled(), true);
  for (const time of [1.4, 4.8, 9]) {
   const frame = await seek(time);
   assert.ok(nearby(frame).length, 'the Traffic switch must render other cars ahead at ' + time + ' seconds');
   if (time === 4.8) await shot('lane-change-traffic');
  }
  await eventControl('lanechange').click();
  await wait(() => window.reviewFrame()?.state.roadworks?.event == null);
  assert.equal(await traffic.getAttribute('aria-pressed'), 'false');
  assert.equal((await read()).fleet.length, 0);

  await traffic.click();
  await wait(() => window.reviewFrame(true)?.fleet.length >= 2);
  const existing = (await read()).fleet.map(car => car.id);
  await event('lanechange');
  const atStart = await seek(0);
  assert.ok(atStart.fleet.some(car => existing.includes(car.id)), 'retain traffic already present before Lane change');
  await eventControl('lanechange').click();
  await wait(() => window.reviewFrame()?.state.roadworks?.event == null);
  assert.equal(await traffic.getAttribute('aria-pressed'), 'true');
 });

 await check('Road timeline seeks before resuming playback', async () => {
  await open('road');
  await event('lanechange');
  const range = page.locator('#tl-range');
  await range.press('End');
  await wait(() => {
   const {state} = window.reviewFrame();
   return !state.requestedPlaying && state.roadworks.time === state.roadworks.duration;
  });
  await range.press('Home');
  await wait(() => {
   const {time, eventStart} = window.reviewFrame().state.roadworks;
   return time === eventStart && !window.reviewFrame().state.requestedPlaying;
  });
  await control('#tl-play');
  await wait(() => window.reviewFrame()?.state.playing);
  const {x,y,width,height} = await range.boundingBox();
  await page.mouse.click(x + width * .3, y + height / 2);
  await wait(() => {
   const {state} = window.reviewFrame();
   return state.requestedPlaying && state.roadworks.time - state.roadworks.eventStart >= 4;
  });
  await range.evaluate(el => {
   el.value = '1320';
   el.dispatchEvent(new Event('input', {bubbles:true}));
   el.dispatchEvent(new Event('change', {bubbles:true}));
  });
  await page.waitForFunction(() => {
   const {state} = window.reviewFrame();
   return state.requestedPlaying && state.roadworks.time - state.roadworks.eventStart >= 13.2;
  }, null, {timeout:2500});
 });

 await check('Road event timeline keeps real time across slow render frames', async () => {
  await open('road');
  await event('cutin');
  await seek(.25);
  await control('#tl-play');
  await wait(() => window.reviewFrame()?.state.playing);
  const rate = await page.evaluate(() => new Promise(resolve => {
   const frame = document.querySelector('iframe[title]').contentWindow;
   const time = () => window.reviewFrame().state.roadworks.time;
   // RAF timestamps share the playback clock and exclude the trailing GPU draw.
   let start, origin;
   // Deliver delayed frames without pausing the page or restarting the route.
   function slowFrame(now) {
    // Resuming starts with a zero-delta frame; measure only after that frame.
    if(start===undefined){start=now;origin=time();}
    if (now - start >= 1800) return resolve((time() - origin) * 1000 / (now - start));
    const end = performance.now() + 170;
    while (performance.now() < end) {}
    frame.requestAnimationFrame(slowFrame);
   }
   frame.requestAnimationFrame(slowFrame);
  }));
  assert.ok(rate >= .8 && rate <= 1.2, 'simulated seconds per wall-clock second: ' + rate);
 });

 await check('Active Road lanes morph in the same frame and preserve a paused replay', async () => {
  await open('road');
  await event('cutin');
  const before=await seek(3.25);
  await page.evaluate(() => {
   const frame = document.querySelector('iframe[title]');
   const cover = document.querySelector('#frame-cover');
   const blank = () => !cover.hidden || frame !== document.querySelector('iframe[title]');
   window.laneSwitchFrames = [];
   const sample = () => {
    if (!window.laneSwitchFrames) return;
    const current=window.reviewFrame();
    window.laneSwitchFrames.push({blank:blank(),ready:Boolean(current),time:current?.state.roadworks?.time});
    requestAnimationFrame(sample);
   };
   requestAnimationFrame(sample);
  });
  for(const lanes of [4,6,4]){
   await laneControl(lanes);
   await wait(n => {
    const frame=window.reviewFrame(true);
    return frame?.lanes===n && frame.laneVisual.blend<.98;
   },lanes);
   await wait(n => {
    const frame=window.reviewFrame(true);
    return frame?.lanes===n && !frame.laneVisual.transition;
   },lanes);
   const after=await read();
   assert.equal(after.state.roadworks.time,before.state.roadworks.time);
   assert.equal(after.state.requestedPlaying,false);
   assert.equal(after.state.roadworks.cutInTiming.actorId,before.state.roadworks.cutInTiming.actorId);
   assert.ok(Math.abs(after.camera[1]-before.camera[1])<.06);
  }
  await page.locator('[data-param=lanes]').evaluate(el=>{
   for(const value of ['6','4','2'])el.querySelector('[data-value="'+value+'"]').click();
  });
  await wait(() => {
   const frame=window.reviewFrame(true);
   return frame?.lanes===2 && !frame.laneVisual.transition;
  });
  assert.equal(await eventControl('cutin').getAttribute('aria-disabled'),'true');
  const samples=await page.evaluate(()=>{
   const frames=window.laneSwitchFrames;
   window.laneSwitchFrames=null;
   return frames;
  });
  assert.ok(samples.length>10);
  assert.ok(samples.every(frame=>frame.ready&&!frame.blank));
  await shot('road-two-lanes');
 });

 async function checkRoadworks() {
  await open('elevated');
  await control('[data-layer=traffic]');
  await wait(() => window.reviewFrame(true)?.fleet.length>=3);
  await page.waitForFunction(() => window.reviewFrame()?.state.distance>=105,null,{timeout:process.env.CI==='true'?180000:60000});
  for (const side of ['left','right']) {
   if (side==='left') await event('roadworks');
   else {
    await control('[data-key=side] [data-value=right]');
    await wait(() => window.reviewFrame()?.state.roadworks?.options?.side==='right');
   }
   const start=await seek(0);
   const timing=start.state.roadworks.workZoneTiming;
   const approach=await seek(Math.max(0,timing.brakeAt+1));
   const coneGap=approach.ego[2]-approach.zone[2]+10;
   assert.ok(coneGap>32,JSON.stringify({side,coneGap,timing}));
   assert.ok(Math.abs(approach.camera[1]-17)<.1,JSON.stringify({side,coneGap,camera:approach.camera,start:start.camera}));
   assert.ok(timing.clearAt>timing.passAt&&timing.passAt>timing.mergeAt,JSON.stringify(timing));
   assert.ok(timing.endAt-timing.clearAt>=2.45,JSON.stringify(timing));
   const pre=await seek(timing.clearAt-.15);
   assert.doesNotMatch(pre.phase,/Resume/);
   const cleared=await seek(timing.clearAt+.15);
   assert.match(cleared.phase,/Resume/);
   for (const index of [0,1,2,3,4,5,6,7,8,9,10,11,12]) {
    const sample=await seek(timing.clearAt*index/12);
    for(const car of sample.fleet.filter(car=>car.direction<0&&(car.alpha??1)>.8)) {
     const along=sample.zone[2]-car.position[2]-10;
     if(along < -3 || along > 69) continue;
     const x=(car.position[0]-sample.zone[0])*(side==='right'?-1:1);
     const edge=5.23-6.76*Math.min(1,Math.max(0,(along+2.6)/50.6));
     assert.ok(x+1.1<edge,`${side} at ${index}: ${car.id} x ${x}, edge ${edge}`);
    }
   }
   await page.locator('#tl-range').press('End');
   const end=await seek(Infinity);
   assert.match(end.guide,/End/);
   assert.ok(end.zone[2]-68.6-end.ego[2]>20);
   // The world is rebased around ego during live playback. Measure travel
   // against the same stationary construction group in both frames.
   assert.ok(end.zone[2]-end.ego[2] > cleared.zone[2]-cleared.ego[2]+20);
   await shot('roadworks-'+side+'-end');
  }
 }
 await check('Roadworks clears both sides before Resume and keeps moving to End',checkRoadworks);

 await check('Roadworks Auto rises once with Traffic during a live run and replay',async()=>{
  // This replay seed adds a vehicle that merges ahead before the cones come into view.
  await page.addInitScript(() => {
   if (window === window.top && new URL(location.href).searchParams.has('camera-replay-seed')) window.reviewTrafficSeed = 2;
  });
  const url=new URL(entry);
  url.searchParams.set('scene','elevated');
  url.searchParams.set('camera-replay-seed','1');
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await wait(()=>window.reviewFrame()?.state.scene==='elevated');
  const traffic=page.locator('[data-layer=traffic]');
  if (await traffic.getAttribute('aria-pressed')!=='true') await traffic.click();
  await wait(()=>window.reviewFrame(true)?.fleet.length>=3);
  await event('roadworks');
  await control('[data-key=side] [data-value=right]');
  await wait(()=>window.reviewFrame()?.state.roadworks?.options.side==='right');

  async function checkCamera(name) {
   const frames=await page.evaluate(()=>{
    const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
    const {eventStart=0,duration}=bridge.get({audit:false}).roadworks;
    const sample=time=>{
     bridge.seekRoadworks(eventStart+time);
     return {time,height:bridge.audit().camera[1]};
    };
    const frames=[];
    for (let step=0;step/5<duration-eventStart;step++) frames.push(sample(step/5));
    frames.push(sample(duration-eventStart));
    return frames;
   });
   const peak=Math.max(...frames.map(frame=>frame.height));
   const peakIndex=frames.findIndex(frame=>frame.height>=peak-.04);
   assert.ok(peak-frames[0].height>10,`${name} reaches High`);
   assert.ok(Math.abs(frames.at(-1).height-frames[0].height)<.04,`${name} returns to Low`);
   for (let i=1;i<frames.length;i++) {
    const delta=frames[i].height-frames[i-1].height;
    assert.ok((i<=peakIndex?delta:-delta)>=-.04,`${name}: unexpected camera change at ${frames[i].time.toFixed(1)}s (${delta.toFixed(2)}m)`);
   }
  }

  await checkCamera('live');
  await page.locator('#tl-range').evaluate(el=>{
   el.value=el.max;
   el.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await wait(()=>document.querySelector('#tl-play')?.getAttribute('aria-label')==='Replay');
  await control('#tl-play');
  await wait(()=>{
   const state=window.reviewFrame()?.state;
   return state?.requestedPlaying && state.roadworks?.eventStart===0;
  });
  await checkCamera('replay');
 });

 await check('Roadworks clears its resource error after retry on a phone across a theme change',async mobileTest=>{
  const context=await browser.newContext({viewport:{width:390,height:845},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  mobileTest.after(()=>context.close());
  await configureRenderer(context);
  const page=await context.newPage();
  let blocked=0;
  const asset='**/traffic-model-y.prepared.bin.gz*';
  await page.route(asset,route=>{blocked++;return route.abort();});
  const url=new URL(entry);url.searchParams.set('scene','elevated');
  await page.goto(url.href);
  await page.waitForFunction(()=>{
   const bridge=document.querySelector('iframe[title]')?.contentWindow?.layoutEngine?.draft;
   return bridge?.get({audit:false}).startup?.ready&&document.querySelector('#frame-cover').hidden;
  });
  const event=page.locator('[data-event=roadworks]');
  const traffic=page.locator('[data-layer=traffic]');
  await event.click();
  const feedback=page.locator('#feedback');
  await feedback.waitFor();
  assert.ok(blocked>0);
  assert.equal(await event.getAttribute('aria-checked'),'false');
  assert.equal(await traffic.getAttribute('aria-pressed'),'false');

  await page.unroute(asset);
  await page.locator('#theme').click();
  await event.click();
  await page.waitForFunction(()=>{
   const api=document.querySelector('iframe[title]')?.contentWindow?.layoutEngine;
   return api?.get().mode==='dark' && api.draft.get({audit:false}).roadworks?.event==='roadworks';
  });
  assert.equal(await event.getAttribute('aria-checked'),'true');
  assert.equal(await traffic.getAttribute('aria-pressed'),'false');
  assert.equal(await feedback.isVisible(),false,'the failed attempt must not leave an error on a successful preview');
 });

 await check('Roadworks keeps repeated runs inside the fixed carriageway',async()=>{
  await open('elevated');
  const side=name=>page.locator('[data-key=side] [data-value='+name+']');
  const pass=async name=>{
   await event('roadworks');
   await side(name).click();
   for(const time of [0,2.8,4.6,7.5,14.4]){
    const frame=await seek(time);
    assert.ok(Math.abs(frame.ego[0])+1.1 < 5.55,JSON.stringify({time,name,ego:frame.ego,zone:frame.zone}));
    assert.ok(Math.abs(frame.zone[0])<.01,'work zone must stay on the original middle lane');
   }
   await eventControl('roadworks').click();
   await wait(()=>!window.reviewFrame()?.state.event);
  };
  for(const name of ['left','left','right','right','left'])await pass(name);
  assert.ok(await side('left').isDisabled());
  assert.ok(await side('right').isDisabled());
 });

 await check('Roadworks cuts between pass sides at the current frame',async()=>{
  await open('elevated');
  await event('roadworks');
  const choose=side=>control('[data-key=side] [data-value='+side+']');
  const start=await seek(0), timing=start.state.roadworks.workZoneTiming;
  const time=(timing.passAt+timing.clearAt)/2;
  const left=await seek(time);
  await choose('right');
  const right=await read();
  assert.equal(right.state.roadworks.options.side,'right');
  assert.equal(right.state.roadworks.time,left.state.roadworks.time);
  assert.equal(right.state.requestedPlaying,false);
  assert.equal(right.state.cameraHandoff,false);
  assert.equal(right.cover,false);
  assert.ok(Math.abs(left.ego[0]-right.ego[0])>5);
  assert.ok(Math.abs(left.ego[0]+right.ego[0]-2*left.zone[0])<.001);
  await choose('left');
  const returned=await read();
  assert.deepEqual(returned.ego,left.ego);
  assert.deepEqual(returned.camera,left.camera);
  // Sample during the side change, before the next renderer frame can
  // advance the wall-clock playback all the way to End in software rendering.
  await page.evaluate(()=>{
   const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
   const switchSide=bridge.cutRoadworksSide;
   bridge.cutRoadworksSide=side=>{
    bridge.cutRoadworksSide=switchSide;
    const before=bridge.get({audit:false});
    switchSide(side);
    window.roadworksSideCut={before,after:bridge.get({audit:false})};
   };
   document.querySelector('#tl-play').click();
   document.querySelector('[data-key=side] [data-value=right]').click();
  });
  const cut=await (await wait(()=>window.roadworksSideCut)).jsonValue();
  assert.equal(cut.before.requestedPlaying,true);
  assert.equal(cut.after.roadworks.options.side,'right');
  assert.equal(cut.after.roadworks.time,cut.before.roadworks.time);
  assert.equal(cut.after.requestedPlaying,true);
  assert.equal(cut.after.cameraHandoff,false);
 });

 await check('Road Cut-in replays only merges that slow ego', async () => {
  await open('road');
  await control('[data-layer=traffic]');
  await wait(()=>window.reviewFrame(true)?.fleet.length>=2);
  await event('cutin');
  let checkedAmber=false;
  for(let attempt=0;attempt<4;attempt++){
   const started=await seek(.25), run=started.state.roadworks;
   const timing=run.cutInTiming;
   assert.ok(timing.impactAt<timing.inLane,'the Cut-in switch must produce a maneuver that requires slowing');
   const approach=await seek(run.handoff+(timing.merge+timing.impactAt)/2);
   assert.match(approach.phase,/, Approach$/);
   const response=await seek(run.handoff+timing.impactAt+1.25);
   assert.ok(response.speed<approach.speed-.1,JSON.stringify({response:response.speed,approach:approach.speed,timing}));
   const respondingCar=response.fleet.find(car=>car.id===timing.actorId);
   assert.match(respondingCar?.feedback??'',/^(yellow|red)$/);
   const mid=await seek(run.handoff+timing.halfIn);
   const after=await seek(run.handoff+timing.inLane+.03);
   const movingCar=mid.fleet.find(car=>car.id===timing.actorId);
   const inLane=after.fleet.find(car=>car.id===timing.actorId);
   assert.ok(movingCar&&inLane,JSON.stringify({timing,traffic:mid.fleet.map(car=>car.id)}));
   assert.ok(Math.abs(movingCar.position[0]-mid.ego[0])>1.3);
   assert.ok(Math.abs(inLane.position[0]-after.ego[0])<.15);
   const gap=after.ego[2]-inLane.position[2];
   assert.ok(gap>6&&gap<49,JSON.stringify({gap,timing}));
   const amberIndex=timing.phases.findIndex(({phase})=>phase==='cut-in');
   if(amberIndex>=0){
    const amberAt=timing.phases[amberIndex].at;
    const amberEnd=timing.phases[amberIndex+1]?.at ?? timing.inLane;
    const amber=await seek(run.handoff+(amberAt+amberEnd)/2);
    assert.match(amber.phase,/, Cut-in$/);
    assert.equal(amber.fleet.find(car=>car.id===timing.actorId)?.feedback,'yellow');
    if(!checkedAmber){
     const before = await seek(run.handoff+timing.impactAt-.02);
     const afterImpact = await seek(run.handoff+timing.impactAt+.02);
     assert.ok(Math.abs(afterImpact.state.path.length-before.state.path.length)<1.5,'the rendered ribbon retracts continuously');
     const following = await seek(run.handoff+timing.inLane+.3);
     const leader = following.fleet.find(car=>car.id===timing.actorId);
     const [,endZ] = following.state.path.end;
     assert.ok(endZ-leader.position[2]>4,'the rendered ribbon ends before the leader’s rear');
     const repeat = await seek(run.handoff+timing.impactAt-.02);
     assert.ok(Math.abs(repeat.state.path.length-before.state.path.length)<.02,'backward seeking restores the ribbon length');
     const raised=await seek(run.handoff+timing.cameraRiseAt+1.5);
     const low=await seek(run.handoff+timing.cameraReturnAt+1.4);
     assert.ok(raised.camera[1]-started.camera[1]>8);
     assert.ok(Math.abs(low.camera[1]-started.camera[1])<.15);
     await seek(run.handoff+(amberAt+amberEnd)/2);
     await shot('road-cut-in');
    }
    checkedAmber=true;
   }
   if(attempt===3)break;
   await seek(Infinity);
   await control('#tl-play');
   await wait(()=>window.reviewFrame()?.state.roadworks?.time<1&&window.reviewFrame().state.requestedPlaying);
  }
  assert.ok(checkedAmber);
 });

 await check('Ramp Entrance and Exit keep distinct rules when switched mid-run', async () => {
  await open('ramp');
  await event('cutin');
  const exit=await seek(.25);
  const {handoff,cutInTiming}=exit.state.roadworks;
  assert.ok(cutInTiming.impactAt<cutInTiming.inLane);
  const yielding=await seek(handoff+cutInTiming.impactAt+1.25);
  assert.ok(yielding.speed<exit.speed);
  await control('[data-key=ramp-type] [data-value="07"]');
  await wait(() => !!window.reviewFrame()?.state.roadworks?.rampMerge);
  const entrance=await seek(2);
  assert.match(entrance.phase,/Approach|Yield|Accelerate|Wait|Merge/);
  await control('[data-key=ramp-type] [data-value="06"]');
  await wait(() => !!window.reviewFrame()?.state.roadworks?.cutInTiming && !window.reviewFrame()?.state.roadworks?.rampMerge);
 });

 await check('Ramp Entrance moves and stays centered under previously blocked arrivals', async () => {
  const url = new URL(entry);
  url.searchParams.set('scene','ramp');
  url.searchParams.set('type','merge');
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await wait(()=>window.reviewFrame()?.state.scene==='ramp'&&!window.reviewFrame().cover);
  for (const seed of [3,14,24]) {
   await page.evaluate(seed=>window.reviewCutInSeed=seed,seed);
   await event('cutin');
   const alongside = await seek(4);
   if (seed===3) assert.notEqual(alongside.fleet.find(car=>car.id==='merge-priority')?.feedback,'yellow');
   const moving = await seek(7.1), end = await seek(Infinity);
   assert.ok(moving.speed>5 && end.state.distance>moving.state.distance+30);
   for (const frame of [alongside,moving,end]) assert.ok(Math.abs(frame.center.x-.5)<.001);
   assert.equal(end.state.roadworks.time,15);
   await eventControl('cutin').click();
   await wait(()=>!window.reviewFrame()?.state.roadworks?.event);
  }
 });

 await check('Driving scene switches reveal live frames immediately after preparation', async () => {
  await open('road');
  for(const scene of ['elevated','ramp','junction','road']){
   await page.evaluate(()=>{
    window.completedSceneReveal=null;
    const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
    const original=bridge.scene;
    bridge.scene=async function(...args){
     try{return await original.apply(this,args)}
     finally{bridge.scene=original;requestAnimationFrame(()=>{window.completedSceneReveal={cover:!document.querySelector('#frame-cover').hidden,frames:bridge.themeStatus().renderedFrames};});}
    };
   });
   await changeScene(scene);
   await wait(()=>window.completedSceneReveal!==null);
   const completed=await page.evaluate(()=>window.completedSceneReveal);
   assert.equal(completed.cover,false,'a frozen old ego must not fade over the live scene');
   await wait(frames=>document.querySelector('iframe[title]').contentWindow.layoutEngine.draft.themeStatus().renderedFrames>frames+2,completed.frames);
  }
 });

 await check('The latest scene owns the canvas after a superseded scene commits', async () => {
  await open('road');
  await page.evaluate(() => {
   const bridge = document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
   const scene = bridge.scene.bind(bridge);
   bridge.scene = async (target, ...options) => {
    if (target !== 'elevated') return scene(target, ...options);
    await scene(target, ...options);
    await new Promise(resolve => { window.releaseElevated = resolve; });
   };
  });
  await control('[data-scene=elevated]');
  await wait(() => typeof window.releaseElevated === 'function');
  try { await control('[data-scene=road]'); }
  finally { await page.evaluate(() => window.releaseElevated()); }
  await wait(() => window.reviewFrame()?.state.scene === 'road' && !window.reviewFrame().cover);
  assert.equal(await page.locator('[data-scene=road]').getAttribute('aria-current'),'page');
 });

 await check('Junction accelerates through the exit and uses the Road cruise lookahead', async () => {
  await open('road');
  await wait(()=>window.reviewFrame(true)?.state.path?.length>55);
  const roadReach=(await read()).state.path.length;
  if(scope||group) await open('junction');
  else await changeScene('junction');
  const before=await read(), started=await event('leftturn');
  assert.equal(started.state.cameraHandoff,false);
  assert.equal(started.cover,false);
  assert.deepEqual(started.state.raster,before.state.raster);
  const stopped=await seek(3.6);
  assert.equal(stopped.state.junction.speed,0);
  const {duration,timing}=stopped.state.event;
  assert.ok(Number.isFinite(timing.turnAt));
  assert.equal(Number(await page.locator('#tl-range').getAttribute('max')),duration*100);
  const launching=await seek(timing.turnAt+.5);
  assert.ok(launching.state.junction.speed*3.6>0&&launching.state.junction.speed*3.6<22);
  let lastSpeed=22;
  for(const offset of [-.5,-.15,0,.15,.5]){
   const {state}=await seek(Math.ceil(timing.clearAt*100)/100+offset);
   const speed=state.junction.speed*3.6;
   assert.ok(speed>lastSpeed+1,'speed continues to rise across the curve exit');
   lastSpeed=speed;
  }
  const accelerating=(await seek(timing.clearAt+1.5)).state.junction.speed*3.6;
  assert.ok(accelerating>22&&accelerating<80);
  const sample=await seek(duration-.9);
  assert.equal(sample.state.junction.speed*3.6,80);
  assert.match(sample.guide,/Resume/);
  assert.ok(Math.abs(sample.state.path.length-roadReach)<.01,JSON.stringify(sample.state.path));
  const distant=await page.evaluate(()=>{
   const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
   const {buildingsPlaced,treePlacements}=bridge.audit(), ego=bridge.capture().pose.carPosition;
   return [buildingsPlaced,treePlacements].map(placements=>[-1,1].map(side=>placements
    .filter(p=>p.x<ego.x-90&&p.x>ego.x-280&&Math.sign(p.z+40)===side&&Math.abs(p.z+40)<38)
    .map(p=>p.x).sort((a,b)=>b-a)));
  });
  assert.ok(distant.flat().every(side=>side.length>=2),JSON.stringify(distant));
  assert.ok(distant[0].every(side=>side[0]-side.at(-1)>=45),JSON.stringify(distant[0]));
  await shot('junction-cruise');
  await control('#tl-play');
  await wait(() => {
   const frame=window.reviewFrame(), run=frame?.state.event;
   return run && run.time===run.duration && !frame.state.requestedPlaying;
  });
  await open('junction');
  const engineFrame=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
  const coldEntry=new URL(engineFrame.url());
  coldEntry.searchParams.set('scene-preview','1');
  coldEntry.searchParams.set('interaction','leftturn');
  coldEntry.searchParams.set('traffic','0');
  await engineFrame.goto(coldEntry.href);
  await engineFrame.waitForFunction(()=>{
   const state=window.layoutEngine?.draft?.get({audit:false});
   return state?.startup?.ready&&state.event?.event==='leftturn';
  });
  const coldStop=await engineFrame.evaluate(()=>{
   const bridge=window.layoutEngine.draft;
   bridge.completeStartup();
   bridge.seekRoadworks(3.6);
   return {ego:bridge.capture().pose.carPosition.toArray(),timing:bridge.get({audit:false}).event.timing};
  });
  assert.deepEqual(coldStop.ego,stopped.ego);
  assert.deepEqual(coldStop.timing,timing);
 });

 await check('Junction and Road have the same cruise lookahead in rain and snow', async () => {
  await open('road');
  const lengths={};
  for(const weather of ['rain','snow']){
   await control('[data-weather='+weather+']');
   await wait(()=>Math.abs((window.reviewFrame(true)?.state.path?.length??0)-80/3.6*.75*2.5)<.03);
   lengths[weather]=(await read()).state.path.length;
  }
  await changeScene('junction');
  const run=await event('leftturn');
  await seek(run.state.event.duration-.5);
  for(const weather of ['rain','snow']){
   await control('[data-weather='+weather+']');
   await wait(length=>Math.abs((window.reviewFrame(true)?.state.path?.length??0)-length)<.03,lengths[weather]);
   assert.equal((await read()).state.junction.speed*3.6,80);
  }
 });

 await check('Junction ribbon and steering use the active vehicle front axle through the curve', async () => {
  await open('junction');
  const getWheelPose=()=>page.evaluate(()=>{
   const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
   const {objects,pose}=bridge.capture();
   const car=objects.find(({object})=>object.userData.draftRolling)?.object;
   const {wheels}=car.userData.vehicleSpec;
   const front=wheels.map(w=>(w.min[2]+w.max[2])/2).filter(pos=>pos<0);
   const z=front.reduce((sum,value)=>sum+value,0)/front.length;
   const yaw=car.rotation.y, {steer,affected}=car.userData.draftRolling;
   const axle=[car.position.x+z*Math.sin(yaw),car.position.z+z*Math.cos(yaw)];
   const {path}=bridge.get();
   const headingOffset=point=>(point.x-car.position.x)*Math.cos(yaw)-(point.z-car.position.z)*Math.sin(yaw);
   return {yaw,steer:steer.value,affected,error:Math.hypot(axle[0]-path.start[0],axle[1]-path.start[1]),
    cameraX:headingOffset(pose.position),aimX:headingOffset(pose.aim),height:pose.position.y-car.position.y,anchor:pose.anchor.toArray()};
  });
  const started=await event('leftturn'), {stopAt,turnAt,clearAt}=started.state.event.timing;
  await seek(.65);
  const approach=await getWheelPose();
  assert.ok(approach.height<10,JSON.stringify(approach));
  await seek(2.55);
  const rising=await getWheelPose();
  assert.ok(rising.height>approach.height+1&&rising.height<28,JSON.stringify(rising));
  for(const time of [3.48,3.49,3.5,3.51]){
   await seek(time);
   const frame=await getWheelPose();
   assert.ok(frame.error<.01,'the guidance stays attached as the car comes to a stop');
  }
  await seek(3.6);
  const stopped=await getWheelPose();
  assert.ok(stopped.height>30,JSON.stringify(stopped));
  assert.equal(turnAt-stopAt,4);
  for(let pulse=0;pulse<5;pulse++){
   const lit=await seek(stopAt+pulse*.8+.2);
   const dark=await seek(stopAt+pulse*.8+.6);
   assert.equal(lit.state.junction.feedback.lampPulse,1);
   assert.equal(dark.state.junction.feedback.lampPulse,0);
   assert.deepEqual(lit.ego,dark.ego);
   assert.equal(lit.state.junction.speed,0);
   assert.equal(lit.state.junction.feedback.stopVisible,true);
   assert.match(lit.guide,/Signal left/);
  }
  for(const [label,time] of [['entry',turnAt+3.05],['apex',turnAt+4.3],['exit',clearAt-.1]]){
   await seek(time);
   const sample=await getWheelPose();
   assert.ok(sample.affected>0&&sample.error<.01,JSON.stringify(sample));
   assert.ok(Math.abs(sample.cameraX)<.001&&Math.abs(sample.aimX)<.001,JSON.stringify(sample));
   assert.ok(Math.abs(sample.height-stopped.height)<.001,JSON.stringify(sample));
   assert.ok(sample.anchor.every((value,i)=>Math.abs(value-stopped.anchor[i])<.001),JSON.stringify(sample));
   if(label==='apex')assert.ok(sample.yaw>.25&&sample.yaw<1.4&&sample.steer>.21,JSON.stringify(sample));
   if(label==='exit')assert.ok(sample.yaw>1.55&&sample.steer>=0&&sample.steer<.015,JSON.stringify(sample));
   await shot('junction-bend-'+label);
  }
  await seek(clearAt+.75);
  const lowering=await getWheelPose();
  assert.ok(lowering.height>approach.height+4&&lowering.height<stopped.height-4,JSON.stringify(lowering));
  await seek(clearAt+.75);
  assert.deepEqual(await getWheelPose(),lowering);
  await seek(clearAt+1.65);
  const returned=await getWheelPose();
  assert.ok(Math.abs(returned.height-approach.height)<.001,JSON.stringify(returned));
  await seek(turnAt+4.3);
  await page.getByRole('radio',{name:'Low',exact:true}).click();
  await wait(()=>window.reviewFrame()?.state.cameraHandoff===false);
  assert.ok((await getWheelPose()).height<10);
  await page.getByRole('radio',{name:'High',exact:true}).click();
  await wait(()=>window.reviewFrame()?.state.cameraHandoff===false);
  const high=await getWheelPose();
  assert.ok(high.height>25&&Math.abs(high.cameraX)<.001,JSON.stringify(high));
  await page.getByRole('radio',{name:'Auto',exact:true}).click();
  await wait(()=>window.reviewFrame()?.state.cameraHandoff===false);
  assert.ok((await getWheelPose()).height>30);
  for(const [id,name] of [['x6','BMW X6'],['ix','BMW iX'],['xc90','Volvo XC90']]){
   await control('.shell-vehicle-card');
   await page.getByRole('menuitemradio',{name,exact:true}).click();
   await wait(id=>window.reviewFrame()?.model===id&&!document.querySelector('.shell-vehicle-card').hasAttribute('aria-busy'),id);
   const sample=await getWheelPose();
   assert.ok(sample.affected>0&&sample.error<.01&&sample.steer>.21,JSON.stringify(sample));
  }
 });

 await check('Junction Left turn keeps an already enabled fleet through seconds 2 and 3', async () => {
  await open('junction');
  await control('[data-layer=traffic]');
  await wait(()=>window.reviewFrame(true)?.fleet.length>=4);
  await page.evaluate(()=>{
   const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
   bridge.setPlaying(false);
   bridge.advance(Math.max(0,2.4-bridge.get({audit:false}).loopTime));
  });
  const before=await read();
  await event('leftturn');
  for(const time of [2.3,2.6,3,4.6,2.4]){
   const sample=await seek(time);
   assert.deepEqual(sample.fleet.map(car=>car.id),before.fleet.map(car=>car.id));
  }
  const after=await read();
  for(const [index,car] of after.fleet.entries()){
   const prior=before.fleet[index];
   assert.ok(Math.hypot(car.position[0]-prior.position[0],car.position[2]-prior.position[2])<1);
  }
 });

 await check('Junction Left turn starts from the stop with an already visible ribbon', async () => {
  await open('junction');
  await wait(()=>window.reviewFrame()?.state.junction.complete&&!window.reviewFrame().cover);
  const stopped = await read(), started = await event('leftturn');
  assert.equal(stopped.state.junction.speed,0);
  assert.equal(started.state.junction.speed,0);
  assert.deepEqual(started.ego,stopped.ego);
  assert.deepEqual(started.camera,stopped.camera);
  assert.deepEqual(started.cameraAim,stopped.cameraAim);
  assert.equal(started.cover,false);
  assert.equal(started.state.path.reveal,1);
  assert.equal(started.state.path.revealing,false);
 });

 await check('Junction Left turn and Traffic can be changed independently', async () => {
  const pattern='**/traffic-model-y.prepared.bin.gz*';
  let trafficRequests=0;
  const block=route=>{trafficRequests++;return route.abort();};
  await page.route(pattern,block);
  try {
   await open('junction');
   const traffic=page.locator('[data-layer=traffic]');
   const started=await event('leftturn');
   assert.equal(await traffic.isEnabled(),true);
   assert.equal(await traffic.getAttribute('aria-pressed'),'false');
   assert.equal(started.fleet.length,0);
   const mid=await seek(started.state.event.timing.turnAt+4.3);
   assert.ok(mid.state.junction.speed>0);
   assert.equal(mid.fleet.length,0);
   assert.equal(trafficRequests,0);
   await shot('junction-left-turn-without-traffic');
   await page.unroute(pattern,block);
   await traffic.click();
   await wait(()=>window.reviewFrame(true)?.fleet.length>0);
   const withTraffic=await read();
   assert.equal(await traffic.getAttribute('aria-pressed'),'true');
   assert.equal(withTraffic.state.loopTime,mid.state.loopTime);
   assert.deepEqual(withTraffic.ego,mid.ego);
   assert.ok(withTraffic.fleet.some(car=>inFrame(withTraffic,car)));
   await shot('junction-left-turn-with-traffic');
   await traffic.click();
   await wait(()=>window.reviewFrame(true)?.fleet.length===0);
   const withoutTraffic=await read();
   assert.equal(await traffic.getAttribute('aria-pressed'),'false');
   assert.equal(withoutTraffic.state.event.event,'leftturn');
   assert.equal(withoutTraffic.state.loopTime,mid.state.loopTime);
   assert.deepEqual(withoutTraffic.ego,mid.ego);
   await control('[data-param=camera] [data-value=low]');
   await wait(()=>!window.reviewFrame()?.state.cameraHandoff);
   for (const time of [13.1,started.state.event.timing.clearAt-.05,started.state.event.timing.clearAt+.1,started.state.event.duration-.4]) {
    const held=await seek(time);
    await traffic.click();
    await wait(()=>window.reviewFrame(true)?.fleet.length>0);
    const enabled=await read();
    assert.deepEqual(enabled.ego,held.ego);
    assert.ok(enabled.fleet.some(car=>inFrame(enabled,car)), `Traffic appears at ${time}s`);
    await traffic.click();
    await wait(()=>window.reviewFrame(true)?.fleet.length===0);
   }
   const waiting=await seek(started.state.event.timing.stopAt+1.5);
   await traffic.click();
   await wait(()=>window.reviewFrame(true)?.fleet.length>0);
   const waitingWithTraffic=await read();
   assert.equal(waitingWithTraffic.state.loopTime,waiting.state.loopTime);
   assert.deepEqual(waitingWithTraffic.ego,waiting.ego);
   assert.ok(waitingWithTraffic.fleet.every(car=>car.axis==='x'
    ? Math.abs(car.position[0])>23
    : Math.abs(car.position[2]+40)>23),'new traffic enters from the approach roads');
   const ids=waitingWithTraffic.fleet.map(car=>car.id);
   await control('.shell-vehicle-card');
   await page.getByRole('menuitemradio',{name:'BMW X6',exact:true}).click();
   await wait(()=>window.reviewFrame()?.model==='x6'&&!document.querySelector('.shell-vehicle-card').hasAttribute('aria-busy'));
   const replaced=await read();
   assert.equal(replaced.state.loopTime,waiting.state.loopTime);
   assert.deepEqual(replaced.fleet.map(car=>car.id),ids);
   assert.deepEqual(replaced.fleet.map(car=>car.position),waitingWithTraffic.fleet.map(car=>car.position));
   assert.ok(replaced.state.event.timing.turnAt>=started.state.event.timing.turnAt);
  }finally{await page.unroute(pattern,block);}
 });

 await check('Parking oncoming car and occupied bay are reachable from the narrow desktop', async () => {
  await page.setViewportSize({width:1020,height:840});
  for(const scene of ['parking','outdoor']) {
   await open(scene);
   await event('parking-yield');
   const start=await seek(2);
   const {decisionAt}=start.state.event;
   const before=await seek(decisionAt+.8), overhead=await seek(decisionAt+1.51);
   assert.ok(before.camera[1]<33);
   assert.ok(overhead.camera[1]>=33.96);
   assert.equal((await seek(Infinity)).state.parking.complete,true);
   const bay=await seek(start.state.event.duration-.12);
   assert.equal(bay.state.parking.complete,false);
   const opacity=await page.evaluate(()=>{
    const bridge=document.querySelector('iframe[title]').contentWindow.layoutEngine.draft;
    return bridge.capture().objects.find(entry=>entry.object.name==='Parking target space').object.material.uniforms.completion.value;
   });
   assert.ok(opacity>0&&opacity<1,`${scene} fades the bay before arrival: ${opacity}`);
   await control('#tl-play');
   await wait(()=>document.querySelector('[data-value=parked]')?.getAttribute('aria-checked')==='true'&&
    !document.querySelector('[data-value=parked]').hasAttribute('aria-busy')&&
    !!document.querySelector('canvas.parked-view:not([hidden])'),null,{timeout:120_000});
   const shades=await page.evaluate(async ()=>{
    const shade=()=>{const list=document.querySelectorAll('canvas.parked-view');const c=list[list.length-1];return c.getContext('2d').getImageData(1,1,1,1).data[0];};
    const from=shade(), previous=document.documentElement.dataset.theme;
    const to=new Promise(resolve=>{
     const observer=new MutationObserver(()=>{
      if(document.documentElement.dataset.theme===previous)return;
      observer.disconnect();resolve(shade());
     });
     observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    });
    document.querySelector('#theme').click();
    return [from,await to];
   });
   assert.ok(Math.abs(shades[0]-shades[1])>110,`Parked and controls change theme in the same update: ${shades}`);

   await open(scene);
   await event('parking-taken');
   const end=await seek(Infinity);
   assert.equal(end.state.event.event,'parking-taken');
   assert.equal(end.state.parking.complete,true);
   assert.match(end.guide,/End/);
  }
 });

 await check('A short viewport starts an interaction directly without an account', async () => {
  await page.setViewportSize({width:320,height:260});
  await page.goto(new URL('/studio/ui-draft/pro-prototype.html?plan=free', base).href);
  await eventControl('cutin').click();
  await wait(()=>document.querySelector('[data-event=cutin]')?.getAttribute('aria-checked')==='true');
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.locator('#proto-bar,#account-actions,.pro-tag').count(),0);
 });

 await check('Driving assist wheel remains visible when the active icon cannot load over the network', async () => {
  await page.setViewportSize({width:1280,height:860});
  const pattern='**/assist-wheel-on.svg';
  const block=route=>route.abort();
  await page.route(pattern,block);
  try {
   for(const [scene,selector] of [
    ['road','#scene-transport'],
    ['elevated','[data-event=roadworks]'],
    ['parking','#scene-transport'],
    ['parking','[data-event=parking-yield]'],
   ]){
    await open(scene);
    await control(selector);
    await wait(()=>{
     const wheel=document.querySelector('#playback-wheel');
     const transport=wheel?.closest('#canvas-playback');
     return transport?.dataset.mode==='timeline'||transport?.querySelector('#scene-transport')?.getAttribute('aria-checked')==='true';
    });
    const image=await page.locator('#playback-wheel').screenshot({animations:'disabled'});
    const {data,info}=await sharp(image).removeAlpha().raw().toBuffer({resolveWithObject:true});
    let white=0,blue=0;
    for(let y=4;y<info.height-4;y++){
     for(let x=4;x<info.width-4;x++){
      const i=(y*info.width+x)*info.channels;
      if(data[i]>210&&data[i+1]>210&&data[i+2]>210)white++;
      if(data[i+2]>125&&data[i+2]-data[i]>75)blue++;
     }
    }
    assert.ok(white>12&&blue>12,`${scene} ${selector} must show the wheel on its blue disc: ${white} white / ${blue} blue pixels`);
   }
  } finally {await page.unroute(pattern,block);}
 });

 await check('Junction round trips preserve the exact turning frame and traffic', async () => {
  await page.setViewportSize({width:1280,height:860});
  const traffic=page.locator('[data-layer=traffic]');
  const setTraffic=async enabled=>{
   if(await traffic.getAttribute('aria-pressed')!==String(enabled))await traffic.click();
   await wait(enabled=> {
    const api=document.querySelector('iframe[title]')?.contentWindow?.layoutEngine;
    return api?.get().traffic?.enabled===enabled;
   },enabled);
  };
  for(const trafficStart of ['off','early','late']){
   await open('junction');
   await setTraffic(trafficStart==='early');
   const active=await event('leftturn');
   await seek(active.state.event.timing.turnAt+5);
   if(trafficStart==='late')await setTraffic(true);
   if(trafficStart!=='off')await wait(()=>window.reviewFrame(true)?.fleet.length>0);
   const before=await read();
   await changeScene('parking');
   await changeScene('junction');
   const after=await read();
   assert.equal(after.state.event.time,before.state.event.time,trafficStart);
   assert.equal(after.state.requestedPlaying,false);
   assert.deepEqual(after.ego,before.ego);
   assert.deepEqual(after.camera,before.camera);
   const renderedFleet=frame=>frame.fleet.map(({id,position,yaw,alpha,feedback})=>({id,position,yaw,alpha,feedback}));
   assert.deepEqual(renderedFleet(after),renderedFleet(before));
   assert.equal(after.state.path.reveal,1);
  }
 });

 await check('A held vehicle download leaves the scene switch available', async () => {
  await page.setViewportSize({width:1280,height:860});
  await open('road');
  await page.evaluate(()=>localStorage.clear());
  await open('road');
  let unblock;
  const transfer=new Promise(resolve=>{unblock=resolve;});
  const model='**/vehicles/x6/model.glb.gz?*';
  const handler=async route=>{await transfer;await route.continue();};
  await page.route(model,handler);
  try{
   await page.getByRole('button',{name:/Vehicle: Tesla Model 3/}).click();
   await Promise.all([
    page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/vehicles/x6/model.glb.gz')),
    page.getByRole('menuitemradio',{name:'BMW X6',exact:true}).click()
   ]);
   await changeScene('junction');
   assert.equal((await read()).model,'model-3');
   unblock();
   await wait(()=>window.reviewFrame()?.model==='x6');
   assert.equal((await read()).state.scene,'junction');
  }finally{
   unblock();
   await page.unroute(model,handler);
  }
 });

 assert.deepEqual(errors,[]);
});
