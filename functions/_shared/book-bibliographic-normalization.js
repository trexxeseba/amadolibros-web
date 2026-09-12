const LANGUAGE_LABELS = Object.freeze({
  es: 'Español',
  spa: 'Español',
  en: 'Inglés',
  eng: 'Inglés',
  fr: 'Francés',
  fra: 'Francés',
  fre: 'Francés',
  de: 'Alemán',
  deu: 'Alemán',
  ger: 'Alemán',
  it: 'Italiano',
  ita: 'Italiano',
  pt: 'Portugués',
  por: 'Portugués',
  la: 'Latín',
  lat: 'Latín',
  ca: 'Catalán',
  cat: 'Catalán',
  gl: 'Gallego',
  glg: 'Gallego',
  eu: 'Euskera',
  baq: 'Euskera',
  eus: 'Euskera',
  nl: 'Neerlandés',
  nld: 'Neerlandés',
  dut: 'Neerlandés',
});

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Devuelve la etiqueta legible de un código de idioma, o null si no se
// conoce. Sirve para que un adaptador pueda descartar un código en vez de
// dejar que llegue crudo al dato visible (`dut`, `eng`, `spa`…).
export function bookLanguageLabel(code) {
  const key = clean(code).toLocaleLowerCase('es');
  if (!key) return null;
  return LANGUAGE_LABELS[key] || null;
}

export function normalizeBookLanguage(value) {
  const raw = clean(value);
  if (!raw) return null;
  const labels = raw
    .replace(/\/languages\//gi, '')
    .split(/[,;|/]+|\s+(?=[a-z]{2,3}(?:\s|$))/i)
    .map(clean)
    .filter(Boolean)
    .map(part => LANGUAGE_LABELS[part.toLocaleLowerCase('es')] || part);
  return [...new Set(labels)].join(', ') || null;
}
