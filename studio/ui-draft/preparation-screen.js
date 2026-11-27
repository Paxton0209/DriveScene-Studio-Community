// Keep the current colour buffer while warming the exact screen shader variants.
// Redirecting to a render target changes Three's output-colour-space programs.
// Reflection, shadow and composer targets still prepare normally offscreen.
export function preservePreparationScreen(renderer){
 const clear=renderer.clear,draw=renderer.renderBufferDirect,color=renderer.state.buffers.color,gl=renderer.getContext();
 renderer.clear=function(color=true,depth=true,stencil=true){return clear.call(this,this.getRenderTarget()===null?false:color,depth,stencil)};
 renderer.renderBufferDirect=function(...args){
  if(this.getRenderTarget()!==null)return draw.apply(this,args);
  const mask=gl.getParameter(gl.COLOR_WRITEMASK)[0];
  color.setMask(false);color.setLocked(true);
  try{return draw.apply(this,args)}finally{color.setLocked(false);color.setMask(mask)}
 };
 return ()=>{renderer.clear=clear;renderer.renderBufferDirect=draw};
}
