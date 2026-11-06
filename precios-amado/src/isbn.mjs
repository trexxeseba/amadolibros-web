// Normalización de ISBN: cualquier ISBN-10 o ISBN-13 (con guiones o espacios)
// se lleva a ISBN-13 sin separadores. Devuelve null si no es un ISBN válido.
export function normalizeIsbn(raw) {
  const s = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) return isbn13Valid(s) ? s : null;
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    if (!isbn10Valid(s)) return null;
    const core = '978' + s.slice(0, 9);
    return core + isbn13Check(core);
  }
  return null;
}

function isbn13Check(core12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
const isbn13Valid = s => isbn13Check(s.slice(0, 12)) === s[12];
function isbn10Valid(s) {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

// ISBN de una publicación de ML: atributos GTIN / ISBN, en ese orden.
export function itemIsbn(item) {
  const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
  for (const id of ['GTIN', 'ISBN', 'BOOK_ISBN']) {
    const a = attrs.find(x => x?.id === id);
    const n = normalizeIsbn(a?.value_name ?? a?.values?.[0]?.name);
    if (n) return n;
  }
  return null;
}
