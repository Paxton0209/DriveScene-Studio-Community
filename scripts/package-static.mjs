import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

// Package only the delivered application and its runtime dependencies.
const destination=resolve(process.argv[2]??'_site');
const root=resolve(import.meta.dirname,'..');
if(destination===root||root.startsWith(destination+'/'))throw Error('Destination must not contain the repository');
const files=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
const rootFiles=new Set(['index.html','sw.js','favicon.svg','favicon.ico','favicon-32.png','favicon-64.png','apple-touch-icon.png','LICENSE','ASSET-LICENSE.md','CREDITS.md','THREE-LICENSE.txt','MESHOPT-LICENSE.txt']);
const included=files.filter(file=>rootFiles.has(file)||(
 /^(studio\/ui-draft\/|studio\/engine\/)/.test(file)&&
 !/(^|\/)(tests|node_modules|scripts|sources|startup-test|test-results)(\/|$)/.test(file)&&
 !/(^|\/)(AGENTS\.md|package(-lock)?\.json)$/.test(file)&&
 !/\.(test\.mjs|py|map)$/.test(file)
));
const workbench='studio/ui-draft/';
const defaultEntry=`${workbench}index.html`;
const interactionEntry=`${workbench}pro-prototype.html`;
const basicEntry=`${workbench}basic.html`;
const workbenchHtml=await readFile(resolve(root,interactionEntry),'utf8');
if(!workbenchHtml.includes('<head>'))throw Error('Missing workbench document head');
const withHead=extra=>workbenchHtml.replace('<head>',`<head>
<link rel="canonical" href="https://www.drivescenestudio.com/">
${extra}`);
// Resolve existing asset URLs before the browser starts preloading the workbench.
const homepage=withHead(`<base href="${workbench}">`);
// Serve the same page at old links and update the URL without a second navigation.
const legacyPage=withHead(`<base href="./">
<script>
{
  const destination = new URL(location.href);
  destination.pathname = destination.pathname.replace(/\\/studio\\/ui-draft(?:\\/.*)?$/, '/');
  document.querySelector('base').href = new URL('${workbench}', destination).href;
  history.replaceState(history.state, '', destination);
}
</script>`);
const publishedPages=new Map([
 ['index.html',homepage],
 [defaultEntry,legacyPage],
 [interactionEntry,legacyPage],
]);
const entries=new Map(included.map(file=>[file,file]));
entries.set(basicEntry,defaultEntry);
await rm(destination,{recursive:true,force:true});
let bytes=0;
for(const [file,sourceFile] of entries){
 const source=resolve(root,sourceFile);
 const target=resolve(destination,file);
 const info=await stat(source);
 if(!info.isFile())continue;
 await mkdir(dirname(target),{recursive:true});
 const page=publishedPages.get(file);
 if(page!==undefined){
  await writeFile(target,page);
  bytes+=Buffer.byteLength(page);
 }else{
  await copyFile(source,target);
  bytes+=info.size;
 }
}
await writeFile(resolve(destination,'.nojekyll'),'');
// Edge caching rules for Cloudflare Pages / Netlify static hosting:
// HTML, SW and release metadata revalidate immediately while versioned/binary
// assets cache aggressively at the edge and in the browser.
const edgeHeaders=`/*
  X-Content-Type-Options: nosniff

/
  Cache-Control: public, max-age=0, must-revalidate

/*.html
  Cache-Control: public, max-age=0, must-revalidate

/studio/ui-draft/*.html
  Cache-Control: public, max-age=0, must-revalidate

/sw.js
  Cache-Control: public, max-age=0, must-revalidate

/release.json
  Cache-Control: public, max-age=0, must-revalidate

/studio/ui-draft/vehicles/*
  Cache-Control: public, max-age=31536000, immutable

/studio/engine/assets/*
  Cache-Control: public, max-age=31536000, immutable

/studio/ui-draft/guizang-trial/*
  Cache-Control: public, max-age=31536000, immutable

/studio/ui-draft/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/studio/ui-draft/sounds/*
  Cache-Control: public, max-age=31536000, immutable

/studio/ui-draft/startup-previews/*
  Cache-Control: public, max-age=31536000, immutable

/studio/ui-draft/*.bin.gz
  Cache-Control: public, max-age=31536000, immutable

/studio/ui-draft/*.bundle.js
  Cache-Control: public, max-age=300, stale-while-revalidate=86400

/studio/ui-draft/pro-prototype/*.bundle.js
  Cache-Control: public, max-age=300, stale-while-revalidate=86400
`;
await writeFile(resolve(destination,'_headers'),edgeHeaders);
await writeFile(resolve(destination,'release.json'),JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim()},null,2)+'\n');
console.log(JSON.stringify({destination,files:entries.size,bytes}));
