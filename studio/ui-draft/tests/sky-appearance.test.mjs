import test from 'node:test';
import assert from 'node:assert/strict';
import {Color} from 'three';
import {applySkyAppearance,rememberSkyAppearance,weatherSkyEndpoint} from '../sky-appearance.js';
import {trafficHeading} from '../driving-heading.js';

const colors=['top','bottom','weatherTop','cloudLight','cloudShade'];
const palette=Object.fromEntries(['overcast','rain','snow'].map(key=>[key,{
 light:{top:new Color('#aab5c0'),light:new Color('#ccd5df'),shade:new Color('#667788'),opacity:.7},
 dark:{top:new Color('#23282d'),light:new Color('#444950'),shade:new Color('#111820'),opacity:.8}
}]));
const uniforms=()=>Object.fromEntries([...colors.map(k=>[k,{value:new Color()}]),['range',{value:.2}],['cloudOpacity',{value:0}]]);
const base=mode=>({top:new Color(mode==='light'?'#96bde0':'#1d1e20'),bottom:new Color(mode==='light'?'#ccd5df':'#373a3e'),range:mode==='light'?.2:.3});

test('Weather sky interpolates completed endpoints once in both theme directions and interrupted blends',()=>{
 for(const id of ['01','06','07','09','10','17'])for(const weather of ['default','overcast','rain','snow','mixed']){
  const weights=Object.fromEntries(['default','overcast','rain','snow'].map(k=>[k,weather==='mixed'?.25:Number(weather===k)]));
  const world={state:{id,mode:'light'},sky:{material:{uniforms:uniforms()}}},u=uniforms();
  for(const mode of ['light','dark']){
   const b=base(mode);world.state.mode=mode;
   world.sky.material.uniforms.top.value.copy(b.top);world.sky.material.uniforms.bottom.value.copy(b.bottom);world.sky.material.uniforms.range.value=b.range;
   rememberSkyAppearance(world);
  }
  const indoor=id==='10',light=weatherSkyEndpoint(base('light'),weights,palette,false,indoor),dark=weatherSkyEndpoint(base('dark'),weights,palette,true,indoor);
  for(const tone of [0,.01,.05,.2,.5,.85,1,.9,.6,.7,.3,0]){
   applySkyAppearance(world,weights,palette,u,indoor,tone);
   for(const key of colors){
    const expected=light[key].clone().lerp(dark[key],tone);
    for(const c of ['r','g','b'])assert.ok(Math.abs(u[key].value[c]-expected[c])<1e-12,`${id}/${weather}/${key}/${tone}`);
   }
   assert.ok(Math.abs(u.range.value-(light.range+(dark.range-light.range)*tone))<1e-12);
  }
 }
});

test('Sky baseline caches are separate for scenes and read the newly committed theme',()=>{
 const world={state:{id:'01',mode:'light'},sky:{material:{uniforms:uniforms()}}};
 world.sky.material.uniforms.bottom.value.set('#ccd5df');rememberSkyAppearance(world);
 world.state={id:'10',mode:'dark'};world.sky.material.uniforms.bottom.value.set('#252628');rememberSkyAppearance(world);
 assert.equal(world.draftSkyBaselines.get('01').light.bottom.getHexString(),'ccd5df');
 assert.equal(world.draftSkyBaselines.get('10').dark.bottom.getHexString(),'252628');
});

test('A nearly stopped traffic car does not anticipate a later lane change',()=>{
 for(const speed of [0,.0001,.01,.1,.3,1]){
  const car={speedAt:()=>speed,distanceAt:t=>t*speed,xAt:t=>t<11?0:3.7};
  assert.equal(trafficHeading(car,9.8),0);
 }
 const diagonal={speedAt:()=>4,distanceAt:t=>4*t,xAt:t=>t};
 assert.ok(Math.abs(trafficHeading(diagonal,3)-Math.atan2(-1,4))<1e-12);
});
