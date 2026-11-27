import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {retire,selectTargets,TARGETS,APPROVAL} from '../../scripts/monitoring/checkly-retire.mjs';

const fixtures=()=>TARGETS.map(c=>({...c,activated:true,muted:false,frequency:10,locations:['us-east-1'],request:{url:'https://www.amadolibros.com/'},alertChannelSubscriptions:[{alertChannelId:7,activated:true}]}));
function fakeApi(checks=fixtures(),{ignoreUpdate=false,alterConfig=false,partialList=false,keepSubscriptions=false}={}) {
  const inventory=structuredClone(checks),calls=[];
  const api=async(path,options={})=>{
    calls.push({path,...options});
    if(path==='/v1/accounts/me/entitlements')return {plan:'hobby'};
    if(path==='/v1/checks')return structuredClone(inventory).map(c=>{if(partialList){delete c.request;delete c.alertChannelSubscriptions;}return c;});
    const id=path.split('?')[0].split('/').at(-1),check=inventory.find(c=>c.id===id);
    if(!check)throw Error('UNEXPECTED_CHECK');
    if(options.method==='PUT'&&!ignoreUpdate){const subscriptions=check.alertChannelSubscriptions;Object.assign(check,options.body);if(keepSubscriptions)check.alertChannelSubscriptions=subscriptions;if(alterConfig)check.frequency=60;}
    return structuredClone(check);
  };
  api.calls=calls;
  return api;
}

test('baja: apaga y silencia los seis IDs y verifica el inventario final',async()=>{
  const api=fakeApi(),report=await retire({api,approval:APPROVAL});
  assert.equal(report.knownChecksDisabled,true);
  assert.deepEqual(report.remainingActive,[]);
  assert.equal(report.updated.length,6);
  for(const call of api.calls.filter(c=>c.method==='PUT')) {
    assert.deepEqual(call.body,{activated:false,muted:true,alertChannelSubscriptions:[]});
    assert.match(call.path,/^\/v1\/checks\/(api|browser)\/[a-f0-9-]+\?autoAssignAlerts=false$/);
  }
  assert.ok(api.calls.every(c=>!c.method||c.method==='PUT'));
});
test('baja: repetirla no vuelve a escribir ni recrea controles borrados',async()=>{
  const checks=fixtures().slice(1).map(c=>({...c,activated:false,muted:true,alertChannelSubscriptions:[]})),api=fakeApi(checks);
  const report=await retire({api,approval:APPROVAL});
  assert.equal(report.updated.length,0);
  assert.deepEqual(report.missingKnownIds,[TARGETS[0].id]);
  assert.equal(api.calls.some(c=>c.method),false);
});
test('baja: compara el detalle antes y después aunque el listado omita campos',async()=>{
  const report=await retire({api:fakeApi(fixtures(),{partialList:true}),approval:APPROVAL});
  assert.equal(report.knownChecksDisabled,true);
  assert.equal(report.updated.length,6);
});
test('baja: sin autorización no consulta ni escribe',async()=>{
  const api=fakeApi();
  await assert.rejects(retire({api,approval:'otra'}),/OWNER_APPROVAL_REQUIRED/);
  assert.equal(api.calls.length,0);
});
test('baja: detiene todo antes de escribir si cambió la identidad de un control',async()=>{
  const checks=fixtures();checks[5].name='Otro servicio';const api=fakeApi(checks);
  await assert.rejects(retire({api,approval:APPROVAL}),/CHECKLY_TARGET_CHANGED/);
  assert.equal(api.calls.some(c=>c.method),false);
});
test('baja: un control nuevo de Amado requiere revisar el alcance antes de tocar nada',async()=>{
  const api=fakeApi([...fixtures(),{id:'nuevo',name:'Amado - nuevo',activated:true}]);
  await assert.rejects(retire({api,approval:APPROVAL}),/CHECKLY_UNREVIEWED_AMADO_CHECK/);
  assert.equal(api.calls.some(c=>c.method),false);
});
test('baja: no toca controles de otro proyecto y los informa',async()=>{
  const other={id:'other',name:'Otra tienda',activated:true,muted:false,checkType:'API'};
  const api=fakeApi([...fixtures(),other]),report=await retire({api,approval:APPROVAL});
  assert.deepEqual(report.remainingActive,[other]);
  assert.equal(api.calls.some(c=>c.method&&c.path.includes('other')),false);
});
test('baja: HTTP exitoso sin apagado efectivo no se informa como éxito',async()=>{
  await assert.rejects(retire({api:fakeApi(fixtures(),{ignoreUpdate:true}),approval:APPROVAL}),/CHECKLY_NOT_DISABLED/);
});
test('baja: comprueba que también se hayan desuscripto los avisos',async()=>{
  await assert.rejects(retire({api:fakeApi(fixtures(),{keepSubscriptions:true}),approval:APPROVAL}),/CHECKLY_ALERTS_STILL_ATTACHED/);
});
test('baja: detecta modificaciones a configuración ajena a la baja',async()=>{
  await assert.rejects(retire({api:fakeApi(fixtures(),{alterConfig:true}),approval:APPROVAL}),/CHECKLY_UNEXPECTED_CONFIGURATION_CHANGE/);
});
test('baja: inventario inválido o repetido no permite elegir controles',()=>{
  assert.throws(()=>selectTargets({}),/CHECKLY_INVENTORY_INVALID/);
  assert.throws(()=>selectTargets([fixtures()[0],fixtures()[0]]),/CHECKLY_INVENTORY_INVALID/);
});
test('CLI anterior: ya no permite aplicar ni ejecutar simulacros, incluso con una clave configurada',()=>{
  for(const action of ['aplicar','simulacro']) {
    let failure;
    try {execFileSync(process.execPath,['scripts/monitoring/checkly-cobro.mjs',action],{cwd:new URL('../../',import.meta.url),env:{...process.env,CHECKLY_API_KEY:'clave-inventada'},stdio:'pipe'});}
    catch(error){failure=error;}
    assert.equal(failure?.status,1);
    assert.match(String(failure?.stderr),/CHECKLY_RETIRADO_USAR_UPTIMEROBOT/);
    assert.doesNotMatch(String(failure?.stderr),/HTTP|fetch|clave-inventada/);
  }
});
