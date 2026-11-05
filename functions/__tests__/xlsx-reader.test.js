import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xlsxToCsv, XlsxError } from '../../worker-sync/xlsx-reader.js';
import { parseCsv } from '../../worker-sync/importacion-externa.js';
import { buildXlsx, buildZip } from './support/xlsx-fixture.js';

test('xlsxToCsv: cabeceras y filas con shared strings y números, lo mismo que lee parseCsv', async () => {
  const grid = [
    [{ s: 'SKU' }, { s: 'Publicación' }, { s: 'FULL' }, { s: 'Depósito' }],
    [{ s: '978-84-9105-123-4' }, { s: 'Martes con mi viejo profesor' }, { n: 0 }, { n: 2 }],
    [{ s: '978-0-306-40615-7' }, { s: 'Libro, con coma' }, { n: 1 }, { n: 0 }],
  ];
  const csv = await xlsxToCsv(buildXlsx(grid));
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['SKU', 'Publicación', 'FULL', 'Depósito']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].celdas.SKU, '978-84-9105-123-4');
  assert.equal(rows[0].celdas.Publicación, 'Martes con mi viejo profesor');
  assert.equal(rows[0].celdas.FULL, '0');
  assert.equal(rows[1].celdas.Publicación, 'Libro, con coma', 'una coma dentro de una celda no corta la columna');
});

test('xlsxToCsv: texto en línea (sin tabla de shared strings) también se lee', async () => {
  const grid = [[{ s: 'Título' }], [{ s: 'Un libro' }]];
  const csv = await xlsxToCsv(buildXlsx(grid, { sharedStrings: false }));
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['Título']);
  assert.equal(rows[0].celdas.Título, 'Un libro');
});

test('xlsxToCsv: celdas salteadas en una fila no corren las columnas siguientes', async () => {
  const grid = [
    [{ s: 'A' }, { s: 'B' }, { s: 'C' }],
    [{ s: 'x' }, null, { s: 'z' }],
  ];
  const csv = await xlsxToCsv(buildXlsx(grid));
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['A', 'B', 'C']);
  assert.equal(rows[0].celdas.A, 'x');
  assert.equal(rows[0].celdas.B, '');
  assert.equal(rows[0].celdas.C, 'z');
});

test('xlsxToCsv: entradas guardadas sin compresión (method=0) también se leen', async () => {
  const grid = [[{ s: 'A' }], [{ s: '1' }]];
  const csv = await xlsxToCsv(buildXlsx(grid));
  assert.match(csv, /A\n1/);
});

test('xlsxToCsv: un archivo que no es zip tira XlsxError, nunca basura silenciosa', async () => {
  await assert.rejects(() => xlsxToCsv(Buffer.from('no soy un xlsx')), XlsxError);
  await assert.rejects(() => xlsxToCsv(new Uint8Array(0)), XlsxError);
});

test('xlsxToCsv: un zip sin xl/workbook.xml (no es un xlsx) tira no_es_xlsx', async () => {
  const notXlsx = buildZip([{ name: 'otraCosa.txt', text: 'hola' }]);
  await assert.rejects(() => xlsxToCsv(notXlsx), (err) => err instanceof XlsxError && err.code === 'no_es_xlsx');
});
