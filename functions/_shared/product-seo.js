import { slugify } from './slug.js';

/**
 * Ajustes editoriales respaldados por oportunidades reales de Search Console.
 * No cambian el título comercial ni los datos del catálogo: sólo el snippet
 * orgánico de la ficha.
 */
const PRODUCT_SEO = new Map([
  ['MLU1416777650', {
    title: 'Murdoku en Uruguay: 80 acertijos de lógica',
    description: 'Consultá por Murdoku de Manuel Garand en Uruguay: stock o encargo, retiro en Montevideo y envíos a todo el país con Amado Libros.',
    keepIndexedWhenUnavailable: true,
  }],
  ['MLU676002408', {
    title: 'Mientras dormíamos: El engaño maestro',
    description: 'Mientras dormíamos: El engaño maestro, de Giuseppe Nocera Costabile. Consultá precio, stock y envíos en Uruguay con Amado Libros.',
  }],
  ['MLU633445690', {
    title: 'Así fue como llegaste: donación de esperma',
    description: 'Así fue como llegaste, de Silvia Jadur y Constanza Duhalde. Consultá precio, stock y envíos en Uruguay con Amado Libros.',
  }],
  ['MLU646420175', {
    title: 'Urmah: Los sembradores siderales',
    description: 'Urmah: Los sembradores siderales, de Luis Ángel Loaiza Ferreira. Consultá precio, stock y envíos en Uruguay con Amado Libros.',
  }],
  ['MLU662039047', {
    title: 'Jujutsu Kaisen 25 de Gege Akutami',
    description: 'Jujutsu Kaisen, tomo 25, de Gege Akutami. Verificá edición, idioma, precio, stock y envíos en Uruguay con Amado Libros.',
  }],
  ['MLU707743600', {
    title: 'Colección Grandes Aventuras Genios: 11 libros',
    description: 'Colección Grandes Aventuras Genios de 11 libros. Consultá precio, stock y envíos a todo Uruguay con Amado Libros.',
  }],
  ['MLU626854956', {
    title: 'Amagi, de Sagar Prakash Khatnani',
    description: 'Libro Amagi, de Sagar Prakash Khatnani. Consultá precio, stock, retiro en Montevideo y envíos a todo Uruguay con Amado Libros.',
  }],
  ['MLU653980087', {
    title: 'Colorea y descubre el misterio: Princesas',
    description: 'Colorea y descubre el misterio: Princesas, de Jeremy Mariez. Consultá stock o encargo y envíos a todo Uruguay con Amado Libros.',
    keepIndexedWhenUnavailable: true,
  }],
  ['MLU1467423248', {
    title: 'Más astuto que el diablo, de Napoleon Hill',
    description: 'Más astuto que el diablo, de Napoleon Hill. Consultá edición, precio, stock y envíos a todo Uruguay con Amado Libros.',
  }],
  ['MLU889085304', {
    title: 'Primeros pasos en clínica psicopedagógica Vol. 1',
    description: 'Primeros pasos en la clínica psicopedagógica, volumen 1, de Guillermina Ferra. Consultá precio, stock y envíos con Amado Libros.',
  }],
  ['MLU696157645', {
    title: 'La taza de la mañana, de Camille J. Sage',
    description: 'La taza de la mañana, de Camille J. Sage. Consultá precio, stock, retiro en Montevideo y envíos a todo Uruguay con Amado Libros.',
  }],
]);

/**
 * Pares de publicaciones comprobados como la misma edición (mismo ISBN,
 * título y datos comerciales). Google ya eligió la ficha destino como
 * canónica. La comprobación se repite en runtime para no consolidar dos
 * ediciones si el catálogo cambia en el futuro.
 */
const VERIFIED_DUPLICATE_TARGETS = new Map([
  ['MLU704333012', 'MLU704333014'],
  ['MLU693866378', 'MLU693700826'],
]);

function isbnDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function productSeoFor(id) {
  return PRODUCT_SEO.get(String(id || '')) || null;
}

export function shouldIndexProduct(item, isPreview = false) {
  if (isPreview) return false;
  const inStock = item?.status === 'active' && Number(item?.available_quantity) > 0;
  return inStock || productSeoFor(item?.id)?.keepIndexedWhenUnavailable === true;
}

export function verifiedDuplicateCanonicalTarget(item, catalogItems = []) {
  const targetId = VERIFIED_DUPLICATE_TARGETS.get(String(item?.id || ''));
  if (!targetId || !Array.isArray(catalogItems)) return null;

  const target = catalogItems.find(candidate => candidate?.id === targetId);
  const sourceIsbn = isbnDigits(item?.isbn);
  const targetIsbn = isbnDigits(target?.isbn);
  if (!target || !sourceIsbn || sourceIsbn !== targetIsbn) return null;
  if (slugify(item?.title) !== slugify(target.title)) return null;
  if (target.status !== 'active' || Number(target.available_quantity) <= 0) return null;
  return target;
}

export const PRODUCT_SEO_IDS = Object.freeze([...PRODUCT_SEO.keys()]);
