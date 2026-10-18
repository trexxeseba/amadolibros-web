import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { vintagePilot } from '../_shared/meli-vintage-pilot.js';
import { PublicationError } from '../../worker-sync/publication-policy.js';

const ORIGIN='https://www.amadolibros.com',PATH='/panel/meli-vintage-piloto';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hidden=(key,value)=>'<input type="hidden" name="'+esc(key)+'" value="'+esc(value)+'">';
function form(action,fields,label) {
 return '<form method="post" action="'+PATH+'"'+(['prepare','advance'].includes(action)?' data-vintage-preflight':'')+'>'+hidden('action',action)+Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')+'<button>'+esc(label)+'</button></form>';
}
function html(title,body,status=200) {
 return new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+esc(title)+'</title><style>body{font:18px system-ui;max-width:1050px;margin:6vh auto;padding:24px;line-height:1.6}button,select,input{font:inherit;padding:12px;margin:12px 0;max-width:100%;box-sizing:border-box}button{cursor:pointer}table{border-collapse:collapse;width:100%}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}code{overflow-wrap:anywhere}small{display:block}h1{line-height:1.2}.table{overflow-x:auto}.stock{background:#f7f5ef;border:1px solid #d6cfc2;border-radius:12px;padding:20px;margin:24px 0}.warning{color:#9a3412;font-weight:600}.stock h2{margin-top:0;font-size:23px}</style><h1>'+esc(title)+'</h1>'+body+'<script type="module" src="/assets/meli-vintage-preflight.js"></script><script type="module" src="/assets/meli-vintage-stock-upload.js"></script></html>',{status,headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; worker-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
}
const date=value=>value?esc(new Date(value).toLocaleString('es-UY',{timeZone:'America/Montevideo'})):'sin registro';
const errorLabel=code=>({supplier_stock_stale_or_future:'El archivo de SBS está vencido o tiene una fecha futura.',supplier_download_failed:'No se pudo descargar el archivo de SBS.',supplier_workbook_invalid:'El archivo descargado no tiene el formato de stock esperado.',selected_book_without_stock:'Uno de los cinco libros no tiene disponibilidad.',selected_isbn_changed:'El archivo no coincide con los cinco ISBN elegidos.',sample_changed_or_not_ready:'La muestra cambió o está en proceso.'}[code]??'No se pudo completar la actualización.');
function stockHtml(state){
 const diagnostics=state.stock_diagnostics??{},automatic=diagnostics.automatic,manual=diagnostics.manual;
 let out='<section class="stock"><h2>Stock para los cinco libros</h2>';
 if(state.feed)out+='<p'+(!state.stock_fresh?' class="warning"':'')+'>'+(state.stock_fresh?'Stock vigente.':'Stock vencido. Cargá un Excel actualizado para continuar.')+'<br>Fecha del proveedor: '+date(state.feed.source_date)+'.<br>Vence: '+date(Date.parse(state.feed.source_date)+86400000)+'.</p>';
 if(automatic)out+='<p>Última descarga automática: '+date(automatic.checked_at)+'.<br>Fecha del archivo recibido: '+date(automatic.source_date)+'.<br>'+(automatic.state==='success'?'Descarga e importación completas.':esc(errorLabel(automatic.error_code)))+'</p>';
 else out+='<p>La descarga automática todavía no tiene un resultado registrado en este panel.</p>';
 if(manual)out+='<p>Última carga manual: '+date(manual.checked_at)+'. '+(manual.state==='success'?'Stock confirmado para los cinco ISBN.':esc(errorLabel(manual.error_code)))+'</p>';
 if(state.can_upload)out+='<form data-vintage-stock data-isbns="'+esc(JSON.stringify(state.sample.map(j=>j.isbn)))+'">'+hidden('run_id',state.run.id)+hidden('feed_id',state.feed.id)+hidden('sample_hash',state.sample_hash)+'<label for="vintage-stock-file">Excel de stock de SBS</label><br><input id="vintage-stock-file" name="stock_file" type="file" accept=".xlsx" required><br><button type="submit">Cargar Excel y actualizar estos 5 ISBN</button></form><p>El archivo debe incluir disponibilidad, peso y fecha del proveedor, con menos de 24 horas. Se leerá en tu navegador y se enviarán solo las cinco filas elegidas. Si cambian los datos comerciales o de la edición, volverán a validación antes de aprobar.</p><p data-stock-notice role="status" aria-live="polite"></p>';
 return out+'</section>';
}
const pct=value=>esc((value*100).toFixed(2))+' %';
const labels={preflight:'validando',ready:'lista para revisar',publishing:'publicando',complete:'terminada',complete_with_review:'terminada con casos para revisar',stock_stale:'stock vencido',auth_error:'revisar conexión',pending:'pendientes',validated:'validados',published:'publicados',uncertain:'resultado por confirmar',creating:'en curso',review:'para revisar',retry:'en espera',skipped_pilot_limit:'fuera de la muestra',skipped_history:'ya procesados',skipped_duplicate:'duplicados',skipped_identity:'edición sin confirmar',skipped_category:'categoría sin confirmar',skipped_ml_requirement:'requisitos de Mercado Libre',skipped_stock_uncertain:'sin stock confirmado'};
const label=value=>esc(labels[value]??value);
function policyHtml(p) {
 return '<p>Política comercial: descuento del proveedor '+pct(p.supplierDiscount)+', cambio '+esc(p.arsPerUyu)+' ARS/UYU y '+esc(p.usdPerUyu)+' UYU/USD; flete USD '+esc(p.freightUsdKg)+'/kg; trabajo $ '+esc(p.laborUyu)+'; margen '+pct(p.margin)+'; comisión máxima '+pct(p.mlFee)+'; entrega $ '+esc(p.deliveryUyu)+'. Mínimo de venta $ '+esc(p.minimumSaleUyu)+' y contribución $ '+esc(p.minimumContributionUyu)+'; redondeo $ '+esc(p.roundUyu)+'; recargo '+pct(p.additionalPricePct)+'.</p><p>Disponibilidad: <strong>'+esc(p.availabilityDays)+' días</strong>. Tipo: '+esc(p.listingTypeId)+'. Catálogo: '+(p.catalogListing==='required_only'?'solo cuando Mercado Libre lo exige':'desactivado')+'. Una unidad por publicación. Moneda: UYU.</p>';
}
export function createVintagePilotPage({pilot=vintagePilot}={}) {
 return async function onRequest({request,env}) {
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||env.APP_ENV!=='production')return html('No disponible','',403);
  const panel=resolvePanelConfig(env);
  if(!panel.ok||!await hasValidSession(request,await deriveSessionSecret(panel.password)))return html('Ingresá al panel','<p><a href="/panel">Abrir el panel de Amado</a>. Después volvé a esta página.</p>',401);
  if(!['GET','POST'].includes(request.method))return html('Método no permitido','',405);
  try {
   if(request.method==='POST') {
    if(request.headers.get('origin')!==ORIGIN||!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return html('Solicitud inválida','',403);
    if(Number(request.headers.get('content-length'))>2048)return html('Solicitud inválida','',413);
    const raw=await request.text();if(raw.length>2048)return html('Solicitud inválida','',413);
    const args=Object.fromEntries(new URLSearchParams(raw)),action=args.action;
    if(action==='prepare')await pilot.prepare(env,args);
    else if(action==='advance')await pilot.advance(env,args);
    else if(action==='approve')await pilot.approve(env,args);
    else if(action==='publish_approved')await pilot.publishApproved(env,args);
    else if(action==='verify_published')await pilot.verifyPublished(env,args);
    else return html('Solicitud inválida','',400);
    return new Response(null,{status:303,headers:{Location:PATH,'Cache-Control':'no-store'}});
   }
   const state=await pilot.snapshot(env);
   if(url.searchParams.get('format')==='progress'){
    return Response.json({run_id:state.run?.id??null,state:state.run?.state??'not_started',disabled:state.progress?.disabled??false,indexed:state.progress?.indexed??0,index_complete:state.progress?.index_complete??false,index_status:state.progress?.index_status??'active',busy:state.progress?.busy??false,resume_at:state.progress?.backoff_until??0,counts:state.summary?.counts??[]},{headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'same-origin','X-Frame-Options':'DENY'}});
   }
   let body='<p>Cuenta de destino: <strong>AMADO_VINTAGE · seller 2341378249</strong>. Prueba limitada a <strong>5 publicaciones</strong>.</p>'+stockHtml(state);
   if(!state.run) {
    const sources=await pilot.sources(env);
    if(!sources.feeds.length||!sources.policies.length){
     if(!sources.feeds.length)body+='<p>Falta cargar un archivo vigente del proveedor y completar su importación. El stock debe tener menos de 24 horas.</p>';
     if(!sources.policies.length)body+='<p>Falta una política comercial de referencia para calcular y revisar los precios.</p>';
     return html('Prueba de Amado Vintage',body+'<p>No se inició ninguna publicación.</p>');
    }
    body+='<p>Elegí el stock y la política de referencia. Preparar solo consulta y valida en Mercado Libre; después se mostrarán los cinco títulos y precios.</p><form method="post" action="'+PATH+'" data-vintage-preflight>'+hidden('action','prepare')+'<label>Stock del proveedor<br><select name="feed_id">'+sources.feeds.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.source_date)+' · '+esc(f.expected_rows)+' ISBN</option>').join('')+'</select></label><br><label>Política del lote de referencia<br><select name="source_run_id">'+sources.policies.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.id)+' · '+esc(p.policy.availabilityDays)+' días · recargo '+pct(p.policy.additionalPricePct)+'</option>').join('')+'</select></label><br><button>Preparar la muestra de 5, sin publicar</button></form><p>Políticas disponibles:</p>';
    for(const source of sources.policies)body+='<details><summary>'+esc(source.id)+'</summary>'+policyHtml(source.policy)+'</details>';
    return html('Prueba de Amado Vintage',body);
   }
   body+='<p>Lote: <code>'+esc(state.run.id)+'</code><br>Estado: <strong>'+label(state.display_state??state.run.state)+'</strong>.</p>';
   if(state.progress){
    const p=state.progress;
    if(p.disabled)body+='<p>El publicador está deshabilitado por configuración. La validación no puede avanzar hasta habilitarlo.</p>';
    body+='<p><strong>'+(p.index_complete?'Revisión de publicaciones existentes terminada.':'Revisando publicaciones '+(p.index_status==='paused'?'pausadas':'activas')+' de Vintage para evitar duplicados.')+'</strong><br>Publicaciones revisadas: <strong>'+esc(p.indexed)+'</strong>. Los libros del proveedor se validan después de completar esta revisión.</p>';
    if(p.busy)body+='<p>Hay una comprobación en curso. Usá Actualizar estado para ver su avance. Si se interrumpió, se podrá continuar al vencer la reserva, a las '+esc(new Date(p.lease_until).toLocaleTimeString('es-UY',{timeZone:'America/Montevideo'}))+'.</p>';
    if(p.backoff_until>Date.now())body+='<p>Mercado Libre pidió una pausa. Podrá continuar a las '+esc(new Date(p.backoff_until).toLocaleTimeString('es-UY',{timeZone:'America/Montevideo'}))+'.</p>';
   }
   body+=policyHtml(state.policy);
   body+='<div class="table"><table><thead><tr><th>Título / ISBN</th><th>Precio UYU</th><th>Estado</th></tr></thead><tbody>'+state.sample.map(j=>{
    const verification=(state.verified??[]).find(v=>v.isbn===j.isbn&&v.item_id===j.item_id);
    const verified=verification?'<small>'+(verification.ok?'Verificada en Mercado Libre.':'Requiere revisión en Mercado Libre.')+' '+date(verification.checked_at)+'</small>':'';
    return '<tr><td>'+esc(j.title)+'<small>'+esc(j.isbn)+'</small></td><td>'+(typeof j.price==='number'?'$ '+esc(j.price):'Pendiente de validación')+'</td><td>'+label(j.state)+(j.item_id?'<small><a href="https://articulo.mercadolibre.com.uy/'+esc(j.item_id.replace('MLU','MLU-'))+'" target="_blank" rel="noopener">Ver publicación '+esc(j.item_id)+'</a></small>'+verified:'')+'</td></tr>';
   }).join('')+'</tbody></table></div>';
   body+='<p>Libros del proveedor: '+state.summary.counts.map(x=>label(x.state)+': '+esc(x.n)).join(' · ')+'.</p>';
   if(state.can_approve&&!state.progress?.disabled)body+='<p>Revisá los cinco títulos, precios y condiciones. Al aprobar comenzará la publicación real de estos cinco ISBN en Amado Vintage.</p>'+form('approve',{run_id:state.run.id,policy_hash:state.policy_hash,sample_hash:state.sample_hash},'Aprobar precios y publicar estos 5 en Vintage');
   if(state.run.state==='preflight'&&state.stock_fresh!==false&&!state.progress?.disabled&&!state.progress?.busy&&!(state.progress?.backoff_until>Date.now()))body+=form('advance',{run_id:state.run.id},'Continuar validación automática, sin publicar');
   if(state.run.state==='publishing'&&!state.progress?.disabled)body+='<p>Los cinco títulos están aprobados. El siguiente paso crea publicaciones reales en Vintage hasta el límite de cinco.</p>'+form('publish_approved',{run_id:state.run.id},'Publicar / continuar los 5 aprobados en Vintage');
   if(['complete','complete_with_review'].includes(state.run.state))body+='<p>La prueba terminó. No se avanzará a los 10.000 automáticamente.</p><p><a href="/panel/meli-vintage-lote">Abrir el lote de Vintage por tandas</a></p>';
   if(state.sample.some(j=>j.state==='published'&&j.item_id))body+='<p>Comprobá la cuenta, ISBN, precio, cantidad y plazo de disponibilidad de las publicaciones creadas.</p>'+form('verify_published',{run_id:state.run.id},'Verificar publicaciones creadas en Mercado Libre');
   if(state.issues.length)body+='<p>Casos para revisar: '+state.issues.map(j=>esc(j.isbn)+': '+esc(j.error)).join(' · ')+'.</p>';
   body+='<p><a href="'+PATH+'">Actualizar estado</a></p>';
   return html('Prueba de Amado Vintage',body);
  }catch(e){return html('No se pudo avanzar','<p>Diagnóstico: <code>'+esc(e instanceof PublicationError?e.code:'server_error')+'</code>.</p><p>Revisá el estado antes de repetir. <a href="'+PATH+'">Volver a la prueba</a>.</p>',e instanceof PublicationError?e.status:503);}
 };
}
export const onRequest=createVintagePilotPage();
