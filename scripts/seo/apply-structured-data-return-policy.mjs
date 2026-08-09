import { readFile, writeFile } from 'node:fs/promises';

const path = 'functions/libro/[[path]].js';
const source = await readFile(path, 'utf8');

const oldBlock = `            'availability': 'https://schema.org/InStock',\n            'seller': { '@type': 'Organization', 'name': 'Amado Libros' },\n        };`;

const newBlock = `            'availability': 'https://schema.org/InStock',\n            'seller': { '@type': 'Organization', 'name': 'Amado Libros', 'url': BASE },\n            'hasMerchantReturnPolicy': {\n                '@type': 'MerchantReturnPolicy',\n                'merchantReturnLink': \`${'${BASE}'}/devoluciones\`,\n            },\n        };`;

const matches = source.split(oldBlock).length - 1;
if (matches !== 1) {
  throw new Error(`Expected exactly one active Offer block, found ${matches}`);
}

await writeFile(path, source.replace(oldBlock, newBlock));
console.log('Structured data return policy patch applied.');
