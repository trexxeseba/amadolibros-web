import {readSelectedStock,readFullStock} from './meli-vintage-xlsx.mjs';
self.onmessage=async({data})=>{
 try{
  const result=data.full===true?readFullStock(data.buffer):readSelectedStock(data.buffer,data.isbns);
  const digest=await crypto.subtle.digest('SHA-256',data.buffer);
  result.source_sha256=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  self.postMessage({ok:true,result});
 }catch(error){self.postMessage({ok:false,error:/^[a-z_]+$/.test(error.message)?error.message:'invalid_workbook'});}
};
