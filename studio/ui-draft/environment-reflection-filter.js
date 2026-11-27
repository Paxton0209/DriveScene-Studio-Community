// Filter coverage, source-height attenuation and radiance together. Applying
// the unfiltered depth at the receiver reintroduces each building silhouette.
export const environmentReflectionPrefilter=`
uniform sampler2D draftReflectionDepth;
uniform mat4 draftReflectionInverse;
uniform float draftReflectionGroundY;
uniform float draftReflectionHeightFade;
uniform float draftPrefilterReflection;
uniform float draftEnvironmentBlur;
vec4 draftReflectionSample(vec2 uv){
 vec4 color=texture2D(source,uv);
 if(draftPrefilterReflection<.5)return color;
 float depth=texture2D(draftReflectionDepth,uv).r;
 if(color.a<.001||depth>=1.)return vec4(0.);
 vec4 point=draftReflectionInverse*vec4(uv*2.-1.,depth*2.-1.,1.);
 float height=max(0.,point.y/max(point.w,.0001)-draftReflectionGroundY);
 return color*exp(-height/draftReflectionHeightFade);
}
`;

// The five-tap bilinear kernel is only continuous at its native texel spacing.
// Enlarging that spacing makes separated copies of facade edges. Densely sample
// the same two passes so their footprints overlap even in a 4K export.
export const environmentReflectionBlur=`
if(draftEnvironmentBlur>.5){
 vec4 color=vec4(0.);float weightSum=0.;
 for(int i=-16;i<=16;i++){
  float weight=exp(-float(i*i)/40.);
  color+=draftReflectionSample(vUv+direction*(float(i)/8.))*weight;
  weightSum+=weight;
 }
 gl_FragColor=color/weightSum;
 return;
}
`;
