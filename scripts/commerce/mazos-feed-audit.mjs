#!/usr/bin/env node
/**
 * Auditoría de SOLO LECTURA: ¿qué mazos de tarot, oráculos, cartas y barajas del
 * catálogo entran hoy al feed de Merchant Center, y por qué los otros no?
 *
 * Usa las MISMAS funciones que arman el feed (isEligibleForFeed / isBookProduct),
 * así que el resultado es lo que Merchant recibe de verdad, no una estimación.
 * No escribe nada, no llama a Merchant ni a Mercado Libre: solo lee el catálogo
 * público y cuenta.
 *
 *   node scripts/commerce/mazos-feed-audit.mjs [--catalogo catalog.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isEligibleForFeed, isBookProduct, normalizeIsbnToGtin } from '../../functions/feed.xml.js';
import { TAROT_MERCH_TAGS } from '../../functions/_shared/tarot-merch-tags.js';

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';

// Palabras que usa quien busca estos productos. Solo sirve para encontrar candidatos:
// lo que decide es la regla real del feed.
export const MAZO_WORDS = /\b(tarot|tarots|or[aá]culos?|lenormand|kipper|mazo|mazos|baraja|barajas|cartas)\b/i;

export function esCandidato(item, tagIds = new Set()) {
    return tagIds.has(String(item?.id)) || MAZO_WORDS.test(String(item?.title || ''));
}

/** Por qué un candidato activo y vendible no entra al feed. */
export function motivo(item) {
    if (!item?.permalink) return 'sin enlace';
    if (!(Number(item.available_quantity) > 0)) return 'sin stock';
    if (!(Number(item.price) > 0)) return 'sin precio';
    if (String(item.currency || item.currency_id || '').trim().toUpperCase() !== 'UYU') return 'moneda no UYU';
    if (!isBookProduct(item)) {
        const domain = String(item.domain_id || '').trim().toUpperCase();
        const hasIsbn = normalizeIsbnToGtin(item.isbn).valid;
        const apoyo = [
            Boolean(String(item.author || '').trim()),
            Number(item.pages) > 0,
            Boolean(item.bibliographic && Object.values(item.bibliographic).some(v => String(v || '').trim())),
        ].filter(Boolean).length;
        if (domain && !hasIsbn) return 'no es libro: tiene dominio y no tiene ISBN válido';
        if (domain && hasIsbn && apoyo === 0) return 'no es libro: ISBN válido, pero sin autor ni páginas';
        if (!domain && !hasIsbn) return 'no es libro: sin dominio ni ISBN válido';
        return 'no es libro: otra causa';
    }
    return 'otra causa';
}

export function auditar(items, tagIds = new Set()) {
    const activos = items.filter(i => i?.status === 'active');
    const candidatos = activos.filter(i => esCandidato(i, tagIds));
    const out = {
        catalogo_activo: activos.length,
        candidatos: candidatos.length,
        entran_al_feed: 0,
        fuera_del_feed: 0,
        con_isbn_valido: 0,
        con_autor: 0,
        dominios: {},
        motivos: {},
        ejemplos_fuera: [],
    };
    for (const item of candidatos) {
        if (normalizeIsbnToGtin(item.isbn).valid) out.con_isbn_valido++;
        if (String(item.author || '').trim()) out.con_autor++;
        const domain = String(item.domain_id || '(sin dominio)').trim().toUpperCase();
        out.dominios[domain] = (out.dominios[domain] || 0) + 1;
        if (isEligibleForFeed(item)) { out.entran_al_feed++; continue; }
        out.fuera_del_feed++;
        const why = motivo(item);
        out.motivos[why] = (out.motivos[why] || 0) + 1;
        if (out.ejemplos_fuera.length < 12) {
            out.ejemplos_fuera.push({ id: item.id, titulo: String(item.title || '').slice(0, 70), motivo: why, dominio: domain });
        }
    }
    out.dominios = Object.fromEntries(Object.entries(out.dominios).sort((a, b) => b[1] - a[1]).slice(0, 12));
    return out;
}

async function main(argv) {
    const idx = argv.indexOf('--catalogo');
    const catalog = idx >= 0
        ? JSON.parse(readFileSync(argv[idx + 1], 'utf8'))
        : await (await fetch(CATALOG_URL)).json();
    const tagIds = new Set(TAROT_MERCH_TAGS.map(t => String(t.id)));
    const result = { generado: new Date().toISOString(), ...auditar(catalog.items ?? [], tagIds) };
    mkdirSync('artifacts/mazos', { recursive: true });
    writeFileSync('artifacts/mazos/mazos-feed-audit.json', `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    main(process.argv.slice(2)).catch(error => { console.error(`mazos-feed-audit: ${error.message}`); process.exit(1); });
}
