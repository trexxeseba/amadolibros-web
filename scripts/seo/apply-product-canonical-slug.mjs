import fs from 'node:fs';

const file = 'functions/libro/[[path]].js';
let source = fs.readFileSync(file, 'utf8');

const handlerMarker = `// ---------------------------------------------------------------------------\n// Handler principal\n// ---------------------------------------------------------------------------\n\nexport async function onRequest(context) {`;

const helper = `// ---------------------------------------------------------------------------\n// Normalización de URL canónica de producto\n// ---------------------------------------------------------------------------\n\nexport function canonicalProductRedirectUrl({\n    requestUrl,\n    navigationBase,\n    id,\n    providedSlug,\n    canonicalSlug,\n}) {\n    if (providedSlug && providedSlug === canonicalSlug) return null;\n\n    const currentUrl = new URL(requestUrl);\n    // layout es un parámetro histórico de presentación: no debe sobrevivir\n    // al salto canónico. El resto de la query se conserva.\n    currentUrl.searchParams.delete('layout');\n    return \`${navigationBase}/libro/${id}/${canonicalSlug}${currentUrl.search}\`;\n}\n\n`;

if (!source.includes('export function canonicalProductRedirectUrl(')) {
    if (!source.includes(handlerMarker)) {
        throw new Error('No se encontró el marcador del handler principal.');
    }
    source = source.replace(handlerMarker, `${helper}${handlerMarker}`);
}

const oldBlock = `    // Redirect 301 si no viene el slug\n    if (!providedSlug) {\n        return Response.redirect(\`${navigationBase}/libro/${id}/${slug}\`, 301);\n    }`;

const newBlock = `    // Una sola URL por entidad: slug faltante o incorrecto -> 301 canónico.\n    const canonicalRedirect = canonicalProductRedirectUrl({\n        requestUrl: context.request.url,\n        navigationBase,\n        id,\n        providedSlug,\n        canonicalSlug: slug,\n    });\n    if (canonicalRedirect) {\n        return Response.redirect(canonicalRedirect, 301);\n    }`;

if (source.includes(oldBlock)) {
    source = source.replace(oldBlock, newBlock);
} else if (!source.includes('const canonicalRedirect = canonicalProductRedirectUrl({')) {
    throw new Error('No se encontró el bloque de redirect esperado.');
}

fs.writeFileSync(file, source);
console.log('SEO-URL-CANONICAL-ENFORCEMENT-1 aplicado.');
