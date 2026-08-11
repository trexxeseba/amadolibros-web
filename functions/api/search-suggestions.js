import { fetchActiveIndex, fetchPausedIndex } from '../_shared/catalog.js';

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function buildSuggestions(items, rawQuery, limit = 10) {
  const query = normalize(rawQuery);
  if (query.length < 2) return [];
  const candidates = [];
  const seen = new Set();
  for (const item of items) {
    const fields = [
      { value: item.title, type: 'Título', score: 0 },
      { value: item.author, type: 'Autor', score: 2 },
      { value: item.isbn, type: 'ISBN', score: 4 },
    ];
    for (const field of fields) {
      const value = String(field.value || '').trim();
      const normalized = normalize(value);
      if (!value || !normalized.includes(query)) continue;
      const key = `${field.type}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        value,
        label: `${field.type}: ${value}`,
        score: field.score + (normalized.startsWith(query) ? 0 : 1),
      });
    }
  }
  return candidates.sort((a, b) => a.score - b.score || a.value.localeCompare(b.value, 'es'))
    .slice(0, limit).map(({ value, label }) => ({ value, label }));
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const query = (url.searchParams.get('q') || '').slice(0, 100);
  if (normalize(query).length < 2) {
    return Response.json({ suggestions: [] }, { headers: { 'cache-control': 'no-store' } });
  }
  const [active, paused] = await Promise.all([fetchActiveIndex(ctx), fetchPausedIndex(ctx)]);
  const items = [
    ...(Array.isArray(active?.items) ? active.items : []),
    ...(Array.isArray(paused?.items) ? paused.items : []),
  ];
  return Response.json({ suggestions: buildSuggestions(items, query) }, {
    headers: { 'cache-control': 'public,max-age=300', 'x-robots-tag': 'noindex' },
  });
}
