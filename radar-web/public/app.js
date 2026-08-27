const $ = s => document.querySelector(s);
const money = (n, currency='UYU') => Number.isFinite(Number(n)) ? new Intl.NumberFormat('es-UY',{style:'currency',currency,maximumFractionDigits:0}).format(Number(n)) : '—';
const pct = n => Number.isFinite(Number(n)) ? `${Number(n).toFixed(1)}%` : '—';
const date = value => value ? new Date(value).toLocaleString('es-UY',{dateStyle:'short',timeStyle:'short'}) : '—';

async function getJson(url){
  const r=await fetch(url,{cache:'no-store'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}

async function loadSales(){
  $('#statusPill').textContent='Actualizando ventas…';
  $('#salesBody').innerHTML='<tr><td colspan="5" class="loading">Cargando datos reales…</td></tr>';
  try{
    const data=await getJson('/api/sales?days=7&pages=2');
    $('#ordersCount').textContent=data.orders_observed ?? '—';
    $('#itemsCount').textContent=data.sample?.length ?? 0;
    $('#daysCount').textContent=`${data.days} días`;
    $('#coverageText').textContent=data.partial?'Parcial':'Completa';
    $('#statusPill').textContent=`Actualizado ${date(data.checked_at)}`;
    const rows=(data.sample||[]).map(row=>`<tr><td><strong>${row.item_id}</strong></td><td>${row.units}</td><td>${money(row.revenue)}</td><td>${date(row.last_sale_at)}</td><td><button data-mlu="${row.item_id}">Ver competencia</button></td></tr>`).join('');
    $('#salesBody').innerHTML=rows||'<tr><td colspan="5" class="loading">Sin ventas observadas.</td></tr>';
    $('#salesFoot').textContent=data.partial?'Lectura parcial: sirve como panorama inmediato, no como cierre contable del período.':'Cobertura completa de la consulta.';
    document.querySelectorAll('[data-mlu]').forEach(btn=>btn.addEventListener('click',()=>{ $('#mluInput').value=btn.dataset.mlu; analyzeCompetition(btn.dataset.mlu); window.scrollTo({top:180,behavior:'smooth'}); }));
  }catch(e){
    $('#statusPill').textContent='Error de actualización';
    $('#salesBody').innerHTML=`<tr><td colspan="5" class="loading">${e.message}</td></tr>`;
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
    result.className='competition-result';
    result.innerHTML=`
      <div><strong>${d.title||d.item_id}</strong><div class="hint">${d.item_id}${d.isbn?` · ISBN ${d.isbn}`:''}${d.catalog_product_id?` · catálogo ${d.catalog_product_id}`:''}</div></div>
      <div class="result-grid" style="margin-top:14px">
        <div class="result-card"><span>Nuestro precio</span><strong>${money(d.own_price,d.currency_id)}</strong></div>
        <div class="result-card"><span>${exact?'Ganador catálogo':'Benchmark ML'}</span><strong>${money(d.benchmark_price,d.currency_id)}</strong></div>
        <div class="result-card"><span>Diferencia</span><strong>${money(d.gap_amount,d.currency_id)}</strong></div>
        <div class="result-card"><span>Gap</span><strong>${pct(d.gap_percent)}</strong></div>
      </div>
      <div class="result-grid" style="margin-top:10px">
        <div class="result-card"><span>Estado catálogo</span><strong>${exact?.status||'—'}</strong></div>
        <div class="result-card"><span>Precio para ganar</span><strong>${money(exact?.price_to_win,d.currency_id)}</strong></div>
        <div class="result-card"><span>Referencia sugerida ML</span><strong>${money(ref?.suggested_price,d.currency_id)}</strong></div>
        <div class="result-card"><span>Valores comparados</span><strong>${ref?.compared_values ?? '—'}</strong></div>
      </div>
      <div class="action ${actionClass(d.recommendation)}">${actionLabel(d.recommendation)}${exact?.confidence?` · confianza ${exact.confidence}`:ref?.confidence?` · confianza ${ref.confidence}`:''}</div>
      <p class="hint">Fuente: ${d.benchmark_source||'sin benchmark'}. No se muestran condiciones de envío ni stock de terceros.</p>`;
  }catch(e){ result.className='competition-result empty'; result.textContent=`No pude obtener la comparación: ${e.message}`; }
}

$('#competitionForm').addEventListener('submit',e=>{e.preventDefault();const v=$('#mluInput').value.trim().toUpperCase();if(v) analyzeCompetition(v)});
$('#refreshSales').addEventListener('click',loadSales);
loadSales();
