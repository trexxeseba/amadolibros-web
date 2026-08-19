import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyVerifiedDemandBibliography,
  VERIFIED_DEMAND_BOOK_IDS,
} from '../verified-demand-bibliography.js';

test('completa sólo campos confirmados en las 31 fichas sin tocar contenido comercial', () => {
  assert.equal(VERIFIED_DEMAND_BOOK_IDS.length, 31);
  assert.equal(new Set(VERIFIED_DEMAND_BOOK_IDS).size, 31);

  const items = VERIFIED_DEMAND_BOOK_IDS.map((id, index) => ({
    id,
    title: `Título comercial ${index}`,
    author: `Autor existente ${index}`,
    isbn: null,
    publisher: null,
    pages: null,
    bibliographic: {
      format: 'Tapa dura existente',
      edition: 'Edición existente',
    },
    description: `Descripción existente ${index}`,
    price: 1000 + index,
    available_quantity: index,
    pictures: [`foto-${index}.jpg`],
  }));

  const result = applyVerifiedDemandBibliography(items);

  assert.deepEqual(result, {
    matched_items: 31,
    applied_items: 31,
    applied_fields: {
      isbn: 31,
      publisher: 6,
      pages: 11,
      publication_year: 26,
    },
    skipped_isbn_mismatch: 0,
    preserved_existing_fields: 0,
  });

  assert.ok(items.every((item, index) => item.title === `Título comercial ${index}`));
  assert.ok(items.every((item, index) => item.author === `Autor existente ${index}`));
  assert.ok(items.every((item, index) => item.description === `Descripción existente ${index}`));
  assert.ok(items.every((item, index) => item.price === 1000 + index));
  assert.ok(items.every((item, index) => item.available_quantity === index));
  assert.ok(items.every((item, index) => item.pictures[0] === `foto-${index}.jpg`));
  assert.ok(items.every(item => item.bibliographic.format === 'Tapa dura existente'));
  assert.ok(items.every(item => item.bibliographic.edition === 'Edición existente'));

  const almuzara = items.find(item => item.id === 'MLU704191572');
  assert.equal(almuzara.isbn, '9788417880521');
  assert.equal(almuzara.publisher, 'Almuzara');
  assert.equal(almuzara.pages, 232);
  assert.equal(almuzara.bibliographic.publication_year, '2021');

  const pagesOnly = items.find(item => item.id === 'MLU644929173');
  assert.equal(pagesOnly.pages, 320);
  assert.equal(pagesOnly.bibliographic.publication_year, undefined);

  const publisherOnly = items.find(item => item.id === 'MLU656702417');
  assert.equal(publisherOnly.publisher, 'Debolsillo');
  assert.equal(publisherOnly.pages, null);
  assert.equal(publisherOnly.bibliographic.publication_year, undefined);
});

test('conserva datos reales existentes y sólo reemplaza publishers placeholder', () => {
  const existing = {
    id: 'MLU704191572',
    title: 'Título intacto',
    isbn: '9788417880521',
    publisher: 'Editorial ya cargada',
    pages: 999,
    bibliographic: {
      publication_year: '1999',
      format: 'Tapa blanda',
    },
  };

  const existingResult = applyVerifiedDemandBibliography([existing]);

  assert.deepEqual(existingResult, {
    matched_items: 1,
    applied_items: 0,
    applied_fields: {
      isbn: 0,
      publisher: 0,
      pages: 0,
      publication_year: 0,
    },
    skipped_isbn_mismatch: 0,
    preserved_existing_fields: 3,
  });
  assert.equal(existing.publisher, 'Editorial ya cargada');
  assert.equal(existing.pages, 999);
  assert.equal(existing.bibliographic.publication_year, '1999');
  assert.equal(existing.bibliographic.format, 'Tapa blanda');

  const placeholder = {
    id: 'MLU656702417',
    title: 'Otro título intacto',
    isbn: '9786073113724',
    publisher: 'Amado Libros',
    bibliographic: null,
  };

  const placeholderResult = applyVerifiedDemandBibliography([placeholder]);

  assert.equal(placeholderResult.applied_items, 1);
  assert.equal(placeholderResult.applied_fields.publisher, 1);
  assert.equal(placeholder.publisher, 'Debolsillo');
  assert.equal(placeholder.title, 'Otro título intacto');
});

test('rechaza una publicación cuyo ISBN actual corresponde a otra edición', () => {
  const item = {
    id: 'MLU709076232',
    title: 'Título intacto',
    isbn: '9780000000000',
    publisher: null,
    pages: null,
    bibliographic: null,
  };

  const result = applyVerifiedDemandBibliography([item]);

  assert.deepEqual(result, {
    matched_items: 1,
    applied_items: 0,
    applied_fields: {
      isbn: 0,
      publisher: 0,
      pages: 0,
      publication_year: 0,
    },
    skipped_isbn_mismatch: 1,
    preserved_existing_fields: 0,
  });
  assert.equal(item.title, 'Título intacto');
  assert.equal(item.publisher, null);
  assert.equal(item.pages, null);
  assert.equal(item.bibliographic, null);
});

test('acepta el ISBN-10 equivalente sin reescribirlo', () => {
  const item = {
    id: 'MLU709076232',
    title: 'Título intacto',
    isbn: '8416894868',
    publisher: null,
    pages: null,
    bibliographic: {},
  };

  const result = applyVerifiedDemandBibliography([item]);

  assert.equal(result.skipped_isbn_mismatch, 0);
  assert.equal(result.applied_items, 1);
  assert.equal(result.applied_fields.isbn, 0);
  assert.equal(result.applied_fields.pages, 1);
  assert.equal(result.applied_fields.publication_year, 1);
  assert.equal(item.isbn, '8416894868');
  assert.equal(item.pages, 224);
  assert.equal(item.bibliographic.publication_year, '2017');
});
