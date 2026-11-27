// Race a stalled or slow public asset against an immutable, integrity-checked mirror.
// Only pinned, integrity-checked build inputs may use another origin. X6's
// original PNG model is also valid when its primary uses lossless WebP pixels.
export async function fetchStartupAsset(url,{mirror,scope=globalThis,delay=600,slowDelay=1500}={}){
 const read=async(target,signal,progress)=>{
  const response=await scope.fetch(target,{priority:'high',signal});
  if(!response.ok)throw Error(response.status);
  if(!progress||!response.body)return response.arrayBuffer();
  progress();
  return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,controller){
   if(chunk.byteLength)progress();controller.enqueue(chunk);
  }}))).arrayBuffer();
 };
 if(!mirror||!/^(?:paxton0209\.github\.io|(?:.+\.)?(?:drivescenestudio\.com|chatgpt\.site))$/.test(scope.location?.hostname||''))return read(url);
 const primary=new AbortController(),backup=new AbortController();let timer,slow,startBackup,started=false;
 const progress=()=>{if(!started){clearTimeout(timer);timer=setTimeout(startBackup,delay);}};
 const fallback=new Promise((resolve,reject)=>{startBackup=()=>{
  if(started)return;started=true;clearTimeout(timer);clearTimeout(slow);
  const readMirror=(scope.__draftStartupMirrorQueue??Promise.resolve()).then(()=>{backup.signal.throwIfAborted();return read(mirror.url,backup.signal);});
  scope.__draftStartupMirrorQueue=readMirror.then(()=>{},()=>{});
  readMirror.then(async bytes=>{
   const digest=await scope.crypto.subtle.digest('SHA-256',bytes);
   if(Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')!==mirror.sha256)throw Error();
   return bytes;
  }).then(resolve,reject);
 };});
 progress();
 if(slowDelay>delay)slow=setTimeout(startBackup,slowDelay);
 try{return await Promise.any([read(url,primary.signal,progress).catch(error=>{startBackup();throw error}),fallback])}
 catch(cause){throw new Error('Scene files could not load. Please try again.',{cause})}
 finally{clearTimeout(timer);clearTimeout(slow);primary.abort();backup.abort()}
}

// This generated data module is self-contained: no relative imports or code from users.
export async function loadParkingNormalModule(url){
 const scope=window.parent,mirror=scope.__draftStartupMirrors?.['./parking-normals.bundle.js'];
 const bytes=await fetchStartupAsset(url,{scope,mirror,delay:150});
 const local=URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}));
 try{return await import(local)}finally{URL.revokeObjectURL(local)}
}
