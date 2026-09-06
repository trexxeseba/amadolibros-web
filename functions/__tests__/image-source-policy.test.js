import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImageAlternatives, mlImageIdentity, googleReadyImage } from '../_shared/image-source-policy.js';
import { renderPage } from '../libro/[[path]].js';
import { filterItemsWithReadyPrimaryCover, additionalMerchantImageLinks } from '../feed.xml.js';

const a='https://http2.mlstatic.com/D_123456-MLU123456789_012026-O.jpg';
const b='https://http2.mlstatic.com/D_NQ_NP_123456-MLU123456789_012026-F.jpg';
test('sólo compara variantes de la misma imagen y no confunde tapas con contraportadas',()=>{
  assert.equal(mlImageIdentity(a),mlImageIdentity(b));
  assert.deepEqual(nativeImageAlternatives(a,[b,'https://http2.mlstatic.com/D_654321-MLU987654321_022026-O.jpg']),[a,b]);
  assert.equal(mlImageIdentity('https://evil.example/D_123456-MLU123456789_012026-O.jpg'),null);
});

test('gate Google exige ambos lados de 500 y no elimina productos al desactivarlo',()=>{
  const item={id:'MLU123456',pictures:[a,b]};
  const entry=(source,hash,width,height)=>({current:{source_url:source,sha256:hash,object_key:`covers/v1/objects/${hash}.jpg`,mime:'image/jpeg',width,height}});
  const manifest={schema_version:1,entries:{'MLU123456:0':entry(a,'a'.repeat(64),400,1200),'MLU123456:1':entry(b,'b'.repeat(64),300,500)}};
  assert.equal(filterItemsWithReadyPrimaryCover([item],manifest).length,1);
  assert.equal(filterItemsWithReadyPrimaryCover([item],manifest,true).length,0);
  manifest.entries['MLU123456:0'].current.width=800;
  assert.equal(filterItemsWithReadyPrimaryCover([item],manifest,true).length,1);
  assert.deepEqual(additionalMerchantImageLinks(item,manifest,10,true),[]);
  assert.equal(additionalMerchantImageLinks(item,manifest,10,false).length,1);
  assert.equal(googleReadyImage({object_key:'x',width:500,height:499}),false);
});


test('JSON-LD respeta imágenes verificadas sin esconder la galería visible', () => {
  const item = {id:'MLU123456',title:'Libro de prueba',status:'active',available_quantity:1,
    price:500,currency:'UYU',pictures:[a,b],permalink:'https://example.com/libro'};
  const productSchema = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(match => JSON.parse(match[1])).find(schema => schema['@type'] === 'Book' || schema['@type']?.includes?.('Product'));
  const good = 'https://www.amadolibros.com/book-cover/MLU123456/cover.jpg';
  const filtered = renderPage(item,'libro-de-prueba',false,'','',[],[good]);
  assert.deepEqual(productSchema(filtered).image,[good]);
  const pending = renderPage(item,'libro-de-prueba',false,'','',[],[]);
  assert.equal(productSchema(pending).image,undefined);
  assert.match(pending,/cover-2\.jpg/);
});


test('quitar una placa no cambia la identidad de las imágenes restantes', () => {
  const item = {id:'MLU123456',title:'Libro',status:'active',available_quantity:1,price:500,
    pictures:['https://http2.mlstatic.com/D_768794-MLU78243849622_082024-O.jpg',a,b]};
  const html = renderPage(item,'libro',false,'');
  const schema = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(match => JSON.parse(match[1])).find(schema => schema['@type'] === 'Book' || schema['@type']?.includes?.('Product'));
  assert.deepEqual(schema.image, [
    'https://www.amadolibros.com/book-cover/MLU123456/cover-2.jpg',
    'https://www.amadolibros.com/book-cover/MLU123456/cover-3.jpg']);
});
