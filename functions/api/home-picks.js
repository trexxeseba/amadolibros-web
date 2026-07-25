/**
 * functions/api/home-picks.js
 *
 * Selección de portada ("Incorporaciones recientes") calculada en cada
 * request contra el catálogo real de R2 — nunca depende de un deploy.
 * Reutiliza fetchCatalog() (mismo cache de 1h que /catalogo y las fichas).
 *
 * Reglas de selección — idénticas a las que existían antes en build-time
 * (BestsellerSection.astro), movidas acá sin cambiar su comportamiento:
 *   - status === 'active' && available_quantity > 0 (único criterio de
 *     "comprable"; si el ítem no cumple esto, o no está en el catálogo
 *     actual, directamente no llega a la respuesta)
 *   - excluye objetos antiguos que no son libros (heurística por título)
 *   - deduplica por autor+precio (o título+precio si no hay autor)
 *   - ordena por start_time descendente
 *   - máximo 8 resultados
 *
 * Si el catálogo no se puede leer (R2 caído, JSON inválido, etc.),
 * responde { ok:false, items:[] } — el cliente debe ocultar la sección,
 * nunca mostrar datos viejos como si fueran vigentes.
 */

import { fetchCatalog } from '../_shared/catalog.js';

const MAX_ITEMS = 8;

const ANTIQUE_SIGNALS = [
  'cruz', 'crucifijo', 'bronce', 'chapa esmaltada', 'cartel chapa',
  'dije', 'plata 925', 'jaspe', 'colgante vintage', 'sacapuntas vintage',
  'candelabro', 'figura bronce', 'figuras bronce',
  'decorativo', 'decorativa',
  'pared cristo', 'cristo inri', 'inri antigua',
  'jeringa',
  'veterinaria vidrio',
  'volante cine',
  'antiguo matrimonio',
  'antigua veterinaria',
  'pieza antigua',
  'objeto antiguo',
];

function isAntiqueObject(b) {
  if (b.author && String(b.author).trim()) return false;
  const t = String(b.title || '').toLowerCase();
  return ANTIQUE_SIGNALS.some(s => t.includes(s));
}

function normalize(v) {
  return String(v || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickFields(b) {
  return {
    id: b.id,
    title: b.title,
    author: b.author ?? null,
    price: b.price,
    status: b.status,
    available_quantity: b.available_quantity,
    thumbnail: b.thumbnail ?? null,
    pictures: Array.isArray(b.pictures) ? b.pictures.slice(0, 1) : [],
    start_time: b.start_time ?? null,
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...extraHeaders },
  });
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Método no permitido.' }, 405, { Allow: 'GET' });
  }

  const catalog = await fetchCatalog(context);
  const items = (catalog && Array.isArray(catalog.items)) ? catalog.items : null;

  if (!items) {
    return json({ ok: false, items: [] }, 200, { 'Cache-Control': 'no-store' });
  }

  const comprables = items.filter(
    b => b && b.status === 'active' && Number(b.available_quantity) > 0 && !isAntiqueObject(b)
  );

  comprables.sort((a, b) => {
    const ta = a.start_time ? new Date(a.start_time).getTime() : 0;
    const tb = b.start_time ? new Date(b.start_time).getTime() : 0;
    return tb - ta;
  });

  const seen = new Set();
  const deduped = comprables.filter(b => {
    const authorKey = normalize(b.author);
    const identityKey = authorKey || normalize(b.title).slice(0, 60);
    const key = `${identityKey}|${Number(b.price || 0)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const picks = deduped.slice(0, MAX_ITEMS).map(pickFields);

  return json({ ok: true, items: picks }, 200, { 'Cache-Control': 'public, max-age=300' });
}
