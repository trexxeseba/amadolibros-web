import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mlFalso, it } from './ml-falso.mjs';

test('corrida de simulación de punta a punta: decide, informa y no escribe nada en ML', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'precios-sim-')); t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.PRECIOS_DATOS_DIR = dir; process.env.ML_ACCESS_TOKEN = 'tok-prueba';
  await writeFile(join(dir, 'piso.json'), JSON.stringify({ comisionPct: 0.15, cargoFijoUyu: 0, envioUyu: 100, margenMinPct: 0.10 }));
  await writeFile(join(dir, 'costos.csv'), 'item_id,costo_uyu,envio_uyu\nMLU1,900,\nMLU2,1500,\n');
  const items = { MLU1: it('MLU1', 2000), MLU2: it('MLU2', 2000), MLU3: it('MLU3', 2000), MLU4: it('MLU4', 1500, { catalog_listing: false, catalog_product_id: null }), MLU5: it('MLU5', 2000) };
  const ptw = id => ({ status: 'competing', price_to_win: 1700, catalog_product_id: 'P' + id, winner: { item_id: 'MLU9' + id, price: 1700 } });
  const otro = (id, price) => [{ item_id: 'MLU9' + id, seller_id: 111, price, currency_id: 'UYU', condition: 'new' }, { item_id: 'MLU' + id, seller_id: 440298103, price: 2000, condition: 'new' }];
  const f = mlFalso({
    items,
    ptw: { MLU1: ptw('1'), MLU2: ptw('2'), MLU3: ptw('3'), MLU5: ptw('5') },
    ofertas: { P1: otro('1', 1700), P2: otro('2', 1700), P3: otro('3', 1500), P5: otro('5', 1700) },
    promos: { MLU5: [{ id: 'P-X', type: 'DEAL', status: 'pending' }] },
  });
  for (const id of Object.keys(items)) items[id].catalog_product_id = items[id].catalog_listing ? 'P' + id.slice(3) : null;
  const viejo = globalThis.fetch; globalThis.fetch = f.fetcher; t.after(() => { globalThis.fetch = viejo; });
  const { main } = await import('../src/run.mjs');
  const codigo = await main(['--sin-alertas', '--real']);   // --real sin modo.json = simulación
  assert.equal(codigo, 0);
  assert.equal(f.llamadas.filter(l => !l.startsWith('GET')).length, 0, 'ninguna escritura');
  const [corrida] = await readdir(join(dir, 'informes'));
  const csv = await readFile(join(dir, 'informes', corrida, 'informe.csv'), 'utf8');
  const fila = id => csv.split('\r\n').find(l => l.startsWith(id + ','));
  assert.match(fila('MLU1'), /,bajar,/); assert.match(fila('MLU1'), /,1683,317,false,/);   // piso 1334
  assert.match(fila('MLU2'), /,omitir_bajo_piso,/);        // piso (1500+100)/0,75 = 2134
  assert.match(fila('MLU3'), /,no_tocar_umbral,/);         // D 500
  assert.match(fila('MLU4'), /,revision_sin_comparable,/); // sin catálogo
  assert.match(fila('MLU5'), /,omitir_promocion,/);        // promo programada
  const md = await readFile(join(dir, 'informes', corrida, 'informe.md'), 'utf8');
  assert.match(md, /Impacto del límite acumulado/);
  assert.equal(items.MLU1.price, 2000);
});
