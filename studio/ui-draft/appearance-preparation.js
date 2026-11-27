import {preservePreparationScreen} from './preparation-screen.js';
import {appearanceSnapshot,createAppearanceBlend} from './theme-blend.js';

export function installAppearancePreparation(world,prepareRenderer){
 // Theme changes update car uniforms; both scene shader variants are drawn
 // during startup. Reuse each model's prepared appearance across themes.
 const preparedAppearances=new WeakMap(),appearanceKey=car=>car.uuid+':traffic-'+!!world.draftTrafficEnabled;
 const remember=car=>{let keys=preparedAppearances.get(world.root);if(!keys)preparedAppearances.set(world.root,keys=new Set());keys.add(appearanceKey(car));};
 const preparedDraw=world.renderPreparedFrame;
 world.renderPreparedFrame=function(...args){const result=preparedDraw.apply(this,args);remember(this.car);return result;};
 // All four models share the scene's lights and render passes. Record their
 // exact meshes together so each pass is traversed/compiled once per scene.
 world.draftPrepareAppearances=async(cars,{preserveScreen=false}={})=>{
  const pendingCars=cars.filter(car=>!preparedAppearances.get(world.root)?.has(appearanceKey(car)));
  if(!pendingCars.length)return;
  world.draftAppearancePreparations=(world.draftAppearancePreparations||0)+1;
  const restoreScreen=preserveScreen?preservePreparationScreen(world.renderer):()=>{};
  try{
   const initializing=world.initializingScene,suspended=world.suspended,staged=[];
   world.initializingScene=true;world.suspended=false;
   try{
    for(const car of pendingCars)if(car!==world.car){
     staged.push({car,parent:car.parent,position:car.position.clone(),rotation:car.rotation.clone(),visible:car.visible});
     car.position.copy(world.car.position);car.rotation.copy(world.car.rotation);car.visible=true;world.scene.add(car);
    }
    const pending=prepareRenderer(world);world.suspended=true;await pending;
   }finally{
    for(const {car,parent,position,rotation,visible}of staged){car.removeFromParent();parent?.add(car);car.position.copy(position);car.rotation.copy(rotation);car.visible=visible;}
    world.initializingScene=initializing;world.suspended=suspended;
   }
   world.renderPreparedFrame();
   for(const car of pendingCars)remember(car);
  }finally{restoreScreen()}
 };
 world.draftPrepareAppearance=options=>world.draftPrepareAppearances([world.car],options);
}

// Prepare the live palette's blend and endpoint before revealing the scene.
// A feature such as clearcoat can be active during the blend and zero at its end.
export function prepareSceneThemes(world){
 const mode=world.state?.mode;
 if(!mode)return;
 const from=appearanceSnapshot(world),blend=createAppearanceBlend(),suspended=world.suspended;
 const apply=next=>{world.setDraftTheme(next);world.draftThemeTone.value=next==='dark'?1:0;};
 try{
  world.suspended=false;
  apply(mode==='dark'?'light':'dark');
  blend.start(from,appearanceSnapshot(world),0);
  blend.sample(200);
  world.renderFrame();
  blend.finish();world.renderFrame();
 }finally{
  apply(mode);
  world.suspended=suspended;
 }
 if(!suspended)world.renderFrame();
}
