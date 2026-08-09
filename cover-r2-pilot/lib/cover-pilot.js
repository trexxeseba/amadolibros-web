export const MAX_IMPORT_ITEMS = 20;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const MANIFEST_KEY = 'covers/v1/manifest.json';

const ALLOWED_HOST = 'http2.mlstatic.com';
const MIN_DIMENSION = 100;
const MAX_DIMENSION = 12_000;
const FETCH_TIMEOUT_MS = 12_000;

class PilotError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function emptyManifest(nowIso) {
  return {
    schema_version: 1,
    updated_at: nowIso,
    entries: {},
  };
}

function isManifest(value) {
  return value && value.schema_version === 1 &&
    typeof value.updated_at === 'string' &&
    value.entries && typeof value.entries === 'object' &&
    !Array.isArray(value.entries);
}

export async function readManifest(bucket, nowIso = new Date().toISOString()) {
  const object = await bucket.get(MANIFEST_KEY);
  if (!object) return emptyManifest(nowIso);
  let parsed;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    throw new PilotError(503, 'MANIFEST_INVALID', 'El manifest no es JSON válido.');
  }
  if (!isManifest(parsed)) {
    throw new PilotError(503, 'MANIFEST_INVALID', 'El manifest no tiene el esquema esperado.');
  }
  return parsed;
}

export function manifestSummary(manifest) {
  const entries = Object.values(manifest.entries || {});
  return {
    updated_at: manifest.updated_at,
    entries: entries.length,
    with_valid_copy: entries.filter(entry => entry?.current?.object_key).length,
    with_last_error: entries.filter(entry => entry?.last_error).length,
  };
}

function validateSourceUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PilotError(400, 'SOURCE_URL_INVALID', 'URL de imagen inválida.');
  }
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || url.username || url.password) {
    throw new PilotError(
      400,
      'SOURCE_HOST_NOT_ALLOWED',
      `Sólo se acepta https://${ALLOWED_HOST}/.`,
    );
  }
  url.hash = '';
  return url.toString();
}

function normalizeItems(payload) {
  if (!payload || !Array.isArray(payload.items)) {
    throw new PilotError(400, 'ITEMS_REQUIRED', 'items debe ser un array.');
  }
  if (payload.items.length === 0) {
    throw new PilotError(400, 'ITEMS_EMPTY', 'items no puede estar vacío.');
  }
  if (payload.items.length > MAX_IMPORT_ITEMS) {
    throw new PilotError(
      400,
      'ITEM_LIMIT_EXCEEDED',
      `Máximo ${MAX_IMPORT_ITEMS} imágenes por ejecución.`,
    );
  }

  const seen = new Set();
  return payload.items.map((item, index) => {
    const productId = typeof item?.product_id === 'string' ? item.product_id.trim() : '';
    const position = Number(item?.position);
    if (!/^MLU\d{6,20}$/.test(productId)) {
      throw new PilotError(400, 'PRODUCT_ID_INVALID', `product_id inválido en items[${index}].`);
    }
    if (!Number.isInteger(position) || position < 0 || position > 15) {
      throw new PilotError(400, 'POSITION_INVALID', `position inválida en items[${index}].`);
    }
    const key = `${productId}:${position}`;
    if (seen.has(key)) {
      throw new PilotError(400, 'ITEM_DUPLICATED', `Entrada duplicada: ${key}.`);
    }
    seen.add(key);
    return {
      key,
      product_id: productId,
      position,
      source_url: validateSourceUrl(item.url),
    };
  });
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngInfo(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const end = bytes.length - 12;
  if (end < 33 || String.fromCharCode(...bytes.slice(end + 4, end + 8)) !== 'IEND') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { mime: 'image/png', ext: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegInfo(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { mime: 'image/jpeg', ext: 'jpg', width, height };
    }
    offset += length;
  }
  return null;
}

function webpInfo(bytes) {
  if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null;
  const declaredSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
  if (declaredSize !== bytes.length) return null;
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === 'VP8X') {
    return {
      mime: 'image/webp', ext: 'webp',
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return {
      mime: 'image/webp', ext: 'webp',
      width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
      height: 1 + (((bytes[22] & 0xc0) >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    };
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      mime: 'image/webp', ext: 'webp',
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  return null;
}

function inspectImage(bytes, responseMime) {
  const info = pngInfo(bytes) || jpegInfo(bytes) || webpInfo(bytes);
  if (!info) {
    throw new PilotError(422, 'IMAGE_SIGNATURE_INVALID', 'Firma o estructura de imagen inválida.');
  }
  const normalizedMime = String(responseMime || '').split(';')[0].trim().toLowerCase();
  if (normalizedMime !== info.mime) {
    throw new PilotError(422, 'IMAGE_MIME_MISMATCH', 'Content-Type no coincide con el archivo.');
  }
  if (info.width < MIN_DIMENSION || info.height < MIN_DIMENSION ||
      info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
    throw new PilotError(422, 'IMAGE_DIMENSIONS_INVALID', 'Dimensiones fuera del rango permitido.');
  }
  return info;
}

async function readLimitedBody(response) {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new PilotError(413, 'IMAGE_TOO_LARGE', 'La imagen excede 8 MiB.');
  }
  if (!response.body) throw new PilotError(502, 'IMAGE_BODY_MISSING', 'Respuesta sin cuerpo.');

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new PilotError(413, 'IMAGE_TOO_LARGE', 'La imagen excede 8 MiB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

function dueForRefresh(entry, sourceUrl, nowMs) {
  if (!entry?.current) return true;
  if (entry.current.source_url !== sourceUrl) return true;
  const lastValidated = Date.parse(entry.last_validated_at || '');
  return !Number.isFinite(lastValidated) || nowMs - lastValidated >= REFRESH_AFTER_MS;
}

async function fetchSource(item, entry, fetchFn) {
  const headers = { Accept: 'image/webp,image/png,image/jpeg' };
  const sameSource = entry?.current?.source_url === item.source_url;
  if (sameSource && entry.source_validators?.etag) {
    headers['If-None-Match'] = entry.source_validators.etag;
  }
  if (sameSource && entry.source_validators?.last_modified) {
    headers['If-Modified-Since'] = entry.source_validators.last_modified;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(item.source_url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status !== 304 && response.status >= 300 && response.status < 400) {
      throw new PilotError(502, 'SOURCE_REDIRECT_REJECTED', 'Mercado Libre respondió con una redirección.');
    }
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new PilotError(504, 'SOURCE_TIMEOUT', 'La descarga excedió 12 segundos.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeError(error, nowIso) {
  return {
    at: nowIso,
    code: String(error?.code || 'SOURCE_IMPORT_FAILED').slice(0, 80),
    message: String(error?.message || 'Error de importación.').slice(0, 240),
  };
}

async function processItem(bucket, item, entry, nowIso, nowMs, fetchFn) {
  if (!dueForRefresh(entry, item.source_url, nowMs)) {
    return { entry, result: { key: item.key, status: 'fresh-skip', object_key: entry.current.object_key } };
  }

  const response = await fetchSource(item, entry, fetchFn);
  if (response.status === 304 && entry?.current) {
    return {
      entry: { ...entry, last_validated_at: nowIso, last_error: null },
      result: { key: item.key, status: 'not-modified', object_key: entry.current.object_key },
    };
  }
  if (!response.ok) {
    throw new PilotError(502, 'SOURCE_HTTP_ERROR', `Mercado Libre respondió HTTP ${response.status}.`);
  }

  const bytes = await readLimitedBody(response);
  const image = inspectImage(bytes, response.headers.get('Content-Type'));
  const hash = await sha256Hex(bytes);
  const objectKey = `covers/v1/objects/${hash}.${image.ext}`;
  const existing = typeof bucket.head === 'function' ? await bucket.head(objectKey) : null;

  if (existing && Number(existing.size) !== bytes.byteLength) {
    throw new PilotError(
      503,
      'R2_EXISTING_OBJECT_INVALID',
      'Ya existe un objeto con el mismo hash pero tamaño incoherente.',
    );
  }

  if (!existing) {
    await bucket.put(objectKey, bytes, {
      httpMetadata: {
        contentType: image.mime,
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        sha256: hash,
        importedAt: nowIso,
        sourceHost: ALLOWED_HOST,
      },
    });
    if (typeof bucket.head !== 'function') {
      throw new PilotError(503, 'R2_HEAD_UNAVAILABLE', 'R2 no permite verificar la escritura.');
    }
    const stored = await bucket.head(objectKey);
    if (!stored || Number(stored.size) !== bytes.byteLength) {
      throw new PilotError(503, 'R2_READBACK_FAILED', 'La verificación de la copia en R2 falló.');
    }
  }

  const previousObjectKey = entry?.current?.object_key || null;
  const nextEntry = {
    product_id: item.product_id,
    position: item.position,
    current: {
      object_key: objectKey,
      sha256: hash,
      bytes: bytes.byteLength,
      mime: image.mime,
      width: image.width,
      height: image.height,
      source_url: item.source_url,
      imported_at: nowIso,
    },
    previous_object_key: previousObjectKey !== objectKey ? previousObjectKey : entry?.previous_object_key || null,
    source_validators: {
      etag: response.headers.get('ETag') || null,
      last_modified: response.headers.get('Last-Modified') || null,
    },
    last_validated_at: nowIso,
    last_error: null,
  };
  return {
    entry: nextEntry,
    result: {
      key: item.key,
      status: previousObjectKey === objectKey ? 'revalidated' : 'imported',
      object_key: objectKey,
      replaced_previous: Boolean(previousObjectKey && previousObjectKey !== objectKey),
    },
  };
}

export async function importCovers(env, payload, {
  fetchFn = fetch,
  now = () => new Date(),
} = {}) {
  const items = normalizeItems(payload);
  const bucket = env?.COVER_R2;
  if (!bucket || typeof bucket.get !== 'function' || typeof bucket.put !== 'function') {
    throw new PilotError(503, 'R2_BINDING_MISSING', 'Binding COVER_R2 no disponible.');
  }
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const manifest = await readManifest(bucket, nowIso);
  const nextManifest = {
    ...manifest,
    updated_at: nowIso,
    entries: { ...manifest.entries },
  };
  const results = [];

  // Secuencial a propósito: el piloto reduce presión sobre mlstatic y evita
  // que una sola ejecución dispare 20 descargas simultáneas.
  for (const item of items) {
    const previous = nextManifest.entries[item.key] || null;
    try {
      const processed = await processItem(bucket, item, previous, nowIso, nowMs, fetchFn);
      nextManifest.entries[item.key] = processed.entry;
      results.push(processed.result);
    } catch (error) {
      nextManifest.entries[item.key] = {
        ...(previous || { product_id: item.product_id, position: item.position, current: null }),
        last_attempted_source_url: item.source_url,
        last_error: safeError(error, nowIso),
      };
      results.push({
        key: item.key,
        status: 'failed',
        code: error.code || 'SOURCE_IMPORT_FAILED',
        retained_previous: Boolean(previous?.current?.object_key),
      });
    }
  }

  // Único puntero mutable, escrito al final. Una falla previa conserva el
  // manifest anterior; una falla acá puede dejar sólo un objeto huérfano.
  await bucket.put(MANIFEST_KEY, JSON.stringify(nextManifest), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });

  return {
    status: 'completed',
    attempted: results.length,
    imported: results.filter(result => ['imported', 'revalidated'].includes(result.status)).length,
    unchanged: results.filter(result => ['fresh-skip', 'not-modified'].includes(result.status)).length,
    failed: results.filter(result => result.status === 'failed').length,
    manifest_key: MANIFEST_KEY,
    results,
  };
}
