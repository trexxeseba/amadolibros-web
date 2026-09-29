/**
 * Reglas de salud compartidas entre el informe diario por correo
 * (scripts/ops/*) y la sección «Salud» del panel privado.
 *
 * Viven acá, en `_shared`, por la misma razón por la que el contador de
 * fichas del panel usa la misma función que arma el feed: si el correo y el
 * panel calcularan "el sync está viejo" cada uno por su lado, el día que
 * cambie el umbral tendríamos dos verdades distintas y nadie sabría cuál
 * creer. Una sola regla, dos consumidores.
 *
 * Todo lo de este archivo es puro: no hace fetch, no lee KV, no toca D1.
 */

// El cron del Worker corre una vez por día (07:15 UTC). 26 horas deja margen
// para un arranque demorado sin dejar pasar un día entero sin publicar; es el
// mismo umbral que usa /api/status para su propio `sync_fresh`.
const DEFAULT_MAX_AGE_HOURS = 26;
// Un sync que empezó hace más de 45 minutos y no terminó quedó trabado.
// Mismo valor que STUCK_MS en /api/status.
const STUCK_MS = 45 * 60 * 1000;

function asText(value) {
  return String(value ?? '').trim();
}

/**
 * Convierte las tres claves de KV que escribe el Worker en el mismo objeto
 * `worker` que devuelve /api/status. Lo consume el panel, que tiene el binding
 * de KV y no necesita pasar por HTTP para saber cómo está el sync.
 *
 * Replica a propósito las dos reglas de /api/status (in_progress y
 * possibly_stuck) en vez de importarlas: ese handler las tiene inline y
 * tocarlo para extraerlas es un cambio en la API pública que no corresponde
 * a este lote. Si alguna vez divergen, este comentario es el lugar donde
 * mirar primero.
 */
export function deriveSyncWorkerState({ lastStarted, lastOk, lastError } = {}, now = new Date()) {
  const lastOkMs = Date.parse(asText(lastOk));
  const startedMs = Date.parse(asText(lastStarted));
  const okValid = Number.isFinite(lastOkMs);
  const startedValid = Number.isFinite(startedMs);
  const in_progress = startedValid && (!okValid || startedMs > lastOkMs);
  const possibly_stuck = in_progress && (now.getTime() - startedMs) > STUCK_MS;

  return {
    last_started: asText(lastStarted) || null,
    last_ok: asText(lastOk) || null,
    has_error: Boolean(asText(lastError)),
    in_progress,
    possibly_stuck,
  };
}

/**
 * Veredicto sobre el cuerpo de /api/status (o sobre un objeto con la misma
 * forma). No reimplementa el `healthy` del endpoint: lo complementa con una
 * comprobación de edad propia para que la falla diga cuántas horas hace que
 * no publica, en vez de un "degraded" pelado.
 */
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

/**
 * Los reportes automáticos que importan. Son pocos a propósito: hay 167
 * workflows en el repo y 73 son sondas temporales; si se vigilaran todos, el
 * ruido taparía la señal y nadie volvería a leer el aviso.
 *
 * `maxDias: null` significa "no mirar la antigüedad": deploy.yml corre cuando
 * hay un push y pasar una semana sin publicar no es una falla.
 * `rama` filtra a main donde el workflow también corre en PRs, para no leer
 * como "última corrida" la de una rama cualquiera.
 */
export const WORKFLOWS_VIGILADOS = [
  { archivo: 'deploy.yml', nombre: 'Deploy a producción', maxDias: null, rama: 'main' },
  { archivo: 'sync-freshness.yml', nombre: 'Frescura del sync', maxDias: 2, rama: 'main' },
  { archivo: 'checkout-funnel-report.yml', nombre: 'Embudo de checkout', maxDias: 2, rama: 'main' },
  { archivo: 'gsc-inspection-rotation.yml', nombre: 'Indexación en Google', maxDias: 2, rama: 'main' },
  { archivo: 'full-commerce-audit.yml', nombre: 'Auditoría comercial', maxDias: 9, rama: 'main' },
  { archivo: 'gsc-export.yml', nombre: 'Tráfico de búsqueda', maxDias: 9, rama: 'main' },
  { archivo: 'bing-webmaster-report.yml', nombre: 'Bing Webmaster', maxDias: 9, rama: 'main' },
];

function dias(desdeIso, now) {
  const ms = Date.parse(asText(desdeIso));
  if (!Number.isFinite(ms)) return null;
  return Math.round(((now.getTime() - ms) / 86_400_000) * 10) / 10;
}

/**
 * Convierte la última corrida de cada workflow en un veredicto legible.
 * `corridas` es un mapa archivo → { ok: true, corrida } | { ok: false, error }.
 *
 * Avisa por dos motivos distintos, porque son dos fallas distintas: que la
 * última corrida haya fallado, o que hace demasiado que no corre. Lo segundo
 * es el modo de fallar más fácil de no notar: una tarea programada que dejó
 * de dispararse no falla, simplemente desaparece.
 */
export function evaluarWorkflows(corridas, { now = new Date(), vigilados = WORKFLOWS_VIGILADOS } = {}) {
  const filas = [];
  const problemas = [];
  const sinConsultar = [];

  for (const wf of vigilados) {
    const lectura = corridas?.[wf.archivo] ?? null;

    // «No pude preguntar» y «nunca corrió» son cosas distintas y hay que
    // decirlas distinto. Confundirlas convierte un corte de red momentáneo en
    // siete avisos de que tus reportes están muertos — y un aviso que grita en
    // falso una vez es un aviso que no se lee nunca más.
    if (lectura && lectura.ok === false) {
      filas.push({ nombre: wf.nombre, estado: 'no se pudo consultar', dias: null, ok: false, url: null });
      sinConsultar.push(wf.nombre);
      continue;
    }

    const corrida = lectura?.corrida ?? null;

    if (!corrida) {
      filas.push({ nombre: wf.nombre, estado: 'sin corridas', dias: null, ok: false, url: null });
      problemas.push(`«${wf.nombre}» no tiene ninguna corrida registrada.`);
      continue;
    }

    const conclusion = asText(corrida.conclusion) || 'sin conclusión';
    const antiguedad = dias(corrida.created_at, now);
    // `skipped` y `cancelled` no son fallas: no se avisa por ellas, pero
    // tampoco cuentan como verde, así que se muestran tal cual.
    const fallo = conclusion === 'failure' || conclusion === 'timed_out';
    const viejo = wf.maxDias != null && antiguedad != null && antiguedad > wf.maxDias;

    if (fallo) problemas.push(`«${wf.nombre}» falló en su última corrida (hace ${antiguedad} días).`);
    if (viejo) problemas.push(`«${wf.nombre}» no corre hace ${antiguedad} días (máximo esperado: ${wf.maxDias}).`);

    filas.push({
      nombre: wf.nombre,
      estado: conclusion,
      dias: antiguedad,
      ok: !fallo && !viejo,
      url: asText(corrida.html_url) || null,
    });
  }

  // Si no se pudo consultar ninguno, el problema es uno solo —la API no
  // respondió— y no uno por reporte. Un correo con siete avisos que en
  // realidad son el mismo hecho es ruido.
  if (sinConsultar.length && sinConsultar.length === vigilados.length) {
    problemas.push('No se pudo consultar la API de GitHub: esta vez no hay datos de ningún reporte automático.');
  } else {
    for (const nombre of sinConsultar) {
      problemas.push(`No se pudo consultar el estado de «${nombre}».`);
    }
  }

  return { filas, problemas, sinConsultar };
}
