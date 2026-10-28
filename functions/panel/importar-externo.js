// /panel/importar-externo — cargar un CSV de Nubimetrics, Administrado u otra
// fuente con su contrato auditable (original, hash, fuente, mercado, vendedor,
// extracción, período, completitud, mapeo y trazabilidad por fila). Sólo
// guarda en D1; no crea datos ficticios ni toca precios. Sesión + producción.
import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { importarExterno, listImports, PLANTILLAS, FUENTES, TIPOS, COMPLETITUD } from '../../worker-sync/importacion-externa.js';

const ORIGIN = 'https://www.amadolibros.com';
const MAX_BYTES = 950 * 1024;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = ms => ms ? new Date(Number(ms)).toISOString().slice(0, 10).split('-').reverse().join('/') : '—';

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Importar fuente externa</title>
<style>body{font:15px system-ui;margin:0;padding:16px;line-height:1.45;color:#222;background:#faf8f4}main{max-width:1100px;margin:0 auto}h1{margin:.2em 0}h2{font-size:18px;margin:24px 0 8px}
.card{background:#fff;border:1px solid #e6e0d6;border-radius:10px;padding:14px 16px;margin:12px 0}.muted{color:#777;font-size:13px}a{color:#a94e3d}label{display:block;margin:8px 0 2px;font-size:13px;color:#555}
input[type=text],input[type=date],select,textarea{font:inherit;padding:6px;border:1px solid #ccc;border-radius:6px;width:100%;box-sizing:border-box}textarea{min-height:180px;font-family:ui-monospace,monospace;font-size:13px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #a94e3d;background:#a94e3d;color:#fff;cursor:pointer;margin-top:10px}
.ok{background:#e7f5ea;color:#1b6b30;padding:8px 12px;border-radius:8px}.err{background:#fde8e4;color:#9a2b18;padding:8px 12px;border-radius:8px}.warn{background:#fff4d6;color:#8a5a00;padding:8px 12px;border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#666}code{font-size:12px}</style>
<main><p><a href="/panel">← Panel</a> · <a href="/panel/oportunidades">Oportunidades</a></p>${body}</main></html>`, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

const opt = (list, sel, label = v => v) => list.map(v => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label(v))}</option>`).join('');

function form(v = {}) {
  const plantillas = ['', ...Object.keys(PLANTILLAS)];
  return `<div class="card"><form method="post" action="/panel/importar-externo">
  <div class="row">
    <div><label>Plantilla (mapeo de columnas)</label><select name="plantilla">${opt(plantillas, v.plantilla ?? '', p => p ? `${p}${PLANTILLAS[p].verificado ? '' : ' (no verificada)'}` : 'Sin plantilla: mapeo manual')}</select></div>
    <div><label>Fuente</label><select name="fuente">${opt(FUENTES, v.fuente ?? 'administrado')}</select></div>
    <div><label>Tipo</label><select name="tipo">${opt(TIPOS, v.tipo ?? 'competidores_ventas')}</select></div>
    <div><label>Completitud declarada</label><select name="completitud">${opt(COMPLETITUD, v.completitud ?? 'desconocida')}</select></div>
    <div><label>Vendedor / cuenta analizada (si aplica)</label><input type="text" name="vendedor" value="${esc(v.vendedor ?? '')}" maxlength="80"></div>
    <div><label>Fecha de extracción</label><input type="date" name="extraccion" value="${esc(v.extraccion ?? '')}"></div>
    <div><label>Período desde</label><input type="date" name="periodo_desde" value="${esc(v.periodo_desde ?? '')}"></div>
    <div><label>Período hasta</label><input type="date" name="periodo_hasta" value="${esc(v.periodo_hasta ?? '')}"></div>
    <div><label>Nombre del archivo original</label><input type="text" name="nombre_archivo" value="${esc(v.nombre_archivo ?? '')}" maxlength="160"></div>
    <div><label>Ventana en días de "vendidas" (si no la trae la plantilla)</label><input type="text" name="ventana_dias" value="${esc(v.ventana_dias ?? '')}" maxlength="4"></div>
  </div>
  <label>Mapeo manual (JSON, sólo sin plantilla): <code>{"columnas":{"isbn":"GTIN","titulo":"Título","vendedor":"Competidor","precio":"Precio","vendidas":"Vendidas 7d"}}</code></label><input type="text" name="mapeo" value="${esc(v.mapeo ?? '')}" maxlength="2000">
  <label>CSV (pegá el contenido; XLSX: guardalo como CSV primero)</label><textarea name="csv" required spellcheck="false">${esc(v.csv ?? '')}</textarea>
  <label>Nota</label><input type="text" name="nota" value="${esc(v.nota ?? '')}" maxlength="300">
  <button type="submit">Importar</button></form>
  <p class="muted">Se guarda el original con su hash: el mismo archivo dos veces no se carga dos veces. Cada fila queda con su número y su línea cruda. Las cifras externas se etiquetan "estimado" salvo que la fuente diga lo contrario, y nunca se suman entre fuentes ni entre ventanas.</p></div>`;
}

function importsTable(list) {
  if (!list.length) return '<p class="muted">Todavía no hay cargas.</p>';
  return `<div class="card"><table><thead><tr><th>Cargado</th><th>Fuente · tipo</th><th>Vendedor</th><th>Extracción · período</th><th>Filas</th><th>Completitud</th><th>Archivo</th><th>Hash</th></tr></thead><tbody>${list.map(i => `<tr><td>${esc(day(i.created_at))}</td><td>${esc(i.fuente)} · ${esc(i.tipo)}${i.plantilla ? `<br><small class="muted">${esc(i.plantilla)}</small>` : ''}</td><td>${esc(i.vendedor ?? '—')}</td><td>${esc(i.extraccion ?? '—')}<br><small class="muted">${esc(i.periodo_desde ?? '—')} → ${esc(i.periodo_hasta ?? '—')}${i.ventana_dias ? ` · ${i.ventana_dias} d` : ''}</small></td><td>${i.filas_validas} válidas · ${i.filas_invalidas} inválidas · ${i.filas_duplicadas} dup.</td><td>${esc(i.completitud)}</td><td>${esc(i.nombre_archivo ?? '—')}</td><td><code>${esc(String(i.id).slice(0, 12))}</code></td></tr>`).join('')}</tbody></table></div>`;
}

function resultHtml(r) {
  if (r.duplicado) return `<p class="warn">Ese archivo ya estaba cargado (hash <code>${esc(r.import_id.slice(0, 12))}</code>, ${r.filas_validas} filas válidas, el ${esc(day(r.cargado_en))}). No se cargó de nuevo.</p>`;
  return `<p class="ok">Importado <code>${esc(r.import_id.slice(0, 12))}</code>: ${r.filas_validas} filas válidas, ${r.filas_invalidas} inválidas, ${r.filas_duplicadas} duplicadas dentro del archivo (delimitador "${esc(r.delimitador === '\t' ? 'tab' : r.delimitador)}"). Columnas usadas: ${esc(Object.entries(r.columnas).map(([k, v]) => `${k} ← ${v}`).join(', '))}.</p>${r.advertencia ? `<p class="warn">${esc(r.advertencia)}</p>` : ''}`;
}

export function createImportarExternoPanel({ importer = importarExterno, now = Date.now } = {}) {
  return async ({ request, env }) => {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || env.APP_ENV !== 'production') return page('<p>No disponible.</p>', 403);
    const config = resolvePanelConfig(env);
    if (!config.ok || !await hasValidSession(request, await deriveSessionSecret(config.password))) return Response.redirect(`${ORIGIN}/panel`, 303);
    if (!env.ORDERS_DB) return page('<p>Sin base de datos en este entorno.</p>', 503);
    const recent = async () => importsTable(await listImports(env.ORDERS_DB, 20).catch(() => []));
    if (request.method === 'GET') return page(`<h1>Importar fuente externa</h1>${form()}<h2>Cargas anteriores</h2>${await recent()}`);
    if (request.method !== 'POST') return page('<p>Método no permitido.</p>', 405);
    if (request.headers.get('origin') !== ORIGIN) return page('<p class="err">Origen no válido.</p>', 403);
    if (Number(request.headers.get('content-length')) > MAX_BYTES) return page('<p class="err">El CSV supera 900 KB. Partilo en lotes.</p>', 413);
    const f = await request.formData();
    const v = Object.fromEntries(['plantilla', 'fuente', 'tipo', 'completitud', 'vendedor', 'extraccion', 'periodo_desde', 'periodo_hasta', 'nombre_archivo', 'ventana_dias', 'mapeo', 'csv', 'nota'].map(k => [k, String(f.get(k) ?? '').trim()]));
    let mapeo = null;
    if (v.mapeo) { try { mapeo = JSON.parse(v.mapeo); } catch { return page(`<h1>Importar fuente externa</h1><p class="err">El mapeo no es JSON válido.</p>${form(v)}`, 400); } }
    const input = { plantilla: v.plantilla || undefined, fuente: v.fuente, tipo: v.tipo, completitud: v.completitud, vendedor: v.vendedor || null, extraccion: v.extraccion || null, periodo_desde: v.periodo_desde || null, periodo_hasta: v.periodo_hasta || null,
      nombre_archivo: v.nombre_archivo || null, ventana_dias: v.ventana_dias ? Number(v.ventana_dias) : undefined, mapeo: mapeo ?? undefined, csv: v.csv, nota: v.nota || null };
    try {
      const r = await importer(env.ORDERS_DB, input, now());
      return page(`<h1>Importar fuente externa</h1>${resultHtml(r)}${form()}<h2>Cargas anteriores</h2>${await recent()}`);
    } catch (error) {
      const detail = error?.detail ? `<br><small>${esc(JSON.stringify(error.detail))}</small>` : '';
      return page(`<h1>Importar fuente externa</h1><p class="err">No se pudo importar: <code>${esc(error?.code || 'internal_error')}</code>${detail}</p>${form(v)}`, error?.status || 500);
    }
  };
}

export const onRequest = createImportarExternoPanel();
