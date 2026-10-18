import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { webpDimensions } from '../../worker-sync/image-variants-api.js';
import { CF_CARD_VARIANTS, CF_ENCODER } from '../../shared/image-variants.js';
import { pilotClient } from './pilot-client.mjs';

const PILOT_MAX_NEW_ATTEMPTS = 32;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;

// Verifica, contra el Worker de Preview, el piloto completo. Se detiene en el primer
// paso fallido: nada se continúa sobre un resultado dudoso. Nunca toca producción.
export async function runPilotCheck({ call, selection, usage, expectedHead }) {
  const steps = [];
  const record = (name, ok, detail = {}) => { steps.push({ name, ok, ...detail }); if (!ok) throw Object.assign(new Error(`pilot-step-failed:${name}`), { steps }); };
  try {
    const ready = await call('/ready');
    record('ready', ready.ok && (!expectedHead || ready.json?.head === expectedHead), { head: ready.json?.head ?? null });

    const etagBefore = (await call('/production-etag')).json;
    record('production-manifest-readable', typeof etagBefore?.etag === 'string', {});
    const init = await call('/init', { method: 'POST', body: { maxNewAttempts: PILOT_MAX_NEW_ATTEMPTS, usage } });
    record('init', init.status === 200 && init.json?.initialized === true && init.json.max_new_attempts === PILOT_MAX_NEW_ATTEMPTS,
      { prior_consumed: init.json?.prior_consumed ?? null, max_new_attempts: init.json?.max_new_attempts ?? null });
    const again = await call('/init', { method: 'POST', body: { maxNewAttempts: PILOT_MAX_NEW_ATTEMPTS, usage } });
    record('init-cannot-be-repeated', again.status === 400);

    const { pilot, exhaustion } = selection;
    const expectedVariants = pilot.items.length * pilot.recipes.length;
    const run = await call('/run', { method: 'POST', body: { plan: pilot, approval: pilot.items_sha256, usage, limit: PILOT_MAX_NEW_ATTEMPTS } });
    const r = run.json || {};
    record('pilot-run', run.status === 200 && r.stopped === null && r.failures?.length === 0 && r.conflicts?.length === 0 && r.complete === true &&
      r.attempts <= expectedVariants && r.attempts === r.created, { attempts: r.attempts, created: r.created, skipped: r.skipped?.length ?? 0 });
    const generated = new Set((r.skipped || []).map(s => s.ref));

    // Cada objeto releído desde R2 (vía el Worker): nada se acepta por un 200 o por el informe del job.
    let verified = 0;
    for (const item of pilot.items) {
      const hash = item.file.slice(0, 64);
      for (const recipe of CF_CARD_VARIANTS) {
        if (generated.has(`${hash}/${recipe.id}`)) continue;
        const object = await call(`/object/${hash}/${recipe.id}`);
        let meta = {}; try { meta = JSON.parse(object.headers.get('x-variant-metadata') || '{}'); } catch { meta = {}; }
        const dims = (() => { try { return webpDimensions(object.bytes); } catch { return null; } })();
        const width = Math.min(item.width, recipe.width), height = Math.max(1, Math.round(item.height * width / item.width));
        const ok = object.status === 200 && object.headers.get('content-type') === 'image/webp' && dims &&
          meta.encoder === CF_ENCODER && meta.recipe === recipe.id && meta.master_sha256 === hash && HASH.test(meta.sha256 || '') &&
          meta.sha256 === sha(object.bytes) && Number(meta.bytes) === object.bytes.length &&
          dims.width === width && Math.abs(dims.height - height) <= 1 && dims.width <= item.width &&
          Number(meta.width) === dims.width && Number(meta.height) === dims.height &&
          Number(meta.source_width) === item.width && Number(meta.source_height) === item.height;
        record(`object:${hash.slice(0, 8)}/${recipe.id}`, Boolean(ok), ok ? {} : { status: object.status, dims, meta_keys: Object.keys(meta) });
        verified++;
      }
    }
    record('objects-verified', verified === r.created, { verified });

    const before = (await call('/status')).json?.ledger;
    record('ledger-after-pilot', before?.consumed === r.attempts && before.succeeded === r.created && before.failed === 0 && before.lease === null &&
      before.max_new_attempts === PILOT_MAX_NEW_ATTEMPTS && before.consumed <= PILOT_MAX_NEW_ATTEMPTS, { consumed: before?.consumed });

    const resume = await call('/run', { method: 'POST', body: { plan: pilot, approval: pilot.items_sha256, usage, limit: PILOT_MAX_NEW_ATTEMPTS } });
    const after = (await call('/status')).json?.ledger;
    record('resume-spends-nothing', resume.json?.attempts === 0 && resume.json.stopped === null && after?.consumed === before.consumed, { consumed: after?.consumed });

    const left = PILOT_MAX_NEW_ATTEMPTS - before.consumed;
    const exhausted = await call('/run', { method: 'POST', body: { plan: exhaustion, approval: exhaustion.items_sha256, usage, limit: PILOT_MAX_NEW_ATTEMPTS } });
    record('budget-exhausted-stops', exhausted.json?.attempts === Math.min(left, exhaustion.recipes.length) && (left >= exhaustion.recipes.length || exhausted.json.stopped === 'budget-exhausted'),
      { attempts: exhausted.json?.attempts, stopped: exhausted.json?.stopped, remaining_before: left });
    const closed = await call('/run', { method: 'POST', body: { plan: exhaustion, approval: exhaustion.items_sha256, usage, limit: PILOT_MAX_NEW_ATTEMPTS } });
    const final = (await call('/status')).json?.ledger;
    record('exhausted-ledger-spends-nothing-more', left >= exhaustion.recipes.length || (closed.json?.attempts === 0 && final.consumed === PILOT_MAX_NEW_ATTEMPTS),
      { consumed: final?.consumed });
    const etagAfter = (await call('/production-etag')).json;
    record('production-manifest-unchanged', etagAfter?.etag === etagBefore.etag && etagAfter.size === etagBefore.size, { etag: etagAfter?.etag ?? null });
    record('never-above-32', final?.consumed <= PILOT_MAX_NEW_ATTEMPTS && final.lease === null, { consumed: final?.consumed, succeeded: final?.succeeded, failed: final?.failed });
    return { ok: true, steps, consumed: final.consumed, succeeded: final.succeeded, failed: final.failed };
  } catch (error) {
    if (error.steps) return { ok: false, steps: error.steps, failed_step: steps.at(-1)?.name };
    steps.push({ name: 'unexpected', ok: false, reason: 'pilot-error' });
    return { ok: false, steps, failed_step: 'unexpected' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [selectionPath, usagePath, reportPath] = process.argv.slice(2);
  if (!reportPath) throw new Error('usage: card-generation-pilot-check selection.json usage-report.json report.json');
  const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
  const usage = JSON.parse(await readFile(usagePath, 'utf8'));
  const call = pilotClient({ baseUrl: process.env.PILOT_URL, token: process.env.PILOT_TOKEN });
  const result = await runPilotCheck({ call, selection, usage, expectedHead: process.env.PILOT_BUILD_SHA });
  await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ok: result.ok, failed_step: result.failed_step ?? null, consumed: result.consumed ?? null, steps: result.steps.length }));
  if (!result.ok) process.exitCode = 1;
}
