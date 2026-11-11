// Vigía de infracciones de propiedad intelectual de Amado Vintage, solo, cada 10 minutos
// (.github/workflows/vintage-vigia.yml). Hace lo mismo que el vigía de cada corrida del publicador
// (vigia-pi.mjs): lee infracciones y denuncias, y ante una nueva pausa la denunciada y las parecidas,
// las bloquea, pone el freno y manda el mail. No publica, no renueva el token, no toca precios.
//
//   node scripts/vintage-cloud/vigia.mjs
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {d1Client} from './d1.mjs';
import {watch,watchSignals,mlReaders} from './vigia-pi.mjs';

export async function correr({query,runUrl=null,vigia=null,senales=null}={}){
 try{
  let dq=null,readers=null;
  const prepare=()=>{dq=query??d1Client();readers=mlReaders(dq);};
  const result=vigia?await vigia():await (()=>{prepare();return watch({query:dq,...readers,runUrl});})();
  // Avisos del panel y reputación: si fallan no tumban el vigía de infracciones.
  let otras=null;
  try{otras=senales?await senales():await (()=>{if(!dq)prepare();return watchSignals({query:dq,getNotices:readers.getNotices,getReputation:readers.getReputation,getCompetencia:readers.getCompetencia,runUrl});})();}
  catch(error){otras={error:[error.code,error.message].find(x=>/^[a-z0-9_]{1,100}$/.test(x??''))??'senales_fallo'};}
  return {ok:true,vigia_pi:result,senales:otras};
 }catch(error){
  return {ok:false,error:[error.code,error.message].find(x=>/^[a-z0-9_]{1,100}$/.test(x??''))??'vigia_fallo'};
 }
}

async function main(){
 const out=await correr({runUrl:process.env.RUN_URL??null});
 console.log(JSON.stringify(out));
 if(!out.ok)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
