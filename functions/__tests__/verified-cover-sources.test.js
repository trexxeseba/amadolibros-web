import test from 'node:test';
import assert from 'node:assert/strict';
import { VERIFIED_COVER_SOURCES, verifiedCoverSource } from '../_shared/verified-cover-sources.js';
import { coverSources } from '../book-cover/[[path]].js';
import { merchantImageSources, additionalMerchantImageLinks } from '../feed.xml.js';
import { coverCandidates, selectCoverBatch, syncCoverMirror, COVER_MANIFEST_KEY } from '../../worker-sync/cover-mirror.js';
import { findPreviewCover } from '../_shared/preview-cover.js';

function item(row) {
  return { id: row.product_id, status: 'active', available_quantity: 1, price: 1000,
    currency: 'UYU', domain_id: 'MLU-BOOKS', pictures: [row.source_url, row.replacement_url] };
}
function png(width, height) {
  const b = new Uint8Array(45); b.set([137,80,78,71,13,10,26,10]);
  b.set([0,0,0,13,73,72,68,82],8);
  new DataView(b.buffer).setUint32(16,width); new DataView(b.buffer).setUint32(20,height);
  b.set([73,69,78,68],37); return b;
}
class R2 {
  data = new Map(); version = 0;
  async get(key) {
    const b = this.data.get(key);
    return b ? { body: b, etag: String(this.version), text: async () => new TextDecoder().decode(b) } : null;
  }
  async head(key) { return this.data.has(key) ? { size: this.data.get(key).length } : null; }
  async put(key, bytes) { this.data.set(key, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes); this.version++; return {etag: String(this.version)}; }
}

for (const row of VERIFIED_COVER_SOURCES) {
  test(`fuente única, posiciones estables y copia R2 nativa: ${row.product_id} ${row.source_url}`, async () => {
    const book = item(row);
    assert.deepEqual(coverSources(book), [row.replacement_url, row.replacement_url]);
    assert.deepEqual(merchantImageSources(book), coverSources(book));
    assert.deepEqual(coverCandidates(book).map(x => x.source_url), coverSources(book));
    const selected = selectCoverBatch({items:[book]}, null, {aiUpscaleEnabled:true}).selected;
    assert.ok(selected.every(x => !x.aiUpscaleEligible));
    const r2 = new R2();
    const result = await syncCoverMirror({COVER_R2:r2, IMAGES:{input(){throw new Error('No debe generar IA');}}}, {items:[book]}, {
      fetchFn: async url => {
        assert.equal(url, row.replacement_url);
        return new Response(png(row.width,row.height), {headers:{'content-type':'image/png'}});
      },
    });
    assert.equal(result.failed,0);
    assert.equal(result.quality_pending,0);
    const manifest = JSON.parse(await (await r2.get(COVER_MANIFEST_KEY)).text());
    const current = manifest.entries[`${row.product_id}:0`].current;
    assert.equal(current.width,row.width); assert.equal(current.height,row.height);
    assert.equal(current.transform,null);
    assert.equal(current.object_key,current.original_object_key);
    assert.deepEqual(additionalMerchantImageLinks(book,manifest),[]); // Same bytes do not become duplicate additional images.
    const ctx = {env:{APP_ENV:'preview',COVER_R2:r2},request:new Request('https://preview.example/'),data:{}};
    assert.ok(await findPreviewCover(ctx,row.product_id,0,row.source_url));
    assert.equal(await findPreviewCover(ctx,row.product_id,0,'https://http2.mlstatic.com/CHANGED-O.jpg'),null);
    // A later source regression must retain the already published R2 master.
    const rejected = await syncCoverMirror({COVER_R2:r2}, {items:[book]}, {
      now: () => new Date('2030-01-01'),
      fetchFn: async () => new Response(png(300,400),{headers:{'content-type':'image/png'}}),
    });
    assert.equal(rejected.failed,2);
    const after = JSON.parse(await (await r2.get(COVER_MANIFEST_KEY)).text());
    assert.deepEqual(after.entries[`${row.product_id}:0`].current,current);
  });
}

test('no modifica otros productos, otras fotos ni reordena la galería', () => {
  const row=VERIFIED_COVER_SOURCES[0];
  assert.equal(verifiedCoverSource('MLU999999',row.source_url),row.source_url);
  assert.equal(verifiedCoverSource(row.product_id,'https://http2.mlstatic.com/NEW-O.jpg'),'https://http2.mlstatic.com/NEW-O.jpg');
  const book=item(row); book.pictures.unshift('https://http2.mlstatic.com/NEW-O.jpg');
  assert.equal(coverSources(book)[0],book.pictures[0]);
  assert.equal(coverSources(book)[1],row.replacement_url);
});
