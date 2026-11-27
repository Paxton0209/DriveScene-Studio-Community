import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {patchPreparedVehicleDownload,patchX6VehicleDownload} from './runtime-patches.mjs';

await build({
  absWorkingDir:fileURLToPath(new URL('.',import.meta.url)),
  entryPoints:['parked-view.js'],outfile:'parked-view.bundle.js',
  bundle:true,minify:true,format:'esm',target:['chrome110','safari17'],
  plugins:[{name:'parked-view-engine-assets',setup(builder){
    builder.onLoad({filter:/\/engine\/.*\.js$/},async args=>{
      const name=args.path.split('/engine/').at(-1);
      let source=await readFile(args.path,'utf8');
      if(name==='vehicle.js')source=patchX6VehicleDownload(source);
      if(name==='vehicle-library/three/load-prepared.js')source=patchPreparedVehicleDownload(source);
      return {contents:source.replaceAll('import.meta.url',`new URL('../engine/${name}',import.meta.url).href`),
        loader:'js',resolveDir:args.path.slice(0,args.path.lastIndexOf('/'))};
    });
  }}]
});
