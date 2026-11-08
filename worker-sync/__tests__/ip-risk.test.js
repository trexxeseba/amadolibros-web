import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ipRisk,normalizeText} from '../ip-risk.js';

test('the three titles Mercado Libre flagged on 08/11/2026 are blocked',()=>{
 assert.equal(ipRisk('Libro Digital Society For The Ib Diploma, De Aa. Vv.. Editorial Hodder Education, En Inglés Internacional'),'digital');
 assert.ok(ipRisk('Dieci A1 - Libro + Ebook Interattivo, De Orlandino, Euridice. Editorial Alma Edizioni En Italiano'));
 assert.ok(ipRisk('Dieci B1 - Libro + Ebook Interattivo'));
});

test('earlier cases and the official policy words are blocked',()=>{
 for(const t of ['Cuaderno anillado de ejercicios','Manual encuadernado','Libro en PDF','Réplica del original','Libro símil cuero','Copia del manuscrito','Facsímil de la primera edición','E-book de regalo','Incluye código de acceso','Student Book with Online Access','English File Digital Pack','Audiolibro narrado','Libro + CD','Impreso bajo demanda','Libro + App','Kit de lectura','Versión e-book','Libro electrónico'])assert.ok(ipRisk(t),t);
});

test('ordinary book titles pass',()=>{
 for(const t of ['Cien años de soledad','El nombre de la rosa','Harry Potter y la piedra filosofal','Manual de cocina uruguaya','Historia de la Banda Oriental','The Great Gatsby','Rayuela','Sapiens: De animales a dioses','La sombra del viento'])assert.equal(ipRisk(t),null,t);
});

test('accents, case and punctuation do not hide a word',()=>{
 assert.equal(normalizeText('Réplica—ÉBOOK!'),'replica ebook');
 assert.ok(ipRisk('LIBRO-DIGITAL'));assert.ok(ipRisk('e.book'));
 assert.ok(ipRisk('Título limpio',"Editorial Digital"),'the publisher is checked too');
});

test('course material and entertainment brands are blocked',()=>{
 for(const t of ['Society For The Ib Diploma','English File Student\'s Book','Workbook with Key','Teacher\'s Guide','Libro del alumno A1','Practice Tests Plus','Disney Princesas Libro de cuentos','Marvel Avengers Enciclopedia','Libro Pokémon oficial','Lego Ninjago'])assert.ok(ipRisk(t),t);
});
