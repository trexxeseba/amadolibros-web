// FICHAS-VIDRIERA-3000-QUALITY: aplica el título derivado al renderer automático
// sin cambiar el título fuente, el slug, el canonical ni los datos del carrito.

import {
  buildBookSeoTitle,
  deriveBookDisplayTitle,
} from './book-display-title.js';
import {
  isGenericAuthor,
  normalizeValidIsbn,
} from './showcase-ranking.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function shortenByWord(value, maxLength) {
  const text = clean(value);
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, Math.max(1, maxLength - 1)).replace(/\s+\S*$/u, '').trim();
  return `${sliced || text.slice(0, maxLength - 1)}…`;
}

function replaceExact(value, rawTitle, displayTitle) {
  if (typeof value !== 'string' || !rawTitle || rawTitle === displayTitle) return value;
  return value.split(rawTitle).join(displayTitle);
}

function buildMetaDescription(item, displayTitle) {
  const author = !isGenericAuthor(item?.author) ? clean(item.author) : null;
  const isbn = normalizeValidIsbn(item?.isbn);
  const identity = `Comprá ${displayTitle}${author ? ` de ${author}` : ''} en Uruguay.`;
  const edition = isbn ? ` ISBN ${isbn}.` : '';
  return shortenByWord(
    `${identity}${edition} Consultá stock, 12% menos por transferencia, cuotas y envíos a todo el país.`,
    170,
  );
}

export function applyShowcaseTitleQuality(config, item) {
  if (!config || typeof config !== 'object' || !item || typeof item !== 'object') return config;
  const display = deriveBookDisplayTitle(item);
  if (!display.title) return config;

  const summary = Array.isArray(config.summary)
    ? config.summary.map(value => replaceExact(value, display.rawTitle, display.title))
    : config.summary;
  const schemaDescription = replaceExact(
    config.schemaDescription,
    display.rawTitle,
    display.title,
  );

  return {
    ...config,
    h1: display.title,
    rawTitle: display.rawTitle,
    titleChanged: display.changed,
    titleReason: display.reason,
    removedTitleParts: [...display.removedParts],
    seoTitle: buildBookSeoTitle(display.title),
    introHeading: replaceExact(config.introHeading, display.rawTitle, display.title),
    summary,
    schemaDescription,
    metaDescription: buildMetaDescription(item, display.title),
  };
}
