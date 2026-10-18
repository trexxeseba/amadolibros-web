export async function localExecutorState(env,now=Date.now()){
 const exists=await env.ORDERS_DB.prepare("SELECT name FROM sqlite_master WHERE name='ml_vintage_local_access'").first();
 if(!exists)return {active:false};
 const row=await env.ORDERS_DB.prepare('SELECT enabled,expires_at,last_at FROM ml_vintage_local_access WHERE id=1').first();
 return {active:Boolean(row?.enabled&&row.expires_at>now),expires_at:row?.expires_at??null,last_at:row?.last_at??null};
}
export async function stopLocalExecutor(env){
 const exists=await env.ORDERS_DB.prepare("SELECT name FROM sqlite_master WHERE name='ml_vintage_local_access'").first();
 if(exists)await env.ORDERS_DB.prepare('UPDATE ml_vintage_local_access SET enabled=0 WHERE id=1').run();
}
