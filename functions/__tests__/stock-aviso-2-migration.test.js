import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(path.join(ROOT, 'migrations/0007_stock_waitlist_customer_notification.sql'), 'utf8');
const deployWorkflow = readFileSync(path.join(ROOT, '.github/workflows/deploy-worker-sync.yml'), 'utf8');

test('stock-aviso-2: migración agrega outbox sin tocar pedidos', () => {
  assert.match(migration, /customer_notification_status/);
  assert.match(migration, /customer_notification_id/);
  assert.match(migration, /last_notification_attempt_at/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+(orders|order_items|order_events)/i);
  assert.doesNotMatch(migration, /DROP TABLE/i);
});

test('stock-aviso-2: despliega la versión antes de editar el secreto de Resend', () => {
  const deployStep = deployWorkflow.indexOf('- name: Deploy amadolibros-sync Worker');
  const secretStep = deployWorkflow.indexOf('- name: Sync Resend secret to Worker');
  const triggerStep = deployWorkflow.indexOf('- name: Trigger catalog sync');

  assert.ok(deployStep >= 0, 'falta el deploy del Worker');
  assert.ok(secretStep > deployStep, 'Cloudflare exige desplegar la versión antes de editar secretos');
  assert.ok(triggerStep > secretStep, 'el sync no debe ejecutarse antes de cargar RESEND_API_KEY');
});
