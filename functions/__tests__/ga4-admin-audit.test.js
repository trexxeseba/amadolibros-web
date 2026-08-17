import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classify,
  cleanAdsId,
  csvCell,
  summaryMarkdown,
} from '../../scripts/ga4-admin-audit.mjs';

function row(overrides = {}) {
  return {
    streams: [{}],
    isTarget: false,
    isObserved: false,
    events30d: '0',
    purchases90d: '0',
    lastActivityDate365d: '',
    inspectionErrors: [],
    isLinkedToTargetAds: false,
    ...overrides,
  };
}

test('normaliza identificadores de Google Ads', () => {
  assert.equal(cleanAdsId('715-685-8182'), '7156858182');
});

test('conserva siempre el target productivo', () => {
  assert.equal(classify(row({ isTarget: true })), 'KEEP_PRODUCTION_TARGET');
  assert.equal(
    classify(row({ isTarget: true, inspectionErrors: ['403'] })),
    'KEEP_PRODUCTION_TARGET_REVIEW_INCOMPLETE',
  );
});

test('un error de inspección nunca genera candidato de borrado', () => {
  assert.equal(
    classify(row({ inspectionErrors: ['API disabled'] })),
    'REVIEW_INSPECTION_INCOMPLETE',
  );
});

test('actividad y compras fuerzan revisión', () => {
  assert.equal(classify(row({ purchases90d: '1' })), 'REVIEW_HAS_PURCHASES');
  assert.equal(classify(row({ events30d: '40' })), 'REVIEW_ACTIVE');
});

test('protege CSV contra fórmulas', () => {
  assert.equal(csvCell('=IMPORTXML("x")'), '"\'=IMPORTXML(""x"")"');
});

test('el resumen declara modo de solo lectura', () => {
  const summary = summaryMarkdown([row({ isTarget: true })], []);
  assert.match(summary, /Production target G-SDX45VEPP3: 1/);
  assert.match(summary, /No resource was created, modified, linked or deleted/);
});
