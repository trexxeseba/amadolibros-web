// El aviso de cookies aparece en todas las páginas indexables. Lighthouse
// (auditoría SEO link-text) baja el puntaje si sus enlaces dicen cosas
// genéricas como "Más información", "acá" o "click aquí".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync('astro-front/public/meta-tracking.js', 'utf8');

// Lista de textos genéricos en español que Lighthouse 12 marca, más los
// equivalentes rioplatenses.
const GENERIC = /^(click|clic|clicka|pincha|hac[eé] clic)?\s*(aqu[ií]|ac[aá])$|^(m[aá]s|m[aá]s informaci[oó]n|ver m[aá]s|leer m[aá]s|este|enlace|este enlace|empezar|ir)$/i;

test('el aviso de cookies enlaza a privacidad con un texto descriptivo', () => {
  const banner = script.slice(script.indexOf('function showBanner'), script.indexOf('function applyConfig'));
  const links = [...banner.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)];
  assert.ok(links.length > 0, 'el aviso debe tener el enlace a /privacidad/');
  assert.ok(links.some(m => /href="\/privacidad\/"/.test(m[0])), 'el enlace debe ir a /privacidad/');
  for (const [, text] of links) {
    const clean = text.trim().replace(/[.:]$/, '');
    assert.ok(clean.length > 0, 'el enlace necesita texto');
    assert.doesNotMatch(clean, GENERIC, `texto de enlace genérico: "${clean}"`);
  }
});
