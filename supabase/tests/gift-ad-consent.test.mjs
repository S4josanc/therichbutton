import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script = readFileSync(new URL('../../gift-ad-measure.js', import.meta.url), 'utf8');
const dataKey = 'rich-gift-ad-choice-v1';
const origin = 'https://therichbutton.com';
const example = 'e8d7e4cc-977f-4f90-88a3-27cae7945ac6';
const receipt = '/gift.html?order=secret-token&session_id=cs_live_secret-session';

function makePage(path, {enabled=true, choice, store=new Map(), bridge=false, hasBody=true}={}) {
  const listeners = new Map();
  const w = {};
  const posted = [];
  const nodes = [];
  const frames = [];
  const localStorage = {getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  if (choice) localStorage.setItem(dataKey, JSON.stringify({choice,until:Date.now()+100000}));
  function element(tag) {
    const events = new Map();
    const node = {tag, dataset:{}, hidden:false, children:[], style:{}, className:'',
      setAttribute(k,v) { this[k]=v; },
      addEventListener(k,fn) { events.set(k,fn); },
      dispatch(k) { events.get(k)?.(); },
      click() { this.dispatch('click'); },
      focus() {},
      after(...others) { nodes.push(...others); },
      remove() { this.removed=true; },
      append(...others) { this.children.push(...others); },
      prepend(el){this.children.unshift(el);},
      querySelectorAll() {return this.buttons??[];},
      querySelector(){return this.buttons?.[0];}
    };
    if (tag === 'aside') {
      node.buttons=['decline','allow'].map(choice=>{const el=element('button');el.dataset.choice=choice;return el;});
    }
    if(tag==='iframe') {
      node.contentWindow={postMessage(data,to){posted.push({data,to});}};
      frames.push(node);
    }
    nodes.push(node);
    return node;
  }
  const head = element('head'), body = element('body'), header=element('header'), footer=element('footer'), tier=element('select');
  tier.value='rich-gift';
  const document = {readyState:hasBody?'complete':'loading',head,body:hasBody?body:null,
    createElement:element, querySelector:s=>s==='header'?header:s==='footer'?footer:null,
    getElementById:id=>id==='tier'?tier:null, addEventListener(){}};
  w.top=w;
  w.parent=bridge?{postMessage:(data,to)=>posted.push({data,to})}:w;
  w.addEventListener=(k,fn)=>{const a=listeners.get(k)??new Set();a.add(fn);listeners.set(k,a);};
  w.removeEventListener=(k,fn)=>listeners.get(k)?.delete(fn);
  const emit=(k,e)=>[...(listeners.get(k)??[])].forEach(fn=>fn(e));
  const browser={URLSearchParams,localStorage,location:new URL(path,origin),window:w,document,navigator:{},setTimeout,clearTimeout};
  const fixture=enabled ? script.replace(/const pixelId = '\d*';/,"const pixelId = '123456789012345';") :
    script.replace(/const pixelId = '\d*';/,"const pixelId = '';"); // no real Pixel IDs ever used in a test
  vm.runInNewContext(fixture,browser);
  async function ack(frame) {
    frame.onload();
    emit('message',{origin,source:frame.contentWindow,data:{type:'rich-gift-ad-v1',complete:true}});
    await Promise.resolve();
  }
  return {w,body,store,posted,nodes,frames,tier,emit,ack,document,
    choose(choice) {nodes.find(n=>n.tag==='aside').buttons.find(b=>b.dataset.choice===choice).click();},
    img:()=>nodes.filter(n=>n.tag==='img')};
}

test('no ID, private preview, gift recipient, test order, other tier and checkout return are excluded',()=>{
  const disabled=makePage('/rich-gift.html',{enabled:false});
  assert.equal(disabled.w.richGiftAds,undefined); assert.equal(disabled.nodes.some(n=>n.tag==='aside'),false);
  for(const path of ['/gift.html?gift=personal','/gift.html?e=r&n=person','/gift.html#gift=private',
      '/gift.html?stripe_test=1','/gift.html?test_order=xxx&session_id=cs_test_abc',
      '/gift.html?order=secret','/gift.html?tier=gold','/rich-gift.html?session_id=secret','/index.html','/open-gift.html']) {
    const page=makePage(path,{choice:'allow'}); assert.equal(page.w.richGiftAds,undefined,path); assert.equal(page.frames.length,0,path);
  }
});

test('no network on undecided or refused, grant emits only ViewContent and revoke cancels the frame',()=>{
  const p=makePage('/rich-gift.html?utm_campaign=SECRET&fbclid=SECRET');
  assert.equal(p.frames.length,0);p.choose('decline');assert.equal(p.frames.length,0);
  p.choose('allow');assert.equal(p.frames.length,1);
  const f=p.frames[0];assert.equal(f.src,'/gift-ad-frame.html');assert.equal(f.referrerPolicy,'no-referrer');
  f.onload();assert.equal(JSON.stringify(p.posted[0].data),JSON.stringify({type:'rich-gift-ad-v1',name:'ViewContent'}));
  assert.equal(p.posted[0].to,origin);
  p.choose('decline');assert.equal(f.removed,true);
  const repeat=makePage('/rich-gift.html',{store:p.store});assert.equal(repeat.frames.length,0);
});

test('no checkout before consent; eligible session creation is awaited and the signal stops at timeout',async()=>{
  const p=makePage('/gift.html?tier=rich-gift');
  assert.equal(await p.w.richGiftAds.checkoutStarted(),false);
  p.choose('allow');const sent=p.w.richGiftAds.checkoutStarted();const f=p.frames.at(-1);
  await p.ack(f);assert.equal(await sent,true);assert.equal(p.posted[0].data.name,'InitiateCheckout');
  assert.equal(await p.w.richGiftAds.checkoutStarted(),false);
  const blocked=makePage('/gift.html',{choice:'allow'});
  assert.equal(await blocked.w.richGiftAds.checkoutStarted(),false);assert.equal(blocked.frames[0].removed,true);
});

test('receipt requires existing consent, trusted scope and a live server-issued opaque event; duplicates collapse',async()=>{
  const no=makePage(receipt);assert.equal(no.w.richGiftAds.canMeasurePurchase(),false);
  const p=makePage(receipt,{choice:'allow'});
  assert.equal(p.w.richGiftAds.canMeasurePurchase(),true);assert.equal(p.frames.length,0);
  const input={eventId:example,currency:'EUR',value:24.5,recipient:'MY SECRET',order:'PRIVATE'};
  for(const invalid of [{...input,eventId:'cs_live_x'},{...input,currency:'USD'},{...input,value:-49}]) {
    assert.equal(await p.w.richGiftAds.purchase(invalid),false);
  }
  const sent=p.w.richGiftAds.purchase(input);assert.equal(await p.w.richGiftAds.purchase(input),false);
  await p.ack(p.frames[0]);assert.equal(await sent,true);
  assert.equal(JSON.stringify(p.posted[0].data),JSON.stringify({type:'rich-gift-ad-v1',name:'Purchase',value:24.5,currency:'EUR',eventId:example}));
  assert.equal(await p.w.richGiftAds.purchase(input),false);
  const resumed=makePage(receipt,{store:p.store});
  assert.equal(await resumed.w.richGiftAds.purchase(input),false);
  p.choose('decline');assert.equal(p.w.richGiftAds.canMeasurePurchase(),false);
});

test('clean frame accepts only its parent on the same origin; image sends only allowlisted fields and no referrer',()=>{
  const p=makePage('/gift-ad-frame.html',{choice:'allow',bridge:true});
  const data={type:'rich-gift-ad-v1',name:'Purchase',currency:'EUR',value:49,eventId:example,order:'private',utm_content:'x',nameOfPerson:'SENSITIVE'};
  assert.equal(p.img().length,0);
  for (const [eventOrigin,source,name] of [['https://other.example',p.w.parent,'Purchase'],[origin,{},'Purchase'],[origin,p.w.parent,'Bad']]) {
    p.emit('message',{origin:eventOrigin,source,data:{...data,name}});
  }
  assert.equal(p.img().length,0);
  p.emit('message',{origin,source:p.w.parent,data});
  const image=p.img()[0], url=new URL(image.src);
  assert.equal(url.origin,'https://www.facebook.com');assert.equal(url.pathname,'/tr');assert.equal(image.referrerPolicy,'no-referrer');
  assert.deepEqual([...url.searchParams.keys()],['id','ev','cd[value]','cd[currency]','eid']);
  assert.equal(url.searchParams.get('cd[value]'),'49.00');assert.equal(url.searchParams.get('eid'),example);
  p.emit('message',{origin,source:p.w.parent,data});assert.equal(p.img().length,1);
  for(const options of [{choice:'decline',bridge:true}, {choice:'allow',bridge:false}]) {
    const dis=makePage('/gift-ad-frame.html',options);dis.emit('message',{origin,source:dis.w.parent,data});assert.equal(dis.img().length,0);
  }
  const dirty=makePage('/gift-ad-frame.html?private=x',{choice:'allow',bridge:true});
  dirty.emit('message',{origin,source:dirty.w.parent,data});assert.equal(dirty.img().length,0);
});
