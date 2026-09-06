import { verifiedCoverSource, verifiedNativeCover } from '../functions/_shared/verified-cover-sources.js';
import { dedupeByGtinAndCondition, isEligibleForFeed } from '../functions/feed.xml.js';

export const COVER_MANIFEST_KEY = 'covers/v1/manifest.json';
export const DEFAULT_COVER_BATCH_SIZE = 250;
export const COVER_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const COVER_AI_TRANSFORM_VERSION = 1;

const ALLOWED_HOST_SUFFIX = '.mlstatic.com';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 6;
const MAX_GALLERY_IMAGES = 16;
const TARGET_SHORT_EDGE = 1024;
const TRANSFORM_RETRY_MS = 24 * 60 * 60 * 1000;
const MANIFEST_WRITE_ATTEMPTS = 4;

function emptyManifest(nowIso) {
  return { schema_version: 1, updated_at: nowIso, entries: {} };
}

function normalizedSource(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    const hostname = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) ||
        !(hostname === 'mlstatic.com' || hostname.endsWith(ALLOWED_HOST_SUFFIX))) return null;
    url.protocol = 'https:';
    url.hash = '';
    url.username = '';
    url.password = '';
    url.pathname = url.pathname.replace(/-I\.(jpg|jpeg|png|webp)$/i, '-O.$1');
    return url.toString();
  } catch {
    return null;
  }
}

export function primaryCoverCandidate(item) {
  return coverCandidates(item)[0] || null;
}

export function coverCandidates(item, { includePaused = false } = {}) {
  const isActive = item?.status === 'active' && Number(item.available_quantity) > 0;
  const isPaused = includePaused && item?.status === 'paused';
  if (!isActive && !isPaused) return [];
  const id = String(item.id || '').trim().toUpperCase();
  if (!/^MLU\d+$/.test(id)) return [];
  const pictures = Array.isArray(item.pictures) ? item.pictures : [];
  const sources = [...new Set(
    (pictures.length > 0 ? pictures : [item.thumbnail])
      .map(normalizedSource)
      .filter(Boolean),
  )].slice(0, MAX_GALLERY_IMAGES);
  return sources.map((sourceUrl, position) => ({
    product_id: id,
    position,
    source_url: verifiedCoverSource(id, sourceUrl),
    catalog_product_id: String(item.catalog_product_id || '').trim().toUpperCase() || null,
  }));
}

function validManifest(value) {
  return value?.schema_version === 1 && value.entries &&
    typeof value.entries === 'object' && !Array.isArray(value.entries);
}

async function readManifestState(bucket, nowIso) {
  const object = await bucket.get(COVER_MANIFEST_KEY);
  if (!object) return { manifest: emptyManifest(nowIso), etag: null };
  const parsed = JSON.parse(await object.text());
  if (!validManifest(parsed)) throw new Error('Manifest de portadas R2 inválido.');
  const etag = String(object.etag || object.httpEtag || '').replace(/^"|"$/g, '');
  if (!etag) throw new Error('Manifest de portadas R2 sin ETag; no se puede actualizar de forma atómica.');
  return { manifest: parsed, etag };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeProcessedEntry(freshEntry, processed) {
  const localEntry = processed.entry;
  if (!freshEntry) return localEntry;

  if (processed.status !== 'failed') {
    // Si otra ejecución ya validó la misma entrada mientras esta corrida
    // procesaba sus bytes, nunca hacemos retroceder el puntero `current`.
    return timestamp(localEntry?.last_validated_at) > timestamp(freshEntry?.last_validated_at)
      ? localEntry
      : freshEntry;
  }

  // Un error sólo agrega diagnóstico. La última copia válida leída tras
  // el conflicto gana siempre, incluso si el intento fallido partió de un
  // manifest más viejo.
  const merged = { ...freshEntry };
  if (timestamp(localEntry?.last_error?.at) > timestamp(freshEntry?.last_error?.at)) {
    merged.last_attempted_source_url = localEntry.last_attempted_source_url;
    merged.last_error = localEntry.last_error;
  }
  return merged;
}

async function writeManifestAtomically(bucket, initialState, processedEntries, nowIso) {
  let state = initialState;
  for (let attempt = 0; attempt < MANIFEST_WRITE_ATTEMPTS; attempt++) {
    const nextManifest = {
      ...state.manifest,
      updated_at: timestamp(nowIso) > timestamp(state.manifest.updated_at)
        ? nowIso
        : state.manifest.updated_at,
      entries: { ...state.manifest.entries },
    };
    for (const [key, processed] of processedEntries) {
      nextManifest.entries[key] = mergeProcessedEntry(nextManifest.entries[key], processed);
    }

    const onlyIf = state.etag
      ? { etagMatches: state.etag }
      : { etagDoesNotMatch: '*' };
    const result = await bucket.put(COVER_MANIFEST_KEY, JSON.stringify(nextManifest), {
      onlyIf,
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
    // R2 devuelve null cuando la precondición falla. `undefined` sigue siendo
    // un éxito válido para mocks/implementaciones compatibles con put().
    if (result !== null) return { manifest: nextManifest, retries: attempt };
    state = await readManifestState(bucket, nowIso);
  }
  throw new Error(`Conflicto persistente al publicar ${COVER_MANIFEST_KEY}.`);
}

function needsAiUpscale(entry) {
  const current = entry?.current;
  if (!current?.object_key) return false;
  if (verifiedNativeCover(entry.product_id, current.source_url) &&
      Math.min(Number(current.width) || 0, Number(current.height) || 0) >= 500) return false;
  const shortEdge = Math.min(Number(current.width) || 0, Number(current.height) || 0);
  if (shortEdge >= TARGET_SHORT_EDGE) return false;
  return current.transform?.kind !== 'cloudflare-ai-upscale' ||
    Number(current.transform?.version) !== COVER_AI_TRANSFORM_VERSION;
}

function candidatePriority(candidate, entry, nowMs, aiUpscaleEnabled) {
  if (!entry?.current?.object_key) return 0;
  if (entry.current.source_url !== candidate.source_url) return 1;
  if (aiUpscaleEnabled && needsAiUpscale(entry)) {
    const attempted = Date.parse(entry.last_transform_attempt_at || '');
    if (!Number.isFinite(attempted) || nowMs - attempted >= TRANSFORM_RETRY_MS) return 2;
  }
  const validated = Date.parse(entry.last_validated_at || '');
  if (!Number.isFinite(validated) || nowMs - validated >= COVER_REFRESH_MS) return 3;
  return null;
}

export function selectCoverBatch(catalog, manifest, {
  limit = DEFAULT_COVER_BATCH_SIZE,
  nowMs = Date.now(),
  aiUpscaleEnabled = false,
  aiUpscaleProductIds = null,
  includePaused = false,
  priorityCatalogProductIds = null,
} = {}) {
  const candidates = (Array.isArray(catalog?.items) ? catalog.items : [])
    .flatMap(item => coverCandidates(item, { includePaused }))
    .map(candidate => {
      const entry = manifest?.entries?.[`${candidate.product_id}:${candidate.position}`] || null;
      const aiUpscaleEligible = candidate.position === 0 && aiUpscaleEnabled &&
        !verifiedNativeCover(candidate.product_id, candidate.source_url) &&
        (!aiUpscaleProductIds || aiUpscaleProductIds.has(candidate.product_id));
      return {
        ...candidate,
        entry,
        aiUpscaleEligible,
        preferred: Boolean(priorityCatalogProductIds?.has(candidate.catalog_product_id)),
        priority: candidatePriority(candidate, entry, nowMs, aiUpscaleEligible),
      };
    })
    .filter(candidate => candidate.priority !== null)
    .sort((a, b) => {
      // Merchant solo necesita la posición 0 para publicar el producto.
      // Completar galerías enteras por ID antes de pasar al siguiente libro
      // dejaba miles de ofertas fuera del feed aunque el manifest creciera.
      // Primero cubrimos una portada principal por producto; después usamos
      // la capacidad restante para las imágenes secundarias de la galería.
      const primaryA = a.position === 0;
      const primaryB = b.position === 0;
      if (primaryA !== primaryB) return primaryA ? -1 : 1;
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const validatedA = Date.parse(a.entry?.last_validated_at || '') || 0;
      const validatedB = Date.parse(b.entry?.last_validated_at || '') || 0;
      if (validatedA !== validatedB) return validatedA - validatedB;
      const productOrder = a.product_id.localeCompare(b.product_id);
      return productOrder || a.position - b.position;
    });
  return {
    total_candidates: candidates.length,
    selected: candidates.slice(0, Math.max(0, Number(limit) || 0)),
  };
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngInfo(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { mime: 'image/png', ext: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegInfo(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker) && length >= 7) {
      return {
        mime: 'image/jpeg', ext: 'jpg',
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function webpInfo(bytes) {
  if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null;
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === 'VP8X') {
    return { mime: 'image/webp', ext: 'webp', width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
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

export function inspectCoverBytes(bytes, responseMime) {
  const image = pngInfo(bytes) || jpegInfo(bytes) || webpInfo(bytes);
  if (!image || image.width < 100 || image.height < 100 || image.width > 12_000 || image.height > 12_000) {
    throw new Error('Imagen inválida o con dimensiones fuera de rango.');
  }
  const mime = String(responseMime || '').split(';')[0].trim().toLowerCase();
  if (mime !== image.mime) throw new Error('El Content-Type no coincide con los bytes de imagen.');
  return image;
}

async function readLimitedBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new Error('Imagen mayor a 8 MiB.');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('Tamaño de imagen inválido.');
  return new Uint8Array(buffer);
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function storeImmutable(bucket, bytes, image, nowIso, metadata = {}) {
  const sha256 = await sha256Hex(bytes);
  const objectKey = `covers/v1/objects/${sha256}.${image.ext}`;
  const existing = await bucket.head(objectKey);
  if (existing && Number(existing.size) !== bytes.byteLength) {
    throw new Error('Objeto R2 existente con tamaño incoherente.');
  }
  if (!existing) {
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: image.mime, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { sha256, importedAt: nowIso, sourceHost: 'mlstatic.com', ...metadata },
    });
    const stored = await bucket.head(objectKey);
    if (!stored || Number(stored.size) !== bytes.byteLength) {
      throw new Error('Falló la verificación de escritura en R2.');
    }
  }
  return { objectKey, sha256 };
}

async function readStoredOriginal(bucket, candidate) {
  if (!needsAiUpscale(candidate.entry) || candidate.entry.current.source_url !== candidate.source_url) return null;
  const current = candidate.entry.current;
  const key = current.original_object_key || current.object_key;
  const object = await bucket.get(key);
  if (!object) return null;
  let buffer;
  if (typeof object.arrayBuffer === 'function') buffer = await object.arrayBuffer();
  else if (object.body instanceof Uint8Array) buffer = object.body;
  else if (object.body) buffer = await new Response(object.body).arrayBuffer();
  else return null;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const image = inspectCoverBytes(bytes, current.original_mime || current.mime);
  return {
    bytes,
    image,
    sourceValidators: candidate.entry.source_validators || { etag: null, last_modified: null },
    originalObjectKey: key,
  };
}

async function aiUpscaleCover(imagesBinding, bytes, image) {
  if (!imagesBinding || typeof imagesBinding.input !== 'function' ||
      Math.min(image.width, image.height) >= TARGET_SHORT_EDGE) {
    return null;
  }
  const transform = image.width <= image.height
    ? { width: TARGET_SHORT_EDGE, fit: 'scale-up', upscale: 'generate' }
    : { height: TARGET_SHORT_EDGE, fit: 'scale-up', upscale: 'generate' };
  const stream = new Response(bytes).body;
  const output = await imagesBinding.input(stream)
    .transform(transform)
    .output({ format: 'image/jpeg', quality: 90 });
  const response = output.response();
  if (!response?.ok) throw new Error(`Cloudflare Images respondió HTTP ${response?.status || 500}.`);
  const transformedBytes = await readLimitedBody(response);
  const transformedImage = inspectCoverBytes(transformedBytes, response.headers.get('content-type'));
  if (Math.min(transformedImage.width, transformedImage.height) < TARGET_SHORT_EDGE) {
    throw new Error('Cloudflare Images no alcanzó el lado corto objetivo de 1024 px.');
  }
  return { bytes: transformedBytes, image: transformedImage, transform };
}

async function fetchCover(candidate, fetchFn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(candidate.source_url, {
      headers: {
        accept: 'image/webp,image/png,image/jpeg',
        'user-agent': 'Mozilla/5.0 (compatible; AmadoLibrosCoverMirror/1.0)',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Origen respondió HTTP ${response.status}.`);
    const bytes = await readLimitedBody(response);
    const image = inspectCoverBytes(bytes, response.headers.get('content-type'));
    return {
      bytes,
      image,
      sourceValidators: {
        etag: response.headers.get('etag') || null,
        last_modified: response.headers.get('last-modified') || null,
      },
      originalObjectKey: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function processCover(bucket, candidate, nowIso, fetchFn, imagesBinding) {
  const source = await readStoredOriginal(bucket, candidate) || await fetchCover(candidate, fetchFn);
  if (verifiedNativeCover(candidate.product_id, candidate.source_url) &&
      Math.min(source.image.width, source.image.height) < 500) {
    throw new Error("La fuente nativa verificada ya no alcanza 500 px; se conserva la copia anterior.");
  }
  const originalStored = source.originalObjectKey
    ? { objectKey: source.originalObjectKey, sha256: candidate.entry.current.original_sha256 || candidate.entry.current.sha256 }
    : await storeImmutable(bucket, source.bytes, source.image, nowIso);
  let finalBytes = source.bytes;
  let finalImage = source.image;
  let finalStored = originalStored;
  let transformInfo = null;
  let transformError = null;
  const shouldUpscale = candidate.position === 0 && candidate.aiUpscaleEligible && Boolean(imagesBinding?.input) &&
    Math.min(source.image.width, source.image.height) < TARGET_SHORT_EDGE;
  if (shouldUpscale) {
    try {
      const transformed = await aiUpscaleCover(imagesBinding, source.bytes, source.image);
      if (transformed) {
        finalBytes = transformed.bytes;
        finalImage = transformed.image;
        finalStored = await storeImmutable(bucket, finalBytes, finalImage, nowIso, {
          transformedBy: 'cloudflare-images-ai',
          originalSha256: originalStored.sha256,
        });
        transformInfo = {
          kind: 'cloudflare-ai-upscale',
          version: COVER_AI_TRANSFORM_VERSION,
          target_short_edge: TARGET_SHORT_EDGE,
          original_width: source.image.width,
          original_height: source.image.height,
        };
      }
    } catch (error) {
      transformError = String(error?.message || 'Error').slice(0, 240);
    }
  }
  const previousKey = candidate.entry?.current?.object_key || null;
  return {
    entry: {
      product_id: candidate.product_id,
      position: candidate.position,
      current: {
        object_key: finalStored.objectKey,
        sha256: finalStored.sha256,
        bytes: finalBytes.byteLength,
        mime: finalImage.mime,
        width: finalImage.width,
        height: finalImage.height,
        original_object_key: originalStored.objectKey,
        original_sha256: originalStored.sha256,
        original_mime: source.image.mime,
        source_url: candidate.source_url,
        imported_at: nowIso,
        transform: transformInfo,
      },
      previous_object_key: previousKey && previousKey !== finalStored.objectKey ? previousKey : candidate.entry?.previous_object_key || null,
      source_validators: source.sourceValidators,
      last_validated_at: nowIso,
      last_transform_attempt_at: shouldUpscale ? nowIso : candidate.entry?.last_transform_attempt_at || null,
      last_transform_error: transformError ? { at: nowIso, message: transformError } : null,
      last_error: null,
    },
    status: previousKey === finalStored.objectKey ? 'revalidated' : 'imported',
    quality_status: transformInfo ? 'ai-upscaled' : transformError ? 'original-retained' : 'native',
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function syncCoverMirror(env, catalog, {
  fetchFn = fetch,
  now = () => new Date(),
  limit = Number(env?.COVER_MIRROR_BATCH_SIZE || DEFAULT_COVER_BATCH_SIZE),
  concurrency = DEFAULT_CONCURRENCY,
  includePaused = false,
} = {}) {
  const bucket = env?.COVER_R2;
  if (!bucket || typeof bucket.get !== 'function' || typeof bucket.put !== 'function' || typeof bucket.head !== 'function') {
    return { status: 'disabled', reason: 'cover-r2-binding-missing' };
  }
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const manifestState = await readManifestState(bucket, nowIso);
  const manifest = manifestState.manifest;
  const aiUpscaleEnabled = Boolean(env?.IMAGES && typeof env.IMAGES.input === 'function');
  // La mejora generativa se reserva para la portada primaria del mismo
  // universo deduplicado que recibe Merchant. Las imágenes secundarias se
  // copian sin alterarlas para no inventar texto ni accesorios del producto.
  const merchantItems = dedupeByGtinAndCondition(
    (Array.isArray(catalog?.items) ? catalog.items : []).filter(isEligibleForFeed),
  );
  const aiUpscaleProductIds = new Set(merchantItems.map(item => String(item.id || '').toUpperCase()));
  const priorityCatalogProductIds = new Set(String(env?.ML_CATALOG_GALLERY_PRIORITY_IDS || '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(value => /^MLU\d+$/.test(value)));
  const batch = selectCoverBatch(catalog, manifest, {
    limit,
    nowMs: nowDate.getTime(),
    aiUpscaleEnabled,
    aiUpscaleProductIds,
    includePaused,
    priorityCatalogProductIds,
  });
  const processedEntries = new Map();
  const results = await mapWithConcurrency(batch.selected, Math.max(1, Number(concurrency) || 1), async candidate => {
    const key = `${candidate.product_id}:${candidate.position}`;
    try {
      const result = await processCover(
        bucket,
        candidate,
        nowIso,
        fetchFn,
        candidate.aiUpscaleEligible ? env?.IMAGES : null,
      );
      processedEntries.set(key, { entry: result.entry, status: result.status });
      return { key, status: result.status, quality_status: result.quality_status };
    } catch (error) {
      const entry = {
        ...(candidate.entry || { product_id: candidate.product_id, position: candidate.position, current: null }),
        last_attempted_source_url: candidate.source_url,
        last_error: { at: nowIso, message: String(error?.message || 'Error').slice(0, 240) },
      };
      processedEntries.set(key, { entry, status: 'failed' });
      return { key, status: 'failed', error: String(error?.message || 'Error').slice(0, 160) };
    }
  });
  let finalManifest = manifest;
  let manifestRetries = 0;
  if (batch.selected.length > 0) {
    const written = await writeManifestAtomically(bucket, manifestState, processedEntries, nowIso);
    finalManifest = written.manifest;
    manifestRetries = written.retries;
  }
  const validCopies = Object.values(finalManifest.entries).filter(entry => entry?.current?.object_key).length;
  const imported = results.filter(result => ['imported', 'revalidated'].includes(result.status)).length;
  const failed = results.filter(result => result.status === 'failed').length;
  const aiUpscaled = Object.values(finalManifest.entries).filter(entry =>
    entry?.current?.transform?.kind === 'cloudflare-ai-upscale' &&
    Number(entry.current.transform.version) === COVER_AI_TRANSFORM_VERSION &&
    Math.min(Number(entry.current.width) || 0, Number(entry.current.height) || 0) >= TARGET_SHORT_EDGE
  ).length;
  const qualityPending = aiUpscaleEnabled
    ? Object.values(finalManifest.entries).filter(entry =>
        Number(entry?.position) === 0 &&
        aiUpscaleProductIds.has(String(entry?.product_id || '').toUpperCase()) && needsAiUpscale(entry)
      ).length
    : null;
  return {
    status: 'completed',
    attempted: results.length,
    imported,
    failed,
    // Un intento fallido sigue pendiente. Sin esto, el último lote podía
    // declarar terminado el backfill y bajar prematuramente la frecuencia
    // de reintento de 5 minutos a una hora.
    pending: Math.max(0, batch.total_candidates - imported),
    valid_copies: validCopies,
    ai_upscaled: aiUpscaled,
    quality_pending: qualityPending,
    manifest_retries: manifestRetries,
    results,
  };
}
