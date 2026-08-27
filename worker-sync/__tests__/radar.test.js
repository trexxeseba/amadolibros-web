import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRadarAlerts,
  computeReplenishmentScoreV1,
  HIGH_WAITLIST_THRESHOLD,
  LOW_STOCK_THRESHOLD,
  REPLENISHMENT_SCORE_VERSION,
  severityFromScore,
} from '../radar.js';

test('computeReplenishmentScoreV1: agotado sin espera da score moderado y motivo explicable', () => {
  const { score, reasons } = computeReplenishmentScoreV1({ availableQuantity: 0, waitlistCount: 0, status: 'active' });
  assert.equal(score, 50);
  assert.deepEqual(reasons, ['Sin stock disponible.']);
});

test('computeReplenishmentScoreV1: queda 1 unidad + clientes esperando suma componentes', () => {
  const { score, reasons } = computeReplenishmentScoreV1({ availableQuantity: 1, waitlistCount: 2, status: 'active' });
  assert.equal(score, 60); // 40 (queda 1) + 20 (2 esperando * 10)
  assert.deepEqual(reasons, ['Queda 1 unidad.', 'Hay 2 clientes esperando.']);
});

test('computeReplenishmentScoreV1: publicación pausada reduce el score pero no lo anula', () => {
  const active = computeReplenishmentScoreV1({ availableQuantity: 0, waitlistCount: 1, status: 'active' });
  const paused = computeReplenishmentScoreV1({ availableQuantity: 0, waitlistCount: 1, status: 'paused' });
  assert.ok(paused.score < active.score);
  assert.ok(paused.score > 0);
  assert.ok(paused.reasons.some(reason => reason.includes('pausada')));
});

test('computeReplenishmentScoreV1: ISBN faltante suma una penalización pequeña y explicable', () => {
  const withIsbn = computeReplenishmentScoreV1({ availableQuantity: 1, waitlistCount: 0, status: 'active', isbnPresent: true });
  const withoutIsbn = computeReplenishmentScoreV1({ availableQuantity: 1, waitlistCount: 0, status: 'active', isbnPresent: false });
  assert.equal(withoutIsbn.score - withIsbn.score, 5);
  assert.ok(withoutIsbn.reasons.some(reason => reason.includes('ISBN')));
});

test('computeReplenishmentScoreV1: nunca excede 100 ni baja de 0', () => {
  const { score } = computeReplenishmentScoreV1({ availableQuantity: 0, waitlistCount: 999, status: 'active', isbnPresent: false });
  assert.ok(score <= 100);
  const { score: floor } = computeReplenishmentScoreV1({ availableQuantity: 50, waitlistCount: 0, status: 'active' });
  assert.equal(floor, 0);
});

test('severityFromScore: umbrales de negocio', () => {
  assert.equal(severityFromScore(70), 'high');
  assert.equal(severityFromScore(69), 'medium');
  assert.equal(severityFromScore(40), 'medium');
  assert.equal(severityFromScore(39), 'low');
});

test('buildRadarAlerts: item activo con 1 unidad genera REPOSICION_URGENTE con score', () => {
  const alerts = buildRadarAlerts({
    activeItems: [{ id: 'MLU1', title: 'Libro A', isbn: '9780000000001', status: 'active', available_quantity: 1 }],
    pausedItems: [],
    waitlistCounts: new Map(),
  });
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert.alert_type, 'REPOSICION_URGENTE');
  assert.equal(alert.item_id, 'MLU1');
  assert.equal(alert.isbn, '9780000000001');
  assert.equal(alert.score_version, REPLENISHMENT_SCORE_VERSION);
  assert.equal(alert.severity, 'medium');
  assert.deepEqual(alert.reasons, ['Queda 1 unidad.']);
});

test('buildRadarAlerts: item activo con 0 unidades genera AGOTADO, no REPOSICION_URGENTE', () => {
  const alerts = buildRadarAlerts({
    activeItems: [{ id: 'MLU2', title: 'Libro B', isbn: '123', status: 'active', available_quantity: 0 }],
    waitlistCounts: new Map(),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alert_type, 'AGOTADO');
});

test(`buildRadarAlerts: stock por encima de ${LOW_STOCK_THRESHOLD} sin espera no genera alerta de reposición`, () => {
  const alerts = buildRadarAlerts({
    activeItems: [{ id: 'MLU3', title: 'Libro C', isbn: '123', status: 'active', available_quantity: 10 }],
    waitlistCounts: new Map(),
  });
  assert.deepEqual(alerts, []);
});

test('buildRadarAlerts: publicación pausada siempre genera PUBLICACION_PAUSADA', () => {
  const alerts = buildRadarAlerts({
    pausedItems: [{ id: 'MLU4', title: 'Libro D', status: 'paused', available_quantity: 3 }],
    waitlistCounts: new Map(),
  });
  const paused = alerts.filter(alert => alert.alert_type === 'PUBLICACION_PAUSADA');
  assert.equal(paused.length, 1);
  assert.equal(paused[0].severity, 'medium');
  assert.deepEqual(paused[0].reasons, ['Publicación pausada.']);
});

test('buildRadarAlerts: pausado con clientes esperando también genera REPOSICION_URGENTE (score reducido)', () => {
  const alerts = buildRadarAlerts({
    pausedItems: [{ id: 'MLU5', title: 'Libro E', status: 'paused', available_quantity: 0 }],
    waitlistCounts: new Map([['MLU5', 2]]),
  });
  const types = alerts.map(alert => alert.alert_type).sort();
  assert.deepEqual(types, ['CLIENTES_ESPERANDO', 'PUBLICACION_PAUSADA', 'REPOSICION_URGENTE']);
  const reposicion = alerts.find(alert => alert.alert_type === 'REPOSICION_URGENTE');
  assert.ok(reposicion.score > 0);
  assert.equal(reposicion.metrics.status, 'paused');
});

test('buildRadarAlerts: pausado sin clientes esperando no genera alerta de reposición', () => {
  const alerts = buildRadarAlerts({
    pausedItems: [{ id: 'MLU6', title: 'Libro F', status: 'paused', available_quantity: 0 }],
    waitlistCounts: new Map(),
  });
  assert.deepEqual(alerts.map(alert => alert.alert_type), ['PUBLICACION_PAUSADA']);
});

test('buildRadarAlerts: item activo sin ISBN genera CORREGIR_ISBN', () => {
  const alerts = buildRadarAlerts({
    activeItems: [{ id: 'MLU7', title: 'Libro G', status: 'active', available_quantity: 10 }],
    waitlistCounts: new Map(),
  });
  assert.deepEqual(alerts.map(alert => alert.alert_type), ['CORREGIR_ISBN']);
  assert.equal(alerts[0].severity, 'low');
  assert.equal(alerts[0].score, null);
  assert.equal(alerts[0].score_version, null);
});

test('buildRadarAlerts: ISBN faltante + stock bajo sube la severidad de CORREGIR_ISBN', () => {
  const alerts = buildRadarAlerts({
    activeItems: [{ id: 'MLU8', title: 'Libro H', status: 'active', available_quantity: 1 }],
    waitlistCounts: new Map(),
  });
  const isbnAlert = alerts.find(alert => alert.alert_type === 'CORREGIR_ISBN');
  assert.equal(isbnAlert.severity, 'medium');
});

test('buildRadarAlerts: no genera CORREGIR_ISBN para pausados en este PR', () => {
  const alerts = buildRadarAlerts({
    pausedItems: [{ id: 'MLU9', title: 'Libro I', status: 'paused', available_quantity: 0 }],
    waitlistCounts: new Map(),
  });
  assert.ok(!alerts.some(alert => alert.alert_type === 'CORREGIR_ISBN'));
});

test(`buildRadarAlerts: CLIENTES_ESPERANDO sube a 'high' desde ${HIGH_WAITLIST_THRESHOLD} personas`, () => {
  const below = buildRadarAlerts({
    activeItems: [{ id: 'MLU10', title: 'Libro J', isbn: '1', status: 'active', available_quantity: 10 }],
    waitlistCounts: new Map([['MLU10', HIGH_WAITLIST_THRESHOLD - 1]]),
  });
  const at = buildRadarAlerts({
    activeItems: [{ id: 'MLU11', title: 'Libro K', isbn: '1', status: 'active', available_quantity: 10 }],
    waitlistCounts: new Map([['MLU11', HIGH_WAITLIST_THRESHOLD]]),
  });
  assert.equal(below.find(alert => alert.alert_type === 'CLIENTES_ESPERANDO').severity, 'medium');
  assert.equal(at.find(alert => alert.alert_type === 'CLIENTES_ESPERANDO').severity, 'high');
});

test('buildRadarAlerts: un mismo item puede acumular varias alertas simultáneas', () => {
  const alerts = buildRadarAlerts({
    activeItems: [{ id: 'MLU12', title: 'Libro L', status: 'active', available_quantity: 1 }],
    waitlistCounts: new Map([['MLU12', 3]]),
  });
  const types = alerts.map(alert => alert.alert_type).sort();
  assert.deepEqual(types, ['CLIENTES_ESPERANDO', 'CORREGIR_ISBN', 'REPOSICION_URGENTE']);
});

test('buildRadarAlerts: ignora items sin id', () => {
  const alerts = buildRadarAlerts({ activeItems: [{ title: 'Sin id', status: 'active', available_quantity: 0 }] });
  assert.deepEqual(alerts, []);
});
