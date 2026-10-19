import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {summarizeRequestRows} from './telemetry.mjs';

export async function readRequestSummary(directory){
 const text=await fs.readFile(path.join(directory,'request-counts.jsonl'),'utf8');
 return summarizeRequestRows(text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const i=process.argv.indexOf('--directory');
 if(i<0||!process.argv[i+1])throw new Error('usage: node scripts/vintage-local/metrics.mjs --directory <publisher state folder>');
 console.log(JSON.stringify(await readRequestSummary(process.argv[i+1]),null,2));
}
