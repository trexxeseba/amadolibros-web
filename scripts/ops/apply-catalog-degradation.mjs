import fs from 'node:fs';

const file = 'functions/catalogo.js';
let source = fs.readFileSync(file, 'utf8');
const from = `    const catalog = !useCompactSearch || !Array.isArray(activeIndex?.items)
        ? await fetchCatalog(ctx)
        : null;
    const items = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];
`;
const to = `    const needsFullCatalog = !useCompactSearch || !Array.isArray(activeIndex?.items);
    const catalog = needsFullCatalog ? await fetchCatalog(ctx) : null;
    if (needsFullCatalog && (!catalog || !Array.isArray(catalog.items))) {
        return new Response(
            '<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="robots" content="noindex, nofollow"><title>Catálogo temporalmente no disponible — Amado Libros</title></head><body><main><h1>Catálogo temporalmente no disponible</h1><p>Intentá nuevamente en unos minutos.</p></main></body></html>',
            {
                status: 503,
                headers: {
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': 'no-store',
                    'X-Robots-Tag': 'noindex, nofollow',
                },
            },
        );
    }
    const items = catalog?.items || [];
`;
const count = source.split(from).length - 1;
if (count !== 1) throw new Error(`catalog source block: esperado 1 match, encontrados ${count}`);
source = source.replace(from, to);
fs.writeFileSync(file, source);
console.log('A3 catalog degradation patch aplicado.');
