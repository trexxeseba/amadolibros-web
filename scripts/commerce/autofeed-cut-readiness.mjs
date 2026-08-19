import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API='https://merchantapi.googleapis.com';
const ACCOUNT=process.env.MERCHANT_ACCOUNT_ID || '5330457716';
const TOKEN=process.env.MERCHANT_ACCESS_TOKEN || '';
const TARGET=(process.env.TARGET_OFFER_ID || 'MLU1183067570').toUpperCase();
const OUT=process.env.OUT_DIR || 'artifacts/autofeed-cut';
if (!TOKEN) throw new Error('Falta MERCHANT_ACCESS_TOKEN');

async function request(url){
  const r=await fetch(url,{headers:{Authorization:`Bearer ${TOKEN}`,Accept:'application/json'},signal:AbortSignal.timeout(60000)});
  const text=await r.text();
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,500)}`);
  return text?JSON.parse(text):{};
}
async function list(endpoint,field,size=1000){
  const out=[]; let token='';
  for(let page=0;page<30;page++){
    const u=new URL(endpoint);u.searchParams.set('pageSize',String(size));if(token)u.searchParams.set('pageToken',token);
    const x=await request(u); if(Array.isArray(x[field]))out.push(...x[field]); token=String(x.nextPageToken||''); if(!token)return out;
  }
  throw new Error(`Paginación excedida ${field}`);
}
const parent=`accounts/${ACCOUNT}`;
const [sources,products,feedXml]=await Promise.all([
  list(`${API}/datasources/v1/${parent}/dataSources`,'dataSources',1000),
  list(`${API}/products/v1/${parent}/products`,'products',1000),
  fetch('https://www.amadolibros.com/feed.xml',{signal:AbortSignal.timeout(60000)}).then(async r=>{if(!r.ok)throw new Error(`feed HTTP ${r.status}`);return r.text();}),
]);

function txt(v){return String(v??'').trim();}
function sourceName(s){return txt(s.name)||`accounts/${ACCOUNT}/dataSources/${txt(s.dataSourceId)}`;}
function safeUri(s){return txt(s?.fileInput?.fetchSettings?.fetchUri || s?.fetchSettings?.fetchUri || s?.fileInput?.fetchUri);}
function sourceKind(s){
  const input=txt(s.input).toUpperCase(); const display=txt(s.displayName).toUpperCase(); const uri=safeUri(s).toLowerCase();
  if(input.includes('AUTOFEED') || display==='AMADOLIBROS.COM') return 'AUTOFEED';
  if(input.includes('FILE') || uri.includes('/feed.xml') || display.includes('PRODUCTS SOURCE 3')) return 'FILE';
  if(display.includes('CONTENT API')) return 'CONTENT_API';
  return input || 'OTHER';
}
const sourceMap=new Map(sources.map(s=>[sourceName(s),{id:txt(s.dataSourceId),name:sourceName(s),displayName:txt(s.displayName),input:txt(s.input),kind:sourceKind(s),fetchUri:safeUri(s)}]));
const fileSource=[...sourceMap.values()].find(s=>s.kind==='FILE')||null;
let latestFileUpload=null;
let latestFileUploadError='';
if(fileSource?.id){
  try{
    latestFileUpload=await request(`${API}/datasources/v1/accounts/${ACCOUNT}/dataSources/${fileSource.id}/fileUploads/latest`);
  }catch(e){latestFileUploadError=String(e?.message||e);}
}
function productMlu(p){
  const blob=[p.offerId,p.name,p.legacyLocalId,p.product?.offerId,p.product?.title].map(txt).join(' ');
  return blob.match(/MLU\d+/i)?.[0]?.toUpperCase()||'';
}
function productSource(p){return txt(p.dataSource)||'(sin fuente)';}
function productState(p){
  const rows=p?.productStatus?.destinationStatuses||[];
  const approved=rows.some(r=>(r.approvedCountries||[]).includes('UY'));
  const pending=rows.some(r=>(r.pendingCountries||[]).includes('UY'));
  const disapproved=rows.some(r=>(r.disapprovedCountries||[]).includes('UY'));
  return approved?'active':pending?'pending':disapproved?'disapproved':'other';
}
const byKind={}; const offersByKind={};
for(const p of products){
  const src=sourceMap.get(productSource(p)); const kind=src?.kind||'UNKNOWN';
  byKind[kind]=(byKind[kind]||0)+1;
  const id=productMlu(p); if(!id)continue; if(!offersByKind[kind])offersByKind[kind]=new Set(); offersByKind[kind].add(id);
}
const auto=offersByKind.AUTOFEED||new Set(); const file=offersByKind.FILE||new Set();
const overlap=[...auto].filter(x=>file.has(x)); const autoOnly=[...auto].filter(x=>!file.has(x)); const fileOnly=[...file].filter(x=>!auto.has(x));
const targetProducts=products.filter(p=>productMlu(p)===TARGET).map(p=>({
  offerId:txt(p.offerId), dataSource:productSource(p), source:sourceMap.get(productSource(p))||null,
  stateUY:productState(p), archived:p.archived===true,
  lastUpdateDate:txt(p?.productStatus?.lastUpdateDate), googleExpirationDate:txt(p?.productStatus?.googleExpirationDate),
  issueCodes:(p?.productStatus?.itemLevelIssues||[]).map(i=>txt(i.code)).filter(Boolean),
}));
const feedHasTarget=new RegExp(`<g:id>\\s*${TARGET}\\s*</g:id>`,'i').test(feedXml) || feedXml.toUpperCase().includes(TARGET);
const targetFile=targetProducts.filter(p=>p.source?.kind==='FILE');
const targetAuto=targetProducts.filter(p=>p.source?.kind==='AUTOFEED');
const ready=feedHasTarget && targetFile.length>0 && targetFile.some(p=>p.stateUY==='active' || p.stateUY==='pending');
const fileUpload={
  processingState:txt(latestFileUpload?.processingState),
  uploadTime:txt(latestFileUpload?.uploadTime),
  itemsTotal:txt(latestFileUpload?.itemsTotal),
  itemsCreated:txt(latestFileUpload?.itemsCreated),
  itemsUpdated:txt(latestFileUpload?.itemsUpdated),
  issues:(latestFileUpload?.issues||[]).map(i=>({title:txt(i.title),code:txt(i.code),severity:txt(i.severity),count:txt(i.count)})),
  error:latestFileUploadError,
};

const summary={generatedAt:new Date().toISOString(),accountId:ACCOUNT,target:TARGET,feedHasTarget,ready,targetFileCount:targetFile.length,targetAutoCount:targetAuto.length,totalProcessed:products.length,byKind,unique:{auto:auto.size,file:file.size,overlap:overlap.length,autoOnly:autoOnly.length,fileOnly:fileOnly.length},sources:[...sourceMap.values()],fileUpload,targetProducts};
await mkdir(OUT,{recursive:true});
await writeFile(path.join(OUT,'report.json'),JSON.stringify(summary,null,2));
const md=[
 '# MERCHANT AUTOFEED — cut readiness','',
 `- Target: **${TARGET}**`,
 `- Target presente en /feed.xml: **${feedHasTarget?'sí':'no'}**`,
 `- Target procesado por FILE: **${targetFile.length}**`,
 `- Target procesado por AUTOFEED: **${targetAuto.length}**`,
 `- Readiness técnico del target: **${ready?'PASS':'NO PASS'}**`,
 `- Productos procesados API: **${products.length}**`,'',
 '## Último procesamiento FILE','',
 `- Estado: **${fileUpload.processingState||'—'}**`,
 `- Upload time: **${fileUpload.uploadTime||'—'}**`,
 `- Items total: **${fileUpload.itemsTotal||'—'}**`,
 `- Creados: **${fileUpload.itemsCreated||'—'}**`,
 `- Actualizados: **${fileUpload.itemsUpdated||'—'}**`,
 `- Error de lectura: **${fileUpload.error||'ninguno'}**`,
 `- Issues de archivo: **${fileUpload.issues.length}**`,'',
 '## Cobertura actual por fuente','',
 '| Métrica | Cantidad |','| --- | ---: |',
 `| AUTOFEED IDs únicos | ${auto.size} |`,
 `| FILE IDs únicos | ${file.size} |`,
 `| Solapamiento AUTOFEED ∩ FILE | ${overlap.length} |`,
 `| Sólo AUTOFEED | ${autoOnly.length} |`,
 `| Sólo FILE | ${fileOnly.length} |`,'',
 '## Fuentes','',
 '| Tipo | Display | ID | Entrada |','| --- | --- | --- | --- |',
 ...[...sourceMap.values()].map(s=>`| ${s.kind} | ${s.displayName||'—'} | ${s.id||'—'} | ${s.input||'—'} |`),'',
 '## Target en Merchant','',
 '| Fuente | Tipo | Estado UY | Archivado | Última actualización | Issues |','| --- | --- | --- | --- | --- | --- |',
 ...(targetProducts.length?targetProducts.map(p=>`| ${p.source?.displayName||p.dataSource} | ${p.source?.kind||'UNKNOWN'} | ${p.stateUY} | ${p.archived?'sí':'no'} | ${p.lastUpdateDate||'—'} | ${p.issueCodes.join(', ')||'—'} |`):['| — | — | — | — | — | No encontrado |']),
];
await writeFile(path.join(OUT,'summary.md'),md.join('\n'));
console.log(md.join('\n'));
