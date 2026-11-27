// Recreate a lost renderer, including its GPU-only reflection and preparation caches.
// A short retry window prevents a broken GPU from trapping the page in a reload loop.
export function installContextRecovery({host,frame,rebuild,onFailure=()=>{},beforeRebuild=()=>{}}){
 const storageKey='drivescene-context-recovery:'+host.location.pathname;
 let pending=false,timer;
 const resume=()=>{
  if(!pending||host.document.hidden)return;
  host.clearTimeout(timer);
  timer=host.setTimeout(()=>{
   if(host.document.hidden)return;
   host.document.removeEventListener('visibilitychange',resume);
   beforeRebuild();rebuild();pending=false;
  },100);
 };
 const recover=()=>{
  if(pending)return true;
  const now=Date.now();let attempts;
  try{attempts=JSON.parse(host.sessionStorage.getItem(storageKey)||'[]').filter(at=>now-at<60000);if(attempts.length>=2)return false;host.sessionStorage.setItem(storageKey,JSON.stringify([...attempts,now]));}catch{return false;}
  pending=true;host.document.addEventListener('visibilitychange',resume);resume();return true;
 };
 const message=event=>{
  if(event.source!==frame()?.contentWindow||event.origin!==host.location.origin)return;
  const lost=event.data?.type==='ui-draft-context-lost'||event.data?.type==='ui-draft-error'&&/3D view is interrupted/.test(event.data.message);
  if(lost&&!recover())onFailure();
 };
 host.addEventListener('message',message);
 return {get pending(){return pending;},recover,dispose(){host.clearTimeout(timer);host.removeEventListener('message',message);host.document.removeEventListener('visibilitychange',resume);}};
}
