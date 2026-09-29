#!/usr/bin/env node

// Verifica en la web publicada, sobre una muestra de fichas activas, lo que
// cambió con #360: miga de pan con la categoría real (visible y en
// BreadcrumbList), ficha ampliada y enlaces a landings. Sólo lectura.
//
// Uso: FICHAS_CHECK_BASE=https://www.amadolibros.com node scripts/seo/fichas-produccion-check.mjs

import { readFileSync } from 'node:fs';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { categoryTrailForPaths } from '../../functions/libro/_middleware.js';

const BASE = (process.env.FICHAS_CHECK_BASE || 'https://www.amadolibros.com').replace(/\/$/, '');
const SAMPLE = Math.max(1, Number(process.env.FICHAS_CHECK_SAMPLE) || 30);

function breadcrumbSchema(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.['@type'] === 'BreadcrumbList') return parsed;
    } catch {}
  }
  return null;
}

async function main() {
  const catalog = await (await fetch(CATALOG_URL)).json();
  const categories = JSON.parse(readFileSync('astro-front/public/data/active-categories.json', 'utf8')).items;
  const assisted = new Set(JSON.parse(readFileSync('scripts/categorize/assisted-classifications.json', 'utf8')).map(e => e.mlu));
  const active = catalog.items.filter(item => item.status === 'active' && Number(item.available_quantity) > 0);
  const withTrail = active.filter(item => categoryTrailForPaths(categories[item.id]).length);
  const sample = [
    ...withTrail.filter(item => assisted.has(item.id)).slice(0, Math.ceil(SAMPLE / 2)),
    ...withTrail.filter(item => !assisted.has(item.id)).slice(0, Math.floor(SAMPLE / 2)),
  ];

  const rows = [];
  for (const item of sample) {
    const expected = categoryTrailForPaths(categories[item.id]);
    const response = await fetch(`${BASE}/libro/${item.id}`, { redirect: 'follow' });
    const html = await response.text();
    const nav = html.match(/<nav>[\s\S]*?<\/nav>/)?.[0] || '';
    const schema = breadcrumbSchema(html);
    const schemaItems = (schema?.itemListElement || []).map(entry => entry.item || '');
    const visibleOk = expected.every(step => nav.includes(`href="${step.path}"`));
    const schemaOk = expected.every(step => schemaItems.includes(`${BASE}${step.path}`) || schemaItems.some(url => url.endsWith(step.path)));
    rows.push({
      id: item.id,
      status: response.status,
      asistida: assisted.has(item.id),
      esperado: expected.map(step => step.name).join(' › '),
      visible: visibleOk,
      jsonld: schemaOk,
      ficha_ampliada: html.includes('class="product-showcase"'),
    });
  }

  const ok = rows.filter(row => row.status === 200 && row.visible && row.jsonld);
  console.log(`Base: ${BASE}`);
  console.log(`Fichas revisadas: ${rows.length} · miga de pan correcta (visible + JSON-LD): ${ok.length}`);
  console.log(`Con ficha ampliada: ${rows.filter(row => row.ficha_ampliada).length}/${rows.length}`);
  console.log('| MLU | HTTP | asistida | categoría esperada | visible | JSON-LD | ficha ampliada |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    console.log(`| ${row.id} | ${row.status} | ${row.asistida ? 'sí' : 'no'} | ${row.esperado} | ${row.visible ? 'OK' : 'FALTA'} | ${row.jsonld ? 'OK' : 'FALTA'} | ${row.ficha_ampliada ? 'sí' : 'no'} |`);
  }
  if (ok.length !== rows.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
