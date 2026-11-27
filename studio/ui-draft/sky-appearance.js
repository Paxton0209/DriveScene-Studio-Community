import {Color,MathUtils} from 'three';

const clearTop=new Color('#469fee'),clearHorizon=new Color('#ccd5df');
const rainTop=new Color('#626c77'),rainHorizon=new Color('#a6adb4');
const rainLight=new Color('#8d97a0'),rainShade=new Color('#515a64');
const snowTop=new Color('#bbc6d2'),snowHorizon=new Color('#d5dee6');

export function rememberSkyAppearance(world){
 const u=world.sky.material.uniforms;
 const scenes=world.draftSkyBaselines??=new Map();
 let pair=scenes.get(world.state.id);if(!pair)scenes.set(world.state.id,pair={});
 pair[world.state.mode]={top:u.top.value.clone(),bottom:u.bottom.value.clone(),range:u.range.value};
 return pair;
}

export function weatherSkyEndpoint(base,w,palette,dark,indoor){
 const day=dark?0:1,clear=day*w.default,rain=day*w.rain,snow=day*w.snow;
 const frame={top:base.top.clone(),bottom:base.bottom.clone(),range:base.range,
  weatherTop:base.top.clone().multiplyScalar(w.default),cloudLight:new Color(0),cloudShade:new Color(0),cloudOpacity:0};
 for(const key of ['overcast','rain','snow']){
  const p=palette[key][dark?'dark':'light'];
  frame.weatherTop.add(p.top.clone().multiplyScalar(w[key]));
  frame.cloudLight.add(p.light.clone().multiplyScalar(w[key]));
  frame.cloudShade.add(p.shade.clone().multiplyScalar(w[key]));
  frame.cloudOpacity+=p.opacity*w[key];
 }
 if(!indoor){frame.weatherTop.lerp(clearTop,clear);frame.bottom.lerp(clearHorizon,clear);frame.range=MathUtils.lerp(frame.range,.23,clear);}
 frame.weatherTop.lerp(rainTop,rain).lerp(snowTop,snow);
 frame.bottom.lerp(rainHorizon,(w.rain+w.overcast*.16)*day).lerp(snowHorizon,snow);
 frame.cloudLight.lerp(rainLight,rain);frame.cloudShade.lerp(rainShade,rain);
 return frame;
}

export function applySkyAppearance(world,w,palette,u,indoor,tone){
 const pairs=world.draftSkyBaselines?.get(world.state.id);
 const pair=pairs?.[world.state.mode]?pairs:rememberSkyAppearance(world);
 world.draftRememberSkyAppearance=()=>rememberSkyAppearance(world);
 const base=pair[world.state.mode];
 const light=weatherSkyEndpoint(pair.light??base,w,palette,false,indoor);
 const dark=weatherSkyEndpoint(pair.dark??base,w,palette,true,indoor);
 // Interpolate the completed weather endpoints once. Applying daylight to an
 // already interpolated baseline made the horizon brighten before darkening.
 for(const key of ['top','bottom','weatherTop','cloudLight','cloudShade'])u[key].value.copy(light[key]).lerp(dark[key],tone);
 for(const key of ['range','cloudOpacity'])u[key].value=MathUtils.lerp(light[key],dark[key],tone);
}
