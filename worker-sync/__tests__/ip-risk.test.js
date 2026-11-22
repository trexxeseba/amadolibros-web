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

test('school and language textbook publishers are blocked even with a clean title',()=>{
 assert.equal(ipRisk('Libro Arriviamo! 3, De Anna Maria Crimi, Vol. 3. Editorial Eli Edizioni, Tapa Blanda'),'editorial_educativa');
 assert.ok(ipRisk('Arriviamo 3','Eli Edizioni'));
 assert.ok(ipRisk('Arriviamo 3','ELI'));
 assert.ok(ipRisk('Dieci A1','Alma'));
 assert.equal(ipRisk('El alma del mundo','Planeta'),null);
 assert.equal(ipRisk('Eli y el mar','Alfaguara'),null);
 assert.ok(ipRisk('Society','Hodder Education'));
 assert.ok(ipRisk('Dieci A1','Alma Edizioni'));
 assert.equal(ipRisk('Cien años de soledad','Penguin Random House'),null);
});

test('alertas de la investigación del 19/11/2026: contacto externo, sexo/kama sutra, medicamentos e imitación se retienen',()=>{
 assert.equal(ipRisk('Kama Sutra ilustrado'),'adulto');
 assert.equal(ipRisk('Amor y sexo en España contado para escépticos'),'adulto');
 assert.equal(ipRisk('Prozac Nation','Anagrama'),'medicamento');
 assert.equal(ipRisk('Clonazepam: guía'),'medicamento');
 assert.equal(ipRisk('Escribime por WhatsApp para pagar por fuera'),'contacto');
 assert.equal(ipRisk('Libro nuevo, contacto vendedor@gmail.com'),'arroba');
 assert.equal(ipRisk('Escribime por t.me/vendedor'),'contacto');
 assert.equal(ipRisk('Counterfeit edition'),'imitacion');
 assert.equal(ipRisk('Libro escaneado'),'imitacion');
});

test('los títulos editoriales verdaderos siguen pasando',()=>{
 assert.equal(ipRisk('La hora antes del alba','Planeta'),null);
 assert.equal(ipRisk('Todas las noches, todas las ciudades','Destino'),null);
 assert.equal(ipRisk('El hombre en busca del sentido','Herder'),null);
});

test('pirata, estilo, tipo e imitación siguen retenidas hasta que Seba apruebe aflojarlas; las marcas de lujo también',()=>{
 assert.equal(ipRisk('Te quiero tanto tanto tantisimo','DEL PIRATA, EDICIONS'),'copia');
 assert.equal(ipRisk('Supera la diabetes tipo 2','EDAF'),'copia');
 assert.equal(ipRisk('La imitación de Cristo','San Pablo'),'copia');
 assert.equal(ipRisk('Referentes estilo. Chanel nº 5','Blume'),'copia');
 assert.equal(ipRisk('Un libro con Birkin y Rolex'),'marca');
});

test('una arroba en el título, el autor o la editorial deja el libro fuera',()=>{
 assert.equal(ipRisk('Los dones de los niños altamente sensibles URSULA PERONA @URSULAPERONAPSICOLOGA','ZENITH'),'arroba');
 assert.equal(ipRisk('Psicología Zombi','VERGARA @algo'),'arroba');
 assert.equal(ipRisk('Psicología Zombi','Vergara'),null);
});

test('casos que Mercado Libre ya dio de baja en cuentas del dueño y marcas que reclamaron quedan afuera (correos 2023 a 2026)',()=>{
 assert.equal(ipRisk('Los Secretos De La Mente Millonaria','Sirio'),'reclamado_antes');
 assert.equal(ipRisk('Secrets Of The Millionaire Mind: Mastering','Harper'),'reclamado_antes');
 assert.equal(ipRisk('Never Finished: Unshackle Your Mind','Lioncrest'),'reclamado_antes');
 assert.equal(ipRisk('Why Men Love Bitches: From Doormat To Dreamgirl','Health Communications'),'reclamado_antes');
 assert.equal(ipRisk('El Eternauta Edicion Economica','Planeta'),'reclamado_antes');
 assert.equal(ipRisk('El Codice Neshama','Autor'),'reclamado_antes');
 assert.equal(ipRisk('Pulsera Swarovski cristal','x'),'marca_reclamada');
 assert.equal(ipRisk('Calcomanias Red Bull vinilo','x'),'marca_reclamada');
 assert.equal(ipRisk('La hora antes del alba','Planeta'),null);
 assert.equal(ipRisk('El poder del ahora','Gaia'),null);
});
