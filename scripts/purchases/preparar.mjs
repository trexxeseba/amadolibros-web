#!/usr/bin/env node
// Prepara compras para la acción "Importar compras": lee los PDF (o un JSON), los
// valida y escribe el texto sellado en el archivo de salida. Por pantalla sólo
// salen conteos (número de documento, líneas, unidades), nunca precios.
//
//   node scripts/purchases/preparar.mjs --proveedor celesa|sbs --salida sellado.txt a.pdf b.pdf
//   node scripts/purchases/preparar.mjs --json compras.json --salida sellado.txt
//   ... --quitar CELESA:invoice:2026:CF-10256   (antes de importar, quita una compra que cargó este circuito)
// Con --enviar dispara la acción "Importar compras" con `gh api` REST (en las sesiones de Claude
// no hay GraphQL; el texto sellado no pasa por la conversación: va del archivo a GitHub). Sin --enviar sólo deja el archivo.
// Clave pública: scripts/purchases/clave-publica.json (la entrega la acción con accion=clave).
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PARSERS, pdfText } from './parsers.mjs';
import { seal, validateDocuments } from './sellar.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : null; };
const enviar = (i => i >= 0 && args.splice(i, 1).length > 0)(args.indexOf('--enviar'));
const quitar = []; for (let q = flag('quitar'); q; q = flag('quitar')) quitar.push(q);
const proveedor = flag('proveedor'), json = flag('json'), salida = flag('salida'), clave = flag('clave') ?? new URL('./clave-publica.json', import.meta.url).pathname;

async function main() {
  if (!salida) throw new Error('Falta --salida');
  let docs;
  if (json) { const parsed = JSON.parse(await readFile(json, 'utf8')); docs = Array.isArray(parsed) ? parsed : parsed.documents ?? [parsed]; }
  else {
    const parse = PARSERS[proveedor];
    if (!parse || !args.length) throw new Error('Uso: --proveedor celesa|sbs --salida archivo PDF... | --json compras.json --salida archivo');
    docs = [];
    for (const path of args) docs.push(parse(await pdfText(path), { reference: `gmail:${path.split('/').pop().slice(0, 60)}` }));
  }
  for (const d of validateDocuments(docs)) console.error(`${d.supplier} ${d.document_number ?? d.supplier_order_id} ${d.purchase_date}: ${d.items.length} líneas, ${d.items.reduce((n, i) => n + i.quantity, 0)} unidades`);
  const publicJwk = JSON.parse(await readFile(clave, 'utf8'));
  const sealed = await seal(publicJwk, { documents: docs, ...(quitar.length ? { remove: quitar } : {}) });
  await writeFile(salida, sealed);
  console.error(`Sellado en ${salida} (${sealed.length} caracteres)`);
  if (enviar) await dispatch(sealed);
}

function dispatch(sealed) {
  const body = JSON.stringify({ ref: 'main', inputs: { accion: 'importar', sellado: sealed } });
  return new Promise((resolve, reject) => {
    const gh = spawn('gh', ['api', '-X', 'POST', 'repos/trexxeseba/amadolibros-web/actions/workflows/importar-compras.yml/dispatches', '--input', '-'], { stdio: ['pipe', 'inherit', 'inherit'] });
    gh.on('error', reject);
    gh.on('close', code => (code === 0 ? resolve() : reject(new Error(`gh api (dispatch) falló (${code})`))));
    gh.stdin.end(body);
  });
}
main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
