// Vintage sales -> Airtable; operational summary -> one owned ML note per order.
// Never log customer/order data: this repository and Actions logs are public.
export const SELLER = '2341378249';
export const BASE = 'appA7zwO1Yo0FGTvz';
export const TABLE = 'tblhcKFTWeTJwH5GJ';
export const START = '2026-11-09T03:00:00.000Z';
export const F = {
 id:'ML Venta ID', pack:'ML Pack ID', buyer:'Comprador ML', sale:'Estado venta ML',
 shipping:'Estado envío ML', follow:'Seguimiento para ML', sync:'Sincronización ML',
 noteId:'Nota ML ID', noteText:'Nota ML sincronizada', synced:'Última sincronización ML',
 category:'Categoría', title:'Título', date:'Fecha consulta', state:'Estado', channel:'Canal',
 detail:'Detalle canal', price:'Precio de venta', payment:'Medio de pago',
 notes:'NOTAS', responsible:'Responsable', supplier:'Pedido en', bought:'Fecha compra',
 eta:'Entrega estimada', seen:'Visto'
};
export const fail = code => Object.assign(new Error(code), {code});
export const safeError = e => /^[a-z0-9_]+$/.test(e?.code || '') ? e.code : 'error_no_clasificado';
export function id(value) {
 if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fail('id_inseguro');
 const s=String(value ?? '');
 if (!/^\d{1,18}$/.test(s)) throw fail('id_invalido');
 return s;
}
const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();
const short = (value,n) => [...clean(value)].slice(0,n).join('');
export function validateOrder(o,expected) {
 if(id(o.id)!==id(expected)||String(o.seller?.id)!==SELLER)throw fail('venta_cuenta_incorrecta');
 if(o.currency_id!=='UYU')throw fail('moneda_no_uyu');
 if(!Array.isArray(o.order_items)||!o.order_items.length)throw fail('venta_sin_items');
 if(!Number.isFinite(o.total_amount)||o.total_amount<0||!Number.isFinite(Date.parse(o.date_created)))throw fail('venta_invalida');
 return o;
}
export function noteTarget(o) {
 return o.pack_id ? '/packs/'+id(o.pack_id)+'/notes' : '/orders/'+id(o.id)+'/notes';
}
export function unpackNotes(body) {
 const a=Array.isArray(body)?body:Array.isArray(body?.results)?body.results:null;
 if(!a)throw fail('notas_respuesta_invalida');
 return a.flatMap(x=>Array.isArray(x?.results)?x.results:[x]).map(n=>{
  if(!n||n.id===undefined||typeof n.note!=='string')throw fail('nota_invalida');
  return {...n,id:String(n.id)};
 });
}
export function buildSummary(f,orderId) {
 const parts=['[AMADO '+id(orderId)+']',
  'Gestión: '+short(f[F.state]||'pendiente',35)];
 if(f[F.responsible])parts.push('Resp: '+short(f[F.responsible],20));
 if(f[F.supplier])parts.push('Proveedor: '+short(f[F.supplier],30));
 if(f[F.bought])parts.push('Compra: '+short(f[F.bought],10));
 if(f[F.eta])parts.push('Prevista: '+short(f[F.eta],10));
 if(f[F.sale] && f[F.sale]!=='paid')parts.push('ML: '+short(f[F.sale],24));
 if(f[F.shipping])parts.push('Envío: '+short(f[F.shipping],40));
 if(f[F.follow])parts.push('Acción: '+clean(f[F.follow]));
 return short(parts.join(' | '),300);
}
export function selectNote(notes,f,orderId) {
 const marker='[AMADO '+id(orderId)+']';
 const owned=notes.filter(n=>n.note.startsWith(marker));
 if(owned.length>1)throw fail('notas_duplicadas_revisar');
 const saved=f[F.noteId];
 if(saved && (!owned.length || owned[0].id!==saved))throw fail('nota_borrada_o_identidad_cambiada');
 if(owned[0] && f[F.noteText] && owned[0].note!==f[F.noteText] && owned[0].note!==buildSummary(f,orderId))throw fail('nota_editada_manualmente');
 // After uncertain POST, adopt only an exact match; never adopt arbitrary marker text.
 if(owned[0] && !f[F.noteText] && owned[0].note!==buildSummary(f,orderId))throw fail('nota_sin_recibo_revisar');
 return owned[0]||null;
}
export function importedFields(o,shipment) {
 const f={
  [F.id]:id(o.id),[F.pack]:o.pack_id?id(o.pack_id):'',
  [F.buyer]:clean([o.buyer?.first_name,o.buyer?.last_name,o.buyer?.nickname].filter(Boolean).join(' | ')),
  [F.sale]:o.status,[F.shipping]:shipment?clean([shipment.status,shipment.substatus].filter(Boolean).join(' / ')):'sin envío informado'
 };
 return f;
}

export async function classifyOrder(o,ml) {
 const kinds=[];
 for(const line of o.order_items){
  const itemId=String(line.item?.id||'');
  if(!/^MLU\d+$/.test(itemId))throw fail('publicacion_invalida');
  const item=await ml.get('/items/'+itemId);
  if(item.id!==itemId||String(item.seller_id)!==SELLER)throw fail('publicacion_cuenta_incorrecta');
  if(!item.domain_id)throw fail('tipo_libro_no_verificable');
  if(item.domain_id!=='MLU-BOOKS'){kinds.push('notBook');continue;}
  const term=(item.sale_terms||[]).find(t=>t.id==='MANUFACTURING_TIME');
  const days=Number(term?.value_struct?.number ?? String(term?.value_name||'').match(/^\s*(\d+)/)?.[1] ?? 0);
  if(!Number.isFinite(days))throw fail('plazo_no_verificable');
  kinds.push(days>0?'demand':'stock');
 }
 if(kinds.every(k=>k==='demand'))return 'demand';
 if(kinds.includes('demand'))throw fail('orden_mixta_revisar');
 return kinds.includes('notBook')?'notBook':'stock';
}

export function newFields(o,shipment) {
 return {...importedFields(o,shipment),
  [F.title]:o.order_items.map(i=>clean(i.item?.title)+' × '+i.quantity).join('\n'),
  [F.date]:o.date_created,[F.state]:shipment?.status==='delivered'?'entregado':'pago_total',[F.channel]:'Otros',
  [F.category]:'Por encargo',[F.follow]:'Verificar si ya se compró al proveedor y completar seguimiento.',
  [F.detail]:'Mercado Libre | AMADO_VINTAGE | Venta '+id(o.id),
  [F.price]:o.total_amount,[F.payment]:'Mercado Pago',[F.seen]:false,
  [F.notes]:'Venta importada por API. Importe total de la orden en UYU; no es el neto liquidado. Pago del cliente confirmado; compra al proveedor NO confirmada.\nDetalle: https://www.mercadolibre.com.uy/ventas/'+id(o.id)+'/detalle\n'+o.order_items.map(i=>'Publicación '+clean(i.item?.id)+' | cantidad '+i.quantity+' | precio unitario '+i.unit_price).join('\n')
 };
}
export async function syncSales({ml,at,real=false,start=START,now=()=>new Date().toISOString(),wait=ms=>new Promise(r=>setTimeout(r,ms))}) {
 const stats={read:0,created:0,updated:0,notesWritten:0,unchanged:0,aliases:0,skippedStock:0,skippedNotBook:0,errors:0};
 const me=await ml.get('/users/me');
 if(String(me.id)!==SELLER||me.site_id!=='MLU')throw fail('token_no_es_vintage');
 const rows=await at.list();
 const byId=new Map();
 for(const r of rows){
  const key=id(r.fields[F.id]);
  if(byId.has(key))throw fail('airtable_venta_duplicada');
  byId.set(key,r);
 }
 const discovered=await ml.search(start);
 const orderCache=new Map(), packOrders=new Map();
 for(const orderId of discovered.map(id)){
  const o=validateOrder(await ml.get('/orders/'+orderId),orderId);
  orderCache.set(orderId,o);
  if(o.pack_id){const p=id(o.pack_id);packOrders.set(p,[...(packOrders.get(p)||[]),orderId]);}
 }
 // Email sale links can carry a pack ID. Resolve only an exact, unambiguous
 // API relationship, before importing anything; never match by title/buyer.
 for(const [key,row] of [...byId]){
  if(orderCache.has(key)||!packOrders.has(key))continue;
  const matches=packOrders.get(key);
  if(matches.length!==1)throw fail('pack_email_con_varias_ordenes_revisar');
  const canonical=matches[0];
  if(byId.has(canonical))throw fail('airtable_pack_y_orden_duplicados');
  const fields={[F.id]:canonical,[F.pack]:key};
  if(real)await at.patch(row.id,fields);
  row.fields={...row.fields,...fields};
  byId.delete(key);byId.set(canonical,row);stats.aliases++;
 }
 const ids=[...new Set([...byId.keys(),...discovered.map(id)])];
 for(const orderId of ids){
  let row=byId.get(orderId);
  try {
   const o=orderCache.get(orderId)||validateOrder(await ml.get('/orders/'+orderId),orderId);
   stats.read++;
   if(!row && (o.status!=='paid'||Date.parse(o.date_created)<Date.parse(start)))continue;
   if(!row){
    const kind=await classifyOrder(o,ml);
    if(kind!=='demand'){stats[kind==='stock'?'skippedStock':'skippedNotBook']++;continue;}
   }
   let shipment=null;
   if(o.shipping?.id)shipment=await ml.get('/shipments/'+id(o.shipping.id));
   const incoming=importedFields(o,shipment);
   if(!row){
    if(!real){stats.created++; await ml.get(noteTarget(o)).then(unpackNotes); continue;}
    // Server upsert and workflow concurrency prevent duplicate creates/retries.
    row=await at.upsert(newFields(o,shipment));stats.created++;
   }else if(real){
    const titlePatch = !row.fields[F.title] || row.fields[F.title].includes('[título truncado en email]') ? {[F.title]:newFields(o,shipment)[F.title]} : {};
    await at.patch(row.id,{...incoming,...titlePatch,[F.sync]:'Pendiente: comprobando nota'});
    stats.updated++;
   }
   // Reread immediately before composing: keep current human edits.
   if(real)row=await at.get(row.id);
   const f={...row.fields,...incoming};
   if (!ml.write) {
    // Read every available surface: a seller may have used the order or the pack.
    const archive = 'Respaldo notas manuales ML';
    const targets = [...new Set([noteTarget(o), '/orders/'+orderId+'/notes'])];
    const previous = f[archive] || '';
    let snapshot = previous;
    let unavailable = false;
    for (const path of targets) {
     try {
      for (const entry of unpackNotes(await ml.get(path))) {
       if (!entry.note || (entry.id === String(f[F.noteId]) && entry.note === f[F.noteText])) continue;
       const block = path+' #'+entry.id+'\n'+entry.note;
       if (!snapshot.split('\n\n---\n\n').includes(block)) snapshot += (snapshot?'\n\n---\n\n':'')+block;
      }
     } catch { unavailable = true; }
    }
    if (real) await at.patch(row.id,{
     ...(snapshot!==previous ? {[archive]:snapshot} : {}),
     [F.sync]:unavailable?'Solo lectura ML: lectura parcial':'Solo lectura ML',
     [F.synced]:now()
    });
    if (unavailable) stats.errors++;
    continue;
   }
   const desired=buildSummary(f,orderId), target=noteTarget(o);
   const notes=unpackNotes(await ml.get(target));
   const old=selectNote(notes,f,orderId);
   if(!real){if(!old||old.note!==desired)stats.notesWritten++;else stats.unchanged++;continue;}
   if(!old||old.note!==desired){
    // No blind write retries. A timeout is reconciled by reading this marker next run.
    await ml.write(old?'PUT':'POST',old?target+'/'+encodeURIComponent(old.id):target,{note:desired});
    stats.notesWritten++;
   }else stats.unchanged++;
   let confirmed;
   // ML can acknowledge a note before its GET is consistent. Retry reads only.
   for(const delay of [0,1000,2000,4000,8000]){
    if(delay)await wait(delay);
    confirmed=unpackNotes(await ml.get(target)).filter(n=>n.note.startsWith('[AMADO '+orderId+']'));
    if(confirmed.length===1&&confirmed[0].note===desired)break;
    if(confirmed.length>1)throw fail('notas_duplicadas_revisar');
   }
   if(confirmed.length!==1||confirmed[0].note!==desired)throw fail('nota_no_confirmada');
   // Detect a human edit during the API call; next run sends the new content.
   const latest=await at.get(row.id);
   const stillCurrent=buildSummary({...latest.fields,...incoming},orderId)===desired;
   await at.patch(row.id,{
    [F.noteId]:confirmed[0].id,[F.noteText]:desired,
    [F.sync]:stillCurrent?'OK':'Pendiente: seguimiento cambió durante la sincronización',
    [F.synced]:now()
   });
  }catch(e){
   stats.errors++;
   if(real&&row)await at.patch(row.id,{[F.sync]:'Error: '+safeError(e)}).catch(()=>{});
   // Only fixed error codes, never response bodies, IDs, names or notes.
   if(ml.reportError)ml.reportError(safeError(e));
  }
 }
 return stats;
}
