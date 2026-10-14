/**
 * FASE 0 — diagnóstico del control de precios (solo lectura).
 *
 * 1. Lee el inventario publicado (catalog.json en R2) y cuenta las activas con
 *    stock > 0 de verdad.
 * 2. Con una muestra de títulos, prueba qué endpoints de la API de Mercado
 *    Libre Uruguay (MLU) devuelven a los OTROS vendedores y sus precios, si
 *    exigen token y qué dicen del envío.
 * 3. Registra la forma real de los datos de envío para decidir cómo distinguir
 *    «entrega inmediata» de «por encargo».
 *
 * No escribe nada, no modifica publicaciones. Nunca usa el refresh token
 * rotativo de la tienda (compartirlo con el sync de producción lo invalidaría):
 * si hay credenciales de aplicación usa grant client_credentials.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const R2_BASE = process.env.CATALOG_BASE_URL || 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const SELLER_ID = process.env.SELLER_ID || '440298103';
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 20);
const PACE_MS = Number(process.env.PACE_MS || 350);
const OUT = process.env.OUT_DIR || 'artifacts/price-watch';
const API = 'https://api.mercadolibre.com';

const stats = { calls: 0, status429: 0, retries: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, token) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(PACE_MS);
    stats.calls += 1;
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    } catch (error) {
      return { status: 0, error: error?.name || 'fetch', body: null };
    }
    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) stats.status429 += 1;
      stats.retries += 1;
      const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      await sleep(wait);
      continue;
    }
    let body = null;
    try { body = await res.json(); } catch { /* sin cuerpo */ }
    return { status: res.status, body };
  }
  return { status: 429, error: 'agotó reintentos', body: null };
}

async function appToken() {
  const id = process.env.ML_APP_ID;
  const secret = process.env.ML_CLIENT_SECRET;
  if (!id || !secret) return { token: null, note: 'sin ML_APP_ID/ML_CLIENT_SECRET: solo llamadas sin token' };
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) return { token: null, note: `client_credentials rechazado (HTTP ${res.status}: ${json.error || json.message || 'sin detalle'})` };
  return { token: json.access_token, note: 'client_credentials OK' };
}

const keysOf = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 2) return typeof value;
  if (Array.isArray(value)) return value.length ? [keysOf(value[0], depth + 1)] : [];
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k, keysOf(v, depth + 1)]));
};

function pickSample(items, size) {
  const withProduct = items.filter((i) => i.catalog_product_id);
  const without = items.filter((i) => !i.catalog_product_id);
  const half = Math.ceil(size / 2);
  const step = (list, n) => list.filter((_, idx) => idx % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
  return [...step(withProduct, half), ...step(without, size - half)].slice(0, size);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), sellerId: SELLER_ID };

  // 1) Inventario
  const catRes = await fetch(`${R2_BASE}/catalog.json`);
  if (!catRes.ok) throw new Error(`catalog.json HTTP ${catRes.status}`);
  const catalog = await catRes.json();
  const items = Array.isArray(catalog) ? catalog : catalog.items || [];
  const active = items.filter((i) => i.status === 'active' && Number(i.available_quantity) > 0);
  report.inventory = {
    total_en_catalogo: items.length,
    activas_con_stock: active.length,
    con_catalog_product_id: active.filter((i) => i.catalog_product_id).length,
    catalog_listing_true: active.filter((i) => i.catalog_listing === true).length,
    con_isbn: active.filter((i) => i.isbn).length,
    moneda: Object.fromEntries([...new Set(active.map((i) => i.currency))].map((c) => [c, active.filter((i) => i.currency === c).length])),
    campos_de_ventas: ['sold_quantity', 'sales', 'revenue'].filter((k) => active.some((i) => k in i)),
    updated_at: catalog.updated_at || null,
  };
  console.log('Inventario:', JSON.stringify(report.inventory));

  // 2) Token
  const auth = await appToken();
  report.auth = auth.note;
  console.log('Auth:', auth.note);

  // 3) Muestra y métodos
  const sample = pickSample(active, SAMPLE_SIZE);
  report.sampleSize = sample.length;
  const methods = {
    item_publico: (i) => `${API}/items/${i.id}`,
    producto_catalogo: (i) => (i.catalog_product_id ? `${API}/products/${i.catalog_product_id}` : null),
    ofertas_del_producto: (i) => (i.catalog_product_id ? `${API}/products/${i.catalog_product_id}/items` : null),
    busqueda_por_producto: (i) => (i.catalog_product_id ? `${API}/sites/MLU/search?product_id=${i.catalog_product_id}&limit=50` : null),
    busqueda_por_isbn: (i) => (i.isbn ? `${API}/sites/MLU/search?q=${encodeURIComponent(i.isbn)}&limit=50` : null),
    busqueda_titulo_editorial: (i) => `${API}/sites/MLU/search?q=${encodeURIComponent([i.title, i.publisher].filter(Boolean).join(' ').slice(0, 120))}&limit=50`,
  };
  const results = Object.fromEntries(Object.keys(methods).map((m) => [m, { intentos: 0, ok_sin_token: 0, ok_con_token: 0, otros_vendedores: 0, status_sin_token: {}, status_con_token: {} }]));
  const shapes = {};
  const errorSamples = {};

  for (const item of sample) {
    for (const [name, build] of Object.entries(methods)) {
      const url = build(item);
      if (!url) continue;
      const r = results[name];
      r.intentos += 1;
      const anon = await get(url, null);
      r.status_sin_token[anon.status] = (r.status_sin_token[anon.status] || 0) + 1;
      if (anon.status === 200) r.ok_sin_token += 1;
      else if (!errorSamples[name]) errorSamples[name] = { status: anon.status, body: anon.body ?? anon.error };
      let best = anon;
      if (auth.token) {
        const authed = await get(url, auth.token);
        r.status_con_token[authed.status] = (r.status_con_token[authed.status] || 0) + 1;
        if (authed.status === 200) { r.ok_con_token += 1; best = authed; }
      }
      if (best.status === 200) {
        const rows = Array.isArray(best.body?.results) ? best.body.results : Array.isArray(best.body) ? best.body : [];
        const others = rows.filter((row) => String(row.seller?.id ?? row.seller_id ?? '') && String(row.seller?.id ?? row.seller_id) !== SELLER_ID);
        if (others.length) r.otros_vendedores += 1;
        if (!shapes[name]) shapes[name] = keysOf(rows.length ? rows[0] : best.body);
      }
    }
  }
  report.methods = results;
  report.shapes = shapes;
  report.stats = stats;

  // 4) Forma de los datos de envío en publicaciones propias (para definir «entrega inmediata»)
  const shippingSamples = [];
  for (const item of sample.slice(0, 5)) {
    const r = await get(`${API}/items/${item.id}`, auth.token);
    if (r.status === 200) {
      const b = r.body;
      shippingSamples.push({
        id: item.id, shipping: b.shipping, sale_terms: (b.sale_terms || []).map((t) => ({ id: t.id, value: t.value_name })),
        seller_address: b.seller_address ? { city: b.seller_address.city?.name, state: b.seller_address.state?.name } : null,
        tags: b.tags, listing_type_id: b.listing_type_id,
        manufacturing_time: (b.sale_terms || []).find((t) => t.id === 'MANUFACTURING_TIME')?.value_name ?? null,
      });
    }
  }
  report.shippingSamples = shippingSamples;

  await writeFile(`${OUT}/fase0.json`, `${JSON.stringify(report, null, 2)}\n`);
  const lines = ['## Fase 0 — control de precios', '',
    `- Activas con stock > 0: **${report.inventory.activas_con_stock}** (de ${report.inventory.total_en_catalogo} en el catálogo)`,
    `- Con catalog_product_id: ${report.inventory.con_catalog_product_id} · con ISBN: ${report.inventory.con_isbn}`,
    `- Auth: ${auth.note}`, `- Llamadas: ${stats.calls} · 429: ${stats.status429} · reintentos: ${stats.retries}`, '',
    '| Método | Intentos | OK sin token | OK con token | Con otros vendedores |', '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(results).map(([m, r]) => `| ${m} | ${r.intentos} | ${r.ok_sin_token} | ${r.ok_con_token} | ${r.otros_vendedores} |`),
    '', '### Códigos de estado sin token / con token', '',
    ...Object.entries(results).map(([m, r]) => `- ${m}: sin token ${JSON.stringify(r.status_sin_token)}${auth.token ? ` · con token ${JSON.stringify(r.status_con_token)}` : ''}`),
    '', '### Mensaje de error de ejemplo (sin token)', '',
    ...Object.entries(errorSamples).map(([m, e]) => `- ${m}: HTTP ${e.status} ${JSON.stringify(e.body)?.slice(0, 220)}`)];
  await writeFile(`${OUT}/fase0-resumen.md`, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

main().catch((error) => { console.error(error); process.exit(1); });
