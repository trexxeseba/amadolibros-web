// D1 de producción por la API de Cloudflare (la misma base que usan el sitio y el Worker).
// Lo usa el publicador de la nube para guardar el estado de pausas entre corridas.
export const D1_DATABASE_ID='6dc8dc3a-2d4f-4045-b428-14323c7b0bcd';
const problem=code=>Object.assign(new Error(code),{code});
export function d1Client({accountId=process.env.CLOUDFLARE_ACCOUNT_ID,apiTokens=[process.env.CLOUDFLARE_ADMIN_API_TOKEN,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean),fetcher=fetch}={}){
 if(!accountId||!apiTokens.length)throw problem('faltan_secretos_cloudflare');
 return async function query(sql,params=[]){
  let last='cloudflare_sin_respuesta';
  for(const token of apiTokens){
   for(let attempt=0;attempt<3;attempt++){
    const res=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(30000)}).catch(()=>null);
    if(!res){last='cloudflare_transporte';await new Promise(r=>setTimeout(r,2000*(attempt+1)));continue;}
    const body=await res.json().catch(()=>null);
    if(res.ok&&body?.success!==false)return body?.result?.[0]?.results??[];
    last=`cloudflare_http_${res.status}`;
    if(res.status<500&&res.status!==429)break;
    await new Promise(r=>setTimeout(r,2000*(attempt+1)));
   }
  }
  throw problem(last);
 };
}
// Estado de la sincronización de stock (qué pausamos nosotros y desde cuándo falta cada libro).
// Misma forma que la tabla vintage_stock_sync del SQLite de la PC.
export const CLOUD_STOCK_TABLE='ml_vintage_cloud_stock_sync';
export const STOCK_COLUMNS=['isbn','item_id','desired_status','applied_status','missing_since','feed_id','attempts','next_at','last_error','updated_at','applied_price','competitor_json','competitor_at'];
export const CLOUD_STOCK_SCHEMA=`CREATE TABLE IF NOT EXISTS ${CLOUD_STOCK_TABLE} (isbn TEXT PRIMARY KEY,item_id TEXT NOT NULL,desired_status TEXT,applied_status TEXT,missing_since INTEGER NOT NULL DEFAULT 0,feed_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL DEFAULT 0,applied_price INTEGER,competitor_json TEXT,competitor_at INTEGER)`;
const ROWS_PER_INSERT=7; // 7 filas x 13 columnas = 91 parámetros (D1 admite 100 por consulta)
export async function loadStockState(query){
 await query(CLOUD_STOCK_SCHEMA);
 return query(`SELECT ${STOCK_COLUMNS.join(',')} FROM ${CLOUD_STOCK_TABLE}`);
}
export async function saveStockState(query,rows){
 let saved=0;
 for(let i=0;i<rows.length;i+=ROWS_PER_INSERT){
  const group=rows.slice(i,i+ROWS_PER_INSERT);
  const values=group.map(()=>`(${STOCK_COLUMNS.map(()=>'?').join(',')})`).join(',');
  await query(`INSERT INTO ${CLOUD_STOCK_TABLE}(${STOCK_COLUMNS.join(',')}) VALUES ${values} ON CONFLICT(isbn) DO UPDATE SET ${STOCK_COLUMNS.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`,group.flatMap(r=>STOCK_COLUMNS.map(c=>r[c]??null)));
  saved+=group.length;
 }
 return saved;
}
