// Evidence only. No MLU writes, OAuth refresh, D1 mutation or deployments.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const SELLER='440298103',DB='6dc8dc3a-2d4f-4045-b428-14323c7b0bcd',APP='4741021817925208';
export function parseIds(value){const ids=(value??'').split(',');if(ids.length<1||ids.length>100||new Set(ids).size!==ids.length||ids.some(i=>!/^MLU\d{6,15}$/.test(i)))throw Error('invalid_selection');return ids;}
export function checkPage(body,offset){
 if(!Number.isInteger(body?.paging?.total)||body.paging.total<0||body.paging.total>1000||!Array.isArray(body.results)||body.results.some(i=>!/^MLU\d{6,15}$/.test(i))||new Set(body.results).size!==body.results.length||body.results.length!==Math.min(100,Math.max(0,body.paging.total-offset)))throw Error('invalid_or_incomplete_page');
 return body.paging.total;
}
export function checkItem(i){if(!i||String(i.seller_id)!==SELLER||!/^MLU\d{6,15}$/.test(i.id)||!Array.isArray(i.attributes)||typeof i.catalog_listing!=='boolean'||!Array.isArray(i.variations))throw Error('invalid_or_foreign_item');return i;}
export function makeReader(token,fetcher=fetch){return async path=>{
 if(!/^\/(?:users\/440298103\/items\/search\?|items\/MLU\d+\?|categories\/MLU1196\/attributes$|users\/me$)/.test(path))throw Error('path_not_allowed');
 for(let attempt=0;attempt<4;attempt++){
  const r=await fetcher('https://api.mercadolibre.com'+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
  if([429,500,502,503,504].includes(r.status)&&attempt<3){await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));continue;}
  if(!r.ok)throw Error('ml_read_http_'+r.status);return r.json();
 }
};}
const project=i=>Object.fromEntries(['id','seller_id','title','status','category_id','catalog_listing','catalog_product_id','user_product_id','variations','attributes','last_updated','available_quantity','sold_quantity','price','sale_terms'].filter(k=>Object.hasOwn(i,k)).map(k=>[k,i[k]]));
async function main(){
 const out=process.argv[2];if(!out)throw Error('output_required');const ids=parseIds(process.env.REVIEW_IDS),account=process.env.CLOUDFLARE_ACCOUNT_ID;
 if(!/^[a-f0-9]{32}$/.test(account??'')||!process.env.CLOUDFLARE_API_TOKEN)throw Error('cloudflare_auth_missing');
 // Literal SELECT only; never retrieve the refresh token or log the response.
 const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DB}/query`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({sql:'SELECT access_token,access_expires_at FROM ml_oauth WHERE app_id=?',params:[APP]})});
 if(!res.ok)throw Error('d1_read_http_'+res.status);const data=await res.json(),row=data.success&&data.result?.[0]?.results?.[0];
 if(!row||typeof row.access_token!=='string'||Number(row.access_expires_at)-Date.now()<600000)throw Error('existing_token_unavailable_or_expiring');
 const ml=makeReader(row.access_token);delete row.access_token;
 if(String((await ml('/users/me')).id)!==SELLER)throw Error('wrong_seller');
 const schema=await ml('/categories/MLU1196/attributes');if(!Array.isArray(schema)||!schema.length)throw Error('empty_schema');
 const report={seller_id:SELLER,read_only:true,authorized_to_apply:false,started_at:new Date().toISOString(),selected_ids:ids,groups:[],items:[],schema,complete:false},all=new Map();
 async function item(id){if(!all.has(id)){const i=checkItem(await ml(`/items/${id}?include_internal_attributes=true`));if(i.id!==id)throw Error('unexpected_item');all.set(id,project(i));}return all.get(id);}
 try{
  for(const id of ids){
   const up=(await item(id)).user_product_id;if(typeof up!=='string'||!/^MLUU\d+$/.test(up))throw Error('missing_user_product');
   if(report.groups.some(g=>g.user_product_id===up))throw Error('duplicate_selected_group');
   const g={selected_id:id,user_product_id:up,queries:[],item_ids:[],complete:false},union=new Set();report.groups.push(g);
   for(const status of ['', 'active','paused','closed','under_review']){
    const found=new Set();let total=null;
    for(let offset=0;;offset+=100){
     const q=new URLSearchParams({user_product_id:up,limit:'100',offset:String(offset)});if(status)q.set('status',status);
     const body=await ml(`/users/${SELLER}/items/search?${q}`),t=checkPage(body,offset);if(total!==null&&t!==total)throw Error('group_total_changed');total=t;
     for(const iid of body.results){if(found.has(iid))throw Error('duplicate_group_id');found.add(iid);union.add(iid);}if(found.size===total)break;
    }
    g.queries.push({status:status||'all',total,ids:[...found],complete:found.size===total,queried_at:new Date().toISOString()});
   }
   if(!union.has(id))throw Error('target_absent_from_group');
   for(const iid of union)if((await item(iid)).user_product_id!==up)throw Error('group_member_changed');
   if([...union].some(iid=>!g.queries[0].ids.includes(iid)))throw Error('all_status_query_incomplete');
   g.item_ids=[...union];g.complete=true;if(report.groups.length%10===0)console.log('Grupos completos leídos:',report.groups.length);
  }
  report.complete=report.groups.length===ids.length;
 }finally{report.items=[...all.values()];report.completed_at=new Date().toISOString();await fs.mkdir(out,{recursive:true});await fs.writeFile(out+'/lectura-grupos.json',JSON.stringify(report,null,2));}
 console.log(JSON.stringify({read_only:true,complete:report.complete,groups:report.groups.length,items:all.size}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'read_failed_without_credentials_logged');process.exitCode=1;});
