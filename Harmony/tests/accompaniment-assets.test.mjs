import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../public/tonnetz/',import.meta.url);
test('bundled guitar and bass assets have exact source hashes, attribution and offline coverage', async()=>{
  const sw=await readFile(new URL('sw.js',root),'utf8');
  for(const kind of ['bass','guitar']) {
    const manifest=JSON.parse(await readFile(new URL(`media/${kind}/manifest.json`,root),'utf8'));
    assert.equal(manifest.samples.length,9);
    assert.match(manifest.sourceCommit,/^[a-f0-9]{40}$/);
    const notice=await readFile(new URL(`media/${kind}/NOTICE.txt`,root),'utf8');
    assert.match(notice,/Karoryfer/);assert.match(notice,/CC BY 3.0/);
    for(const sample of manifest.samples) {
      const bytes=await readFile(new URL(`media/${kind}/${sample.file}`,root));
      assert.equal(bytes.length,sample.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.sha256);
      assert.ok(sw.includes(`./media/${kind}/${sample.file}`));
    }
  }
});
