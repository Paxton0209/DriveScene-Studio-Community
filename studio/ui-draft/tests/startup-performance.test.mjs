import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {webcrypto} from 'node:crypto';
import {fetchStartupAsset} from '../startup-transfer.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

test('Pro shell inlines all CSS without @import waterfalls and preloads critical assets', async () => {
  const [html, proEngine, bundle] = await Promise.all([
    readFile(new URL('../pro-prototype.html', import.meta.url), 'utf8'),
    readFile(new URL('../pro-engine.html', import.meta.url)),
    readFile(new URL('../pro-prototype/prototype.bundle.js', import.meta.url)),
  ]);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/);
  assert.doesNotMatch(html, /@import\s+url\(/);
  assert.match(html, /data-prototype-css="draft\.css"/);
  assert.match(html, /data-prototype-css="shell-v5\.css"/);
  assert.match(html, /<link data-prototype-font rel="preload"[^>]+Halden-Regular\.woff2/);
  assert.match(html, /<link data-prototype-font rel="preload"[^>]+Halden-Medium\.woff2/);
  assert.match(html, /<link data-prototype-icon rel="preload"[^>]+assist-wheel-off\.svg/);
  assert.ok(html.includes(`href="pro-prototype/prototype.bundle.js?v=${hash(bundle)}"`));
  assert.equal(html.match(/name="pro-engine-revision" content="([^"]+)"/)?.[1], hash(proEngine));
  assert.match(html, /<script id="prototype-early-engine">/);
  assert.match(html, /<script id="prototype-sw">/);
});

test('Minimal pro-engine.html strips standalone UI styles and stays lightweight', async () => {
  const [proEngine, fullEngine] = await Promise.all([
    readFile(new URL('../pro-engine.html', import.meta.url), 'utf8'),
    readFile(new URL('../engine.html', import.meta.url), 'utf8'),
  ]);
  assert.ok(Buffer.byteLength(proEngine) < 28000, 'pro-engine.html should remain lightweight');
  assert.ok(gzipSync(proEngine).byteLength < 8500);
  assert.ok(Buffer.byteLength(proEngine) < Buffer.byteLength(fullEngine) / 3);
  assert.match(proEngine, /runtime\.bundle\.js\?v=[a-f0-9]+/);
  assert.match(proEngine, /globalThis\.__draftSearch/);
});

test('Runtime splits export and driving-events into lazy chunks sharing host THREE', async () => {
  const [runtime, exportBundle, eventsBundle] = await Promise.all([
    readFile(new URL('../runtime.bundle.js', import.meta.url), 'utf8'),
    readFile(new URL('../export.bundle.js', import.meta.url), 'utf8'),
    readFile(new URL('../driving-events.bundle.js', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /\.\/export\.bundle\.js\?v=[a-f0-9]+/);
  assert.match(runtime, /\.\/driving-events\.bundle\.js\?v=[a-f0-9]+/);
  assert.ok(Buffer.byteLength(exportBundle) < 25000, 'export.bundle.js must not duplicate THREE');
  assert.ok(Buffer.byteLength(eventsBundle) < 80000, 'driving-events.bundle.js must not duplicate THREE');
});

test('Production hosts race integrity-checked mirrors when primary trickles slowly', async () => {
  const payload = new Uint8Array([9, 8, 7]).buffer;
  const sha256 = createHash('sha256').update(Buffer.from(payload)).digest('hex');
  const mirror = {url: 'https://cdn.jsdelivr.net/test.glb.gz', sha256};
  for (const hostname of ['drivescenestudio.com', 'www.drivescenestudio.com', 'drivescene-studio.peixinyao0209.chatgpt.site']) {
    let primaryAborted = false;
    const scope = {
      location: {hostname},
      crypto: webcrypto,
      fetch: async (url, {signal}) => {
        if (url === mirror.url) return new Response(payload);
        // Simulate a slow trickling primary stream that emits 1 byte every 20ms
        const body = new ReadableStream({
          async start(controller) {
            signal?.addEventListener('abort', () => { primaryAborted = true; try { controller.error(Error('aborted')); } catch {} });
            for (let i = 0; i < 20; i++) {
              if (signal?.aborted) return;
              controller.enqueue(new Uint8Array([1]));
              await new Promise(r => setTimeout(r, 20));
            }
            controller.close();
          }
        });
        return new Response(body);
      }
    };
    const result = await fetchStartupAsset('https://primary.test/model.glb.gz', {mirror, scope, delay: 40, slowDelay: 60});
    assert.deepEqual(new Uint8Array(result), new Uint8Array(payload));
    assert.equal(primaryAborted, true);
  }
});

test('Service worker is packaged at site root for immutable caching', async () => {
  const [sw, packager] = await Promise.all([
    readFile(new URL('../../../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/package-static.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(sw, /drivescene-immutable-v1/);
  assert.match(packager, /'sw\.js'/);
});

test('Model 3 startup LOD preserves all meshes, exterior body and bounds while cutting startup payload >2.1x', async () => {
  const {gunzipSync} = await import('node:zlib');
  const {NodeIO} = await import('@gltf-transform/core');
  const {ALL_EXTENSIONS} = await import('@gltf-transform/extensions');
  const {MeshoptDecoder} = await import('meshoptimizer');
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder});
  const [fullGz, lodGz] = await Promise.all([
    readFile(new URL('../vehicles/model-3/model.glb.gz', import.meta.url)),
    readFile(new URL('../vehicles/model-3/startup.glb.gz', import.meta.url)),
  ]);
  assert.ok(lodGz.length < 750_000, `Expected startup LOD < 750KB, got ${lodGz.length}`);
  assert.ok(fullGz.length / lodGz.length > 2.1, 'Expected >2.1x size reduction');
  const [fullDoc, lodDoc] = await Promise.all([io.readBinary(gunzipSync(fullGz)), io.readBinary(gunzipSync(lodGz))]);
  const fullNames = new Set(fullDoc.getRoot().listNodes().filter(n => n.getMesh()).map(n => n.getName()));
  const lodNames = new Set(lodDoc.getRoot().listNodes().filter(n => n.getMesh()).map(n => n.getName()));
  for (const name of fullNames) assert.ok(lodNames.has(name), `Missing mesh node ${name}`);
  const bounds = doc => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION'), pt = [];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, pt);
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pt[a]); max[a] = Math.max(max[a], pt[a]); }
      }
    }
    return {min, max};
  };
  const a = bounds(fullDoc), b = bounds(lodDoc), extent = Math.max(...a.max.map((v, i) => v - a.min[i]));
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(a.min[axis] - b.min[axis]) < extent * 0.005);
    assert.ok(Math.abs(a.max[axis] - b.max[axis]) < extent * 0.005);
  }
});

test('Pro startup preloads Model 3 startup LOD and runtime wires full-res background upgrade', async () => {
  const {startStartupAssets} = await import('../startup-bundles.mjs');
  const calls = [];
  const scope = {
    location: {search: ''},
    history: {},
    document: {documentElement: {dataset: {}}, baseURI: 'https://example.test/studio/ui-draft/'},
    fetch: async url => { calls.push(url); return new Response(new Uint8Array([1])); },
  };
  const requests = startStartupAssets(scope, null, {}, true);
  await Promise.all(requests.values());
  assert.ok(calls.some(url => url.includes('/vehicles/model-3/startup.glb.gz?v=lod-20261126')));
  assert.equal(scope.__draftStartupLod?.id, 'model-3');
  const runtime = await readFile(new URL('../runtime.bundle.js', import.meta.url), 'utf8');
  assert.match(runtime, /ensureFullVehicle/);
  assert.match(runtime, /scheduleFullVehicleUpgrade/);
});
