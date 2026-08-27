const USER = 'radar';
const PASSWORD_SHA256 = 'c71c8b17fa29a0e65af9eba67a744dc7d7b5099543300ff88821d30dd3de8983';
const API_ORIGIN = 'https://radar-api-amadolibros-sync.undiaes.workers.dev';

async function sha256Hex(value){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}

async function authorized(request){
  const header=request.headers.get('Authorization')||'';
  if(!header.startsWith('Basic ')) return false;
  try{
    const decoded=atob(header.slice(6));
    const i=decoded.indexOf(':');
    if(i<0) return false;
    const user=decoded.slice(0,i), pass=decoded.slice(i+1);
    return user===USER && await sha256Hex(pass)===PASSWORD_SHA256;
  }catch{return false}
}

function denied(){
  return new Response('Radar Amado — acceso privado',{status:401,headers:{'WWW-Authenticate':'Basic realm="Radar Amado"','Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'}});
}

export default {
  async fetch(request,env){
    if(!await authorized(request)) return denied();
    const url=new URL(request.url);
    if(url.pathname==='/api/sales' || url.pathname==='/api/competition'){
      const upstream=new URL(url.pathname==='/api/sales'?'/dashboard/sales':'/dashboard/competition',API_ORIGIN);
      for(const [k,v] of url.searchParams) upstream.searchParams.append(k,v);
      const response=await fetch(upstream,{headers:{Authorization:request.headers.get('Authorization')||''}});
      return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')||'application/json','Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'}});
    }
    const response=await env.ASSETS.fetch(request);
    const headers=new Headers(response.headers);
    headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
    headers.set('Cache-Control','private, no-store');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};
