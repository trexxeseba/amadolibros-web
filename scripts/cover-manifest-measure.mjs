/**
 * scripts/cover-manifest-measure.mjs
 *
 * Cuánto ocupa EN MEMORIA el manifest real de portadas, medido sobre el
 * manifest real y no sobre uno sintético.
 *
 * Por qué existe: el modelo de cover-manifest-budget.js estima el grafo a
 * partir del tamaño del JSON, con un factor sacado de manifests sintéticos.
 * La primera vez que ese modelo se enfrentó al manifest de producción dijo
 * 202% del isolate — o sea "esto ya tendría que estar muerto"— y producción
 * estaba viva. Un guardián que se contradice con la realidad la primera vez
 * que habla no sirve: lo van a ignorar cuando tenga razón.
 *
 * Así que acá se mide de verdad. Node y workerd corren el mismo V8, así que
 * el grafo que mide este proceso es el que va a ocupar dentro del Worker.
 *
 * Corre como proceso aparte a propósito: necesita --expose-gc para que las
 * mediciones de heap sirvan, y los chequeos de CI no arrancan con esa bandera.
 *
 *   node --expose-gc scripts/cover-manifest-measure.mjs <manifest.json.gz>
 *
 * Escribe una línea de JSON con lo medido. No decide nada: la decisión es de
 * cover-manifest-budget.js, que recibe esta medición.
 */
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const MB = 1024 * 1024;
const ruta = process.argv[2];

if (!ruta) {
  console.error('Falta la ruta al manifest (.json o .json.gz).');
  process.exit(2);
}
if (!globalThis.gc) {
  console.error('Falta --expose-gc: sin eso la medición de heap no sirve.');
  process.exit(2);
}

const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };

const crudo = await readFile(ruta);
const bytes = ruta.endsWith('.gz') ? gunzipSync(crudo) : crudo;
const texto = bytes.toString('utf8');
const jsonBytes = Buffer.byteLength(texto);

// Se mide sólo el parseo. La cadena de entrada ya está viva antes de la marca,
// así que no entra en la diferencia.
const antes = heap();
const manifest = JSON.parse(texto);
const grafoBytes = heap() - antes;

const entradas = Object.keys(manifest?.entries || {}).length;
if (!entradas) {
  console.error('El manifest no tiene entradas: la medición no significaría nada.');
  process.exit(2);
}

// Lo que hace el escritor antes de indexar: una copia superficial de entries.
const antesCopia = heap();
const copia = { ...manifest, entries: { ...manifest.entries } };
const copiaBytes = heap() - antesCopia;
if (!copia.entries) throw new Error('imposible');

console.log(JSON.stringify({
  measured: true,
  manifest_bytes: jsonBytes,
  entries: entradas,
  bytes_per_entry: Math.round(jsonBytes / entradas),
  graph_mb: Number((grafoBytes / MB).toFixed(1)),
  entries_copy_mb: Number((Math.max(0, copiaBytes) / MB).toFixed(1)),
  graph_per_json: Number((grafoBytes / jsonBytes).toFixed(2)),
}));
