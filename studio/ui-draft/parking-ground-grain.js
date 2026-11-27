export const parkingGroundGrain = `
float concreteHash(vec2 p){
 vec3 q=fract(vec3(p.xyx)*.1031);
 q+=dot(q,q.yzx+33.33);
 return fract((q.x+q.y)*q.z);
}
float concreteGrain(vec2 p){
 vec2 i=floor(p),f=fract(p);
 f=f*f*(3.-2.*f);
 float n=mix(mix(concreteHash(i),concreteHash(i+vec2(1,0)),f.x),
             mix(concreteHash(i+vec2(0,1)),concreteHash(i+vec2(1)),f.x),f.y);
 return (n-.5)*(1.-smoothstep(.48,1.4,length(fwidth(p))));
}
float parkingGrain(vec2 p,float fine,float tone){
 // Crossfade fixed endpoint patterns; moving their frequency makes the floor crawl.
 vec2 day=p*vec2(5.5,4.),night=p*vec2(9.5);
 float dayGrain=concreteGrain(day)*.014+concreteGrain(day*.27)*.015;
 float nightGrain=concreteGrain(night)*.018+concreteGrain(night*.27)*.004;
 return mix(dayGrain,nightGrain,fine)*mix(.45,.75,tone);
}`;
