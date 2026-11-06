// Avisos por mail del publicador de Vintage en la nube (los manda el workflow después de cada corrida).
//  - Cierre del día: la primera corrida después de la medianoche de Montevideo manda cuántas altas
//    hubo el día anterior y el total publicado. Una sola vez por día.
//  - Trancado: la corrida falló, o publicó 0 sin llegar al tope diario. Como mucho uno cada 3 h
//    por motivo, para no llenar la casilla.
// Lo ya avisado queda en D1 (ml_vintage_cloud_alerts). Nunca manda claves ni tokens.
//
//   node scripts/vintage-cloud/aviso.mjs --reporte <reporte.json> --run-url <url> [--fallo]
import fs from 'node:fs/promises';
import {d1Client} from './d1.mjs';

export const SELLER='2341378249';
export const THROTTLE_MS=3*3600000;
const UY_OFFSET_MS=3*3600000;
export const uyDate=ms=>new Date(ms-UY_OFFSET_MS).toISOString().slice(0,10);
export const uyDayStart=date=>Date.parse(date+'T03:00:00Z');

// Qué avisar con lo que pasó en esta corrida. Pura: sin red ni D1.
export function decide({report,failed,now=Date.now()}){
 const out=[];
 const publicacion=report?.publicacion,freno=report?.freno;
 if(failed||report?.estado==='fallo'){
  out.push({id:'fallo',asunto:'el publicador falló',texto:`La corrida terminó con error${report?.error?` (${report.error}${report?.fase?`, fase ${report.fase}`:''})`:''}. No se publicó nada en esta vuelta. Se reintenta sola la próxima hora.`});
 }else if(report?.accion==='publicar'&&publicacion&&publicacion.altas_de_esta_corrida===0&&report?.estado!=='tope_diario_alcanzado'&&!(freno&&freno.altas_hoy>=freno.tope_diario)){
  out.push({id:'sin_altas',asunto:'la corrida no publicó nada',texto:`La corrida terminó (${publicacion.estado}) sin altas nuevas y sin haber llegado al tope del día (${freno?.altas_hoy??'?'} de ${freno?.tope_diario??'?'}). Total publicado: ${publicacion.publicados_total??'?'}.`});
 }
 // Cierre del día: entre las 00:00 y las 06:00 de Montevideo, el día anterior.
 const hourUy=new Date(now-UY_OFFSET_MS).getUTCHours();
 if(hourUy<6)out.push({id:'cierre-'+uyDate(now-86400000),daily:true,day:uyDate(now-86400000)});
 return out;
}

export async function sendMail({asunto,texto,fetcher=fetch,env=process.env}){
 const apiKey=env.RESEND_API_KEY,to=String(env.VINTAGE_EMAIL_TO||env.PRECIO_GANADOR_EMAIL_TO||'').split(',').map(s=>s.trim()).filter(Boolean);
 if(!apiKey||!to.length)return 'sin_credenciales';
 const res=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(30000),
  body:JSON.stringify({from:env.REPORT_EMAIL_FROM||'Amado Libros <web@notificaciones.amadolibros.com>',to,subject:`Vintage nube: ${asunto}`,text:texto})}).catch(()=>null);
 return res?.ok?'enviado':'error';
}

export async function run({report,failed,runUrl,query,now=Date.now(),send=sendMail}){
 await query('CREATE TABLE IF NOT EXISTS ml_vintage_cloud_alerts (key TEXT PRIMARY KEY,at INTEGER NOT NULL)');
 const sent=[];
 for(const alert of decide({report,failed,now})){
  const last=(await query('SELECT at FROM ml_vintage_cloud_alerts WHERE key=?',[alert.id]))[0]?.at??0;
  if(alert.daily?last>0:now-last<THROTTLE_MS)continue;
  let asunto=alert.asunto,texto=alert.texto;
  if(alert.daily){
   const start=uyDayStart(alert.day),end=start+86400000;
   const day=(await query("SELECT COUNT(*) n FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND created_at>=? AND created_at<?",[SELLER,start,end]))[0]?.n??0;
   const total=(await query("SELECT COUNT(*) n FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published'",[SELLER]))[0]?.n??0;
   const [y,m,d]=alert.day.split('-');
   asunto=`${Number(day).toLocaleString('es-UY')} altas el ${d}/${m}`;
   texto=`Amado Vintage publicó ${Number(day).toLocaleString('es-UY')} libros nuevos el ${d}/${m}/${y}.\nTotal publicado por la campaña: ${Number(total+5).toLocaleString('es-UY')}.`;
  }
  const result=await send({asunto,texto:texto+(runUrl?`\n\nDetalle de la última corrida: ${runUrl}`:'')});
  if(result==='enviado')await query('INSERT INTO ml_vintage_cloud_alerts(key,at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at',[alert.id,now]);
  sent.push({id:alert.id,result});
 }
 return sent;
}

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 let report=null;try{report=JSON.parse(await fs.readFile(get('--reporte'),'utf8'));}catch{}
 const sent=await run({report,failed:args.includes('--fallo')||!report,runUrl:get('--run-url'),query:d1Client()});
 console.log(JSON.stringify({avisos:sent}));
}
if(process.argv[1]?.endsWith('aviso.mjs'))await main();
