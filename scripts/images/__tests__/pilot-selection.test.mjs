import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { selectPilotMasters, selectWithProbe } from '../select-pilot-masters.mjs';
import { captureImagesUsage, usageUrl, usageReportFromCapture, USAGE_SOURCE } from '../capture-images-usage.mjs';
import { validateUsageReport } from '../../../worker-sync/card-generation.js';
import { validateGenerationPlan } from '../../../worker-sync/card-generation.js';

const hashOf = n => createHash('sha256').update('master' + n).digest('hex');
function manifestOf(rows) {
  const entries = {};
  rows.forEach((row, i) => {
    const hash = row.hash || hashOf(i);
    entries[`MLU${100 + i}:${row.position ?? 0}`] = { current: { object_key: `covers/v1/objects/${hash}.${row.ext || 'jpg'}`,
      sha256: hash, bytes: row.bytes || 90_000, width: row.width, height: row.height } };
  });
  return { updated_at: '2026-10-17T03:10:32.644Z', entries };
}
const rich = () => [
  ...Array.from({ length: 6 }, () => ({ width: 800, height: 1200 })),
  { width: 700, height: 1000, ext: 'png' }, { width: 640, height: 900, ext: 'webp' }, { width: 900, height: 600 },
  { width: 500, height: 900 }, { width: 1800, height: 2600 }, { width: 300, height: 450 }, { width: 200, height: 300 }, { width: 420, height: 600 },
  { width: 800, height: 1200, position: 1 }, { width: 800, height: 1200 },
];

test('selects ten distinct masters covering every required case, deterministically, plus one for the exhaustion test', async () => {
  const manifest = manifestOf(rich());
  const a = selectPilotMasters({ manifest, v1Inventory: new Set() });
  const b = selectPilotMasters({ manifest, v1Inventory: new Set() });
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.pilot.items.length, 10); assert.equal(new Set(a.pilot.items.map(i => i.file)).size, 10);
  assert.ok(a.strata.every(s => s.filled && !s.filler), JSON.stringify(a.strata));
  const dims = a.pilot.items;
  assert.ok(dims.some(i => i.width < 240) && dims.some(i => i.width > 240 && i.width < 360) && dims.some(i => i.width > 360 && i.width < 480));
  assert.ok(dims.some(i => i.file.endsWith('.png')) && dims.some(i => i.file.endsWith('.webp')) && dims.some(i => i.width > i.height));
  assert.equal(a.exhaustion.items.length, 1);
  assert.ok(!dims.some(i => i.file === a.exhaustion.items[0].file), 'exhaustion master is not a pilot master');
  // The plans are directly consumable by the generator's closed-plan validation.
  await validateGenerationPlan(a.pilot, a.pilot.items_sha256);
  await validateGenerationPlan(a.exhaustion, a.exhaustion.items_sha256);
  assert.ok(a.pilot.items.every(i => JSON.stringify(i.recipes) === JSON.stringify(['v2-240-q85', 'v2-360-q85', 'v2-480-q85'])));
});

test('never selects a master that already has any v1 recipe, gallery positions, or malformed entries', () => {
  const rows = rich();
  const manifest = manifestOf(rows);
  const taken = hashOf(0);
  const withV1 = selectPilotMasters({ manifest, v1Inventory: new Set([`${taken}/v1-360-q85`]) });
  assert.ok(!withV1.pilot.items.some(i => i.file.startsWith(taken)) && !withV1.exhaustion.items[0].file.startsWith(taken));
  const gallery = selectPilotMasters({ manifest, v1Inventory: new Set() });
  const galleryHash = hashOf(rows.length - 2);
  assert.ok(![...gallery.pilot.items, ...gallery.exhaustion.items].some(i => i.file.startsWith(galleryHash)), 'position-1 entry ignored');
  const broken = manifestOf([...rich(), { width: 50, height: 50 }, { width: 800, height: 1200, bytes: 9e9 }]);
  assert.doesNotThrow(() => selectPilotMasters({ manifest: broken, v1Inventory: new Set() }));
  assert.throws(() => selectPilotMasters({ manifest: { entries: null }, v1Inventory: new Set() }), /pilot-manifest-invalid/);
});

test('fills empty strata with reported fillers and refuses when there are not enough candidates', () => {
  const plain = manifestOf(Array.from({ length: 12 }, () => ({ width: 800, height: 1200 })));
  const out = selectPilotMasters({ manifest: plain, v1Inventory: new Set() });
  assert.equal(out.pilot.items.length, 10); assert.ok(out.strata.some(s => s.filler), 'gaps are reported, not hidden');
  assert.throws(() => selectPilotMasters({ manifest: manifestOf(Array.from({ length: 10 }, () => ({ width: 800, height: 1200 }))), v1Inventory: new Set() }), /insufficient/);
});

// ---- Usage capture ---------------------------------------------------------------
const account = 'a'.repeat(32);
test('usage capture is a read-only GET to api.cloudflare.com with the configured token and returns the raw body digest', async () => {
  const calls = [];
  const fetchFn = async (url, options) => { calls.push({ url: String(url), options }); return new Response('{"raw":true}', { status: 200 }); };
  const out = await captureImagesUsage({ fetchFn, token: 'secret-token', accountId: account, now: new Date('2026-10-18T12:00:00Z') });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'manual');
  assert.match(calls[0].url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\/billable-usage\?from=2026-10-01&to=2026-10-18$/);
  assert.equal(out.raw_sha256, createHash('sha256').update('{"raw":true}').digest('hex'));
  assert.ok(!JSON.stringify({ ...out, body: undefined }).includes('secret-token'));
});

test('usage capture fails closed: no token, bad account, foreign host, HTTP error, oversized body', async () => {
  const ok = async () => new Response('{}', { status: 200 });
  await assert.rejects(captureImagesUsage({ fetchFn: ok, accountId: account }), /usage-token-missing/);
  await assert.rejects(captureImagesUsage({ fetchFn: ok, token: 't', accountId: 'nope' }), /invalid-account/);
  await assert.rejects(captureImagesUsage({ fetchFn: ok, token: 't', accountId: account, template: 'https://evil.example/{account_id}' }), /usage-host-not-allowed/);
  await assert.rejects(captureImagesUsage({ fetchFn: ok, token: 't', accountId: account, template: 'http://api.cloudflare.com/{account_id}' }), /usage-host-not-allowed/);
  await assert.rejects(captureImagesUsage({ fetchFn: async () => new Response('x', { status: 403 }), token: 't', accountId: account }), /usage-http-403/);
  await assert.rejects(captureImagesUsage({ fetchFn: async () => new Response('x'.repeat(5_000_001)), token: 't', accountId: account }), /usage-response-too-large/);
  assert.throws(() => usageUrl({ accountId: account, template: 'https://user:pw@api.cloudflare.com/{account_id}' }), /usage-host-not-allowed/);
});

// ---- Usage report conversion (ASSUMED response shape; fails closed on anything else) ----
const NOW = new Date('2026-10-18T12:00:00Z');
const capture = (body, extra = {}) => ({ body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), observed_at: NOW.toISOString(), raw_sha256: 'a'.repeat(64), ...extra });
const row = (over = {}) => ({ ServiceFamilyName: 'Images', ServiceName: 'Images Transformations', ConsumedUnit: 'transformations', ConsumedQuantity: 1234,
  ChargePeriodStart: '2026-10-01T00:00:00Z', ChargePeriodEnd: '2026-10-18T00:00:00Z', ...over });

test('usage report: sums raw consumed Images transformations, and is accepted by the ledger validator', () => {
  const report = usageReportFromCapture(capture({ success: true, result: [row(), row({ ConsumedQuantity: 66.2 }), { ServiceFamilyName: 'R2', ServiceName: 'R2 Storage', ConsumedQuantity: 9e9 }] }), { now: NOW });
  assert.equal(report.billed_transformations, 1234 + 67); assert.equal(report.rows_matched, 2); assert.equal(report.source, USAGE_SOURCE);
  assert.equal(report.period, '2026-10'); assert.equal(report.raw_sha256, 'a'.repeat(64));
  assert.doesNotThrow(() => validateUsageReport(report, NOW.getTime(), '2026-10'));
});

test('usage report fails closed: unknown shape, no Images row (zero is NOT assumed), missing/invalid raw quantity, other periods', () => {
  const bad = {
    'not json': capture('<html>'), 'api error': capture({ success: false, result: [] }), 'result not an array': capture({ success: true, result: { data: [row()] } }),
    'empty result': capture({ success: true, result: [] }),
    'no images rows': capture({ success: true, result: [{ ServiceFamilyName: 'R2', ServiceName: 'Storage', ConsumedQuantity: 5 }] }),
    'images but not transformations': capture({ success: true, result: [row({ ConsumedUnit: 'GB', ServiceName: 'Images Storage' })] }),
    'only PricingQuantity': capture({ success: true, result: [(({ ConsumedQuantity, ...rest }) => ({ ...rest, PricingQuantity: 77 }))(row())] }),
    'string quantity': capture({ success: true, result: [row({ ConsumedQuantity: '12' })] }),
    'negative quantity': capture({ success: true, result: [row({ ConsumedQuantity: -1 })] }),
    'NaN-like quantity': capture({ success: true, result: [row({ ConsumedQuantity: null })] }),
    'previous month rows': capture({ success: true, result: [row({ ChargePeriodStart: '2026-09-15T00:00:00Z' })] }),
    'missing period': capture({ success: true, result: [row({ ChargePeriodStart: undefined })] }),
    'one good one bad row': capture({ success: true, result: [row(), row({ ConsumedQuantity: 'x' })] }),
  };
  for (const [name, input] of Object.entries(bad)) assert.throws(() => usageReportFromCapture(input, { now: NOW }), /usage-/, name);
});

test('probe selection avoids masters that already have v1 without any general inventory, probing each hash once', async () => {
  const rows = rich(); const manifest = manifestOf(rows);
  const baseline = selectPilotMasters({ manifest, v1Inventory: new Set() });
  const poisoned = baseline.pilot.items[0].file.slice(0, 64);
  const calls = [];
  const probe = async hash => { calls.push(hash); return hash === poisoned ? ['v1-360-q85'] : []; };
  const out = await selectWithProbe({ manifest, probe });
  assert.ok(![...out.pilot.items, ...out.exhaustion.items].some(i => i.file.startsWith(poisoned)), 'master with v1 dropped');
  assert.equal(out.pilot.items.length, 10); assert.equal(new Set(calls).size, calls.length, 'every hash probed at most once');
  assert.ok(calls.length <= 6 * 11, 'bounded probes'); assert.equal(out.probes, calls.length);
  const clean = await selectWithProbe({ manifest, probe: async () => [] });
  assert.deepEqual(clean.pilot, baseline.pilot); assert.equal(clean.probes, 11);
  await assert.rejects(selectWithProbe({ manifest, probe: async hash => { throw new Error('probe-http-403'); } }), /probe-http-403/);
  await assert.rejects(selectWithProbe({ manifest, probe: async () => ['v1-240-q85'], maxRounds: 2 }), /did-not-converge|insufficient/);
});
