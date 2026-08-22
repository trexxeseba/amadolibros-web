/**
 * functions/api/tarot-finder-alternatives.js
 *
 * TAROT-FINDER-UX-2 (gate de performance post-Preview): el pool "por
 * encargo" (409 candidatos, ~186KB JSON) dejó de viajar embebido en el
 * HTML de /libros/esoterismo-tarot — medido, agregaba ~70% al HTML
 * comprimido de CADA visita, para una función que la gran mayoría no usa.
 * Este endpoint lo reemplaza: GET same-origin, sólo se llama cuando la
 * persona ya refinó, obtuvo 0 resultados exactos y tocó explícitamente
 * "Ver estas alternativas" (ver astro-front/public/tarot-finder.js).
 *
 * Contrato:
 *  - Sólo parámetros de enum ya conocidos (intent/system/deckFamily/
 *    language/guide) — nunca texto libre. Cualquier valor fuera de esos
 *    enums, parámetro desconocido o parámetro conocido repetido es 400;
 *    nunca se intenta interpretar ni elegir silenciosamente un valor.
 *  - Reutiliza buildTarotFinderDataset (status='paused') y
 *    findNearestTarotAlternatives — el mismo motor canónico que ya usa el
 *    Finder, nunca una copia paralela.
 *  - `system` nunca se relaja (ver tarot-finder-scoring.js) — un Oráculo
 *    jamás vuelve acá si se pidió Tarot.
 *  - Nunca precio/stock inventado — status='paused' siempre los deja null.
 *  - Máximo 3 candidatos. Nunca recibe ni guarda datos personales (los
 *    parámetros son enums fijos, no texto del usuario).
 *  - Respuesta cacheable en edge: la combinación de enums tiene
 *    cardinalidad chica y no depende de quién pregunta.
 */
import { fetchPausedIndex } from '../_shared/catalog.js';
import { bookCoverUrl } from '../_shared/cloudflare-images.js';
import { buildTagLookup } from '../_shared/tarot-hub-modules.js';
import { TAROT_MERCH_TAGS } from '../_shared/tarot-merch-tags.js';
import { buildTarotFinderDataset } from '../_shared/tarot-finder-dataset.js';
import { findNearestTarotAlternatives } from '../_shared/tarot-finder-scoring.js';
import { slugify } from '../_shared/slug.js';
import { BASE } from '../_shared/catalog.js';
import { fetchCategoryData } from '../libros/[[path]].js';

const TAROT_CATEGORY_ID = 'esoterismo-tarot';
const tarotTagLookup = buildTagLookup(TAROT_MERCH_TAGS);

// Único vocabulario aceptado — mismo que QUESTIONS/OPENING_OPTIONS en
// tarot-finder.js. Cualquier otro valor es un 400: este endpoint nunca
// intenta interpretar texto libre.
const VALID_PARAMS = {
    intent: new Set(['primer_mazo', 'estudiar', 'experiencia', 'regalo', 'coleccionista', 'sin_preferencia']),
    system: new Set(['tarot', 'oraculo', 'lenormand', 'kipper', 'unsure']),
    deckFamily: new Set(['rider_waite_smith', 'marsella', 'thoth', 'no_preference']),
    language: new Set(['espanol', 'ingles', 'multilingue', 'no_preference']),
    guide: new Set(['si', 'no_importante']),
};

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'X-Robots-Tag': 'noindex, nofollow',
            ...extraHeaders,
        },
    });
}

/**
 * Valida y arma `answers` desde la query string. Cualquier parámetro
 * presente que no matchee su enum, o cualquier parámetro conocido repetido,
 * es un error explícito — nunca se ignora ni se elige uno en silencio.
 */
function parseAnswers(searchParams) {
    const answers = {};
    for (const key of Object.keys(VALID_PARAMS)) {
        const values = searchParams.getAll(key);
        if (values.length === 0) continue;
        if (values.length > 1) {
            return { error: `Parámetro repetido: ${key}` };
        }
        const [value] = values;
        if (!VALID_PARAMS[key].has(value)) {
            return { error: `Parámetro inválido: ${key}` };
        }
        answers[key] = value;
    }
    // Ningún otro parámetro está permitido — ni siquiera si coincidiera
    // por casualidad con un enum de otro campo.
    for (const key of searchParams.keys()) {
        if (!(key in VALID_PARAMS)) return { error: `Parámetro no reconocido: ${key}` };
    }
    return { answers };
}

export async function onRequest(context) {
    const { request } = context;
    if (request.method !== 'GET') {
        return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
    }

    const url = new URL(request.url);
    const parsed = parseAnswers(url.searchParams);
    if (parsed.error) {
        return json({ error: parsed.error }, 400);
    }
    const { answers } = parsed;

    // Fail-open a nivel de infraestructura: si el catálogo no responde,
    // el Finder no debe romperse — el cliente ya conserva sus alternativas
    // activas y WhatsApp como salida. Sólo un 400 real (arriba) es un
    // error del llamador; esto de acá es "no hay nada que ofrecer ahora".
    try {
        const categoryData = await fetchCategoryData(context);
        if (!categoryData) return json({ candidates: [] }, 200, { 'Cache-Control': 'no-store' });

        const pausedIndex = await fetchPausedIndex(context);
        const pausedItems = Array.isArray(pausedIndex?.items) ? pausedIndex.items : [];
        const pausedCategoryItems = pausedItems.filter(item =>
            (categoryData.items[item.id] || [])[0] === TAROT_CATEGORY_ID
        );

        const isPreview = context.env?.APP_ENV === 'preview';
        const navigationBase = isPreview ? url.origin : BASE;
        const pausedDataset = buildTarotFinderDataset({
            items: pausedCategoryItems,
            tagLookup: tarotTagLookup,
            imageForId: id => bookCoverUrl(id),
            hrefForItem: it => `${navigationBase}/libro/${it.id}/${slugify(it.title)}`,
            status: 'paused',
        });

        const alternatives = findNearestTarotAlternatives(pausedDataset, answers, { limit: 3 });
        const candidates = alternatives.map(({ candidate }) => candidate);

        // Cardinalidad chica (enums fijos, no texto de usuario) y ningún
        // dato personal — cacheable en edge sin riesgo de mezclar
        // respuestas de personas distintas.
        return json({ candidates }, 200, { 'Cache-Control': 'public, max-age=300' });
    } catch {
        return json({ candidates: [] }, 200, { 'Cache-Control': 'no-store' });
    }
}
