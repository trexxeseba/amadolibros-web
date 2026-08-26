#!/usr/bin/env node
// Orquestador del Bloque 1. Corre en secuencia (no en paralelo entre sí, para
// no combinar la concurrencia de dos scripts contra el mismo origen) los
// puntos 1.1 a 1.6 y el medidor existente de 1.5, y deja todo en el mismo
// directorio de reportes del día.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, OUTPUT_DIR } from './_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function run(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${scriptPath} salió con código ${code}`))));
  });
}

async function main() {
  const steps = [
    ['1.1 sitemap-status', path.join(here, 'sitemap-status.mjs'), {}],
    ['1.2 social-tags', path.join(here, 'social-tags.mjs'), {}],
    ['1.3 jsonld-products', path.join(here, 'jsonld-products.mjs'), {}],
    ['1.4 pagination-reach', path.join(here, 'pagination-reach.mjs'), {}],
    // 1.5 reutiliza el script YA existente en el repo, apuntado al mismo
    // directorio de salida del día — no se reimplementa la medición.
    ['1.5 link-graph-audit (existente)', path.join(here, '..', 'seo', 'link-graph-audit.mjs'), {
      SEO_OUTPUT_DIR: OUTPUT_DIR,
      SEO_SITEMAP_URL: `${BASE_URL}/sitemap-books-active.xml`,
    }],
    ['1.6 legacy-and-protocol', path.join(here, 'legacy-and-protocol.mjs'), {}],
  ];

  const results = [];
  for (const [label, scriptPath, env] of steps) {
    console.log(`\n=== ${label} ===`);
    try {
      await run(scriptPath, env);
      results.push({ step: label, ok: true });
    } catch (error) {
      console.error(`FALLÓ: ${label}: ${error.message}`);
      results.push({ step: label, ok: false, error: error.message });
    }
  }

  console.log('\n=== Resumen Bloque 1 ===');
  for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FALLO'} ${r.step}`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}

main();
