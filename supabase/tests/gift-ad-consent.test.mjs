import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
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
  const browser={MessageChannel:class { constructor() { this.port2={}; this.port1={ postMessage:data=>posted.push({data}), close(){} }; } },URLSearchParams,localStorage,sessionStorage:localStorage,location:new URL(path,origin),window:w,document,navigator:{},setTimeout,clearTimeout};
  const fixture=enabled ? script.replace(/const pixelId = '\d*';/,"const pixelId = '123456789012345';") :
    script.replace(/const pixelId = '\d*';/,"const pixelId = '';"); // no real Pixel IDs ever used in a test
  vm.runInNewContext(fixture,browser);
  async function ack(frame) {
    frame.onload();
    emit('message',{origin,source:frame.contentWindow,data:{type:'rich-gift-ad-v1',ready:true}});
    const sent=posted.findLast(m=>m.data.seq);
    emit('message',{origin,source:frame.contentWindow,data:{type:'rich-gift-ad-v1',seq:sent.data.seq,ok:true}});
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
  f.onload();p.emit('message',{origin,source:f.contentWindow,data:{type:'rich-gift-ad-v1',ready:true}});
  assert.equal(JSON.stringify(p.posted.at(-1).data),JSON.stringify({type:'rich-gift-ad-v1',seq:1,name:'ViewContent'}));
  assert.equal(p.posted[0].to,origin);
  p.choose('decline');assert.equal(f.removed,true);
  const repeat=makePage('/rich-gift.html',{store:p.store});assert.equal(repeat.frames.length,0);
});

test('a slow SDK counts one consenting product view, never after withdrawal or leaving the page', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const page = makePage('/rich-gift.html', {choice:'allow'});
  const revoked = makePage('/rich-gift.html', {choice:'allow'});
  const left = makePage('/rich-gift.html', {choice:'allow'});
  const ready = (p, frame) => p.emit('message', {
    origin, source:frame.contentWindow, data:{type:'rich-gift-ad-v1',ready:true}
  });
  const views = p => p.posted.filter(m => m.data.name === 'ViewContent').length;
  for (const p of [page, revoked, left]) p.frames[0].onload();
  revoked.choose('decline');
  left.emit('pagehide', {persisted:true});
  t.mock.timers.tick(60000);
  for (const p of [page, revoked, left]) ready(p, p.frames[0]);
  assert.deepEqual([views(page), views(revoked), views(left)], [1,0,0]);

  left.emit('pageshow', {persisted:true});
  ready(left, left.frames[0]); // The removed iframe's messages are always stale.
  assert.equal(views(left), 0);
  left.frames[1].onload();
  ready(left, left.frames[1]);
  ready(left, left.frames[1]);
  assert.equal(views(left), 1);

  page.emit('pagehide', {persisted:true});
  page.emit('pageshow', {persisted:true});
  assert.equal(page.frames.length, 1);
  assert.equal(views(page), 1);
});

test('no checkout before consent; eligible session creation is awaited and the signal stops at timeout',async()=>{
  const p=makePage('/gift.html?tier=rich-gift');
  assert.equal(await p.w.richGiftAds.checkoutStarted(),false);
  p.choose('allow');const sent=p.w.richGiftAds.checkoutStarted();const f=p.frames.at(-1);
  await p.ack(f);assert.equal(await sent,true);assert.equal(p.posted.at(-1).data.name,'InitiateCheckout');
  assert.equal(await p.w.richGiftAds.checkoutStarted(),false);
  const blocked=makePage('/gift.html',{choice:'allow'});
  assert.equal(await blocked.w.richGiftAds.checkoutStarted(),false);assert.equal(blocked.posted.some(m=>m.data.name),false);
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
  assert.equal(JSON.stringify(p.posted.at(-1).data),JSON.stringify({type:'rich-gift-ad-v1',seq:1,name:'Purchase',value:24.5,currency:'EUR',eventId:example}));
  assert.equal(await p.w.richGiftAds.purchase(input),false);
  const resumed=makePage(receipt,{store:p.store});
  assert.equal(await resumed.w.richGiftAds.purchase(input),false);
  p.choose('decline');assert.equal(p.w.richGiftAds.canMeasurePurchase(),false);
});

test('relay requires correct origin and window, strips private fields and confines vendor to an opaque sandbox',()=>{
  const p=makePage('/gift-ad-frame.html',{choice:'allow',bridge:true});
  const request={type:'rich-gift-ad-v1',action:'prepare'};
  for(const [addr,source] of [['https://other.invalid',p.w.parent],[origin,{}]]) {
    p.emit('message',{origin:addr,source,data:request});
  }
  assert.equal(p.frames.length,0);
  p.emit('message',{origin,source:p.w.parent,data:request});
  const sandbox=p.frames[0];assert.equal(sandbox.sandbox,'allow-scripts');assert.equal(sandbox.src,'/gift-ad-runtime.html');assert.equal(sandbox.referrerPolicy,'no-referrer');
  sandbox.onload();
  const data={type:'rich-gift-ad-v1',seq:1,name:'Purchase',currency:'EUR',value:49,eventId:example,order:'private',utm_content:'secret'};
  p.emit('message',{origin,source:p.w.parent,data});
  assert.deepEqual(JSON.parse(JSON.stringify(p.posted.at(-1).data)),{name:'Purchase',seq:1,value:49,currency:'EUR',eventId:example});
  for (const [path,choice] of [['/gift-ad-frame.html','decline'],['/gift-ad-frame.html?order=secret','allow']]) {
    const denied=makePage(path,{choice,bridge:true});denied.emit('message',{origin,source:denied.w.parent,data:request});assert.equal(denied.frames.length,0);
  }
});

test('opaque runtime loads the official SDK only via the clean relay and never configures advanced matching',()=>{
  const html=readFileSync(new URL('../../gift-ad-runtime.html',import.meta.url),'utf8');
  const source=html.match(/<script>([\s\S]+?)<\/script>/)[1];
  assert.ok(html.includes("'sha256-" + createHash('sha256').update(source).digest('base64') + "'"));
  function run({opaque=true, referrer=''}={}) {
    const messages=[],scripts=[],ls={};const w={parent:{},origin:opaque?'null':origin,addEventListener:(k,f)=>ls[k]=f,removeEventListener:k=>delete ls[k]};
    const d={referrer,createElement:()=>({}),head:{append:s=>scripts.push(s)}};
    const loc=new URL(origin+'/gift-ad-runtime.html');
    vm.runInNewContext(source,{window:w,document:d,location:loc,URL,URLSearchParams});
    const port={postMessage:d=>messages.push(d)};
    const connect={source:w.parent,origin,data:'rich-gift-ad-connect',ports:[port]};
    return {w,ls,scripts,port,messages,connect};
  }
  for(const opts of [{opaque:false},{referrer:origin+'/gift.html?order=SECRET'}]) assert.equal(run(opts).ls.message,undefined);
  const p=run();
  p.ls.message({...p.connect,origin:'https://other.invalid'});assert.equal(p.port.onmessage,undefined);
  p.ls.message(p.connect);p.port.onmessage({data:{pixelId:'123456789012345'}});
  assert.equal(p.scripts.length,1);assert.equal(p.scripts[0].src,'https://connect.facebook.net/en_US/fbevents.js');
  const queued=p.w.fbq.queue.map(a=>Array.from(a));assert.equal(JSON.stringify(queued),JSON.stringify([['set','autoConfig',false,'123456789012345'],['init','123456789012345']]));
  const calls=[];p.w.fbq.callMethod=(...args)=>calls.push(args);p.scripts[0].onload();
  assert.equal(p.messages[0].ready,true);
  p.port.onmessage({data:{seq:1,name:'Purchase',currency:'EUR',value:24.5,eventId:example,recipient:'secret'}});
  assert.equal(JSON.stringify(calls[0]),JSON.stringify(['trackSingle','123456789012345','Purchase',{content_ids:['rich-gift'],content_type:'product',value:24.5,currency:'EUR'},{eventID:example}]));
});

test('only a valid ad click ID can enter the isolated ad runtime after consent and is cleared on withdrawal', () => {
  const id='IwRlZW1example0123456789';
  const p=makePage('/rich-gift.html?fbclid='+id+'&utm_campaign=secret');
  assert.equal(p.frames.length,0);assert.equal(p.store.has('rich-gift-ad-click-v1'),false);
  p.choose('allow');p.frames[0].onload();
  assert.deepEqual(JSON.parse(JSON.stringify(p.posted[0].data)),{type:'rich-gift-ad-v1',action:'prepare',clickId:id});
  const relay=makePage('/gift-ad-frame.html',{choice:'allow',bridge:true});
  relay.emit('message',{origin,source:relay.w.parent,data:{...p.posted[0].data,order:'secret'}});
  assert.equal(relay.frames[0].src,'/gift-ad-runtime.html?fbclid='+id);
  p.choose('decline');assert.equal(p.store.has('rich-gift-ad-click-v1'),false);
  const bad=makePage('/rich-gift.html?fbclid=someone%40example.org',{choice:'allow'});bad.frames[0].onload();assert.equal(bad.posted[0].data.clickId,undefined);
  bad.choose('decline');
});
