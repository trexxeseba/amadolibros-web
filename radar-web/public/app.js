const $ = s => document.querySelector(s);
const money = (n, currency='UYU') => Number.isFinite(Number(n)) ? new Intl.NumberFormat('es-UY',{style:'currency',currency,maximumFractionDigits:0}).format(Number(n)) : '—';
const pct = n => Number.isFinite(Number(n)) ? `${Number(n).toFixed(1)}%` : '—';
const date = value => value ? new Date(value).toLocaleString('es-UY',{dateStyle:'short',timeStyle:'short'}) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"})[ch]);

let salesRows=[];
let activeFilter='all';

async function getJson(url){
  const r=await fetch(url,{cache:'no-store'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}

function isLowStockSold(row){
  return row.stock!=null && Number(row.stock)<=2 && Number(row.units)>0;
}

function stockBadge(stock,status){
  if(stock==null) return '<span class="stock-badge unknown">—</span>';
  const n=Number(stock);
  const cls=n<=0?'zero':n<=2?'low':'ok';
  const label=status==='paused'&&n<=0?'0 · pausada':String(n);
  return `<span class="stock-badge ${cls}">${esc(label)}</span>`;
}

function productCell(row){
  const title=esc(row.title||'Título no disponible');
  const author=row.author?`<div class="subline">${esc(row.author)}</div>`:'';
  const link=row.permalink?`<a class="external-link" href="${esc(row.permalink)}" target="_blank" rel="noreferrer">Abrir en ML</a>`:'';
  return `<div class="product-title">${title}</div>${author}${link}`;
}

function idCell(row){
  return `<strong>${esc(row.item_id)}</strong>${row.isbn?`<div class="subline">ISBN ${esc(row.isbn)}</div>`:''}`;
}

function sortRows(rows,sort){
  const copy=[...rows];
  if(sort==='revenue') return copy.sort((a,b)=>(Number(b.revenue)||0)-(Number(a.revenue)||0));
  if(sort==='recent') return copy.sort((a,b)=>Date.parse(b.last_sale_at||0)-Date.parse(a.last_sale_at||0));
  if(sort==='stock') return copy.sort((a,b)=>(a.stock==null?Number.POSITIVE_INFINITY:Number(a.stock))-(b.stock==null?Number.POSITIVE_INFINITY:Number(b.stock)) || (Number(b.units)||0)-(Number(a.units)||0));
  return copy.sort((a,b)=>(Number(b.units)||0)-(Number(a.units)||0));
}

function renderSales(){
  const q=($('#salesSearch')?.value||'').trim().toLowerCase();
  const sort=$('#salesSort')?.value||'units';
  const filtered=salesRows.filter(row=>{
    if(activeFilter==='low-stock' && !isLowStockSold(row)) return false;
    if(!q) return true;
    return [row.item_id,row.title,row.author,row.isbn].some(v=>String(v||'').toLowerCase().includes(q));
  });
  const rows=sortRows(filtered,sort).map(row=>`<tr>
    <td class="product-cell">${productCell(row)}</td>
    <td>${idCell(row)}</td>
    <td>${stockBadge(row.stock,row.status)}</td>
    <td>${money(row.price,row.currency)}</td>
    <td><strong>${esc(row.units)}</strong></td>
    <td>${money(row.revenue,row.currency||'UYU')}</td>
    <td>${date(row.last_sale_at)}</td>
    <td><button class="table-action" data-mlu="${esc(row.item_id)}">Analizar precio</button></td>
  </tr>`).join('');
  $('#salesBody').innerHTML=rows||'<tr><td colspan="8" class="loading">No hay resultados para ese filtro.</td></tr>';
  document.querySelectorAll('[data-mlu]').forEach(btn=>btn.addEventListener('click',()=>{
    const mlu=btn.dataset.mlu;
    $('#mluInput').value=mlu;
    analyzeCompetition(mlu);
    $('#competitionPanel').scrollIntoView({behavior:'smooth',block:'start'});
  }));
}

async function loadSales(){
  $('#statusPill').textContent='Actualizando ventas…';
  $('#salesBody').innerHTML='<tr><td colspan="8" class="loading">Cargando datos reales…</td></tr>';
  try{
    const data=await getJson('/api/sales?days=7&pages=2');
    salesRows=data.sample||[];
    const units=salesRows.reduce((sum,row)=>sum+(Number(row.units)||0),0);
    const revenue=salesRows.reduce((sum,row)=>sum+(Number(row.revenue)||0),0);
    const lowStock=salesRows.filter(isLowStockSold).length;
    $('#ordersCount').textContent=data.orders_observed ?? '—';
    $('#itemsCount').textContent=salesRows.length;
    $('#unitsCount').textContent=units;
    $('#revenueCount').textContent=money(revenue,'UYU');
    $('#lowStockCount').textContent=lowStock;
    $('#coverageText').textContent=data.partial?'Parcial':'Completa';
    $('#statusPill').textContent=`Actualizado ${date(data.checked_at)}`;
    $('#salesFoot').textContent=data.partial
      ? 'Lectura parcial del período: los importes corresponden a las filas mostradas, no a un cierre contable.'
      : 'Cobertura completa de la consulta observada de Mercado Libre.';
    $('#catalogFoot').textContent=data.catalog_enriched
      ? `Catálogo enriquecido${data.catalog_updated_at?` · stock/precios del ${date(data.catalog_updated_at)}`:''}.`
      : `No se pudo enriquecer con catálogo${data.catalog_error?`: ${data.catalog_error}`:''}.`;
    renderSales();
  }catch(e){
    $('#statusPill').textContent='Error de actualización';
    $('#salesBody').innerHTML=`<tr><td colspan="8" class="loading">${esc(e.message)}</td></tr>`;
    $('#salesFoot').textContent='';
  }
}

function actionClass(value){return value==='REVISAR_PRECIO'?'review':value==='SIN_REFERENCIA'?'none':'good'}
function actionLabel(value){return ({REVISAR_PRECIO:'REVISAR PRECIO',OPORTUNIDAD_COMPETENCIA:'OPORTUNIDAD COMPETITIVA',PRECIO_COMPETITIVO:'PRECIO COMPETITIVO',SIN_REFERENCIA:'SIN REFERENCIA COMPARABLE'})[value]||value}

async function analyzeCompetition(itemId){
  const result=$('#competitionResult');
  result.className='competition-result empty'; result.textContent='Consultando Mercado Libre…';
  try{
    const d=await getJson(`/api/competition?item_id=${encodeURIComponent(itemId)}`);
    const exact=d.exact_catalog_competition;
    const ref=d.ml_reference;
    const benchmarkLabel=exact?'Ganador catálogo':'Benchmark ML';
    result.className='competition-result';
    result.innerHTML=`
      <div class="competition-title-row">
        <div>
          <strong class="competition-title">${esc(d.title||d.item_id)}</strong>
          <div class="hint">${esc(d.item_id)}${d.isbn?` · ISBN ${esc(d.isbn)}`:''}${d.catalog_product_id?` · catálogo ${esc(d.catalog_product_id)}`:''}</div>
        </div>
        ${d.permalink?`<a class="external-link button-link" href="${esc(d.permalink)}" target="_blank" rel="noreferrer">Abrir publicación</a>`:''}
      </div>
      <div class="result-grid result-grid-primary">
        <div class="result-card"><span>Nuestro precio</span><strong>${money(d.own_price,d.currency_id)}</strong></div>
        <div class="result-card"><span>${benchmarkLabel}</span><strong>${money(d.benchmark_price,d.currency_id)}</strong></div>
        <div class="result-card"><span>Diferencia</span><strong>${money(d.gap_amount,d.currency_id)}</strong></div>
        <div class="result-card"><span>Gap</span><strong>${pct(d.gap_percent)}</strong></div>
      </div>
      <div class="result-grid">
        <div class="result-card"><span>Estado catálogo</span><strong>${esc(exact?.status||'—')}</strong></div>
        <div class="result-card"><span>Precio para ganar</span><strong>${money(exact?.price_to_win,d.currency_id)}</strong></div>
        <div class="result-card"><span>Referencia sugerida ML</span><strong>${money(ref?.suggested_price,d.currency_id)}</strong></div>
        <div class="result-card"><span>Valores comparados</span><strong>${esc(ref?.compared_values ?? '—')}</strong></div>
      </div>
      <div class="action ${actionClass(d.recommendation)}">${esc(actionLabel(d.recommendation))}${exact?.confidence?` · confianza ${esc(exact.confidence)}`:ref?.confidence?` · confianza ${esc(ref.confidence)}`:''}</div>
      <p class="hint">Fuente: ${esc(d.benchmark_source||'sin benchmark')}. Si no existe una referencia inequívoca, Radar no inventa un competidor.</p>`;
  }catch(e){ result.className='competition-result empty'; result.textContent=`No pude obtener la comparación: ${e.message}`; }
}

$('#competitionForm').addEventListener('submit',e=>{e.preventDefault();const v=$('#mluInput').value.trim().toUpperCase();if(v) analyzeCompetition(v)});
$('#refreshSales').addEventListener('click',loadSales);
$('#salesSearch').addEventListener('input',renderSales);
$('#salesSort').addEventListener('change',renderSales);
document.querySelectorAll('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{
  activeFilter=btn.dataset.filter||'all';
  document.querySelectorAll('[data-filter]').forEach(other=>other.classList.toggle('active',other===btn));
  renderSales();
}));
loadSales();
