import * as THREE from 'three';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
import {createIndoorVehicleContact} from './parking-materials.js';
import {indoorShadowPresets} from './indoor-shadow-settings.js';
import {createStudioEnvironment} from '../engine/studio-environment.js';
import {applySrVehicleFinish} from '../engine/sr-vehicle-finish.js';
import {createVehicle} from '../engine/vehicle.js';
import {loadPreparedVehicle} from '../engine/vehicle-library/three/load-prepared.js';
import {parkingGroundGrain} from './parking-ground-grain.js';
import {finishParkedFront} from './parked-vehicle-finish.js';
import {vehicleTrackScale} from './vehicle-reflection-sampling.js';

const reference = {
  width: 1767, height: 1090, yaw: 29.76, pitch: 11.45, distance: 21.55,
  fov: 23.1, targetY: .69, shiftX: .00796, shiftY: -.18323
};
const LIGHT = [[222,224,224],[205,208,212]];
const DARK = [[29,30,32],[25,26,28]];
const flatColor = rgb => new THREE.Vector3(...rgb.map(value => value * 1.07 / 255));

const screenVertex=`varying vec2 frameUv;
  void main(){frameUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;

function makeFrontEdgePass(renderer) {
  let pixels;
  const material=new THREE.ShaderMaterial({
    uniforms:THREE.UniformsUtils.clone(FXAAShader.uniforms),
    vertexShader:FXAAShader.vertexShader.replace('projectionMatrix * modelViewMatrix * ',''),
    fragmentShader:FXAAShader.fragmentShader.replace(
      'gl_FragColor = ApplyFXAA( tDiffuse, resolution.xy, vUv );',
      `vec2 distanceToEdge=min(vUv,1.-vUv)/resolution;
       float weight=smoothstep(1.,8.,min(distanceToEdge.x,distanceToEdge.y));
       gl_FragColor=mix(texture(tDiffuse,vUv),ApplyFXAA(tDiffuse,resolution,vUv),weight);`
    ),
    depthTest:false,depthWrite:false,toneMapped:false
  });
  const scene=new THREE.Scene(),camera=new THREE.Camera();
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  quad.frustumCulled=false;scene.add(quad);
  const bounds=new THREE.Box2(),corner=new THREE.Vector3(),offset=new THREE.Vector2();
  return (view,width,height,bodyScale)=>{
    // Filter only the projected hood and front bumper at the existing resolution.
    bounds.makeEmpty();
    for(const x of [-.98,.98])for(const y of [.07,1.04])for(const z of [-2.48,-1.08]){
      corner.set(x*bodyScale.x,y,z*bodyScale.y).project(view);
      bounds.expandByPoint(offset.set((corner.x+1)*.5*width,(corner.y+1)*.5*height));
    }
    const left=Math.max(0,Math.floor(bounds.min.x)-8),bottom=Math.max(0,Math.floor(bounds.min.y)-8);
    const w=Math.min(width,Math.ceil(bounds.max.x)+8)-left,h=Math.min(height,Math.ceil(bounds.max.y)+8)-bottom;
    if(w<2||h<2)return;
    if(pixels?.image.width!==w||pixels?.image.height!==h){
      pixels?.dispose();pixels=new THREE.FramebufferTexture(w,h);
      pixels.minFilter=pixels.magFilter=THREE.LinearFilter;
    }
    renderer.copyFramebufferToTexture(pixels,offset.set(left,bottom));
    material.uniforms.tDiffuse.value=pixels;
    material.uniforms.resolution.value.set(1/w,1/h);
    renderer.setViewport(left,bottom,w,h);
    renderer.autoClear=false;
    renderer.render(scene,camera);
    renderer.autoClear=true;
    renderer.setViewport(0,0,width,height);
  };
}

function makeReflectionBlur(renderer) {
  const options={depthBuffer:false,type:renderer.extensions.has('EXT_color_buffer_float')?THREE.HalfFloatType:THREE.UnsignedByteType};
  const horizontal=new THREE.WebGLRenderTarget(1,1,options);
  const blurred=new THREE.WebGLRenderTarget(1,1,options);
  const material=new THREE.ShaderMaterial({
    depthTest:false,depthWrite:false,toneMapped:false,
    uniforms:{image:{value:null},stepUV:{value:new THREE.Vector2()},sigma:{value:1}},
    vertexShader:screenVertex,
    fragmentShader:`varying vec2 frameUv;
      uniform sampler2D image;
      uniform vec2 stepUV;
      uniform float sigma;
      void main(){
        vec4 sum=texture2D(image,frameUv);
        float weights=1.;
        for(int i=1;i<=24;i++){
          float pixel=float(i);
          if(pixel>ceil(3.*sigma))break;
          float weight=exp(-.5*pow(pixel/sigma,2.));
          vec2 delta=stepUV*pixel;
          sum+=(texture2D(image,frameUv+delta)+texture2D(image,frameUv-delta))*weight;
          weights+=2.*weight;
        }
        gl_FragColor=sum/weights;
      }`
  });
  const scene=new THREE.Scene(), camera=new THREE.Camera();
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  quad.frustumCulled=false;
  scene.add(quad);
  return {texture:blurred.texture,render(source){
    const {width,height}=source;
    const {image,stepUV,sigma}=material.uniforms;
    const radius=Math.max(2, height*.009);
    if(horizontal.width!==width||horizontal.height!==height){
      horizontal.setSize(width,height);
      blurred.setSize(width,height);
    }
    image.value=source.texture;
    stepUV.value.set(1/width,0);
    sigma.value=radius*.85;
    renderer.setRenderTarget(horizontal);
    renderer.render(scene,camera);
    image.value=horizontal.texture;
    stepUV.value.set(0,1/height);
    sigma.value=radius;
    renderer.setRenderTarget(blurred);
    renderer.render(scene,camera);
  }};
}

function makeBackdrop(reflection) {
  const material = new THREE.ShaderMaterial({
    depthTest:false, depthWrite:false, toneMapped:false,
    uniforms:{
      tones:{value:LIGHT.map(flatColor)}, dark:{value:0},
      viewToWorld:{value:new THREE.Matrix4()}, eye:{value:new THREE.Vector3()}, ground:{value:new THREE.Vector3()},
      reflection:{value:reflection}, reflectionAmount:{value:1}, reflectionStep:{value:new THREE.Vector2()},
      bodyScale:{value:new THREE.Vector2(1,1)}
    },
    vertexShader:screenVertex,
    fragmentShader:`varying vec2 frameUv;
      uniform vec3 tones[2];
      uniform float dark, reflectionAmount;
      uniform mat4 viewToWorld;
      uniform vec3 eye, ground;
      uniform sampler2D reflection;
      uniform vec2 reflectionStep, bodyScale;
      ${parkingGroundGrain}
      vec3 reflectionContrast(vec2 uv,vec3 floorColor){
        vec4 sampleColor=texture2D(reflection,uv);
        vec3 rgb=pow(max(vec3(0.),sampleColor.rgb/max(sampleColor.a,.001)),vec3(1./2.2));
        return clamp(rgb-floorColor,vec3(-.24),vec3(mix(.17,.16,dark)))*sampleColor.a;
      }
      void main(){
        // Spread the sky-to-floor shading over the frame. The ground ray still
        // anchors the concrete detail and reflection as the camera moves.
        float floorShade=mix((1.-.046)*(1.-.1165),.87,dark);
        float backdropFade=smoothstep(.04,.96,1.-frameUv.y);
        vec3 color=mix(tones[0],tones[1]*floorShade,backdropFade);
        vec4 rayEnd=viewToWorld*vec4(frameUv*2.-1.,1.,1.);
        vec3 ray=normalize(rayEnd.xyz/rayEnd.w-eye);
        vec2 floorPoint=eye.xz-ray.xz*eye.y/min(-.001,ray.y);
        float floorFade=smoothstep(.035,.24,-ray.y);
        // Anchor concrete variation to the floor. Filter details that become smaller than a pixel.
        float c=cos(ground.z),s=sin(ground.z);
        vec2 groundPoint=mat2(c,-s,s,c)*floorPoint+ground.xy;
        float floorWeight=smoothstep(.035,.15,-ray.y);
        color+=parkingGrain(groundPoint,dark,dark)*floorFade;
        float edge=length(max(abs(floorPoint)/bodyScale-vec2(.77,1.47),0.));
        if(reflectionAmount>0.&&edge<1.48&&floorWeight>0.){
          float distanceFade=smoothstep(.06,1.48,edge);
          vec2 spread=reflectionStep*mix(.70,1.35,distanceFade);
          vec3 softContrast=reflectionContrast(frameUv,color)*.40;
          for(int i=-1;i<=1;i+=2){
            softContrast+=reflectionContrast(frameUv+vec2(float(i)*spread.x,0.),color)*.15;
            softContrast+=reflectionContrast(frameUv+vec2(0.,float(i)*spread.y),color)*.15;
          }
          softContrast-=max(softContrast,vec3(0.))*mix(.52,.24,dark);
          float ink=floorWeight*(1.-distanceFade);
          color+=softContrast*reflectionAmount*ink*mix(.36,.37,dark);
        }
        // Tiny nonrepeating dither keeps an 8-bit export free of gradient bands.
        vec2 p=gl_FragCoord.xy;
        float d=fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))))-.5;
        gl_FragColor=vec4(color+d/255.,1.0);
      }`
  });
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  mesh.renderOrder=-10;mesh.frustumCulled=false;
  return mesh;
}

function softenModel3Hood(car) {
  const trim=car.getObjectByName('Object_13');
  if(!trim?.material || Array.isArray(trim.material))return;
  // Keep the lining continuous and reduce its contrast where it shows through the hood gap.
  trim.material=trim.material.clone();
  trim.material.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec3 parkedPos;\n'+shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\nparkedPos=(modelMatrix*vec4(transformed,1.0)).xyz;');
    shader.fragmentShader='varying vec3 parkedPos;\n'+shader.fragmentShader
      .replace('#include <color_fragment>',`#include <color_fragment>
        vec3 hood=vec3(abs(parkedPos.x),abs(parkedPos.y),parkedPos.z);
        float seam=(1.-smoothstep(.71,.77,hood.x))
          *smoothstep(-2.30,-2.28,hood.z)*(1.-smoothstep(-1.09,-1.04,hood.z))
          *smoothstep(.54,.60,hood.y);
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.21,.222,.228),seam);`);
  };
  trim.material.customProgramCacheKey=()=>'model3-parked-hood-seam';
}

function finishModel3Paint(material) {
  material.color.set('#eeeae8');
  material.metalness=.36;
  material.roughness=.30;
  material.envMapIntensity=.9;
  material.clearcoatRoughness=.25;
  const compile=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.onBeforeCompile=shader=>{
    compile.call(material,shader);
    shader.vertexShader='varying vec3 paintPosition;\n'+shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\npaintPosition=(modelMatrix*vec4(transformed,1.0)).xyz;');
    shader.fragmentShader='varying vec3 paintPosition;\n'+shader.fragmentShader.replace('#include <opaque_fragment>',`
      float frontFacing=-inverseTransformDirection(normal,viewMatrix).z;
      float front=(1.-smoothstep(-2.30,-1.98,paintPosition.z))*smoothstep(.16,.87,frontFacing);
      float fascia=front*smoothstep(.23,.42,abs(paintPosition.y))*(1.-smoothstep(.58,.72,abs(paintPosition.y)));
      outgoingLight*=1.-fascia*.32;
      #include <opaque_fragment>`);
  };
  material.customProgramCacheKey=()=>key+'-model3-parked-paint';
}

export function createParkedView() {
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  const scene=new THREE.Scene();
  scene.environment=createStudioEnvironment();scene.environmentIntensity=.38;
  const ambient=new THREE.HemisphereLight('#ffffff','#c9cbd0',1.65);scene.add(ambient);
  const key=new THREE.DirectionalLight('#ffffff',2.2);key.position.set(-6,9,-5);scene.add(key);
  const fill=new THREE.DirectionalLight('#ffffff',.7);fill.position.set(6,3,3);scene.add(fill);
  const reflection=new THREE.WebGLRenderTarget(1,1,{samples:Math.min(4,renderer.capabilities.maxSamples)});
  const reflectionBlur=makeReflectionBlur(renderer);
  const smoothFrontEdges=makeFrontEdgePass(renderer);
  const backdrop=makeBackdrop(reflectionBlur.texture);scene.add(backdrop);
  const camera=new THREE.PerspectiveCamera(reference.fov,reference.width/reference.height,.5,200);
  const referenceCamera=camera.clone();
  const yaw=THREE.MathUtils.degToRad(reference.yaw),pitch=THREE.MathUtils.degToRad(reference.pitch);
  const target=new THREE.Vector3(0,reference.targetY,0),distance=reference.distance;
  referenceCamera.position.copy(target).add(new THREE.Vector3(
    distance*Math.cos(pitch)*Math.sin(yaw),distance*Math.sin(pitch),-distance*Math.cos(pitch)*Math.cos(yaw)
  ));
  referenceCamera.lookAt(target);
  const pivot=new THREE.Vector3(0,.85,0);
  const vehicles=new Map();
  let current, theme;
  async function prepareVehicle(id) {
    if(!vehicles.has(id)){
      const entry=(async()=>{
        const car=applySrVehicleFinish(await(id==='x6' ? createVehicle() : loadPreparedVehicle(id,{
          url:new URL('./vehicles/'+id+'/model.glb.gz?v=restore26',import.meta.url)
        })));
        if(id==='model-3'){
          softenModel3Hood(car);
          const materials=new Set();
          car.traverse(mesh=>{if(mesh.isMesh)for(const material of [mesh.material].flat())materials.add(material);});
          for(const material of materials){
            const role=material.userData.surfaceRole;
            if(role==='glass'){
              material.color.set('#151c23');
              material.roughness=.32;
              material.envMapIntensity=.40;
            }
            if(role==='paint')finishModel3Paint(material);
          }
        }
        finishParkedFront(car,id);
        const groundContact=createIndoorVehicleContact(car,{ego:true});
        // Match the contact footprint from the indoor still. Keep it independent of the mirror.
        groundContact.children[1].material.uniforms.footprint.value=1;
        // The first two meshes cover the body and the last one covers the rear.
        for(const wheel of groundContact.children.slice(2,-1))wheel.scale.set(1.10,1.14,1);
        const group=new THREE.Group();
        group.add(car,groundContact);
        const spec=car.userData.vehicleSpec;
        group.userData.bodyScale=new THREE.Vector2(vehicleTrackScale(spec),(spec.length||4.85)/4.72);
        return group;
      })().catch(error=>{vehicles.delete(id);throw error;});
      vehicles.set(id,entry);
    }
    return vehicles.get(id);
  }
  function frame(camera,width,height,offset) {
    camera.setViewOffset(width,height,offset.x*width,offset.y*height,width,height);
    camera.updateMatrixWorld();
  }
  function placeCamera(width,height,source,progress) {
    const offset=new THREE.Vector2(reference.shiftX*height/width*reference.width/reference.height,reference.shiftY);
    camera.position.copy(referenceCamera.position);
    camera.quaternion.copy(referenceCamera.quaternion);
    camera.fov=reference.fov;
    frame(camera,width,height,offset);
    if(!source||progress===1)return;
    const to=pivot.clone().project(camera);
    const from=new THREE.Vector3().fromArray(source.position);
    const a=new THREE.Spherical().setFromVector3(from.sub(pivot));
    const b=new THREE.Spherical().setFromVector3(camera.position.clone().sub(pivot));
    b.theta=a.theta+Math.atan2(Math.sin(b.theta-a.theta),Math.cos(b.theta-a.theta));
    const lerp=THREE.MathUtils.lerp;
    camera.position.setFromSphericalCoords(lerp(a.radius,b.radius,progress),lerp(a.phi,b.phi,progress),lerp(a.theta,b.theta,progress)).add(pivot);
    camera.quaternion.slerpQuaternions(new THREE.Quaternion().fromArray(source.orientation),referenceCamera.quaternion,progress);
    camera.fov=lerp(source.fov,reference.fov,progress);
    offset.set(lerp(source.offset[0],offset.x,progress),lerp(source.offset[1],offset.y,progress));
    frame(camera,width,height,offset);
    // Keep the vehicle in the same screen location during the canvas handoff.
    const at=pivot.clone().project(camera);
    offset.x+=(at.x-lerp(source.anchor[0],to.x,progress))*.5;
    offset.y-=(at.y-lerp(source.anchor[1],to.y,progress))*.5;
    frame(camera,width,height,offset);
  }
  function draw(width,height,source=null,progress=1,animated=false) {
    if(renderer.domElement.width!==width||renderer.domElement.height!==height)renderer.setSize(width,height,false);
    placeCamera(width,height,source,progress);
    const [car,contact]=current.children;
    const ink=THREE.MathUtils.smoothstep(progress,.65,.99);
    backdrop.material.uniforms.reflectionAmount.value=ink;
    backdrop.material.uniforms.reflectionStep.value.set(.019*height/width,.019);
    if(ink>0){
      const rh=Math.min(animated?240:720,Math.ceil(height*.75)),rw=Math.ceil(rh*width/height);
      if(reflection.width!==rw||reflection.height!==rh)reflection.setSize(rw,rh);
      backdrop.visible=contact.visible=false;
      car.scale.y*=-1;
      renderer.setRenderTarget(reflection);
      renderer.setClearColor(0,0);
      renderer.render(scene,camera);
      car.scale.y*=-1;
      backdrop.visible=contact.visible=true;
      reflectionBlur.render(reflection);
      renderer.setRenderTarget(null);
    }
    backdrop.material.uniforms.viewToWorld.value.multiplyMatrices(camera.matrixWorld,camera.projectionMatrixInverse);
    backdrop.material.uniforms.eye.value.copy(camera.position);
    backdrop.material.uniforms.ground.value.fromArray(source?.ground??[0,0,0]);
    renderer.render(scene,camera);
    if(!animated)smoothFrontEdges(camera,width,height,current.userData.bodyScale);
  }
  function render({vehicle, theme:nextTheme, width, height, source, returning, progress, animated}) {
    if(current!==vehicle){
      if(current)scene.remove(current);
      current=vehicle;scene.add(current);
      backdrop.material.uniforms.bodyScale.value.copy(current.userData.bodyScale);
    }
    if(theme!==nextTheme){
      theme=nextTheme;
      backdrop.material.uniforms.tones.value=(theme==='dark'?DARK:LIGHT).map(flatColor);
      const dark=theme==='dark';
      backdrop.material.uniforms.dark.value=Number(dark);
      ambient.intensity=dark?1.12:1.65;
      key.intensity=dark?1.82:2.2;
      fill.intensity=dark?.50:.70;
      scene.environmentIntensity=dark?.30:.38;
      renderer.toneMappingExposure=dark?.86:1;
    }
    const dark=theme==='dark';
    const contact=vehicle.children[1];
    if(contact.userData.theme!==theme){
      contact.userData.theme=theme;
      const {egoShadow,egoOpacity,egoWidth,egoLength}=indoorShadowPresets[theme];
      contact.children[0].scale.set(1.1*egoWidth,1.075*egoLength,1);
      const chassis=contact.children[1];
      for(const patch of contact.children){
        const {opacity,shadowStrength,coverage}=patch.material.uniforms;
        opacity.value=dark?patch.userData.baseOpacity:patch.userData.daylightOpacity;
        shadowStrength.value=egoShadow;
        coverage.value=egoOpacity*(patch===chassis ? .94 : 1);
      }
    }
    if (returning) {
      const {source:destination,weight}=returning;
      const blend=(a,b)=>a.map((value,i)=>THREE.MathUtils.lerp(value,b[i],weight));
      source={ground:source.ground,position:blend(source.position,destination.position),offset:blend(source.offset,destination.offset),
        anchor:blend(source.anchor,destination.anchor),fov:THREE.MathUtils.lerp(source.fov,destination.fov,weight),
        orientation:new THREE.Quaternion().fromArray(source.orientation)
          .slerp(new THREE.Quaternion().fromArray(destination.orientation),weight).toArray()};
    }
    draw(width,height,source,progress,animated);
    const {view}=camera;
    return {position:camera.position.toArray(),orientation:camera.quaternion.toArray(),fov:camera.fov,
      offset:[view.offsetX/view.fullWidth,view.offsetY/view.fullHeight]};
  }
  function exportFrame({format,width,height}) {
    if(format==='camera'){
      draw(width,height);
      const {near,far,fov,aspect}=camera;
      return Promise.resolve(new Blob([JSON.stringify({
        size:{width,height},camera:{projection:'perspective',near,far,fov,aspect,
          position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),
          matrixWorld:camera.matrixWorld.toArray(),projectionMatrix:camera.projectionMatrix.toArray()}
      },null,2)],{type:'application/json'}));
    }
    const scale=Math.min(2,Math.sqrt(16_000_000/(width*height)),renderer.capabilities.maxTextureSize/Math.max(width,height));
    draw(Math.ceil(width*scale),Math.ceil(height*scale));
    const image=document.createElement('canvas');
    image.width=width;image.height=height;
    const context=image.getContext('2d');
    context.imageSmoothingQuality='high';
    context.drawImage(renderer.domElement,0,0,width,height);
    return new Promise((resolve,reject)=>image.toBlob(
      blob=>blob?resolve(blob):reject(Error('Could not export the parked view.')),'image/png'
    ));
  }
  return {canvas:renderer.domElement,prepareVehicle,render,exportFrame};
}
