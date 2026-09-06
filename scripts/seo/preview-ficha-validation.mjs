import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Valida contra el Preview DESPLEGADO cada ficha que el PR dice mejorar.
// Una prueba local del renderizador no sustituye esto: sólo el Preview
// demuestra que el dato llegó a la página que sirve Cloudflare.
//
// La versión anterior daba falsos positivos: buscaba el valor con
// `html.includes()` sobre el documento entero, y como el bloque JSON-LD vive
// DENTRO del HTML, todo campo "aparecía visible" aunque la ficha no lo
// mostrara. Además aceptaba un campo con sólo una de las dos comprobaciones,
// hacía coincidir un número dentro de otro número, y `topics` no se
// comprobaba en absoluto.
//
// Ahora el valor visible se extrae de la sección de detalles de la ficha
// —`<div class="detail-row"><dt>Etiqueta</dt><dd>Valor</dd></div>`—, que por
// construcción excluye scripts, estilos y cualquier contenido no mostrado, y
// se compara el valor NORMALIZADO COMPLETO, no un fragmento.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

function decodeEntities(value) {
  return String(value ?? '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]);
}

export function normalize(value) {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

// Contrato real de la ficha: etiqueta visible y propiedad JSON-LD de cada
// campo, leídos de functions/libro/[[path]].js. `jsonLd: null` significa que
// el campo no tiene representación en el JSON-LD y se registra como NO
// APLICABLE, nunca como aprobado por omisión.
// El middleware de vidriera publica algunas fichas como `Product` a secas en
// vez de `Book` y, cuando lo hace, BORRA a propósito numberOfPages, bookFormat
// y bookEdition: un producto que no es un libro no debe declarar páginas en
// schema.org. Para esas fichas el dato sigue siendo visible, pero su propiedad
// JSON-LD NO APLICA. Se registra así, con el motivo, nunca como aprobado por
// omisión.
export const SOLO_EN_BOOK = Object.freeze(['pages', 'format', 'edition']);

export const FIELD_CONTRACT = Object.freeze({
  author: { etiqueta: 'Autor', jsonLd: schema => schema?.author?.name },
  publisher: { etiqueta: 'Editorial', jsonLd: schema => schema?.publisher?.name },
  pages: { etiqueta: 'Páginas', jsonLd: schema => schema?.numberOfPages },
  language: { etiqueta: 'Idioma', jsonLd: schema => schema?.inLanguage },
  format: { etiqueta: 'Formato', jsonLd: schema => schema?.bookFormat },
  edition: { etiqueta: 'Edición', jsonLd: schema => schema?.bookEdition },
  publication_year: { etiqueta: 'Año', jsonLd: schema => schema?.datePublished },
  // El renderizador une los temas con " · " y publica hasta 6 en `keywords`.
  topics: { etiqueta: 'Temas', jsonLd: schema => schema?.keywords, lista: true, jsonLdTope: 6 },
});

export function productSchema(html) {
  for (const match of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const types = Array.isArray(parsed?.['@type']) ? parsed['@type'] : [parsed?.['@type']];
    if (types.includes('Product')) return parsed;
  }
  return null;
}

// Sólo lee la lista de detalles de la ficha. Un valor que estuviera en un
// script, en un estilo o en un atributo NO aparece acá.
export function detailRows(html) {
  const rows = new Map();
  const pattern = /<div class="detail-row"><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g;
  for (const match of String(html).matchAll(pattern)) {
    const etiqueta = normalize(match[1].replace(/<[^>]+>/g, ' '));
    const valor = normalize(match[2].replace(/<[^>]+>/g, ' '));
    if (etiqueta) rows.set(etiqueta, valor);
  }
  return rows;
}

function jsonLdCoincide(field, contrato, esperado, schema) {
  const bruto = contrato.jsonLd(schema);
  if (bruto == null || bruto === '') return { ok: false, valor: null };
  if (contrato.lista) {
    const publicados = (Array.isArray(bruto) ? bruto : [bruto]).map(normalize).filter(Boolean);
    // El renderizador recorta a los primeros `jsonLdTope`; sólo se exigen los
    // que efectivamente caben.
    const exigidos = esperado.slice(0, contrato.jsonLdTope || esperado.length).map(normalize);
    return { ok: exigidos.every(topic => publicados.includes(topic)), valor: publicados.join(' · ') };
  }
  return { ok: normalize(bruto) === normalize(esperado), valor: normalize(bruto) };
}

function visibleCoincide(field, contrato, esperado, rows) {
  const valor = rows.get(contrato.etiqueta);
  if (valor == null) return { ok: false, valor: null };
  if (contrato.lista) {
    const publicados = valor.split('·').map(normalize).filter(Boolean);
    return { ok: esperado.map(normalize).every(topic => publicados.includes(topic)), valor };
  }
  // Comparación por valor COMPLETO: 496 no puede aprobar dentro de 1496.
  return { ok: valor === normalize(esperado), valor };
}

export function schemaEsBook(schema) {
  const rawType = schema?.['@type'];
  const types = Array.isArray(rawType) ? rawType : [rawType].filter(Boolean);
  return types.includes('Book');
}

export function evaluate(html, esperado) {
  const schema = productSchema(html);
  const esBook = schemaEsBook(schema);
  const rows = detailRows(html);
  const comprobaciones = [];
  // Se conserva para poder revisar una falla sin volver a pedir la página.
  const schemaCrudo = schema
    ? Object.fromEntries(Object.entries(schema).filter(([key]) => (
        ['@type', 'numberOfPages', 'inLanguage', 'bookFormat', 'bookEdition', 'datePublished', 'keywords', 'publisher', 'author'].includes(key)
      )))
    : null;

  for (const [field, valorEsperado] of Object.entries(esperado || {})) {
    const contrato = FIELD_CONTRACT[field];
    if (!contrato) {
      comprobaciones.push({ campo: field, resultado: 'sin_contrato', ok: false });
      continue;
    }
    const esperadoNorm = contrato.lista
      ? (Array.isArray(valorEsperado) ? valorEsperado : [valorEsperado]).map(normalize).filter(Boolean)
      : normalize(valorEsperado);
    if (!esperadoNorm || (contrato.lista && esperadoNorm.length === 0)) continue;

    const visible = visibleCoincide(field, contrato, esperadoNorm, rows);
    const noAplicaPorTipo = SOLO_EN_BOOK.includes(field) && schema && !esBook;
    const jsonLd = noAplicaPorTipo || !contrato.jsonLd
      ? { ok: null, valor: null }
      : jsonLdCoincide(field, contrato, esperadoNorm, schema);

    comprobaciones.push({
      campo: field,
      esperado: contrato.lista ? esperadoNorm.join(' · ') : esperadoNorm,
      visible_encontrado: visible.valor,
      visible_ok: visible.ok,
      jsonld_encontrado: jsonLd.valor,
      // `null` = la propiedad no aplica a esta ficha; se dice por qué.
      jsonld_ok: jsonLd.ok,
      ...(noAplicaPorTipo
        ? { jsonld_no_aplica: 'la ficha se publica como Product, no como Book' }
        : {}),
      // Se exigen AMBAS donde ambas corresponden.
      ok: visible.ok && (jsonLd.ok === null || jsonLd.ok === true),
    });
  }

  return { tieneSchema: Boolean(schema), esBook, comprobaciones, schemaCrudo, filasVisibles: Object.fromEntries(rows) };
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
  const base = normalize(process.env.PREVIEW_BASE_URL).replace(/\/$/, '');
  const planPath = process.env.PREVIEW_PLAN;
  const outputPath = process.env.PREVIEW_OUTPUT || 'artifacts/preview/preview-ficha-validation.json';
  const deployedSha = normalize(process.env.PREVIEW_DEPLOYED_SHA) || null;
  if (!base || !planPath) throw new Error('Faltan PREVIEW_BASE_URL y PREVIEW_PLAN.');

  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const fichas = Array.isArray(plan.fichas) ? plan.fichas : [];

  const resultados = await mapWithConcurrency(fichas, 6, async ficha => {
    const url = `${base}/libro/${ficha.id}`;
    const base_row = { id: ficha.id, isbn: ficha.isbn, url, ganados: ficha.ganados };
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (response.status !== 200) {
        // Un 404 queda SIN VERIFICAR. No se le atribuye causa.
        return { ...base_row, status: response.status, estado: 'no_verificada', motivo: `HTTP ${response.status}` };
      }
      const html = await response.text();
      const { tieneSchema, comprobaciones, schemaCrudo, filasVisibles } = evaluate(html, ficha.esperado || {});
      // Ningún campo mejorado puede quedar sin comprobar.
      const sinComprobar = (ficha.ganados || []).filter(
        field => !comprobaciones.some(c => c.campo === field),
      );
      const fallidas = comprobaciones.filter(c => !c.ok);
      const ok = comprobaciones.length > 0 && fallidas.length === 0 && sinComprobar.length === 0;
      return {
        ...base_row, status: 200, tieneSchema, comprobaciones, sin_comprobar: sinComprobar,
        estado: ok ? 'verificada' : 'fallida',
        // Sólo para las fallidas: evidencia suficiente para diagnosticar sin
        // volver a pedir la página.
        ...(ok ? {} : { schema_crudo: schemaCrudo, filas_visibles: filasVisibles }),
      };
    } catch (error) {
      return { ...base_row, status: 0, estado: 'no_verificada', motivo: normalize(error?.message) || 'fetch falló' };
    }
  });

  const verificadas = resultados.filter(r => r.estado === 'verificada');
  const fallidas = resultados.filter(r => r.estado === 'fallida');
  const noVerificadas = resultados.filter(r => r.estado === 'no_verificada');

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    previewBaseUrl: base,
    previewDeployedSha: deployedSha,
    snapshot: plan.snapshot || null,
    totales: {
      fichas_esperadas: fichas.length,
      verificadas: verificadas.length,
      fallidas: fallidas.length,
      no_verificadas: noVerificadas.length,
      comprobaciones_totales: resultados.reduce((sum, r) => sum + (r.comprobaciones?.length || 0), 0),
    },
    fallidas,
    no_verificadas: noVerificadas.map(r => ({ id: r.id, isbn: r.isbn, status: r.status, motivo: r.motivo })),
    resultados,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== VALIDACIÓN DEL PREVIEW DESPLEGADO ===');
  console.log(JSON.stringify({ ...report, resultados: undefined, fallidas: fallidas.slice(0, 10) }, null, 2));
  if (fallidas.length || noVerificadas.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
