// Evidence-only UX journeys on production. No orders, payments, contacts or analytics are sent.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path');
const BASE='https://www.amadolibros.com';
const OUT=path.resolve('ux-followup');
const report={startedAt:new Date().toISOString(),pages:[],actions:[],requests:[],errors:[]};
const product='/libro/MLU1001381834/falcones-la-reina-descalza-novela-historica-tapa-dura';
let page,context,current='';
async function save(){await fs.writeFile(path.join(OUT,'ux-results.json'),JSON.stringify(report,null,2));}
async function act(name,fn){try{const value=await fn();report.actions.push({name,at:new Date().toISOString(),url:page.url(),ok:true,value});}catch(e){report.actions.push({name,at:new Date().toISOString(),url:page.url(),ok:false,error:e.message.slice(0,1400)});}await save();}
async function snap(name,full=true,a11y=false){
 current=name;await page.waitForTimeout(1000);
 const result=await page.evaluate(()=>{
  const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom}};
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
  const above=el=>{const r=el.getBoundingClientRect();return visible(el)&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0};
  const hit=el=>{const r=el.getBoundingClientRect();if(!above(el))return null; const x=Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.y+r.height/2));const h=document.elementFromPoint(x,y);return{reachable:!!h&&(el.contains(h)||h===el),topElement:h?.tagName+'#'+h?.id+'.'+h?.className}};
  return {url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
    text:document.body.innerText.slice(0,52000),
    headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).map(e=>({tag:e.tagName,text:e.textContent.trim(),rect:rect(e)})),
    controls:[...document.querySelectorAll('a,button,input,select,textarea,summary')].filter(visible).slice(0,450).map(e=>({tag:e.tagName,id:e.id,name:e.name,type:e.type,role:e.getAttribute('role'),text:(e.innerText||e.getAttribute('aria-label')||e.placeholder||'').trim().slice(0,220),href:e.getAttribute('href'),action:e.getAttribute('data-action'),rect:rect(e),above:above(e),hit:hit(e),required:e.required,options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:o.text})):undefined})),
    images:[...document.images].filter(visible).slice(0,120).map(e=>({src:e.currentSrc||e.src,alt:e.alt,width:e.naturalWidth,height:e.naturalHeight,complete:e.complete,rect:rect(e),above:above(e)})),
    suggestions:[...document.querySelectorAll('datalist option')].map(e=>({value:e.value,label:e.label})),
    schema:[...document.querySelectorAll('script[type="application/ld+json"]')].map(e=>{try{return JSON.parse(e.textContent)}catch{return e.textContent}}),
    metrics:window.__uxVitals||{},navigation:performance.getEntriesByType('navigation').map(e=>({responseStart:e.responseStart,domContentLoaded:e.domContentLoadedEventEnd,load:e.loadEventEnd,transfer:e.transferSize})),
    resources:performance.getEntriesByType('resource').filter(e=>/img|script|css|fetch|xmlhttprequest/.test(e.initiatorType)).map(e=>({name:e.name,type:e.initiatorType,duration:e.duration,transfer:e.transferSize})),
    dataLayer:(window.dataLayer||[]).map(e=>Array.from(e)).filter(e=>e[0]==='event').slice(-30),
  };
 });
 const evidence={name,at:new Date().toISOString(),...result};
 await page.screenshot({path:path.join(OUT,name+'.png')});
 if(full)await page.screenshot({path:path.join(OUT,name+'-full.png'),fullPage:true});
 if(a11y){try{await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});evidence.accessibility=await page.evaluate(async()=>{const x=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return{violations:x.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,helpUrl:v.helpUrl,nodes:v.nodes.slice(0,20).map(n=>({html:n.html,target:n.target,summary:n.failureSummary}))})),incomplete:x.incomplete.map(v=>({id:v.id,help:v.help,nodes:v.nodes.length}))};});}catch(e){evidence.axeError=e.message;}}
 report.pages.push(evidence);await save();console.log(JSON.stringify({name,url:result.url,width:result.scroll.width,viewport:result.viewport.width,violations:evidence.accessibility?.violations.map(v=>v.id)}));return evidence;
}
async function go(url,name,full=true,a11y=false){current=name;const r=await page.goto(new URL(url,BASE).href,{waitUntil:'domcontentloaded',timeout:40000});await page.waitForTimeout(1800);const s=await snap(name,full,a11y);s.httpStatus=r.status();await save();return s;}
async function rejectCookies(){const b=page.getByRole('button',{name:/Rechazar/i}).first();if(await b.count())await b.click({timeout:3000});}
(async()=>{
 await fs.mkdir(OUT,{recursive:true});const browser=await chromium.launch({channel:'chrome',headless:true});report.browser=await browser.version();report.channel='chrome';
 try{
  context=await browser.newContext({viewport:{width:375,height:812},locale:'es-UY',isMobile:true,hasTouch:true});
  await context.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());
   if(/google-analytics|analytics.google|doubleclick|googleadservices|facebook|wa\.me|whatsapp/.test(u.hostname)||/\/api\/(?:marketing|analytics|events|search-miss)/.test(u.pathname))return route.fulfill({status:204,body:''});
   if(!['GET','HEAD'].includes(r.method())&&!(u.hostname==='www.amadolibros.com'&&u.pathname==='/api/cart/validate'&&r.method()==='POST')){report.requests.push({page:current,url:r.url(),method:r.method(),blocked:'write'});return route.abort();}
   return route.continue();
  });
  await context.addInitScript(()=>{
   window.__uxVitals={cls:0,shifts:[]};
   new PerformanceObserver(l=>{for(const e of l.getEntries())window.__uxVitals.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});
   new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput){window.__uxVitals.cls+=e.value;window.__uxVitals.shifts.push({value:e.value,at:e.startTime,sources:e.sources.map(s=>({node:s.node?.outerHTML.slice(0,200),previous:s.previousRect.toJSON(),current:s.currentRect.toJSON()}))})}}).observe({type:'layout-shift',buffered:true});
  });
  page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>report.errors.push({page:current,message:e.message}));
  await go(product,'ficha-375',false,true);await act('rechazar',rejectCookies);await page.evaluate(()=>scrollTo(0,0));await snap('ficha-limpia-375',false);
  await act('expandir-bibliografia',()=>page.getByText('Ver más sobre este libro',{exact:true}).click());await snap('ficha-bibliografia',false);
  await act('ver-sinopsis',()=>page.getByRole('heading',{name:/De qué trata/}).scrollIntoViewIfNeeded());await snap('ficha-sinopsis',false);
  await go('/libro/MLU1001304230','encargo-375',false);
  await act('contacto-invalido',async()=>{
   const f=page.locator('main form').first();const inp=f.locator('input:not([type="hidden"]):not([tabindex="-1"])').first();
   await inp.fill('09abc841325');await f.locator('button[type="submit"]').click();return f.innerText();
  });await snap('encargo-error-contacto',false);
  await go('/temas','temas-375',false);
  for(const name of ['Educación','Psicología']){
   await act('profesional-'+name,async()=>{
    await page.getByRole('link',{name,exact:true}).first().click();await snap('tema-'+(name==='Educación'?'educacion':'psicologia'),false);
   });await go('/temas','temas-retorno-'+name,false);
  }
  await go('/catalogo?q=criminalistica','busqueda-sin-tilde',false);
  await go('/regalos','regalos-inicio-375',false);
  await act('regalos-clasificacion',async()=>{
   const hs=await page.locator('main h2,main h3').allTextContents();report.giftHeadings=hs;
   await page.getByRole('heading',{name:/manga|cómic/i}).first().scrollIntoViewIfNeeded();
  });await snap('regalos-comics',false);
  await act('regalos-ninos',()=>page.getByRole('heading',{name:/niñ|chic|pequeñ/i}).first().scrollIntoViewIfNeeded());await snap('regalos-ninos',false);
  await go('/libro/MLU863228068','barato-375',false);
  await act('cart-add',()=>page.locator('[data-action="add-to-cart"]').first().click());
  for(let i=0;i<3;i++){await go('/carrito','cart-load-'+i,false);await page.waitForTimeout(3000);}
  await act('cart-envio',()=>page.locator('input[name="delivery"][value="shipping"]').check());
  await page.evaluate(()=>scrollTo(0,0));await snap('cart-envio-arriba',false);
  await act('cart-resumen',()=>page.locator('#cart-summary-panel summary').click());await page.evaluate(()=>scrollTo(0,0));await snap('cart-resumen-abierto',false);
  await act('cart-metodos',()=>page.getByText('¿Cómo querés pagar?',{exact:true}).scrollIntoViewIfNeeded());await snap('cart-metodos',false);
  await act('cart-transferencia',()=>page.locator('#payment-method-transfer').check());await snap('cart-transferencia-final',false);
  await act('cart-mercadopago',()=>page.locator('#payment-method-mercadopago').check());await snap('cart-mercadopago-final',false);
  await go('/especialidades/psicologia','especialidad-datos',false);
  await act('ficha-freud',async()=>{await page.getByRole('link',{name:/Psicoanalisis Aplicado Y Tecnica/i}).first().click();await snap('ficha-autor-inconsistente',false);});
  await context.close();
  context=await browser.newContext({viewport:{width:1440,height:900},locale:'es-UY'});page=await context.newPage();page.setDefaultTimeout(6000);
  await context.route('**/*',r=>['GET','HEAD'].includes(r.request().method())&&!/analytics|doubleclick|facebook/.test(r.request().url())?r.continue():r.abort());
  for(const [name,url]of [
   ['casa-del-libro','https://www.casadellibro.com/libro-la-reina-descalza/9788425350528/2071694'],
   ['bookshop','https://bookshop.org/'],
   ['escaramuza','https://escaramuza.com.uy/'],
   ['libreriadelau','https://www.libreriadelau.com/']
  ])await act('benchmark-'+name,()=>go(url,'benchmark-'+name,false));
 }finally{report.finishedAt=new Date().toISOString();await save();await browser.close();}
})().catch(async e=>{report.fatal=e.stack;await save();console.error(e.message);process.exitCode=1;});
