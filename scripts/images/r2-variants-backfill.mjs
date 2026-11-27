// Completa en R2 las variantes WebP que faltan para las tapas vigentes.
// Lee el manifiesto de portadas, lista las variantes ya guardadas y genera
// sólo las ausentes con el mismo codificador (createVariant) y el mismo
// contrato de metadatos que lee functions/book-cover (readImageVariant).
// Nunca sobrescribe (If-None-Match: *), nunca borra y no toca los masters.
// Los registros muestran totales, no identificadores ni rutas.
import { createHash, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createVariant } from './build-permanent-variants.mjs';
import { IMAGE_VARIANTS, variantObjectKey } from '../../shared/image-variants.js';

export const BUCKET = 'amadolibros-images-production';
export const MANIFEST_KEY = 'covers/v1/manifest.json';
const OBJECT_KEY_RE = /^covers\/v1\/objects\/([a-f0-9]{64})\.(jpg|png|webp)$/;
const VARIANT_KEY_RE = /^covers\/variants\/v1\/([a-f0-9]{64})\/(v1-\d+-q\d+)\.webp$/;
const MAX_MASTER_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;

// Recetas por posición: la tapa principal se usa en tarjetas, ficha, zoom y
// relacionados; las demás fotos de la galería, en la ficha (miniatura,
// principal y zoom).
export const COVER_RECIPES = IMAGE_VARIANTS.map(r => r.id);
export const GALLERY_RECIPES = ['v1-96-q82', 'v1-320-q85', 'v1-480-q85', 'v1-768-q85', 'v1-1024-q85', 'v1-1024-q88'];

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function signS3({ account, accessKey, secretKey, key = '', query = {}, method, body, headers = {}, now = new Date() }) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8);
  const host = `${account}.r2.cloudflarestorage.com`;
  const path = '/' + BUCKET + (key ? '/' + key.split('/').map(enc).join('/') : '');
  const qs = Object.keys(query).sort().map(k => enc(k) + '=' + enc(String(query[k]))).join('&');
  const payloadHash = sha(body || Buffer.alloc(0));
  const all = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date, ...headers };
  const names = Object.keys(all).map(k => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map(k => k + ':' + String(lower[k]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const canonical = [method, path, qs, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), 'auto'), 's3'), 'aws4_request');
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', date, scope, sha(canonical)].join('\n')).toString('hex');
  lower.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { url: 'https://' + host + path + (qs ? '?' + qs : ''), options: { method, headers: lower, body, redirect: 'manual' } };
}

// Qué variantes necesita cada master según las posiciones en que aparece.
export function plannedVariants(manifest) {
  const masters = new Map();
  for (const [slot, entry] of Object.entries(manifest?.entries || {})) {
    const position = Number(String(slot).split(':')[1]);
    const match = OBJECT_KEY_RE.exec(String(entry?.current?.object_key || ''));
    if (!match || entry.current.sha256 !== match[1] || !Number.isInteger(position)) continue;
    const m = masters.get(match[1]) || { hash: match[1], objectKey: entry.current.object_key, recipes: new Set() };
    for (const id of position === 0 ? COVER_RECIPES : GALLERY_RECIPES) m.recipes.add(id);
    masters.set(match[1], m);
  }
  return [...masters.values()];
}

export function missingWork(masters, existingKeys) {
  const work = [];
  for (const m of masters) {
    const missing = [...m.recipes].filter(id => !existingKeys.has(variantObjectKey(m.hash, id)));
    if (missing.length) work.push({ ...m, missing });
  }
  return work;
}

async function readAll(response, limit) {
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('object-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dryRun = process.env.DRY_RUN === '1';
  const maxMasters = Number(process.env.MAX_MASTERS || 0);
  const concurrency = Math.min(16, Math.max(1, Number(process.env.CONCURRENCY || 8)));
  if (!token || !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('missing-cloudflare-secrets');
  // Mismo método que r2-card-stage.mjs: credenciales S3 derivadas del token existente.
  const verify = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, {
    headers: { authorization: 'Bearer ' + token } });
  if (verify.status !== 200) throw new Error('token-verification-failed-' + verify.status);
  const accessKey = (await verify.json()).result?.id, secretKey = sha(token);
  const counters = { GET: 0, PUT: 0, LIST: 0 };
  const s3 = async (method, key, { body, headers, query } = {}) => {
    counters[query ? 'LIST' : method] = (counters[query ? 'LIST' : method] || 0) + 1;
    for (let attempt = 1; ; attempt++) {
      const { url, options } = signS3({ account, accessKey, secretKey, key, query, method, body, headers });
      try {
        const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
        if (res.status >= 500 && attempt < 4) { await res.body?.cancel(); await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
        return res;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  };

  const manifestRes = await s3('GET', MANIFEST_KEY);
  if (manifestRes.status !== 200) throw new Error('manifest-http-' + manifestRes.status);
  const manifest = JSON.parse((await readAll(manifestRes, MAX_MANIFEST_BYTES)).toString('utf8'));
  const masters = plannedVariants(manifest);

  const existing = new Set();
  let token2;
  do {
    const query = { 'list-type': '2', prefix: 'covers/variants/v1/', 'max-keys': '1000', ...(token2 ? { 'continuation-token': token2 } : {}) };
    const res = await s3('GET', '', { query });
    if (res.status !== 200) throw new Error('list-http-' + res.status);
    const xml = await res.text();
    for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) if (VARIANT_KEY_RE.test(key)) existing.add(key);
    token2 = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] : null;
  } while (token2);

  let work = missingWork(masters, existing);
  const plannedTotal = masters.reduce((n, m) => n + m.recipes.size, 0);
  const missingTotal = work.reduce((n, w) => n + w.missing.length, 0);
  console.log(JSON.stringify({ masters: masters.length, variantes_previstas: plannedTotal,
    variantes_existentes: existing.size, variantes_faltantes: missingTotal, masters_con_faltantes: work.length }));
  if (dryRun) return;
  if (maxMasters > 0) work = work.slice(0, maxMasters);

  const { default: sharp } = await import('sharp');
  const result = { creadas: 0, ya_estaban: 0, masters_ok: 0, errores: {}, bytes_subidos: 0 };
  const fail = reason => { result.errores[reason] = (result.errores[reason] || 0) + 1; };
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const item = work[next++];
      try {
        const res = await s3('GET', item.objectKey);
        if (res.status !== 200) { await res.body?.cancel(); fail('master-http-' + res.status); continue; }
        const bytes = await readAll(res, MAX_MASTER_BYTES);
        if (sha(bytes) !== item.hash) { fail('master-sha-mismatch'); continue; }
        const source = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
        for (const id of item.missing) {
          const recipe = IMAGE_VARIANTS.find(r => r.id === id);
          let out;
          try { out = await createVariant(bytes, recipe, sharp); } catch (e) { fail('encode-' + String(e.message).slice(0, 40)); continue; }
          const meta = await sharp(out).metadata();
          if (meta.format !== 'webp' || meta.width !== Math.min(source.width, recipe.width)) { fail('encoded-dimensions'); continue; }
          const digest = sha(out);
          const put = await s3('PUT', variantObjectKey(item.hash, id), { body: out, headers: {
            'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', 'if-none-match': '*',
            'x-amz-meta-master_sha256': item.hash, 'x-amz-meta-recipe': id, 'x-amz-meta-sha256': digest,
            'x-amz-meta-width': String(meta.width), 'x-amz-meta-height': String(meta.height),
            'x-amz-meta-source_width': String(source.width), 'x-amz-meta-source_height': String(source.height),
          } });
          await put.body?.cancel();
          if (put.status === 412) result.ya_estaban++;
          else if (put.status === 200 || put.status === 201) { result.creadas++; result.bytes_subidos += out.length; }
          else fail('put-http-' + put.status);
        }
        result.masters_ok++;
        if (result.masters_ok % 250 === 0) console.log(JSON.stringify({ avance: result.masters_ok, de: work.length, creadas: result.creadas }));
      } catch (e) { fail('error-' + String(e.message).slice(0, 40)); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(JSON.stringify({ ...result, operaciones: counters }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '```json\n' + JSON.stringify({ masters: masters.length, faltantes_antes: missingTotal, ...result, operaciones: counters }, null, 1) + '\n```\n');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error('backfill-failed:', String(error.message).slice(0, 80)); process.exit(1); });
}
