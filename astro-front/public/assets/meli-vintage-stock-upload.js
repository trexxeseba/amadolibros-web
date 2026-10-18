const messages={supplier_stock_stale_or_future:'El Excel está vencido o tiene una fecha futura. Descargá un informe de stock vigente de SBS.',stock_columns_or_date_missing:'Este archivo no es el informe de stock: debe incluir disponibilidad, peso y fecha del proveedor.',selected_isbn_missing:'Falta alguno de los cinco ISBN elegidos en este archivo.',selected_book_without_stock:'Uno de los cinco libros figura sin disponibilidad. No se reemplazó por otro título.',duplicate_selected_isbn:'El archivo repite uno de los cinco ISBN. Revisá el informe antes de continuar.',sample_changed_or_not_ready:'La muestra cambió o hay un proceso en curso. Actualizá la página.',run_busy:'Hay otra comprobación en curso. Esperá y actualizá el estado.',panel_session_required:'Tu sesión venció. Ingresá al panel y volvé a intentar.'};
export const uploadError=code=>messages[code]||'No se pudo cargar el stock ('+(/^[a-z_]+$/.test(code)?code:'error')+'). El stock anterior se conserva.';
export function bindStockUpload(){
 const form=document.querySelector('[data-vintage-stock]');if(!form)return;
 const notice=document.querySelector('[data-stock-notice]'),button=form.querySelector('button'),fileInput=form.querySelector('input[type=file]');let busy=false;
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const file=fileInput.files?.[0];if(!file)return;
  if(!/\.xlsx$/i.test(file.name)||file.size>64*1024*1024){notice.textContent='Elegí un archivo .xlsx de hasta 64 MB.';return;}
  busy=true;button.disabled=true;notice.textContent='Leyendo el Excel y buscando los cinco ISBN elegidos…';let worker;
  try{
   worker=new Worker('/assets/meli-vintage-stock-worker.js',{type:'module'});
   const buffer=await file.arrayBuffer(),isbns=JSON.parse(form.dataset.isbns);
   const parsed=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('workbook_read_timeout')),120000);
    worker.onmessage=({data})=>{clearTimeout(timer);data.ok?resolve(data.result):reject(Error(data.error));};
    worker.onerror=()=>{clearTimeout(timer);reject(Error('workbook_read_failed'));};
    worker.postMessage({buffer,isbns},[buffer]);
   });
   const source=Date.parse(parsed.source_date);
   if(!Number.isFinite(source)||source>Date.now()+300000||Date.now()-source>86400000)throw Error('supplier_stock_stale_or_future');
   notice.textContent='Cinco ISBN encontrados. Actualizando solo el stock de Vintage…';
   const response=await fetch('/panel/meli-vintage-stock',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({run_id:form.elements.run_id.value,feed_id:form.elements.feed_id.value,sample_hash:form.elements.sample_hash.value,source_date:parsed.source_date,source_sha256:parsed.source_sha256,rows:parsed.rows}),signal:AbortSignal.timeout(90000)});
   const result=await response.json();if(!response.ok)throw Error(result.error||'stock_upload_failed');
   window.location.assign('/panel/meli-vintage-piloto?stock=updated');
  }catch(error){notice.textContent=uploadError(error.message);}finally{worker?.terminate();busy=false;button.disabled=false;}
 });
}
if(typeof document!=='undefined')bindStockUpload();
