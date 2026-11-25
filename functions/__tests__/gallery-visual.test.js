import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGalleryVisualPolicy} from '../../shared/gallery-visual-policy.js';
import {NON_BOOK_VISUAL_REFERENCES} from '../../shared/gallery-visual-references.js';
import {excludeNonBookImages} from '../../shared/gallery-visual-filter.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/gallery-visual.json',import.meta.url),'utf8'));
const policy=createGalleryVisualPolicy(NON_BOOK_VISUAL_REFERENCES);

test('reviewed photos: keep covers/interiors and reject recompressed non-book posters',()=>{
  assert.ok(fixtures.cases.length>=100);
  assert.ok(fixtures.cases.some(c=>!c.bad&&c.variant==='jpeg-96'));
  for(const c of fixtures.cases)assert.equal(Boolean(policy.match(c.fingerprint)),c.bad,c.id+' '+c.variant);
});

test('fingerprints are calculated from decoded compressed pixels',()=>{
  for(const row of fixtures.decoded){
    const expected=fixtures.cases.find(c=>c.id===row.id&&c.variant===row.variant);
    assert.deepEqual(policy.fingerprint(row.pixels,row.aspect),expected.fingerprint);
    assert.equal(Boolean(policy.match(policy.fingerprint(row.pixels,row.aspect))),expected.bad);
  }
});

test('visual policy preserves unknown layouts, blank images and differing proportions/colors',()=>{
  const known=NON_BOOK_VISUAL_REFERENCES[0];
  assert.equal(policy.match(null),null);
  assert.equal(policy.match({...known,contrast:0}),null);
  assert.equal(policy.match({...known,aspect:known.aspect*2}),null);
  assert.equal(policy.match({...known,colors:known.colors.map(v=>255-v)}),null);
  assert.equal(policy.distance('invalid',known.hash),64);
});

test('image errors and unreadable canvas preserve the image; work is bounded to two images',async()=>{
  let active=0,max=0;const excluded=[];
  class Image {
    set src(value){this.value=value;this.naturalWidth=this.naturalHeight=32;active++;max=Math.max(max,active);
      setImmediate(()=>{active--;value==='error'?this.onerror():this.onload();});}
  }
  const dom={Image,setTimeout,clearTimeout,document:{createElement(){return{getContext(){return{
    fillRect(){},drawImage(image){this.value=image.value;},getImageData(){if(this.value==='cors')throw Error('SecurityError');return{data:this.value};}
  };}};}}};
  const fakePolicy={fingerprint:pixels=>pixels,match:value=>value==='poster'?'known':null};
  await excludeNonBookImages(['poster','cover','error','cors','interior'].map(thumb=>({thumb})),fakePolicy,i=>excluded.push(i),dom);
  assert.deepEqual(excluded,[0]);assert.equal(max,2);
});
