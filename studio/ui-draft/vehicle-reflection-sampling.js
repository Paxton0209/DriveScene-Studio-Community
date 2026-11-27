// Enclose the rotated body continuously; a binary 30-degree orientation switch
// changes the floor response abruptly while the reversing car turns smoothly.
export function updateVehicleReflectionFootprint(car,target){
 const spec=car.userData.vehicleSpec||{},width=(spec.width||1.9*vehicleTrackScale(spec))+.55,length=(car.userData.physicalLength||spec.length||4.85)+.45;
 const c=Math.abs(Math.cos(car.rotation.y)),s=Math.abs(Math.sin(car.rotation.y));
 return target.set(car.position.x,car.position.z,(width*c+length*s)*.75,(length*c+width*s)*.75);
}

// Normalize to the Model 3 track so the same falloff follows each silhouette.
export function vehicleTrackScale(spec){
 let outer=0;
 for(const {min,max} of spec.wheels||[])outer=Math.max(outer,-min[0],max[0]);
 return outer ? outer/.93 : 1;
}

export function tireShadowScale(wheel){
 const width=wheel.max[0]-wheel.min[0];
 const diameter=wheel.max[2]-wheel.min[2];
 return [width/.246,diameter/.69];
}

// Weight colour and coverage by source height before filtering. Raw roof/window
// depth is discontinuous; reapplying it after blur creates detached arches and
// repeating bands. These are the existing horizontal/vertical car blur passes.
// Bound isolated HDR highlights before blur and carry lamp radiance into the night reflection.
export const vehicleReflectionPrefilter=`
uniform sampler2D source;uniform sampler2D reflectionDepth;
uniform mat4 reflectionInverse;uniform vec2 direction;
uniform float absorbSource;uniform float reflectionTone;uniform float groundY;uniform float draftVehicleMirror;
varying vec2 vUv;
void main(){vec4 color=vec4(0.);float total=0.;
 for(int i=-6;i<=6;i++){
  vec2 uv=vUv+direction*float(i);float weight=exp(-float(i*i)/8.);
  float absorption=1.;
  if(absorbSource>.5){
   float depth=texture2D(reflectionDepth,uv).x;
   vec4 p=reflectionInverse*vec4(uv*2.-1.,depth*2.-1.,1.);
   float height=max(0.,p.y/p.w-groundY);
   float rate=mix(.8,1.1,reflectionTone);
   absorption=exp(-height*rate)*(1.-smoothstep(.65,1.65,height));
  }
  vec4 sampleColor=texture2D(source,uv);
  if(absorbSource>.5){
   float peak=max(sampleColor.r,max(sampleColor.g,sampleColor.b));
   sampleColor.rgb*=min(1.,4./max(peak,.0001));
  }
  float warm=max(0.,sampleColor.r-max(sampleColor.g,sampleColor.b));
  sampleColor.rgb=mix(sampleColor.rgb,sampleColor.rgb*mix(.12,.50,draftVehicleMirror)+vec3(warm*mix(12.,3.8,draftVehicleMirror),warm*.8,warm*.5),absorbSource*reflectionTone);
  color+=sampleColor*absorption*weight;total+=weight;
 }
 gl_FragColor=color/total;
}`.replace(/^ *\/\/.*\n|^ +/gm, '');
// The requested +30% replaces +80%, using the same 1.68 baseline.
// Every ground receiver uses this response; traffic retains its weaker role.
export const LIGHT_REFLECTION_GAIN=1.68*1.3;
export const DARK_REFLECTION_STRENGTH=.18;
export function bodyReflectionStrength(tone=0,ego=true){return ((1-tone)*(.255*LIGHT_REFLECTION_GAIN)+tone*.32)*(ego?1:.42)}
// Parking retains more near-field contrast than asphalt.
// Express roughness in normalized coordinates so preview and export agree.
export const vehicleReflectionSampling=`
uniform float draftVehicleMirror;
vec3 compositeVehicleReflection(vec3 ground,vec3 source,float coverage,float tone,float strength,float gain,bool parking,float exposure){
 if(draftVehicleMirror>.5){
  vec3 contrast=clamp(source-ground,vec3(-.30),vec3(.40));
  float strengthByTone=parking?mix(.54,.39,tone):mix(.23,.20,tone);
  return clamp(ground+contrast*clamp(coverage*strengthByTone*(parking?gain:1.)*(1.+tone*exposure),0.,1.),0.,1.);
 }
 float groundLuma=max(dot(ground,vec3(.2126,.7152,.0722)),.035);
 vec3 reference=vec3(.702,.737,.773);
 float referenceLuma=dot(reference,vec3(.2126,.7152,.0722));
 vec3 lightDelta=(source-reference)*(groundLuma/referenceLuma);
 lightDelta*=(1.+2.*groundLuma)/(1.+2.*.46);
 float nightContrast=clamp(pow(groundLuma/.025,.65),.6,2.);
 vec3 darkDelta=(vec3(1.)-ground)*source*(1.5*nightContrast);
 float nightStrength=tone*${DARK_REFLECTION_STRENGTH};
 float lightCoverage=clamp(coverage*(strength-nightStrength)*${.255*LIGHT_REFLECTION_GAIN}*gain,0.,1.);
 float darkCoverage=clamp(coverage*nightStrength*.32,0.,1.);
 return clamp(ground+lightDelta*lightCoverage+darkDelta*darkCoverage,0.,1.);
}
vec4 roughVehicleSample(vec2 uv,float distance,bool parking){
 if(parking&&draftVehicleMirror>.5){
  // Sample the blurred capture across a wider area as the floor leaves the car.
  vec2 stepUV=vec2(.0045,.009)*mix(1.,1.9,smoothstep(.25,.95,distance));
  vec4 color=texture2D(reflectionTexture,uv)*.28;
  for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
   int offset=abs(x)+abs(y);
   if(offset>0)color+=texture2D(reflectionTexture,uv+vec2(float(x),float(y))*stepUV)*(offset==1?.12:.06);
  }
  return color;
 }
 if(draftVehicleMirror>.5){
  vec2 stepUV=vec2(.0030,.0060)*mix(1.,2.3,smoothstep(0.,1.1,distance));
  vec4 color=texture2D(reflectionTexture,uv)*.24;
  for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
   if(x!=0||y!=0)color+=texture2D(reflectionTexture,uv+vec2(float(x),float(y))*stepUV)*.070;
  }
  // Asphalt spreads part of the response along the viewing direction.
  color+=texture2D(reflectionTexture,uv-vec2(0.,.016))*.13;
  color+=texture2D(reflectionTexture,uv-vec2(0.,.027))*.07;
  return color;
 }
 float radius=mix(4.,18.,smoothstep(0.,.9,distance));
 vec2 roughnessStep=vec2(1./1408.,1./792.);
 vec4 color=vec4(0.);float sum=0.;
 for(int x=-3;x<=3;x++)for(int y=-8;y<=8;y++){
  float w=exp(-float(x*x)/4.5-abs(float(y))*.20);
  vec2 sampleUV=uv+vec2(float(x)*radius/3.,(float(y)+float(x)/7.)*8.)*roughnessStep*2.;
  color+=texture2D(reflectionTexture,sampleUV)*w;sum+=w;
 }
 return color/sum;
}`.replace(/^ *\/\/.*\n|^ +/gm, '');
