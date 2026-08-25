// scripts/categorize/taxonomy.js
//
// Fuente única de verdad de las categorías autorizadas para CF-CATEGORÍAS-2C.
// Versionar TAXONOMY_VERSION cada vez que se agregue/renombre/quite una
// categoría o subcategoría — run.js decide con esto si hay que reclasificar.
//
// CF-CATEGORÍAS-2C amplía la V1: agrega subcategorías donde el catálogo real
// sostiene volumen (ver informe de distribución), y agrega "otros-productos"
// como categoría comercial visible para lo que no es un libro (discos,
// revistas, objetos de colección) — reemplaza la idea de "excluir del
// catálogo": todo activo queda visible en alguna categoría.

export const TAXONOMY_VERSION = 4;

// subcategories: null si la categoría no tiene subdivisión (volumen
// insuficiente para que valga la pena, o no aplica).
export const CATEGORIES = [
  {
    id: 'literatura-ficcion', name: 'Literatura y ficción',
    subcategories: [
      { id: 'novela', name: 'Novela' },
      { id: 'cuento', name: 'Cuento' },
      { id: 'poesia', name: 'Poesía' },
      { id: 'teatro', name: 'Teatro' },
      { id: 'policial-suspenso', name: 'Policial y suspenso' },
      { id: 'ciencia-ficcion-fantasia', name: 'Ciencia ficción y fantasía' },
    ],
  },
  {
    id: 'infantil-juvenil', name: 'Infantil y juvenil',
    subcategories: [
      { id: 'primera-infancia', name: 'Primera infancia' },
      { id: 'literatura-infantil', name: 'Literatura infantil' },
      { id: 'literatura-juvenil', name: 'Literatura juvenil' },
      { id: 'actividades-aprendizaje', name: 'Actividades y aprendizaje' },
    ],
  },
  {
    id: 'psicologia', name: 'Psicología',
    subcategories: [
      { id: 'psicoanalisis', name: 'Psicoanálisis' },
      { id: 'psicoterapia', name: 'Psicoterapia' },
      { id: 'psicologia-clinica', name: 'Psicología clínica' },
      { id: 'psicologia-infantil', name: 'Psicología infantil' },
      { id: 'neuropsicologia', name: 'Neuropsicología' },
      { id: 'autismo-neurodesarrollo', name: 'Autismo y neurodesarrollo' },
      { id: 'psicomotricidad', name: 'Psicomotricidad' },
    ],
  },
  {
    id: 'familia-crianza', name: 'Familia, maternidad y crianza',
    subcategories: [
      { id: 'maternidad', name: 'Maternidad' },
      { id: 'crianza', name: 'Crianza' },
    ],
  },
  {
    id: 'desarrollo-personal', name: 'Desarrollo personal', subcategories: null,
  },
  {
    id: 'religion-espiritualidad', name: 'Religión y espiritualidad',
    subcategories: [
      { id: 'biblia', name: 'Biblia' },
      { id: 'reina-valera', name: 'Reina-Valera' },
      { id: 'espiritualidad', name: 'Espiritualidad' },
      { id: 'otras-tradiciones', name: 'Otras tradiciones religiosas' },
    ],
  },
  {
    id: 'esoterismo-tarot', name: 'Esoterismo y tarot',
    subcategories: [
      { id: 'tarot-oraculos', name: 'Tarot y oráculos' },
      { id: 'astrologia', name: 'Astrología' },
      { id: 'cabala-kabbalah', name: 'Cábala y Kabbalah' },
      { id: 'sufismo', name: 'Sufismo' },
    ],
  },
  {
    id: 'historia', name: 'Historia',
    subcategories: [
      { id: 'historia-argentina-uruguay', name: 'Historia de Argentina y Uruguay' },
      { id: 'historia-mundial', name: 'Historia mundial' },
    ],
  },
  {
    id: 'filosofia-ciencias-sociales', name: 'Filosofía y ciencias sociales',
    subcategories: [
      { id: 'filosofia', name: 'Filosofía' },
      { id: 'sociologia-antropologia', name: 'Sociología y antropología' },
      { id: 'ciencia-politica', name: 'Ciencia política' },
    ],
  },
  {
    id: 'medicina-salud', name: 'Medicina y salud',
    subcategories: [
      { id: 'anatomia', name: 'Anatomía' },
      { id: 'enfermeria', name: 'Enfermería' },
      { id: 'nutricion', name: 'Nutrición' },
      { id: 'salud-mental', name: 'Salud mental' },
      { id: 'dermatologia', name: 'Dermatología y cuidado de la piel' },
    ],
  },
  {
    id: 'educacion', name: 'Educación',
    subcategories: [
      { id: 'pedagogia', name: 'Pedagogía' },
      { id: 'formacion-docente', name: 'Formación docente' },
    ],
  },
  {
    id: 'derecho', name: 'Derecho', subcategories: null,
  },
  {
    id: 'ciencia-tecnologia', name: 'Ciencia y tecnología',
    subcategories: [
      { id: 'matematica', name: 'Matemática' },
      { id: 'biologia', name: 'Biología' },
      { id: 'fisica-quimica', name: 'Física y química' },
      { id: 'programacion', name: 'Programación' },
      { id: 'informatica-software', name: 'Informática y desarrollo de software' },
    ],
  },
  {
    id: 'naturaleza-animales', name: 'Naturaleza y animales',
    subcategories: [
      { id: 'zoologia-animales', name: 'Zoología y animales' },
      { id: 'caballos-equitacion', name: 'Caballos y equitación' },
    ],
  },
  {
    id: 'deportes', name: 'Deportes',
    subcategories: [
      { id: 'futbol', name: 'Fútbol' },
      { id: 'otros-deportes', name: 'Otros deportes' },
    ],
  },
  {
    id: 'negocios-economia', name: 'Negocios y economía', subcategories: null,
  },
  {
    id: 'arte-diseno-fotografia', name: 'Arte, diseño y fotografía', subcategories: null,
  },
  {
    id: 'comics-manga', name: 'Cómics y manga', subcategories: null,
  },
  {
    id: 'cocina-gastronomia', name: 'Cocina y gastronomía', subcategories: null,
  },
  {
    id: 'idiomas-aprendizaje', name: 'Idiomas y aprendizaje',
    subcategories: [
      { id: 'ingles', name: 'Inglés' },
      { id: 'otros-idiomas', name: 'Otros idiomas' },
    ],
  },
  {
    id: 'otros-libros', name: 'Otros libros', subcategories: null,
  },
  {
    id: 'otros-productos', name: 'Otros productos',
    subcategories: [
      { id: 'discos-vinilos', name: 'Discos y vinilos' },
      { id: 'revistas', name: 'Revistas' },
      { id: 'objetos-coleccion', name: 'Objetos de colección' },
      { id: 'papeleria-manualidades', name: 'Papelería y manualidades' },
    ],
  },
];

export const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));

export const SUBCATEGORY_IDS_BY_CATEGORY = new Map(
  CATEGORIES.map(c => [c.id, new Set((c.subcategories || []).map(s => s.id))])
);

export const TYPES = Object.freeze({
  BOOK: 'book',
  MAGAZINE: 'magazine',
  MUSIC: 'music',
  OBJECT: 'object',
  OTHER: 'other',
});

export function isValidCategoryId(id) {
  return id === null || CATEGORY_IDS.has(id);
}

export function isValidSubcategoryId(categoryId, subcategoryId) {
  if (subcategoryId === null || subcategoryId === undefined) return true;
  const set = SUBCATEGORY_IDS_BY_CATEGORY.get(categoryId);
  return Boolean(set && set.has(subcategoryId));
}
