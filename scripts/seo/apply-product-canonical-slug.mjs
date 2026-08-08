import fs from 'node:fs';

const file = 'functions/libro/[[path]].js';
let source = fs.readFileSync(file, 'utf8');

const handlerMarker = [
  '// ---------------------------------------------------------------------------',
  '// Handler principal',
  '// ---------------------------------------------------------------------------',
  '',
  'export async function onRequest(context) {',
].join('\n');

const helper = [
  '// ---------------------------------------------------------------------------',
  '// Normalización de URL canónica de producto',
  '// ---------------------------------------------------------------------------',
  '',
  'export function canonicalProductRedirectUrl({',
  '    requestUrl,',
  '    navigationBase,',
  '    id,',
  '    providedSlug,',
  '    canonicalSlug,',
  '}) {',
  '    if (providedSlug && providedSlug === canonicalSlug) return null;',
  '',
  '    const currentUrl = new URL(requestUrl);',
  '    // layout es un parámetro histórico de presentación: no debe sobrevivir',
  '    // al salto canónico. El resto de la query se conserva.',
  "    currentUrl.searchParams.delete('layout');",
  '    return `${navigationBase}/libro/${id}/${canonicalSlug}${currentUrl.search}`;',
  '}',
  '',
].join('\n');

if (!source.includes('export function canonicalProductRedirectUrl(')) {
  if (!source.includes(handlerMarker)) {
    throw new Error('No se encontró el marcador del handler principal.');
  }
  source = source.replace(handlerMarker, `${helper}\n${handlerMarker}`);
}

const oldBlock = [
  '    // Redirect 301 si no viene el slug',
  '    if (!providedSlug) {',
  '        return Response.redirect(`${navigationBase}/libro/${id}/${slug}`, 301);',
  '    }',
].join('\n');

const newBlock = [
  '    // Una sola URL por entidad: slug faltante o incorrecto -> 301 canónico.',
  '    const canonicalRedirect = canonicalProductRedirectUrl({',
  '        requestUrl: context.request.url,',
  '        navigationBase,',
  '        id,',
  '        providedSlug,',
  '        canonicalSlug: slug,',
  '    });',
  '    if (canonicalRedirect) {',
  '        return Response.redirect(canonicalRedirect, 301);',
  '    }',
].join('\n');

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (!source.includes('const canonicalRedirect = canonicalProductRedirectUrl({')) {
  throw new Error('No se encontró el bloque de redirect esperado.');
}

fs.writeFileSync(file, source);
console.log('SEO-URL-CANONICAL-ENFORCEMENT-1 aplicado.');
