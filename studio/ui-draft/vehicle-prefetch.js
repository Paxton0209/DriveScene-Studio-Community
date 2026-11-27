import {fetchAsset,takePrefetched} from '../engine/asset-request.js';

// Parked and the live viewport have separate renderers. Share the four
// compressed assets for this page, while each renderer owns its decoded model.
export function fetchVehicleAsset(url, early, host=window.parent){
 const assets=host.__draftVehicleAssets;
 const key=new URL(url,host.document.baseURI).href;
 if(assets?.has(key)){const cached=assets.get(key);return typeof cached?.then==='function'?cached:Promise.resolve(cached);}
 const startup=host.__draftStartupAssets;
 early??=startup?.get(key);
 startup?.delete(key);
 const request=takePrefetched('early',()=>fetchAsset(key,assets?{timeoutMs:12000}:undefined),{early});
 if(!assets)return request;
 // Store parent-realm Promise and replace with the resolved ArrayBuffer so
 // navigating an iframe cannot strand a subsequent iframe on a dead-realm Promise.
 const shared=host.Promise&&host.Promise!==Promise?host.Promise.resolve(request):request;
 assets.set(key,shared);
 void shared.then(buf=>{if(assets.get(key)===shared)assets.set(key,buf);},()=>{if(assets.get(key)===shared)assets.delete(key);});
 return shared;
}

// Transfer compressed files only. Decode and GPU preparation happen separately.
export async function prefetchVehicleFiles(models,{needsModel,host=window.parent,download=fetchAsset}){
 const requests=host.__draftStartupAssets,connection=host.navigator.connection;
 if(!requests||connection?.saveData||['slow-2g','2g'].includes(connection?.effectiveType))return;
 for(const id of models){
  if(host.document.hidden)return;
  if(!needsModel(id))continue;
  const version=id==='x6'?'x6-lossless-20261104':'restore26';
  const preload=path=>{
   const url=new URL(`./vehicles/${id}/${path}`,host.document.baseURI).href;
   if(host.__draftVehicleAssets?.has(url))return host.__draftVehicleAssets.get(url);
   if(requests.has(url))return requests.get(url);
   const request=download(url,{priority:'low',timeoutMs:10000}).catch(error=>{
    if(requests.get(url)===request)requests.delete(url);
    throw error;
   });
   requests.set(url,request);
   return request;
  };
  await Promise.allSettled([preload(`model.glb.gz?v=${version}`),preload('framing-hull.json?v=cold-20261102')]);
 }
}
