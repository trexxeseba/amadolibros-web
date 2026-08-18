import { PAUSED_SEO_COHORT } from './paused-seo-cohort.js';
import { slugify } from './slug.js';

export const ORDER_HUB_PATH = '/libros-por-encargo';
export const ORDER_HUB_PAGE_SIZE = 48;

export function orderHubPath(page = 1) {
  const normalized = Number(page);
  return Number.isInteger(normalized) && normalized > 1
    ? `${ORDER_HUB_PATH}?page=${normalized}`
    : ORDER_HUB_PATH;
}

export function parseOrderHubPage(rawValue) {
  if (rawValue == null || rawValue === '') {
    return { present: false, valid: true, page: 1 };
  }
  const value = String(rawValue).trim();
  if (!/^[1-9]\d*$/.test(value)) {
    return { present: true, valid: false, page: null };
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page)) {
    return { present: true, valid: false, page: null };
  }
  return { present: true, valid: true, page };
}

export function orderHubBooks(pausedIndex) {
  const pausedItems = Array.isArray(pausedIndex?.items) ? pausedIndex.items : [];
  const byId = new Map(pausedItems.map(item => [String(item?.id || '').toUpperCase(), item]));

  return PAUSED_SEO_COHORT
    .map(entry => byId.get(entry.id))
    .filter(item => item?.status === 'paused' && item.id && item.title)
    .map(item => Object.freeze({
      id: String(item.id).toUpperCase(),
      title: String(item.title),
      author: item.author ? String(item.author) : '',
      isbn: item.isbn ? String(item.isbn) : '',
      thumbnail: item.thumbnail ? String(item.thumbnail) : '',
      slug: slugify(item.title),
    }));
}

export function orderHubPageCount(booksOrCount) {
  const count = Array.isArray(booksOrCount)
    ? booksOrCount.length
    : Math.max(0, Number(booksOrCount) || 0);
  return Math.max(1, Math.ceil(count / ORDER_HUB_PAGE_SIZE));
}

export function orderHubPageSlice(books, page) {
  const pageNumber = Number(page);
  if (!Array.isArray(books) || !Number.isInteger(pageNumber) || pageNumber < 1) return [];
  const start = (pageNumber - 1) * ORDER_HUB_PAGE_SIZE;
  return books.slice(start, start + ORDER_HUB_PAGE_SIZE);
}

export function orderHubPaginationEntries(pausedIndex, baseUrl) {
  const books = orderHubBooks(pausedIndex);
  const totalPages = orderHubPageCount(books);
  const base = String(baseUrl || '').replace(/\/$/, '');
  return Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => ({
    loc: `${base}${orderHubPath(index + 2)}`,
  }));
}
