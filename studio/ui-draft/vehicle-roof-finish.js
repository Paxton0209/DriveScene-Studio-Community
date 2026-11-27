// Shared glazing often spans the roof and windows. Suppress reflections on
// upward glass without dimming the diffuse shape, side glazing, or lamps.
const prepared=new WeakSet();
export function softenVehicleRoof(car){
 car?.traverse(mesh=>{
  if(!mesh.isMesh||!mesh.material)return;
  for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
   if(!material?.isMeshStandardMaterial||prepared.has(material))continue;
   const role=material.userData.surfaceRole;
   if(role!=='glass'&&(role||material.name!=='glass'))continue;
   prepared.add(material);
   const compile=material.onBeforeCompile,key=material.customProgramCacheKey();
   material.onBeforeCompile=function(shader,renderer){
    compile.call(this,shader,renderer);
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_end>',`#include <lights_fragment_end>
     float roofUp=dot(nonPerturbedNormal,(viewMatrix*vec4(0.,1.,0.,0.)).xyz);
     float roofHighlight=mix(1.,.035,smoothstep(.52,.84,roofUp));
     reflectedLight.directSpecular*=roofHighlight;
     reflectedLight.indirectSpecular*=roofHighlight;
     #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect*=roofHighlight;
      clearcoatSpecularIndirect*=roofHighlight;
     #endif
    `);
   };
   material.customProgramCacheKey=()=>key+'-roof-highlight-1';
   material.needsUpdate=true;
  }
 });
}
