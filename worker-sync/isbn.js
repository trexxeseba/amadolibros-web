// ISBN de libro, sin dependencias: lo usan el Worker y las Pages Functions.
// Devuelve el ISBN-13 (978/979) con dígito verificador válido; un ISBN-10
// válido se convierte. Cualquier otra cosa → null.
export function bookIsbn(input) {
  let s = String(input ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    if ([...s].reduce((n, c, i) => n + (10 - i) * (c === 'X' ? 10 : Number(c)), 0) % 11 !== 0) return null;
    const stem = '978' + s.slice(0, 9);
    s = stem + ((10 - [...stem].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10);
  }
  if (!/^97[89]\d{10}$/.test(s)) return null;
  return [...s].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? s : null;
}
