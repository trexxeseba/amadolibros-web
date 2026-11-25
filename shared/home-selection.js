// Sólo diversifica el escaparate; no modifica ni fusiona publicaciones.
const STOP_WORDS = new Set(['a', 'al', 'de', 'del', 'el', 'en', 'la', 'las', 'lo', 'los', 'un', 'una', 'y', 'con', 'se', 'por', 'para']);
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function titleTokens(book) {
  return new Set(normalize(book.title).split(/[^a-z0-9]+/).filter(word => word && !STOP_WORDS.has(word)));
}
function sameDisplayBook(a, b) {
  const isbnA = String(a.isbn || '').replace(/[^0-9X]/gi, '');
  const isbnB = String(b.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbnA && isbnA === isbnB) return true;
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size < 4 || right.size < 4) return false;
  // Nunca ocultar un tomo distinto por la semejanza del resto del título.
  const numbers = tokens => [...tokens].filter(word => /^\d+$/.test(word)).sort().join(',');
  if (numbers(left) !== numbers(right)) return false;
  const intersection = [...left].filter(word => right.has(word)).length;
  return intersection / new Set([...left, ...right]).size >= 0.8;
}
export function selectDistinctHomeBooks(items, limit) {
  const selected = [];
  for (const book of items) {
    if (selected.some(existing => existing.id === book.id || sameDisplayBook(existing, book))) continue;
    selected.push(book);
    if (selected.length >= limit) break;
  }
  return selected;
}
