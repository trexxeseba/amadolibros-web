/**
 * scripts/cover-memory-benchmark.mjs
 *
 * De dónde salen las constantes de functions/_shared/cover-manifest-budget.js.
 *
 * Arma manifests sintéticos con la forma real del manifest privado de portadas
 * y mide cuánta memoria ocupa cada cosa que vive AL MISMO TIEMPO dentro del
 * isolate cuando el cron reescribe:
 *
 *   1. el grafo del manifest ya parseado
 *   2. la copia superficial de `entries` que hace writeManifestAttempt
 *   3. los shards en vuelo de prepareCoverIndex
 *
 * Se corre a mano cuando se quiera revisar el modelo:
 *
 *     node --expose-gc scripts/cover-memory-benchmark.mjs
 *
 * DOS TRAMPAS QUE YA CAYERON UNA VEZ, PARA NO REPETIRLAS:
 *
 * - Si todas las entradas comparten el mismo sha256, V8 deduplica la cadena y
 *   el grafo mide 0,9x el JSON en vez de 2,2x. El resultado sale optimista por
 *   un factor de dos y medio. Por eso acá cada entrada tiene su hash único.
 *
 * - `JSON.stringify` del manifest entero crea una cadena de decenas de MB que
 *   ensucia la medición siguiente. Por eso los bytes se cuentan por pedazos.
 *
 * - La peor de las tres: CONSTRUIR los objetos con literales en vez de
 *   PARSEARLOS. Sobre los mismos datos, construidos dan 2,2x y parseados dan
 *   1,25x — V8 parsea mucho más compacto. El Worker parsea, así que acá se
 *   arma el texto, se tira el grafo construido y se mide el que sale de
 *   JSON.parse. Medir el construido daba un 76% de más.
 *
 * NO mide el bucket: el `put` de este banco guarda los shards en un Map y eso
 * en el Worker real se va a R2 y no ocupa memoria. Ese término se informa
 * aparte y no entra en el modelo.
 *
 * Cada tamaño corre en su PROPIO proceso. Medirlos todos en uno daba resultados
 * absurdos —un manifest más grande "pesando" la mitad que uno chico— porque el
 * heap de V8 no vuelve al mismo punto entre corridas por más gc que se le pida.
 */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareCoverIndex } from '../functions/_shared/cover-public-index.js';
import {
  GRAPH_PER_JSON_MB, ENTRIES_COPY_BYTES_PER_ENTRY, coverManifestBudget,
} from '../functions/_shared/cover-manifest-budget.js';

const MB = 1024 * 1024;
const TAMANOS = [40432, 80864, 121296, 161728];

if (!globalThis.gc) {
  console.error('Falta --expose-gc: sin eso las mediciones de heap no sirven.');
  console.error('Corré:  node --expose-gc scripts/cover-memory-benchmark.mjs');
  process.exit(2);
}

const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed / MB; };

let semilla = 0x2f6e1c3b;
function hexUnico() {
  let salida = '';
  for (let i = 0; i < 8; i++) {
    semilla = Math.imul(semilla ^ (semilla >>> 15), 0x2545f491) >>> 0;
    salida += semilla.toString(16).padStart(8, '0');
  }
  return salida;
}

function entrada(id, position) {
  const sha = hexUnico();
  return {
    product_id: id,
    position,
    current: {
      object_key: `covers/v1/o/${id}/${position}/${sha}.jpg`,
      sha256: sha,
      mime: 'image/jpeg',
      source_url: `https://http2.mlstatic.com/D_NQ_NP_2X_${id}-${position}-F.webp`,
      width: 1200, height: 1600, bytes: 184320,
    },
    last_validated_at: `2026-09-0${1 + (position % 9)}T04:12:33.109Z`,
    source_policy_version: 3,
  };
}

function bytesSinRetener(manifest) {
  let total = JSON.stringify({ ...manifest, entries: {} }).length;
  for (const [clave, valor] of Object.entries(manifest.entries)) {
    total += JSON.stringify(clave).length + JSON.stringify(valor).length + 2;
  }
  return total;
}

const ESTE = fileURLToPath(import.meta.url);
const unaSola = process.argv.indexOf('--una');

async function medir(cuantas) {
  // Se arma el texto y se descarta el grafo construido: lo que importa es el
  // que produce JSON.parse, que es lo que hace el Worker.
  let texto = null;
  {
    const entries = {};
    for (let i = 0; i < cuantas; i += 2) {
      const id = `MLU${600000000 + i * 37}`;
      entries[`${id}:0`] = entrada(id, 0);
      entries[`${id}:1`] = entrada(id, 1);
    }
    texto = JSON.stringify({ schema_version: 1, updated_at: '2026-09-09T04:12:33.109Z', entries });
  }
  const jsonMb = Buffer.byteLength(texto) / MB;

  const base = heap();
  const manifest = JSON.parse(texto);
  const grafo = heap() - base;
  const trasContar = grafo;

  const siguiente = { ...manifest, entries: { ...manifest.entries } };
  const copia = (heap() - base) - trasContar;

  const almacen = new Map();
  const bucket = {
    put: async (clave, cuerpo) => { almacen.set(clave, cuerpo); return {}; },
    get: async clave => (almacen.has(clave)
      ? { text: async () => almacen.get(clave), size: almacen.get(clave).length }
      : null),
  };
  const inicio = Date.now();
  const resultado = await prepareCoverIndex(bucket, siguiente);
  const segundos = (Date.now() - inicio) / 1000;

  if (!resultado.hash || !siguiente.entries) throw new Error('imposible');

  return {
    entradas: cuantas,
    json_mb: Number(jsonMb.toFixed(1)),
    grafo_mb: Number(grafo.toFixed(1)),
    grafo_por_json: Number((grafo / jsonMb).toFixed(2)),
    copia_mb: Number(Math.max(0, copia).toFixed(1)),
    copia_bytes_por_entrada: Math.round((Math.max(0, copia) * MB) / cuantas),
    prepare_s: Number(segundos.toFixed(2)),
    shards: resultado.shards,
  };
}

// Hijo: mide un solo tamaño y lo escribe como JSON. Padre: los junta.
if (unaSola !== -1) {
  console.log(JSON.stringify(await medir(Number(process.argv[unaSola + 1]))));
  process.exit(0);
}

const filas = [];
for (const cuantas of TAMANOS) {
  const hijo = spawnSync(process.execPath,
    ['--expose-gc', '--max-old-space-size=6144', ESTE, '--una', String(cuantas)],
    { encoding: 'utf8' });
  if (hijo.status !== 0) {
    console.error(`No se pudo medir ${cuantas} entradas:`);
    console.error(hijo.stderr || hijo.stdout);
    process.exit(1);
  }
  filas.push(JSON.parse(hijo.stdout.trim().split('\n').at(-1)));
}

console.log('entradas | JSON MB | grafo MB | grafo/JSON | copia MB | copia B/ent | prepare s');
console.log('---------+---------+----------+------------+----------+-------------+----------');
for (const fila of filas) {
  console.log(
    `${String(fila.entradas).padStart(8)} | ${String(fila.json_mb).padStart(7)}`
    + ` | ${String(fila.grafo_mb).padStart(8)} | ${String(fila.grafo_por_json).padStart(10)}`
    + ` | ${String(fila.copia_mb).padStart(8)} | ${String(fila.copia_bytes_por_entrada).padStart(10)}`
    + ` | ${String(fila.prepare_s).padStart(9)}`,
  );
}

const grafoMedido = Math.max(...filas.map(fila => fila.grafo_por_json));
const copiaMedida = Math.max(...filas.map(fila => fila.copia_bytes_por_entrada));
console.log('');
console.log(`Modelo en uso:  grafo ${GRAPH_PER_JSON_MB}x · copia ${ENTRIES_COPY_BYTES_PER_ENTRY} B/entrada`);
console.log(`Medido ahora:   grafo ${grafoMedido.toFixed(2)}x · copia ${copiaMedida} B/entrada`);
// Tolerancia del 2%: los valores vienen redondeados y una diferencia en el
// último decimal no es un modelo optimista, es ruido de medición.
const TOLERANCIA = 1.02;
if (grafoMedido > GRAPH_PER_JSON_MB * TOLERANCIA
  || copiaMedida > ENTRIES_COPY_BYTES_PER_ENTRY * TOLERANCIA) {
  console.log('');
  console.log('El modelo quedó OPTIMISTA respecto de lo medido. Hay que subir las');
  console.log('constantes en functions/_shared/cover-manifest-budget.js.');
  process.exitCode = 1;
}

console.log('');
// El manifest real, medido en CI el 2026-09-10: 108.774.952 bytes, 80.871
// entradas, 1387 por entrada. El 31,6 MB que circulaba era un dato viejo.
console.log('Ejemplo con el manifest real de producción (103,7 MB / 80.871):');
console.log(JSON.stringify(coverManifestBudget({ manifestBytes: 108774952, entries: 80871 }), null, 2));
