import {
  CF_CARD_VARIANTS, CF_ENCODER, CF_VARIANT_VERSION, VARIANT_VERSION, imageVariant, variantObjectKey, variantVersion,
} from '../shared/image-variants.js';
import { inspectCoverBytes } from './cover-mirror.js';
import { webpDimensions } from './image-variants-api.js';

// Generador privado de variantes v2 (Cloudflare Images) con cupo persistente.
// Núcleo sin I/O propio: recibe buckets R2 y el binding IMAGES. Ningún camino
// público lo invoca; las visitas nunca generan imágenes.
//
// Presupuesto: USD 20/mes para imágenes = 15 generación + 5 reserva. A USD 0,50
// por 1.000 transformaciones y SIN descontar la cuota incluida, 30.000 intentos
// = USD 15. La reserva (10.000) no es utilizable por este job.
export const LEDGER_SCHEMA = 'card-generation-ledger-v1';
export const GENERATION_CAP_CEILING = 30_000;
export const RESERVE_ATTEMPTS = 10_000;
export const MAX_ITEM_ATTEMPTS = 2;
export const LEASE_MS = 120_000;
export const MAX_FAILURE_RECORDS = 500;
// Cada receta revisada cuesta hasta dos HEAD; 100 ítems × 3 recetas × 2 queda bajo
// el límite de subrequests de un Worker. Se valida en Preview, no se da por supuesto.
export const MAX_ITEMS_SCANNED_PER_RUN = 100;
const MAX_VARIANT_BYTES = 8 * 1024 * 1024;
const MAX_MASTER_BYTES = 8 * 1024 * 1024;
const IMAGES_TIMEOUT_MS = 30_000;
const HASH = /^[a-f0-9]{64}$/;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const RECIPES = CF_CARD_VARIANTS.map(r => r.id);

export const ledgerKey = period => `covers/generation-ledger/v2/${period}/ledger.json`;
export const periodOf = now => new Date(now).toISOString().slice(0, 7);
// Web Crypto (no node:crypto): el Worker no depende de nodejs_compat.
const sha256 = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const stop = (reason, result) => { result.stopped = reason; return result; };

function validateLedger(ledger, period) {
  const ok = ledger?.schema === LEDGER_SCHEMA && ledger.period === period && ledger.encoder === CF_ENCODER &&
    Number.isSafeInteger(ledger.cap_attempts) && ledger.cap_attempts >= 1 && ledger.cap_attempts <= GENERATION_CAP_CEILING &&
    (ledger.max_new_attempts === undefined || (Number.isSafeInteger(ledger.max_new_attempts) && ledger.max_new_attempts >= 1 && ledger.max_new_attempts <= ledger.cap_attempts)) &&
    (ledger.usage_floor === undefined || (isCount(ledger.usage_floor?.billed) && isCount(ledger.usage_floor.consumed_at) && ledger.usage_floor.consumed_at <= ledger.consumed)) &&
    isCount(ledger.prior_consumed) && isCount(ledger.consumed) && isCount(ledger.succeeded) && isCount(ledger.failed) &&
    ledger.failures && typeof ledger.failures === 'object' && !Array.isArray(ledger.failures) &&
    Object.keys(ledger.failures).length <= MAX_FAILURE_RECORDS &&
    (ledger.lease === null || (typeof ledger.lease?.holder === 'string' && Number.isFinite(Date.parse(ledger.lease.expires_at)))) &&
    isCount(ledger.progress?.next_index) && (ledger.progress.plan_sha256 === null || HASH.test(ledger.progress.plan_sha256));
  if (!ok) throw new Error('ledger-invalid');
  return ledger;
}

export async function readLedger(bucket, period) {
  const object = await bucket.get(ledgerKey(period));
  if (!object) throw new Error('ledger-missing');
  return { ledger: validateLedger(JSON.parse(await object.text()), period), etag: object.etag };
}

// Informe de uso de transformaciones del período, obtenido de la cuenta con el
// acceso ya configurado (nunca tipeado a mano ni asumido en 0). `raw_sha256`
// liga el número a la captura cruda que lo respalda.
export const USAGE_SOURCE = 'cloudflare-billable-usage';
export const MAX_USAGE_AGE_MS = 24 * 3600 * 1000;
export function validateUsageReport(usage, nowMs, period) {
  const observed = Date.parse(usage?.observed_at);
  if (usage?.source !== USAGE_SOURCE || usage.period !== period || !isCount(usage.billed_transformations) ||
      !HASH.test(usage.raw_sha256 || '') || !Number.isFinite(observed) ||
      observed > nowMs + 5 * 60_000 || nowMs - observed > MAX_USAGE_AGE_MS) throw new Error('usage-unavailable');
  return usage;
}

// Creación explícita, una sola vez por período. El consumo previo sale del
// informe de uso validado: nunca se asume 0.
// `capAttempts`: techo ABSOLUTO de transformaciones de la cuenta en el mes (incluye
// el consumo previo). `maxNewAttempts`: tope RELATIVO, inmutable, de intentos que
// este libro mayor puede reservar (el piloto lo usa para quedar en ~32).
export async function initLedger(bucket, { now, capAttempts, maxNewAttempts, usage }) {
  if (!Number.isSafeInteger(capAttempts) || capAttempts < 1 || capAttempts > GENERATION_CAP_CEILING) throw new Error('invalid-cap');
  const period = periodOf(now), at = new Date(now).toISOString();
  validateUsageReport(usage, now, period);
  if (maxNewAttempts !== undefined && (!Number.isSafeInteger(maxNewAttempts) || maxNewAttempts < 1 || maxNewAttempts > capAttempts)) throw new Error('invalid-max-new-attempts');
  const priorConsumed = usage.billed_transformations;
  if (priorConsumed > capAttempts) throw new Error('invalid-prior-consumed');
  const ledger = { schema: LEDGER_SCHEMA, period, encoder: CF_ENCODER, cap_attempts: capAttempts, prior_consumed: priorConsumed,
    ...(maxNewAttempts === undefined ? {} : { max_new_attempts: maxNewAttempts }),
    // Piso persistente: lo más alto observado de la cuenta; un informe posterior menor jamás lo baja.
    usage_floor: { billed: priorConsumed, consumed_at: 0 },
    prior_source: usage.source, prior_observed_at: usage.observed_at, prior_raw_sha256: usage.raw_sha256,
    consumed: 0, succeeded: 0, failed: 0, failures: {}, lease: null,
    progress: { plan_sha256: null, next_index: 0, updated_at: at }, created_at: at, updated_at: at };
  const stored = await bucket.put(ledgerKey(period), JSON.stringify(ledger), {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
  if (!stored) throw new Error('ledger-exists');
  return ledger;
}

export async function validateGenerationPlan(plan, approval) {
  if (plan?.schema !== 'card-generation-plan-v2' || JSON.stringify(plan.recipes) !== JSON.stringify(RECIPES) ||
      !Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > 10_000) throw new Error('invalid-plan');
  const seen = new Set();
  for (const item of plan.items) {
    const match = /^([a-f0-9]{64})\.(jpg|png|webp)$/.exec(item?.file || '');
    if (!match || seen.has(match[1]) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_MASTER_BYTES ||
        !Array.isArray(item.recipes) || item.recipes.length < 1 || new Set(item.recipes).size !== item.recipes.length ||
        !item.recipes.every(id => RECIPES.includes(id))) throw new Error('invalid-plan-item');
    seen.add(match[1]);
  }
  const digest = await sha256(JSON.stringify(plan.items));
  if (digest !== plan.items_sha256 || approval !== digest) throw new Error('plan-not-approved');
  return digest;
}

function validVariantHead(head, hash, id) {
  const m = head?.customMetadata;
  return Boolean(head && head.size > 0 && head.httpMetadata?.contentType === 'image/webp' &&
    m?.master_sha256 === hash && m.recipe === id && m.encoder === CF_ENCODER && HASH.test(m.sha256 || ''));
}

// Sólo códigos conocidos llegan al libro mayor y a los informes: nunca texto
// libre de una excepción (podría incluir URLs o datos internos).
const KNOWN_ERRORS = /^(images-timeout|images-http-\d{3}|output-size-invalid|dimensions-or-aspect-ratio-mismatch|invalid-webp)$/;
const errorCode = error => KNOWN_ERRORS.test(error?.message || '') ? error.message : 'images-error';

// Lectura acotada del cuerpo: nunca más de `max` bytes en memoria.
async function readBounded(response, max) {
  if (!response.body) throw new Error('output-size-invalid');
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('output-size-invalid'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function timed(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

export async function runGeneration({ bucket, sourceBucket, images, plan, approval, usage, clock = Date.now, limit = 20, holder,
  imagesTimeoutMs = IMAGES_TIMEOUT_MS }) {
  const result = { attempts: 0, created: 0, existing: 0, skipped: [], failures: [], conflicts: [], stopped: null };
  if (!bucket || !sourceBucket || typeof images?.input !== 'function' || typeof holder !== 'string' || !holder ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return stop('invalid-configuration', result);
  let planDigest;
  try { planDigest = await validateGenerationPlan(plan, approval); } catch (error) { return stop(error.message, result); }
  const period = periodOf(clock());
  // Otros usos de Images también gastan el mismo cupo: sin un informe de uso
  // fresco del período no se genera nada (antes de leer masters o llamar a Images).
  try { validateUsageReport(usage, clock(), period); } catch { return stop('usage-unavailable', result); }
  let state;
  try { state = await readLedger(bucket, period); } catch (error) { return stop(error.message === 'ledger-missing' ? 'ledger-missing' : 'ledger-unavailable', result); }

  // Toda escritura del libro mayor es compare-and-swap sobre el ETag leído.
  // Un conflicto o una falla detiene el job; jamás se reintenta a ciegas.
  async function commit(mutate) {
    const next = structuredClone(state.ledger);
    mutate(next);
    next.updated_at = new Date(clock()).toISOString();
    validateLedger(next, period);
    const stored = await bucket.put(ledgerKey(period), JSON.stringify(next), {
      onlyIf: { etagMatches: state.etag }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
    if (!stored) throw new Error('ledger-conflict');
    state = { ledger: next, etag: stored.etag };
  }
  const leaseUntil = () => new Date(clock() + LEASE_MS).toISOString();

  try {
    // Serialización: un único titular con arrendamiento vigente.
    const lease = state.ledger.lease;
    if (lease && lease.holder !== holder && Date.parse(lease.expires_at) > clock()) return stop('job-running', result);
    const stale = lease?.pending || null;
    let staleSucceeded = false;
    if (stale) {
      const [hash, id] = String(stale.key).split('/');
      const staleKey = variantObjectKey(hash, id);
      staleSucceeded = staleKey ? validVariantHead(await bucket.head(staleKey), hash, id) : false;
    }
    await commit(l => {
      if (stale) {
        if (staleSucceeded) { l.succeeded++; delete l.failures[stale.key]; }
        else { l.failed++; l.failures[stale.key] = { n: (l.failures[stale.key]?.n || 0) + 1, last_error: 'interrupted', at: l.updated_at }; }
      }
      l.lease = { holder, expires_at: leaseUntil(), pending: null };
      // Piso persistente del consumo observado: sólo sube. Un informe menor (retraso,
      // reintento de consulta, datos parciales) no libera cupo ya observado como gastado.
      const floorNow = l.usage_floor ? l.usage_floor.billed + (l.consumed - l.usage_floor.consumed_at) : 0;
      if (!l.usage_floor || usage.billed_transformations > floorNow) l.usage_floor = { billed: usage.billed_transformations, consumed_at: l.consumed };
      l.last_usage = { billed_transformations: usage.billed_transformations, observed_at: usage.observed_at, raw_sha256: usage.raw_sha256 };
      if (l.progress.plan_sha256 !== planDigest) l.progress = { plan_sha256: planDigest, next_index: 0, updated_at: l.updated_at };
    });
  } catch (error) { return stop(error.message === 'ledger-conflict' ? 'ledger-conflict' : 'ledger-unavailable', result); }

  const start = state.ledger.progress.next_index;
  const end = Math.min(plan.items.length, start + MAX_ITEMS_SCANNED_PER_RUN);
  let frontier = null; // primer índice no resuelto de forma definitiva

  try {
    for (let index = start; index < end; index++) {
      const item = plan.items[index];
      const hash = item.file.slice(0, 64), extension = item.file.slice(65);
      let master = null, unresolved = false;
      for (const id of item.recipes) {
        const key = variantObjectKey(hash, id), ref = `${hash}/${id}`;
        const head = await bucket.head(key);
        if (head) {
          if (validVariantHead(head, hash, id)) { result.existing++; continue; }
          result.conflicts.push(ref); continue; // nunca se sobrescribe un objeto existente
        }
        const width = imageVariant(id).width;
        const v1Id = `${VARIANT_VERSION}-${width}-q85`;
        const v1 = await sourceBucket.head(variantObjectKey(hash, v1Id));
        if (v1?.size > 0 && v1.customMetadata?.master_sha256 === hash && v1.customMetadata.recipe === v1Id) {
          result.skipped.push({ ref, reason: 'v1-exists' }); continue;
        }
        if ((state.ledger.failures[ref]?.n || 0) >= MAX_ITEM_ATTEMPTS) { result.skipped.push({ ref, reason: 'retry-limit' }); continue; }
        if (result.attempts >= limit) { unresolved = true; result.stopped = 'run-limit'; break; }

        // Si cruzamos medianoche UTC del último día, ningún intento nuevo se carga al mes anterior.
        if (periodOf(clock()) !== period) { unresolved = true; result.stopped = 'period-changed'; break; }
        // Gasto efectivo: lo que sabemos que gastamos o el piso observado de la cuenta
        // más lo gastado desde entonces, lo mayor. La facturación puede retrasarse:
        // ese margen es lo que cubre la reserva de USD 5.
        const floor = state.ledger.usage_floor;
        const spent = Math.max(state.ledger.prior_consumed + state.ledger.consumed, floor.billed + (state.ledger.consumed - floor.consumed_at));
        if (spent + 1 > state.ledger.cap_attempts || state.ledger.consumed + 1 > (state.ledger.max_new_attempts ?? state.ledger.cap_attempts)) { unresolved = true; result.stopped = 'budget-exhausted'; break; }
        // Fuente validada antes de reservar: una fuente inválida no gasta cupo.
        if (!master) {
          const object = await sourceBucket.get(`covers/v1/objects/${item.file}`);
          const bytes = object?.body && object.size <= MAX_MASTER_BYTES ? new Uint8Array(await new Response(object.body).arrayBuffer()) : null;
          let info = null;
          try { info = bytes && bytes.length === item.size && await sha256(bytes) === hash ? inspectCoverBytes(bytes, MIME[extension]) : null; } catch { info = null; }
          if (!info || (item.width && (item.width !== info.width || item.height !== info.height))) {
            result.failures.push({ ref: item.file, reason: 'master-invalid' }); break; // sin gasto; requiere revisión manual
          }
          master = { bytes, info };
        }

        // 1) Reservar y persistir el intento ANTES de llamar a Images.
        await commit(l => { l.consumed++; l.lease = { holder, expires_at: leaseUntil(), pending: { key: ref, at: l.updated_at } }; });
        result.attempts++;

        // 2) Transformar. Todo error ya está contado como intento consumido.
        let outcome = null, error = null;
        try {
          let live = null;
          const bytes = await timed((async () => {
            const out = await images.input(new Response(master.bytes).body)
              .transform({ width, fit: 'scale-down' }).output({ format: 'image/webp', quality: 85, anim: false });
            const response = out.response(); live = response;
            if (!response?.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') throw new Error(`images-http-${response?.status || 500}`);
            // La lectura completa del cuerpo cuenta dentro del mismo plazo.
            return readBounded(response, MAX_VARIANT_BYTES);
          })(), imagesTimeoutMs, 'images-timeout').catch(async failure => { await live?.body?.cancel?.().catch(() => {}); throw failure; });
          if (!bytes.length) throw new Error('output-size-invalid');
          const dimensions = webpDimensions(bytes);
          const expectedWidth = Math.min(master.info.width, width);
          const expectedHeight = Math.max(1, Math.round(master.info.height * expectedWidth / master.info.width));
          if (dimensions.width !== expectedWidth || Math.abs(dimensions.height - expectedHeight) > 1) throw new Error('dimensions-or-aspect-ratio-mismatch');
          const digest = await sha256(bytes);
          const stored = await bucket.put(key, bytes, {
            onlyIf: { etagDoesNotMatch: '*' },
            httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
            customMetadata: { master_sha256: hash, recipe: id, sha256: digest, encoder: CF_ENCODER,
              width: String(dimensions.width), height: String(dimensions.height),
              source_width: String(master.info.width), source_height: String(master.info.height),
              bytes: String(bytes.length) } });
          outcome = stored ? 'created' : 'existing';
        } catch (caught) { error = errorCode(caught); }

        // 3) Registrar el resultado. Si esto falla se detiene; el próximo job
        // reconcilia el intento pendiente consultando el objeto en R2.
        await commit(l => {
          l.lease = { holder, expires_at: leaseUntil(), pending: null };
          if (error) { l.failed++; l.failures[ref] = { n: (l.failures[ref]?.n || 0) + 1, last_error: error, at: l.updated_at }; }
          else { l.succeeded++; delete l.failures[ref]; }
        });
        // `||=`: un fallo posterior del mismo libro nunca borra la marca de otro que aún admite reintento.
        if (error) { result.failures.push({ ref, reason: error }); unresolved ||= (state.ledger.failures[ref]?.n || 0) < MAX_ITEM_ATTEMPTS; }
        else if (outcome === 'created') result.created++; else result.existing++;
      }
      if (unresolved && frontier === null) frontier = index;
      if (result.stopped) break;
    }
  } catch (error) {
    result.stopped = error.message === 'ledger-conflict' ? 'ledger-conflict' : 'ledger-unavailable';
    return result; // sin escribir más: el arrendamiento caduca solo
  }

  // Cierre: avanzar el cursor sólo sobre ítems resueltos y liberar el arrendamiento.
  const scannedAll = !result.stopped && end === plan.items.length;
  const next = frontier ?? (result.stopped && result.stopped !== 'run-limit' ? start : end);
  try {
    await commit(l => { l.lease = null; l.progress = { plan_sha256: planDigest, next_index: Math.max(l.progress.next_index, Math.min(next, plan.items.length)), updated_at: l.updated_at }; });
  } catch { result.releaseFailed = true; }
  result.complete = scannedAll && frontier === null;
  return result;
}
