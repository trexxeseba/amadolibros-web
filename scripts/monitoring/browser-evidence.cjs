// Read-only diagnostics: block writes and Analytics; never submit orders or payments.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path');
const BASE='https://www.amadolibros.com';
(async()=>{
 const out=path.resolve('browser-evidence');await fs.mkdir(out,{recursive:true});let browser;
 try{
  let channel='chrome';
  try{browser=await chromium.launch({headless:true,channel:'chrome'});}catch{channel='chromium';browser=await chromium.launch({headless:true});}
  const report={collectedAt:new Date().toISOString(),browser:await browser.version(),channel,runs:[]};
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
   const context=await browser.newContext({viewport,locale:'es-UY'});
   await context.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(!['GET','HEAD'].includes(r.method())||/google-analytics|googletagmanager|doubleclick|facebook|googleadservices/.test(u.hostname))return route.abort();
    return route.continue();
   });
   const page=await context.newPage();let productPath;
   for(const name of ['portada','catalogo','ficha']){
    if(name==='ficha'&&!productPath)continue;
    const url=BASE+(name==='portada'?'/':name==='catalogo'?'/catalogo':productPath);
    const run={name,url,viewport,at:new Date().toISOString(),errors:[],badResponses:[],failedRequests:[]};
    const onError=e=>run.errors.push(e.message);
    const onResponse=r=>{if(r.status()>=400)run.badResponses.push({url:r.url(),status:r.status()});};
    const onFailed=r=>{if(r.failure()?.errorText!=='net::ERR_FAILED')run.failedRequests.push({url:r.url(),error:r.failure()?.errorText});};
    page.on('pageerror',onError);page.on('response',onResponse);page.on('requestfailed',onFailed);
    try{
     const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});run.httpStatus=response.status();
     await page.waitForTimeout(8500);
     run.initial=await page.evaluate(()=>({
      title:document.title,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      h1:document.querySelector('h1')?.textContent,body:document.body.innerText.slice(0,24000),
      images:[...document.images].map(i=>{const r=i.getBoundingClientRect();return{src:i.currentSrc||i.src,alt:i.alt,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,complete:i.complete,visible:r.width>20&&r.height>20&&r.top<innerHeight&&r.bottom>0,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}}),
      productLinks:[...document.querySelectorAll('a[href*="/libro/"]')].slice(0,15).map(a=>a.getAttribute('href')),
      backgrounds:[...document.querySelectorAll('main *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20&&r.top<innerHeight&&r.bottom>0&&getComputedStyle(el).backgroundImage!=='none'}).slice(0,15).map(el=>({tag:el.tagName,classes:el.className,background:getComputedStyle(el).backgroundImage})),
     }));
     if(name==='catalogo'&&run.initial.productLinks[0])productPath=new URL(run.initial.productLinks[0],BASE).pathname;
     await page.screenshot({path:path.join(out,name+'-'+viewport.width+'-first.png')});
     await page.evaluate(()=>scrollTo(0,innerHeight));await page.waitForTimeout(8500);
     run.afterScroll=await page.evaluate(()=>({images:[...document.images].filter(i=>{const r=i.getBoundingClientRect();return r.width>20&&r.height>20&&r.top<innerHeight&&r.bottom>0}).map(i=>({src:i.currentSrc||i.src,naturalWidth:i.naturalWidth,complete:i.complete}))}));
     await page.screenshot({path:path.join(out,name+'-'+viewport.width+'-full.png'),fullPage:true});
     run.resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(x=>x.initiatorType==='img').map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize})));
    }catch(e){run.failure=e.message;}
    page.off('pageerror',onError);page.off('response',onResponse);page.off('requestfailed',onFailed);
    report.runs.push(run);await fs.writeFile(path.join(out,'browser-results.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({name,viewport:viewport.width,url,status:run.httpStatus,failure:run.failure,broken:run.initial?.images.filter(i=>i.visible&&(!i.complete||!i.naturalWidth)),errors:run.errors,badResponses:run.badResponses}));
   }
   await context.close();
  }
 }finally{await browser?.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
