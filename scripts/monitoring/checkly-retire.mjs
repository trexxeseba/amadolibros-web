// Baja operativa autorizada por Seba el 26/11/2026. No borra el historial,
// no cancela cuentas ajenas y no crea controles, canales, pedidos ni pagos.
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {checklyApi, CHECKLY_ACCOUNT} from './checkly-cobro.mjs';

export const APPROVAL = '2026-11-26';
export const TARGETS = [
  {id:'cae1fd03-78de-4865-9739-32e0808b0e95',name:'Amado cobro - configuracion y servicios',checkType:'API'},
  {id:'86114915-1782-4d12-9697-bbddb7c1632a',name:'Amado - catalogo y sincronizacion',checkType:'API'},
  {id:'5f279721-5056-423c-b066-86f058cb2510',name:'Amado - disponibilidad del catalogo',checkType:'API'},
  {id:'4c0aa824-c117-4376-82dc-3e735a1f4009',name:'Amado - prueba de entrega al backend',checkType:'API'},
  {id:'0e4f3da1-91d2-42cc-9c6c-c2888be2546b',name:'Amado cobro - aviso de Mercado Pago exige firma',checkType:'API'},
  {id:'0dc3fea6-5f11-49eb-b9e0-1c4f79471334',name:'Amado - portadas banners y ficha',checkType:'BROWSER'},
];
const targetById = new Map(TARGETS.map(c => [c.id,c]));
const summary = c => ({id:c.id,name:c.name,checkType:c.checkType,activated:c.activated,muted:c.muted});
const protectedKeys = ['name','checkType','request','script','frequency','locations','tags','groupId','runtimeId','runParallel','doubleCheck','retryStrategy','maxResponseTime','degradedResponseTime','alertSettings','useGlobalAlertSettings'];
const protectedConfig = c => Object.fromEntries(protectedKeys.map(k => [k,c[k]]));
const hasSubscriptions = c => (c.alertChannelSubscriptions||[]).length>0;

export function selectTargets(inventory) {
  if (!Array.isArray(inventory) || new Set(inventory.map(c=>c.id)).size !== inventory.length) throw Error('CHECKLY_INVENTORY_INVALID');
  const selected=[];
  for (const c of inventory) {
    const expected=targetById.get(c.id);
    if (!expected) {
      if (/^Amado(?:\s|$)/i.test(c.name||'') && c.activated !== false) throw Error('CHECKLY_UNREVIEWED_AMADO_CHECK');
      continue;
    }
    if (c.name!==expected.name || c.checkType!==expected.checkType || typeof c.activated!=='boolean' || typeof c.muted!=='boolean') throw Error('CHECKLY_TARGET_CHANGED');
    selected.push(c);
  }
  return selected;
}

export async function retire({api, approval, report={}}) {
  if (approval!==APPROVAL) throw Error('OWNER_APPROVAL_REQUIRED');
  report.startedAt=new Date().toISOString();
  report.accountId=CHECKLY_ACCOUNT;
  const [inventory, entitlements]=await Promise.all([api('/v1/checks'),api('/v1/accounts/me/entitlements')]);
  const targets=selectTargets(inventory);
  report.plan=typeof entitlements?.plan==='string'?entitlements.plan:null;
  report.before=targets.map(summary);
  report.missingKnownIds=TARGETS.filter(t=>!targets.some(c=>c.id===t.id)).map(t=>t.id);
  report.updated=[];
  report.after=[];
  for (const listed of targets) {
    // El listado y el detalle no incluyen siempre los mismos campos/defaults.
    // Comparar dos lecturas del mismo endpoint evita atribuirlos al PUT.
    const before=await api(`/v1/checks/${listed.id}`);
    if (before.id!==listed.id) throw Error('CHECKLY_TARGET_CHANGED');
    selectTargets([before]);
    if (before.activated || !before.muted || hasSubscriptions(before)) {
      await api(`/v1/checks/${before.checkType.toLowerCase()}/${before.id}?autoAssignAlerts=false`, {
        method:'PUT',body:{activated:false,muted:true,alertChannelSubscriptions:[]},
      });
      report.updated.push(before.id);
    }
    const after=await api(`/v1/checks/${before.id}`);
    if (after.id!==before.id || after.activated!==false || after.muted!==true) throw Error('CHECKLY_NOT_DISABLED');
    if (hasSubscriptions(after)) throw Error('CHECKLY_ALERTS_STILL_ATTACHED');
    if (!isDeepStrictEqual(protectedConfig(before),protectedConfig(after))) {
      report.unexpectedChangedKeys=Object.keys(protectedConfig(before)).filter(k=>!isDeepStrictEqual(protectedConfig(before)[k],protectedConfig(after)[k]));
      throw Error('CHECKLY_UNEXPECTED_CONFIGURATION_CHANGE');
    }
    report.after.push(summary(after));
  }
  const finalInventory=await api('/v1/checks');
  const finalTargets=selectTargets(finalInventory);
  if (finalTargets.some(c=>c.activated || !c.muted || hasSubscriptions(c))) throw Error('CHECKLY_STILL_ACTIVE');
  report.remainingActive=finalInventory.filter(c=>c.activated).map(summary);
  report.remainingAlertSubscriptions=finalTargets.reduce((n,c)=>n+(c.alertChannelSubscriptions||[]).length,0);
  report.knownChecksDisabled=true;
  report.finishedAt=new Date().toISOString();
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const report={knownChecksDisabled:false};
  try { await retire({api:checklyApi(),approval:process.env.OWNER_CHECKLY_RETIRE,report}); }
  catch (error) {
    report.error=/^[A-Z0-9_]+$/.test(error?.message||'')?error.message:'CHECKLY_RETIRE_FAILED';
    process.exitCode=1;
  }
  await mkdir('artifacts/checkly-retired',{recursive:true});
  await writeFile('artifacts/checkly-retired/report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
