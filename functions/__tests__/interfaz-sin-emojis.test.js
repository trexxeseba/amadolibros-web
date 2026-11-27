import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// La tienda es una librería cara: la interfaz y los mensajes de WhatsApp que
// arma el sitio no llevan emojis (Seba, 27/11/2026). Se permiten los símbolos
// tipográficos: flecha (↗), estrellas de la calificación (★), tilde y cruz de
// estado (✓ ✗ ✕) y el separador (✦). Node 22 y Node 24 no clasifican igual
// estos símbolos, por eso van explícitos. El panel interno y los console.log
// quedan fuera.
const EMOJI = /\p{Extended_Pictographic}/u;
const PERMITIDOS = new Set(['↗', '★', '✓', '✗', '✕', '✦']);
const RAICES = ['astro-front/src', 'astro-front/public', 'functions', 'shared'];
const FUERA = new Set(['node_modules', '__tests__', 'dist', '.astro', 'panel']);

function archivos(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (FUERA.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, out);
    else if (/\.(js|mjs|astro|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('la interfaz pública y los saludos de WhatsApp no llevan emojis', () => {
  const hallados = [];
  for (const f of RAICES.flatMap(r => archivos(r))) {
    const rel = f.split(path.sep).join('/');
    if (rel.includes('/_shared/panel') || rel.startsWith('functions/api/webhooks/')) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((linea, i) => {
      if (/console\.(log|warn|error|info)/.test(linea) || /^\s*(\/\/|\*)/.test(linea)) return;
      const emojis = [...linea].filter(c => EMOJI.test(c) && !PERMITIDOS.has(c));
      if (emojis.length) hallados.push(`${rel}:${i + 1} ${emojis.join('')}`);
    });
  }
  assert.deepEqual(hallados, []);
});
