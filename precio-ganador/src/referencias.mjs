// Referencias de precio de Mercado Libre para nuestras publicaciones (sólo lee, no cambia precios).
//
//   node precio-ganador/src/referencias.mjs --cuenta libros --salida DIR
//
// El 24/11/2026 se confirmó con una llamada real que GET /suggestions/user/{seller}/items devuelve
// la lista de publicaciones propias con referencia (1.627 en Amado Libros), y que para ellas
// GET /suggestions/items/{id}/details trae el precio sugerido. Preguntar ítem por ítem sin esa lista
// daba 404 en casi todas, y por eso se había dado por no disponible en Uruguay.
// Desde el 23/11/2026 /products/{id}/items responde 403 (PolicyAgent): esta es la única lectura de
// precios de competencia que queda por API.
// El log sólo muestra conteos (el repo es público); el detalle va al archivo de salida (repo privado).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { detalle } from './publicaciones.mjs';

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const monto = v => num(v?.amount ?? v);

// De la respuesta de /suggestions/items/{id}/details a una fila chica. Función pura.
export function filaReferencia(item, d) {
  const precio = num(item?.price), sugerido = monto(d?.suggested_price), actual = monto(d?.current_price), minimo = monto(d?.lowest_price);
  // Seba, 25/11/2026: sólo se compara contra Mercado Libre (interno), no contra precios de otras tiendas (externo).
  const interno = monto(d?.internal_price), externo = monto(d?.external_price);
  const brechaInterna = precio !== null && interno !== null && precio > 0 ? Math.round((precio - interno) / precio * 1000) / 10 : null;
  const brecha = precio !== null && sugerido !== null && precio > 0 ? Math.round((precio - sugerido) / precio * 1000) / 10 : null;
  return {
    id: item?.id ?? d?.item_id ?? null, titulo: String(item?.title ?? '').slice(0, 70), precio, stock: num(item?.available_quantity), catalogo: !!item?.catalog_listing,
    estado: String(d?.status ?? ''), sugerido, precio_segun_ml: actual, minimo, brecha_pct: brecha, interno, externo, brecha_interna_pct: brechaInterna,
    comparadas: num(d?.metadata?.compared_values) ?? (Array.isArray(d?.metadata?.graph) ? d.metadata.graph.length : null),
    claves: d && typeof d === 'object' ? Object.keys(d) : [],
  };
}

const mediana = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function resumenReferencias(filas) {
  const porEstado = {};
  for (const f of filas) porEstado[f.estado || 'sin_estado'] = (porEstado[f.estado || 'sin_estado'] ?? 0) + 1;
  const caras = filas.filter(f => (f.sugerido !== null && f.precio !== null && f.sugerido < f.precio) || (f.interno != null && f.precio != null && f.interno < f.precio));
  return {
    con_interno: filas.filter(f => f.interno != null).length, mas_caras_que_el_interno: filas.filter(f => f.interno != null && f.precio != null && f.interno < f.precio).length,
    leidas: filas.length, por_estado: porEstado, con_sugerido: filas.filter(f => f.sugerido !== null).length,
    mas_caras_que_el_sugerido: caras.length, brecha_mediana_pct: mediana(caras.map(f => f.brecha_pct)),
    brecha_hasta_10: caras.filter(f => f.brecha_pct <= 10).length, brecha_10_a_25: caras.filter(f => f.brecha_pct > 10 && f.brecha_pct <= 25).length, brecha_mas_de_25: caras.filter(f => f.brecha_pct > 25).length,
  };
}

async function enParalelo(lista, n, fn) {
  const cola = [...lista];
  await Promise.all(Array.from({ length: n }, async () => { while (cola.length) await fn(cola.shift()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta || cuenta.clave !== 'libros') { console.error('Sólo --cuenta libros'); process.exit(2); }
  const salida = opt('salida', '.');
  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 }); // sólo GET en este archivo
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  // Lista de publicaciones con referencia. Se pagina por si la respuesta viene cortada.
  const ids = new Set(); let total = null;
  for (let offset = 0; offset < 20000; ) {
    const d = await ml.get(`/suggestions/user/${cuenta.sellerId}/items?offset=${offset}&limit=1000`);
    const lote = Array.isArray(d?.items) ? d.items : [];
    total ??= num(d?.total);
    const antes = ids.size;
    for (const id of lote) ids.add(String(id));
    if (!lote.length || ids.size === antes || (total !== null && ids.size >= total)) break;
    offset += lote.length;
  }
  const lista = [...ids];
  const items = await detalle(ml, lista);
  const filas = []; const errores = {};
  await enParalelo(lista, 4, async id => {
    try { filas.push(filaReferencia(items.get(id) ?? { id }, await ml.get(`/suggestions/items/${id}/details`))); }
    catch (e) { if (e?.fatal || e?.status === 429) throw e; const k = 'http_' + (e?.status ?? 0); errores[k] = (errores[k] ?? 0) + 1; }
  });
  // Visitas de 30 días de las que están más caras que la referencia (Seba, 25/11/2026: empezar por las más vistas).
  const caras = filas.filter(f => f.sugerido !== null && f.precio !== null && f.sugerido < f.precio);
  await enParalelo(caras, 4, async f => { try { const r = await ml.get(`/items/${f.id}/visits/time_window?last=30&unit=day`); f.visitas_30d = Number(r?.total_visits ?? 0); } catch (e) { if (e?.fatal || e?.status === 429) throw e; f.visitas_30d = null; } });
  const fecha = new Date().toISOString().slice(0, 10);
  const resumen = { fecha, cuenta: cuenta.clave, total_segun_ml: total, ids: lista.length, errores, ...resumenReferencias(filas), claves_vistas: [...new Set(filas.flatMap(f => f.claves))] };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-referencias.json`), JSON.stringify({ resumen, filas: filas.map(({ claves, ...f }) => f) }, null, 1));
  console.log(JSON.stringify(resumen)); // sólo conteos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('referencias:', e.message); process.exit(1); });
