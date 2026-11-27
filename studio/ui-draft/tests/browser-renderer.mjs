// Hosted Linux runners have no GPU. Bound only their interactive preview raster;
// the export assertion still renders the independently selected 4K output.
export const browserOptions=()=>({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
export async function configureRenderer(context){
 if(process.env.CI!=='true')return;
 context.setDefaultTimeout(90000);
 const limit=Number(process.env.DRIVESCENE_TEST_PREVIEW_LIMIT??480);
 if(![320,480].includes(limit))throw new Error('Unsupported CI preview raster');
 await context.addInitScript(limit=>Object.defineProperty(window,'__draftPreviewLimit',{configurable:true,get:()=>limit,set:()=>{}}),limit);
}
