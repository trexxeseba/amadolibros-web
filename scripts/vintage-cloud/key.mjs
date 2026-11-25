// Clave de corrida para /operations/vintage-renew sin secreto en GitHub.
//   node scripts/vintage-cloud/key.mjs crear   -> genera una clave, guarda su hash en D1 (vence en 4 h)
//                                                 y la deja en $GITHUB_ENV como VINTAGE_RENEW_SECRET,
//                                                 enmascarada en los registros. Nunca la imprime.
//   node scripts/vintage-cloud/key.mjs borrar  -> borra de D1 la clave de esta corrida y las vencidas.
import fs from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {d1Client} from './d1.mjs';
export const TABLE='ml_vintage_cloud_keys';
export const SCHEMA=`CREATE TABLE IF NOT EXISTS ${TABLE} (key_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)`;
export const TTL_MS=4*3600000;
const hash=key=>createHash('sha256').update(key,'utf8').digest('hex');
export async function createKey(query,now=Date.now()){
 const key=randomBytes(32).toString('hex');
 await query(SCHEMA);
 await query(`DELETE FROM ${TABLE} WHERE expires_at<=?`,[now]);
 await query(`INSERT INTO ${TABLE}(key_hash,expires_at,created_at) VALUES(?,?,?)`,[hash(key),now+TTL_MS,now]);
 return key;
}
export async function deleteKey(query,key,now=Date.now()){
 await query(`DELETE FROM ${TABLE} WHERE key_hash=? OR expires_at<=?`,[hash(key??''),now]);
}
async function main(){
 const query=d1Client(),action=process.argv[2];
 if(action==='crear'){
  const key=await createKey(query);
  process.stdout.write(`::add-mask::${key}\n`);
  await fs.appendFile(process.env.GITHUB_ENV,`VINTAGE_RENEW_SECRET=${key}\n`);
  console.log('Clave de corrida creada (vence en 4 h).');
 }else if(action==='borrar'){
  await deleteKey(query,process.env.VINTAGE_RENEW_SECRET);
  console.log('Clave de corrida borrada.');
 }else{console.error('Uso: key.mjs crear|borrar');process.exitCode=2;}
}
if(process.argv[1]?.endsWith('key.mjs'))await main();
