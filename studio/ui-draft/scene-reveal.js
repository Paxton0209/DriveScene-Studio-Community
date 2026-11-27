// Navigation acknowledges input immediately. Only the prepared canvas waits.
export async function revealScene({cover,commit,reduce=false,live=false,signal}){
 commit();
 if(signal?.aborted)return;
 // A still of a driving vehicle must not sit over an already moving scene.
 if(reduce||live){cover.hidden=true;return;}
 const fade=cover.animate([{opacity:1},{opacity:0}],{duration:450,easing:'cubic-bezier(.4,0,.2,1)'});
 const cancel=()=>fade.cancel();signal?.addEventListener('abort',cancel,{once:true});
 try{await fade.finished.catch(()=>{});}
 finally{signal?.removeEventListener('abort',cancel);if(!signal?.aborted)cover.hidden=true;}
}
