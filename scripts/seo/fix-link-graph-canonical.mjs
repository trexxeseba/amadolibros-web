import fs from 'node:fs';

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: esperado 1 match, encontrados ${count}`);
  return source.replace(from, to);
}

{
  const file = 'functions/catalogo.js';
  let s = fs.readFileSync(file, 'utf8');
  const from = `    // Canonical propio por página: una secuencia paginada no es contenido
    // duplicado, así que \`?page=2\` no debe canonicalizar hacia la página 1 —
    // hacerlo le pediría a Google que descarte el resto del catálogo.
    const canonicalHref = \`${'${BASE}${catalogPath({'}
        q: rawQ, categoria, subcategoria, page,
    })}\`;`;
  const to = `    // La secuencia limpia /catalogo?page=N tiene canonical propio. Las vistas
    // con búsqueda/categoría/subcategoría siguen noindex y canonicalizan al
    // catálogo limpio: no abrimos un segundo espacio SEO de filtros.
    const canonicalHref = isIndex
        ? \`${'${BASE}${catalogPath({ q: \'\', categoria: \'\', subcategoria: \'\', page })}'}\`
        : \`${'${BASE}'}/catalogo\`;`;
  s = replaceOnce(s, from, to, 'filtered canonical policy');
  fs.writeFileSync(file, s);
}

{
  const file = 'functions/__tests__/catalogo-paginacion.test.js';
  let s = fs.readFileSync(file, 'utf8');
  const from = `test('18. una búsqueda paginada es noindex, follow con canonical propio', async () => {
  const { html } = await render(\`${'${BASE_URL}'}?q=prueba&page=2\`);
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\\/\\/www\\.amadolibros\\.com\\/catalogo\\?q=prueba&amp;page=2">/);
});`;
  const to = `test('18. una búsqueda paginada es noindex, follow y canonicaliza al catálogo limpio', async () => {
  const { html } = await render(\`${'${BASE_URL}'}?q=prueba&page=2\`);
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\\/\\/www\\.amadolibros\\.com\\/catalogo">/);
});`;
  s = replaceOnce(s, from, to, 'pagination test 18');
  fs.writeFileSync(file, s);
}

console.log('Canonical de filtros restaurado; paginación limpia conserva self-canonical.');
