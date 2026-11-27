import {parkingGroundGrain} from './parking-ground-grain.js';

// Parking finish for the isolated preview, leaving the shared engine sources intact.
function once(source,from,to){if(source.split(from).length!==2)throw Error('Indoor finish anchor mismatch: '+from.slice(0,90));return source.replace(from,to);}
export function refineIndoorFinish(name,source){
 if(name==='world.js'){
  source=once(source,"this.sky.material.uniforms.top.value.set(dark?'#202225':'#96bde0');","this.sky.material.uniforms.top.value.set(dark?(isIndoor?'#252628':'#1c1d1e'):(isIndoor?'#c0c6ce':'#96bde0'));");
  // Use the published night horizon for the driving fog and the bottom of its sky.
  source=once(source,"this.sky.material.uniforms.bottom.value.set(dark?'#303132':'#dce5ee');",`this.sky.material.uniforms.bottom.value.set(dark?(isIndoor?'#252628':isParking?'#303132':'#373a3e'):(isIndoor?'#b7bfc9':'#dce5ee'));
  if(isIndoor&&this.draftParkingGray?.value)for(const key of ['top','bottom']){
   const color=this.sky.material.uniforms[key].value;
   const gray=.2126*color.r+.7152*color.g+.0722*color.b,amount=this.draftParkingGray.value;
   color.setRGB(color.r+(gray-color.r)*amount,color.g+(gray-color.g)*amount,color.b+(gray-color.b)*amount).multiplyScalar(1.10*(dark?1.16:1.25));
  }`);
  source=once(source,"this.fill.intensity=.35;}","this.fill.intensity=.35;if(dark){this.hemi.color.set('#dadbdd');this.sun.color.set('#e5e5e7');this.fill.color.set('#ccced1');}}");
 }
 if(name==='parking-reference.js'){
  source=once(source,'createParkingSurface(world,tone,true)','createParkingSurface(world,tone,false)');
  source=once(source,'for(const side of [-1,1])for(const z of rows){\n  const stop','if(!world.draftParkingGray?.value)for(const side of [-1,1])for(const z of rows){\n  const stop');
  source=once(source,'wheelStopFromBayEnd:.33','wheelStopFromBayEnd:world.draftParkingGray?.value?null:.33');
 }
 if(name==='outdoor-parking.js'){
  source=once(source,' world.parkingBays=[];', ' const showWheelStops=!world.draftParkingGray?.value;\n world.parkingBays=[];');
  source=once(source,'  // Short wheel stop inside the bay;', '  if(!showWheelStops)continue;\n  // Short wheel stop inside the bay;');
  source=once(source,'wheelStops:parkingBayRows.length*2,wheelStopFromBayEnd:.33',
   'wheelStops:showWheelStops ? parkingBayRows.length*2 : 0,wheelStopFromBayEnd:showWheelStops ? .33 : null');
 }
 if(name==='ground-reflection.js'){
  source=once(source,'uniforms:{tone,outdoor:{value:outdoor?1:0},','uniforms:{tone,parkingGray:world.draftParkingGray??{value:0},groundBrightness:(world.draftParkingFinish??={}).ground??={value:1},floorBlue:world.draftParkingFinish.blue??={value:0},indoor:{value:outdoor?0:1},outdoor:{value:1},');
  source=once(source,'uniform float tone;uniform float outdoor;uniform vec3 horizon;','uniform float tone;uniform float parkingGray;uniform float groundBrightness;uniform float floorBlue;uniform float indoor;uniform float outdoor;uniform vec3 horizon;');
  source=once(source,'void main(){\n float radius=',`${parkingGroundGrain}\nvoid main(){\n float radius=`);
  source=once(source,'center*.68','center*mix(.68,.43,indoor)');
  source=once(source,'.035*overhead','.035*mix(1.,.35,indoor)*overhead');
  // Indoor and outdoor floors start at different points on the ACES curve.
  source=once(source,'vec3 surface=mix(light,dark,tone);',`light*=mix(mix(.96,.65,indoor),1.,tone);
 vec3 surface=mix(light,dark,tone*(1.-indoor));
 // Grade the outdoor ground before weather and aerial perspective.
 surface*=mix(1.,mix(1.13,1.55,tone),(1.-indoor)*step(.01,parkingGray));`);
  source=once(source,'surface=mix(surface,horizon,outdoor*aerial);',`// The neutral outdoor floor applies haze after its color grade.
 float outdoorNight=tone*(1.-indoor)*step(.01,parkingGray);
 surface=mix(surface,horizon,outdoor*aerial*(1.-outdoorNight));`);
  source=once(source,'#include <colorspace_fragment>}`});',`// Keep a shallow lighting variation across the concrete.
 float poolIndoor=smoothstep(-65.,15.,p.z);
 vec3 indoorFloor=mix(vec3(.030,.032,.038),vec3(.037,.040,.048),poolIndoor);
 float parkingPreview=step(.01,parkingGray);
 float indoorPreview=parkingPreview*indoor;
 float distanceToEye=length(p.xz-cameraPosition.xz);
 float indoorHaze=1.-exp(-pow(max(0.,distanceToEye-14.)/37.,1.45));
 float indoorAerial=mix(smoothstep(35.,150.,-p.z),indoorHaze,indoorPreview);
 float outdoorAerial=smoothstep(65.,190.,distanceToEye);
 gl_FragColor.rgb=mix(gl_FragColor.rgb,indoorFloor,tone*indoor);
 // Small blue steps preserve luminance; brightness remains an independent axis.
 float floorLuma=dot(gl_FragColor.rgb,vec3(.2126,.7152,.0722));
 vec3 blueTint=vec3(.82,.99,1.63);blueTint/=dot(blueTint,vec3(.2126,.7152,.0722));
 gl_FragColor.rgb=mix(gl_FragColor.rgb,mix(gl_FragColor.rgb,floorLuma*blueTint,floorBlue)*groundBrightness,indoor);
 float neutral=dot(gl_FragColor.rgb,vec3(.2126,.7152,.0722));
 gl_FragColor.rgb=mix(gl_FragColor.rgb,vec3(neutral),parkingGray);
 gl_FragColor.rgb*=mix(1.,1.16*mix(1.25,1.16,tone),indoorPreview);
 gl_FragColor.rgb*=mix(1.,.88,tone*parkingPreview);
 // Apply the published exponential night falloff after grading, in any camera direction.
 float horizonBlend=mix(outdoorAerial*parkingPreview,indoorAerial,indoor);
 float nightHorizon=1.-exp(-max(0.,distanceToEye-20.)/18.);
 gl_FragColor.rgb=mix(gl_FragColor.rgb,horizon,mix(horizonBlend,nightHorizon,outdoorNight));
 float floorFade=smoothstep(.035,.24,normalize(cameraPosition-p).y);
 float textureLight=parkingGrain(p.xz,1.,tone)*floorFade*(1.-horizonBlend)*mix(3.,.35,tone);
 gl_FragColor.rgb+=vec3(textureLight*parkingPreview);
#include <colorspace_fragment>}\x60});`);
 }
 if(name==='weather-ground.js'){
  source=once(source,'surface=mix(surface,horizon,tone*(1.-indoor)*outdoor*aerial);',
   'surface=mix(surface,horizon,tone*(1.-indoor)*outdoor*aerial*(1.-outdoorNight));');
 }
 return source;
}
