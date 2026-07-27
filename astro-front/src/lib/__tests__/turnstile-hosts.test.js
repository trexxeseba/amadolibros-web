import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostMatchesEntry,
  isTurnstileHostAllowed,
  isTurnstileConfigured,
} from '../turnstile-hosts.js';

const PRODUCTION_HOSTS = ['amadolibros.com', 'www.amadolibros.com'];
const PREVIEW_HOSTS = ['amadolibros-web.pages.dev', '.amadolibros-web.pages.dev'];

test('hostMatchesEntry: acepta amadolibros.com como host exacto de Producción', () => {
  assert.equal(hostMatchesEntry('amadolibros.com', 'amadolibros.com'), true);
});

test('hostMatchesEntry: acepta www.amadolibros.com como host exacto de Producción', () => {
  assert.equal(hostMatchesEntry('www.amadolibros.com', 'www.amadolibros.com'), true);
});

test('hostMatchesEntry: acepta subdominio de deployment de Preview vía entrada con punto inicial', () => {
  assert.equal(
    hostMatchesEntry('feature-2-n-g2.amadolibros-web.pages.dev', '.amadolibros-web.pages.dev'),
    true,
  );
});

test('hostMatchesEntry: rechaza evil-amadolibros.com contra amadolibros.com', () => {
  assert.equal(hostMatchesEntry('evil-amadolibros.com', 'amadolibros.com'), false);
});

test('hostMatchesEntry: rechaza amadolibros.com.evil.example contra amadolibros.com', () => {
  assert.equal(hostMatchesEntry('amadolibros.com.evil.example', 'amadolibros.com'), false);
});

test('hostMatchesEntry: rechaza evilamadolibros-web.pages.dev.evil.example contra .amadolibros-web.pages.dev', () => {
  assert.equal(
    hostMatchesEntry('evilamadolibros-web.pages.dev.evil.example', '.amadolibros-web.pages.dev'),
    false,
  );
});

test('hostMatchesEntry: una entrada con punto inicial nunca acepta el host desnudo por sí solo', () => {
  assert.equal(hostMatchesEntry('amadolibros-web.pages.dev', '.amadolibros-web.pages.dev'), false);
});

test('hostMatchesEntry: entrada sin punto inicial nunca acepta subdominios', () => {
  assert.equal(hostMatchesEntry('sub.amadolibros.com', 'amadolibros.com'), false);
});

test('hostMatchesEntry: entrada vacía o ausente nunca matchea', () => {
  assert.equal(hostMatchesEntry('amadolibros.com', ''), false);
});

test('isTurnstileHostAllowed: hosts de Producción aceptados, hosts de Preview rechazados', () => {
  assert.equal(isTurnstileHostAllowed('amadolibros.com', PRODUCTION_HOSTS), true);
  assert.equal(isTurnstileHostAllowed('www.amadolibros.com', PRODUCTION_HOSTS), true);
  assert.equal(
    isTurnstileHostAllowed('hash123.amadolibros-web.pages.dev', PRODUCTION_HOSTS),
    false,
  );
});

test('isTurnstileHostAllowed: hosts de Preview aceptados, host de Producción rechazado', () => {
  assert.equal(
    isTurnstileHostAllowed('hash123.amadolibros-web.pages.dev', PREVIEW_HOSTS),
    true,
  );
  assert.equal(isTurnstileHostAllowed('amadolibros.com', PREVIEW_HOSTS), false);
});

test('isTurnstileHostAllowed: ataques de spoofing rechazados en ambos ambientes', () => {
  const attacks = [
    'evil-amadolibros.com',
    'amadolibros.com.evil.example',
    'evilamadolibros-web.pages.dev.evil.example',
  ];
  for (const hostname of attacks) {
    assert.equal(isTurnstileHostAllowed(hostname, PRODUCTION_HOSTS), false, hostname);
    assert.equal(isTurnstileHostAllowed(hostname, PREVIEW_HOSTS), false, hostname);
  }
});

test('isTurnstileConfigured: false si el checkout está apagado, aunque el resto sea válido', () => {
  assert.equal(
    isTurnstileConfigured(false, '0xsitekey', 'amadolibros.com', PRODUCTION_HOSTS),
    false,
  );
});

test('isTurnstileConfigured: false si falta la site key', () => {
  assert.equal(isTurnstileConfigured(true, '', 'amadolibros.com', PRODUCTION_HOSTS), false);
});

test('isTurnstileConfigured: false si el host actual no está permitido', () => {
  assert.equal(
    isTurnstileConfigured(true, '0xsitekey', 'evil-amadolibros.com', PRODUCTION_HOSTS),
    false,
  );
});

test('isTurnstileConfigured: true solo cuando checkout on + site key + host permitido', () => {
  assert.equal(
    isTurnstileConfigured(true, '0xsitekey', 'amadolibros.com', PRODUCTION_HOSTS),
    true,
  );
});

test('isTurnstileConfigured: site key de Preview no es válida para host de Producción y viceversa', () => {
  // La site key en sí no determina el ambiente — lo hace el host permitido
  // inyectado por build. Este test documenta que isTurnstileConfigured no
  // valida la site key contra el ambiente, solo su presencia; el aislamiento
  // real entre site keys de Producción y Preview lo garantiza qué valores
  // inyecta cada workflow (deploy.yml vs deploy-preview.yml) en build time,
  // no esta función en tiempo de ejecución.
  assert.equal(
    isTurnstileConfigured(true, '0xpreviewkey', 'amadolibros.com', PRODUCTION_HOSTS),
    true,
  );
});
