/**
 * ¿El sync de catálogo publicó hoy?
 *
 * El estado vive en KV (`sync:last_ok`, `sync:last_error`) y KV no se puede
 * leer desde afuera de Cloudflare. Por eso la pregunta "¿el cron corrió?"
 * venía quedando sin respuesta cada vez que alguien la hacía desde una sesión
 * sin acceso a producción: el dato existía y no había forma de mirarlo.
 *
 * `/api/status` ya expone ese estado y ya calcula su propio veredicto. Este
 * script no reimplementa esas reglas —si lo hiciera, el día que cambien
 * tendríamos dos verdades distintas—: le pide el veredicto al endpoint y sólo
 * agrega una comprobación de edad propia, para que el mensaje de falla diga
 * cuántas horas hace que no publica en vez de un "degraded" pelado.
 *
 * Solo lectura: un GET. No dispara syncs, no escribe KV, no despliega.
 */

const DEFAULT_STATUS_URL = 'https://www.amadolibros.com/api/status';
// El cron del Worker corre una vez por día (07:15 UTC). 26 horas deja margen
// para un arranque demorado sin dejar pasar un día entero sin publicar; es el
// mismo umbral que usa /api/status para su propio `sync_fresh`.
const DEFAULT_MAX_AGE_HOURS = 26;

function asText(value) {
  return String(value ?? '').trim();
}

export function evaluateSyncStatus(body, { maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = new Date() } = {}) {
  const problemas = [];
  const notas = [];

  const worker = body?.worker || {};
  const catalog = body?.catalog || {};

  const lastOk = asText(worker.last_ok);
  const lastOkMs = lastOk ? Date.parse(lastOk) : NaN;
  const edadHoras = Number.isFinite(lastOkMs)
    ? Math.round(((now.getTime() - lastOkMs) / 3_600_000) * 10) / 10
    : null;

  if (!lastOk) {
    problemas.push('El Worker nunca registró un sync exitoso (sync:last_ok vacío).');
  } else if (!Number.isFinite(lastOkMs)) {
    problemas.push(`sync:last_ok no es una fecha legible: ${lastOk}`);
  } else if (edadHoras > maxAgeHours) {
    problemas.push(`El último sync exitoso fue hace ${edadHoras} h, más que el máximo de ${maxAgeHours} h.`);
  }

  if (worker.has_error === true) {
    problemas.push('El Worker dejó registrado un error en el último sync (sync:last_error presente).');
  }
  if (worker.possibly_stuck === true) {
    problemas.push('Hay un sync empezado que no terminó: quedó trabado.');
  }
  if (catalog.available === false) {
    problemas.push('catalog.json no está disponible en R2.');
  }
  if (catalog.meta_available === false) {
    problemas.push('meta.json no está disponible en R2.');
  }

  // `in_progress` sin `possibly_stuck` es un sync corriendo ahora mismo: no es
  // una falla, pero conviene decirlo para que nadie lea mal una edad alta.
  if (worker.in_progress === true && worker.possibly_stuck !== true) {
    notas.push('Hay un sync en curso en este momento.');
  }
  if (Array.isArray(body?.warnings) && body.warnings.length) {
    notas.push(`Avisos del endpoint: ${body.warnings.join(', ')}`);
  }

  return {
    ok: problemas.length === 0,
    edadHoras,
    lastOk: lastOk || null,
    totalItems: catalog.total_items ?? null,
    estadoDeclarado: asText(body?.status) || null,
    saludDeclarada: body?.healthy === true,
    problemas,
    notas,
  };
}

export function buildSummary(veredicto, url) {
  const lineas = [
    '## Frescura del sync de catálogo',
    '',
    `- Fuente: ${url}`,
    `- Último sync exitoso: ${veredicto.lastOk || '—'}`,
    `- Antigüedad: ${veredicto.edadHoras == null ? '—' : `${veredicto.edadHoras} h`}`,
    `- Ítems en el catálogo: ${veredicto.totalItems ?? '—'}`,
    `- Veredicto del endpoint: ${veredicto.estadoDeclarado || '—'}`,
    '',
  ];

  if (veredicto.ok) {
    lineas.push('**El sync publicó dentro de plazo.**');
  } else {
    lineas.push('**El sync NO está publicando como debería:**', '');
    for (const problema of veredicto.problemas) lineas.push(`- ${problema}`);
  }
  if (veredicto.notas.length) {
    lineas.push('', 'Contexto:');
    for (const nota of veredicto.notas) lineas.push(`- ${nota}`);
  }
  return `${lineas.join('\n')}\n`;
}

export async function main() {
  const url = asText(process.env.SYNC_STATUS_URL) || DEFAULT_STATUS_URL;
  const maxAgeHours = Number(process.env.SYNC_MAX_AGE_HOURS) > 0
    ? Number(process.env.SYNC_MAX_AGE_HOURS)
    : DEFAULT_MAX_AGE_HOURS;

  let body = null;
  let httpStatus = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    httpStatus = response.status;
    body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // No alcanzar el endpoint es en sí mismo una falla que hay que ver: sin
    // esto, una caída del sitio se leería como "no hay noticias".
    const detalle = asText(error?.message) || 'error desconocido';
    const texto = `## Frescura del sync de catálogo\n\n**No se pudo leer ${url}** (${detalle}${httpStatus ? `, HTTP ${httpStatus}` : ''}).\n`;
    process.stdout.write(texto);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto);
    }
    process.exitCode = 1;
    return;
  }

  const veredicto = evaluateSyncStatus(body, { maxAgeHours });
  const texto = buildSummary(veredicto, url);
  process.stdout.write(texto);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto);
  }
  if (!veredicto.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
