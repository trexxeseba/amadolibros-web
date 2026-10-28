// La cola de altas del Worker publica en Amado Libros (440298103). Seba decidió el
// 26/10/2026 que ahí no hay altas automáticas: las altas van solo a Amado Vintage
// (Global Emporium) desde la PC. Ver docs/cuentas-mercado-libre.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createPublicationService} from '../publication-engine.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wrangler=readFileSync(path.join(root,'wrangler.toml'),'utf8');
const value=name=>wrangler.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`,'m'))?.[1];

test('the Worker that publishes to Amado Libros stays read-only: no publication ticks and no queue',()=>{
 assert.equal(value('USER_ID'),'440298103');
 assert.equal(value('ML_PUBLISHER_MODE'),'disabled','la cola de Amado Libros se reactiva solo con pedido explícito de Seba');
 assert.equal(value('ML_PUBLISH_QUEUE_ENABLED'),'false','la cola de Amado Libros se reactiva solo con pedido explícito de Seba');
});
test('with the publisher disabled a publication tick does nothing',async()=>{
 const env={USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'disabled',ORDERS_DB:{}};
 const service=createPublicationService({sellerId:'440298103',api:{},storeFactory:()=>({async initialize(){}})});
 assert.deepEqual(await service.tick(env),{state:'disabled'});
});
