import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { vintagePilot } from '../_shared/meli-vintage-pilot.js';
import { PublicationError } from '../../worker-sync/publication-policy.js';

const ORIGIN='https://www.amadolibros.com',PATH='/panel/meli-vintage-piloto';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hidden=(key,value)=>'<input type="hidden" name="'+esc(key)+'" value="'+esc(value)+'">';
function form(action,fields,label) {
 return '<form method="post" action="'+PATH+'">'+hidden('action',action)+Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')+'<button>'+esc(label)+'</button></form>';
}
function html(title,body,status=200) {
 return new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+esc(title)+'</title><style>body{font:18px system-ui;max-width:1050px;margin:6vh auto;padding:24px;line-height:1.6}button,select{font:inherit;padding:12px;margin:12px 0;max-width:100%}button{cursor:pointer}table{border-collapse:collapse;width:100%}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}code{overflow-wrap:anywhere}small{display:block}h1{line-height:1.2}.table{overflow-x:auto}</style><h1>'+esc(title)+'</h1>'+body+'</html>',{status,headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
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
    else return html('Solicitud inválida','',400);
    return new Response(null,{status:303,headers:{Location:PATH,'Cache-Control':'no-store'}});
   }
   const state=await pilot.snapshot(env);
   let body='<p>Cuenta de destino: <strong>AMADO_VINTAGE · seller 2341378249</strong>. Prueba limitada a <strong>5 publicaciones</strong>.</p>';
   if(!state.run) {
    const sources=await pilot.sources(env);
    if(!sources.feeds.length||!sources.policies.length)return html('Prueba de Amado Vintage',body+'<p>Falta un snapshot vigente del proveedor o una política comercial de referencia. No se inició ninguna publicación.</p>');
    body+='<p>Elegí el stock y la política de referencia. Preparar solo consulta y valida en Mercado Libre; después se mostrarán los cinco títulos y precios.</p><form method="post" action="'+PATH+'">'+hidden('action','prepare')+'<label>Stock del proveedor<br><select name="feed_id">'+sources.feeds.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.source_date)+' · '+esc(f.expected_rows)+' ISBN</option>').join('')+'</select></label><br><label>Política del lote de referencia<br><select name="source_run_id">'+sources.policies.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.id)+' · '+esc(p.policy.availabilityDays)+' días · recargo '+pct(p.policy.additionalPricePct)+'</option>').join('')+'</select></label><br><button>Preparar la muestra de 5, sin publicar</button></form><p>Políticas disponibles:</p>';
    for(const source of sources.policies)body+='<details><summary>'+esc(source.id)+'</summary>'+policyHtml(source.policy)+'</details>';
    return html('Prueba de Amado Vintage',body);
   }
   body+='<p>Lote: <code>'+esc(state.run.id)+'</code><br>Estado: <strong>'+label(state.run.state)+'</strong>. Stock del proveedor: '+esc(state.feed?.source_date)+'.</p>'+policyHtml(state.policy);
   body+='<div class="table"><table><thead><tr><th>Título / ISBN</th><th>Precio UYU</th><th>Estado</th></tr></thead><tbody>'+state.sample.map(j=>'<tr><td>'+esc(j.title)+'<small>'+esc(j.isbn)+'</small></td><td>$ '+esc(j.price)+'</td><td>'+esc(j.state)+(j.item_id?'<small><a href="https://articulo.mercadolibre.com.uy/'+esc(j.item_id.replace('MLU','MLU-'))+'">'+esc(j.item_id)+'</a></small>':'')+'</td></tr>').join('')+'</tbody></table></div>';
   body+='<p>Avance: '+state.summary.counts.map(x=>esc(x.state)+': '+esc(x.n)).join(' · ')+'.</p>';
   if(state.can_approve)body+='<p>Revisá los cinco títulos, precios y condiciones. Al aprobar se habilitan únicamente estos cinco ISBN. La publicación comienza al presionar el botón del paso siguiente.</p>'+form('approve',{run_id:state.run.id,policy_hash:state.policy_hash,sample_hash:state.sample_hash},'Aprobar estos 5 títulos y sus precios');
   if(state.run.state==='preflight')body+=form('advance',{run_id:state.run.id},'Continuar validando, sin publicar');
   if(state.run.state==='publishing')body+='<p>Los cinco títulos están aprobados. El siguiente paso crea publicaciones reales en Vintage hasta el límite de cinco.</p>'+form('advance',{run_id:state.run.id},'Publicar / continuar los 5 aprobados en Vintage');
   if(['complete','complete_with_review'].includes(state.run.state))body+='<p>La prueba terminó. No se avanzará a los 10.000 automáticamente.</p>';
   if(state.issues.length)body+='<p>Casos para revisar: '+state.issues.map(j=>esc(j.isbn)+': '+esc(j.error)).join(' · ')+'.</p>';
   body+='<p><a href="'+PATH+'">Actualizar estado</a></p>';
   return html('Prueba de Amado Vintage',body);
  }catch(e){return html('No se pudo avanzar','<p>Diagnóstico: <code>'+esc(e instanceof PublicationError?e.code:'server_error')+'</code>.</p><p>Revisá el estado antes de repetir. <a href="'+PATH+'">Volver a la prueba</a>.</p>',e instanceof PublicationError?e.status:503);}
 };
}
export const onRequest=createVintagePilotPage();
