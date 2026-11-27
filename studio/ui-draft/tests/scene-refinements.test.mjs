import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {refineWorld,refineWeather,refineSnowGround,refineActivation} from '../scene-refinements.mjs';
import {isolatedRuntimePlugin} from '../runtime-patches.mjs';

test('Horizon uses output color space and one distance curve throughout the theme blend',async()=>{
 const source=refineWorld(await readFile(new URL('../../engine/world.js',import.meta.url),'utf8'));
 assert.match(source,/linearToOutputTexel\(vec4\(fogColor,1\.\)\)\.rgb/);
 assert.doesNotMatch(source,/vFogDepth-65\.\)\/235\./);
 assert.doesNotMatch(source,/outgoingLight=mix\(outgoingLight,sharedHorizon/);
 assert.match(source,/bodyContact.material.uniforms.opacity.value=isIndoor\?0:/);
});

test('Weather uses a broad low-contrast field without a projective cloud band',async()=>{
 const source=refineWeather(await readFile(new URL('../../engine/version-features.js',import.meta.url),'utf8'));
 const shader=source.slice(source.indexOf('const skyFragment='),source.indexOf('const mirror='));
 assert.doesNotMatch(shader,/fbm|d\.xz\/|float band=/);
 assert.match(shader,/cloudOpacity\*amount\*\.18/);
});

test('Scan fades out inside its geometry, with zero energy at the far boundary and at completion',async()=>{
 const source=refineActivation(await readFile(new URL('../../engine/activation-sweep.js',import.meta.url),'utf8'));
 assert.match(source,/PlaneGeometry\(24,320\)/);assert.match(source,/smoothstep\(68\.,126\.,distance\)/);
 assert.match(source,/\*edge\*nearFade\*farFade\*fade/);
 const farEdge=145+320/2;
 assert.ok(farEdge>126+118);
 assert.match(source,/1\.-smoothstep\(\.40,1\.,progress\)/);
});

test('Indoor finish is isolated while preserving shared light ground and contact details',async()=>{
 let load;isolatedRuntimePlugin().setup({onLoad(_options,handler){load=handler}});
 const result=await load({path:new URL('../../engine/parking-reference.js',import.meta.url).pathname});
 assert.match(result.contents,/const floor=createParkingSurface\(world,tone,false\)/);

 assert.match(result.contents,/createIndoorDetails\(world\)/);
 const outdoor=await load({path:new URL('../../engine/outdoor-parking.js',import.meta.url).pathname});
 assert.match(outdoor.contents,/surface.material=createParkingSurface\(world,tone,true\)/);
});

test('Snow is a continuous orientation-weighted coating without dirty noise islands or a dark undercoat',async()=>{
 const original=await readFile(new URL('../../engine/weather-ground.js',import.meta.url),'utf8'),updated=refineSnowGround(original);
 const snow=updated.slice(updated.indexOf(' float distSnow='),updated.indexOf('const strRoof='));
 assert.doesNotMatch(snow,/weatherNoise|patches|drift|coarse|fine|color\*=/);
 assert.match(snow,/float cover=roof>\.5\?snowUp\*\.72:level\*settling\*\.30/);
 assert.match(snow,/roadClear=mix\(1\.,edgeSnow/);
 assert.equal(updated.slice(updated.indexOf(' if(weatherKind<1.5)'),updated.indexOf(' float distSnow=')).trimEnd(),original.slice(original.indexOf(' if(weatherKind<1.5)'),original.indexOf(' // Thin settling snow favours')).trimEnd());
});

test('Rain removes only flat-ground puddle islands while preserving roof wetting and snow',async()=>{
 let load;isolatedRuntimePlugin().setup({onLoad(_options,handler){load=handler}});
 const {contents}=await load({path:new URL('../../engine/weather-ground.js',import.meta.url).pathname});
 const rain=contents.slice(contents.indexOf('if(weatherKind<1.5)'),contents.indexOf('float distSnow='));
 assert.doesNotMatch(rain,/float pool=|float pockets=|float sheen=/);
 assert.match(rain,/if\(roof>\.5\)/);assert.match(rain,/return color\*\(1\.-weatherAmount\*level\*\.5\)/);
 assert.match(contents,/float cover=roof>\.5/);
});

test('Final isolated runtime preserves the reference distant horizon without adding ramp scenery',async()=>{
 let load;isolatedRuntimePlugin().setup({onLoad(_options,handler){load=handler}});
 const {contents}=await load({path:new URL('../../engine/world.js',import.meta.url).pathname});
 assert.match(contents,/vFogDepth-220\.\)\/335\./);
 assert.match(contents,/float aerial=t\*t\*t\*\(t\*\(t\*6\.-15\.\)\+10\.\)/);
 assert.match(contents,/isIndoor\?'#252628':isParking\?'#303132':'#373a3e'/);
 assert.match(contents,/this\.scene\.fog\.color\.copy\(this\.sky\.material\.uniforms\.bottom\.value\)/);
 assert.doesNotMatch(contents,/pow\(1\.-t,2\.\)/);
 assert.doesNotMatch(contents,/this\.ramp\(id,w\);yield\* this\.environmentSteps/);
 const structures=(await load({path:new URL('../../engine/structures.js',import.meta.url).pathname})).contents;
 assert.doesNotMatch(structures,/\['07','Merge'\]\],buildings:true,trees:true/);
});

test('Junction westbound frontage uses the Road spacing and staggered blocks through the distance',async()=>{
 const source=refineWorld(await readFile(new URL('../../engine/world.js',import.meta.url),'utf8'));
 const method=source.slice(source.indexOf(' environmentPlan('),source.indexOf(' environment(w,options'));
 const world=new Function('return ({'+method+'})')();
 const road=world.environmentPlan(22.2,{},'02');
 const junction=world.environmentPlan(22.2,{cross:true},'05');
 for(const side of [-1,1]){
  const exit=junction.filter(o=>o.kind==='building'&&o.args[6]&&Math.sign(o.args[1]+40)===side).map(o=>o.args);
  const frontage=road.filter(o=>o.kind==='building'&&Math.sign(o.args[0])===-side).map(o=>o.args);
  const transformed=exit.slice(0,frontage.length).map(([x,z,w,d,h,v])=>[-40-z,x+34,d,w,h,v]);
  for(const [i,site] of frontage.entries())assert.ok(site.every((value,j)=>Math.abs(value-transformed[i][j])<1e-8));
  const gaps=exit.slice(1).map(([x],i)=>exit[i][0]-x);
  assert.ok(Math.min(...gaps)>=26&&Math.max(...gaps)>=65);
  assert.ok(exit.at(-1)[0]<-510);
 }
 const lawns=junction.filter(o=>o.kind==='lawn'&&o.args[2]<-25).map(o=>o.args);
 const trees=junction.filter(o=>o.kind==='tree'&&o.args[0]<-25).map(o=>o.args);
 assert.ok(trees.some(([x])=>x<-510));
 assert.ok(trees.every(([x,z])=>lawns.some(([w,d,lx,lz])=>Math.abs(x-lx)<w/2&&Math.abs(z-lz)<d/2)));
});

// A duplicated upstream anchor must fail rather than silently patch one copy.
test('Atmosphere refinement rejects missing and ambiguous upstream distance anchors',async()=>{
 const source=await readFile(new URL('../../engine/world.js',import.meta.url),'utf8');
 const anchor='${lightQuality.aerialStart.toFixed(1)})/${lightQuality.aerialSpan.toFixed(1)}';
 assert.throws(()=>refineWorld(source.replace(anchor,'changed upstream curve')),/expected 1 anchor, found 0/);
 assert.throws(()=>refineWorld(source+'\n'+anchor),/expected 1 anchor, found 2/);
});


test('Parking horizon keeps daylight and foreground intact while night joins within the courtyard',async()=>{
 let load;isolatedRuntimePlugin().setup({onLoad(_options,handler){load=handler}});
 const {contents}=await load({path:new URL('../../engine/ground-reflection.js',import.meta.url).pathname});
 const expression=contents.match(/float aerial=([^;]+);vec3 courtyardSurface=surface;/)[1];
 const nightExpression=contents.match(/float nightHorizon=([^;]+);/)[1];
 assert.match(contents,/surface=mix\(surface,horizon,outdoor\*aerial\*\(1\.-outdoorNight\)\)/);
 assert.match(contents,/gl_FragColor\.rgb=mix\(gl_FragColor\.rgb,horizon,mix\(horizonBlend,nightHorizon,outdoorNight\)\)/);
 const smoothstep=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)};
 const evaluate=new Function('smoothstep','mix','exp','max','courtyardDistance','tone','return '+expression);
 const aerial=(distance,tone)=>evaluate(smoothstep,(a,b,t)=>a+(b-a)*t,Math.exp,Math.max,distance,tone);
 const night=new Function('exp','max','distanceToEye','return '+nightExpression);
 for(const d of [0,20,30,65,120,190])assert.equal(night(Math.exp,Math.max,d),aerial(d,1));
 for(const d of [0,10,20,50,95,120,180,250,1000])assert.equal(aerial(d,0),smoothstep(95,250,d));
 for(const d of [0,10,20])assert.equal(aerial(d,1),0);
 assert.ok(aerial(40,1)>.65);assert.ok(aerial(120,1)>.99);
 let previous=0;for(let d=0;d<=300;d++){const value=aerial(d,1);assert.ok(value>=previous&&value<=1);previous=value;}
});
