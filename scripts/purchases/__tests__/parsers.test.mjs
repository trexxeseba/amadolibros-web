import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCelesaText, parseSbsText } from '../parsers.mjs';
import { seal, validateDocuments } from '../sellar.mjs';

const pad = (s, n) => String(s).padEnd(n);
// Textos inventados con la misma disposición que `pdftotext -layout`.
const celesa = ({ type = 'BILL', units = 4, total = '125,10 €', extra = '' } = {}) => [
  '   Customer Code     Document Type     Date     Invoice Nº     Page',
  `   863137            ${type}        06/10/2026        CF10256        1 de 1`,
  `${pad('9780000000002', 24)}${pad('EDITORIAL UNO', 28)}1 ${pad('LIBRO DE PRUEBA UNO', 50)}${pad('45,18', 14)}${pad('30,00', 10)}${pad('0,00', 10)}31,63`,
  '                                    C-47738941-C',
  `${pad('9780000000019', 24)}${pad('EDITORIAL DOS', 28)}3 ${pad('LIBRO DE PRUEBA DOS 2', 50)}${pad('12,98', 14)}${pad('34,00', 10)}${pad('0,00', 10)}25,70`,
  `${' '.repeat(40)}GASTOS DE ENVIO INTERNACIONAL${' '.repeat(30)}67,77${' '.repeat(20)}0,00${' '.repeat(20)}67,77`,
  extra,
  '   Units     Gross Amount     Tax Base     % VAT     Tot VAT     TOTAL',
  `   ${units}                                  0,00                                ${total}`,
].join('\n');

test('Celesa: lee cabecera, líneas, envío y verifica unidades y total', () => {
  const doc = parseCelesaText(celesa(), { reference: 'gmail:x' });
  assert.equal(doc.supplier, 'CELESA');
  assert.equal(doc.document_number, 'CF-10256', 'con guion, como figura en el asunto del mail');
  assert.equal(doc.document_date, '2026-10-06');
  assert.equal(doc.currency, 'EUR');
  assert.equal(doc.total_amount, 125.1);
  assert.deepEqual(doc.items.map(i => [i.isbn, i.quantity, i.unit_price, i.discount_pct, i.line_total]), [['9780000000002', 1, 45.18, 30, 31.63], ['9780000000019', 3, 12.98, 34, 25.7]]);
  assert.equal(doc.items[1].title, 'LIBRO DE PRUEBA DOS 2', 'el título conserva sus dígitos');
  assert.equal(doc.items[0].publisher, 'EDITORIAL UNO');
});

test('Celesa: si no cuadran las unidades o el total, no devuelve nada', () => {
  assert.throws(() => parseCelesaText(celesa({ units: 5 })), /celesa_unidades_no_cuadran/);
  assert.throws(() => parseCelesaText(celesa({ total: '300,00 €' })), /celesa_total_no_cuadra/);
  assert.throws(() => parseCelesaText(celesa({ type: 'CREDIT' })), /celesa_tipo_no_soportado/);
  assert.throws(() => parseCelesaText('texto cualquiera'), /celesa_cabecera_no_encontrada/);
});

const sbs = ({ subtotal = '$54200,00' } = {}) => [
  '                 VENTAS PEDIDO', '                 Numero :0053 - 04392242', '                 Fecha : 18/11/2026',
  'Estado Cantidad      ISBN                        Titulo                      Precio                    Dtos                       Fecha Orig       Observ   Disponible',
  `           2      9780000000002 ${pad('LIBRO DE PRUEBA UNO', 30)}$29000,00          %35,00            $37700,00    13/11/2026 11:51:16   AG WEB`,
  `    R      1      9780000000019 ${pad('LIBRO DE PRUEBA DOS', 30)}$25384,62          %35,00            $16500,00    16/11/2026 18:30:33   AG WEB`,
  `                                         Subtotal                     ${subtotal}`,
].join('\n');

test('SBS: lee el pedido (también con estado R) y marca el destino como encargo', () => {
  const doc = parseSbsText(sbs());
  assert.equal(doc.supplier_order_id, 'PE-4392242');
  assert.equal(doc.document_type, 'order');
  assert.equal(doc.document_date, '2026-11-18');
  assert.equal(doc.currency, 'ARS');
  assert.equal(doc.purpose, 'encargo_cliente');
  assert.deepEqual(doc.items.map(i => [i.isbn, i.quantity, i.line_total]), [['9780000000002', 2, 37700], ['9780000000019', 1, 16500]]);
  assert.throws(() => parseSbsText(sbs({ subtotal: '$99999,00' })), /sbs_total_no_cuadra/);
});

test('los documentos leídos pasan la validación del Worker y se pueden sellar', async () => {
  const docs = [parseCelesaText(celesa()), parseSbsText(sbs())];
  assert.equal(validateDocuments(docs).length, 2);
  assert.throws(() => validateDocuments([{ supplier: 'CELESA' }]), /documento_0_invalido/);
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const sealed = await seal(await crypto.subtle.exportKey('jwk', pair.publicKey), { documents: docs });
  assert.match(sealed, /^[A-Za-z0-9_-]+$/, 'base64url: cabe en el campo de entrada de la acción');
  assert.ok(sealed.length < 60000, 'el límite de entrada de GitHub es 65.535 caracteres');
  assert.doesNotMatch(Buffer.from(sealed, 'base64url').toString(), /PRUEBA|CELESA|9780000/, 'el sobre no deja nada en claro');
});
