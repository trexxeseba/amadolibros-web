// Evidence-only UX journeys on production. No orders, payments, contacts or analytics are sent.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path');
const BASE='https://www.amadolibros.com';
const OUT=path.resolve('product-consistency');
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
const IDS=["MLU1045175530","MLU1247650322","MLU1453304176","MLU622669081","MLU628130354","MLU636039773","MLU639917680","MLU652446535","MLU668155030","MLU682311076","MLU687857558","MLU688248964","MLU706638240","MLU729484780","MLU783512566","MLU862968034","MLU863244436","MLU863271916","MLU863972466","MLU912954534"];
(async()=>{
 await fs.mkdir(OUT,{recursive:true});const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  context=await browser.newContext({viewport:{width:390,height:844},locale:'es-UY',isMobile:true,hasTouch:true});
  await context.route('**/*',r=>['GET','HEAD'].includes(r.request().method())&&!/google-analytics|analytics.google|doubleclick|googleadservices|facebook|\/api\/marketing/.test(r.request().url())?r.continue():r.abort());
  page=await context.newPage();page.setDefaultTimeout(5000);
  const feedResponse=await context.request.get(BASE+'/feed.xml');const xml=await feedResponse.text();
  report.feed={at:new Date().toISOString(),status:feedResponse.status(),items:(xml.match(/<item>/g)||[]).length};
  report.products=[];const tag=(s,name)=>{const m=s.match(new RegExp('<(?:g:)?'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:g:)?'+name+'>'));return m?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g,'').replace(/&amp;/g,'&').trim()||null};
  for(const id of IDS){
   const item=(xml.match(/<item>[\s\S]*?<\/item>/g)||[]).find(s=>tag(s,'id')===id);const f=item?Object.fromEntries(['id','title','link','image_link','price','sale_price','availability','condition'].map(k=>[k,tag(item,k)])):null;
   await act('product-'+id,async()=>{
    const s=await go(f?.link||'/libro/'+id,id,false);
    await rejectCookies().catch(()=>{});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(OUT,id+'.png')});
    const images=await page.locator('main img').evaluateAll(es=>es.slice(0,10).map(e=>({src:e.currentSrc||e.src,alt:e.alt,width:e.naturalWidth,height:e.naturalHeight})));
    const book={id,feed:f,url:s.url,status:s.httpStatus,title:s.title,schema:s.schema,images,text:s.text,at:s.at};
    if(f?.image_link){const response=await context.request.get(f.image_link);book.cover={status:response.status(),contentType:response.headers()['content-type']};if(response.ok())await fs.writeFile(path.join(OUT,id+'-feed.jpg'),await response.body());}
    report.products.push(book);await save();
   });
  }
  for(const id of ['MLU633015355','MLU625783078','MLU629635962','MLU702445718'])await act('merchant-issue-'+id,()=>go('/libro/'+id,'merchant-'+id,false));
  await go('/regalos','gift-check',false);
  const cheap=await page.locator('main article').evaluateAll(es=>es.map(e=>({text:e.innerText,link:e.querySelector('a[href*="/libro/"]')?.href})).filter(x=>x.link).slice(0,90));report.giftCards=cheap;
 }finally{report.finishedAt=new Date().toISOString();await save();await browser.close();}
})().catch(async e=>{report.fatal=e.stack;await save();console.error(e.message);process.exitCode=1;});
