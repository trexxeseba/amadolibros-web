import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  gzipCandidates,
  readJsonMaybeGzip,
  writeJsonGzip,
} from '../../scripts/seo/book-intelligence-cache-io.mjs';
import { isSourceCacheFresh, planBookSourceResearch } from '../../scripts/seo/book-intelligence-sources.mjs';

const ISBN = '9780062273208';

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'cache-io-'));
}

test('lo escrito comprimido se recupera idéntico', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'source-cache.json');
  const value = { schema_version: 1, entries: { [ISBN]: { bne: { records: [{ isbn: ISBN, pages: 320 }] } } } };
  const written = await writeJsonGzip(target, value);
  assert.match(written, /\.gz$/);
  const { data } = await readJsonMaybeGzip(target);
  assert.deepEqual(data, value);
  assert.deepEqual(JSON.parse(gunzipSync(readFileSync(written)).toString('utf8')), value);
});

// Un caché de una corrida anterior sigue sirviendo aunque esté en texto plano.
test('un caché viejo sin comprimir se sigue leyendo', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'source-cache.json');
  const value = { schema_version: 1, entries: {} };
  writeFileSync(target, JSON.stringify(value));
  const { data, path: leido } = await readJsonMaybeGzip(target);
  assert.deepEqual(data, value);
  assert.equal(leido, target);
});

test('se prefiere el comprimido cuando existen los dos', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'source-cache.json');
  writeFileSync(target, JSON.stringify({ entries: { viejo: true } }));
  await writeJsonGzip(target, { entries: { nuevo: true } });
  const { data } = await readJsonMaybeGzip(target);
  assert.deepEqual(data.entries, { nuevo: true });
  assert.deepEqual(gzipCandidates(target), [`${target}.gz`, target]);
});

test('un archivo inexistente falla con ENOENT, no en silencio', async () => {
  await assert.rejects(() => readJsonMaybeGzip(path.join(tempDir(), 'no-existe.json')), { code: 'ENOENT' });
});

// Lo que importa de verdad: con el caché comprimido, el lote NO vuelve a pedir
// lo que ya trajo.
test('el caché comprimido reanuda el lote sin repedir lo conocido', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'source-cache.json');
  const fetchedAt = new Date().toISOString();
  await writeJsonGzip(target, {
    schema_version: 1,
    entries: { [ISBN]: { bne: { fetched_at: fetchedAt, error: null, records: [] } } },
  });
  const { data: cache } = await readJsonMaybeGzip(target);
  assert.equal(isSourceCacheFresh(cache, ISBN, 'bne'), true);
  const plan = planBookSourceResearch([{ id: 'A', isbn: ISBN }], cache, { bneBudget: 5 });
  assert.deepEqual(plan.bne, [], 'no debería volver a pedir el ISBN cacheado');
  assert.equal(plan.cached_bne, 1);
});
