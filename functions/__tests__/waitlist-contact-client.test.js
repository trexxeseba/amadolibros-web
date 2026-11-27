import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderPage} from './helpers/render-product-page.js';

test('Avisame valida antes del envio y permite corregir el contacto sin recargar',async()=>{
  const html=renderPage({id:'MLU12345',title:'Libro agotado',price:1200,status:'paused',available_quantity:0},'libro',true,'test-key');
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes("getElementById('aviso-stock')"));
  assert.ok(script);
  const listeners={},attrs={};let focused=false,calls=0;
  const field={value:'099123456abc',addEventListener:(k,fn)=>listeners['field:'+k]=fn,setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k],focus:()=>focused=true};
  const status={className:'',textContent:'',classList:{contains:k=>status.className.includes(k)}};
  const button={};const form={elements:{email:field,company:{value:''}},addEventListener:(k,fn)=>listeners[k]=fn,querySelector:s=>s.startsWith('button')?button:{value:'valid-token'}};
  vm.runInNewContext(script,{document:{getElementById:id=>id==='aviso-stock'?form:status},window:{location:{pathname:'/libro/MLU12345'}},fetch:async()=>{calls++;return Response.json({registered:true});}});
  await listeners.submit({preventDefault(){}});
  assert.equal(calls,0);assert.equal(attrs['aria-invalid'],'true');assert.equal(focused,true);
  assert.match(status.textContent,/099 123 456/);
  field.value='099 123 456';listeners['field:input']();
  assert.equal(attrs['aria-invalid'],undefined);assert.equal(status.textContent,'');
  await listeners.submit({preventDefault(){}});
  assert.equal(calls,1);assert.equal(status.className,'waitlist-status is-ok');assert.equal(button.disabled,false);
});
