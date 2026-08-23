import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const source=readFileSync(path.join(ROOT,'scripts','seo','search-quality-benchmark.mjs'),'utf8');

test('benchmark cubre Tarot, Biblias, typo, acentos, abreviatura e ISBN',()=>{
  for (const expected of ['tarot','rider wait','oráculo','reina valera 1960','rvr 1960','biblia católica','9781602552951']) {
    assert.match(source,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));
  }
  for (const intent of ['typo','accent','abbreviation','isbn','word_order','attribute']) assert.match(source,new RegExp(`intent: '${intent}'`));
});

test('benchmark es read-only contra /catalogo y no llama APIs de escritura',()=>{
  assert.match(source,/\/catalogo\?q=/);
  assert.doesNotMatch(source,/method:\s*['"]POST['"]/);
  assert.doesNotMatch(source,/\/api\/orders|\/api\/preferences|DELETE|PUT|PATCH/);
});

test('benchmark reporta no-result rate y top5',()=>{
  assert.match(source,/no_result_rate/);
  assert.match(source,/top5/);
});
