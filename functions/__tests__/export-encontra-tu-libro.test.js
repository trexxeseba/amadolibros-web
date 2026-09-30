import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPOS_EXPORTADOS,
  aRegistroExportado,
  autorDe,
  condicionDe,
  construirExport,
  motivoDeExclusion,
  precioTransferencia,
  urlFichaDe,
} from '../api/_export_etl_logic.js';
import { NOMBRE_CABECERA, crearExportHandler } from '../api/_export_etl_handler.js';
import { TRANSFER_FACTOR } from '../api/_orders_logic.js';
import { isEligibleForFeed } from '../feed.xml.js';

function libro(patch = {}) {
  return {
    id: 'MLU100000001',
    title: 'Rayuela',
    author: 'Julio Cortázar',
    isbn: '9788437604572',
    price: 1290,
    currency_id: 'UYU',
    status: 'active',
    available_quantity: 3,
    condition: 'new',
    domain_id: 'MLU-BOOKS',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU100000001',
    ...patch,
  };
}

// ─── Selección: qué entra y qué no ───────────────────────────────────────────

test('un libro activo con stock entra', () => {
  assert.equal(motivoDeExclusion(libro()), null);
});

test('cada motivo de exclusión se detecta por separado', () => {
  const casos = [
    [{ id: 'no-es-mlu' }, 'id_invalido'],
    [{ status: 'paused' }, 'no_activo'],
    [{ available_quantity: 0 }, 'sin_stock'],
    [{ price: 0 }, 'sin_precio'],
    [{ currency_id: 'USD' }, 'moneda_no_uyu'],
    [{ currency_id: '' }, 'moneda_no_uyu'],
  ];
  for (const [patch, motivo] of casos) {
    assert.equal(motivoDeExclusion(libro(patch)), motivo, JSON.stringify(patch));
  }
  assert.equal(motivoDeExclusion(null), 'id_invalido');
});

// El punto que corrigió Seba: las exigencias de Merchant no deben recortar
// este export.
test('un libro vendible SIN ISBN y SIN portada validada entra igual', () => {
  const sinIsbn = libro({ isbn: null, thumbnail: null, pictures: [] });
  assert.equal(motivoDeExclusion(sinIsbn), null, 'no se excluye por no tener ISBN');
  assert.equal(aRegistroExportado(sinIsbn).isbn13, null, 'y el ISBN se informa como ausente, no inventado');
});

test('un libro sin permalink de Mercado Libre entra, aunque el feed lo excluya', () => {
  const sinPermalink = libro({ permalink: null });
  assert.equal(motivoDeExclusion(sinPermalink), null);
  assert.equal(isEligibleForFeed(sinPermalink), false,
    'control: el filtro de Merchant sí lo excluye, y por eso no lo reusamos');
});

test('no se reusa el filtro de Merchant como criterio', () => {
  // Si alguien cambiara motivoDeExclusion por isEligibleForFeed, este caso
  // dejaría de entrar y la prueba de arriba fallaría. Esta lo dice explícito.
  const sinPermalink = libro({ permalink: undefined });
  assert.notEqual(motivoDeExclusion(sinPermalink), 'id_invalido');
  assert.equal(motivoDeExclusion(sinPermalink), null);
});

// ─── Precios ─────────────────────────────────────────────────────────────────

test('el precio por transferencia usa la misma regla y redondeo que la ficha', () => {
  // La ficha hace Math.round(price * 0.88). Se compara contra eso, no contra
  // un número escrito a mano.
  for (const precio of [1290, 999, 1, 1501, 2345, 7777]) {
    assert.equal(precioTransferencia(precio), Math.round(precio * 0.88), `precio ${precio}`);
    assert.equal(precioTransferencia(precio), Math.round(precio * TRANSFER_FACTOR));
  }
  assert.equal(precioTransferencia(1290), 1135);
});

test('un precio inválido no produce un precio de transferencia inventado', () => {
  for (const malo of [0, -5, null, undefined, 'gratis']) {
    assert.equal(precioTransferencia(malo), null, String(malo));
  }
});

// ─── Datos faltantes: se informan, no se suponen ─────────────────────────────

test('la condición ausente es desconocida, NO usado', () => {
  assert.equal(condicionDe(libro({ condition: 'new' })), 'nuevo');
  assert.equal(condicionDe(libro({ condition: 'used' })), 'usado');
  for (const vacio of [null, undefined, '', '   ', 'refurbished']) {
    assert.equal(condicionDe(libro({ condition: vacio })), 'desconocida', String(vacio));
  }
});

test('un autor genérico se informa como ausente', () => {
  assert.equal(autorDe(libro({ author: 'Julio Cortázar' })), 'Julio Cortázar');
  assert.equal(autorDe(libro({ author: '  Julio   Cortázar ' })), 'Julio Cortázar');
  assert.equal(autorDe(libro({ author: '' })), null);
  assert.equal(autorDe(libro({ author: null })), null);
});

test('un ISBN inválido se informa como ausente, nunca crudo', () => {
  for (const malo of ['123', 'ABC', '9788437604573', null, '']) {
    assert.equal(aRegistroExportado(libro({ isbn: malo })).isbn13, null, String(malo));
  }
  assert.equal(aRegistroExportado(libro()).isbn13, '9788437604572');
});

// ─── Campos: nada de más ─────────────────────────────────────────────────────

test('el registro trae exactamente los campos permitidos', () => {
  const registro = aRegistroExportado(libro());
  assert.deepEqual(Object.keys(registro).sort(), [...CAMPOS_EXPORTADOS].sort());
});

test('no se filtra nada interno ni la cantidad exacta', () => {
  const conBasura = libro({
    available_quantity: 7,
    sold_quantity: 42,
    cost_uyu: 500,
    supplier: 'Proveedor Secreto',
    seller_id: 999,
    permalink: 'https://articulo.mercadolibre.com.uy/MLU100000001',
  });
  const serializado = JSON.stringify(aRegistroExportado(conBasura));
  for (const prohibido of ['sold_quantity', '42', 'cost_uyu', '500', 'Proveedor', 'seller_id', '999', 'mercadolibre']) {
    assert.doesNotMatch(serializado, new RegExp(prohibido), `no debe aparecer: ${prohibido}`);
  }
  assert.equal(aRegistroExportado(conBasura).disponibilidad, 'en_stock',
    'la disponibilidad es una etiqueta, no el número');
});

test('la URL es la ficha propia, nunca el permalink de Mercado Libre', () => {
  const url = urlFichaDe(libro());
  assert.equal(url, 'https://www.amadolibros.com/libro/MLU100000001/rayuela');
  assert.doesNotMatch(url, /mercadolibre/);
});

// ─── Sin deduplicar por ISBN ─────────────────────────────────────────────────

test('dos publicaciones con el mismo ISBN entran las dos', () => {
  const resultado = construirExport({
    updated_at: '2026-09-30T07:15:00.000Z',
    items: [
      libro({ id: 'MLU100000001', condition: 'new', price: 1290 }),
      libro({ id: 'MLU100000002', condition: 'used', price: 790 }),
    ],
  });
  assert.equal(resultado.totales.incluidos, 2, 'son ofertas distintas, no duplicados');
  assert.deepEqual(resultado.libros.map(l => l.id), ['MLU100000001', 'MLU100000002']);
  assert.deepEqual(resultado.libros.map(l => l.condicion), ['nuevo', 'usado']);
});

// ─── Totales y fecha ─────────────────────────────────────────────────────────

test('los totales suman el universo y se desglosan por motivo', () => {
  const resultado = construirExport({
    updated_at: '2026-09-30T07:15:00.000Z',
    items: [
      libro(),
      libro({ id: 'MLU2', status: 'paused' }),
      libro({ id: 'MLU3', available_quantity: 0 }),
      libro({ id: 'MLU4', currency_id: 'USD' }),
      libro({ id: 'sin-formato' }),
    ],
  });
  const t = resultado.totales;
  assert.equal(t.en_catalogo, 5);
  assert.equal(t.incluidos, 1);
  assert.equal(t.incluidos + t.excluidos, t.en_catalogo, 'los números tienen que cerrar');
  assert.equal(t.excluidos_por_motivo.no_activo, 1);
  assert.equal(t.excluidos_por_motivo.sin_stock, 1);
  assert.equal(t.excluidos_por_motivo.moneda_no_uyu, 1);
  assert.equal(t.excluidos_por_motivo.id_invalido, 1);
});

test('la fecha es la del catálogo, no la de la descarga', () => {
  const conFecha = construirExport({ updated_at: '2026-09-30T07:15:00.000Z', items: [libro()] });
  assert.equal(conFecha.fuente_actualizada, '2026-09-30T07:15:00.000Z');
  assert.equal(conFecha.fuente_actualizada_nota, null);

  const sinFecha = construirExport({ items: [libro()] });
  assert.equal(sinFecha.fuente_actualizada, null, 'no se rellena con la hora de ahora');
  assert.match(sinFecha.fuente_actualizada_nota, /no se pudo determinar/i);
});

test('se declara que es una foto completa', () => {
  const resultado = construirExport({ items: [libro()] });
  assert.equal(resultado.tipo, 'foto_completa');
  assert.match(resultado.alcance, /stock inmediato/);
});

// ─── Autenticación ───────────────────────────────────────────────────────────

const CLAVE = 'clave-de-prueba-larga-y-unica';

function pedir({ clave = null, method = 'GET' } = {}) {
  const headers = {};
  if (clave !== null) headers[NOMBRE_CABECERA] = clave;
  return new Request('https://www.amadolibros.com/export/encontra-tu-libro.json', { method, headers });
}

const catalogoFalso = async () => ({ updated_at: '2026-09-30T07:15:00.000Z', items: [libro()] });

test('sin secreto configurado el endpoint NO sirve datos', async () => {
  const handler = crearExportHandler({ obtenerCatalogo: catalogoFalso });
  const res = await handler({ request: pedir({ clave: CLAVE }), env: {} });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'export_no_configurado');
});

test('sin clave, con clave equivocada o con clave parcial no se entra', async () => {
  const handler = crearExportHandler({ obtenerCatalogo: catalogoFalso });
  const env = { ETL_EXPORT_KEY: CLAVE };
  for (const clave of [null, '', 'otra', CLAVE.slice(0, -1), `${CLAVE}x`, CLAVE.toUpperCase()]) {
    const res = await handler({ request: pedir({ clave }), env });
    assert.equal(res.status, 401, `debería rechazar: ${String(clave)}`);
  }
});

test('con la clave correcta se sirve el export', async () => {
  const handler = crearExportHandler({ obtenerCatalogo: catalogoFalso });
  const res = await handler({ request: pedir({ clave: CLAVE }), env: { ETL_EXPORT_KEY: CLAVE } });
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.totales.incluidos, 1);
  assert.deepEqual(cuerpo.campos, CAMPOS_EXPORTADOS);
});

test('ninguna respuesta se puede cachear, ni la de rechazo', async () => {
  const handler = crearExportHandler({ obtenerCatalogo: catalogoFalso });
  const env = { ETL_EXPORT_KEY: CLAVE };
  for (const clave of [CLAVE, 'mal', null]) {
    const res = await handler({ request: pedir({ clave }), env });
    const cache = res.headers.get('Cache-Control');
    assert.match(cache, /no-store/, `respuesta con clave ${String(clave)}`);
    assert.match(cache, /private/);
    assert.equal(res.headers.get('Vary'), NOMBRE_CABECERA,
      'si alguna capa cachea, que al menos distinga por clave');
  }
});

test('sólo GET', async () => {
  const handler = crearExportHandler({ obtenerCatalogo: catalogoFalso });
  const res = await handler({ request: pedir({ clave: CLAVE, method: 'POST' }), env: { ETL_EXPORT_KEY: CLAVE } });
  assert.equal(res.status, 405);
});

// ─── Catálogo caído ──────────────────────────────────────────────────────────

test('un catálogo caído no se sirve como export vacío', async () => {
  for (const caido of [null, { items: [] }, { items: 'no-es-array' }]) {
    const handler = crearExportHandler({ obtenerCatalogo: async () => caido });
    const res = await handler({ request: pedir({ clave: CLAVE }), env: { ETL_EXPORT_KEY: CLAVE } });
    assert.equal(res.status, 503, JSON.stringify(caido));
    assert.equal((await res.json()).code, 'catalogo_no_disponible');
  }
});

test('si el catálogo explota, se responde 503 y no se filtra el error', async () => {
  const handler = crearExportHandler({
    obtenerCatalogo: async () => { throw new Error('R2 secreto interno'); },
  });
  const res = await handler({ request: pedir({ clave: CLAVE }), env: { ETL_EXPORT_KEY: CLAVE } });
  assert.equal(res.status, 503);
  assert.doesNotMatch(JSON.stringify(await res.json()), /R2 secreto interno/);
});
