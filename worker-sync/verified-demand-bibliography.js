/**
 * Campos bibliográficos confirmados para la cohorte SEO de 130 fichas con
 * demanda histórica de Search Console.
 *
 * Evidencia: issue #182 y audit-results/demand-bibliography-verified.json de
 * la rama agent/audit-gsc-demand-bibliography, generados el 2026-08-19.
 * Cada campo fue confirmado para el ISBN exacto por Google Books y Open
 * Library. Library of Congress no participa en este lote y nunca bloquea el
 * sync. No se agregan formato ni edición porque no alcanzaron dos fuentes.
 *
 * Reglas de aplicación:
 * - ID de Mercado Libre e ISBN deben identificar la misma edición;
 * - sólo se completan campos ausentes o un publisher placeholder;
 * - nunca se reemplazan título, autor, descripción, fotos, precio ni stock;
 * - un dato real ya presente en Mercado Libre se conserva.
 */

const VERIFIED_DEMAND_BIBLIOGRAPHY = new Map([
  ['MLU709076232', { isbn: '9788416894864', pages: 224, publication_year: '2017' }],
  ['MLU611170975', { isbn: '9789500203760', pages: 1126, publication_year: '2000' }],
  ['MLU663271326', { isbn: '9788417963040', pages: 324, publication_year: '2020' }],
  ['MLU753430344', { isbn: '9786073151702', publication_year: '2023' }],
  ['MLU714604980', { isbn: '9786075262758', publication_year: '2017' }],
  ['MLU1044785818', { isbn: '9788491041542', publication_year: '2015' }],
  ['MLU667447994', { isbn: '9786073801553', publication_year: '2023' }],
  ['MLU716663648', { isbn: '9789874922717', pages: 646, publication_year: '2020' }],
  ['MLU827100010', { isbn: '9781442498327', publication_year: '2013' }],
  ['MLU696591850', { isbn: '9788468475226', pages: 320, publication_year: '2011' }],
  ['MLU644929173', { isbn: '9788467479324', pages: 320 }],
  ['MLU704191572', { isbn: '9788417880521', publisher: 'Almuzara', pages: 232, publication_year: '2021' }],
  ['MLU630854789', { isbn: '9788416145317', pages: 192 }],
  ['MLU717732940', { isbn: '9780997419900', publisher: 'Am Education & Services', publication_year: '2016' }],
  ['MLU660197052', { isbn: '9788433030474', publication_year: '2019' }],
  ['MLU1349705242', { isbn: '9788423436750', publication_year: '2024' }],
  ['MLU1388713612', { isbn: '9788467585803', pages: 312 }],
  ['MLU1431949100', { isbn: '9788483580271', publication_year: '2007' }],
  ['MLU648552863', { isbn: '9781316634875', publisher: 'Cambridge University Press', publication_year: '2017' }],
  ['MLU656702417', { isbn: '9786073113724', publisher: 'Debolsillo' }],
  ['MLU665138560', { isbn: '9788490731307', publication_year: '2015' }],
  ['MLU717757810', { isbn: '9780194115124', publication_year: '2017' }],
  ['MLU766250362', { isbn: '9788466678865', publisher: 'Ediciones B', publication_year: '2024' }],
  ['MLU766276576', { isbn: '9781404119420', publication_year: '2023' }],
  ['MLU925896746', { isbn: '9788445019580', publication_year: '2025' }],
  ['MLU620531223', { isbn: '9788495973351', publication_year: '2006' }],
  ['MLU643828797', { isbn: '9788499213811', pages: 288, publication_year: '2013' }],
  ['MLU652240418', { isbn: '9788424629427', publisher: 'La Galera' }],
  ['MLU654532366', { isbn: '9780738762647', publication_year: '2019' }],
  ['MLU714465576', { isbn: '9781107668577', publication_year: '2014' }],
  ['MLU604541596', { isbn: '9788420678818', pages: 680, publication_year: '2013' }],
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeIsbn(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (/^\d{13}$/.test(raw)) return raw;
  if (!/^\d{9}[0-9X]$/.test(raw)) return raw;

  const base = `978${raw.slice(0, 9)}`;
  const sum = [...base].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function isPublisherPlaceholder(value) {
  const normalized = clean(value).toLowerCase();
  return !normalized || [
    'amado libros',
    'amado libros uruguay',
    'sin editorial',
    'no aplica',
    'n/a',
  ].includes(normalized);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function validPublicationYear(value) {
  const match = clean(value).match(/^(18|19|20)\d{2}$/);
  return match ? match[0] : null;
}

/**
 * Completa únicamente los campos confirmados que siguen ausentes.
 * Devuelve métricas para auditar el siguiente sync sin exponer datos sensibles.
 */
export function applyVerifiedDemandBibliography(items = []) {
  let matchedItems = 0;
  let appliedItems = 0;
  let skippedIsbnMismatch = 0;
  let preservedExistingFields = 0;
  const appliedFields = {
    isbn: 0,
    publisher: 0,
    pages: 0,
    publication_year: 0,
  };

  for (const item of items) {
    const verified = VERIFIED_DEMAND_BIBLIOGRAPHY.get(String(item?.id || ''));
    if (!verified) continue;
    matchedItems++;

    const currentIsbn = normalizeIsbn(item.isbn);
    const verifiedIsbn = normalizeIsbn(verified.isbn);
    if (currentIsbn && currentIsbn !== verifiedIsbn) {
      skippedIsbnMismatch++;
      continue;
    }

    let changed = false;
    if (!currentIsbn) {
      item.isbn = verified.isbn;
      appliedFields.isbn++;
      changed = true;
    }

    if (verified.publisher) {
      if (isPublisherPlaceholder(item.publisher)) {
        item.publisher = verified.publisher;
        appliedFields.publisher++;
        changed = true;
      } else {
        preservedExistingFields++;
      }
    }

    if (verified.pages) {
      if (!positiveInteger(item.pages)) {
        item.pages = verified.pages;
        appliedFields.pages++;
        changed = true;
      } else {
        preservedExistingFields++;
      }
    }

    if (verified.publication_year) {
      const bibliographic = item.bibliographic && typeof item.bibliographic === 'object'
        ? item.bibliographic
        : {};
      if (!validPublicationYear(bibliographic.publication_year)) {
        item.bibliographic = {
          ...bibliographic,
          publication_year: verified.publication_year,
        };
        appliedFields.publication_year++;
        changed = true;
      } else {
        preservedExistingFields++;
      }
    }

    if (changed) appliedItems++;
  }

  return {
    matched_items: matchedItems,
    applied_items: appliedItems,
    applied_fields: appliedFields,
    skipped_isbn_mismatch: skippedIsbnMismatch,
    preserved_existing_fields: preservedExistingFields,
  };
}

export const VERIFIED_DEMAND_BOOK_IDS = Object.freeze([
  ...VERIFIED_DEMAND_BIBLIOGRAPHY.keys(),
]);
