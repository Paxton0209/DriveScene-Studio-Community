import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,12);
test('Returning prototype tabs invalidate cached engine HTML and edited controls after a build',async()=>{
 const html=await readFile(new URL('../pro-prototype.html',import.meta.url),'utf8');
 const engine=await readFile(new URL('../engine.html',import.meta.url));
 assert.equal(html.match(/name="scene-engine-revision" content="([^"]+)"/)[1],hash(engine));
 for(const name of ['prototype.bundle.js','prototype.css']){
  const bytes=await readFile(new URL('../pro-prototype/'+name,import.meta.url));
  assert.ok(html.includes('pro-prototype/'+name+'?v='+hash(bytes)),name+' must invalidate its old browser cache');
 }
});
