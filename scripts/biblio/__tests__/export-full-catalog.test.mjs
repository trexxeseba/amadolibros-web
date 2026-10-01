import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const exporter = fileURLToPath(new URL('../export-full-catalog.mjs', import.meta.url));

test('exports bibliographic years, never the Mercado Libre listing date or title years', async (t) => {
  const cases = [
    ['MLU922339414', 'Revista El Negro Timoteo N°16 Montevideo 1895', '1895'],
    ['MLU922183500', 'Revista El Negro Timoteo N°21 Montevideo 1895', '1895'],
    ['MLU923093472', 'Peloduro Julio E. Suárez Arca 1969 Primera Edición', '1969'],
    ['MLU693866286', 'Aquarian Tarot In A Tin, Edición 2016', '2016'],
    ['MLU100000001', '1984', ''],
    ['MLU100000002', 'Libro con año bibliográfico de primer nivel', '2001'],
  ];
  const items = cases.map(([id, title, year], index) => ({
    id, title, price: 1700, currency: 'UYU', status: 'active',
    available_quantity: 2, condition: 'used', domain_id: 'MLU-BOOKS',
    start_time: '2025-10-28T17:46:03.893Z',
    ...(index === 5 ? { year } : { bibliographic: { publication_year: year } }),
  }));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'biblio-date-test-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/catalog.json' ? { items } : {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await execFileAsync(process.execPath, [exporter], {
    timeout: 15000,
    env: {
      ...process.env,
      BIBLIO_CATALOG_URL: `${base}/catalog.json`,
      BIBLIO_PRODUCTION_MANIFEST_URL: `${base}/manifest.json`,
      BIBLIO_OUTPUT_DIR: outputDir,
      BIBLIO_UYU_PER_USD: '39.60',
      BIBLIO_MARKUP: '1.30',
      BIBLIO_MIN_USD: '12',
      BIBLIO_INCLUDE_NON_BOOKS: 'false',
    },
  });
  const lines = (await fs.readFile(path.join(outputDir, 'biblio-amado-full.txt'), 'utf8'))
    .trimEnd().split('\n').map((line) => line.split('\t'));
  const [headers, ...rows] = lines;
  assert.equal(headers.length, 17);
  assert.equal(rows.length, cases.length);
  for (let index = 0; index < rows.length; index += 1) {
    assert.equal(rows[index].length, 17);
    const row = Object.fromEntries(headers.map((header, column) => [header, rows[index][column]]));
    const [id, , expectedYear] = cases[index];
    assert.equal(row['Book ID'], id);
    assert.equal(row['Publication Date'], expectedYear, id);
    assert.equal(row.Price, '55.81');
    assert.equal(row.Currency, 'USD');
    assert.equal(row.Quantity, '2');
    assert.equal(row.Binding, '');
    if (expectedYear) assert.ok(row.Description.includes(`Fecha/año: ${expectedYear}.`), id);
    else assert.ok(!row.Description.includes('Fecha/año:'), id);
    assert.ok(!row.Description.includes('Fecha/año: 2025.'), id);
  }
});
