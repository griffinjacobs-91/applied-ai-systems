/* Systems Go assessment engine: grading and the jump-ahead test rules (FORMAT.md section 7b, drafts/gates/README.md).
   Pure functions, no DOM, so the page and test/assess.test.js share them. Every check is deterministic, because the free
   tier has no Pip: the build (_build/plugins.py) ships hashes of the right answers, never the answers themselves.
   Item types: choice, short, code, fix, spot, match, order, evidence. */
var SGAssess=(function(){
'use strict';
/* normalisation and hash, mirrored in _build/plugins.py (gate_norm, gate_code, gate_hash) */
function norm(s){return String(s==null?'':s).normalize('NFKC').toLowerCase().replace(/[‘’“”"'`]/g,'').replace(/\s+/g,' ').trim().replace(/[.!?,;:]+$/,'').replace(/^(the|a|an) /,'');}
/* code: quotes made straight and single, every space dropped, one trailing semicolon dropped; case kept */
function code(s){return String(s==null?'':s).normalize('NFKC').replace(/[‘’“”"`]/g,"'").replace(/\s+/g,'').replace(/;+$/,'');}
function fnv(s){const b=new TextEncoder().encode(s);let h=0x811c9dc5;for(let i=0;i<b.length;i++){h^=b[i];h=Math.imul(h,0x01000193)>>>0;}return ('0000000'+h.toString(16)).slice(-8);}
const hashOf=(id,v)=>fnv(id+'|'+v);
/* a written line passes if it matches an accepted form, or the item's pattern (both after code()) */
function codeOk(q,t){const n=code(t);if(!n)return false;if((q.h||[]).includes(hashOf(q.id,n)))return true;if(q.rx){try{return new RegExp(q.rx,q.rf||'').test(n);}catch(e){}}return false;}
const ints=a=>Array.isArray(a)?a.map(Number):[];
/* q is a built item (see plugins.gate_item). given depends on the type:
   choice: option index; short, code, evidence: text; fix: {line, text}; spot: [line indices]; match: [right index per left];
   order: [indices of the shown steps, in the learner's order] */
function check(q,given){
  switch(q.kind){
    case 'choice':return hashOf(q.id,String(given))===q.a;
    case 'short':{const n=norm(given);if(!n)return false;if(q.h.includes(hashOf(q.id,n)))return true;if(q.rx){try{return new RegExp(q.rx).test(n);}catch(e){}}return false;}
    case 'code':return codeOk(q,given);
    case 'fix':return !!given&&typeof given==='object'&&hashOf(q.id,String(given.line))===q.ln&&codeOk(q,given.text);
    case 'spot':{const s=ints(given).slice().sort((a,b)=>a-b);return s.length>0&&hashOf(q.id,s.join(','))===q.s;}
    case 'match':{const m=ints(given);return m.length===q.L.length&&m.every(x=>x>=0)&&hashOf(q.id,m.join(','))===q.m;}
    case 'order':{const o=ints(given);return o.length===q.S.length&&new Set(o).size===o.length&&hashOf(q.id,o.join(','))===q.k;}
    case 'evidence':{const t=String(given==null?'':given).trim();if(!t)return false;try{return new RegExp(q.re,q.flags||'').test(t);}catch(e){return false;}}
  }
  return false;}
/* the right answer of a built item, in the shape check() takes, found by trying the small answer space (shown after a try) */
function perms(n){const out=[],a=[...Array(n).keys()];const go=k=>{if(k===n){out.push(a.slice());return;}for(let i=k;i<n;i++){[a[k],a[i]]=[a[i],a[k]];go(k+1);[a[k],a[i]]=[a[i],a[k]];}};go(0);return out;}
function solve(q){
  switch(q.kind){
    case 'choice':return q.o.findIndex((_,i)=>check(q,i));
    case 'short':case 'code':return q.show;
    case 'fix':{const n=q.snip.lines.length;for(let i=0;i<n;i++)if(hashOf(q.id,String(i))===q.ln)return {line:i,text:q.show};return null;}
    case 'spot':{const n=q.snip.lines.length;for(let m=1;m<(1<<n);m++){const s=[];for(let i=0;i<n;i++)if(m&(1<<i))s.push(i);if(check(q,s))return s;}return null;}
    case 'match':return perms(q.R.length).find(p=>check(q,p.slice(0,q.L.length)))||null;
    case 'order':return perms(q.S.length).find(p=>check(q,p))||null;
  }
  return null;}
/* ---- the jump-ahead test ---- */
function need(n,pct){return Math.ceil(n*(pct||90)/100-1e-9);}
function rule(cfg,bank){cfg=cfg||{};const draw=Math.max(1,+cfg.draw||25),n=bank?Math.min(draw,bank.slots.reduce((a,s)=>a+s.q.length,0)):draw;return {draw:n,need:need(n,cfg.pass_pct),pct:+cfg.pass_pct||90,choiceMax:Math.floor(n*0.15)};}
/* Question ids in slot order. Every slot is asked at least once, two "evidence" items about the learner's own app come first,
   and multiple choice is held to 15% of the draw where the bank allows. seen: ids from earlier tries, asked last. */
function draw(bank,cfg,seen,rand){
  rand=rand||Math.random;seen=seen||[];const r=rule(cfg,bank),n=r.draw,pick=new Set(),count=bank.slots.map(()=>0);let choices=0;
  const shuffle=a=>{const x=a.slice();for(let i=x.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;};
  const rank=q=>(seen.includes(q.id)?2:0)+(q.kind==='choice'&&choices>=r.choiceMax?1:0);
  const order=a=>shuffle(a).sort((p,q)=>rank(p)-rank(q));
  const take=(si,q)=>{pick.add(q.id);count[si]++;if(q.kind==='choice')choices++;};
  const ev=order(bank.slots.flatMap((s,si)=>s.q.filter(q=>q.kind==='evidence').map(q=>Object.assign({si},q))));
  for(const e of ev){if(pick.size>=2)break;if(count[e.si]&&ev.some(o=>!count[o.si]&&!pick.has(o.id)))continue;take(e.si,e);}
  bank.slots.forEach((s,si)=>{if(count[si]||pick.size>=n)return;const f=order(s.q)[0];if(f)take(si,f);});
  while(pick.size<n){const left=bank.slots.map((s,si)=>({si,q:order(s.q.filter(q=>!pick.has(q.id)))})).filter(x=>x.q.length);if(!left.length)break;
    const low=Math.min(...left.map(x=>count[x.si])),c=left.filter(x=>count[x.si]===low);
    const best=Math.min(...c.map(x=>rank(x.q[0]))),cc=c.filter(x=>rank(x.q[0])===best),x=cc[Math.floor(rand()*cc.length)];take(x.si,x.q[0]);}
  return bank.slots.flatMap(s=>s.q.filter(q=>pick.has(q.id)).map(q=>q.id));}
/* answers: {qid: true|false}. Every section of a slot with any miss must be taken; the rest are tested out. */
function score(bank,cfg,qids,answers){
  const r=rule(cfg,bank),n=qids.length,right=qids.filter(id=>answers[id]===true).length,needN=need(n,r.pct);
  const take=[],tested=[],missed=[];
  bank.slots.forEach(s=>{const asked=s.q.filter(q=>qids.includes(q.id));if(!asked.length)return;
    const miss=asked.filter(q=>answers[q.id]!==true);
    if(miss.length){missed.push(...miss.map(q=>q.id));s.take.forEach(id=>{if(!take.includes(id))take.push(id);});}
    else s.take.forEach(id=>{if(!tested.includes(id))tested.push(id);});});
  return {n,right,need:needN,pass:n>0&&right>=needN,take,tested:tested.filter(id=>!take.includes(id)),missed};}
/* ---- the schedule (LEVELS.json "assessment") ---- */
/* time limit: the sum of item_seconds over the drawn item kinds, times the level's factor, rounded up to whole minutes */
function timeLimitMs(sch,kinds,level){const sec=(sch&&sch.item_seconds)||{},f=((sch&&sch.level_time_factor)||[])[Math.min(7,Math.max(1,level||1))-1]||1;return Math.ceil(kinds.reduce((a,k)=>a+(sec[k]||60),0)*f/60)*60000;}
/* cooldown after the fails-th failure in a row: the level's minutes, times backoff for each further failure, up to backoff_cap */
function cooldownMs(sch,kind,level,fails){const c=(sch&&sch[kind])||{},m=((c.cooldown_minutes||[])[Math.min(7,Math.max(1,level||1))-1])||10;return m*60000*Math.min(Math.pow(+c.backoff||1,Math.max(0,(fails||1)-1)),+c.backoff_cap||1);}
/* ---- the sticky ledger (game.js keeps it in localStorage and IndexedDB) ----
   One entry per assessment: f failures in a row, u cooldown end, t tries, x closed, p when it was passed (and l, the sections
   a passed jump-ahead test still sends you to); c the latest clock seen.
   While a run is open the entry also carries o, what a failure would set ({f, u, x}). A state that never saw that try
   (an in-app reset mid-run, a wiped store) takes the failure. Merging only moves a record towards "more tried, longer
   locked", or passed, so a pass survives a reset, and a wiped game state gets the ledger's values back and a stale store never shortens a lock. */
function ledgerOf(g){const out={c:(g&&g.clockSeen)||0,k:{}};Object.entries((g&&g.assess)||{}).forEach(([k,r])=>{if(!r||typeof r!=='object'||!(r.tries||r.fails||r.closed||r.passed))return;
  const e={f:r.fails||0,u:r.until||0,t:r.tries||0,x:r.closed?1:0,p:r.passed?(+r.passed||1):0};if(r.passed&&r.last&&Array.isArray(r.last.take))e.l=r.last.take;if(r.run&&r.run.ifFail)e.o=r.run.ifFail;out.k[k]=e;});return out;}
function ledgerMerge(g,L){if(!g||!L||typeof L!=='object'||!L.k||typeof L.k!=='object')return false;g.assess=g.assess||{};let ch=false;if((+L.c||0)>(g.clockSeen||0)){g.clockSeen=+L.c;ch=true;}
  Object.entries(L.k).forEach(([k,v])=>{if(!v||typeof v!=='object')return;let r=g.assess[k];if(!r||typeof r!=='object')r=g.assess[k]={tries:0,fails:0,until:0,seen:[]};
    if(r.passed&&!v.p)return;const lost=!!(v.o&&typeof v.o==='object'&&!r.run&&(r.tries||0)<(+v.t||0));
    if((+v.t||0)>(r.tries||0)){r.tries=+v.t;ch=true;}if(r.passed)return;
    if(v.p){r.passed=+v.p;r.fails=0;r.until=0;r.closed=false;r.review=null;delete r.run;if(Array.isArray(v.l))r.last=Object.assign({},r.last,{take:v.l.filter(x=>typeof x==='string')});ch=true;return;}
    const f=Math.max(+v.f||0,lost?+v.o.f||0:0),u=Math.max(+v.u||0,lost?+v.o.u||0:0),x=v.x||(lost&&v.o.x);
    if(f>(r.fails||0)){r.fails=f;ch=true;}if(u>(r.until||0)){r.until=u;ch=true;}if(x&&!r.closed){r.closed=true;ch=true;}});return ch;}
/* study tips after a miss: one per distinct tip, in the order missed, each section's link shown once (a check's items share a section) */
/* a level final: n ids, questions not seen on earlier tries first, multiple choice held to 15% of the draw as on the jump-ahead test */
function pickFinal(items,n,seen,rand){rand=rand||Math.random;seen=seen||[];const cap=Math.floor(n*0.15),out=[];let ch=0;
  const sh=a=>{const x=a.slice();for(let i=x.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;};
  const all=[...sh(items.filter(q=>!seen.includes(q.id))),...sh(items.filter(q=>seen.includes(q.id)))];
  for(const q of all){if(out.length>=n)break;if(q.kind==='choice'){if(ch>=cap)continue;ch++;}out.push(q.id);}
  for(const q of all){if(out.length>=n)break;if(!out.includes(q.id))out.push(q.id);}
  return out;}
function tipList(qs){const tips=new Set(),secs=new Set(),out=[];(qs||[]).forEach(q=>{if(!q||!q.tip||tips.has(q.tip))return;tips.add(q.tip);out.push({tip:q.tip,see:q.see,link:!!q.see&&!secs.has(q.see)});if(q.see)secs.add(q.see);});return out;}
/* hints: never on a counting tier, and never on anything while a counting test's clock runs */
const COUNTING=['check','final','gate'];
function hintOk(sch,kind,active){if(active||COUNTING.includes(kind))return false;return !!(sch&&sch[kind]&&sch[kind].hints);}
function decode(s){try{const bin=atob(s),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return JSON.parse(new TextDecoder().decode(u));}catch(e){return {};}}
return {norm,code,fnv,hashOf,check,solve,need,rule,draw,score,timeLimitMs,cooldownMs,ledgerOf,ledgerMerge,COUNTING,hintOk,tipList,pickFinal,decode};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=SGAssess;
