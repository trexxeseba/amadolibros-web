import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {renderPage} from '../libro/[[path]].js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/gallery-visual.json',import.meta.url),'utf8'));
const poster=fixtures.decoded.find(r=>fixtures.cases.find(c=>c.id===r.id).bad);
const cover=fixtures.decoded.find(r=>!fixtures.cases.find(c=>c.id===r.id).bad);

async function gallery(allPosters=false){
  const book={id:'MLU123456789',title:'Galeria',price:1200,status:'active',available_quantity:1,pictures:['https://http2.mlstatic.com/D_FIRST-O.jpg','https://http2.mlstatic.com/D_SECOND-O.jpg','https://http2.mlstatic.com/D_THIRD-O.jpg']};
  const html=renderPage(book,'galeria');
  const script=html.match(/<script>\(function\(\)\{\n  var imgs=[\s\S]*?<\/script>/)[0];
  const placeholders=[];
  function node(attrs={}){return{attrs,style:{},listeners:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]??null;},removeAttribute(k){delete this.attrs[k];},hasAttribute(k){return k in this.attrs;},addEventListener(k,fn){this.listeners[k]=fn;},focus(){},parentNode:{appendChild:p=>placeholders.push(p)}};}
  const nodes={glb:node({hidden:''}),glbImg:node(),glbCounter:node(),gMainBtn:node({'data-current-index':'0'}),gMainImg:node({'data-title':'Galeria'}),glbClose:node()};
  const thumbs=[node(),node(),node()],prev=node(),next=node();
  const document={body:{style:{}},getElementById:id=>nodes[id],querySelectorAll:()=>thumbs,querySelector:s=>s==='.lb-prev'?prev:next,addEventListener(){},createElement(type){
    if(type!=='canvas')return{};
    const ctx={fillRect(){},drawImage(image){this.data=image.pixels;},getImageData(){return{data:this.data};}};
    return{getContext:()=>ctx};
  }};
  class Image{set src(value){const photo=allPosters||/\/cover\.jpg$/.test(value)?poster:cover;this.pixels=photo.pixels;this.naturalWidth=photo.aspect*1000;this.naturalHeight=1000;setImmediate(()=>this.onload?.());}}
  vm.runInNewContext(script.slice(8,-9),{document,Image,setTimeout,clearTimeout,requestIdleCallback:fn=>fn()});
  for(let i=0;i<4;i++)await new Promise(setImmediate);
  return{nodes,thumbs,prev,next,placeholders};
}

test('a reuploaded poster is removed from thumbnails, main image and zoom navigation',async()=>{
  const{nodes,thumbs,next}=await gallery();
  assert.equal(thumbs[0].hidden,true);
  assert.equal(nodes.gMainBtn.getAttribute('data-current-index'),'1');
  nodes.gMainBtn.listeners.click();assert.match(nodes.glbImg.src,/cover-2\.jpg$/);
  assert.equal(nodes.glbCounter.textContent,'Imagen 1 de 2');
  next.listeners.click();assert.match(nodes.glbImg.src,/cover-3\.jpg$/);
  next.listeners.click();assert.match(nodes.glbImg.src,/cover-2\.jpg$/);
});

test('a gallery containing only reviewed posters shows an honest empty state',async()=>{
  const{nodes,thumbs,placeholders}=await gallery(true);
  assert.ok(thumbs.every(t=>t.hidden));assert.equal(nodes.gMainBtn.hidden,true);
  assert.equal(placeholders.length,1);assert.equal(placeholders[0].textContent,'Imagen del libro no disponible');
});

test('el filtro define __name antes de usar funciones serializadas (el empaquetado las envuelve con __name)',()=>{
  const book={id:'MLU123456789',title:'Galeria',price:1200,status:'active',available_quantity:1,pictures:['https://http2.mlstatic.com/D_FIRST-O.jpg','https://http2.mlstatic.com/D_SECOND-O.jpg']};
  const html=renderPage(book,'galeria');
  const start=html.indexOf('var filterImages=function(){');
  const shim=html.indexOf('var __name=function(target){return target;};',start);
  assert.ok(start>0&&shim>start,'falta el ayudante __name dentro de filterImages');
  assert.ok(shim<html.indexOf('var policy=',start),'__name se define antes de armar la politica');
});
