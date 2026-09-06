import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Valida contra el Preview DESPLEGADO cada ficha que el PR dice mejorar.
// Una prueba local del renderizador no sustituye esto: sólo el Preview
// demuestra que el dato llegó a la página que sirve Cloudflare.
//
// Comprueba, por ficha: HTTP, el campo visible en el HTML y el campo en el
// JSON-LD cuando corresponde. Las diferencias de catálogo —fichas que ya no
// están activas— se registran APARTE y no se cuentan como fallo del PR.

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function productSchema(html) {
  for (const match of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const types = Array.isArray(parsed?.['@type']) ? parsed['@type'] : [parsed?.['@type']];
    if (types.includes('Product')) return parsed;
  }
  return null;
}

// Qué se espera ver, campo por campo, en la página servida.
export function expectedChecks(esperado) {
  const checks = [];
  if (esperado.publisher) {
    checks.push({ campo: 'publisher', visible: esperado.publisher, jsonLd: schema => clean(schema?.publisher?.name || schema?.publisher) });
  }
  if (esperado.pages) {
    checks.push({ campo: 'pages', visible: String(esperado.pages), jsonLd: schema => clean(schema?.numberOfPages) });
  }
  if (esperado.publication_year) {
    checks.push({ campo: 'publication_year', visible: String(esperado.publication_year), jsonLd: null });
  }
  if (esperado.language) {
    checks.push({ campo: 'language', visible: esperado.language, jsonLd: null });
  }
  if (esperado.author) {
    checks.push({ campo: 'author', visible: esperado.author, jsonLd: schema => clean(schema?.author?.name || schema?.author) });
  }
  return checks;
}

export function evaluate(html, esperado) {
  const schema = productSchema(html);
  const resultados = [];
  for (const check of expectedChecks(esperado)) {
    const enHtml = html.includes(check.visible);
    const enJsonLd = check.jsonLd ? String(check.jsonLd(schema)).includes(check.visible) : null;
    resultados.push({ campo: check.campo, esperado: check.visible, enHtml, enJsonLd });
  }
  return { tieneSchema: Boolean(schema), resultados };
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index]);
    }
  }));
  return out;
}

export async function main() {
  const base = clean(process.env.PREVIEW_BASE_URL).replace(/\/$/, '');
  const planPath = process.env.PREVIEW_PLAN;
  const outputPath = process.env.PREVIEW_OUTPUT || 'artifacts/preview/preview-ficha-validation.json';
  if (!base || !planPath) throw new Error('Faltan PREVIEW_BASE_URL y PREVIEW_PLAN.');

  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const fichas = Array.isArray(plan.fichas) ? plan.fichas : [];

  const resultados = await mapWithConcurrency(fichas, 6, async ficha => {
    const url = `${base}/libro/${ficha.id}`;
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      const status = response.status;
      if (status !== 200) return { ...ficha, url, status, ok: false, motivo: `HTTP ${status}` };
      const html = await response.text();
      const { tieneSchema, resultados: campos } = evaluate(html, ficha.esperado || {});
      const faltantes = campos.filter(c => !c.enHtml && c.enJsonLd !== true);
      return { ...ficha, url, status, tieneSchema, campos, ok: faltantes.length === 0, faltantes: faltantes.map(c => c.campo) };
    } catch (error) {
      return { ...ficha, url, status: 0, ok: false, motivo: clean(error?.message) || 'fetch falló' };
    }
  });

  const noEncontradas = resultados.filter(r => r.status === 404);
  const comparables = resultados.filter(r => r.status === 200);
  const conFalla = comparables.filter(r => !r.ok);
  const errores = resultados.filter(r => r.status !== 200 && r.status !== 404);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    previewBaseUrl: base,
    snapshot: plan.snapshot || null,
    totales: {
      fichas_esperadas: fichas.length,
      verificadas_http_200: comparables.length,
      con_todos_los_campos: comparables.length - conFalla.length,
      con_campos_faltantes: conFalla.length,
      // Diferencias de catálogo: la ficha ya no está publicada. No es un fallo
      // del PR y se informa por separado.
      no_publicadas_hoy_http_404: noEncontradas.length,
      otros_errores: errores.length,
    },
    fallas: conFalla,
    diferencias_de_catalogo: noEncontradas.map(r => ({ id: r.id, isbn: r.isbn })),
    errores,
    resultados,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== VALIDACIÓN DEL PREVIEW DESPLEGADO ===');
  console.log(JSON.stringify({ ...report, resultados: undefined, fallas: conFalla.slice(0, 15) }, null, 2));
  if (conFalla.length || errores.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
