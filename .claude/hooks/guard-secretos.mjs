#!/usr/bin/env node
// Freno para sesiones de Claude: no se leen archivos de credenciales.
//
// Una instruccion en CLAUDE.md es un pedido que puede olvidarse; este hook es una
// regla que se cumple siempre. Corre antes de cada lectura, busqueda y comando.
// Si el pedido apunta a .env, .dev.vars, *.secret o similares, lo bloquea
// (permissionDecision "deny"). Los archivos de ejemplo (.dev.vars.example,
// .env.example) si se pueden leer.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const norm = p => String(p ?? '').replace(/\\/g, '/');

const SAFE = /\.(example|sample|template)$/i;
const SECRET_NAME = /(^|\/)(\.env(\.[^/\s]+)?|\.dev\.vars(\.[^/\s]+)?|[^/\s]*\.secret|[^/\s]*\.pem|[^/\s]*\.key|id_(rsa|ed25519|ecdsa)|credentials(\.json)?)$/i;

export const isSecretPath = p => {
  const path = norm(p).trim();
  if (!path || SAFE.test(path)) return false;
  return SECRET_NAME.test(path);
};

// En comandos: palabras sueltas que parezcan ruta de secreto.
const tokenize = cmd => String(cmd ?? '').split(/[\s"'`=;|&<>()]+/).filter(Boolean);

export function decide(input) {
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};
  if (tool === 'Read' || tool === 'NotebookRead') {
    const p = args.file_path ?? args.notebook_path;
    return isSecretPath(p) ? `Leer ${norm(p)}` : null;
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const hits = [args.path, args.glob, args.pattern].filter(isSecretPath);
    return hits.length ? `Buscar en ${hits[0]}` : null;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const hit = tokenize(args.command).find(isSecretPath);
    return hit ? `El comando toca ${hit}` : null;
  }
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
        permissionDecision: 'deny',
        permissionDecisionReason: `Credenciales: ${reason}. Las claves no se leen en sesiones de Claude. Usar .dev.vars.example para ver los nombres de las variables.`,
      },
    }));
  }
}
