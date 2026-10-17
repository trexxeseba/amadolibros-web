// User-started preflight continuation. Page visits/polling never start work.
// Only prepare/advance are accepted; approval and publishing are separate forms.
export async function runPreflight({initial,post,read,onProgress=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),stopped=()=>false,now=Date.now,maxSteps=30,maxMs=720000}) {
 if(!['prepare','advance'].includes(initial.get('action')))throw Error('preflight_action_required');
 const started=now();let request=initial,steps=0;
 while(!stopped()&&steps<maxSteps&&now()-started<maxMs) {
  if(request){await post(request);steps++;request=null;}
  const state=await read();onProgress(state);
  if(state.disabled)return {...state,state:'disabled'};
  if(state.state==='not_started'){await wait(3000);continue;}
  if(state.state!=='preflight')return state;
  if(state.busy||state.resume_at>now()){await wait(3000);continue;}
  request=new URLSearchParams({action:'advance',run_id:state.run_id});
 }
 return {state:'continuation_stopped',reason:stopped()?'user':'limit'};
}

function bindPreflightForms() {
 const path='/panel/meli-vintage-piloto';
 let running=false,stop=false;
 const notice=document.createElement('div');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
 document.querySelector('h1')?.after(notice);
 const show=state=>{
  const validated=state.counts?.find(x=>x.state==='validated')?.n??0;
  notice.textContent=state.state==='not_started'?'Preparando el lote de Vintage…':
   !state.index_complete?'Revisando publicaciones '+(state.index_status==='paused'?'pausadas':'activas')+' de Vintage: '+state.indexed+' revisadas.':
   'Revisión de duplicados terminada. Libros validados: '+validated+' de 5.';
  if(state.busy)notice.textContent+=' Hay una comprobación en curso.';
  if(state.resume_at>Date.now())notice.textContent+=' Esperando la pausa solicitada por Mercado Libre.';
 };
 const read=async()=>{
  const response=await fetch(path+'?format=progress',{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('status_unavailable');
  return response.json();
 };
 const post=async body=>{
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),150000);
  let reading=false;
  const poll=setInterval(async()=>{
   if(reading||!running)return;reading=true;
   try{const state=await read();if(running)show(state);}catch{}finally{reading=false;}
  },3000);
  try{
   const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:controller.signal});
   if(!response.ok){
    const html=await response.text(),code=new DOMParser().parseFromString(html,'text/html').querySelector('code')?.textContent??'';
    throw Error(/^[a-z0-9_]{1,80}$/.test(code)?code:'preflight_failed');
   }
   await response.text();
  }finally{clearTimeout(timeout);clearInterval(poll);}
 };
 const stopButton=document.createElement('button');stopButton.type='button';stopButton.textContent='Detener continuación';
 stopButton.hidden=true;notice.after(stopButton);
 stopButton.addEventListener('click',()=>{stop=true;stopButton.disabled=true;notice.textContent='La continuación se detendrá cuando termine la comprobación en curso.';});
 for(const form of document.querySelectorAll('form[data-vintage-preflight]')){
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(running)return;
   const initial=new URLSearchParams(new FormData(form));
   running=true;stop=false;stopButton.hidden=false;stopButton.disabled=false;
   const buttons=[...document.querySelectorAll('form[data-vintage-preflight] button')];buttons.forEach(button=>button.disabled=true);
   notice.textContent='Validación automática en curso. Este proceso no crea publicaciones.';
   try{
    await runPreflight({initial,post,read,onProgress:show,stopped:()=>stop});
    window.location.assign(path);
   }catch(error){
    const code=/^[a-z0-9_]{1,80}$/.test(error.message)?' ('+error.message+')':'';
    notice.textContent='La validación no pudo continuar'+code+'. El avance guardado se conserva. ';
    const link=document.createElement('a');link.href=path;link.textContent='Ver estado guardado';notice.append(link);
   }finally{running=false;stopButton.hidden=true;buttons.forEach(button=>button.disabled=false);}
  });
 }
}
if(typeof document!=='undefined')bindPreflightForms();
