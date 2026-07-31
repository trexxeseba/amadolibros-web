import { brotliCompressSync, constants } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

const r2Base = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const manifestResponse = await fetch(`${r2Base}/stock1-preview/manifest.json`, {
  headers: { 'Cache-Control': 'no-cache' },
});
if (!manifestResponse.ok) {
  throw new Error(`No se pudo leer manifest de Preview: HTTP ${manifestResponse.status}`);
}
const manifest = await manifestResponse.json();
const indexKey = manifest?.current?.active_index_key;
if (typeof indexKey !== 'string' || !indexKey.endsWith('/active-index.json')) {
  throw new Error('El manifest no contiene active_index_key válido.');
}

const indexResponse = await fetch(`${r2Base}/${indexKey}`, {
  headers: { 'Cache-Control': 'no-cache' },
});
if (!indexResponse.ok) {
  throw new Error(`No se pudo leer el índice activo: HTTP ${indexResponse.status}`);
}
const input = Buffer.from(await indexResponse.arrayBuffer());
const parsed = JSON.parse(input.toString('utf8'));
if (parsed?.schema_version !== 1 || !Array.isArray(parsed?.items) || parsed.items.length === 0) {
  throw new Error('El índice activo real no tiene el formato esperado.');
}

const output = brotliCompressSync(input, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 6,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  },
});
if (output.byteLength >= input.byteLength) {
  throw new Error('La prueba Brotli no redujo el archivo.');
}
await writeFile(process.argv[2] || '/tmp/active-index.json.br', output);
process.stdout.write(JSON.stringify({
  input_bytes: input.byteLength,
  output_bytes: output.byteLength,
  ratio: Math.round((output.byteLength / input.byteLength) * 10000) / 100,
  items: parsed.items.length,
}));
