import fs from 'node:fs';

const file = 'functions/api/[[route]].js';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: esperado 1 match, encontrados ${count}`);
  source = source.replace(from, to);
}

replaceOnce(
  `// El catálogo vive en R2. El Worker (worker-sync/) es la única fuente de escritura.\n// Pages ya no sincroniza, no resetea, y no escribe datos de catálogo en KV.\n`,
  `// El catálogo vive en R2. El Worker (worker-sync/) es la única fuente de escritura.\n// Pages ya no sincroniza, no resetea, y no escribe datos de catálogo en KV.\n\nimport { STATUS_SYNC_STALE_MS, STATUS_SYNC_STUCK_MS } from '../_shared/status-policy.js';\n`,
  'import policy',
);

replaceOnce(
  `    // Frescura del sync\n    const STALE_MS = 26 * 60 * 60 * 1000;\n    const STUCK_MS = 45 * 60 * 1000;\n\n`,
  `    // Frescura del sync — umbrales definidos una sola vez en _shared/status-policy.js.\n`,
  'remove local thresholds',
);

replaceOnce('      sync_fresh  = ageMs <= STALE_MS;', '      sync_fresh  = ageMs <= STATUS_SYNC_STALE_MS;', 'stale usage');
replaceOnce("    const possibly_stuck  = in_progress && (Date.now() - lastStartedDate.getTime()) > STUCK_MS;", "    const possibly_stuck  = in_progress && (Date.now() - lastStartedDate.getTime()) > STATUS_SYNC_STUCK_MS;", 'stuck usage');

fs.writeFileSync(file, source);
console.log('A4 freshness policy aplicada sin cambiar umbrales.');
