import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {weld,meshopt,prune,dedup,textureCompress} from '@gltf-transform/functions';
import sharp from 'sharp';
import {MeshoptDecoder,MeshoptEncoder,MeshoptSimplifier} from 'meshoptimizer';
import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';

const WHEEL_MESHES = new Set(['Object_11', 'Object_12', 'Object_13', 'Object_17']);
const INTERIOR_TRIM_MESHES = new Set(['Object_4', 'Object_16']);

function compactPrimitive(prim) {
  const indices = prim.getIndices();
  if (!indices) return;
  const idxArr = indices.getArray();
  const pos = prim.getAttribute('POSITION');
  const count = pos.getCount();
  const remap = new Int32Array(count).fill(-1);
  let next = 0;
  const newIdx = new Uint32Array(idxArr.length);
  for (let i = 0; i < idxArr.length; i++) {
    const v = idxArr[i];
    let nv = remap[v];
    if (nv === -1) { nv = next++; remap[v] = nv; }
    newIdx[i] = nv;
  }
  if (next === count) return;
  indices.setArray(next < 65536 ? new Uint16Array(newIdx) : newIdx);
  for (const sem of prim.listSemantics()) {
    const attr = prim.getAttribute(sem);
    const oldArr = attr.getArray();
    const elemSize = attr.getElementSize();
    const newArr = new oldArr.constructor(next * elemSize);
    for (let v = 0; v < count; v++) {
      const nv = remap[v];
      if (nv !== -1) {
        for (let k = 0; k < elemSize; k++) newArr[nv * elemSize + k] = oldArr[v * elemSize + k];
      }
    }
    attr.setArray(newArr);
  }
}

// Generate a lightweight startup LOD for Model 3 that preserves all 18 mesh
// names, materials, normals, and exterior body/glass geometry 100% untouched
// while simplifying only the 129k-triangle wheel/tire meshes. Full model.glb.gz
// remains untouched and upgrades seamlessly in the background after first frame.
export async function prepareModel3StartupLod({
  sourceURL = new URL('../engine/vehicle-library/prepared/model-3/model.glb.gz', import.meta.url),
  outputURL = new URL('./vehicles/model-3/startup.glb.gz', import.meta.url),
} = {}) {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder});
  const source = await readFile(sourceURL);
  const doc = await io.readBinary(gunzipSync(source));
  await doc.transform(weld());
  for (const mesh of doc.getRoot().listMeshes()) {
    const isWheel = WHEEL_MESHES.has(mesh.getName());
    const isTrim = INTERIOR_TRIM_MESHES.has(mesh.getName());
    if (!isWheel && !isTrim) continue;
    const ratio = isWheel ? 0.025 : 0.15;
    const error = isWheel ? 0.05 : 0.005;
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      if (!indices || !pos) continue;
      const idxArr = new Uint32Array(indices.getArray());
      const posArr = new Float32Array(pos.getArray());
      const target = Math.max(24, Math.floor((idxArr.length / 3) * ratio) * 3);
      const [dst] = MeshoptSimplifier.simplify(idxArr, posArr, 3, target, error);
      if (dst.length >= 3 && dst.length < idxArr.length) {
        indices.setArray(dst.length < 65536 ? new Uint16Array(dst) : dst);
        compactPrimitive(prim);
      }
    }
  }
  await doc.transform(
    textureCompress({encoder: sharp, targetFormat: 'webp', resize: [256, 256], quality: 78}),
    dedup(),
    prune(),
    meshopt({encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 14, quantizeColor: 12}),
  );
  const bytes = gzipSync(await io.writeBinary(doc), {level: 9, mtime: 0});
  await writeFile(outputURL, bytes);
  return {sourceBytes: source.length, startupBytes: bytes.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await prepareModel3StartupLod()));
}
