// Sube el objetivo de la campaña de Amado Vintage sin editar la base a mano.
//
//   node --experimental-sqlite scripts/vintage-local/set-target.mjs <nuevo total> [--directory <carpeta de estado>] [--apply]
//
// <nuevo total> es el número que muestra published_total en status.json (incluye los 5 del
// piloto). Sin --apply sólo muestra lo que haría. Únicamente sube el objetivo (nunca lo baja),
// hasta MAX_TARGET_TOTAL, y sólo en la campaña de Vintage. Se puede correr con el publicador
// andando: el motor relee el objetivo en cada vuelta y, si la campaña ya se había cerrado, el
// autorun la reabre en menos de 15 minutos.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from './db.mjs';
import {VintageBulkStore,BULK_RUN} from '../../functions/_shared/meli-vintage-bulk.js';
import {MAX_TARGET_TOTAL,SELLER} from './engine.mjs';

export const PILOT_PUBLISHED=5;

export async function setTarget(store,newTotal,{apply=false,maxTotal=MAX_TARGET_TOTAL}={}){
 const to=newTotal-PILOT_PUBLISHED,max=maxTotal-PILOT_PUBLISHED;
 const plan=await store.planRaise(BULK_RUN,to,max);
 const published=await store.publishedCount(BULK_RUN);
 if(apply)await store.raiseTarget(BULK_RUN,to,max);
 return {from_total:plan.from+PILOT_PUBLISHED,to_total:newTotal,published_total:PILOT_PUBLISHED+published,applied:apply};
}

async function main(){
 const args=process.argv.slice(2),at=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
 const apply=args.includes('--apply'),total=Number(args.find(a=>/^\d+$/.test(a)));
 const directory=at('--directory')??path.join(process.env.LOCALAPPDATA??'','Amado','VintagePublisher');
 if(!Number.isInteger(total)){console.error('Uso: set-target.mjs <nuevo total> [--directory <carpeta>] [--apply]');process.exitCode=2;return;}
 const db=openDatabase(path.join(directory,'publisher.sqlite'));
 try{
  const result=await setTarget(new VintageBulkStore(db,{sellerId:SELLER}),total,{apply});
  console.log(`Objetivo: ${result.from_total} -> ${result.to_total} (publicados ahora: ${result.published_total}, tope: ${MAX_TARGET_TOTAL}).`);
  console.log(result.applied?'APLICADO. El motor lo toma en su próxima vuelta; si la campaña estaba cerrada, el autorun la reabre en menos de 15 minutos.':'PRUEBA: no se cambió nada. Repetí con --apply para aplicarlo.');
 }catch(error){
  console.error('No se cambió nada:',error?.message??error);process.exitCode=1;
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
