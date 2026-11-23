// Sondeo de LECTURA (23/11/2026): estado de publicaciones viejas de Vintage (para saber si la restricción es de toda la cuenta). No escribe nada.
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
import {exigirVintage} from './guardia.mjs';
import {bulkItemsPath, bulkEntryItem} from '../worker-sync/meli-bulk.js';
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 2});
await exigirVintage(ml);
const ids = ["MLU717110198", "MLU649898229", "MLU717168456", "MLU717006090", "MLU649835621", "MLU717875290", "MLU716940298", "MLU649807385", "MLU716979344", "MLU716928308", "MLU649703925", "MLU649793795", "MLU649767777", "MLU717263682", "MLU716980078", "MLU716941194", "MLU716966734", "MLU716980044", "MLU716940404", "MLU649704035", "MLU721530662", "MLU721517642", "MLU720401658", "MLU717604446", "MLU719604874", "MLU1540952072", "MLU1541276716", "MLU1541003516", "MLU1541364052", "MLU1540977848", "MLU1541364636", "MLU1541302158", "MLU1541289222", "MLU1541366230", "MLU1541301972", "MLU1541272384", "MLU1540965074", "MLU1541364628", "MLU1540315368", "MLU1541301978", "MLU1541289178", "MLU1541290080", "MLU1540289340", "MLU1541303948", "MLU1541364596", "MLU1541288608", "MLU1541304384", "MLU1541298574", "MLU1541303068", "MLU1541003548", "MLU1541288660", "MLU1540302142", "MLU1540328278", "MLU1540315366", "MLU1541303702", "MLU1541289886", "MLU1540289346", "MLU1541289018", "MLU1541366256", "MLU1541298558", "MLU1541289166", "MLU1541365276", "MLU1541298560", "MLU1541289180", "MLU1541365406", "MLU1540328272", "MLU704411323", "MLU704355231", "MLU1541289168", "MLU1522456644", "MLU1526359102", "MLU1531967836", "MLU703772493", "MLU739806198", "MLU703614401", "MLU1531857872", "MLU1524194246", "MLU702853415", "MLU719001508", "MLU1526346196"];
const est = {}, ej = [];
for (let i = 0; i < ids.length; i += 20) for (const e of await ml.get(bulkItemsPath(ids.slice(i, i + 20), 'id,status,sub_status,date_created,title')).catch(() => [])) { const it = bulkEntryItem(e); if (!it?.id) continue; const k = String(it.date_created).slice(0, 7) + ' ' + it.status + (it.sub_status?.length ? ':' + it.sub_status.join(',') : ''); est[k] = (est[k] || 0) + 1; if (ej.length < 8) ej.push([it.id, String(it.date_created).slice(0, 10), it.status, it.sub_status, String(it.title).slice(0, 30)]); }
console.log('VIEJAS', ids.length, JSON.stringify(est));
console.log('EJ', JSON.stringify(ej));
const o = await ml.get('/orders/search?seller=' + (await ml.get('/users/me')).id + '&sort=date_desc&limit=3').catch(e => ({__err: e.code}));
console.log('ULTIMAS_VENTAS', JSON.stringify((o?.results ?? []).map(x => [x.date_created, x.status])));
