/**
 * worker-sync/radar.js
 *
 * RADAR AMADO — motor de alertas operativas (PR1).
 *
 * Lógica pura, sin I/O: recibe catálogo (activos + pausados) y conteos de
 * stock_waitlist ya resueltos, y devuelve una lista de alertas explicables.
 * La persistencia idempotente en D1 vive en radar-store.js.
 *
 * Alcance de este PR (ver ticket RADAR AMADO — PR1):
 *   REPOSICION_URGENTE, AGOTADO, PUBLICACION_PAUSADA, CORREGIR_ISBN,
 *   CLIENTES_ESPERANDO.
 * Explícitamente fuera de alcance hasta tener sus fuentes reales:
 *   ventas recientes, velocidad de venta, margen, precio de competencia,
 *   preguntas pendientes, cambios de precio.
 */

export const REPLENISHMENT_SCORE_VERSION = 'replenishment_score_v1';

// Umbral de "queda poco": 1 o 2 unidades ya amerita alerta de reposición.
export const LOW_STOCK_THRESHOLD = 2;
// A partir de 3 personas esperando, la señal de demanda se considera alta.
export const HIGH_WAITLIST_THRESHOLD = 3;

/**
 * replenishment_score_v1 — score explicable de 0 a 100.
 *
 * Usa únicamente datos disponibles en este PR: available_quantity,
 * cantidad de personas en stock_waitlist, y estado activo/pausado de la
 * publicación. El ISBN faltante suma una penalización pequeña sólo cuando
 * el ítem ya es candidato a reposición (afecta identificar la edición
 * exacta a recomprar) — nunca genera una alerta de reposición por sí solo.
 *
 * V2 (futuro, ticket aprobado): incorporará ventas reales de Mercado Libre
 * vía GET /orders/search?seller=... para sumar velocidad de venta y días de
 * stock estimados. Hasta entonces no se inventa ese dato.
 */
export function computeReplenishmentScoreV1({
  availableQuantity,
  waitlistCount = 0,
  status,
  isbnPresent = true,
} = {}) {
  const qty = Number(availableQuantity) || 0;
  const waiting = Math.max(0, Number(waitlistCount) || 0);
  const reasons = [];
  let score = 0;

  if (qty <= 0) {
    score += 50;
    reasons.push('Sin stock disponible.');
  } else if (qty === 1) {
    score += 40;
    reasons.push('Queda 1 unidad.');
  } else if (qty <= LOW_STOCK_THRESHOLD) {
    score += 25;
    reasons.push(`Quedan ${qty} unidades.`);
  }

  if (waiting > 0) {
    score += Math.min(waiting, 5) * 10;
    reasons.push(waiting === 1 ? 'Hay 1 cliente esperando.' : `Hay ${waiting} clientes esperando.`);
  }

  if (status === 'paused') {
    // Una publicación pausada no vende hoy, así que la urgencia de comprar
    // más baja frente a la misma situación en una publicación activa — pero
    // no desaparece: sigue habiendo demanda real esperando.
    score = Math.round(score * 0.7);
    reasons.push('Publicación pausada: conviene reponer igual antes de reactivarla.');
  }

  if (!isbnPresent) {
    score += 5;
    reasons.push('Sin ISBN: confirmar la edición exacta antes de reponer.');
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function severityFromScore(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function buildAlert({ type, item, severity, score = null, reasons, metrics }) {
  return {
    alert_type: type,
    item_id: item.id,
    isbn: item.isbn || null,
    title: item.title || item.id,
    severity,
    score,
    score_version: score == null ? null : REPLENISHMENT_SCORE_VERSION,
    reasons,
    metrics,
  };
}

/**
 * Calcula todas las alertas vigentes a partir del catálogo y de la demanda
 * en espera. No escribe nada — devuelve un array plano, listo para
 * persistir de forma idempotente (ver radar-store.js).
 *
 * @param {object} params
 * @param {Array}  params.activeItems     — items del catálogo público (status active)
 * @param {Array}  params.pausedItems     — items pausados (fetch liviano dedicado)
 * @param {Map}    params.waitlistCounts  — Map<product_id, cantidad esperando>
 */
export function buildRadarAlerts({
  activeItems = [],
  pausedItems = [],
  waitlistCounts = new Map(),
} = {}) {
  const alerts = [];
  const entries = [
    ...activeItems.map(item => ({ item, status: 'active' })),
    ...pausedItems.map(item => ({ item, status: 'paused' })),
  ];

  for (const { item, status } of entries) {
    if (!item?.id) continue;
    const qty = Number(item.available_quantity) || 0;
    const waiting = Number(waitlistCounts.get(item.id)) || 0;
    const isbnPresent = Boolean(item.isbn);

    const isActiveOutOfStock = status === 'active' && qty <= 0;
    const isActiveLowStock = status === 'active' && qty >= 1 && qty <= LOW_STOCK_THRESHOLD;
    const isPausedWithDemand = status === 'paused' && waiting > 0;

    if (isActiveOutOfStock || isActiveLowStock || isPausedWithDemand) {
      const { score, reasons } = computeReplenishmentScoreV1({
        availableQuantity: qty,
        waitlistCount: waiting,
        status,
        isbnPresent,
      });
      alerts.push(buildAlert({
        type: isActiveOutOfStock ? 'AGOTADO' : 'REPOSICION_URGENTE',
        item,
        severity: severityFromScore(score),
        score,
        reasons,
        metrics: { available_quantity: qty, waitlist_count: waiting, status, isbn_present: isbnPresent },
      }));
    }

    if (status === 'paused') {
      alerts.push(buildAlert({
        type: 'PUBLICACION_PAUSADA',
        item,
        severity: waiting > 0 ? 'high' : 'medium',
        reasons: ['Publicación pausada.'],
        metrics: { available_quantity: qty, waitlist_count: waiting },
      }));
    }

    if (status === 'active' && !isbnPresent) {
      alerts.push(buildAlert({
        type: 'CORREGIR_ISBN',
        item,
        severity: qty >= 1 && qty <= LOW_STOCK_THRESHOLD ? 'medium' : 'low',
        reasons: ['ISBN faltante.'],
        metrics: { available_quantity: qty },
      }));
    }

    if (waiting > 0) {
      alerts.push(buildAlert({
        type: 'CLIENTES_ESPERANDO',
        item,
        severity: waiting >= HIGH_WAITLIST_THRESHOLD ? 'high' : 'medium',
        reasons: [waiting === 1 ? 'Hay 1 cliente esperando.' : `Hay ${waiting} clientes esperando.`],
        metrics: { waitlist_count: waiting, available_quantity: qty, status },
      }));
    }
  }

  return alerts;
}
