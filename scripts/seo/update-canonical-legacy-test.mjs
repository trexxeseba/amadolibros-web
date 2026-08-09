import fs from 'node:fs';

const file = 'functions/__tests__/catalog-display.test.js';
let source = fs.readFileSync(file, 'utf8');

const oldBlock = `test('CF-R2-2B: una URL histórica con slug viejo resuelve por ID, nunca 404, y el canonical apunta al slug actual', async () => {
  // Simula el caso que preocupa: el título cambió (o el libro pasó de
  // activo a pausado) después de que la URL vieja quedara indexada/guardada
  // en algún lado. El slug del path ("titulo-historico-que-ya-no-existe")
  // no coincide con el título actual del ítem — la ficha debe resolver
  // igual por ID, nunca 404 solo por eso.
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/titulo-historico-que-ya-no-existe', {
      path: ['MLU2', 'titulo-historico-que-ya-no-existe'],
    })
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(
    \`<link rel="canonical" href="https://www\\\\.amadolibros\\\\.com/libro/MLU2/alpha-raro">\`
  ));
  assert.match(html, /Alpha raro/);
});`;

const newBlock = `test('CF-R2-2B: una URL histórica con slug viejo resuelve por ID y redirige al slug canónico actual', async () => {
  // Si el título cambió después de que una URL histórica quedara indexada,
  // la entidad sigue resolviéndose por MLU. La variante vieja no da 404 ni
  // sirve un 200 duplicado: consolida en un solo salto a la URL canónica.
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/titulo-historico-que-ya-no-existe', {
      path: ['MLU2', 'titulo-historico-que-ya-no-existe'],
    })
  );

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get('location'),
    'https://www.amadolibros.com/libro/MLU2/alpha-raro',
  );
});`;

if (!source.includes(oldBlock)) {
  throw new Error('No se encontró el bloque de test histórico esperado.');
}
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(file, source);
console.log('Test histórico actualizado a 301 canónico.');
