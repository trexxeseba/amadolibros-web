// scripts/categorize/taxonomy.js
//
// Fuente única de verdad de las categorías autorizadas para CF-CATEGORÍAS-1.
// Versionar este archivo cada vez que se agregue/renombre una categoría —
// TAXONOMY_VERSION es lo que decide si hay que reclasificar (ver run.js).

export const TAXONOMY_VERSION = 1;

// Orden = orden aprobado por Seba en CF-CATEGORÍAS-1. No reordenar sin razón,
// algunos consumidores futuros (home, /catalogo) pueden depender del orden.
export const CATEGORIES = [
  { id: 'literatura-ficcion', name: 'Literatura y ficción' },
  { id: 'infantil-juvenil', name: 'Infantil y juvenil' },
  { id: 'psicologia', name: 'Psicología' },
  { id: 'desarrollo-personal', name: 'Desarrollo personal' },
  { id: 'religion-espiritualidad', name: 'Religión y espiritualidad' },
  { id: 'esoterismo-tarot', name: 'Esoterismo y tarot' },
  { id: 'historia', name: 'Historia' },
  { id: 'filosofia-ciencias-sociales', name: 'Filosofía y ciencias sociales' },
  { id: 'medicina-salud', name: 'Medicina y salud' },
  { id: 'educacion', name: 'Educación' },
  { id: 'derecho', name: 'Derecho' },
  { id: 'ciencia-tecnologia', name: 'Ciencia y tecnología' },
  { id: 'negocios-economia', name: 'Negocios y economía' },
  { id: 'arte-diseno-fotografia', name: 'Arte, diseño y fotografía' },
  { id: 'comics-manga', name: 'Cómics y manga' },
  { id: 'cocina-gastronomia', name: 'Cocina y gastronomía' },
  { id: 'idiomas-aprendizaje', name: 'Idiomas y aprendizaje' },
  { id: 'otros-libros', name: 'Otros libros' },
];

export const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));

export const TYPES = Object.freeze({
  BOOK: 'book',
  OBJECT: 'object',
  UNCERTAIN: 'uncertain',
});

export function isValidCategoryId(id) {
  return id === null || CATEGORY_IDS.has(id);
}
