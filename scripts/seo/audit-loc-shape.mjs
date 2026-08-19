const isbn='9791387869380';
const r=await fetch(`https://www.loc.gov/books/?fo=json&c=10&q=${isbn}`,{headers:{'user-agent':'AmadoLibrosBibliographyAudit/1.0'},signal:AbortSignal.timeout(20000)});
const x=await r.json();
console.log(JSON.stringify({pagination:x.pagination,results:(x.results||[]).map(v=>({keys:Object.keys(v),title:v.title,date:v.date,publisher:v.publisher,description:v.description,format:v.format,original_format:v.original_format,number:v.number,item:v.item})).slice(0,5)},null,2));
