#!/usr/bin/env node
// Freno para sesiones de Claude: nada toca la cuenta de Mercado Libre Amado Libros
// (seller 440298103) sin que Seba lo apruebe en el momento.
//
// Corre antes de cada edición de archivo y de cada comando. Si el cambio toca código
// propio de Amado Libros, código que comparte con Vintage, o menciona el seller, no
// lo hace solo: pide permiso a la persona (permissionDecision "ask"). Leer y buscar
// no pasa por acá.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const SELLER = '440298103';

// Sólo de Amado Libros: la cola de publicación, su stock-sync y sus scripts.
const LIBROS_ONLY = [
  'worker-sync/publication-queue.js',
  'worker-sync/publication-stock-sync.js',
  'worker-sync/publication-routes.js',
  'worker-sync/publication-book-metadata.js',
  '.github/workflows/mercadolibre-publication-queue.yml',
  '.github/workflows/production-paused-catalog.yml',
  'scripts/mercadolibre/publisher-control.mjs',
  'scripts/mercadolibre/approved-four-worker.mjs',
  'scripts/mercadolibre/approved-twenty-worker.mjs',
  'scripts/mercadolibre/approved-twenty-manifest.mjs',
  'scripts/mercadolibre/run-approved-four.mjs',
  'scripts/mercadolibre/run-approved-twenty.mjs',
];
// Compartidos con Vintage: un cambio acá cambia también Amado Libros.
const SHARED = [
  'worker-sync/publication-engine.js',
  'worker-sync/publication-policy.js',
  'worker-sync/publication-store.js',
  'worker-sync/publication-meli.js',
];
// Comandos que operan la cola de Amado Libros.
const COMMAND_PATTERNS = [
  /440298103/,
  /mercadolibre-publication-queue/,
  /publisher-control\.mjs/,
  /run-approved-(four|twenty)/,
  /production-paused-catalog/,
];

const norm = p => String(p ?? '').replace(/\\/g, '/');
const endsWithAny = (path, list) => list.find(f => path === f || path.endsWith('/' + f));

export function decide(input) {
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(args.command ?? '');
    const hit = COMMAND_PATTERNS.find(re => re.test(command));
    return hit ? `El comando opera sobre Amado Libros (coincide con ${hit}).` : null;
  }
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return null;
  const path = norm(args.file_path ?? args.notebook_path);
  const only = endsWithAny(path, LIBROS_ONLY);
  if (only) return `${only} es código de Amado Libros.`;
  const shared = endsWithAny(path, SHARED);
  if (shared) return `${shared} lo comparten Amado Libros y Vintage: un cambio acá también cambia Amado Libros.`;
  const text = [args.content, args.new_string, args.new_source, ...(args.edits ?? []).map(e => e?.new_string)].join('\n');
  if (text.includes(SELLER)) return `El cambio menciona el seller de Amado Libros (${SELLER}).`;
  return null;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const reason = decide(input);
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `Amado Libros: ${reason} Solo con aprobación expresa de Seba.`,
      },
    }));
  }
}
