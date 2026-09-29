import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

// El caché de fuentes y los informes de investigación pesan varios megas cada
// uno y sólo crecen. Guardarlos en texto plano metía casi un millón de líneas
// en el diff del PR, que nadie puede revisar.
//
// Se guardan comprimidos: ocupan ~12 veces menos, el diff deja de inflarse y
// —lo importante— la evidencia NO se pierde ni se muda fuera del repo, así
// que la reanudación del lote sigue siendo automática al hacer checkout.
//
// Se lee cualquiera de las dos formas para que un caché viejo en texto plano
// siga sirviendo.

export function isGzipPath(filePath) {
  return /\.gz$/i.test(String(filePath || ''));
}

export function gzipCandidates(filePath) {
  const base = String(filePath || '').replace(/\.gz$/i, '');
  return [`${base}.gz`, base];
}

export async function readJsonMaybeGzip(filePath) {
  let ultimoError = null;
  for (const candidate of gzipCandidates(filePath)) {
    try {
      const bytes = await readFile(candidate);
      const text = isGzipPath(candidate) ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
      return { data: JSON.parse(text), path: candidate };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      ultimoError = error;
    }
  }
  throw ultimoError || new Error(`No se encontró ${filePath}`);
}

export async function writeJsonGzip(filePath, value) {
  const target = isGzipPath(filePath) ? filePath : `${filePath}.gz`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, gzipSync(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), { level: 9 }));
  return target;
}
