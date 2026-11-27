function replace(source,from,to){const count=source.split(from).length-1;if(count!==1)throw Error('Scene refinement baseline mismatch: expected 1 anchor, found '+count+': '+from.slice(0,80));return source.replace(from,to)}

export function refineWorld(source){
 // Remove the inset rooftop slab: from the high camera its shaded underside
 // reads as a black slot. Keep the main solid volume and its existing height.
 source=replace(source,"   this.box(w*.76,.30,d*.73,x+w*.04,h+.03,z-d*.05,'building',.03);",'');
 source="import {brakingSpeed,requestedJunctionTiming,junctionLiftStart} from '../ui-draft/junction-playback.js';\n"+source;
 // Share Road's daylight asphalt across the driving layouts and junctions.
 // Apply after palette assignment so all palettes and theme restores agree.
 source=replace(source,'  this.mat.environmentBuilding.color.copy(this.mat.building.color);',`  const drivingDay=!dark&&['02','03','05','06','07','08','09','13'].includes(id);
  (this.roadDayGrade??={value:0}).value=Number(drivingDay);
  if(drivingDay)this.mat.road.color.multiplyScalar(.9);
  if(dark){
   // Neutralize the built surfaces without grading vegetation, markings or vehicles.
   for(const key of ['road','ground','pavement','curb','building']){
    const color=this.mat[key].color;
    const gray=.2126*color.r+.7152*color.g+.0722*color.b;
    color.lerp(new THREE.Color(gray,gray,gray),.65).multiplyScalar(key==='building'?.92:.88);
   }
  }
  this.mat.environmentBuilding.color.copy(this.mat.building.color);`);
 // Matte asphalt through the intersection; reset the shared road on scene changes.
 source=replace(source,'  this.mat.glass.roughness=dark?.46:.30;',`  const junctionRoad=id==='05'||id==='08';
  this.mat.road.specularIntensity=junctionRoad?.38:.9;
  if(junctionRoad){this.mat.road.roughness=.84;this.mat.road.clearcoat=dark?0:.08;this.mat.road.envMapIntensity=.82;}
  this.mat.glass.roughness=dark?.46:.30;`);
 // Bound water radiance independently from exposure and reflected sky.
 source=replace(source,"water:['#7695ae','#304146']","water:['#218fc1','#142733']");
 source=replace(source,'shader.uniforms.waterMix=this.waterMix;',"shader.uniforms.waterMix=this.waterMix;shader.uniforms.coastTone=this.draftThemeTone??this.environmentTone;shader.uniforms.coastCloud=this.draftCoastCloud??={value:0};");
 source=replace(source,'uniform float waterMix;uniform sampler2D coastReflectionTexture;','uniform float waterMix;uniform float coastTone;uniform float coastCloud;uniform sampler2D coastReflectionTexture;');
 source=replace(source,'outgoingLight=mix(outgoingLight,reflected,${strength.toFixed(3)}*waterMix);',`float night=clamp(coastTone,0.,1.);vec3 sea=mix(vec3(.055,.14,.25),vec3(.026,.035,.043),night);vec3 reflectionLimit=mix(vec3(.30,.37,.44),vec3(.045,.052,.06),night);float cloud=clamp(coastCloud,0.,1.);sea=mix(sea,mix(vec3(.10,.135,.15),vec3(.029,.035,.039),night),cloud);reflectionLimit=mix(reflectionLimit,mix(vec3(.18,.22,.24),vec3(.038,.044,.048),night),cloud);float grazing=pow(1.-clamp(dot(normalize(vViewPosition),normal),0.,1.),5.);float skyWeight=mix(.10+.34*grazing,.08+.13*grazing,night);vec3 coastal=mix(sea,min(reflected,reflectionLimit),skyWeight);outgoingLight=mix(outgoingLight,coastal,waterMix);`);
 source=replace(source,'submittedAt-(this.lastMovingSubmit??-Infinity)<25','submittedAt-(this.lastMovingSubmit??-Infinity)<(this.draftManaged?0:25)');
 source=replace(source,'motion.sample=sample;motion.tick=tick;motion.frame=requestAnimationFrame(tick);','motion.speedAt=elapsed=>approach&&forward?brakingSpeed(elapsed,{speed:vehicleSpeed,cruise:vehicleCruiseTime,brake:vehicleBrakeTime,scale:.969}):0;motion.sample=sample;motion.tick=tick;motion.frame=requestAnimationFrame(tick);');
 source=replace(source,'const vehicleStopTime=timing.vehicleStopTime;','const published=requestedJunctionTiming(travel),physicalBrakeTime=published.brake;const vehicleStopTime=published.stop;');
 // Leave 24m of additional approach before the shared Cross/T braking sequence.
 source=replace(source,"options.junctionPosition==='approaching'?14:","options.junctionPosition==='approaching'?38:");
 source=replace(source,'stopNearEdge+2.5-frontOffset','(this.junctionDimensions?.markingEnd??-22.55)+(this.junctionDimensions?.stopLineWidth??.18)/2+.5-frontOffset');
 source=replace(source,'const liftStart=defaultLiftStart;','const liftStart=approach&&forward?junctionLiftStart(travel):defaultLiftStart;');
 // No anticipatory prelude before the road-position trigger. The shared quintic easing
 // starts and ends with zero camera velocity/acceleration over the remaining trip.
 source=replace(source,'const preludeDuration=leadDuration,preludeAmount=.07,preludeStart=liftStart-preludeDuration;',`if(approach&&forward){const u=THREE.MathUtils.clamp((time-liftStart)/liftDuration,0,1);return u;}const preludeDuration=leadDuration,preludeAmount=.07,preludeStart=liftStart-preludeDuration;`);
 source=replace(source,'motion.liftDelay=(liftStart-leadDuration)*.969*MOTION_TIME_SCALE;','motion.liftDelay=approach&&forward?liftStart*.969:(liftStart-leadDuration)*.969*MOTION_TIME_SCALE;');
 source=replace(source,'const duration=approach&&forward?timing.duration:baseDuration','const duration=approach&&forward?vehicleStopTime:baseDuration');
 source=replace(source,'Math.min(1.6,vehicleStopTime*.5)','physicalBrakeTime');
 // Manual view picks share a 500 ms phase; the automatic Junction approach keeps its clock.
 source="import {MANUAL_CAMERA_MS,manualCameraBlend} from '../ui-draft/manual-camera.js';\n"+source;
 source=replace(source,'  motion.isJunctionApproach=',`  const drivingCamera=['02','09','13','03','06','07'].includes(this.current);
  const manualCameraTimeScale=drivingCamera?MANUAL_CAMERA_MS/1000/.65:MOTION_TIME_SCALE;
  motion.isJunctionApproach=`);
 source=replace(source,'1000*MOTION_TIME_SCALE;motion.liftDelay=','1000*(approach&&forward?1:manualCameraTimeScale);motion.liftDelay=');
 source=replace(source,'motion.elapsed/1000/MOTION_TIME_SCALE/(approach&&forward?.969:1)','motion.elapsed/1000/(approach&&forward?.969:manualCameraTimeScale)');
 source=replace(source,'   let ease=spring;','   let ease=!approach&&drivingCamera?manualCameraBlend(motion.elapsed):spring;');
 source=replace(source,'if(approach?t>=1:1-spring<.0008){','if(approach?t>=1:drivingCamera?motion.elapsed>=MANUAL_CAMERA_MS:1-spring<.0008){');
 // The Pro Junction bridge composes its follow camera using this sampled vehicle position.
 source=replace(source,'  const liftAtVehicleStop=junctionLiftEase(vehicleStopTime);',`  const liftAtVehicleStop=junctionLiftEase(vehicleStopTime);
  motion.liftAt=elapsed=>THREE.MathUtils.smootherstep(junctionLiftEase(elapsed/1000/.969),0,liftAtVehicleStop);`);
 source=replace(source,'  const sample=(elapsed,dt=0)=>{',`  const liftPosition=(out,ease)=>out.setFromSphericalCoords(
   THREE.MathUtils.lerp(a.radius,b.radius,ease),THREE.MathUtils.lerp(a.phi,b.phi,ease),THREE.MathUtils.lerp(a.theta,b.theta,ease));
  motion.liftPosition=liftPosition;
  const sample=(elapsed,dt=0)=>{`);
 source=replace(source,'pose.position.setFromSpherical(new THREE.Spherical(THREE.MathUtils.lerp(a.radius,b.radius,framingEase),THREE.MathUtils.lerp(a.phi,b.phi,ease),THREE.MathUtils.lerp(a.theta,b.theta,ease))).add(pivot)','liftPosition(pose.position,ease).add(pivot)');
 source=replace(source,'ease=THREE.MathUtils.smootherstep(junctionLiftEase(time),0,liftAtVehicleStop);','ease=motion.liftAt(elapsed);');
 source=replace(source,'const sample=(elapsed,dt=0)=>{','const sample=(elapsed,dt=0,followVehicle=false)=>{');
 source=replace(source,'   if(approach?t>=1:drivingCamera?',`   if(followVehicle){
    this.car.position.lerpVectors(from.carPosition,to.carPosition,carEase);
    this.renderFrame(true);this.onCameraFrame?.(true);return t>=1;
   }
   if(approach?t>=1:drivingCamera?`);
 // One distance curve and the live sky color keep every intermediate theme
 // frame joined. A fixed night-color preblend produced a dark horizon stripe.
 // Retain the fully obscured endpoint and the smooth quintic curve,
 // while postponing the blend into a narrower distant band.
 source=replace(source,'${lightQuality.aerialStart.toFixed(1)})/${lightQuality.aerialSpan.toFixed(1)}','220.)/335.');
 source=replace(source,'    if(darkAerialPerspective>.5)t=clamp((vFogDepth-65.)/235.,0.,1.);','');
 // Match the published distance curve and its extra clear-day asphalt reach.
 // Keep the softened sky-to-ground join on the background plane.
 source=replace(source,"shader.uniforms.darkAerialPerspective=this.darkAerialPerspective;shader.fragmentShader='uniform float darkAerialPerspective;\\n'+shader.fragmentShader;",`shader.uniforms.darkAerialPerspective=this.darkAerialPerspective;shader.fragmentShader='uniform float darkAerialPerspective;\\n'+shader.fragmentShader;
    shader.uniforms.draftSnowHaze=this.draftSnowHaze??={value:0};
    shader.fragmentShader='uniform float draftSnowHaze;\\n'+shader.fragmentShader;
    if(material===this.mat.road){
     shader.uniforms.draftRoadFogDelay=this.draftRoadFogDelay??={value:0};
     shader.uniforms.roadDayGrade=this.roadDayGrade??={value:0};
     shader.fragmentShader='uniform float draftRoadFogDelay;uniform float roadDayGrade;\\n'+shader.fragmentShader;
    }
    if(material===this.mat.ground){
     shader.uniforms.daylightHorizon=this.draftDayHorizon;
     shader.fragmentShader='uniform float daylightHorizon;\\n'+shader.fragmentShader;
    }`);
 source=replace(source,'    float aerial=t*t*t*(t*(t*6.-15.)+10.);',`    \${material===this.mat.road?'t-=draftRoadFogDelay*t*(1.-t);':''}
    float snowDepth=clamp((vFogDepth-48.)/195.,0.,1.);
    t=mix(t,snowDepth,draftSnowHaze);
    float aerial=t*t*t*(t*(t*6.-15.)+10.);
    \${material===this.mat.ground?'float groundAngle=abs(normalize(vGroundWorld-cameraPosition).y);float angleHaze=1.-smoothstep(0.,.065,groundAngle);aerial=max(aerial,angleHaze*daylightHorizon*smoothstep(110.,350.,vFogDepth));':''}`);
 // Calibrate linear radiance for a 12% display-lightness reduction under ACES.
 // Apply the grade before distance haze so the horizon still joins the sky.
 source=replace(source,'gl_FragColor.rgb=mix(gl_FragColor.rgb,fogColor,fogFactor);',`\${material===this.mat.road?'gl_FragColor.rgb*=1.-.146*roadDayGrade;':''}
    gl_FragColor.rgb=mix(gl_FragColor.rgb,linearToOutputTexel(vec4(fogColor,1.)).rgb,fogFactor);`);
 source=replace(source,'float horizonDistance=length(vGroundWorld.xz-cameraPosition.xz);float horizonAerial=smoothstep(70.,280.,horizonDistance)*darkAerialPerspective;outgoingLight=mix(outgoingLight,sharedHorizon,horizonAerial);','');
 // Extend the Cross exits through the distance fade, including the branch
 // the lowered camera faces after a left turn.
 source=replace(source,'r=2.4,crossroad=id===\'05\';',"r=2.4,crossroad=id==='05',exitEnd=-650,westEnd=crossroad?600:150;");
 source=replace(source,'if(crossroad)this.road(0,w,far,-260);','if(crossroad)this.road(0,w,far,exitEnd);');
 source=replace(source,"this.plane(300,w,0,-40,.015,'road');","this.plane(westEnd+150,w,(150-westEnd)/2,-40,.015,'road');");
 source=replace(source,'limit=hx?150:hz<0?110:220;','limit=hx>0?westEnd:hx<0?150:hz<0?110:-40-exitEnd;');
 source=replace(source,"const z=-40+edge*half,start=half+(edge===1||crossroad?r:0);","const z=-40+edge*half,start=half+(edge===1||crossroad?r:0),end=side<0?westEnd:150;");
 source=replace(source,"this.box(150-start,.18,1.6,side*(150+start)/2,-.02,z+edge*.8,'pavement');\n    this.box(150-start,.20,.20,side*(150+start)/2,0,z+edge*.1,'curb');\n    this.plane(150-start,.13,side*(150+start)/2,z-edge*.25,.028,'white');","this.box(end-start,.18,1.6,side*(end+start)/2,-.02,z+edge*.8,'pavement');\n    this.box(end-start,.20,.20,side*(end+start)/2,0,z+edge*.1,'curb');\n    this.plane(end-start,.13,side*(end+start)/2,z-edge*.25,.028,'white');");
 source=replace(source,'if(crossroad)this.line(side*(half-.25),far-r,-260);','if(crossroad)this.line(side*(half-.25),far-r,exitEnd);');
 source=replace(source,'if(crossroad)this.curbs(w,far-r,-260);','if(crossroad)this.curbs(w,far-r,exitEnd);');
 // Rotate the Road frontage onto the westbound exit. Stagger the repeated
 // stretches so their gaps stay as varied as the original roadside sites.
 source=replace(source,'  if(tee)for(const x of',`  if(cross&&!tee){
   const roadside=this.environmentPlan(w,{},'02');
   for(const [offset,stagger,scale] of [[34,0,1],[251,14,1.08],[473,-11,.95]]){
    for(const {kind,args} of roadside){
     const [lateral,along]=kind==='lawn'?args.slice(2):args;
     const x=along*scale-offset+(lateral>0?stagger:0),z=-40-lateral;
     if(x<-580)continue;
     if(kind==='building')add(kind,x,z,args[3],args[2],args[4],args[5],true);
     else if(kind==='lawn')add(kind,args[1]*scale,args[0],x,z);
     else add(kind,x,z,args[2]);
    }
   }
 }
  if(tee)for(const x of`);
 // Give the westbound street the same facade lighting as the northbound Road
 // view. Adjust daylight shading only; geometry and shadows remain in world space.
 source=replace(source,'building(x,z,w,d,h,variantIndex){','building(x,z,w,d,h,variantIndex,westbound){');
 source=replace(source,'   o.material=this.mat.environmentBuilding;',`   o.material=this.mat.environmentBuilding;
   if(westbound)o.geometry.setAttribute('westFacade',new THREE.Float32BufferAttribute(new Float32Array(o.geometry.attributes.position.count).fill(1),1));`);
 source=replace(source,'  this.buildingTint={value:1};',`  this.mat.building.defaultAttributeValues={westFacade:[0]};
  this.buildingTint={value:1};`);
 source=replace(source,'  this.mat.environmentBuilding.clipShadows=true;',`  this.mat.environmentBuilding.clipShadows=true;
  this.mat.environmentBuilding.defaultAttributeValues=building.defaultAttributeValues;`);
 source=replace(source,"shader.vertexShader='varying float vBuildingHeight;", "shader.vertexShader='attribute float westFacade;varying float vWestFacade;varying float vBuildingHeight;");
 source=replace(source,'vBuildingNormal=normalize(mat3(modelMatrix)*normal);','vBuildingNormal=normalize(mat3(modelMatrix)*normal);vWestFacade=westFacade;');
 source=replace(source,"shader.fragmentShader='uniform float buildingTint;", "shader.fragmentShader='varying float vWestFacade;uniform float buildingTint;");
 source=replace(source,'    compile.call(this.mat.building,shader);',`    compile.call(this.mat.building,shader);
    const direction='getDirectionalLightInfo( directionalLight, directLight );';
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',THREE.ShaderChunk.lights_fragment_begin.replace(direction,direction+\`
     if(vWestFacade*buildingTint>0.){
      vec3 lightWorld=transpose(mat3(viewMatrix))*directLight.direction;
      directLight.direction=normalize(mix(directLight.direction,mat3(viewMatrix)*vec3(lightWorld.z,lightWorld.y,-lightWorld.x),buildingTint));
     }\`));`);
 source=replace(source,'float srFacadeShade=1.-smoothstep(-.3,.7,dot(normalize(vBuildingNormal),',`vec3 facadeNormal=mix(vBuildingNormal,vec3(-vBuildingNormal.z,vBuildingNormal.y,vBuildingNormal.x),vWestFacade);
     float srFacadeShade=1.-smoothstep(-.3,.7,dot(normalize(facadeNormal),`);
 // Keep ego paint lighting in the same relative direction as the camera and car turn.
 // The world lights and their shadow maps stay in world space.
 source=replace(source,'  const shadowKey=JSON.stringify',`  if(id==='05'||this.paintYaw){
   if(!this.car.paintMaps){
    this.car.paintMaps=new Set();
    this.car.traverse(o=>{for(const m of [].concat(o.material||[]))if(m.envMap&&m.userData.surfaceRole==='paint')this.car.paintMaps.add(m);});
   }
   const turn=this.paintTurn??={value:new THREE.Matrix3()},rotation=this.paintRotation??=new THREE.Matrix4();
   this.paintYaw=id==='05'?this.car.rotation.y:0;
   turn.value.setFromMatrix4(rotation.makeRotationY(this.paintYaw));
   for(const m of this.car.paintMaps){
    m.envMapRotation.y=this.paintYaw;
    if(m.paintTurn)continue;
    m.paintTurn=true;
    const compile=m.onBeforeCompile,key=m.customProgramCacheKey(),direction='getDirectionalLightInfo( directionalLight, directLight );';
    m.onBeforeCompile=(shader,renderer)=>{
     compile.call(m,shader,renderer);
     shader.uniforms.paintTurn=turn;
     shader.fragmentShader='uniform mat3 paintTurn;\\n'+shader.fragmentShader.replace('#include <lights_fragment_begin>',THREE.ShaderChunk.lights_fragment_begin.replace(direction,direction+'directLight.direction=mat3(viewMatrix)*paintTurn*transpose(mat3(viewMatrix))*directLight.direction;'));
    };
    m.customProgramCacheKey=()=>key+'-paint-turn';m.needsUpdate=true;
   }
  }
  const shadowKey=JSON.stringify`);
 // Driving and Outdoor parking share a sky profile. Indoor has its own backdrop.
 source=replace(source,'this.sky.material.uniforms.range.value=dark?.42:.20;','this.sky.material.uniforms.range.value=(dark||isIndoor) ? .20 : .12;');
 source=replace(source,"this.sky.material.uniforms.bottom.value.set(dark?'#2b2e32':'#dce5ee');","this.sky.material.uniforms.bottom.value.set(dark?'#303132':'#dce5ee');");
 // Grade the landscape in linear light before the existing ACES transform.
 // Asphalt, paint, and the driving-assist path keep their own materials.
 source=replace(source,'  this.mat.ground.onBeforeCompile=shader=>{\n   shader.uniforms.environmentTone=this.environmentTone;',`  this.draftDayGroundGrade={value:0};
  this.draftDayHorizon={value:0};
  this.draftDayGroundBalance={value:new THREE.Vector3(.68,.67,.69)};
  this.mat.ground.onBeforeCompile=shader=>{
   shader.uniforms.environmentTone=this.environmentTone;
   shader.uniforms.draftDayGroundGrade=this.draftDayGroundGrade;
   shader.uniforms.draftDayGroundBalance=this.draftDayGroundBalance;
   shader.fragmentShader='uniform float draftDayGroundGrade;uniform vec3 draftDayGroundBalance;\\n'+shader.fragmentShader;`);
 source=replace(source,'outgoingLight=mix(outgoingLight,vec3(groundLuma),environmentTone);',
  'outgoingLight=mix(outgoingLight,vec3(groundLuma),environmentTone);outgoingLight*=mix(vec3(1.),draftDayGroundBalance,draftDayGroundGrade);');
 // Reuse the two existing environment blur passes. The water and parking
 // captures keep their original profile; only driving prefilters source depth.
 source="import {environmentReflectionPrefilter,environmentReflectionBlur} from '../ui-draft/environment-reflection-filter.js';\n"+source;
 source=replace(source,'  this.blurQuad=new FullScreenQuad(this.blurMaterial);',`  this.draftFilteredEnvironment={value:0};
  Object.assign(this.blurMaterial.uniforms,{draftReflectionDepth:this.reflectionDepth,draftReflectionInverse:this.reflectionInverse,draftReflectionGroundY:{value:0},draftReflectionHeightFade:{value:2.8},draftPrefilterReflection:{value:0},draftEnvironmentBlur:{value:0}});
  this.blurMaterial.fragmentShader=this.blurMaterial.fragmentShader.replaceAll('texture2D(source,','draftReflectionSample(').replace('void main(){',environmentReflectionPrefilter+'\\nvoid main(){'+environmentReflectionBlur);
  this.blurQuad=new FullScreenQuad(this.blurMaterial);`);
 source=replace(source,'  if(waterChanged){',`  if(waterChanged){
   this.blurMaterial.uniforms.draftEnvironmentBlur.value=0;
   this.blurMaterial.uniforms.draftPrefilterReflection.value=0;`);
 source=replace(source,'  this.reflectionInverse.value.copy(this.mirror.camera.projectionMatrix).multiply(this.mirror.camera.matrixWorldInverse).invert();','');
 source=replace(source,"  this.blurMaterial.uniforms.source.value=this.mirror.getRenderTarget().texture;this.blurMaterial.uniforms.direction.value.set((SR_QUALITY_MIX>0&&mode==='light'?12:4)/this.width,0);",`  this.reflectionInverse.value.copy(this.mirror.camera.projectionMatrix).multiply(this.mirror.camera.matrixWorldInverse).invert();
  const filteredEnvironment=!isParking,blurUniforms=this.blurMaterial.uniforms;
  this.draftFilteredEnvironment.value=Number(filteredEnvironment);
  blurUniforms.draftEnvironmentBlur.value=Number(filteredEnvironment);
  blurUniforms.draftPrefilterReflection.value=Number(filteredEnvironment);
  blurUniforms.draftReflectionGroundY.value=this.mirror.position.y;
  // Reflect the facade near its base, then attenuate before the separable blur.
  // Filtering coverage and radiance together avoids a hard silhouette at the fade.
  blurUniforms.draftReflectionHeightFade.value=dark?5.2:id==='02'?4.8:4.2;
  this.blurMaterial.uniforms.source.value=this.mirror.getRenderTarget().texture;this.blurMaterial.uniforms.direction.value.set(filteredEnvironment?10/1408:(SR_QUALITY_MIX>0&&mode==='light'?12:4)/this.width,0);`);
 source=replace(source,"  this.blurMaterial.uniforms.source.value=this.blurTargets[0].texture;this.blurMaterial.uniforms.direction.value.set(0,(SR_QUALITY_MIX>0&&mode==='light'?12:4)/this.height);",`  blurUniforms.draftPrefilterReflection.value=0;
  this.blurMaterial.uniforms.source.value=this.blurTargets[0].texture;this.blurMaterial.uniforms.direction.value.set(0,filteredEnvironment?10/792:(SR_QUALITY_MIX>0&&mode==='light'?12:4)/this.height);`);
 // The deck, crossbeams and piers share the existing sun shadow map.
 // Road surfacing and lane markings retain their receiver-only depth treatment.
 source=replace(source,'this.box(totalWidth+.6,.95,70-distantEnd,deckCenter,deck-.48,(70+distantEnd)/2,\'curb\').castShadow=false;',
  "this.box(totalWidth+.6,.95,70-distantEnd,deckCenter,deck-.48,(70+distantEnd)/2,'curb').userData.bridgeStructure=true;");
 source=replace(source,"this.box(totalWidth-2,.8,2.6,deckCenter,deck-1.3,z,'building',.08).castShadow=false;",
  "this.box(totalWidth-2,.8,2.6,deckCenter,deck-1.3,z,'building',.08).userData.bridgeStructure=true;");
 source=replace(source,"for(const side of [-1,1])this.box(1.65,deck-1.7,1.9,deckCenter+side*6,(deck-1.7)/2,z,'building',.06).castShadow=false;",
  "for(const side of [-1,1])this.box(1.65,deck-1.56,1.9,deckCenter+side*6,(deck-1.84)/2,z,'building',.06).userData.bridgeStructure=true;");
 source=replace(source,"id==='03'&&!o.userData.buildingOwned&&[this.mat.road",
  "id==='03'&&!o.userData.buildingOwned&&!o.userData.bridgeStructure&&[this.mat.road");
 // Keep building sun shadows disabled. Their blurred mirror capture supplies
 // the requested ground reflection without a second directional silhouette.
 source=replace(source,'surroundBlend:SR_QUALITY_MIX>0?.48:.38','surroundBlend:SR_QUALITY_MIX>0?.68:.38');
 source=replace(source,"(dark?.16:.22);","0;");
 source=replace(source,'bodyContact.material.uniforms.opacity.value=SR_QUALITY_MIX>0?(dark?.28:.36):(dark?.30:.38);','bodyContact.material.uniforms.opacity.value=isIndoor?0:isParking?(dark?.95:.99):.53;');
 source=replace(source,'this.weatherSignature,this.drivingFrame]);','this.weatherSignature,(this.vegetation?.children.length||this.environmentGrowth.roadworks.value>0||(this.environmentGrowth.buildings.value>0&&this.buildingPlacements.length))?this.drivingFrame:0]);');
 source=replace(source,'reflectedCar,this.drivingFrame].join','reflectedCar,this.buildingPlacements.length?this.drivingFrame:0].join');
 return source;
}

export function refineWeather(source){
 const start=source.indexOf('const skyFragment='),end=source.indexOf('\n\nconst mirror=',start);
 if(start<0||end<0)throw Error('Weather shader baseline mismatch');
 const fragment=`const skyFragment=\`varying vec3 v;uniform vec3 top;uniform vec3 bottom;uniform float range;uniform vec3 weatherTop;uniform vec3 cloudLight;uniform vec3 cloudShade;uniform float amount;uniform float coverage;uniform float cloudOpacity;uniform float daylightHorizon;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 cell=floor(p),f=fract(p);f=f*f*f*(f*(f*6.-15.)+10.);return mix(mix(hash(cell),hash(cell+vec2(1.,0.)),f.x),mix(hash(cell+vec2(0.,1.)),hash(cell+1.),f.x),f.y);}
void main(){
 vec3 d=normalize(v);float t=smoothstep(0.,range,d.y);
 vec3 viewDirection=normalize(v-cameraPosition);
 float viewElevation=viewDirection.y;
 float elevation=max(viewElevation,0.);t=mix(t,elevation/(elevation+range*.52),daylightHorizon);
 vec3 color=mix(bottom,mix(top,weatherTop,amount),t);
 float broad=noise(d.xz*.85+vec2(d.y*.45,4.));
 float upper=smoothstep(.015,.22,d.y);
 vec3 cloud=mix(cloudShade,cloudLight,smoothstep(.15,.85,broad));
 color=mix(color,cloud,upper*cloudOpacity*amount*.18);
 if(coverage>0.){
  float rainClouds=noise(viewDirection.xz*2.6+vec2(8.7,elevation*1.8));
  vec3 rainLayer=mix(cloudShade,cloudLight,smoothstep(.20,.80,rainClouds));
  float cloudBase=smoothstep(.008,.135,elevation);
  color=mix(color,rainLayer,cloudBase*coverage*.36);
 }
 gl_FragColor=vec4(color,1.);
 #include <colorspace_fragment>
}\`;`;
 const result=replace(source.slice(0,start)+fragment+source.slice(end),'cloudOpacity:{value:0}});','cloudOpacity:{value:0},daylightHorizon:{value:0}});');
 return replace(result,'u.weatherTop.value.copy(u.top.value).lerp(p.top,1.15);u.cloudLight.value.copy(p.light);u.cloudShade.value.copy(p.shade);u.coverage.value=p.coverage;u.cloudOpacity.value=p.opacity;',"const themeTone=world.draftThemeTone?.value??(dark?1:0),light=WEATHER[weather].light,night=WEATHER[weather].dark;u.weatherTop.value.copy(light.top).lerp(night.top,themeTone).sub(u.top.value).multiplyScalar(1.15).add(u.top.value);u.cloudLight.value.copy(light.light).lerp(night.light,themeTone);u.cloudShade.value.copy(light.shade).lerp(night.shade,themeTone);u.coverage.value=p.coverage;u.cloudOpacity.value=THREE.MathUtils.lerp(light.opacity,night.opacity,themeTone);");
}

export function refineRainGround(source){
 const start=source.indexOf('  // A road crown drains'),end=source.indexOf('\n }',start);
 if(start<0||end<0)throw Error('Rain ground baseline mismatch');
 return source.slice(0,start)+`  // Keep a uniform wet surface without puddle islands or water stains.
  return color*(1.-weatherAmount*level*.5);`+source.slice(end);
}

export function refineSnowGround(source){
 const start=source.indexOf(' // Thin settling snow favours'),end=source.indexOf(' float accumulation=',start);
 if(start<0||end<0)throw Error('Snow ground baseline mismatch');
 const snow=`
 float distSnow=abs(world.x-weatherRoad.x)/max(weatherRoad.y,1.);
 float edgeSnow=smoothstep(.55,1.,distSnow);
 float settling=mix(.3+.7*edgeSnow,1.,max(clamp(roof,0.,1.),1.-weatherRoad.z));
 float crown=roof>1.5?1.:0.;
 float snowUp=smoothstep(mix(.54,.16,crown),mix(.92,.85,crown),up);
 float cover=roof>.5?snowUp*.72:level*settling*.30;
`;
 return (source.slice(0,start)+snow+source.slice(end)).replace("const KEY='-weather-ground-7';","const KEY='-weather-ground-draft-continuous-1';").replace('animated road-width drainage; stable irregular roof and crown snow patches','animated road-width drainage; continuous normal-weighted snow coating');
}

export function refineActivation(source){
 // Ramp mainlines are centred on x=0 and have their own fixed road geometry.
 // layoutVisual can still contain the previous Road scene's lane width.
 source=replace(source,'activationCarriageway(state,visualWidth)','activationCarriageway(state,visualWidth,rampWidth)');
 source=replace(source,"if(state?.id==='03')", "if(['06','07'].includes(state?.id)){const half=(Number.isFinite(rampWidth)?rampWidth:7.4)/2;return {min:-half+.315,max:half-.315};}if(state?.id==='03')");
 source=replace(source,'return {min:-5.55,max:5.55};','return {min:-5.235,max:5.235};');
 source=replace(source,'activationCarriageway(world.state,world.layoutVisual?.width)','activationCarriageway(world.state,world.layoutVisual?.width,world.rampDimensions?.width)');
 source=replace(source,"if(state?.id==='03')","if(['10','14','15','16','17','18','19'].includes(state?.id))return {min:-3.3,max:3.3};if(state?.id==='03')");
 source=source.replace("['02','09','03'].includes(world.state?.id)","!!world.state").replace(')*edge*nearFade*fade*mix',')*.8*edge*nearFade*fade*mix');
 // Junction carriageways have a fixed width, independent of the last Road layout.
 source=replace(source,"if(['06','07'].includes(state?.id))","if(['05','08'].includes(state?.id))return {min:.225,max:10.785};if(['06','07'].includes(state?.id))");
 source=replace(source,'new THREE.PlaneGeometry(24,132)','new THREE.PlaneGeometry(24,320)');
 source=replace(source,'world.car.position.z-60','world.car.position.z-145');
 source=replace(source,'float nearFade=smoothstep(-3.,9.,distance);','float nearFade=smoothstep(-3.,9.,distance);float farFade=1.-smoothstep(68.,126.,distance);');
 source=replace(source,'pow(max(0.,1.-progress),.85);','(1.-smoothstep(.40,1.,progress));');
 source=replace(source,'*edge*nearFade*fade*mix','*edge*nearFade*farFade*fade*mix');
 return source;
}
