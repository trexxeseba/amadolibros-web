// Evidence-only UX journeys on production. No orders, payments, contacts or analytics are sent.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path');
const BASE='https://www.amadolibros.com';
const OUT=path.resolve('ux-evidence');
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
 await fs.mkdir(OUT,{recursive:true});let browser;
 try{
  try{browser=await chromium.launch({channel:'chrome',headless:true});report.channel='chrome';}catch{browser=await chromium.launch({headless:true});report.channel='chromium';}
  report.browser=await browser.version();
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
   context=await browser.newContext({viewport,locale:'es-UY',isMobile:viewport.width<500,hasTouch:viewport.width<500});
   await context.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url());const record={page:current,at:new Date().toISOString(),method:r.method(),url:r.url()};
    if(/google-analytics|analytics.google|doubleclick|googleadservices/.test(u.hostname)||(/googletagmanager/.test(u.hostname)&&!u.pathname.includes('/gtag/js'))){report.requests.push({...record,blocked:'analytics',body:r.postData()?.slice(0,8000)});return route.fulfill({status:204,body:''});}
    if(/facebook|wa\.me|whatsapp/.test(u.hostname)||/\/api\/(?:marketing|analytics|events|search-miss)/.test(u.pathname)){report.requests.push({...record,blocked:'analytics-or-contact'});return route.abort();}
    if(!['GET','HEAD'].includes(r.method())&&!(u.hostname==='www.amadolibros.com'&&u.pathname==='/api/cart/validate'&&r.method()==='POST')){report.requests.push({...record,blocked:'write'});return route.abort();}
    return route.continue();
   });
   await context.addInitScript(()=>{
    window.__uxVitals={cls:0};
    try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__uxVitals.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__uxVitals.cls+=e.value}).observe({type:'layout-shift',buffered:true});}catch{}
   });
   page=await context.newPage();page.setDefaultTimeout(6000);
   page.on('pageerror',e=>report.errors.push({page:current,url:page.url(),message:e.message}));
   page.on('response',r=>{if(r.status()>=400)report.requests.push({page:current,at:new Date().toISOString(),url:r.url(),status:r.status()});});
   await go(product,'ficha-'+viewport.width,true,true);
   await act('rechazar-cookies-'+viewport.width,rejectCookies);
   await page.evaluate(()=>scrollTo(0,0));await snap('ficha-sin-cookies-'+viewport.width,false);
   await act('whatsapp-ficha-'+viewport.width,async()=>{
    const a=page.locator('main a[href*="wa.me"], main a[href*="api.whatsapp"]').first();
    const href=await a.getAttribute('href');await a.click({timeout:5000});await page.waitForTimeout(1500);
    return {href,dataLayer:await page.evaluate(()=>(window.dataLayer||[]).map(x=>Array.from(x)).filter(x=>x[0]==='event'))};
   });
   await act('agregar-carrito-'+viewport.width,async()=>{await page.locator('[data-action="add-to-cart"]').first().click();await page.waitForTimeout(700);return page.evaluate(()=>JSON.parse(localStorage.getItem('amado-cart')));});
   await go('/carrito','carrito-'+viewport.width,true,true);
   await act('validacion-vacio-'+viewport.width,()=>page.locator('#btn-confirm-neutral').click());
   await snap('carrito-errores-'+viewport.width,false);
   await act('seleccionar-envio-'+viewport.width,()=>page.locator('input[name="delivery"][value="shipping"]').check());
   await snap('carrito-envio-'+viewport.width,true);
   await act('seleccionar-transferencia-'+viewport.width,()=>page.locator('#payment-method-transfer').check());
   await snap('carrito-transferencia-'+viewport.width,false);
   await act('seleccionar-retiro-'+viewport.width,()=>page.locator('input[name="delivery"][value="pickup"]').check());
   await snap('carrito-retiro-'+viewport.width,false);
   await go('/','portada-'+viewport.width,true,true);
   await act('marca-a-catalogo-'+viewport.width,async()=>{
    const links=page.locator('a[href="/catalogo"]');for(let i=0;i<await links.count();i++){if(await links.nth(i).isVisible()){await links.nth(i).click();return page.url();}}throw Error('No hay enlace visible al catálogo');
   });
   await snap('catalogo-'+viewport.width,true,true);
   if(viewport.width===390){
    const queries=['La reina descalza','reina descalssa','Ildefonso Falcones','ildefonso falconez','9788425350528','978-84-253-5052-8','zzzinexistente999','criminalística','educación','psicología'];
    for(let i=0;i<queries.length;i++){
     const query=queries[i];
     await act('buscar-'+query,async()=>{
      const input=page.locator('main input[name="q"], input[name="q"]').first();
      await input.fill(query);await page.waitForTimeout(1000);
      const suggestions=await page.locator('datalist option').evaluateAll(es=>es.map(e=>({value:e.value,label:e.label})));
      await input.press('Enter');await page.waitForURL(u=>u.searchParams.get('q')===query,{timeout:15000});await page.waitForTimeout(900);
      return {query,suggestions};
     });
     await snap('busqueda-'+i,true,i===6);
    }
    await go('/catalogo?disponibilidad=encargo','catalogo-encargo',true);
    const orderLink=await page.locator('main a[href*="/libro/"]').first().getAttribute('href').catch(()=>null);
    if(orderLink)await go(orderLink,'ficha-encargo',true,true);
    await go('/pedir-libro','pedir-libro',true,true);
    await act('pedir-libro-validacion-vacia',async()=>{await page.locator('button[type="submit"]').first().click();return page.locator(':invalid').evaluateAll(es=>es.map(e=>({name:e.name,id:e.id,message:e.validationMessage})));});
    await snap('pedir-libro-errores',false);
    for(const specialty of ['psicologia','criminalistica','educacion'])await go('/especialidades/'+specialty,'especialidad-'+specialty,true);
    await go('/regalos','regalos-390',true,true);
    const giftLink=await page.locator('main a[href*="/libro/"]').first().getAttribute('href').catch(()=>null);
    if(giftLink)await act('regalos-a-ficha',async()=>{await page.locator('main a[href*="/libro/"]').first().click();await snap('regalo-ficha',true);return page.url();});
    await go('/liquidacion','liquidacion-390',true,true);
    for(const route of ['quienes-somos','devoluciones','envios','contacto','terminos','pedido'])await go('/'+route,route,true,route==='contacto');
    // Separate cheap item journey; local cart only.
    await page.evaluate(()=>localStorage.removeItem('amado-cart'));
    await go('/libro/MLU863228068','ficha-precio-bajo',true);
    await act('agregar-libro-barato',()=>page.locator('[data-action="add-to-cart"]').first().click());
    await go('/carrito','carrito-precio-bajo',true);
    await act('envio-libro-barato',()=>page.locator('input[name="delivery"][value="shipping"]').check());
    await snap('carrito-precio-bajo-envio',true);
   }else{await go('/regalos','regalos-1440',true,true);await go('/pedir-libro','pedir-libro-1440',true,true);}
   await context.close();
  }
 }finally{report.finishedAt=new Date().toISOString();await save();await browser?.close();}
})().catch(async e=>{report.fatal=e.stack;await save();console.error(e.message);process.exitCode=1;});
