const samples=['9791387869380','9798181647725','9789878629933','9798627076188','9788410301245'];
const mlu=['MLU1416777650','MLU1472001988','MLU692066314','MLU738675068','MLU653980087'];
async function probe(url){
  try{const r=await fetch(url,{headers:{'user-agent':'AmadoLibrosBibliographyProbe/1.0','accept':'application/json'},signal:AbortSignal.timeout(20000)});const text=await r.text();return{status:r.status,ok:r.ok,bytes:text.length,head:text.slice(0,300)};}catch(e){return{ok:false,error:String(e?.message||e)}}
}
for(let i=0;i<samples.length;i++){
 const isbn=samples[i];
 const q=encodeURIComponent(`isbn:${isbn}`);
 const row={isbn,mlu:mlu[i]};
 row.googleWww=await probe(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5`);
 row.googleBooks=await probe(`https://books.googleapis.com/books/v1/volumes?q=${q}&maxResults=5`);
 row.loc=await probe(`https://www.loc.gov/books/?fo=json&c=5&q=${encodeURIComponent(isbn)}`);
 row.ml=await probe(`https://api.mercadolibre.com/items/${mlu[i]}`);
 console.log(JSON.stringify(row));
}
