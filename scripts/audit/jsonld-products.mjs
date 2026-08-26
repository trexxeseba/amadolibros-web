#!/usr/bin/env node
// 1.3 — Extrae el JSON-LD de una muestra estratificada de fichas y valida
// Product/Offer. Agrupa los errores por tipo y marca los que podrían
// corresponder a los 47 "missing price" abiertos en Merchant Center.
//
// Estratificación: se toman fichas de sitemap-books-active y de
// sitemap-books-paused por separado, con paso fijo dentro de cada estrato para
// que la muestra sea reproducible entre corridas. Una muestra solo de activas
// escondería justamente el caso "sin Offer" que interesa comparar.
import { BASE_URL, absoluteUrls, mapWithLimit, request, writeReport } from './_lib.mjs';

const SAMPLE_SIZE = Math.max(120, Number(process.env.AUDIT_JSONLD_SAMPLE) || 120);

function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const parsed = [];
  for (const block of blocks) {
    try {
      const value = JSON.parse(block[1].trim());
      for (const node of Array.isArray(value) ? value : [value]) parsed.push(node);
    } catch (error) {
      parsed.push({ __parseError: error.message });
    }
  }
  return parsed;
}

function typesOf(node) {
  return [].concat(node?.['@type'] || []).map(String);
}

function validate(nodes) {
  const errors = [];
  const parseErrors = nodes.filter(node => node.__parseError);
  for (const node of parseErrors) errors.push({ tipo: 'json_invalido', detalle: node.__parseError });

  const product = nodes.find(node => typesOf(node).some(t => t === 'Product' || t === 'Book'));
  if (!product) {
    errors.push({ tipo: 'sin_nodo_product', detalle: 'no hay nodo Product ni Book' });
    return { errors, product: null, offer: null };
  }

  if (!product.name) errors.push({ tipo: 'product_sin_name', detalle: 'falta name' });
  if (!product.image) errors.push({ tipo: 'product_sin_image', detalle: 'falta image' });

  const offerNode = product.offers
    ? ([].concat(product.offers)[0])
    : nodes.find(node => typesOf(node).includes('Offer'));

  if (!offerNode) {
    // Una ficha pausada sin Offer es correcta por diseño: no hay oferta real.
    // Se reporta igual, y la clasificación pausada/activa se resuelve al cruzar.
    errors.push({ tipo: 'sin_offer', detalle: 'Product sin nodo offers' });
    return { errors, product, offer: null };
  }

  const price = offerNode.price ?? offerNode.lowPrice ?? offerNode.highPrice;
  if (price === undefined || price === null || String(price).trim() === '') {
    errors.push({ tipo: 'offer_sin_price', detalle: 'Offer sin price' });
  } else if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
    errors.push({ tipo: 'offer_price_invalido', detalle: `price = ${JSON.stringify(price)}` });
  }
  if (!offerNode.priceCurrency) errors.push({ tipo: 'offer_sin_currency', detalle: 'falta priceCurrency' });
  if (!offerNode.availability) errors.push({ tipo: 'offer_sin_availability', detalle: 'falta availability' });

  return { errors, product, offer: offerNode };
}

async function sitemapUrls(name) {
  const response = await request(`${BASE_URL}/${name}`);
  if (!response.ok || response.status !== 200) return [];
  return absoluteUrls(response.body).filter(loc => /\/libro\/MLU\d+/i.test(loc));
}

function stratify(list, take) {
  if (list.length <= take) return list;
  const step = list.length / take;
  const picked = [];
  for (let i = 0; i < take; i += 1) picked.push(list[Math.floor(i * step)]);
  return picked;
}

async function main() {
  const activas = await sitemapUrls('sitemap-books-active.xml');
  const pausadas = await sitemapUrls('sitemap-books-paused.xml');
  console.log(`Sitemap activas: ${activas.length} · pausadas: ${pausadas.length}`);

  // Reparto proporcional entre estratos, con un piso de 20 en el estrato chico
  // para que el grupo minoritario sea comparable y no anecdótico.
  const total = activas.length + pausadas.length;
  let tomaActivas = Math.round(SAMPLE_SIZE * (activas.length / (total || 1)));
  let tomaPausadas = SAMPLE_SIZE - tomaActivas;
  if (pausadas.length && tomaPausadas < 20) { tomaPausadas = Math.min(20, pausadas.length); tomaActivas = SAMPLE_SIZE - tomaPausadas; }
  if (activas.length && tomaActivas < 20) { tomaActivas = Math.min(20, activas.length); tomaPausadas = SAMPLE_SIZE - tomaActivas; }

  const activasTomadas = stratify(activas, tomaActivas);
  const pausadasTomadas = stratify(pausadas, tomaPausadas);
  const muestra = [
    ...activasTomadas.map(url => ({ url, estrato: 'activa' })),
    ...pausadasTomadas.map(url => ({ url, estrato: 'pausada' })),
  ];
  // Se loguea lo REALMENTE tomado, no el objetivo: con universos chicos
  // (pruebas locales) stratify() puede devolver menos que lo pedido.
  console.log(`Muestra: ${muestra.length} (activas ${activasTomadas.length} / pausadas ${pausadasTomadas.length})`);

  const rows = await mapWithLimit(muestra, async item => {
    const response = await request(item.url);
    if (!response.ok || response.status !== 200) {
      return { ...item, status: response.status, errors: [{ tipo: 'no_alcanzable', detalle: response.error || `HTTP ${response.status}` }] };
    }
    const nodes = extractJsonLd(response.body);
    const { errors, offer } = validate(nodes);
    return {
      ...item,
      status: response.status,
      bloquesJsonLd: nodes.length,
      price: offer?.price ?? null,
      priceCurrency: offer?.priceCurrency ?? null,
      availability: offer?.availability ?? null,
      errors,
    };
  });

  const porTipo = {};
  for (const row of rows) {
    for (const error of row.errors) {
      porTipo[error.tipo] ||= { total: 0, activa: 0, pausada: 0, ejemplos: [] };
      porTipo[error.tipo].total += 1;
      porTipo[error.tipo][row.estrato] += 1;
      if (porTipo[error.tipo].ejemplos.length < 5) porTipo[error.tipo].ejemplos.push(row.url);
    }
  }

  // Cruce con Merchant: los 47 "missing price" solo pueden corresponder a
  // fichas ACTIVAS sin price utilizable. Una pausada sin Offer no entra al feed.
  const candidatosMerchant = rows.filter(row => row.estrato === 'activa'
    && row.errors.some(error => ['offer_sin_price', 'offer_price_invalido', 'sin_offer'].includes(error.tipo)));

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    muestra: { total: rows.length, activas: activasTomadas.length, pausadas: pausadasTomadas.length, universo: { activas: activas.length, pausadas: pausadas.length } },
    totals: {
      sinErrores: rows.filter(row => row.errors.length === 0).length,
      conErrores: rows.filter(row => row.errors.length > 0).length,
      candidatosMissingPriceMerchant: candidatosMerchant.length,
    },
    erroresPorTipo: porTipo,
    candidatosMissingPriceMerchant: candidatosMerchant.map(row => ({ url: row.url, errores: row.errors.map(e => e.tipo) })),
    filas: rows,
  };

  console.log(JSON.stringify(report.totals, null, 2));
  console.log('Errores por tipo:');
  for (const [tipo, data] of Object.entries(porTipo)) {
    console.log(`  ${tipo.padEnd(26)} ${String(data.total).padStart(4)}  (activas ${data.activa} / pausadas ${data.pausada})`);
  }
  await writeReport('1.3-jsonld-products.json', report);
}

main().catch(error => {
  console.error(`jsonld-products falló: ${error.message}`);
  process.exitCode = 1;
});
