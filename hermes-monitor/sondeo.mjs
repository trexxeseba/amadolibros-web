// Temporal (solo lectura): junta los libros de la tienda GLIC (seller 345281879) desde su portada pública y los lee con la API oficial.
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
const GLIC = 345281879;
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
const pausa = ms => new Promise(r => setTimeout(r, ms));
const bajar = async u => { try { const r = await fetch(u, {headers: {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'es-UY'}}); return r.ok ? await r.text() : ''; } catch { return ''; } };
const ids = new Set();
const paginas = new Set(['https://www.mercadolibre.com.uy/tienda/glic']);
const hechas = new Set();
for (let ronda = 0; ronda < 2; ronda++) {
  for (const u of [...paginas]) {
    if (hechas.has(u) || hechas.size > 25) continue;
    hechas.add(u);
    const t = await bajar(u);
    for (const m of t.matchAll(/MLU-?(\d{8,})/g)) ids.add('MLU' + m[1]);
    for (const m of t.matchAll(/https:\/\/www\.mercadolibre\.com\.uy\/tienda\/glic[^"'\s\\<>]*/g)) if (!/\.(js|css|png|jpg|svg)/.test(m[0])) paginas.add(m[0].replace(/&amp;/g, '&'));
    await pausa(500);
  }
}
console.log('GLICINFO paginas', hechas.size, 'ids', ids.size, [...hechas].slice(0, 12).join(' '));
const lista = [...ids];
let libros = 0, otros = 0, ajenos = 0;
for (let i = 0; i < lista.length; i += 20) {
  const lote = lista.slice(i, i + 20);
  await pausa(450);
  const r = await ml.get(`/items?ids=${lote.join(',')}&attributes=id,title,price,seller_id,category_id,catalog_product_id,status,attributes,condition`).catch(() => null);
  for (const w of r ?? []) {
    const it = w.body; if (!it?.id) continue;
    if (Number(it.seller_id) !== GLIC) { ajenos++; continue; }
    if (it.category_id !== 'MLU1196') { otros++; continue; }
    libros++;
    const isbn = (it.attributes ?? []).find(a => ['GTIN', 'ISBN'].includes(a.id))?.value_name ?? null;
    console.log('GLIC ' + JSON.stringify({id: it.id, producto: it.catalog_product_id, titulo: it.title, precio: it.price, isbn, estado: it.status}));
  }
}
console.log('GLICINFO libros', libros, 'otras_categorias', otros, 'de_otro_vendedor', ajenos);
