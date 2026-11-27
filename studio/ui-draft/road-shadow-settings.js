// Separate shared uniforms reach ego and traffic contacts, including recycled cars.
export const roadShadowStrength={value:1},roadTrafficShadowStrength={value:1};
// Plane-local width/length; tyre contacts retain their original footprint.
export const roadShadowSpread={value:[1,1]};
export const roadContactProfile={value:0};
export function syncRoadShadow(scene,value=1){
 const driving=['road','elevated','ramp','junction'].includes(scene);
 roadContactProfile.value=Number(driving);
 roadShadowSpread.value[0]=driving?1.1:1;roadShadowSpread.value[1]=driving?1.075:1;
 const setting=Number.isFinite(value)?{ego:value,traffic:value}:value||{};
 for(const [key,uniform,max] of [['ego',roadShadowStrength,4],['traffic',roadTrafficShadowStrength,2]])uniform.value=driving&&Number.isFinite(setting[key])?Math.max(0,Math.min(max,setting[key])):1;
 return {ego:roadShadowStrength.value,traffic:roadTrafficShadowStrength.value};
}

// Shadow-map radius is measured in texels. Use world width so the soft edge
// keeps the same size when the preview swaps its map for a full-size export.
export function syncDrivingSunShadow(world,scene){
 const shadow=world.sun?.shadow;
 if(!shadow?.mapSize||!shadow.camera||!['road','elevated','ramp','junction'].includes(scene))return;
 const tone=world.draftThemeTone?.value??Number(world.state.mode==='dark');
 const penumbra=scene==='elevated'?1.38:.85;
 const radius=penumbra*shadow.mapSize.x/(shadow.camera.right-shadow.camera.left);
 const intensity=.23-.06*tone;
 if(shadow.radius===radius&&shadow.intensity===intensity)return;
 shadow.radius=radius;shadow.intensity=intensity;world.renderer.shadowMap.needsUpdate=true;
}
