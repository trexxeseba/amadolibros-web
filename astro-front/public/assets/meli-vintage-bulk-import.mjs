// Supplier ingestion only: no Mercado Libre or publication request belongs here.
export async function importBulkRows({rows,feed_id,send,onProgress=()=>{},concurrency=4}){
 if(!Array.isArray(rows)||!rows.length||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('invalid_import');
 let offset=0,completed=0,stopped=false;
 const worker=async()=>{
  while(!stopped&&offset<rows.length){
   const start=offset;offset+=200;
   try{const chunk=rows.slice(start,start+200);await send('import',{feed_id,rows:chunk});completed+=chunk.length;onProgress(completed,rows.length);}
   catch(error){stopped=true;throw error;}
  }
 };
 const results=await Promise.allSettled(Array.from({length:concurrency},worker));
 const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
 return completed;
}
