import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {cardHtml} from '../regalos.js';
const book={id:'MLU123456',title:'Libro de regalo',price:3500,available_quantity:1,status:'active',currency_id:'UYU'};
const cartScript=readFileSync(new URL('../../astro-front/public/cart.js',import.meta.url),'utf8');

test('Regalos agrega al carrito real y el segundo clic abre el carrito sin duplicar',()=>{
  const html=cardHtml(book,0,{},'literatura');
  const tag=html.match(/<button[^>]*data-action="add-to-cart"[^>]*>/)?.[0];
  assert.ok(tag);
  const dataset={};for(const [,key,value] of tag.matchAll(/data-([\w-]+)="([^"]*)"/g))dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
  const listeners={},storage=new Map(),label={dataset:{},textContent:'Agregar al carrito'};
  const btn={dataset,querySelector:()=>label,getAttribute:()=>null,setAttribute(){}};
  const document={addEventListener:(k,fn)=>listeners[k]=fn,dispatchEvent:e=>listeners[e.type]?.(e),querySelectorAll:()=>[]};
  const window={addEventListener(){},location:{pathname:'/regalos',search:'',hash:''},scrollY:0};
  const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  vm.runInNewContext(cartScript,{window,document,localStorage,sessionStorage:localStorage,crypto:{randomUUID:()=> 'test-key'},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}});
  const event={target:{closest:()=>btn}};
  listeners.click(event);
  assert.equal(window.AmadoCart.count(),1);assert.equal(window.AmadoCart.subtotal(),3500);
  assert.equal(JSON.parse(storage.get('amado-cart')).items[0].max_qty,1);
  assert.match(label.textContent,/Ver carrito/);
  listeners.click(event);
  assert.equal(window.location.href,'/carrito');assert.equal(window.AmadoCart.count(),1);
});

test('Regalos no ofrece compra para stock/precio invalido, pausados ni moneda extranjera',()=>{
  for(const patch of [{status:'paused'},{available_quantity:0},{available_quantity:Infinity},{price:0},{price:NaN},{price:Infinity},{currency_id:'USD'},{id:'invalid'}])
    assert.doesNotMatch(cardHtml({...book,...patch},0,{},'literatura'),/data-action="add-to-cart"/,JSON.stringify(patch));
});
