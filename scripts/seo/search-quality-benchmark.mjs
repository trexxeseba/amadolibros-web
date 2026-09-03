#!/usr/bin/env node
import process from 'node:process';

const ORIGIN = String(process.env.SEARCH_BENCHMARK_ORIGIN || 'https://www.amadolibros.com').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;
const CASES = [
  { q: 'tarot', intent: 'category' }, { q: 'tarot rider', intent: 'product_family' },
  { q: 'rider waite', intent: 'product_family' }, { q: 'rider wait', intent: 'typo' },
  { q: 'oraculo', intent: 'accent' }, { q: 'oráculo', intent: 'category' },
  { q: 'lenormand', intent: 'product_family' }, { q: 'marsella tarot', intent: 'word_order' },
  { q: 'thoth tarot', intent: 'product_family' }, { q: 'tarot principiantes', intent: 'intent_synonym' },
  { q: 'reina valera', intent: 'product_family' }, { q: 'reina valera 1960', intent: 'product_family' },
  { q: 'rvr 1960', intent: 'abbreviation' }, { q: 'biblia catolica', intent: 'accent' },
  { q: 'biblia católica', intent: 'category' }, { q: 'biblia letra grande', intent: 'attribute' },
  { q: 'biblia estudio', intent: 'attribute' }, { q: '9781602552951', intent: 'isbn' },
  { q: 'macarthur reina valera', intent: 'title_author' }, { q: 'despertando gigante interior', intent: 'title' },
];

function stripHtml(value='') {
  return String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
}
function decodeEntities(value='') { return String(value).replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
function extractResults(html) {
  const cards=[];
  const re=/<article\b[^>]*class="[^"]*rc-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match=re.exec(html))) {
    const block=match[1];
    const href=block.match(/href="([^"]*\/libro\/[^"]+)"/i)?.[1]||null;
    const title=decodeEntities(stripHtml(block.match(/class="rc-title"[^>]*>([\s\S]*?)<\/p>/i)?.[1]||''));
    const author=decodeEntities(stripHtml(block.match(/class="rc-author"[^>]*>([\s\S]*?)<\/p>/i)?.[1]||''));
    if(title||href) cards.push({title,author,href});
  }
  return cards;
}
async function fetchCase(testCase) {
  const url=`${ORIGIN}/catalogo?q=${encodeURIComponent(testCase.q)}`;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS); const started=performance.now(); let response;
  try { response=await fetch(url,{headers:{Accept:'text/html'},signal:controller.signal,redirect:'follow'}); } finally { clearTimeout(timer); }
  const latencyMs=Math.round(performance.now()-started); const html=await response.text(); const results=extractResults(html);
  return {...testCase,url,http:response.status,bytes:Buffer.byteLength(html),latency_ms:latencyMs,result_count_page:results.length,no_results:results.length===0,top5:results.slice(0,5)};
}

const rows=[];
for (const c of CASES) {
  try { rows.push(await fetchCase(c)); }
  catch(error) { rows.push({...c,error:error?.name||'error',message:String(error?.message||error).slice(0,160),no_results:true,top5:[]}); }
}
const byIntent={};
for (const row of rows) { const b=byIntent[row.intent]||=( {total:0,no_results:0} ); b.total++; if(row.no_results)b.no_results++; }
const noResults=rows.filter(r=>r.no_results).length; const errors=rows.filter(r=>r.error).length;
console.log(JSON.stringify({schema_version:1,run:'SEARCH-QUALITY-1/baseline',generated_at:new Date().toISOString(),origin:ORIGIN,summary:{cases:rows.length,no_results:noResults,no_result_rate:Number((noResults/rows.length).toFixed(4)),errors},by_intent:byIntent,cases:rows},null,2));
if(errors) process.exitCode=2;
