import {readFullStock} from './meli-vintage-xlsx.mjs?bulk=2';
self.onmessage=async({data})=>{
 try{
  const result=readFullStock(data.buffer),digest=await crypto.subtle.digest('SHA-256',data.buffer);
  result.source_sha256=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  self.postMessage({ok:true,result});
 }catch(error){self.postMessage({ok:false,error:/^[a-z_]+$/.test(error.message)?error.message:'invalid_workbook'});}
};
