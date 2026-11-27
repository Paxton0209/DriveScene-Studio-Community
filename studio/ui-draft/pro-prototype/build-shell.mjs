import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build,transform} from 'esbuild';
import {startupAssetScript} from '../startup-bundles.mjs';

// The prototype keeps its iframe alive across scene changes. Version its HTML
// as well as the bundle so a returning browser cannot retain the old runtime.
const uiDirectory=new URL('../',import.meta.url);
const prototypeFile=new URL('pro-prototype.html',uiDirectory);
const revision=source=>createHash('sha256').update(source).digest('hex').slice(0,12);

const cssNames=['draft.css','inspector.css','guizang-trial.css','shell-v5.css','pro-prototype/prototype.css'];
const [engineHtml,proEngineHtml,runtime,template,tokensCss,prototypeAssets,prototypeScript,...rawStyles]=await Promise.all([
 readFile(new URL('engine.html',uiDirectory)),
 readFile(new URL('pro-engine.html',uiDirectory)),
 readFile(new URL('runtime.bundle.js',uiDirectory)),
 readFile(prototypeFile,'utf8'),
 readFile(new URL('design-system/tokens.css',uiDirectory),'utf8'),
 startupAssetScript(true),
 build({absWorkingDir:fileURLToPath(uiDirectory),entryPoints:['./pro-prototype/prototype.js'],bundle:true,minify:true,format:'esm',write:false,target:['chrome110','safari17'],loader:{'.svg':'text'}}),
 ...cssNames.map(name=>readFile(new URL(name,uiDirectory),'utf8'))
]);

const engineRevision=revision(engineHtml);
const proEngineRevision=revision(proEngineHtml);
const runtimeVersion=revision(runtime);
const prototypeEntry=prototypeScript.outputFiles[0].text;
const prototypeVersion=revision(prototypeEntry);
const prototypeCssVersion=revision(Buffer.from(rawStyles[rawStyles.length-1]));

// Inline and minify all five shell stylesheets (expanding tokens.css @import)
// so first paint and module execution never wait on a multi-hop CSS waterfall.
const inlineStyles=await Promise.all(cssNames.map(async(name,index)=>{
 const source=name==='draft.css'
  ? rawStyles[index].replace('@import url("./design-system/tokens.css");',tokensCss)
  : rawStyles[index];
 const {code:css}=await transform(source,{loader:'css',minifyWhitespace:true});
 const attr=name==='pro-prototype/prototype.css'?`${name}?v=${prototypeCssVersion}`:name;
 return `<style data-prototype-css="${attr}">/* ds-allow: Generated CSS is checked in the owning stylesheet. */${css}</style>`;
}));

// Register the immutable-asset Service Worker on HTTPS production hosts (or
// locally with ?sw=1 for verification) to bypass origin max-age=0 304 stalls.
const swScript=(await transform(`(() => {
 const sw = navigator.serviceWorker;
 if (!sw) return;
 if (location.protocol !== 'https:' && !new URLSearchParams(location.search).has('sw')) return;
 const url = new URL('../../sw.js', document.baseURI);
 sw.register(url.href, {scope: new URL('./', url).pathname}).catch(() => {});
})();`,{loader:'js',minify:true,target:'es2021'})).code.trim();

// Start loading pro-engine.html in parallel with prototype.bundle.js and GLB
// assets during HTML parse instead of waiting for script evaluation.
const earlyMountScript=(await transform(`((engineRev) => {
 const clip = document.querySelector('.artboard-clip');
 if (!clip) return;
 const entry = new URL(location.href), sp = entry.searchParams;
 const initialEvent = sp.get('interaction'), initialScene = sp.get('scene');
 const oldScene = initialEvent === 'roadworks' ? 'elevated'
  : initialEvent === 'junction-left-turn' ? 'junction'
  : (initialEvent === 'parking-yield' || initialEvent === 'parking-taken') ? 'parking' : 'road';
 const metaMap = {
  road: {label: 'Road', layout: '02', seed: 110},
  elevated: {label: 'Elevated', layout: '03', seed: 111},
  ramp: {label: 'Ramp', layout: '06', seed: 112},
  junction: {label: 'Junction', layout: '05', seed: 113},
  parking: {label: 'Indoor parking', layout: '10', seed: 114},
  outdoor: {label: 'Outdoor parking', layout: '17', seed: 115},
 };
 const scene = Object.hasOwn(metaMap, initialScene) ? initialScene : oldScene;
 const meta = metaMap[scene];
 const layout = scene === 'ramp' && sp.get('type') === 'merge' ? '07' : meta.layout;
 const parking = scene === 'parking' || scene === 'outdoor';
 const exterior = scene === 'road' || scene === 'elevated' || scene === 'junction' || scene === 'outdoor';
 const parked = parking && !initialEvent && sp.get('view') === 'parked';
 const savedModel = parked ? history.state?.parkedPreview?.model : null;
 const model = ['model-3', 'x6', 'ix', 'xc90'].includes(savedModel) ? savedModel : 'model-3';
 const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
 const camera = parking ? 'default' : 'low';
 const traffic = scene === 'parking';
 const board = {
  id: 'artboard-' + scene, type: scene, title: meta.label, size: {width: 1920, height: 1080}, seed: meta.seed,
  params: {
   layout, lanes: '6', weather: 'default', model, path: false, traffic,
   buildings: exterior, trees: exterior, waterfront: false, roadworks: false,
   ...(parking ? {cameraRiseStart: 0.4, cameraRiseDuration: 1} : {}), camera
  }
 };
 window.__draftStartupProject = {active: scene, boards: {[scene]: board}};
 const query = new URLSearchParams({
  'neutral-parking': '20261118-parking-handoff',
  'scene-preview': '1', 'traffic-palette': 'amber-red-20261112', 'traffic-feedback': 'cut-in-divider-20261112',
  'camera-motion': 'roadworks-context-tail15-20261112', 'parking-interactions': '20261113-parking-arrival-camera',
  'sky-gradient': '20261112', 'adaptive-roadworks-traffic': '1', review: 'ui-draft', quality: 'sr50', paused: '1',
  scene: layout, mode: theme, lanes: '6', view: camera, model, weather: 'default', seed: String(meta.seed),
  vehicle: '1', path: '0', roadworks: '0',
  traffic: String(Number(traffic)), buildings: String(Number(exterior)), trees: String(Number(exterior)), waterfront: '0',
  'engine-v': engineRev
 });
 const cover = document.createElement('canvas');
 cover.id = 'frame-cover';
 cover.hidden = true;
 cover.setAttribute('aria-hidden', 'true');
 const frame = document.createElement('iframe');
 frame.title = '3D scene preview';
 frame.className = 'pro-scene-preview';
 frame.tabIndex = -1;
 frame.dataset.earlyMount = '1';
 frame.src = new URL('./pro-engine.html?' + query, document.baseURI).href;
 clip.prepend(frame, cover);
 document.currentScript?.remove();
})(${JSON.stringify(proEngineRevision)});`,{loader:'js',minify:true,target:'es2021'})).code.trim();

const preloads=[
 `<link data-prototype-font rel="preload" href="./fonts/halden/Halden-Regular.woff2" as="font" type="font/woff2" crossorigin>`,
 `<link data-prototype-font rel="preload" href="./fonts/halden/Halden-Medium.woff2" as="font" type="font/woff2" crossorigin>`,
 `<link data-prototype-icon rel="preload" href="./assist-wheel-off.svg" as="image">`,
 `<link data-prototype-script rel="modulepreload" fetchpriority="high" href="pro-prototype/prototype.bundle.js?v=${prototypeVersion}">`,
 `<script id="prototype-startup-assets">${prototypeAssets.trim()}</script>`,
 `<script id="prototype-sw">${swScript}</script>`,
].join('\n');

let prototypeHtml=template
 .replace(/(<meta name="scene-engine-revision" content=")[^"]+/,(_,prefix)=>prefix+engineRevision)
 .replace(/<meta name="pro-engine-revision" content="[^"]*">\n?/g,'')
 .replace(/(<meta name="scene-engine-revision" content="[^"]+">)/,`$1\n<meta name="pro-engine-revision" content="${proEngineRevision}">`)
 .replace(/<link data-prototype-(?:font|icon|script|runtime)[^>]*>\n?|<script id="prototype-(?:startup-assets|sw)">[\s\S]*?<\/script>\n?/g,'')
 .replace('<title>',()=>preloads+'\n<title>')
 .replace(/<link rel="stylesheet" href="(?:draft|inspector|guizang-trial|shell-v5)\.css">\s*/g,'')
 .replace(/<link rel="stylesheet" href="pro-prototype\/prototype\.css(?:\?v=[^"]+)?">\s*/g,'')
 .replace(/<style data-prototype-css="[^"]+">[\s\S]*?<\/style>\s*/g,'')
 .replace('</head>',()=>inlineStyles.join('')+'\n</head>')
 .replace(/<script id="prototype-early-engine">[\s\S]*?<\/script>/g,'')
 .replace('<div class="artboard-clip">',()=>`<div class="artboard-clip"><script id="prototype-early-engine">${earlyMountScript}</script>`)
 .replace(/pro-prototype\/prototype(?:\.bundle)?\.js\?v=[^"]+/g,'pro-prototype/prototype.bundle.js?v='+prototypeVersion);

await writeFile(new URL('prototype.bundle.js',import.meta.url),prototypeEntry);
await writeFile(prototypeFile,prototypeHtml);
