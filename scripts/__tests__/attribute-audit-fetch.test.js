import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fetchAllItems, auditPageShape } from '../mercadolibre/attribute-audit-fetch.mjs';

const page = extra => ({ read_only: true, seller_id: '440298103', items: [], failed_ids: [], total: 0, scroll_id: null, page_empty: true, ...extra });

test('recorre las páginas hasta que no hay scroll_id y no repite items', async () => {
  const pages = [
    page({ items: [{ id: 'MLU1' }, { id: 'MLU2' }], scroll_id: 's1', total: 3, page_empty: false }),
    page({ items: [{ id: 'MLU2' }, { id: 'MLU3' }], total: 3, page_empty: false }),
  ];
  const bodies = [];
  const fetcher = async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(pages.shift()); };
  const out = await fetchAllItems({ secret: 'x', fetcher, wait: async () => {} });
  assert.deepEqual(out.items.map(i => i.id), ['MLU1', 'MLU2', 'MLU3']);
  assert.deepEqual(out.failed_ids, []);
  assert.deepEqual(bodies, [{}, { scroll_id: 's1' }]);
});

test('reintenta ante 429 y corta ante un error definitivo', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? Response.json({ error: 'x' }, { status: 429 }) : Response.json(page()));
  assert.equal((await fetchAllItems({ secret: 'x', fetcher: flaky, wait: async () => {} })).items.length, 0);
  await assert.rejects(fetchAllItems({ secret: 'x', fetcher: async () => Response.json({ error: 'no' }, { status: 401 }), wait: async () => {} }), /no/);
  await assert.rejects(fetchAllItems({}), /SYNC_SECRET/);
});

test('rechaza HTTP 200 vacío, JSON inválido y estructuras incompletas', async () => {
  for (const body of [{}, null, [], { items: [] }, page({ items: null }), page({ scroll_id: '' }), page({ failed_ids: null }), page({ seller_id: '2341378249' }), page({ read_only: false }), page({ page_empty: false }), page({ items: [{ id: 'MLU1' }] })]) {
    await assert.rejects(fetchAllItems({ secret: 'x', fetcher: async () => Response.json(body), wait: async () => {} }), /respuesta de auditoría inválida/);
  }
  await assert.rejects(fetchAllItems({ secret: 'x', fetcher: async () => new Response('', { status: 200 }), wait: async () => {} }), /respuesta de auditoría inválida/);
});

test('cero publicaciones exige un total explícito y cobertura completa', async () => {
  const empty = await fetchAllItems({ secret: 'x', fetcher: async () => Response.json(page()), wait: async () => {} });
  assert.equal(empty.total, 0);
  for (const body of [page({ total: 100 }), page({ total: null }), page({ total: 2, page_empty: false, items: [{ id: 'MLU1' }] })]) {
    await assert.rejects(fetchAllItems({ secret: 'x', fetcher: async () => Response.json(body), wait: async () => {} }), /Auditoría incompleta/);
  }
});

test('errores individuales de lectura impiden presentar una auditoría exitosa', async () => {
  await assert.rejects(fetchAllItems({ secret: 'x', fetcher: async () => Response.json(page({ total: 2, page_empty: false, items: [{ id: 'MLU1' }], failed_ids: ['MLU2'] })), wait: async () => {} }), /1 sin poder leer/);
});

test('acepta la página vacía final de un scan completo', async () => {
  const pages = [page({ total: 1, page_empty: false, items: [{ id: 'MLU1' }], scroll_id: 's1' }), page({ total: 1, scroll_id: 's1' })];
  const result = await fetchAllItems({ secret: 'x', fetcher: async () => Response.json(pages.shift()), wait: async () => {} });
  assert.equal(result.items.length, 1);
  assert.equal(result.pages, 2);
});

test('CLI: una respuesta inválida falla sin guardar un falso informe vacío', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mlu-attribute-fetch-'));
  const script = fileURLToPath(new URL('../mercadolibre/attribute-audit-fetch.mjs', import.meta.url));
  const run = body => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(`globalThis.fetch=async()=>Response.json(${JSON.stringify(body)});`)}`, script, path.join(dir, 'raw.json')], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, SYNC_SECRET: 'test-secret-not-real' },
  });
  try {
    const invalid = run({});
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /respuesta de auditoría inválida/);
    assert.ok(!invalid.stderr.includes('test-secret-not-real'));
    await assert.rejects(access(path.join(dir, 'raw.json')));
    const valid = run(page());
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'raw.json'), 'utf8')).total, 0);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('el diagnóstico conserva cobertura previa y omite cursores y cuerpos no validados', async () => {
  const pages = [
    page({ total: 2, page_empty: false, items: [{ id: 'MLU1' }], scroll_id: 'private-cursor' }),
    page({ total: 2, scroll_id: '', secret: 'private-body' }),
  ];
  await assert.rejects(fetchAllItems({ secret: 'private-token', fetcher: async () => Response.json(pages.shift()), wait: async () => {} }), error => {
    assert.equal(error.auditDiagnostics.items_read, 1);
    assert.equal(error.auditDiagnostics.shape.scroll_id_kind, 'empty_string');
    assert.equal(error.incompleteAudit.complete, false);
    assert.deepEqual(error.incompleteAudit.items, [{ id: 'MLU1' }]);
    assert.ok(!JSON.stringify(error).includes('private-'));
    return true;
  });
  const shape = auditPageShape({ scroll_id: 'private-cursor', seller_id: 'private-seller', items: [{ token: 'private-token' }] });
  assert.equal(shape.scroll_id_kind, 'nonempty_string');
  assert.ok(!JSON.stringify(shape).includes('private-'));
});
