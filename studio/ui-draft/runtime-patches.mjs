import {refineIndoorFinish} from './indoor-finish.mjs';
import {readFile} from 'node:fs/promises';
import {refineFigma} from './figma-refinements.mjs';
import {refineWorld,refineWeather,refineRainGround,refineSnowGround,refineActivation} from './scene-refinements.mjs';

function replace(source,from,to){if(!source.includes(from))throw Error(`UI draft baseline mismatch: ${from.slice(0,90)}`);return source.replace(from,to)}

export function patchFeatures(source){
 source="import {drivingRibbonEnd} from '../ui-draft/driving-ribbon-clearance.js';\n"+source;
 source="import {advanceRoadArrows} from '../ui-draft/road-mark-motion.js';\nimport {drivingSpeed,forwardPathEnd,junctionBrakeReveal,roadCruiseSpeed} from '../ui-draft/junction-playback.js';\n"+source;
 source="import {blendPathTheme} from '../ui-draft/path-theme.js';\n"+source;
 source=replace(source,'u.color.value.copy(PATH_COLOR[tone]);','');
 source=replace(source,"if(JUNCTION_IDS.includes(id)||['06','07'].includes(id)){","if(JUNCTION_IDS.includes(id)||id==='06'){");
 source=replace(source,'for(const z of [0,30,60])','for(const z of [0])');
 source=replace(source,"if(path.tone!==tone){u.edgeBlend.value=tone==='light'?.34:.72;for(const [key,value]of Object.entries(PATH_RADIANCE[tone]))u[key].value.copy(value);path.tone=tone;}","blendPathTheme(u,PATH_COLOR,PATH_RADIANCE,world.draftThemeTone?.value??(tone==='dark'?1:0));path.tone=tone;");
 source=replace(source,"if(id==='06')return {kind:'lane',x,y,points:straight(x,8,-255,1)};","if(id==='06')return {kind:'lane',x,y,points:straight(x,8,-255,1)};if(JUNCTION_IDS.includes(id)){const turning=world.draftJunctionTurnActive?.();return {kind:'lane',x,y,points:turning?world.draftJunctionPath():straight(x,60,-255,1)};}");
 // VSM includes receivers in the depth pass; the information ribbon must only
 // receive vehicle shadows, including portions clipped by its own surface shader.
 source=replace(source,'mesh.renderOrder=5;mesh.castShadow=false;mesh.receiveShadow=true;','mesh.renderOrder=5;mesh.castShadow=false;mesh.receiveShadow=true;mesh.customDepthMaterial=world.receiverDepth;');
 source=replace(source,'Math.min(path.plan.fixedEnd??path.startS+PATH_REACH,path.total-1)','forwardPathEnd(path.startS,drivingSpeed(world,id),path.total,path.plan.fixedEnd,JUNCTION_IDS.includes(id)?2:2.5)');
 source=replace(source,"key=PARKING_IDS.includes(id)?'parking':id;let data=roots.get(root);","key=PARKING_IDS.includes(id)?'parking':world.draftJunctionTurnActive?.()?'junction-left-turn':id;let data=roots.get(root);");
 source=replace(source,'fx=car.x-Math.sin(ry)*reach,fz=car.z-Math.cos(ry)*reach','fx=junctionTurn?.frontX??car.x-Math.sin(ry)*reach,fz=junctionTurn?.frontZ??car.z-Math.cos(ry)*reach');
 source=replace(source,'path.endS=end;',`if(world.draftJunctionTurnFrame){
    const release=junctionTurn.pathRelease;
    if(release===0){
     const stop=locate(path.points,path.cum,1.85,junctionTurn.stopLineZ);
     path.startS=Math.min(path.startS,stop-.5);
     end=Math.min(stop,Math.max(end,path.startS+2.5));
     path.stopS=stop;
    }else{
     path.stopS=undefined;
     const speed=Math.min(junctionTurn.speed,roadCruiseSpeed(world));
     const ahead=Math.min(path.total-1,Math.max(path.startS+14,forwardPathEnd(path.startS,speed,path.total)));
     end=release===1?ahead:Math.max(path.startS,THREE.MathUtils.lerp(
      locate(path.points,path.cum,1.85,junctionTurn.stopLineZ),ahead,release));
    }
   }else if(JUNCTION_IDS.includes(id)){const stopZ=(world.junctionDimensions?.markingEnd??-22.55)+(world.junctionDimensions?.stopLineWidth??.18)/2+.15;path.stopS=locate(path.points,path.cum,path.plan.x,stopZ);end=Math.max(path.startS,Math.min(end,path.stopS));}
   else if(roadworks?.traffic){
    // Apply the speed-based range first, then shorten it to the clear corridor.
    const shorten=(z,weight)=>{
     const safe=locate(path.points,path.cum,path.plan.x,z);
     end=THREE.MathUtils.lerp(end,Math.max(path.startS,Math.min(end,safe)),weight);
    };
    if(roadworks.holdWeight>0)shorten(roadworks.holdZ,roadworks.holdWeight);
    end=drivingRibbonEnd(path,world.car.position.z,PATH_HALF_WIDTH,roadworks.visibleTraffic??roadworks.traffic,
     roadworks.pathX,path.startS,end,locate);
   }else if(world.trafficSystem&&world.draftTrafficEnabled){
    const audit=world.trafficSystem.audit?.();
    if(audit?.visible&&audit.positions?.length){
     const ambientCars=audit.positions.map(([cx,,cz],i)=>{
      const lane=audit.lanes[i];
      return {x:cx,z:cz-world.car.position.z,direction:lane.direction,opacity:lane.alpha,yaw:lane.direction>0?Math.PI:0};
     });
     end=drivingRibbonEnd(path,world.car.position.z,PATH_HALF_WIDTH,ambientCars,()=>world.car.position.x,path.startS,end,locate);
    }
   }
   path.endS=end;`);
 // Under managed Pro playback, engine-bridge owns the single RAF loop; avoid a
 // competing 30fps RAF loop during Weather / Driving Assist animations.
 source=replace(source,'if(!world.state||world.initializingScene||animationFrame||globalThis.document?.hidden||world.suspended||reduced())return;','if(world.draftManaged||!world.state||world.initializingScene||animationFrame||globalThis.document?.hidden||world.suspended||reduced())return;');
 source=replace(source,'const path=data.path;\n  if(path){',`const path=data.path;
  if(path){
   const junctionTurn=world.draftJunctionTurnFrame;
   const roadworks=world.draftRoadworksPlayback?.active()?world.draftRoadworksFrame:null;
   const position=path.mesh.geometry.attributes.position;
   if(roadworks){
    if(!path.roadworksBase){
     path.roadworksBase=position.array.slice();
     // Keep the ribbon above the lane paint while it crosses the dashed line.
     for(let i=0;i<position.count;i++)position.setY(i,path.plan.y+.02);
    }
    for(let i=0;i<position.count;i++)position.setX(i,path.roadworksBase[i*3]+roadworks.pathX(path.roadworksBase[i*3+2])-path.plan.x);
    position.needsUpdate=true;
   }else if(path.roadworksBase){position.array.set(path.roadworksBase);position.needsUpdate=true;path.roadworksBase=null;}`);
 source=replace(source,'pathDepthPoint.set(pathStart.x,', 'pathDepthPoint.set(roadworks?.pathX(pathStart.z)??pathStart.x,');
 source=replace(source,'pathDepthPoint.set(pathEnd.x,', 'pathDepthPoint.set(roadworks?.pathX(pathEnd.z)??pathEnd.x,');
 source=replace(source,'path.mesh.visible=reveal>.001&&end-path.startS>2;','path.mesh.visible=reveal>.001&&end-path.startS>(JUNCTION_IDS.includes(id)?.02:2);');
 // Braking is a surface treatment in the same ribbon shader, with no stacked meshes.
 source=replace(source,'uniform float startS;uniform float endS;','uniform float junctionBrake;uniform float junctionReveal;uniform float junctionStop;uniform float roadworksBrake;uniform float startS;uniform float endS;');
 source=replace(source,'material.uniforms.edgeBlend={value:.52};','material.uniforms.edgeBlend={value:.52};material.uniforms.junctionBrake={value:0};material.uniforms.junctionReveal={value:0};material.uniforms.junctionStop={value:-1000};material.uniforms.roadworksBrake={value:0};');
 source=replace(source,'gl_FragColor=vec4(surface*contact*shadow,opacity*edge*head*tail*coverage);',`if(junctionBrake>.5||roadworksBrake>0.){
  float along=junctionBrake>.5?endS-vS:startS-vS;
  float phase=fract((along+abs(vSide)*.65)/2.8);
  float bandAA=max(fwidth(phase),.015);
  float band=smoothstep(.08-bandAA,.08+bandAA,phase)*(1.-smoothstep(.52-bandAA,.52+bandAA,phase));
  float strength=roadworksBrake*(1.-smoothstep(.25,.85,t));
  if(junctionBrake>.5){
   float enter=smoothstep(0.,1.,junctionReveal);
   strength=enter*(1.-smoothstep(enter-.12,enter+.12,t));
  }
  surface*=1.-.14*band*strength;
 }
 if(junctionBrake>.5){
  float stopBlend=(1.-smoothstep(3.,14.,junctionStop-startS))*smoothstep(-1.2,0.,endS-junctionStop);
  tail=mix(tail,1.,stopBlend);coverage=(1.-smoothstep(sweep-.035,sweep+.035,t))*.98;
  float stopEdge=(1.-smoothstep(.10,.17,junctionStop-vS))*stopBlend;
  surface=mix(surface,vec3(1.),stopEdge);head=1.;
 }
 gl_FragColor=vec4(surface*contact*shadow,opacity*edge*head*tail*coverage);`);
 source=replace(source,'u.startS.value=path.startS;','u.junctionStop.value=path.stopS??-1000;u.junctionBrake.value=JUNCTION_IDS.includes(id)&&!(junctionTurn?.pathRelease>0)?1:0;u.junctionReveal.value=junctionBrakeReveal(world.draftJunctionElapsed||0);u.roadworksBrake.value=roadworks?.brakeStrength??0;u.startS.value=path.startS;');
 source=source.replaceAll("'material-draft'","'ui-draft'");
 source=source.replaceAll('performance.now()','(world.draftTime??performance.now())');
 source=replace(source,'if(patch.path&&!reduced())activationSweep?.start();',"if(patch.path&&animate&&!reduced())activationSweep?.start();");
 source=replace(source,'u.singleLayer.value=activationSweep?1:0;',"u.singleLayer.value=activationSweep?1:0;if(JUNCTION_IDS.includes(id)){u.singleLayer.value=1;u.sweepProgress.value=closing?pathReveal.closingActivation*1.07-.035:reveal*1.07-.035;u.motionPreset.value=0;u.motionElapsed.value=2000;}");
 source=source.replace('surface=mix(surface,sweepColor,sweepBand);','surface=mix(surface,sweepColor,sweepBand*.8);');
 source=replace(source,'const queueFrame=()=>{','const queueFrame=()=>{if(world.draftManaged)return;');
 source=replace(source,'far.visible=opacity>.001;}\n  }\n  return data;','far.visible=opacity>.001;}\n   advanceRoadArrows(data,world.drivingDistance||0);\n  }\n  return data;');
 source="import {weatherFrame} from '../ui-draft/scene-experience.js';\n"+refineWeather(source);
 const a=source.indexOf(' const applyWeather=()=>{'),b=source.indexOf(' const guarded=',a);
 source=source.slice(0,a)+` const applyWeather=()=>{if(!world.state||!world.sky)return null;const weather=effectiveWeather(sceneId());lastWeather=weather;world.weatherSignature=weather+'|'+world.state.mode;return weatherFrame(world,weather,weatherMaterial,WEATHER);};\n`+source.slice(b);
 source=replace(source,'patch.path&&activationSweep&&animate&&!reduced()?150:0',"patch.path&&activationSweep&&animate&&!reduced()&&!JUNCTION_IDS.includes(sceneId())?150:0");
 source=replace(source,'return result;','if(JUNCTION_IDS.includes(world.state?.id)&&result.path)Object.assign(result.path,{revealMs:650,pathDelayMs:0,totalActivationMs:650,timingMs:{baseFill:[0,650]},sweepEase:"continuous forward reveal",sweepFront:path.material.uniforms.sweepProgress.value});return result;');
 source=replace(source,'const revealDuration=()=>activationSweep?350:',"const revealDuration=()=>JUNCTION_IDS.includes(sceneId())?650:activationSweep?350:");
 return source;
}

export function patchApp(source){
 // Remove extra frame latency on managed right-panel toggles (Buildings, Trees,
 // Camera, Lanes) while preserving the two-frame cadence for full scene swaps.
 source=replace(source,"pendingRender=requestAnimationFrame(()=>{pendingRender=requestAnimationFrame(()=>{const begin=performance.now();render(true,false,motion);preview.dataset.renderMs=(performance.now()-begin).toFixed(1);});});","pendingRender=requestAnimationFrame(()=>{if(world.draftManaged&&motion!=='scene'){const begin=performance.now();render(true,false,motion);preview.dataset.renderMs=(performance.now()-begin).toFixed(1);return;}pendingRender=requestAnimationFrame(()=>{const begin=performance.now();render(true,false,motion);preview.dataset.renderMs=(performance.now()-begin).toFixed(1);});});");
 // The diagnostic instance ID must not block startup on an HTTP preview.
 source="import {MathUtils} from 'three';\n"+source;
 source=replace(source,'crypto.randomUUID();','crypto.randomUUID?.()??MathUtils.generateUUID();');
 source=replace(source,',signal:AbortSignal.timeout(30000)','');
 source=replace(source,'preparePathSound();',`const warmPathSound=()=>{if(window.parent.document.documentElement.dataset.startup||world?.draftManaged&&world.draftInitialFrameReady!==true){setTimeout(warmPathSound,1000);return;}void preparePathSound();};setTimeout(warmPathSound,1500);`);
 // A palette change must not restart camera, layout or environment motion.
 source=replace(source,' async theme(value){',` setDraftTheme(value){
  mode=value;requestedTheme=value;world.setDraftTheme(value);
  document.documentElement.dataset.theme=value;preview.dataset.mode=value;updateURL();
 },
 async theme(value){`);
 // A live driving frame is never idle enough to parse/upload three unused
 // models. Keep selection preparation and its cache; remove the opening sweep.
 source=replace(source,'scheduleVehicleWarmup(800);rememberPreview();','rememberPreview();');
 // The embedded canvas may be narrow on desktop; capacity follows the host viewport.
 source=replace(source,"maxEntries:matchMedia('(max-width:760px)').matches?2:4","maxEntries:4");
 source="import {prepareStartupChoices,startupChoices} from '../ui-draft/startup-readiness.js';\nimport {prefetchVehicleFiles} from '../ui-draft/vehicle-prefetch.js';\n"+source;
 source=replace(source,"if(query.has('qa')){const records=JSON.parse(preview.dataset.vehiclePerformance", "if(query.has('qa')||query.get('review')==='ui-draft'){const records=JSON.parse(preview.dataset.vehiclePerformance");
 source=replace(source,' vehicleReady=true;vehicleFullReady=full;',` await prepareAllStartupChoices();
 vehicleReady=true;vehicleFullReady=full;`);
 source=replace(source,"catch(error){error.code='renderer';throw error;}","catch(error){error.code='renderer';window.parent.postMessage({type:'ui-draft-error',message:'3D rendering is unavailable.'},location.origin);throw error;}");
 source=replace(source," world.suspended=true;world.clearLayoutTransition();"," window.parent.postMessage({type:'ui-draft-context-lost'},location.origin);\n world.suspended=true;world.clearLayoutTransition();");
 source=replace(source,'function failedVehicle(error){console.error(error);',"function failedVehicle(error){console.error(error);window.parent.postMessage({type:'ui-draft-error',message:error.message},location.origin);");
 source=replace(source,'async function installVehicle(car,full=false,animate=false,retainPrevious=false){',`async function prepareAllStartupChoices(){
 const project=window.parent.__draftStartupProject;if(!project)return;
 const initial=selected,saved=new Map([...preferences].map(([key,value])=>[key,{...value}]));
 const scenery=world.draftSceneryRandom.state(),traffic=world.draftTrafficRandom.state();
 const initialFeatures=versionFeatures.get();
 function select(choice){
  selected=choice.key;const values=choice.params,preference=preferences.get(selected);
  Object.assign(preference,{id:values.layout,laneCount:Number(values.lanes),cameraView:values.camera||'low'});
  for(const name of environmentIds)if(name in values)preference[name]=!!values[name];
  if(['parking','outdoor'].includes(selected))preference.id=({parking:{default:'10',raised:'16',bev:'14'},outdoor:{default:'17',raised:'18',bev:'19'}}[selected][values.camera]||preference.id);
  if(selected==='junction'){preference.junctionPosition='approaching';preference.cameraView='low';}
  world.draftSceneryRandom.reset(choice.seed);world.draftTrafficRandom.reset(choice.seed+1);
  versionFeatures.set({path:!!values.path,weather:values.weather||'default'},{animate:false,render:false});
 }
 await prepareStartupChoices({world,models:[selectedVehicle],cache:vehicleCache,prepareVehicle:prepareChoice,choices:startupChoices(project.boards,project.active),select,state,restore(){
  selected=initial;for(const [key,value]of saved)Object.assign(preferences.get(key),value);
  world.draftSceneryRandom.restore(scenery);world.draftTrafficRandom.restore(traffic);
  versionFeatures.set(initialFeatures,{animate:false,render:false});
 }});
}
async function installVehicle(car,full=false,animate=false,retainPrevious=false){`);
 source=replace(source,"if(key==='model'){document.getElementById('vehicle-option-'+value)?.click();return;}","if(key==='model')return vehicleSelector.choose(value);");
 source=replace(source,'preparationQueue.then(()=>prepareVehicleChoice(world,car))','preparationQueue.then(()=>{world.draftPrepareVehicle?.(car);return prepareVehicleChoice(world,car);})');
 source=replace(source,"delete preview.dataset.loadError;world.setVehicle(car,", "delete preview.dataset.loadError;world.draftPrepareVehicle?.(car);world.setVehicle(car,");
 source=replace(source,"mark('update');world.renderFrame();mark('frame');","mark('update');await world.draftPrepareAppearance?.();world.renderFrame();mark('frame');");
 source=replace(source,"(['05','08','06','07'].includes(world.state?.id)&&!!world.cameraMotion)","(world.draftManaged?!!world.draftJunctionPlaying?.():['05','08','06','07'].includes(world.state?.id)&&!!world.cameraMotion)");
 source="import {previewPixels} from '../ui-draft/pixel-resolution.js';\nimport {installDraftBridge,loadExportModule,makeRandom} from '../ui-draft/engine-bridge.js';\n"+source;
 source=replace(source,"import {cameraMetadata,perspectiveSvg,renderDepth,exportSize,exportReadme} from './export-scene.js';\nimport {canvasPng,depthPng,zipFiles,downloadFile} from './export-files.js';\n",'');
 source=replace(source,'async function loadVehicle(id){const car=await (id===\'x6\'?createVehicle():loadPreparedVehicle(id,{url:new URL(`./vehicle-library/prepared/${id}/model.glb.gz`,import.meta.url)}));return car;}',`const startupLod=/\\/pro-engine(?:\\.html)?$/.test(location.pathname)&&window.parent?.__draftStartupLod?.id===selectedVehicle?window.parent.__draftStartupLod:null;
const MODEL3_CANONICAL_WHEELS=[
 {position:'right-rear',min:[0.683104928263162,5.551115123125783e-17,1.0461613298333916],max:[0.9289343774812638,0.6901820833721215,1.736343413205513],size:[0.2458294492181018,0.6901820833721215,0.6901820833721215]},
 {position:'left-rear',min:[-0.9294949335951067,3.885780586188048e-16,1.0461613298333912],max:[-0.6836654843770049,0.6901820833721218,1.7363434132055127],size:[0.2458294492181018,0.6901820833721215,0.6901820833721215]},
 {position:'right-front',min:[0.6759818011126272,5.551115123125783e-17,-1.8270145376040066],max:[0.9218112503307287,0.6901820833721215,-1.1368324542318853],size:[0.24582944921810157,0.6901820833721215,0.6901820833721213]},
 {position:'left-front',min:[-0.9208493059849139,0.00005437501641669673,-1.8270689126204234],max:[-0.6750742317832287,0.6902364583885381,-1.1368868292483019],size:[0.2457750742016852,0.6901820833721214,0.6901820833721215]}
];
let startupLodPending=startupLod?startupLod.id:null,fullVehicleUpgrade=null,fullVehicleTimer=0;
async function loadVehicle(id){
 if(startupLod&&id===startupLodPending){startupLodPending=null;const car=await loadPreparedVehicle(id,{url:new URL(startupLod.url)});car.userData.isStartupLod=true;if(id==='model-3'&&car.userData.vehicleSpec)car.userData.vehicleSpec={...car.userData.vehicleSpec,wheels:MODEL3_CANONICAL_WHEELS.map(w=>({position:w.position,min:[...w.min],max:[...w.max],size:[...w.size]}))};return car;}
 const car=await (id==='x6'?createVehicle():loadPreparedVehicle(id,{url:new URL(\`./vehicle-library/prepared/\${id}/model.glb.gz\`,import.meta.url)}));return car;
}
function ensureFullVehicle(id=selectedVehicle){
 if(!startupLod||id!==startupLod.id)return Promise.resolve();
 if(fullVehicleUpgrade)return fullVehicleUpgrade;
 fullVehicleUpgrade=(async()=>{
  const path=\`./vehicles/\${id}/model.glb.gz\`;
  const fullUrl=new URL(\`../ui-draft/vehicles/\${id}/model.glb.gz?v=restore26\`,import.meta.url);
  const host=window.parent,mirror=host?.__draftStartupMirrors?.[path],loader=host?.__draftFetchStartupAsset;
  if(mirror&&loader&&!host.__draftVehicleAssets?.has(fullUrl.href)&&!host.__draftStartupAssets?.has(fullUrl.href)){
   const req=loader(fullUrl.href,{scope:host,mirror});req.catch(()=>{});
   (host.__draftStartupAssets??=new Map()).set(fullUrl.href,req);
  }
  const fullCar=await loadPreparedVehicle(id,{url:fullUrl});
  await prepareChoice(fullCar);
  const commit=()=>{
   if(selectedVehicle!==id){
    if(vehicleCache.peek(id)?.userData?.isStartupLod)vehicleCache.replace(id,fullCar);
    else disposeVehicle(fullCar);
    return true;
   }
   if(vehicleChanging||world.initializingScene)return false;
   const prevPos=world.car.position.clone(),prevRot=world.car.rotation.clone(),prevVis=world.car.visible;
   world.draftPrepareVehicle?.(fullCar);
   world.setVehicle(fullCar,{disposePrevious:false,preserveScene:true});
   world.car.position.copy(prevPos);world.car.rotation.copy(prevRot);world.car.visible=prevVis;
   world.carReflectionKey=null;world.shadowKey='';
   vehicleCache.replace(id,fullCar);
   if(!world.suspended)world.renderFrame();
   preview.dataset.vehicleQuality='full';
   return true;
  };
  for(let attempt=0;attempt<40;attempt++){
   if(commit())return;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  if(vehicleCache.peek(id)?.userData?.isStartupLod)vehicleCache.replace(id,fullCar);
  else disposeVehicle(fullCar);
 })().catch(error=>{fullVehicleUpgrade=null;throw error;});
 return fullVehicleUpgrade;
}
function scheduleFullVehicleUpgrade(){
 if(!startupLod||fullVehicleUpgrade||fullVehicleTimer||navigator.connection?.saveData)return;
 fullVehicleTimer=setTimeout(()=>{fullVehicleTimer=0;if(document.hidden){scheduleFullVehicleUpgrade();return;}void ensureFullVehicle(startupLod.id).catch(()=>{});},250);
}`);
 source=replace(source,"exporting=true;exportControls.setBusy(true);exportControls.announce('Preparing export…');","await ensureFullVehicle();\n  exporting=true;exportControls.setBusy(true);exportControls.announce('Preparing export…');\n  const {cameraMetadata,perspectiveSvg,renderDepth,exportSize,exportReadme,canvasPng,depthPng,zipFiles,downloadFile}=await loadExportModule();");
 source=replace(source,"function previewResolution(){const mobile=matchMedia('(max-width:760px)').matches;const width=Math.min(mobile?1280:1440,Math.max(640,Math.ceil(preview.clientWidth*Math.min(devicePixelRatio||1,2)/16)*16));return [width,Math.round(width*9/16)];}","function previewResolution(){const raster=previewPixels(preview.clientWidth,devicePixelRatio,window.parent.visualViewport?.scale??1,globalThis.__draftPreviewLimit);return [raster.width,raster.height];}");
 source=source.replaceAll("'material-draft'","'ui-draft'").replaceAll("'sr-theme'","'sr-ui-draft-theme'");
 // The other scene families do not consume the Road lane cache. Keep its
 // deferred shader compilation out of their first visible interaction.
 source=replace(source,"if(query.get('review')==='ui-draft')void prepareLaneGeometry(world);", "if(query.get('review')==='ui-draft'&&selected==='road')void prepareLaneGeometry(world);");
 source=source.replaceAll("history.replaceState(null,'',`?${q}`)","history.replaceState(null,'',location.pathname+`?${q}`)");
 source=replace(source,'createContinuousDriving(world,{onFrame(){if(performance.now()-lastDrivingAudit>180)',"createContinuousDriving(world,{random:world.draftSceneryRandom=makeRandom(Number(query.get('seed'))||110),onFrame(){if(world.root&&!world.initializingScene&&performance.now()-lastDrivingAudit>180)");
 source=replace(source,'createTrafficSystem(world):null',"createTrafficSystem(world,{enabled:query.get('traffic')!=='0',random:world.draftTrafficRandom=makeRandom((Number(query.get('seed'))||110)+1),now:()=>world.draftTime??performance.now()}):null");
 source=replace(source,"continuousDrive.setPlaying(['road','elevated'].includes(selected));","if(!world.draftManaged)continuousDrive.setPlaying(['road','elevated'].includes(selected)&&!matchMedia('(prefers-reduced-motion: reduce)').matches);");
 source=replace(source,"if(key==='layout'){document.querySelector('[data-layout=\"'+value+'\"]')?.click();return;}","if(key==='layout'){preferences.get(selected).id=value;render(true,false,'draft');return;}");
 source=replace(source,"if(key==='path'&&!value&&driveArmTimer)","if(key==='path'&&!value&&driveArmTimer&&!world.draftManaged)");
 // Managed previews already publish state and draw through the bridge. Avoid
 // a second full render and vertex-projection audit in the Traffic click task.
 source=replace(source,"if(key==='traffic'){trafficSystem?.setEnabled(value);world.renderFrame();preview.dataset.audit=JSON.stringify(world.audit());return;}","if(key==='traffic'){trafficSystem?.setEnabled(value);if(!world.draftManaged){world.renderFrame();preview.dataset.audit=JSON.stringify(world.audit());}return;}");
 source=replace(source,"param(key,value){document.documentElement.dataset.choiceInput='pointer';","param(key,value,{sound=false,animate=true}={}){document.documentElement.dataset.choiceInput='pointer';");
 source=replace(source,"if(key==='path'&&!query.has('qa')","if(sound&&key==='path'&&!query.has('qa')");
 source=replace(source,'playPathSound,stopPathSound','playPathSound,playPathExitSound,stopPathSound');
 source=replace(source,'if(value)playPathSound();else stopPathSound();','if(value)playPathSound();else playPathExitSound();');
 source=replace(source,'versionFeatures.set({[key]:value});','versionFeatures.set({[key]:value},{animate});');
 source=replace(source,'scene(key){const button=sceneButtons.get(key);','scene(key){stopPathSound();const button=sceneButtons.get(key);');
 source=replace(source,"preferences.get('junction').junctionPosition=query.get('position')==='approaching'||(first.key==='junction'&&query.get('view')==='low'&&!query.has('position'))?'approaching':'near';","preferences.get('junction').junctionPosition='approaching';");
 source=source.replaceAll("if(!reduced)playThemeSound(theme==='dark');",'').replaceAll("if(mode!==value&&!matchMedia('(prefers-reduced-motion: reduce)').matches)playThemeSound(value==='dark');",'');
 source=replace(source,"mode=value;requestedTheme=value;render(false);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));","mode=value;requestedTheme=value;render(false);");
 // Traffic is part of the initial scene, including its final shader variants.
 // Wait inside the existing preparation lifecycle before any warm or visible frame.
 source=replace(source,'try{let requested;',`try{
  const trafficPreparation=world.draftPrepareInitialTraffic?.();
  trafficPreparation?.catch(()=>{});
  let requested;`);
 source=replace(source,'requested=state();await world.prepareInitialScene(requested);','requested=state();await world.prepareInitialScene(requested);await trafficPreparation;');
 // The prepared frame is already complete. The parent applies its saved
 // settings and presents the visible frame; no extra RAF/render is needed here.
 source=replace(source,'await new Promise(requestAnimationFrame);world.renderFrame();','if(!world.draftManaged){await new Promise(requestAnimationFrame);world.renderFrame();}');
 source=replace(source,"window.dispatchEvent(new Event('studio:ready'));","window.dispatchEvent(new Event('studio:ready'));window.parent.postMessage({type:'ui-draft-ready'},location.origin);");
 // The parent completes saved settings and raster sizing before publishing its first frame.
 source=replace(source,"preview.setAttribute('aria-busy',String(world.initializingScene||","preview.setAttribute('aria-busy',String(world.draftInitialFrameReady!==true||world.initializingScene||");
 source=replace(source,'function rememberPreview(immediate=false){',"function rememberPreview(immediate=false){if(query.get('review')==='ui-draft')return;");
 // Restore a scene's saved settings before constructing it. This avoids the
 // old scene render followed by one render/two RAFs for every saved parameter.
 source=replace(source,'if(vehicleReady&&!versionFeatures.animating()','if(!world.draftManaged&&vehicleReady&&!versionFeatures.animating()');
 source=replace(source,'function active(){return structures.find(s=>s.key===selected);}', 'function active(scene=selected){return structures.find(s=>s.key===scene);}');
 source=replace(source,'function state(){const st={...preferences.get(selected),mode,vehicle:true};for(const key of environmentIds)st[key]=!!active()[key]&&!!st[key];if(selected===\'road\')st.id=st.laneCount===2?\'09\':\'02\';return st;}', 'function state(scene=selected,preference=preferences.get(scene)){const st={...preference,mode,vehicle:true};for(const key of environmentIds)st[key]=!!active(scene)[key]&&!!st[key];if(scene===\'road\')st.id=st.laneCount===2?\'09\':\'02\';return st;}');
 source=replace(source,' warmVehicle,',` warmVehicle,
 ensureFullVehicle,
 scheduleFullVehicleUpgrade,
 async loadVehicleChoice(id){
  const release=vehicleCache.retain(id);
  try{await vehicleCache.get(id);return release;}
  catch(error){release();throw error;}
 },
 prefetchVehicles(ids=vehicleCatalog.map(({id})=>id)){return prefetchVehicleFiles(ids,{needsModel:id=>id!==selectedVehicle&&!vehicleCache.peek(id)&&!vehicleCache.stats().pending.includes(id)});},
 startupAudit(){return {readiness:world.draftStartupReadiness,cache:vehicleCache.stats(),appearancePreparations:world.draftAppearancePreparations||0,vehiclePerformance:JSON.parse(preview.dataset.vehiclePerformance||'[]')};},
 async prepareDraftLayout(value){
  preferences.get(selected).id=value;
  const previousRoot=world.root,initializing=world.initializingScene;world.initializingScene=true;
  try{await world.prepareInitialScene(state());}finally{world.initializingScene=initializing;}
  render(true,false,'draft');if(world.root!==previousRoot)world.continuousDrive?.rebind();
 },
 setDraftCameraView(value){preferences.get(selected).cameraView=value;world.state.cameraView=value;},
 async prepareDraftScene(key,values,commitMotion){
  if(!preferences.has(key))throw Error('Unknown draft scene');
  const preference={...preferences.get(key)};
  Object.assign(preference,{id:values.layout||preference.id,laneCount:Number(values.lanes)||6,cameraView:values.camera||'low'});
  for(const name of environmentIds)if(name in values)preference[name]=!!values[name];
  if(['parking','outdoor'].includes(key))preference.id=({parking:{default:'10',raised:'16',bev:'14'},outdoor:{default:'17',raised:'18',bev:'19'}}[key][values.camera]||preference.id);
  if(key==='junction'){preference.junctionPosition='approaching';preference.cameraView='low';}
  const previousRoot=world.root,previousState=world.state,initializing=world.initializingScene;world.initializingScene=true;
  try{await world.prepareInitialScene(state(key,preference));}
  catch(error){
   const failedRoot=world.root;
   if(previousState){
    if(failedRoot!==previousRoot&&![...world.sceneCache.values()].some(entry=>entry.fields.root===failedRoot))world.disposeSceneRoot(failedRoot);
    try{await world.prepareInitialScene(previousState);}
    catch(cause){throw Object.assign(Error('The scene could not be restored.',{cause}),{sceneUnrecoverable:true});}
   }
   throw error;
  }finally{world.initializingScene=initializing;}
  cancelDriveArming();if(commitMotion)commitMotion();else continuousDrive?.reset();selected=key;Object.assign(preferences.get(key),preference);
  versionFeatures.set({path:!!values.path,weather:values.weather||'default'},{animate:false,render:false});
  trafficSystem?.setEnabled(!!values.traffic);
  render(true,false,'draft');if(world.root!==previousRoot)world.continuousDrive?.rebind();
 },`);
 source=replace(source,"if(animate&&vehicleReady&&!reduced&&!cameraMotion", "if(animate&&motion!=='draft'&&vehicleReady&&!reduced&&!cameraMotion");
 source=replace(source,"window.dispatchEvent(new Event('layout:ready'));","world.draftScheduleFullVehicle=scheduleFullVehicleUpgrade;installDraftBridge({world,features:versionFeatures,drive:continuousDrive,traffic:trafficSystem,api:window.layoutEngine,current:()=>selected,updateURL});\nwindow.dispatchEvent(new Event('layout:ready'));");
 source=replace(source,"const r=preview.getBoundingClientRect();preview.dataset[kind+'MotionRect']=JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});","if(!world.draftManaged){const r=preview.getBoundingClientRect();preview.dataset[kind+'MotionRect']=JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});}");
 return source;
}

export function patchVehicleMaterials(source){
 source="import {yieldSceneTask} from '../../../ui-draft/scene-preparation.js';\n"+source;
 source=replace(source,'export function prepareVehicleMaterials(model,id,length){','export async function prepareVehicleMaterials(model,id,length){');
 // The model is still offscreen. Preserve traversal order and every per-mesh
 // operation, yielding only between meshes so input/rendering can make progress.
 source=replace(source,` model.traverse(mesh=>{
  if(!mesh.isMesh)return;`, ` const meshes=[];model.traverse(mesh=>{if(mesh.isMesh)meshes.push(mesh);});
 let sliceStart=performance.now();
 for(const mesh of meshes){
  if(performance.now()-sliceStart>=4){await yieldSceneTask();sliceStart=performance.now();}`);
 source=replace(source,' });\n prepareFrontGrilles(model,id);',' }\n prepareFrontGrilles(model,id);');
 return source;
}

export function patchPreparedVehicleDownload(source){
 source="import {fetchVehicleAsset} from '../../../ui-draft/vehicle-prefetch.js';\n"+source;
 return replace(source,'const response=await fetch(url,{signal});if(!response.ok)throw Error(`Vehicle download failed (${response.status})`);\n let bytes=await response.arrayBuffer();',`const early=globalThis.__draftPreparedVehicle;
 if(early?.id===id)delete globalThis.__draftPreparedVehicle;
 let bytes=await fetchVehicleAsset(url,early?.id===id?early.request:undefined);`);
}

export function patchX6VehicleDownload(source){
 source="import {fetchVehicleAsset} from '../ui-draft/vehicle-prefetch.js';\n"+source;
 return replace(source,"const compressed=await takePrefetched(startup?'__startupVehicleRequest':'__fullVehicleRequest',()=>fetchAsset(new URL(startup?'./ego-vehicle-startup.glb.gz?v=17.9':'./ego-vehicle-ready.glb.gz?v=17.9',import.meta.url)));",`const url=new URL(startup?'./ego-vehicle-startup.glb.gz?v=17.9':'../ui-draft/vehicles/x6/model.glb.gz?v=x6-lossless-20261104',import.meta.url);
 const early=globalThis.__fullVehicleRequest;
 if(!startup)delete globalThis.__fullVehicleRequest;
 const compressed=await (startup?takePrefetched('__startupVehicleRequest',()=>fetchAsset(url)):fetchVehicleAsset(url,early));`);
}

export function patchLoadPrepared(source){
 source=replace(source,'../prepared/${id}/model.glb.gz',"../../../ui-draft/vehicles/${id}/model.glb.gz?v=${id==='x6'?'x6-lossless-20261104':'restore26'}");
 source="import {loadFramingHull} from '../../../ui-draft/framing-data.js';\n"+patchPreparedVehicleDownload(source);
 source=replace(source,'const early=globalThis.__draftPreparedVehicle;', 'const hullRequest=loadFramingHull(id);const early=globalThis.__draftPreparedVehicle;');
 source=replace(source,',signal}={})', '}={})');
 return replace(source,'const surfaces=prepareVehicleMaterials(model,id,spec.length);',`const surfaces=await prepareVehicleMaterials(model,id,spec.length);
 const hulls=await hullRequest,meshes=[];model.traverse(mesh=>{if(mesh.isMesh)meshes.push(mesh);});
 if(hulls?.length===meshes.length&&meshes.every((mesh,index)=>mesh.name===hulls[index].name&&mesh.geometry.attributes.position.count===hulls[index].count)){
  meshes.forEach((mesh,index)=>{const indices=hulls[index].indices;if(indices?.length)mesh.geometry.userData.frameIndices=indices;});
 }`);
}

export function patchLaneGeometry(source){
 // Output color space selects a shader variant. Compile for the same target as
 // the warm draw, restoring the live output before any asynchronous wait.
 return replace(source,'await renderer.compileAsync(scene,world.camera);await yieldControl();',`const compileTarget=renderer.getRenderTarget();let compilation;
  try{renderer.setRenderTarget(target);compilation=renderer.compileAsync(scene,world.camera);}finally{renderer.setRenderTarget(compileTarget);}
  await compilation;await yieldControl();`);
}

export function patchVehiclePreparation(source){
 // Suspension also covers a hidden document and offscreen scene preparation.
 // Only a lost WebGL context makes vehicle preparation unusable.
 return source.replaceAll("if(world.suspended)throw Error('The 3D view is interrupted');",
  "if(renderer.getContext().isContextLost())throw Error('The 3D view is interrupted');");
}

export function patchRendererPreparation(source){
 source="import {batchPreparationJobs,attachPreparationBatch} from '../ui-draft/preparation-batches.js';\n"+source;
 source=replace(source,' const {renderer,scene}=world,jobs='," const phaseStart=performance.now();const {renderer,scene}=world,jobs=");
 source=replace(source,' await yieldToBrowser();\n world.preparedMaterials='," performance.measure('studio-warm-record',{start:phaseStart,detail:{jobs:jobs.length,batches:batchPreparationJobs(jobs).length}});const compileStart=performance.now();await yieldToBrowser();\n world.preparedMaterials=");
 source=replace(source,'await Promise.all(pending);sliceStart=performance.now();',"await Promise.all(pending);performance.measure('studio-warm-compile',{start:compileStart});const drawStart=performance.now();sliceStart=drawStart;");
 source=replace(source,' }finally{for(const target of targets.values())target.dispose();}'," performance.measure('studio-warm-draw',{start:drawStart});\n }finally{for(const target of targets.values())target.dispose();}");
 source="import {yieldSceneTask} from '../ui-draft/scene-preparation.js';\n"+source;
 source=replace(source,'const yieldToBrowser=()=>new Promise(resolve=>setTimeout(resolve,0));','const yieldToBrowser=yieldSceneTask;');
 // Warm proxies need object metadata references, not a JSON serialization of
 // scene-owned geometry/textures. Keep the source intact even if cloning fails.
 source=replace(source,'const yieldToBrowser=',`function clonePassObject(object){
 const userData=object.userData;let copy;object.userData={};
 try{copy=object.clone(false);}finally{object.userData=userData;}
 copy.userData={...userData};return copy;
}
const yieldToBrowser=`);
 source=replace(source,'const proxy=object.clone(false);','const proxy=clonePassObject(object);');
 source=replace(source,'targetScene.clone(false)','clonePassObject(targetScene)');
 // Fullscreen passes own a light-free scene. Adding the world's lights creates
 // different programs from the actual pass after a scene/light transition.
 source=replace(source,'scene.traverseVisible(light=>','(targetScene||scene).traverseVisible(light=>');

 source=replace(source,'material.uuid,material.side,material.defines','material.uuid,material.side,material.transparent,material.depthWrite,material.defines');
 // Scene switches suspend visible draws. Recording still needs to traverse the
 // incoming scene; restore suspension synchronously before preparation yields.
 source=replace(source,'try{world.renderFrame();}finally{renderer.renderBufferDirect=draw;',
  `const suspended=world.suspended,render=renderer.render;
 renderer.render=function(...args){const passHidden=[],culled=[];scene.traverse(object=>{if(!object.visible){passHidden.push(object);object.visible=true;}if(object.isMesh&&object.frustumCulled){culled.push(object);object.frustumCulled=false;}});try{return render.apply(this,args);}finally{for(const object of passHidden)object.visible=false;for(const object of culled)object.frustumCulled=true;}};
 try{world.suspended=false;world.renderFrame();world.draftRecordStartupVariants?.(()=>world.renderFrame());}finally{world.suspended=suspended;renderer.render=render;renderer.renderBufferDirect=draw;`);
 // Keep both traffic variants on the live material. Hidden cars do not take
 // ownership of a program during the final frame, so disposing proxy copies
 // would otherwise evict their base program before the first reveal.
 source=replace(source,'if(material.isShaderMaterial){','if(material.userData.trafficRole||material.userData.draftTrafficPreparation)copy=material;else if(material.isShaderMaterial){');
 source=replace(source,'jobs.push({camera,scene:contexts.get(targetScene),target:warmTarget,proxy,material:copy});',`jobs.push({camera,scene:contexts.get(targetScene),target:warmTarget,proxy,material:copy,liveMaterial:!!(material.userData.trafficRole||material.userData.draftTrafficPreparation)});
  if(material.userData.trafficRole){
   const fading=clonePassObject(proxy);fading.material=material;
   jobs.push({camera,scene:contexts.get(targetScene),target:warmTarget,proxy:fading,material,liveMaterial:true,trafficFade:true,baseTransparent:material.transparent});
  }`);
 source=replace(source,'jobs.map(job=>job.material)','jobs.filter(job=>!job.liveMaterial).map(job=>job.material)');
 source=replace(source,'const previous=renderer.getRenderTarget();renderer.setRenderTarget(job.target);','const previous=renderer.getRenderTarget(),transparent=job.material.transparent;if(job.trafficFade)job.material.transparent=!job.baseTransparent;renderer.setRenderTarget(job.target);');
 source=replace(source,'job.proxy.removeFromParent();renderer.setRenderTarget(previous);}', 'job.proxy.removeFromParent();job.material.transparent=transparent;renderer.setRenderTarget(previous);}');
 source=replace(source,'const previous=renderer.getRenderTarget();\n  const viewport=', 'const previous=renderer.getRenderTarget(),transparent=job.material.transparent;if(job.trafficFade)job.material.transparent=!job.baseTransparent;\n  const viewport=');
 source=replace(source,'job.proxy.removeFromParent();renderer.setRenderTarget(previous);renderer.setViewport(viewport);','job.proxy.removeFromParent();job.material.transparent=transparent;renderer.setRenderTarget(previous);renderer.setViewport(viewport);');
 // The recorded jobs already contain the shadow passes. A one-pixel colour
 // warm draw must not allocate and redraw a full shadow atlas for every proxy.
 source=replace(source,'renderer.setRenderTarget(job.target);renderer.setViewport(0,0,1,1);renderer.shadowMap.needsUpdate=false;',
  'const shadowAutoUpdate=renderer.shadowMap.autoUpdate,shadowNeedsUpdate=renderer.shadowMap.needsUpdate;renderer.setRenderTarget(job.target);renderer.setViewport(0,0,1,1);renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=false;');
 source=replace(source,'renderer.setViewport(viewport);renderer.shadowMap.needsUpdate=true;',
  'renderer.setViewport(viewport);renderer.shadowMap.autoUpdate=shadowAutoUpdate;renderer.shadowMap.needsUpdate=shadowNeedsUpdate;');
 // Group equivalent pass contexts instead of repeating renderer traversal for
 // every individual material. Each mesh and exact shader variant is retained.
 source=source.replaceAll('for(const job of jobs){','for(const job of batchPreparationJobs(jobs)){');
 source=source.replaceAll('job.scene.add(job.proxy);','const detach=attachPreparationBatch(job);');
 source=source.replaceAll('job.proxy.removeFromParent();','detach();');
 source=source.replaceAll(',transparent=job.material.transparent;if(job.trafficFade)job.material.transparent=!job.baseTransparent;', ';');
 source=source.replaceAll('job.material.transparent=transparent;','');
 // Separate CPU work from asynchronous shader completion in diagnostics.
 source=replace(source,'const compileStart=performance.now();','const compileStart=performance.now(),compileBatches=[],drawBatches=[];');
 source=source.replaceAll('const detach=attachPreparationBatch(job);','const batchStart=performance.now(),programsBefore=(renderer.info?.programs?.length||0);const detach=attachPreparationBatch(job);');
 source=replace(source,'pending.push(renderer.compileAsync(job.scene,job.camera));','pending.push(renderer.compileAsync(job.scene,job.camera));compileBatches.push({jobs:job.jobs.length,cpu:performance.now()-batchStart,newPrograms:(renderer.info?.programs?.length||0)-programsBefore});');
 source=replace(source,"performance.measure('studio-warm-compile',{start:compileStart})","performance.measure('studio-warm-compile',{start:compileStart,detail:{batches:compileBatches,programs:(renderer.info?.programs?.length||0)}})");
 source=replace(source,'try{renderer.render(job.scene,job.camera);}finally{','const savedGeoms=new Map(),savedInst=new Map();for(const item of job.jobs){const p=item.proxy,g=p?.geometry;if(g?.drawRange&&!savedGeoms.has(g)){savedGeoms.set(g,[g.drawRange.start,g.drawRange.count]);const maxCount=g.index?g.index.count:g.attributes?.position?.count;if(maxCount>3)g.drawRange={start:0,count:3};}if(p?.isInstancedMesh&&p.count>1&&!savedInst.has(p)){savedInst.set(p,p.count);p.count=1;}}try{renderer.render(job.scene,job.camera);drawBatches.push({jobs:job.jobs.length,cpu:performance.now()-batchStart,newPrograms:(renderer.info?.programs?.length||0)-programsBefore});}finally{for(const [g,[s,c]] of savedGeoms)g.drawRange={start:s,count:c};for(const [p,c] of savedInst)p.count=c;');
 source=replace(source,"performance.measure('studio-warm-draw',{start:drawStart})","performance.measure('studio-warm-draw',{start:drawStart,detail:{batches:drawBatches,programs:(renderer.info?.programs?.length||0)}})");
 return source;
}

export function isolatedRuntimePlugin(){return {name:'isolated-ui-draft',setup(build){build.onLoad({filter:/\/engine\/.*\.js$/},async args=>{
 let source=await readFile(args.path,'utf8');const name=args.path.split('/engine/').at(-1);
 if(name==='export-scene.js'){
  source=replace(source,'const {camera,car}=world;','const exportSize={width:world.width,height:world.height};const {camera,car}=world;');
  source=replace(source,'function projectedSegment(start,end,camera){','function projectedSegment(start,end,camera,exportSize){');
  source=replace(source,'const {car,camera}=world,height=surfaceHeight(world),lines=[];','const exportSize={width:world.width,height:world.height};const {car,camera}=world,height=surfaceHeight(world),lines=[];');
  source=source.replaceAll('projectedSegment(start,end,camera)','projectedSegment(start,end,camera,exportSize)').replace('height+.025,car.position.z-18+end[1]],camera);','height+.025,car.position.z-18+end[1]],camera,exportSize);');
  source=replace(source,'width="1920" height="1080" viewBox="0 0 1920 1080"','width="${exportSize.width}" height="${exportSize.height}" viewBox="0 0 ${exportSize.width} ${exportSize.height}"');
  source=replace(source,'{width,height}=exportSize;','{width,height}=world;');
 }
 // The versioned browser import and the parking imports share this module in a bundle.
 if(name==='world.js')source=replace(source,"'./ground-reflection.js?v=139'","'./ground-reflection.js'");
 if(name==='app.js')source=patchApp(source).replaceAll('./vehicle-library/prepared/${id}/model.glb.gz',"../ui-draft/vehicles/${id}/model.glb.gz?v=${id==='x6'?'x6-lossless-20261104':'restore26'}");
 if(name==='vehicle.js'){
  source=patchX6VehicleDownload(source);
  source=replace(source,"import frameHulls from './vehicle-frame-hull.js';","import {loadFramingHull} from '../ui-draft/framing-data.js';");
  source=replace(source,'export async function createVehicle({startup=false}={}){',"export async function createVehicle({startup=false}={}){\n const hullRequest=startup?Promise.resolve(null):loadFramingHull('x6');");
  source=replace(source,'let frameIndex=0;','const frameHulls=await hullRequest||[];let frameIndex=0;');
 }
 // The parent owns the visible vehicle selector; do not build a second hidden picker.
 if(name==='vehicle-cache.js')source=replace(source,'  activate(id){','  replace(id,root){const prev=entries.get(id);entries.set(id,{root,bytes:estimate(root)});if(prev&&prev.root!==root)dispose(prev.root);trim(id);},\n  activate(id){');
 if(name==='vehicle-selector.js')source="import {createVehicleSelection} from '../ui-draft/vehicle-selection.js';\n"+replace(source," const element=(tag,className,text)=>"," if(new URLSearchParams(location.search).get('review')==='ui-draft')return createVehicleSelection({selected,onChange,ids:vehicleCatalog.map(model=>model.id)});\n const element=(tag,className,text)=>");
 if(name==='vehicle-library/three/vehicle-materials.js')source=patchVehicleMaterials(source);
 if(name==='vehicle-library/three/load-prepared.js')source=patchLoadPrepared(source);
 if(name==='lane-geometry-cache.js')source=patchLaneGeometry(source);
 if(name==='prepare-renderer.js')source=patchRendererPreparation(source);
 if(name==='prepare-vehicle-choice.js')source=patchVehiclePreparation(source);
 if(name==='version-features.js')source=patchFeatures(source);
 if(name==='sr-road-sheen.js'){
  source=replace(source,'  shader.uniforms.srRoadTone=world.environmentTone;',`  shader.uniforms.srRoadTone=world.environmentTone;
  shader.uniforms.draftReflectionWet=world.draftReflectionWet??={value:0};`);
  source=replace(source,'uniform float srRoadTone;uniform vec3 srRoadSky;','uniform float srRoadTone;uniform float draftReflectionWet;uniform vec3 srRoadSky;');
  source=replace(source,'vec3 srSatin=mix(srAsphalt,vec3(srSkyLuma*.30),srFresnel*.42);',`float wetDay=draftReflectionWet*(1.-srRoadTone);
   vec3 reflectedSky=mix(vec3(srSkyLuma*.30),srRoadSky*.58,wetDay);
   vec3 srSatin=mix(srAsphalt,reflectedSky,srFresnel*mix(.42,.68,wetDay));`);
 }
 if(name==='sr-quality.js')source=source.replaceAll("'material-draft'","'ui-draft'");
 if(name==='road-layout-morph.js'){
  // BufferGeometry.copy shares userData with its template. A role marker can
  // therefore survive on a later clone whose vertex attribute was never set.
  source=replace(source,'if(o.geometry.userData.roadLayoutRole===role)return;',"if(o.geometry.userData.roadLayoutRole===role&&o.geometry.getAttribute('roadLayoutRole')?.count===o.geometry.attributes.position.count)return;");
  source=replace(source,"o.geometry.setAttribute('roadLayoutRole'","o.geometry.userData={...o.geometry.userData};\n  o.geometry.setAttribute('roadLayoutRole'");
 }
 if(name==='activation-sweep.js')source=replace(source,"uniforms.tone.value=world.state.mode==='dark'?1:0;","uniforms.tone.value=world.draftThemeTone?.value??(world.state.mode==='dark'?1:0);");
 if(name==='weather-ground.js')source=refineSnowGround(refineRainGround(source)).replace('uniforms.weatherTone.value=dark?1:0;','uniforms.weatherTone.value=world.draftThemeTone?.value??(dark?1:0);');
 if(name==='activation-sweep.js')source=refineActivation(source).replaceAll('performance.now()','(world.draftTime??performance.now())');
 if(name==='parking-reference.js'){source="import {createIndoorDetails} from '../ui-draft/parking-materials.js';\n"+source;source=replace(source,'world.parkingReplica={','createIndoorDetails(world);world.parkingReplica={');}
 if(name==='continuous-driving.js'){
  // Recycled scenery owns temporary materials so a fade never changes the
  // shared materials on already-visible buildings or trees.
  source=replace(source,'function restore(){',`const fadeDistance=220;
 function clearFade(group){for(const entry of group.fadeMaterials||[]){entry.mesh.material=entry.original;for(const material of entry.copies)material.dispose();}group.fadeMaterials=null;group.fadeStart=null;}
 function finishFade(group){for(const entry of group.fadeMaterials)entry.mesh.material=entry.original;group.fadeStart=null;}
 function updateFade(group){if(group.fadeStart==null)return;const t=Math.min(1,Math.max(0,(distance-group.fadeStart)/fadeDistance));if(t>=1){finishFade(group);return;}const alpha=t*t*(3-2*t);for(const entry of group.fadeMaterials)entry.copies.forEach((material,index)=>{const original=Array.isArray(entry.original)?entry.original[index]:entry.original;material.color?.copy(original.color);material.roughness=original.roughness;material.metalness=original.metalness;material.opacity=original.opacity*alpha;});}
 function beginFade(group){if(group.fadeMaterials){for(const entry of group.fadeMaterials){entry.mesh.material=Array.isArray(entry.original)?entry.copies:entry.copies[0];entry.copies.forEach((material,index)=>{const original=Array.isArray(entry.original)?entry.original[index]:entry.original;material.color?.copy(original.color);material.roughness=original.roughness;material.metalness=original.metalness;material.opacity=0;});}group.fadeStart=distance;return;}group.fadeMaterials=[];for(const item of group.items)item.object.traverse(mesh=>{if(!mesh.isMesh||!mesh.material)return;const original=mesh.material,materials=Array.isArray(original)?original:[original],copies=materials.map(material=>{const copy=material.clone();copy.onBeforeCompile=material.onBeforeCompile;copy.customProgramCacheKey=material.customProgramCacheKey;copy.transparent=true;copy.opacity=0;copy.depthWrite=false;return copy;});mesh.material=Array.isArray(original)?copies:copies[0];group.fadeMaterials.push({mesh,original,copies,base:materials.map(material=>material.opacity)});});group.fadeStart=distance;}
 function restore(){for(const group of groups)clearFade(group);`);
  source=replace(source,'group.z-=span;recycled++;',"const crossing=distance-(group.z-exit);group.z-=span;recycled++;if(group.kind==='building'||group.kind==='tree'){beginFade(group);group.fadeStart=crossing;}");
  source=replace(source,'  for(const item of marks)item.object.position.z=item.position.z+(distance%10);','  for(const group of groups)updateFade(group);\n  for(const item of marks)item.object.position.z=item.position.z+(distance%10);');
  source="import {roadCruiseSpeed} from '../ui-draft/junction-playback.js';\n"+source;
  source=replace(source,'const span=420,exit=65,speed=16.8;','const span=420,exit=65;let speed=null;');
  source=replace(source,'bind();const delta=Math.max(0,Math.min(.1,dt))*speed;distance+=delta;',`bind();const seconds=Math.max(0,Math.min(.1,dt)),reference=roadCruiseSpeed(world),prior=speed??reference;let target=reference;const traffic=world.trafficSystem?.audit();if(traffic?.visible)for(let i=0;i<traffic.positions.length;i++){const p=traffic.positions[i],lane=traffic.lanes[i],gap=world.car.position.z-p[2];if(lane.direction<0&&Math.abs(p[0]-world.car.position.x)<1.7&&gap>0)target=Math.min(target,Math.max(0,lane.speed+(gap-(6+prior*1.5))/3));}speed=prior+Math.max(-2.2*seconds,Math.min(.9*seconds,target-prior));const delta=(prior+speed)*.5*seconds;distance+=delta;world.draftCruiseSpeed=speed;`);
  source=replace(source,'pause();restore();distance=0;recycled=0;', 'pause();restore();distance=0;recycled=0;speed=null;world.draftCruiseSpeed=null;');
  // Rebind restores the outgoing root after world.lawns points at the incoming
  // root. Keep the outgoing registry so recycled clones cannot leak into caches.
  source=replace(source,"groups=[],marks=[],clones=[],distance=0", "groups=[],marks=[],clones=[],boundLawns=null,boundScene=null,distance=0");
  source=replace(source,"world.lawns?.indexOf(clone)","boundLawns?.indexOf(clone)");
  source=replace(source,"world.lawns.splice(index,1)","boundLawns.splice(index,1)");
  source=replace(source,"['02','09'].includes(root.userData?.trafficScene)","['02','09'].includes(boundScene)");
  source=replace(source,"rootKey=key;if(!root)return;","rootKey=key;boundLawns=world.lawns;boundScene=world.state?.id;if(!root)return;if(!['02','09','03','06','07'].includes(boundScene)){distance=0;return;}");
  // Mesh.clone does not copy custom shadow materials. Recycled tree copies
  // otherwise cast from the target lane position while their canopy morphs.
  source=replace(source,'const clone=item.object.clone(true);clone.position.z-=210;',`const clone=item.object.clone(true);const originals=[];item.object.traverse(object=>originals.push(object));let shadowIndex=0;clone.traverse(object=>{const original=originals[shadowIndex++];if(object.isMesh){object.customDepthMaterial=original.customDepthMaterial;object.customDistanceMaterial=original.customDistanceMaterial;}});clone.position.z-=210;`);
  // Binding adds scenery copies after the root's first capture. Refresh the
  // existing targets once so paused first frames include those same objects.
  source=replace(source,'world.drivingDistance=distance;\n\n }','world.drivingDistance=distance;world.shadowKey=null;world.groundReflectionKey=null;world.carReflectionKey=null;\n\n }');
  // Recycled buildings pivot their width around the facade beside the lawn.
  source=replace(source,"group.identity=[group.kind", "if(group.kind==='building')group.front=Math.min(...group.items.map(item=>{const b=item.object.geometry.boundingBox;return Math.abs(item.position.x)-Math.max(Math.abs(b.min.x),Math.abs(b.max.x))*item.scale.x;}));\n   group.identity=[group.kind");
  source=replace(source,"const lateral=group.kind==='building'?(random()-.5)*2:0;","const lateral=group.kind==='building'?Math.sign(group.x)*(width-1)*(Math.abs(group.x)-group.front):0;");

  source=source.replaceAll("['02','09','03'].includes(world.state?.id)","['02','09','03','06','07'].includes(world.state?.id)");
  source=source.replaceAll('if(!hidden())frame=schedule(tick)','if(!world.draftManaged&&!hidden())frame=schedule(tick)').replaceAll('if(playing&&!hidden())frame=schedule(tick)','if(playing&&!world.draftManaged&&!hidden())frame=schedule(tick)');
  source=replace(source,'return {setPlaying,pause,reset,advance,',`return {seekDraftDistance(value,velocity){
   bind();distance=value;speed=velocity;world.draftCruiseSpeed=speed;
   for(const group of groups){
    const start=group.items.reduce((sum,item)=>sum+item.position.z,0)/group.items.length;
    let z=start+distance;
    const cycles=Math.max(0,Math.ceil((z-exit)/span));
    z-=span*cycles;
    if(group.kind==='building'||group.kind==='tree'){
     const recycleAt=exit-start+(cycles-1)*span;
     if(cycles&&distance<recycleAt+fadeDistance){
      if(group.fadeStart==null)beginFade(group);
      group.fadeStart=recycleAt;
      updateFade(group);
     }else if(group.fadeStart!=null)finishFade(group);
    }
    group.z=z;
    for(const item of group.items)item.object.position.z=item.position.z+z-start;
   }
   for(const item of marks)item.object.position.z=item.position.z+distance%10;
   world.drivingDistance=distance;world.drivingFrame=Math.floor(distance*2);
  },draftCapture:()=>({distance,recycled,speed,z:groups.map(group=>group.z),fades:groups.map(group=>group.fadeStart??null)}),draftRestore(snapshot){distance=snapshot.distance;recycled=snapshot.recycled;speed=snapshot.speed;world.draftCruiseSpeed=speed;groups.forEach((group,index)=>{const start=snapshot.fades?.[index];if(start!=null){if(group.fadeStart==null)beginFade(group);group.fadeStart=start;updateFade(group);}else{for(const entry of group.fadeMaterials||[])entry.mesh.material=entry.original;group.fadeStart=null;}});snapshot.z.forEach((z,index)=>{if(groups[index])groups[index].z=z});world.drivingDistance=distance;world.drivingFrame=Math.floor(distance*2);},setPlaying,pause,reset,advance,`);
 }
 if(name==='continuous-driving.js')source=source.replaceAll('world.drivingFrame=Math.floor(distance*2)','world.drivingFrame=distance');
 if(name==='environment-finish.js'){
  source=replace(source,'bounds.setFromObject(block);',"bounds.setFromObject(block);if(world.layoutMotion)bounds.translate(layoutOffset.set((world.layoutVisual.width-world.layoutMotion.to.width)*Math.sign(block.position.x)/2,0,0));");
  source=replace(source,'const amount={value:strength};','const amount={value:strength},junctionFacade=world.draftJunctionFacade??={value:0},darkFacade=world.draftDarkFacade??={value:0},foliageFinish=world.draftFoliageFinish??={value:0},facadeNeutralize=world.draftFacadeNeutralize??={value:0};');
  source=replace(source,'shader.uniforms.finishTone=world.environmentTone;','shader.uniforms.finishTone=world.environmentTone;shader.uniforms.junctionFacade=junctionFacade;shader.uniforms.draftDarkFacade=darkFacade;shader.uniforms.foliageFinish=foliageFinish;shader.uniforms.draftFacadeNeutralize=facadeNeutralize;');
  source=replace(source,"'uniform float environmentFinishAmount;uniform float finishTone;","'uniform float junctionFacade;uniform float draftDarkFacade;uniform float foliageFinish;uniform float draftFacadeNeutralize;uniform float environmentFinishAmount;uniform float finishTone;");
  source=replace(source,'${shaping}',"${shaping}\n    ${kind==='leaf'||kind==='leaf2'?'outgoingLight=mix(outgoingLight,vec3(dot(outgoingLight,vec3(.2126,.7152,.0722))),foliageFinish);':''}");
  source=replace(source,'float finishVolume=.94+.08*finishUpper-.05*finishBase;','float finishVolume=.94+.08*finishUpper-.22*finishBase;');
  source=replace(source,'finishContact=max(finishContact,.24*exp(-separation/.85)',"finishContact=max(finishContact,${kind==='ground'?'.32':'.24'}*exp(-separation/.85)");
  source=replace(source,'outgoingLight*=mix(1.,finishVolume,finishStrength);',`
    outgoingLight*=mix(1.,finishVolume,finishStrength);
    // Match the existing key light so each wall has a consistent orientation.
    float facing=dot(finishNormal,normalize(vec3(-38.,55.,62.)));
    float wallLight=smoothstep(.23,.76,facing);
    float wallShade=mix(.60,.99,wallLight);
    float facadeShade=mix(wallShade,.99,max(finishNormal.y,0.));
    outgoingLight*=mix(1.,facadeShade,junctionFacade);
    float backWall=(1.-smoothstep(-.10,.40,facing))*(1.-abs(finishNormal.y));
    float facadeLuma=dot(outgoingLight,vec3(.2126,.7152,.0722));
    outgoingLight=mix(outgoingLight,vec3(facadeLuma),draftFacadeNeutralize*backWall*step(.0001,environmentFinishAmount));
    // Lower bright upper faces in night mode while retaining the wall relief.
    float roofFacing=smoothstep(.18,.90,finishNormal.y);
    outgoingLight*=mix(1.,mix(.94,.77,roofFacing),draftDarkFacade);
  `.trim());
 }
 if(name==='precipitation.js'){
  source=replace(source,'count:1400,reduced:520','count:800,reduced:300');
  source=replace(source,'size:[.045,.085]','size:[.028,.062]');
  source=replace(source,'gl_PointSize=clamp(px,1.8,12.);','gl_PointSize=clamp(px,1.,5.);');
  source=replace(source,'smoothstep(.35,1.,dot(c,c))','smoothstep(.04,1.,dot(c,c))');

  source=replace(source,'count:1800,reduced:650','count:420,reduced:180');
  source=replace(source,'size:[.32,.58]','size:[.18,.34]');
  source=replace(source,'const t=tone();uniforms.color.value.copy(k.color[t]);uniforms.opacity.value=k.opacity[t]*WEATHER_STRENGTH;',`const blend=world.draftThemeTone?.value??(tone()==='dark'?1:0);
    uniforms.color.value.copy(k.color.light).lerp(k.color.dark,blend);
    uniforms.opacity.value=THREE.MathUtils.lerp(k.opacity.light,k.opacity.dark,blend)*WEATHER_STRENGTH*(kind==='snow'?1.15:1)*(world.draftWeather?.weights[kind]??1);`);
 }
 if(name==='contact-shadows.js'){
  source="import {tireShadowScale} from '../ui-draft/vehicle-reflection-sampling.js';\n"+source;
  source=replace(source,'exp(-dot(p*vec2(1.35,1.05),p*vec2(1.35,1.05))*2.4)*(1.-smoothstep(.65,1.,length(p)))','(1.-smoothstep(.28,1.,r))*(.70+.30*exp(-dot(p*vec2(1.1,.8),p*vec2(1.1,.8))*2.))');

  source=replace(source,'patch(x,z,.56,.80,softBody?.92:.88)','const [width,depth]=tireShadowScale(wheel);patch(x,z,.44*width,.60*depth,.98)');
  source=replace(source,'mesh.position.set(x,.035,z)','mesh.position.set(x,.023,z)');
 }
 if(name==='ground-reflection.js'){
  source=replace(source,"return {blend:.48,floor:.40,ceiling:1.0,heightFade:7.5,soften:.28};","return {blend:.68,floor:.28,ceiling:1.2,heightFade:7.5,soften:.28};");
  source=replace(source,"const satinRoad=SR_QUALITY_MIX>0&&kind==='road';","const satinRoad=SR_QUALITY_MIX>0&&(kind==='road'||custom);");
  source="import {vehicleReflectionSampling} from '../ui-draft/vehicle-reflection-sampling.js';\n"+source;
  source=replace(source,'if(satinRoad){shader.uniforms.vehicleFootprints=',"if(satinRoad){shader.uniforms.draftVehicleMirror=world.draftVehicleMirror??={value:0};shader.uniforms.vehicleFootprints=");
  source=replace(source,"if(satinRoad)shader.fragmentShader='uniform vec4 vehicleFootprints[12];uniform int vehicleReflectionCount;\\n'+shader.fragmentShader;","if(satinRoad)shader.fragmentShader='uniform vec4 vehicleFootprints[12];uniform int vehicleReflectionCount;\\n'+shader.fragmentShader.replace('void main()',vehicleReflectionSampling+'\\nvoid main()');");
  source=replace(source,'vec4 reflectedSample=mix(texture2D(reflectionSharp,reflectionUV),texture2D(reflectionTexture,reflectionUV),smoothstep(.4,5.,reflectedHeight));',"vec4 reflectedSample=${satinRoad?'roughVehicleSample(reflectionUV,'+(custom?'parkingBlurDistance,true':'reflectedHeight,false')+')':'mix(texture2D(reflectionSharp,reflectionUV),texture2D(reflectionTexture,reflectionUV),1.)'};");
  source=replace(source,"${profile.soften?'reflectedSample=", "${profile.soften&&!satinRoad?'reflectedSample=");
  source=replace(source,'valid*=footprintMask*smoothstep(.02,.14,reflectedSample.a);','valid*=footprintMask;');
  // Move the existing footprint calculation ahead of sampling. Its distance is
  // continuous across the car outline, unlike the depth of the mirror capture.
  const start=source.indexOf("${satinRoad?'float footprintMask=0.;");
  const end=source.indexOf("}${satinSurround?",start)+1;
  if(start<0||end===0)throw Error('Vehicle reflection footprint anchor missing');
  const footprints=source.slice(start,end).replace('valid*=footprintMask;','');
  source=source.slice(0,start)+"${satinRoad?'valid*=footprintMask;':''}"+source.slice(end);
  source=replace(source,'vec4 reflectedSample=',footprints+'vec4 reflectedSample=');
  // The first footprint is ego only while ego participates in the capture.
  source=replace(source,'shader.uniforms.vehicleReflectionCount=world.vehicleReflectionCount;', 'shader.uniforms.vehicleReflectionCount=world.vehicleReflectionCount;shader.uniforms.egoReflectionCount=world.draftEgoReflectionCount??={value:0};');
  source=replace(source,'uniform int vehicleReflectionCount;', 'uniform int vehicleReflectionCount;uniform int egoReflectionCount;uniform float mirrorExposure;');
  source=replace(source,'shader.uniforms.egoReflectionCount=','shader.uniforms.mirrorExposure=world.draftMirrorExposure??={value:0};shader.uniforms.egoReflectionCount=');
  source=replace(source,'float footprintMask=0.;',"float footprintMask=0.,egoMask=0.;'+(custom?'float parkingBlurDistance=1.;':'')+'");
  // Extend the asphalt fade toward the vehicle and let it reach zero sooner.
  source=replace(source,'footprintMask=max(footprintMask,(1.-smoothstep(.65,1.,q.x))*(1.-smoothstep(.65,1.,q.y)));',
   "'+(custom?'parkingBlurDistance=min(parkingBlurDistance,max(q.x,q.y));':'')+'bool ego=i<egoReflectionCount;float lengthFade=1.-smoothstep('+(custom?'.46,1.':'.47,.95')+',q.y);float mask=(ego?1.:.42)*(1.-smoothstep('+(custom?'.48':'.58')+',1.,q.x))*lengthFade;if(ego)egoMask=max(egoMask,mask);footprintMask=max(footprintMask,mask);");
  source=replace(source,"${['road','ground','pavement'].some","${!satinRoad&&['road','ground','pavement'].some");
  source=replace(source,'reflectionStrength:world.reflectionStrength??={value:1}', 'reflectionStrength:world.reflectionStrength??={value:1},draftFilteredEnvironment:world.draftFilteredEnvironment??={value:0}');
  source=replace(source,"shader.fragmentShader='uniform sampler2D reflectionDepth;", "shader.fragmentShader='uniform float draftFilteredEnvironment;uniform sampler2D reflectionDepth;");
  source=replace(source,'float proximity=exp(-reflectedHeight/mix(${profile.heightFade.toFixed(2)},9.,reflectionTone));', 'float proximity=${satinRoad?\'1.\':\'draftFilteredEnvironment>.5?1.:exp(-reflectedHeight/mix(\'+profile.heightFade.toFixed(2)+\',9.,reflectionTone))\'};');
  // Match the mirror contrast on both verges. Sun-facing facade radiance must
  // not wash out one side; retain a little facade shading within the same
  // ground-relative response. Night uses a brighter reflected silhouette.
  source=replace(source,'outgoingLight=mix(outgoingLight,clamp(softReflection,',
   'if(draftFilteredEnvironment>.5)softReflection=mix(softReflection,outgoingLight*mix(.58,1.85,reflectionTone),.85);outgoingLight=mix(outgoingLight,clamp(softReflection,');
  source=replace(source,"${satinRoad?'.28':'.55'}","${satinRoad?'.28':'.68'}");
  source=replace(source, 'reflectionTone)*proximity*valid*reflectionStrength);\\n#include <opaque_fragment>', 'reflectionTone)*proximity*valid*reflectionStrength*${satinRoad?"1.":"mix(1.,1.24,reflectionTone)"});\\n#include <opaque_fragment>');
  source=replace(source,"else shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',reflection+`", "else shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',reflection+(satinRoad?'\\n#include <opaque_fragment>':`");
  source=replace(source,'\\n#include <opaque_fragment>`);','\\n#include <opaque_fragment>`));');

  source=replace(source,"if(custom)shader.fragmentShader=shader.fragmentShader.replace('gl_FragColor=vec4(surface,1.);',reflection+'surface=mix","if(custom)shader.fragmentShader=shader.fragmentShader.replace('gl_FragColor=vec4(surface,1.);',reflection+(satinRoad?'gl_FragColor=vec4(surface,1.);':'surface=mix");
  source=replace(source,"*valid*reflectionStrength);gl_FragColor=vec4(surface,1.);');","*valid*reflectionStrength);gl_FragColor=vec4(surface,1.);'));");
  source=replace(source,' material.customProgramCacheKey=',`  if(satinRoad){
   const compile=material.onBeforeCompile;
   material.onBeforeCompile=shader=>{
    compile(shader);
    const gain=custom?'mix(1.,1.3,indoor)':'max(1.,1.2*egoMask/max(footprintMask,.0001))';
    const composite='vec3 reflectedFloor=compositeVehicleReflection(gl_FragColor.rgb,linearToOutputTexel(vec4(softReflection,1.)).rgb,valid,reflectionTone,reflectionStrength,'+gain+','+custom+',mirrorExposure*egoMask);';
    // Apply a further 15% reduction to the previous asphalt blend of .65.
    const response=composite+(custom
     ? 'vec3 delta=reflectedFloor-gl_FragColor.rgb;gl_FragColor.rgb+=min(delta,vec3(0.))+max(delta,vec3(0.))*mix(1.,mix(.4,.72,draftVehicleMirror),indoor);'
     : 'gl_FragColor.rgb=mix(gl_FragColor.rgb,reflectedFloor,.5525);');
    const anchor=custom?'#include <colorspace_fragment>':'#include <premultiplied_alpha_fragment>';
    shader.fragmentShader=shader.fragmentShader.replace(anchor,custom?anchor+'\\n'+response:response+'\\n'+anchor);
   };
  }
 material.customProgramCacheKey=`);
 }


 if(name==='traffic-model.js'){
  source="import {fetchStartupAsset} from '../ui-draft/startup-transfer.mjs';\n"+source;
  source="import {consolidateTrafficRear,refineTrafficBody} from '../ui-draft/traffic-surface.js';\n"+source;
  source="import {takePrefetched} from './asset-request.js';\n"+source;
  source=replace(source,"if(!bytes){const response=await fetch(new URL('../engine/assets/traffic-model-y.json.gz?v=1',import.meta.url));if(!response.ok)throw Error('Traffic model could not load');bytes=await response.arrayBuffer();}","if(!bytes)bytes=await takePrefetched('__draftTrafficRequest',async()=>{const scope=typeof window!=='undefined'?window.parent:globalThis;return fetchStartupAsset(new URL('../engine/assets/traffic-model-y.json.gz?v=1',import.meta.url),{scope,mirror:scope.__draftStartupMirrors?.['./traffic-model-y.prepared.bin.gz']});});");
  source=replace(source,"../engine/assets/traffic-model-y.json.gz?v=1","../ui-draft/traffic-model-y.prepared.bin.gz?v=restore26");
  source="import {decodeTrafficPayload} from '../ui-draft/traffic-payload.js';\n"+source;
  source=replace(source,"const text=header[0]===31&&header[1]===139?await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text():await blob.text();", "const decoded=header[0]===31&&header[1]===139?await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():await blob.arrayBuffer();");
  source=replace(source,'const data=JSON.parse(text),template=', 'let data=decodeTrafficPayload(decoded);if(!data.draftBodySurface)data=refineTrafficBody(consolidateTrafficRear(data));const template=');
  source=source.replace('a*.36*visibility','a*.55*visibility');
  source="import {toCreasedNormals} from 'three/addons/utils/BufferGeometryUtils.js';\n"+source;
  source=replace(source,'const geometry=new THREE.BufferGeometry();','let geometry=new THREE.BufferGeometry();');
  source=replace(source,'if(part.indices)geometry.setIndex(part.indices);',"if(part.indices)geometry.setIndex(Array.isArray(part.indices)?part.indices:new THREE.BufferAttribute(part.indices,1));if(part.role==='paint'&&!data.draftBodySurface){const original=geometry;geometry=toCreasedNormals(original,Math.PI/3);const normals=geometry.attributes.normal;for(let i=0;i<normals.count;i++){const n=new THREE.Vector3().fromBufferAttribute(normals,i);if(!Number.isFinite(n.lengthSq())||n.lengthSq()<1e-8){const index=original.index?.getX(i)??i;if(original.attributes.normal)n.fromBufferAttribute(original.attributes.normal,index);if(!Number.isFinite(n.lengthSq())||n.lengthSq()<1e-8)n.set(0,1,0);n.normalize();normals.setXYZ(i,n.x,n.y,n.z);}}if(geometry!==original)original.dispose();}");
 }
 if(name==='traffic-vehicle.js'){
  source="import {junctionTrafficPlan,isJunction,advanceJunctionTraffic,stoppedApproachZ} from '../ui-draft/junction-traffic.js';\n"+source;
  // Initial pending cars own their shadow materials, but share geometry.
  source=replace(source,'while(slot.car.children.length)slot.car.remove(slot.car.children[0]);','for(const material of new Set(slot.car.children.map(child=>child.material)))material?.dispose();for(const child of [...slot.car.children])slot.car.remove(child);');
  source=replace(source,'slot.speed=route.speed+(random()-.5)*2.2;',`const reference=80/3.6;slot.speed=isJunction(world.state?.id)?route.speed:reference*(route.direction>0?1.02:route.egoLane?.99:Math.abs(route.x)>7?1.025:1.055);slot.speed+=(random()-.5)*.5;`);
  source=replace(source,'let target=slot.desiredSpeed;',`const weights=world.draftWeather?.weights,factor=weights?1-.12*(weights.overcast||0)-(isJunction(world.state?.id)?.22:.25)*(weights.rain||0)-(isJunction(world.state?.id)?.38:.25)*(weights.snow||0):1;let target=slot.desiredSpeed*factor;`);
  source=replace(source,"const id=state.id;if(!", "const id=state.id;const junction=junctionTrafficPlan(id);if(junction)return junction;if(!");
  // Keep desiredSpeed as the clear-weather baseline. A newly entered car must
  // already match the current weather, including after it recycles offscreen.
  source=replace(source,'slot.desiredSpeed=slot.speed;','slot.desiredSpeed=slot.speed;const weather=world.draftWeather?.weights;if(weather)slot.speed*=1-.12*(weather.overcast||0)-(isJunction(world.state?.id)?.22:.25)*(weather.rain||0)-(isJunction(world.state?.id)?.38:.25)*(weather.snow||0);if(isJunction(world.state?.id)){slot.cooldown=0;slot.car.position.set(route.x,.02,route.z);const offset=random()*24;if(route.axis===\'x\')slot.car.position.x-=route.direction*offset;else if(!recycled&&route.direction<0){const stop=stoppedApproachZ(route.direction,slot.car.userData.physicalLength,world.junctionDimensions?.markingEnd),end=Math.min(route.z+24,world.car.position.z-28);if(end>=stop){const start=Math.min(end,Math.max(stop,route.z-24));slot.car.position.z=start+offset/24*(end-start);}else slot.car.position.z=world.car.position.z+48+offset;}else slot.car.position.z-=route.direction*offset;return;}');
  source=replace(source,"if(route.axis==='x'){car.position.x+=slot.speed", "if(isJunction(state.id)){advanceJunctionTraffic(slot,dt,world);continue;}if(route.axis==='x'){car.position.x+=slot.speed");
  source=replace(source,"setTrafficAppearance(car,state.mode==='dark',slot.alpha)","setTrafficAppearance(car,state.mode==='dark',slot.alpha,world.draftThemeTone?.value??(state.mode==='dark'?1:0))");
  source=replace(source,'firstSide?.35+random()*.35','firstSide?.4+Math.abs(route.x)*.22+random()*2.8');
  source=replace(source,"((world.state?.cameraView==='high'?24:12)+(Math.abs(route.x)>7?15:0)+n*30+random()*2)","((world.state?.cameraView==='high'?12:4)+Math.abs(route.x)*2+n*40+random()*6)");
  source=replace(source,'(gap-(6+slot.speed*1.3))/3','(gap-Math.max(36,6+slot.speed*1.5))/3');
  // Resolve the current ordering after movement and recycling, including paused
  // frames. A stale pre-movement group can otherwise clamp a respawn to a car
  // on the other side of the loop and create the visible close pair again.
  source=replace(source,'for(const members of laneGroups.values())for(let i=1;i<members.length;i++){const slot=members[i],leader=members[i-1],direction=slot.route.direction;const limit=leader.car.position.z-direction*10;if(direction<0)slot.car.position.z=Math.max(slot.car.position.z,limit);else slot.car.position.z=Math.min(slot.car.position.z,limit);}',`const currentLanes=new Map();for(const slot of slots){if(!slot.route||!slot.target||slot.cooldown||slot.delay||!slot.car.visible||slot.route.axis==='x')continue;const lane=slot.route.x+'|'+slot.route.direction;if(!currentLanes.has(lane))currentLanes.set(lane,[]);currentLanes.get(lane).push(slot);}for(const members of currentLanes.values()){const direction=members[0].route.direction;members.sort((a,b)=>(b.car.position.z-a.car.position.z)*direction);for(let i=1;i<members.length;i++){const slot=members[i],leader=members[i-1];const limit=leader.car.position.z-direction*32;if(direction<0)slot.car.position.z=Math.max(slot.car.position.z,limit);else slot.car.position.z=Math.min(slot.car.position.z,limit);}}`);
  // Space new same-lane traffic before it becomes visible. During driving,
  // ego follows the lead vehicle without pushing its position forward.
  source=replace(source,'if(recycled&&modelsReady){','if(route.egoLane)slot.car.position.z=Math.min(slot.car.position.z,world.car.position.z-32);\n  if(recycled&&modelsReady){');
  source=replace(source,`const active=slots.filter(s=>s.route&&s.target&&!s.cooldown);
  // The ego is a physical leader/obstacle too. Its lane never respawns behind it.
  const egoLength=world.car.userData.vehicleSpec?.length||4.85;
  const egoLane=active.filter(s=>s.route.direction<0&&s.route.axis!=='x'&&Math.abs(s.car.position.x-world.car.position.x)<1.7).sort((a,b)=>b.car.position.z-a.car.position.z);
  let nearest=world.car.position.z-(egoLength+5.2)/2-8;
  for(const slot of egoLane){slot.car.position.z=Math.min(slot.car.position.z,nearest);nearest=slot.car.position.z-15;}`,'/* draft traffic growth */');
 }
 if(name==='traffic-vehicle.js')source=replace(source,'return {group,ready,update,',"return {draftCapture:()=>({last,elapsed,slots:slots.map(slot=>({...slot}))}),draftRestore(snapshot){last=snapshot.last;elapsed=snapshot.elapsed;slots.forEach((slot,index)=>Object.assign(slot,snapshot.slots[index]));},group,ready,update,");
 if(name==='world.js'){
  source=replace(source,' roadworks(w){',' roadworks(w,{additionalClosedWidth=0,taperIntervals=4,coneSpacing=2.9,truckZ=-34,serviceTruck=true}={}){');
  source=replace(source,'const inner=w/2-3.38,edge=w/2-.32','const inner=w/2-3.38-additionalClosedWidth,edge=w/2-.32');
  source=replace(source,'const z=-10-i*2.9,t=Math.min(i/4,1)','const z=-10-i*coneSpacing,t=Math.min(i/taperIntervals,1)');
  source=replace(source,'front:-10,back:-48','front:-10,back:-Math.round(10+13*coneSpacing)');
  source=replace(source,'x:w/2-1.85,z:-34','x:w/2-1.85,z:truckZ');
  source=replace(source,'const tx=w/2-1.85,tz=-34;','if(!serviceTruck)return;const tx=w/2-1.85,tz=truckZ;');
  // Junction's bridge already samples ego and camera once per display frame.
  // The legacy 25ms camera throttle otherwise drops those sampled frames.
  source=replace(source,'if(this.continuousDrive&&moving&&submittedAt-', 'if(this.continuousDrive&&moving&&!this.draftJunctionPlaying?.()&&submittedAt-');
  source="import {previewPixelLimit} from '../ui-draft/pixel-resolution.js';\n"+source;
  source=replace(source,'return new World(canvas,car,{...options,renderer});',"globalThis.__draftPreviewLimit=previewPixelLimit(renderer);const width=Math.min(options.width||1920,globalThis.__draftPreviewLimit);return new World(canvas,car,{...options,width,height:width*9/16,renderer});");
  source="import {parkingLowShift,parkingViewPose,applyParkingView} from '../ui-draft/parking-camera.js';\n"+source;
  source=replace(source,' configureCamera(id,options){',` configureCamera(id,options){
  // Align Parking Low to the vehicle that entered the scene. Keep that lens
  // shift for the session so vehicle picks cannot move the entire parking lot.
  if(parkingIds.includes(id)&&this.draftParkingFramingRoot!==this.root){
   this.draftParkingFramingRoot=this.root;this.draftParkingLowShift=parkingLowShift(this.camera,this.car,this.draftParkingEntryBottom);
  }else if(!parkingIds.includes(id))this.draftParkingFramingRoot=null;
  if(['10','17'].includes(id)){
   const pose=parkingViewPose(this.camera,this.car,'default',this.car.rotation.y,this.draftParkingLowShift);applyParkingView(this.camera,this.car,pose);this.cameraAim=pose.aim.clone();
   const frame=vehicleFrame(this.car,this.camera);this.framing={group:'low',targetCenter:pose.anchor,targetBottom:frame.bottom,vehicleFrame:frame};return;
  }`);
  // Ten exposed geometry variants must survive the opening preparation.
  source=replace(source,'if(this.sceneCache.size>8)','if(this.sceneCache.size>12)');
  // Retain hidden variants with their cached scene. Releasing warm proxies at
  // the final frame evicts programs unused by that initial frame's layers.
  source=replace(source,'for(const material of this.preparedMaterials||[])material.dispose();this.preparedMaterials=[];',`if(!this.draftPreparedMaterials)this.draftPreparedMaterials=new WeakMap();const retained=this.draftPreparedMaterials.get(this.root)||[];retained.push(...this.preparedMaterials||[]);this.draftPreparedMaterials.set(this.root,retained);this.preparedMaterials=[];`);
  source=replace(source,' disposeSceneRoot(root){',' disposeSceneRoot(root){for(const material of this.draftPreparedMaterials?.get(root)||[])material.dispose();this.draftPreparedMaterials?.delete(root);');

  source=refineWorld(source);
  source=replace(source,'updateTailLight(this.tailReflection,this.car,dark,isParking);','updateTailLight(this.tailReflection,this.car,dark,isParking,this);');
  source="import {retainMorphingScenery} from '../ui-draft/lane-culling.js';\n"+source;
  source=replace(source,'this.layoutMotion.surfaces?.reset();','this.layoutMotion.surfaces?.reset();this.layoutMotion.restoreSceneryCulling?.();');
  source=replace(source,'motion.sample=sample;\n  const tick=now=>{if(this.layoutMotion!==motion', 'motion.restoreSceneryCulling=retainMorphingScenery(this.root);motion.sample=sample;\n  const tick=now=>{if(this.layoutMotion!==motion');
  // The bridge samples managed lane morphs after advancing scenery on one RAF.
  {const begin=source.indexOf(' startLayoutMotion(from,to){'),end=source.indexOf(' seekLaneMotion(progress){',begin);if(begin<0||end<0)throw Error('Lane clock baseline mismatch');source=source.slice(0,begin)+source.slice(begin,end).replaceAll('motion.frame=requestAnimationFrame(tick);','if(!this.draftManaged)motion.frame=requestAnimationFrame(tick);')+source.slice(end);}
  // Smooth right-panel switches: skip redundant synchronous render when
  // environment/layout/camera animation already runs on the bridge's single RAF,
  // and advance growth/camera motion on frame 1 instead of stalling at dt=0.
  source=replace(source,'if(from)this.startCameraMotion(from);else if(!deferRender)this.renderFrame();','if(from)this.startCameraMotion(from);else if(!deferRender&&!(environmentMotion&&!geometryChanged)&&!layoutFrom)this.renderFrame();');
  source=replace(source,'const dt=motion.last?Math.min(.048,(now-motion.last)/1000):0;motion.last=now;','const dt=motion.last?Math.min(.048,(now-motion.last)/1000):1/60;motion.last=now;');
  {const begin=source.indexOf(' startEnvironmentMotion({onfinish}={}){'),end=source.indexOf(' renderFrame(moving=false){',begin);if(begin<0||end<0)throw Error('Environment motion baseline mismatch');source=source.slice(0,begin)+source.slice(begin,end).replace('motion.frame=requestAnimationFrame(tick);\n  };\n  motion.frame=requestAnimationFrame(tick);','if(!this.draftManaged)motion.frame=requestAnimationFrame(tick);\n  };\n  motion.tick=tick;if(!this.draftManaged)motion.frame=requestAnimationFrame(tick);')+source.slice(end);}
  source=replace(source,'this.applyCamera(from);this.framing=from.framing;this.renderFrame();this.onCameraFrame?.(true);','this.applyCamera(from);this.framing=from.framing;if(!this.draftManaged)this.renderFrame();this.onCameraFrame?.(true);');
  source=replace(source,'const tick=now=>{if(this.cameraMotion!==motion||motion.paused)return;const dt=motion.last?Math.min(48,now-motion.last):0;motion.last=now;if(sample(motion.elapsed+dt,dt)){this.finishCameraMotion();return;}motion.frame=requestAnimationFrame(tick);};','const tick=now=>{if(this.cameraMotion!==motion||motion.paused)return;const dt=motion.last?Math.min(48,now-motion.last):16;motion.last=now;if(sample(motion.elapsed+dt,dt)){this.finishCameraMotion();return;}if(!this.draftManaged)motion.frame=requestAnimationFrame(tick);};');
  source=replace(source,'motion.sample=sample;motion.tick=tick;motion.frame=requestAnimationFrame(tick);','motion.sample=sample;motion.tick=tick;if(!this.draftManaged)motion.frame=requestAnimationFrame(tick);');
  source=replace(source,'motion.start=0;motion.frame=requestAnimationFrame(motion.tick);','motion.start=0;if(!this.draftManaged)motion.frame=requestAnimationFrame(motion.tick);');

  // Contact bounds already include the current lane blend and recycled pose.
  // Initial placement records become stale after driving and must not mask
  // the reflection at the building's old position.
  source=replace(source,"const reflectors=[...this.buildingPlacements,...this.parkingColumns.map(c=>({x:c.position.x,z:c.position.z,width:.68,depth:.68}))];this.buildingCount.value=Math.min(32,reflectors.length);reflectors.slice(0,32).forEach((b,i)=>this.buildingFootprints.value[i].set(b.x+(this.layoutMotion?(this.layoutVisual.width-this.layoutMotion.to.width)*Math.sign(b.x)/2:0),b.z,b.width/2,b.depth/2));", "const reflectors=[...this.environmentFinish.contacts().blocks.map(({min,max})=>({x:(min[0]+max[0])/2,z:(min[2]+max[2])/2,width:max[0]-min[0]+.16,depth:max[2]-min[2]+.16})),...this.parkingColumns.map(c=>({x:c.position.x,z:c.position.z,width:.68,depth:.68}))];this.buildingCount.value=Math.min(32,reflectors.length);reflectors.slice(0,32).forEach((b,i)=>this.buildingFootprints.value[i].set(b.x,b.z,b.width/2,b.depth/2));");

  source=replace(source,"const trafficReflectionStamp=this.trafficSystem?.group.visible?this.trafficSystem.group.children.filter(o=>o.visible).map(o=>o.position.toArray().join(',')).join(';'):'none';","const parkingVehicles=(this.draftParkingGroup?.visible?this.draftParkingGroup.children:[]).filter(o=>o.visible&&o.userData.trafficVehicle);const trafficReflectionStamp=(this.trafficSystem?.group.visible?this.trafficSystem.group.children.filter(o=>o.visible).map(o=>o.position.toArray().join(',')).join(';'):'none')+'|'+parkingVehicles.map(o=>o.position.toArray().join(',')).join(';');");
  source=replace(source,'const rootChanged=this.reflectionSceneRoot!==this.root;', 'const draftOverlays=[];const rootChanged=this.reflectionSceneRoot!==this.root;');
  source=replace(source,'this.egoContact.visible=false;this.tailReflection.visible=false;',"this.draftParkingGroup?.traverse(o=>{if(o.visible&&(o.userData.draftOwned||o.userData.trafficShadow)){draftOverlays.push(o);o.visible=false;}});this.egoContact.visible=false;this.tailReflection.visible=false;");
  source=replace(source,'...(vehicle?[this.car]:[]),...(trafficVisible?', '...(vehicle?[this.car]:[]),...parkingVehicles,...(trafficVisible?');
  source=replace(source,'this.car.visible=vehicle;this.tailReflection.visible=vehicle;', 'for(const o of draftOverlays)o.visible=true;this.car.visible=vehicle;this.tailReflection.visible=vehicle;');
  source=replace(source,'const reflectedVehicles=[','(this.draftEgoReflectionCount??={value:0}).value=vehicle?1:0;const reflectedVehicles=[');
  // Lower-body materials on the SUVs contribute less radiance at night. Match
  // the Model 3 floor response without lifting traffic or the rest of the scene.
  source=replace(source,'this.car.visible=vehicle;\n   (this.draftEgoReflectionCount',`this.car.visible=vehicle;
   const spec=this.car.userData.vehicleSpec??{},boost=spec.continuousRearValance||spec.id==='ix'?2.35:spec.id==='xc90'?1.45:0;
   (this.draftMirrorExposure??={value:0}).value=boost*(isParking?(id<'17'?(spec.id==='xc90'?.05:.29):.82):['05','08'].includes(id)?.94:1);
   (this.draftEgoReflectionCount`);
  source="import {DARK_REFLECTION_STRENGTH,vehicleReflectionPrefilter,updateVehicleReflectionFootprint} from '../ui-draft/vehicle-reflection-sampling.js';\n"+source;
  source=replace(source,'dark?.18:lightQuality.reflectionStrength','dark?DARK_REFLECTION_STRENGTH:lightQuality.reflectionStrength');
  // Even on a paused scene the cached vehicle capture must follow the visible
  // theme blend. The same sampled tone drives the prefilter and the receiver.
  source=replace(source,'  const carReflectionKey=[baseKey,reflectedCar,trafficReflectionStamp].join(\'|\');\n','');
  source=replace(source,'  const groundChanged=rootChanged||this.groundReflectionKey!==groundKey||waterChanged;',`  const carReflectionKey=[baseKey,reflectedCar,trafficReflectionStamp,this.environmentTone.value].join('|');
  const carChanged=this.carMirror&&this.carReflectionKey!==carReflectionKey;
  const groundChanged=rootChanged||this.groundReflectionKey!==groundKey||waterChanged||carChanged;`);
  source=replace(source,'if(this.carMirror&&this.carReflectionKey!==carReflectionKey){','if(carChanged){');
  source=replace(source,'this.carBlurQuad=new FullScreenQuad(this.carBlurMaterial);',`this.carBlurMaterial.fragmentShader=vehicleReflectionPrefilter;Object.assign(this.carBlurMaterial.uniforms,{reflectionDepth:this.carReflectionDepth,reflectionInverse:this.carReflectionInverse,absorbSource:{value:1},reflectionTone:{value:0},groundY:{value:0},draftVehicleMirror:this.draftVehicleMirror??={value:0}});this.carBlurQuad=new FullScreenQuad(this.carBlurMaterial);`);
  // Move the existing inverse before source-height absorption. The fullscreen
  // blur passes do not change the capture camera, so the receiver reuses it.
  source=replace(source,'this.carReflectionInverse.value.copy(this.carMirror.camera.projectionMatrix).multiply(this.carMirror.camera.matrixWorldInverse).invert();','');
  source=replace(source,'this.carBlurMaterial.uniforms.source.value=this.carMirror.getRenderTarget().texture;',`this.carReflectionInverse.value.copy(this.carMirror.camera.projectionMatrix).multiply(this.carMirror.camera.matrixWorldInverse).invert();this.carBlurMaterial.uniforms.absorbSource.value=1;this.carBlurMaterial.uniforms.reflectionTone.value=this.environmentTone.value;this.carBlurMaterial.uniforms.groundY.value=this.carMirror.position.y;this.carBlurMaterial.uniforms.source.value=this.carMirror.getRenderTarget().texture;`);
  source=replace(source,'this.carBlurMaterial.uniforms.source.value=this.carBlurTargets[0].texture;', 'this.carBlurMaterial.uniforms.absorbSource.value=0;this.carBlurMaterial.uniforms.source.value=this.carBlurTargets[0].texture;');
  // Keep the short floor response attached through every heading, including
  // the old 30-degree orientation threshold during parking reverse.
  source=replace(source,'reflectedVehicles.slice(0,12).forEach((o,i)=>{const length=o.userData.physicalLength||o.userData.vehicleSpec?.length||4.85,horizontal=Math.abs(Math.sin(o.rotation.y))>.5;this.vehicleFootprints.value[i].set(o.position.x,o.position.z,(horizontal?length/2:1.1)+.5,(horizontal?1.1:length/2)+4.0);});',
   'reflectedVehicles.slice(0,12).forEach((o,i)=>updateVehicleReflectionFootprint(o,this.vehicleFootprints.value[i]));');
  // Match roughness in UV space to the accepted 1408x792 preview at every raster.
  source=replace(source,'this.carBlurMaterial.uniforms.direction.value.set(2/this.width,0)','this.carBlurMaterial.uniforms.direction.value.set(3.5/1408,0)');
  source=replace(source,'this.carBlurMaterial.uniforms.direction.value.set(0,2/this.height)','this.carBlurMaterial.uniforms.direction.value.set(0,3.5/792)');

  // The simulation and UI animations share frames; do not force synchronous
  // geometry projection/audit work into every animation frame.
  source=replace(source,'this.egoContact.visible=vehicle;this.egoContact.position.set','this.egoContact.rotation.y=this.car.rotation.y;this.egoContact.visible=vehicle&&(!isParking||dark);this.egoContact.position.set');
  // Moving buildings and their reflection must be captured on the same frame.
  // Reusing every third capture makes the reflection visibly step behind them.
  source=replace(source,'const construction=[];for(const o of this.root.children)', 'const laneMeshes=[];this.root.traverse(o=>{if(o.userData.laneOffset!==undefined)laneMeshes.push(o)});const construction=[];for(const o of this.root.children)');
  source=replace(source,'this.root.traverse(o=>{if(o.userData.laneOffset!==undefined){const start=', 'laneMeshes.forEach(o=>{if(o.userData.laneOffset!==undefined){const start=');

  source="import {installRampPassage,paintRampMerge} from '../ui-draft/ramp-passage.js';\nimport {installRampCurbs,rampNose,rampInset,RAMP_PAINT_INSET} from '../ui-draft/road-boundaries.js';\n"+source;
  source=replace(source,'ramp(id,w){','ramp(id,w){const draftRampStart=this.root.children.length;');
  source="import {rampSection,mergeRampSection} from '../ui-draft/ramp-lanes.js';\n"+source;
  source=replace(source,'const sample=u=>{const t=Math.max(0,u),q=Math.min(t,60),x=1.85+.009*q*q+Math.max(0,t-60)*1.08,dx=.018*q,h=branchHalf*Math.sqrt(1+dx*dx);return{x,l:x-h,r:x+h};};',`const query=new URLSearchParams(globalThis.__draftSearch??globalThis.location?.search);
  const dual=!exit&&query.has('scene-preview')&&query.get('adaptive-roadworks-traffic')==='1';
  const sample=exit||dual?rampSection:mergeRampSection;`);
  // The exit surface must extend past the published fog range. Beyond the
  // original endpoint the branch is straight, so use a coarser perimeter.
  source=replace(source,'const near=Math.min(toU(70),toU(-260)),far=Math.max(toU(70),toU(-260));',
   'const near=Math.min(toU(70),toU(-260)),far=Math.max(toU(70),toU(exit?-820:-260)),perimeterStep=u=>exit&&u>253?4:.1;');
  source=replace(source,'for(let u=far;u>join;u-=.1)','for(let u=far;u>join;u-=perimeterStep(u))');
  source=replace(source,'for(let u=end+.1;u<far;u+=.1)','for(let u=end+.1;u<far;u+=perimeterStep(u))');
  source=replace(source,'for(let u=far;u>near;u-=.1)','for(let u=far;u>near;u-=perimeterStep(u))');
  source=replace(source,`let join=0;while(sample(join).l<half+2.4)join+=.01;
  const end=join+2.5,handle=4.5,epsilon=.001,slope=(sample(end+epsilon).l-sample(end-epsilon).l)/(2*epsilon);
  const nose=new THREE.CubicBezierCurve3(new THREE.Vector3(half,0,toZ(join)),new THREE.Vector3(half,0,toZ(join-handle)),new THREE.Vector3(sample(end).l-slope*handle,0,toZ(end-handle)),new THREE.Vector3(sample(end).l,0,toZ(end)));`,
  'const {join,end,slope,nose}=rampNose(half,sample,toZ);');
  source=replace(source,"nose:'tangent-continuous cubic'","nose:'integrated continuous-curvature bend'");
  source=replace(source,"const inset=(points,amount)=>points.map(([x,z],i)=>{const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz);return[x-dz/len*amount*sign,z+dx/len*amount*sign];});","const inset=points=>rampInset(points,sign);");
  source=replace(source,"this.pathRibbon(inset(inner,.25),.13,.033,'white');this.pathRibbon(inset(outer,.25),.13,.033,'white');",`if(exit){
   this.pathRibbon(inset(inner),.13,.028,'white');
   this.pathRibbon(inset(outer),.13,.028,'white');
  }else{
   paintRampMerge(this,half,join,end,far,nose,dual);
   this.pathRibbon(inset([...outer.filter(([,z])=>z>toZ(0)),[half,toZ(0)]]),.13,.028,'white');
  }`);
  source=replace(source,'let dist=0,previous=null;const dash=[];', 'if(exit){let dist=0,previous=null;const dash=[];');
  source=replace(source,"if(dash.length>1)this.pathRibbon(dash,.13,.033,'white');\n  const startTangent","if(dash.length>1)this.pathRibbon(dash,.13,.033,'white');}\n  const startTangent");
  source=replace(source,'this.dashed(-1.85,70,-260);this.dashed(1.85,70,-260);','this.dashed(-1.85,70,-650);this.dashed(1.85,70,-650);');
  source=replace(source,"this.line(-half+.25,70,-260)","this.line(-half+RAMP_PAINT_INSET,70,-900)");
  source=replace(source,"paintInset:.25,startTangentDot","paintInset:RAMP_PAINT_INSET,startTangentDot");
  source=replace(source,"this.line(-w/2+.25,70,distantEnd,deck);this.line(w/2-.25,70,distantEnd,deck);","const inset=['06','07'].includes(this.current)?RAMP_PAINT_INSET:.25;this.line(-w/2+inset,70,distantEnd,deck);this.line(w/2-inset,70,distantEnd,deck);");

  source=replace(source,'i<=96;i++){const p=nose.getPoint(i/96)','i<=192;i++){const p=nose.getPoint(i/192)');
  source=replace(source,'this.rampDimensions={lanes:2,laneWidth:3.7,width:7.4,','this.rampDimensions={lanes:w/3.7,branchLanes:exit||dual?2:1,laneWidth:3.7,width:w,');
  source=replace(source,"this.prepareStructurePaint('ramp');","installRampCurbs(this,inner,outer,sign);installRampPassage(this,id,w,draftRampStart,join,dual);this.prepareStructurePaint('ramp');");
  source=replace(source,'if(this.suspended)return;','if(this.suspended||document.hidden)return;');
 }
 if(name==='preview-snapshot.js')source=source.replaceAll('drivescene-preview-v15','drivescene-ui-draft-preview-v2');
 if(name==='path-motion.js')source=source.replaceAll('drivescene-path-motion','drivescene-ui-draft-path-motion');
 if(name==='theme-sound.js')source="export {preparePathSound,pathSoundStatus,playPathSound,playPathExitSound,stopPathSound,playThemeSound} from '../ui-draft/assist-sound.js';";
 if(name==='world.js'){
  source=replace(source,"import {createTailLight,updateTailLight} from './tail-light.js';",'');
  source=replace(source,'this.tailReflection=createTailLight();this.scene.add(this.tailReflection);','');
  source=source.replaceAll('this.tailReflection.visible=false;','').replaceAll('this.tailReflection.visible=vehicle;','');
  source=replace(source,'updateTailLight(this.tailReflection,this.car,dark,isParking,this);','');
  // Preparation records mirror passes before its final shadow draw. Discard
  // that vehicle capture with the existing ground capture invalidation.
  source=replace(source,'this.reflectionSceneRoot=null;this.preparedRoots.add(this.root);','this.reflectionSceneRoot=null;this.carReflectionKey=null;this.preparedRoots.add(this.root);');
  // Initial scene suspension also covered the hand-off draw. A skipped draw
  // disposed every warmed program before live materials could acquire it.
  source=replace(source,' renderPreparedFrame(){\n  const prior=[];', ' renderPreparedFrame(){\n  const suspended=this.suspended;this.suspended=false;\n  const prior=[];');
  source=replace(source,'finally{for(const [object,visible,culled]of prior)', 'finally{this.suspended=suspended;for(const [object,visible,culled]of prior)');

 }
 source=refineIndoorFinish(name,refineFigma(name,source));
 if(name==='world.js'){
  source="import {prepareSceneSteps} from '../ui-draft/scene-preparation.js';\n"+source;
  // Reuse exactly the normal scene palette while leaving its live pose and
  // animation state in place. Apply only those channels in a single task.
  const paletteStart="  const dark=mode==='dark',idx=dark?1:0,isParking=parkingIds.includes(id),isIndoor=['10','14','15','16'].includes(id),vegetated=trees&&catalog.find(s=>s.id===id).trees;";
  const finish=source.indexOf('  this.state={id,mode,trees:vegetated');
  const start=source.indexOf(paletteStart);
  if(start<0||finish<start)throw Error('Live scene palette source missing');
  const palette=source.slice(start+paletteStart.length,finish);
  source=source.slice(0,start)+`  this.applyDraftPalette(id,mode,vehicle);
  const vegetated=trees&&catalog.find(s=>s.id===id).trees;
`+source.slice(finish);
  source=replace(source,' configureCamera(id,options){',` applyDraftPalette(id,mode,vehicle){
  const dark=mode==='dark',idx=dark?1:0,isParking=parkingIds.includes(id),isIndoor=['10','14','15','16'].includes(id);${palette} }
 setDraftTheme(mode){
  if(!this.state)return;
  this.applyDraftPalette(this.state.id,mode,this.state.vehicle);
  this.state.mode=mode;
  if(this.layoutTransition?.target)this.layoutTransition.target.mode=mode;
 }
 configureCamera(id,options){`);
  source=replace(source,'for(const step of this.buildSteps(id,{...state,palette:this.palette}))await new Promise(resolve=>setTimeout(resolve,0));','await prepareSceneSteps(this.buildSteps(id,{...state,palette:this.palette}));');
  // Use the same construction path for synchronous callers and sliced scene
  // preparation. Yield only after a complete independent geometry operation.
  source=replace(source,'{installRampCurbs,rampNose,','{installRampCurbs,rampCurbSteps,rampNose,');
  source=replace(source,' ramp(id,w){',' ramp(id,w){for(const step of this.rampSteps(id,w)){} }\n *rampSteps(id,w){');
  source=replace(source,'   this.ramp(id,w);','   yield* this.rampSteps(id,w);');
  source=replace(source,"shape.closePath();this.flatShape(shape,.015,'road');","shape.closePath();yield;this.flatShape(shape,.015,'road');yield;");
  source=replace(source,"this.line(-half+RAMP_PAINT_INSET,70,-900)","yield;this.line(-half+RAMP_PAINT_INSET,70,-900)");
  source=replace(source,'  const startTangent=nose.getTangent(0)', '  yield;const startTangent=nose.getTangent(0)');
  source=replace(source,'installRampCurbs(this,inner,outer,sign);installRampPassage(this,id,w,draftRampStart,join,dual);', 'yield* rampCurbSteps(this,inner,outer,sign);installRampPassage(this,id,w,draftRampStart,join,dual,inner,outer);yield;');
 }

 if(name==='traffic-vehicle.js'){
  source="import {createTrafficReveal,applyTrafficGrowth,trafficEntryOpacity} from '../ui-draft/traffic-reveal.js';\n"+source;
  source=replace(source,"const group=new THREE.Group();group.name='Traffic vehicles';", "const reveal=createTrafficReveal({enabled,now});const group=new THREE.Group();group.name='Traffic vehicles';");
  source=replace(source,'if(next!==key||!sameRoot){','if(next!==key||!sameRoot){if(!sameRoot)reveal.set(enabled,{snap:true});');
  source=source.replaceAll('group.visible=enabled&&modelsReady&&slots.some(s=>s.route);','group.visible=reveal.present&&modelsReady&&slots.some(s=>s.route);');
  source=replace(source,'group.visible=reveal.present&&modelsReady&&slots.some(s=>s.route);','const growth=reveal.sample();group.visible=reveal.present&&modelsReady&&slots.some(s=>s.route);');
  source=replace(source,'/* draft traffic growth */','for(const car of pool)applyTrafficGrowth(car,growth,world);');
  source=replace(source,"setTrafficAppearance(car,state.mode==='dark',slot.alpha,","setTrafficAppearance(car,state.mode==='dark',slot.alpha*trafficEntryOpacity(growth),");
  source=replace(source,'setEnabled(value){const entering=!!value&&!enabled;enabled=!!value;', 'animating:()=>reveal.active,setEnabled(value){const entering=!!value&&!enabled&&!reveal.present;reveal.set(value,{snap:world.draftInitialFrameReady!==true||!!world.initializingScene});enabled=!!value;');
  source=replace(source,'draftCapture:()=>({last,elapsed,slots:', 'draftCapture:()=>({enabled,reveal:reveal.capture(),last,elapsed,slots:');
  source=replace(source,'draftRestore(snapshot){last=snapshot.last;', 'draftRestore(snapshot){enabled=snapshot.enabled??enabled;if(snapshot.reveal)reveal.restore(snapshot.reveal);last=snapshot.last;');
  source=replace(source,"const ready=load?readyTrafficModel(null,'model-y').then", "let readyPromise;function ensureReady(){return readyPromise??=(load?readyTrafficModel(null,'model-y').then");
  source=replace(source,"modelError=error.message;console.error(error);}):Promise.resolve();", "modelError=error.message;readyPromise=null;throw error;}):Promise.resolve());}");
  source=replace(source,'modelsReady=true;for(const slot', 'modelsReady=true;modelError=null;for(const slot');
  source=replace(source,'group,ready,update,','group,get ready(){return ensureReady()},update,');
 }
 if(name==='traffic-vehicle.js'){
  source=`import {createCutInIndicator} from '../ui-draft/cut-in-indicator.js';
import {createFeedbackPainter} from '../ui-draft/traffic-feedback.js';
const paintTrafficFeedback=createFeedbackPainter(THREE.Color);
`+source;
  // Apply after the initial-pose refinement, which anchors to this old branch.
  // The fixed-model pool only needs a new pose and speed when recycling.
  source=replace(source,`  if(recycled&&modelsReady){
   const type='model-y',fresh=createTrafficVehicle(type);
   for(const child of [...slot.car.children]){slot.car.remove(child);child.material?.dispose();}
   for(const child of [...fresh.children])slot.car.add(child);Object.assign(slot.car.userData,fresh.userData);
  }
`,'');
  source=replace(source,' function update(playing=false,egoSpeed=0){',' let cutInIndicator,liveJunction;\n function update(playing=false,egoSpeed=0){');
  source=replace(source,'  const transitioning=world.layoutTransition',`  if(cutInIndicator)cutInIndicator.visible=false;
  const roadworks=!world.initializingScene?(world.draftJunctionTurnFrame??(world.draftRoadworksPlayback?.active()?world.draftRoadworksFrame:null)):null;
  if(roadworks){
   liveJunction=roadworks.liveTraffic?world.root:null;
   // The event owns every vehicle pose. Use the same model pool as regular
   // traffic, and rebind normal lane routes when leaving the event.
   key='';
   const ambient=roadworks.visibleTraffic;
   const entry=reveal.sample();
   const fleet=ambient??roadworks.traffic??[];
   group.visible=modelsReady&&fleet.length>0;
   for(const [index,slot] of slots.entries()){
    const pose=fleet[index],car=slot.car;
    const opacity=pose?.opacity??1;
    const growth=(pose?.growth??1)*(ambient?entry:1);
    car.visible=!!pose&&opacity>0&&growth>0&&group.visible;
    if(!car.visible){if(liveJunction)slot.route=null;continue;}
    Object.assign(slot,{route:pose,id:pose.id,alpha:opacity,target:opacity,speed:pose.speed,cooldown:0,delay:false});
    car.position.set(pose.x,world.car.position.y,world.car.position.z+pose.z);
    car.rotation.y=pose.yaw;
    const tone=world.draftThemeTone?.value??(state.mode==='dark'?1:0);
    setTrafficAppearance(car,state.mode==='dark',opacity,tone);
    paintTrafficFeedback(car,pose.trafficFeedback,tone);
    applyTrafficGrowth(car,growth,world);
    if(pose.rearIndicator){
     cutInIndicator??=createCutInIndicator();
     if(cutInIndicator.parent!==car)car.add(cutInIndicator);
     cutInIndicator.scale.x=pose.rearIndicator==='left'?1:-1;
     cutInIndicator.visible=true;
    }
   }
   return;
  }
  const transitioning=world.layoutTransition`);
  source=replace(source,'if(!laneChange)for(const slot of slots)', 'if(liveJunction===world.root)for(const slot of slots){if(slot.route&&!routes.some(route=>route.id===slot.id))slot.route=null;}if(!laneChange&&liveJunction!==world.root)for(const slot of slots)');
  source=replace(source,'root=world.root;if(root)root.userData.trafficScene=state.id;', 'root=world.root;liveJunction=null;if(root)root.userData.trafficScene=state.id;');
  source=replace(source,'animating:()=>reveal.active,setEnabled(value)', 'get enabled(){return enabled},animating:()=>reveal.active,setEnabled(value)');
  source=replace(source,'alpha:s.alpha,retiring:', 'alpha:s.alpha,yaw:s.car.rotation.y,axis:s.route.axis,feedback:s.route.cutInColor,retiring:');
 }
 if(['contact-shadows.js','traffic-model.js'].includes(name)){
  source=(name==='contact-shadows.js'?"import {roadShadowStrength,roadShadowSpread} from '../ui-draft/road-shadow-settings.js';\n":"import {roadTrafficShadowStrength as roadShadowStrength,roadShadowSpread} from '../ui-draft/road-shadow-settings.js';\n")+source;
  const uniformAnchor=name==='contact-shadows.js'?'uniforms:{opacity:':'uniforms:{body:';
  source=replace(source,uniformAnchor,uniformAnchor.replace('uniforms:{','uniforms:{roadShadowStrength,roadShadowSpread,'));
  const spread='mix(vec2(1.),roadShadowSpread,body)';
  source=replace(source,"vertexShader:'varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'","vertexShader:'uniform vec2 roadShadowSpread;"+'uniform float body;'+"varying vec2 v;void main(){v=uv;vec3 local=position;local.xy*="+spread+";gl_Position=projectionMatrix*modelViewMatrix*vec4(local,1.);}'");
  source=replace(source,"fragmentShader:'varying vec2 v;","fragmentShader:'uniform float roadShadowStrength;varying vec2 v;");
  if(name==='contact-shadows.js')source=replace(source,'gl_FragColor=vec4(.008,.010,.014,a);','gl_FragColor=vec4(.008,.010,.014,1.-pow(1.-clamp(a,0.,.999),roadShadowStrength));');
  else {
   source=replace(source,"import {roadTrafficShadowStrength as roadShadowStrength,roadShadowSpread}", "import {roadTrafficShadowStrength as roadShadowStrength,roadShadowSpread,roadContactProfile}");
   source=replace(source,'uniforms:{roadShadowStrength,roadShadowSpread,','uniforms:{roadShadowStrength,roadShadowSpread,roadContactProfile,');
   source=replace(source,"fragmentShader:'uniform float roadShadowStrength;", "fragmentShader:'uniform float roadContactProfile;uniform float roadShadowStrength;");
   source=replace(source,'gl_FragColor=vec4(.008,.01,.014,a*mix(.88,.55,body)*visibility);',`
    float chassisRadius=pow(pow(abs(p.x),4.)+pow(abs(p.y),4.),.25);
    float chassisContact=(1.-smoothstep(.40,1.,chassisRadius))*.50;
    float tireContact=exp(-dot(p,p)*3.8)*(1.-smoothstep(.72,1.,length(p)))*.96;
    float contact=mix(a*mix(.88,.55,body),mix(tireContact,chassisContact,body),roadContactProfile);
    gl_FragColor=vec4(.008,.01,.014,(1.-pow(1.-clamp(contact,0.,.999),roadShadowStrength))*visibility);`.replaceAll('\n',' '));
   source=replace(source,'wheelShadow.uniforms.roadShadowSpread=shadow.material.uniforms.roadShadowSpread;', 'wheelShadow.uniforms.roadShadowSpread=shadow.material.uniforms.roadShadowSpread;wheelShadow.uniforms.roadContactProfile=roadContactProfile;');
  }
 }

 // srcdoc has no query string. All engine modules read the host-provided parameters.
 source=source.replace(/globalThis\.location\?\.search|(?<![\w.])location\.search/g,'(globalThis.__draftSearch??globalThis.location?.search)').replaceAll('location.origin',"(window.frameElement?window.parent.location.origin:location.origin)").replaceAll('history.replaceState(',"if(location.protocol!=='about:')history.replaceState(");
 source=source.replaceAll('import.meta.url',`new URL('../engine/${name}',import.meta.url).href`);
 return {contents:source,loader:'js',resolveDir:args.path.slice(0,args.path.lastIndexOf('/'))};
 });}}}
