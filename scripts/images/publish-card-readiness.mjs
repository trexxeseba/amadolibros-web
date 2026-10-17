import { createHash, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { signedS3Request } from './r2-card-stage.mjs';

export const READINESS_SHA = 'fdc59f13a42150ac77cd6cb5c700bc0b963eed3efc48259891ef77f32a49adcf';
export const READINESS_BUCKET = 'amadolibros-images-production';
export const READINESS_KEY = `covers/card-readiness/v1/${READINESS_SHA}.json`;
const BYTES = 530591;
const digest = data => createHash('sha256').update(data).digest('hex');

export function decodeReadiness(envelope, summary, token) {
  if (envelope.schema !== 'encrypted-card-readiness-v1' || summary.commit !== '76ea0e85ab166a78f63bb9de1a3331fb23106fb6' ||
      summary.bucket !== READINESS_BUCKET || summary.readiness_sha256 !== READINESS_SHA || summary.readiness_bytes !== BYTES ||
      summary.evidence_run !== 39037088403 || summary.resolver_matched !== 2790 || summary.unique_variants !== 8364 ||
      summary.canary_ready_cards !== 2787 || summary.remotely_verified !== true || summary.production_writes !== 0)
    throw new Error('readiness-artifact-not-approved');
  const key = createHash('sha256').update('amado-card-journal-v1\0'+token).digest();
  const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]);
  validateReadiness(bytes);
  return bytes;
}

export function validateReadiness(bytes) {
  if (bytes.length !== BYTES || digest(bytes) !== READINESS_SHA) throw new Error('readiness-byte-mismatch');
  const index = JSON.parse(bytes);
  if (index.schema !== 'verified-card-readiness-v1' || index.bucket !== READINESS_BUCKET ||
      JSON.stringify(index.recipes) !== JSON.stringify(['v1-240-q85','v1-360-q85','v1-480-q85']) ||
      Object.keys(index.cards || {}).length !== 2790) throw new Error('readiness-content-mismatch');
}

export async function publishReadiness({bytes, s3, approval}) {
  if (approval !== READINESS_SHA) throw new Error('readiness-write-not-approved');
  validateReadiness(bytes);
  let gets = 0, puts = 0, created = false;
  async function inspect(response) {
    if (response.status !== 200 || response.headers.get('content-type') !== 'application/json' ||
        response.headers.get('x-amz-meta-sha256') !== READINESS_SHA ||
        response.headers.get('x-amz-meta-schema') !== 'verified-card-readiness-v1')
      throw new Error('stored-readiness-response-mismatch');
    if (Number(response.headers.get('content-length')) !== BYTES) throw new Error('stored-readiness-size-mismatch');
    const chunks=[];let size=0;
    for await (const chunk of response.body) {
      size+=chunk.length;if(size>BYTES)throw new Error('stored-readiness-too-large');chunks.push(chunk);
    }
    validateReadiness(Buffer.concat(chunks));
  }
  const existing = await s3('GET',READINESS_KEY); gets++;
  if (existing.status === 200) await inspect(existing);
  else {
    if (existing.status !== 404) throw new Error('readiness-read-http-'+existing.status);
    await existing.body?.cancel();
    puts++;
    const response = await s3('PUT',READINESS_KEY,bytes,{
      'if-none-match':'*', 'content-type':'application/json',
      'cache-control':'public, max-age=31536000, immutable',
      'x-amz-meta-sha256':READINESS_SHA, 'x-amz-meta-schema':'verified-card-readiness-v1',
      'x-amz-meta-evidence_run':'39037088403', 'x-amz-meta-preparation_run':'39045624433',
    });
    if (![200,201,204,412].includes(response.status)) throw new Error('readiness-put-http-'+response.status);
    created = response.status !== 412;
    await response.body?.cancel();
    const stored = await s3('GET',READINESS_KEY); gets++;await inspect(stored);
  }
  return {schema:'card-readiness-publication-v1',bucket:READINESS_BUCKET,key:READINESS_KEY,
    sha256:READINESS_SHA,bytes:BYTES,created,verified:true,GET:gets,PUT:puts,
    image_writes:0,web_read_activated:false,production_deployments:0};
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('existing-secrets-unavailable');
  const dir=process.env.CARD_READINESS_ARTIFACT;
  const envelope=JSON.parse(await readFile(dir+'/card-readiness.encrypted.json','utf8'));
  const summary=JSON.parse(await readFile(dir+'/card-readiness-summary.json','utf8'));
  const bytes=decodeReadiness(envelope,summary,token);
  if (process.env.CARD_READINESS_WRITE_APPROVAL !== READINESS_SHA) throw new Error('readiness-write-not-approved');
  // Existing token ID is needed solely to authenticate S3, not to investigate policy.
  const verification=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`,{
    headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(verification.status!==200)throw new Error('existing-token-authentication-http-'+verification.status);
  const accessKey=(await verification.json()).result?.id, secretKey=digest(token);
  let putCount=0;
  const s3=async(method,key,body,headers)=>{
    if (key!==READINESS_KEY || !['GET','PUT'].includes(method) || method==='PUT' &&
        (++putCount>1 || headers?.['if-none-match']!=='*' || digest(body)!==READINESS_SHA))
      throw new Error('publication-transport-out-of-scope');
    const signed=signedS3Request({account,accessKey,secretKey,bucket:READINESS_BUCKET,key,method,body,headers});
    return fetch(signed.url,signed.options);
  };
  const result=await publishReadiness({bytes,s3,approval:process.env.CARD_READINESS_WRITE_APPROVAL});
  console.log(JSON.stringify(result));
  await writeFile(process.env.CARD_READINESS_PUBLICATION_REPORT,JSON.stringify(result));
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(result,null,2)+'\n```\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error('Readiness publication stopped: '+error.message);process.exitCode=1;});
}
