const AUTHOR_PAGES = [
  {
    id: 'maria-montessori',
    name: 'María Montessori',
    path: '/libros-maria-montessori-uruguay',
    aliases: ['María Montessori', 'Maria Montessori', 'Montessori, Maria'],
    focus: 'pedagogía Montessori, educación, infancia, crianza y formación docente',
    intro: 'Reunimos ediciones de María Montessori para familias, estudiantes y profesionales de la educación. La selección se actualiza con el stock real disponible en Amado Libros.',
  },
  {
    id: 'walter-riso',
    name: 'Walter Riso',
    path: '/libros-walter-riso-uruguay',
    aliases: ['Walter Riso', 'Riso, Walter', 'Riso Walter'],
    focus: 'psicología, vínculos, autoestima y bienestar emocional',
    intro: 'Esta selección reúne libros de Walter Riso disponibles en Uruguay sobre vínculos, autoestima, autonomía emocional y herramientas de psicología para la vida cotidiana.',
  },
  {
    id: 'jacobo-grinberg-zylberbaum',
    name: 'Jacobo Grinberg-Zylberbaum',
    path: '/libros-jacobo-grinberg-uruguay',
    aliases: [
      'Grinberg-Zylberbaum, Jacobo',
      'Dr. Jacobo Grinberg-Zylberbaum',
      'Jacobo Grinberg-Zylberbaum (Autor)',
      'Grinberg-Zylerbaum y Deshimaru',
    ],
    focus: 'conciencia, percepción, psicología y tradiciones de conocimiento',
    intro: 'Agrupamos las obras disponibles de Jacobo Grinberg-Zylberbaum vinculadas con la conciencia, la percepción y el diálogo entre psicología y tradiciones de conocimiento.',
  },
  {
    id: 'jacques-lacan',
    name: 'Jacques Lacan',
    path: '/libros-jacques-lacan-uruguay',
    aliases: ['Jacques Lacan', 'Lacan', 'Autor/a Jacques Lacan'],
    focus: 'psicoanálisis, teoría clínica, escritos y seminarios',
    intro: 'La página reúne libros de Jacques Lacan disponibles para estudiantes, docentes y profesionales interesados en psicoanálisis, teoría clínica, escritos y seminarios.',
  },
  {
    id: 'boris-cyrulnik',
    name: 'Boris Cyrulnik',
    path: '/libros-boris-cyrulnik-uruguay',
    aliases: ['Boris Cyrulnik', 'Cyrulnik, Boris'],
    focus: 'resiliencia, trauma, vínculos afectivos y desarrollo humano',
    intro: 'Seleccionamos libros de Boris Cyrulnik disponibles en Uruguay sobre resiliencia, trauma, vínculos afectivos y desarrollo humano.',
  },
];

export const SEO_AUTHORS = Object.freeze(
  AUTHOR_PAGES.map(author => Object.freeze({
    ...author,
    aliases: Object.freeze([...author.aliases]),
  })),
);

function normalizeAuthor(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
}

export function authorPageById(id) {
  return SEO_AUTHORS.find(author => author.id === id) || null;
}

export function authorPageByName(name) {
  const normalized = normalizeAuthor(name);
  if (!normalized) return null;
  return SEO_AUTHORS.find(author =>
    author.aliases.some(alias => normalizeAuthor(alias) === normalized)
  ) || null;
}

export function authorPathForName(name) {
  return authorPageByName(name)?.path || null;
}

export function matchesAuthor(item, author) {
  if (!item || !author) return false;
  return author.aliases.some(alias =>
    normalizeAuthor(alias) === normalizeAuthor(item.author)
  );
}
