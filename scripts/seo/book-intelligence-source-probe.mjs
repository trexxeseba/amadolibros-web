import { pathToFileURL } from 'node:url';

import {
  NATIONAL_LIBRARIES,
  buildNationalLibraryUrl,
  fetchNationalLibraryEvidence,
} from './book-intelligence-national-libraries.mjs';

// Sonda de alcance: antes de gastar horas de lote contra un endpoint muerto,
// se prueban unos pocos ISBN reales por catálogo y se reporta qué contesta.
// Sólo lectura, sin escribir nada.

const ISBNS = [
  '9780062273208', // inglés, HarperBusiness
  '9788401039058', // español
  '9780142410110', // inglés, Puffin
  '9783423134422', // alemán, dtv
];

export async function probe(key, isbns = ISBNS) {
  const rows = [];
  for (const isbn of isbns) {
    const started = Date.now();
    try {
      const records = await fetchNationalLibraryEvidence(key, isbn, { timeoutMs: 20_000 });
      const fields = records.length
        ? Object.entries(records[0])
          .filter(([field, value]) => ['publisher', 'pages', 'language', 'publication_year'].includes(field) && value)
          .map(([field]) => field)
        : [];
      rows.push({ isbn, ok: true, registros: records.length, campos: fields, ms: Date.now() - started });
    } catch (error) {
      rows.push({ isbn, ok: false, error: String(error?.message || error), ms: Date.now() - started });
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return rows;
}

export async function main() {
  const resumen = {};
  for (const key of Object.keys(NATIONAL_LIBRARIES)) {
    console.log(`\n=== ${key.toUpperCase()} — ${buildNationalLibraryUrl(key, ISBNS[0])} ===`);
    const rows = await probe(key);
    for (const row of rows) console.log(JSON.stringify(row));
    resumen[key] = {
      consultas: rows.length,
      sin_error: rows.filter(row => row.ok).length,
      con_registro: rows.filter(row => row.ok && row.registros > 0).length,
    };
  }
  console.log('\n=== RESUMEN DE ALCANCE ===');
  console.log(JSON.stringify(resumen, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
