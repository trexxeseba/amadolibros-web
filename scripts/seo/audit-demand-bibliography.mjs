import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PAUSED_SEO_COHORT } from '../../functions/_shared/paused-seo-cohort.js';

const OUT = process.env.OUT_DIR || 'artifacts/demand-bibliography';
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CONCURRENCY || 4)));
const GOOGLE_BOOKS_ACCESS_TOKEN = String(process.env.GOOGLE_BOOKS_ACCESS_TOKEN || '').trim();
const UA = 'AmadoLibrosBibliographyAudit/1.0 (+https://www.amadolibros.com)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function digits(v) { return String(v || '').replace(/\D/g, ''); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function key(v) {
  return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(editorial|ediciones|editions|publishing|publishers?|grupo|group|press)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function int(v) {
  const n = Number(String(v ?? '').replace(/[^0-9]/g, ''));
  return Number.isInteger(n) && n > 0 && n < 10000 ? n : null;
}
function year(v) {
  const m = String(v || '').match(/(?:^|\D)((?:18|19|20)\d{2})(?:\D|$)/);
  return m ? Number(m[1]) : null;
}
function formatKey(v) {
  const s = key(v);
  if (!s) return '';
  if (/hardcover|hardback|tapa dura|cartone/.test(s)) return 'Tapa dura';
  if (/paperback|softcover|tapa blanda|rustica|rustico/.test(s)) return 'Tapa blanda';
  if (/spiral|espiral/.test(s)) return 'Espiral';
  if (/ebook|digital|kindle|electron/.test(s)) return 'eBook';
  return clean(v);
}

async function fetchJson(url, attempts = 3, extraHeaders = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...extraHeaders }, signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : {};
      last = new Error(`HTTP ${r.status}: ${text.slice(0, 250)}`);
      if (![429, 500, 502, 503, 504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    await sleep(500 * i);
  }
  throw last;
}

function attr(item, ids) {
  const set = new Set(ids.map(x => x.toUpperCase()));
  const row = Array.isArray(item?.attributes) ? item.attributes.find(a => set.has(String(a?.id || '').toUpperCase())) : null;
  return clean(row?.value_name || row?.values?.[0]?.name || '');
}

async function fromMercadoLibre(id) {
  try {
    const x = await fetchJson(`https://api.mercadolibre.com/items/${encodeURIComponent(id)}`);
    return {
      ok: true,
      title: clean(x.title),
      publisher: attr(x, ['BOOK_PUBLISHER','PUBLISHER','EDITORIAL']),
      pages: int(attr(x, ['BOOK_PAGES','PAGES','NUMBER_OF_PAGES'])),
      format: formatKey(attr(x, ['BOOK_FORMAT','FORMAT','COVER_TYPE','BINDING'])),
      edition: attr(x, ['EDITION','BOOK_EDITION']),
      year: year(attr(x, ['PUBLICATION_YEAR','YEAR','RELEASE_YEAR'])),
    };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

async function fromGoogleBooks(isbn) {
  try {
    const q = encodeURIComponent(`isbn:${isbn}`);
    const headers = GOOGLE_BOOKS_ACCESS_TOKEN ? { authorization: `Bearer ${GOOGLE_BOOKS_ACCESS_TOKEN}` } : {};
    const x = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&printType=books`, 3, headers);
    const exact = (x.items || []).map(v => v.volumeInfo || {}).find(v =>
      (v.industryIdentifiers || []).some(i => digits(i.identifier) === digits(isbn))
    );
    if (!exact) return { ok: true, found: false };
    return {
      ok: true, found: true,
      title: clean(exact.title),
      publisher: clean(exact.publisher),
      pages: int(exact.pageCount),
      format: '',
      edition: '',
      year: year(exact.publishedDate),
    };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

async function fromOpenLibrary(isbn) {
  try {
    const x = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
    return {
      ok: true, found: true,
      title: clean(x.title),
      publisher: clean(Array.isArray(x.publishers) ? x.publishers[0] : x.publishers),
      pages: int(x.number_of_pages || x.pagination),
      format: formatKey(x.physical_format),
      edition: clean(x.edition_name || ''),
      year: year(x.publish_date),
    };
  } catch (e) {
    if (/HTTP 404/.test(String(e?.message || e))) return { ok: true, found: false };
    return { ok: false, error: String(e?.message || e) };
  }
}

function consensus(sources, field, normalizer = key) {
  const vals = [];
  for (const [source, data] of Object.entries(sources)) {
    const raw = data?.[field];
    if (raw == null || raw === '') continue;
    const normalized = normalizer(raw);
    if (normalized == null || normalized === '') continue;
    vals.push({ source, raw, normalized });
  }
  const groups = new Map();
  for (const v of vals) {
    const k = String(v.normalized);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const ranked = [...groups.values()].sort((a,b) => b.length - a.length);
  const best = ranked[0] || [];
  return {
    verified: best.length >= 2,
    value: best.length >= 2 ? best[0].raw : null,
    agreeingSources: best.length >= 2 ? best.map(v => v.source) : [],
    all: vals,
    conflict: ranked.length > 1,
  };
}

async function inspect(row) {
  const [ml, googleBooks, openLibrary] = await Promise.all([
    fromMercadoLibre(row.id), fromGoogleBooks(row.isbn), fromOpenLibrary(row.isbn),
  ]);
  const sources = { mercadoLibre: ml, googleBooks, openLibrary };
  return {
    id: row.id,
    isbn: row.isbn,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    sources,
    verified: {
      publisher: consensus(sources, 'publisher', key),
      pages: consensus(sources, 'pages', v => int(v)),
      format: consensus(sources, 'format', formatKey),
      edition: consensus(sources, 'edition', key),
      publication_year: consensus(sources, 'year', v => Number(v) || null),
    },
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const demand = PAUSED_SEO_COHORT.filter(r => r.source === 'gsc-demand');
if (demand.length !== 130) throw new Error(`Esperaba 130 gsc-demand, encontré ${demand.length}`);
await mkdir(OUT, { recursive: true });
const rows = await mapLimit(demand, CONCURRENCY, inspect);
const fieldNames = ['publisher','pages','format','edition','publication_year'];
const summary = Object.fromEntries(fieldNames.map(f => [f, {
  verified: rows.filter(r => r.verified[f].verified).length,
  conflict: rows.filter(r => r.verified[f].conflict).length,
  anyEvidence: rows.filter(r => r.verified[f].all.length > 0).length,
}]));
const sourceHealth = {
  mercadoLibreOk: rows.filter(r => r.sources.mercadoLibre.ok).length,
  googleBooksOk: rows.filter(r => r.sources.googleBooks.ok).length,
  googleBooksFound: rows.filter(r => r.sources.googleBooks.found).length,
  openLibraryFound: rows.filter(r => r.sources.openLibrary.found).length,
};
const candidates = {};
for (const r of rows) {
  const fields = {};
  for (const f of fieldNames) if (r.verified[f].verified) fields[f] = r.verified[f].value;
  if (Object.keys(fields).length) candidates[r.isbn] = { id: r.id, impressions: r.impressions, clicks: r.clicks, ...fields };
}
const report = { generatedAt: new Date().toISOString(), sample: rows.length, googleBooksAuthenticated: Boolean(GOOGLE_BOOKS_ACCESS_TOKEN), sourceHealth, summary, candidateIsbns: Object.keys(candidates).length, rows };
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(OUT, 'verified-candidates.json'), JSON.stringify(candidates, null, 2));

const md = [
  '# SEO-DEMAND-130 — verificación bibliográfica', '',
  `- ISBN/fichas auditadas: **${rows.length}**`,
  `- Google Books con OAuth del proyecto: **${GOOGLE_BOOKS_ACCESS_TOKEN ? 'sí' : 'no'}**`,
  `- Google Books respondió OK: **${sourceHealth.googleBooksOk}/${rows.length}**`,
  `- Google Books encontró edición exacta: **${sourceHealth.googleBooksFound}/${rows.length}**`,
  `- Open Library encontró edición: **${sourceHealth.openLibraryFound}/${rows.length}**`,
  `- ISBN con al menos un campo confirmado por ≥2 fuentes: **${Object.keys(candidates).length}/${rows.length}**`, '',
  '| Campo | Confirmado ≥2 fuentes | Con evidencia | Conflictos |',
  '| --- | ---: | ---: | ---: |',
  ...fieldNames.map(f => `| ${f} | ${summary[f].verified} | ${summary[f].anyEvidence} | ${summary[f].conflict} |`), '',
  '## Top 20 por impresiones', '',
  '| MLU | ISBN | Imp. | Clics | Editorial | Páginas | Formato | Año |',
  '| --- | --- | ---: | ---: | --- | ---: | --- | ---: |',
  ...rows.slice(0,20).map(r => `| ${r.id} | ${r.isbn} | ${r.impressions} | ${r.clicks} | ${r.verified.publisher.verified ? clean(r.verified.publisher.value) : '—'} | ${r.verified.pages.verified ? r.verified.pages.value : '—'} | ${r.verified.format.verified ? clean(r.verified.format.value) : '—'} | ${r.verified.publication_year.verified ? r.verified.publication_year.value : '—'} |`),
];
await writeFile(path.join(OUT, 'summary.md'), md.join('\n'));
console.log(md.join('\n'));
