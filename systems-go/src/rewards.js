/* Systems Go rewards: the points schedule by unit minutes, coins, sign-in coins, the rig shop, and hints on extra credit.
   Design and the numbers behind it: drafts/game/REWARDS.md. Loads before game.js, which reads ECON for ranks, unit points,
   the streak rule and the daily goals; everything stateful goes through window.SG once game.js has booted.
   Coins are never stored as a balance: earned = floor(points / 10) + sign-in coins, minus what was spent. Spending never
   touches points, so it never lowers a rank. Pure functions are exported for test/rewards.test.js. */
var SGRewards=(function(){
'use strict';
const ECON={
  /* a finished unit pays 2 points per minute of its estimate, more for hands-on kinds, rounded to 5, at least 10 */
  unit:{perMin:2,weight:{lesson:1,reading:1,field:1,lab:1.25,drill:1.25,build:1.5,bridge:1.5},round:5,min:10},
  waypoint:50,
  coinPer:10,
  signin:{daily:5,seventh:15},
  /* [nudge, narrow] in coins, by level 1 to 7; a hinted right answer pays 2 points, so a hint always costs more than it pays */
  hint:[[3,5],[3,5],[4,7],[4,7],[4,7],[5,9],[5,9]],
  /* thresholds sit where a learner with 40% of first tries, no notes, no simulators and no extra credit reaches hours
     3, 11, 20, 30, 40, 50 and the finish (REWARDS.md section 3) */
  ranks:[['Cadet',0],['Pilot',700],['Navigator',2700],['Flight Lead',4800],['Flight Engineer',6950],['Mission Specialist',8950],['Commander',11300],['Flight Director',13500]],
  streak:{mode:'calendar',qualify:10},
  goals:[[50,'A short lesson'],[100,'About half an hour'],[200,'About an hour']]
};
/* rig gear opens at a waypoint (the section that carries it is done), so there is something new about every 3 hours.
   [key, name, coins, opens at: '' the start, a waypoint name, or '*' the whole course done] */
const GEAR=[
 ['mug','Mug',10,''],['stickers','Laptop stickers',15,''],
 ['lamp','Desk lamp',40,'You can see inside any page'],['desk','Real desk',70,'Your machine is ready'],
 ['phones','Headphones',45,'The agent works under your rules'],['chair','Desk chair',55,'Main is guarded'],
 ['board','Whiteboard with your system map',70,'Spec on file'],['mon1','First monitor',60,'First change landed'],
 ['keys','Mechanical keyboard',70,'Fuelled and ready'],['plant','Plant',50,'First rollback'],
 ['ledstrip','LED strip',70,'Own call sign'],['mon2','Second monitor',95,'Every door checks'],
 ['rack','Home server rack',75,'Your own rows'],['standing','Standing desk',85,'Scripts and guesses refused'],
 ['espresso','Espresso machine',90,'A capped bill'],['ultra','Ultrawide screen',100,'First money'],
 ['statuswall','Status wall',95,'Normal, written down'],['porthole','Porthole on orbit',75,'The slow afternoon'],
 ['captain',"Captain's chair",80,'The quiet failure'],['patchwall','Patch wall',90,'Capsule on the pad'],
 ['console','Command console',120,'*']
];
/* ---- pure rules ---- */
function unitPoints(min,kind){const u=ECON.unit,w=u.weight[kind]||1;return Math.max(u.min,u.round*Math.round(u.perMin*(+min||0)*w/u.round));}
function hintPrice(level,which){const row=ECON.hint[Math.min(7,Math.max(1,+level||1))-1];return which==='narrow'?row[1]:row[0];}
function blank(){return {signin:{last:'',run:0,coins:0},spent:0,owned:{},hints:{},credit:{}};}
function rw(g){if(!g.rw||typeof g.rw!=='object')g.rw=blank();const b=blank();for(const k in b)if(g.rw[k]==null||typeof g.rw[k]!==typeof b[k])g.rw[k]=b[k];return g.rw;}
function earned(g){return Math.floor(Math.max(0,+g.pts||0)/ECON.coinPer)+(+rw(g).signin.coins||0);}
function balance(g){return Math.max(0,earned(g)-(+rw(g).spent||0));}
/* the day's sign-in: once per calendar day, 5 coins, 15 on every 7th day in a row */
function signIn(g,day,yesterday){const s=rw(g).signin;if(s.last&&day<=s.last)return 0; /* once a day, and never again for a day already passed when the clock moves back */s.run=s.last===yesterday?(s.run||0)+1:1;s.last=day;const c=s.run%7===0?ECON.signin.seventh:ECON.signin.daily;s.coins=(s.coins||0)+c;return c;}
/* spend: refused unless the coins are already in hand; no loans, no going below zero */
function spend(g,price){if(!(price>0)||balance(g)<price)return false;rw(g).spent=(rw(g).spent||0)+price;return true;}
function buy(g,key,open){const it=GEAR.find(x=>x[0]===key),r=rw(g);if(!it||r.owned[key]||!open)return false;if(!spend(g,it[2]))return false;r.owned[key]=Date.now();return true;}
/* hints are refused on the kinds that count and while a counting clock runs, whatever the caller says */
const COUNTING=['check','final','gate'];
function hintAllowed(tier,testing){return tier==='extra'&&!testing;}
function rankOf(pts){let i=0;ECON.ranks.forEach((r,k)=>{if(pts>=r[1])i=k;});return i;}
/* the streak as it stands now, without changing it: calendar mode keeps it while the last qualifying day is today or
   yesterday (or the day before, when a freeze will cover the gap); rolling mode keeps it for 24 hours after the last one */
function streakNow(s,freezes,mode,day,yesterday,before,nowMs){if(!s||!s.n)return 0;
  if(mode==='rolling')return s.lastAt&&nowMs-s.lastAt<=864e5?s.n:(s.lastAt&&nowMs-s.lastAt<=2*864e5&&freezes>0?s.n:0);
  if(s.last===day||s.last===yesterday)return s.n;if(s.last===before&&freezes>0)return s.n;return 0;}
/* time left before the streak breaks, in minutes; null when today is already banked in calendar mode */
function tickerMins(s,mode,banked,nowDate){if(mode==='rolling'){if(!s||!s.lastAt)return null;return Math.max(0,Math.round((s.lastAt+864e5-nowDate.getTime())/60000));}
  if(banked)return null;const m=new Date(nowDate);m.setHours(24,0,0,0);return Math.max(0,Math.round((m-nowDate)/60000));}
const PURE={ECON,GEAR,unitPoints,hintPrice,blank,rw,earned,balance,signIn,spend,buy,hintAllowed,COUNTING,rankOf,streakNow,tickerMins};
if(typeof document==='undefined')return PURE;

/* ---- page layer ---- */
const D=document,$=(s,r)=>(r||D).querySelector(s),$$=(s,r)=>[...(r||D).querySelectorAll(s)];
const SG=()=>window.SG||null,G=()=>SG()?SG().state():null,save=()=>{const s=SG();if(s)s.save();};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const pad=n=>String(n).padStart(2,'0'),dkey=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const dayOff=n=>{const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+n);return dkey(d);};
const RM=()=>{try{return matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){return false}};
const isDone=id=>{try{return !!(typeof saved!=='undefined'&&saved&&saved.done&&saved.done[id]);}catch(e){return false;}};
const testing=()=>D.documentElement.classList.contains('sg-testing')||(typeof SGAssess!=='undefined'&&typeof SGAssess.active==='function'&&!!SGAssess.active());
function emit(type,detail){try{D.dispatchEvent(new CustomEvent('sg:event',{detail:Object.assign({type,id:typeof cur!=='undefined'?cur:'',ts:Date.now()},detail)}));}catch(e){}}
function secOf(name){const el=$$('[data-waypoint]').find(x=>x.dataset.waypoint===name);const s=el&&el.closest('section.sec');return s?s.id:null;}
function kindOf(id){const s=D.getElementById(id);return (s&&s.dataset.unit)||'lesson';}
function minsOf(id){try{if(typeof META!=='undefined'&&META[id])return +META[id].min||0;}catch(e){}const s=D.getElementById(id);return s?+s.dataset.min||0:0;}
/* points a section pays when it is done; 0 when a passed jump-ahead test already credited it */
function pointsFor(id){const g=G();if(g&&rw(g).credit[id])return 0;return unitPoints(minsOf(id),kindOf(id));}
/* a waypoint pays once, when the section that carries it is done or tested out */
function waypointFor(id){const g=G(),s=D.getElementById(id);if(!s||!$('[data-waypoint]',s)||(g&&rw(g).credit[id]))return 0;return ECON.waypoint;}
function courseDone(){const g=G();return !!(g&&g.patches&&g.patches['full-mission']);}
function gearOpen(it){if(!it[3])return true;if(it[3]==='*')return courseDone();const id=secOf(it[3]);if(!id)return false;const g=G();return isDone(id)||!!(g&&rw(g).credit[id]);}
/* ---- next rank, in hours of lessons still ahead ---- */
function etaMins(toNext){if(!(toNext>0)||typeof IDS==='undefined')return null;let pts=0,min=0;
  for(const id of IDS){if(isDone(id))continue;const s=D.getElementById(id);if(!s||s.closest('[data-capstone]')||/^(Start|Reference)$/.test(s.dataset.part||''))continue;
    const m=minsOf(id);pts+=unitPoints(m,kindOf(id))+($('.guess.checkpoint,[data-assess^="check:"]',s)?14:0)+($('[data-waypoint]',s)?ECON.waypoint:0);min+=m;if(pts>=toNext)return min;}
  return null;}
function etaText(toNext){const m=etaMins(toNext);if(m==null)return '';if(m<60)return 'about '+Math.max(5,5*Math.round(m/5))+' min of lessons';const h=Math.round(m/30)/2;return 'about '+(h%1?h:h.toFixed(0))+' h of lessons';}
/* ---- sign-in and gate credit ---- */
function dailySignIn(){const g=G();if(!g)return;const c=signIn(g,dayOff(0),dayOff(-1));if(c){save();$$('.sg-hintbar').forEach(b=>paintHintBar(b));renderRig();setTimeout(()=>{const s=SG();if(s&&s.fx&&s.renderHeader)s.renderHeader(true);const el=$('#sg-header .sg-coins');if(el&&s&&s.fx)s.fx.chip(el,'+'+c+' coins for showing up',true);},400);}}
/* a passed jump-ahead test credits the unit points of the sections it let you skip (no first-try bonuses), and their
   waypoints count as reached for the rig; doing one of them later pays nothing more for the unit itself */
function creditSkipped(ids){const g=G(),s=SG();if(!g||!s)return;let pts=0;ids.forEach(id=>{const sec=D.getElementById(id);if(!sec||isDone(id)||rw(g).credit[id])return;const p=unitPoints(minsOf(id),kindOf(id))+($('[data-waypoint]',sec)?ECON.waypoint:0);rw(g).credit[id]=p;pts+=p;});
  if(pts)s.award('jump_credit',ids[0]||'',pts,'Sections tested out');renderRig();}
/* the sections a passed jump-ahead test let you skip: its level's, minus the ones a missed slot still sends you to */
function testedOut(levelId,key){if(typeof LEVELS_LIVE==='undefined'||!Array.isArray(LEVELS_LIVE))return [];const L=LEVELS_LIVE.find(l=>l.id===levelId);if(!L)return [];
  const g=G(),r=g&&g.assess&&g.assess[key],take=(r&&r.last&&Array.isArray(r.last.take))?r.last.take:[];return L.lessons.filter(id=>!take.includes(id));}
D.addEventListener('sg:event',e=>{const d=e.detail||{};try{
  if(d.type==='assessment_passed'&&typeof d.key==='string'&&d.key.startsWith('gate:'))creditSkipped(testedOut(d.key.slice(5),d.key));
  if(d.type==='gate_passed'&&d.part&&typeof IDS!=='undefined'&&typeof META!=='undefined'){const P=[];IDS.forEach(id=>{const p=META[id].part;if(!P.includes(p))P.push(p);});const prev=P[P.indexOf(d.part)-1];if(prev)creditSkipped(IDS.filter(id=>META[id].part===prev));}
  if(d.type==='lesson_done'||d.type==='part_unlocked'||(d.type==='lesson_open'&&d.id==='practice'))setTimeout(renderRig,0);
  if(d.type==='hints_locked'||d.type==='hints_unlocked')$$('.sg-hintbar').forEach(b=>paintHintBar(b));
  /* a bar drawn at boot priced against the coins of that moment: repaint the open section's bars as coins change */
  else setTimeout(()=>repaintHere(),0);
}catch(err){console.error('Systems Go rewards',err);}});
/* ---- the rig shop, at the top of Practice ---- */
const coinSVG='<svg viewBox="0 0 16 16" aria-hidden="true" class="sg-coin-i"><circle cx="8" cy="8" r="7" fill="currentColor"/><circle cx="8" cy="8" r="4.6" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.2"/></svg>';
function renderRig(){const host=D.getElementById('sg-rig'),g=G();if(!host||!g)return;const r=rw(g),bal=balance(g),open=GEAR.filter(gearOpen),owned=GEAR.filter(x=>r.owned[x[0]]);
  const next=GEAR.find(x=>!gearOpen(x));
  host.innerHTML=`<div class="sg-rig"><div class="sg-rig-h"><h3>Your rig</h3><span class="sg-coins-l">${coinSVG}<b>${bal.toLocaleString()}</b> coins</span></div>
  <p class="sg-p">Coins come from points (one for every ${ECON.coinPer}) and from showing up (${ECON.signin.daily} a day, ${ECON.signin.seventh} on every 7th day in a row). They buy gear for your rig and hints on extra credit, nothing else. ${owned.length} of ${GEAR.length} pieces owned.${next?` Next to open: <b>${esc(next[1])}</b> at the waypoint <i>${esc(next[3]==='*'?'course finished':next[3])}</i>.`:''}</p>
  ${(()=>{const card=([k,n,p,w])=>{const own=!!r.owned[k],op=gearOpen([k,n,p,w]),short=p-bal;const why=own?'owned':!op?(w==='*'?'opens when the course is done':'opens at '+w):short>0?coinsMore(short):p+' coins';
    return `<button type="button" class="sg-gi${own?' own':''}${op?'':' shut'}" data-sg-buy="${k}" ${own||!op||short>0?'disabled':''} aria-label="${esc(n)}, ${esc(why)}"><b>${esc(n)}</b><span>${own?'Owned':op?coinSVG+p:'Locked'}</span><small>${esc(own?'':op?(short>0?short+' more':'Buy'):(w==='*'?'Course finished':w))}</small></button>`;};
    /* owned and open pieces, then the next two to open; the rest fold away so the list stays short on a phone */
    const shut=GEAR.filter(x=>!gearOpen(x)&&!r.owned[x[0]]),near=GEAR.filter(x=>gearOpen(x)||r.owned[x[0]]).concat(shut.slice(0,2)),rest=shut.slice(2);
    return `<div class="sg-gear">${near.map(card).join('')}</div>${rest.length?`<details class="sg-more"><summary>${rest.length} more pieces, each opening at a waypoint</summary><div class="sg-gear">${rest.map(card).join('')}</div></details>`:''}`;})()}</div>`;}
D.addEventListener('click',e=>{const b=e.target.closest('[data-sg-buy]');if(!b||b.disabled)return;const g=G(),k=b.dataset.sgBuy,it=GEAR.find(x=>x[0]===k);if(!g||!it)return;
  if(!buy(g,k,gearOpen(it)))return;save();emit('gear_bought',{key:k,price:it[2]});const s=SG();if(s&&s.renderHeader)s.renderHeader(true);renderRig();const nb=D.querySelector(`[data-sg-buy="${k}"]`);if(nb&&s&&s.fx)s.fx.settle(nb);});
/* ---- hints on extra credit (window.SGHints; the assessment engine calls offer) ---- */
function paintHintBar(bar){const g=G(),ctx=bar._ctx;if(!g||!ctx)return;const item=bar._item,done=item.classList.contains('is-right')||item.classList.contains('done');
  if(testing()||!hintAllowed(ctx.tier,false)){bar.hidden=true;return;}bar.hidden=false;const bal=balance(g),got=(rw(g).hints[ctx.item.id]||[]);
  const btn=(w,label)=>{const p=hintPrice(ctx.level,w),used=got.includes(w),short=p-bal;return `<button type="button" class="btn sm sg-hintbtn" data-sg-hint="${w}" ${used||done||short>0?'disabled':''}>${used?label+' used':short>0?label+': '+coinsMore(short):label}<span class="sg-coin-p">${coinSVG}${p}</span></button>`;};
  bar.innerHTML=btn('nudge','Nudge')+(canNarrow(ctx)?btn('narrow','Narrow'):'')+`<span class="sg-hintnote">A hinted right answer pays ${hintPays()} points and is never a first try.</span>`;
  got.forEach(w=>showHint(item,ctx,w,true));}
function repaintHere(){const id=typeof cur==='string'?cur:(location.hash||'').slice(1),sec=id&&D.getElementById(id);if(sec)$$('.sg-hintbar',sec).forEach(b=>paintHintBar(b));}
/* reset tells the rewards layer by wrapping SG.reset here, not inside game.js, so a merge of the SG block can't drop it */
(function wrapReset(){const W=window.SG;if(!W||!W.reset){setTimeout(wrapReset,30);return;}if(W.reset._sg)return;const r0=W.reset;W.reset=function(){const v=r0.apply(this,arguments);try{D.dispatchEvent(new CustomEvent('sg:points',{detail:{type:'reset'}}));}catch(e){}return v;};W.reset._sg=1;})();
D.addEventListener('sg:points',e=>{const t=e.detail&&e.detail.type;if(t==='reset')dailySignIn();setTimeout(()=>{$$('.sg-hintbar').forEach(b=>paintHintBar(b));renderRig();},0);});
D.addEventListener('toggle',e=>{const t=e.target;if(t&&t.matches&&t.matches('details')&&t.open)$$('.sg-hintbar',t).forEach(b=>paintHintBar(b));},true);
const coinsMore=n=>n+(n===1?' more coin':' more coins');
function hintPays(){try{const a=typeof ASSESS_LIVE==='string'&&typeof SGAssess!=='undefined'?SGAssess.decode(ASSESS_LIVE):{};return +(((a.schedule||{}).extra||{}).points_later)||2;}catch(e){return 2;}}
function canNarrow(ctx){const it=ctx.item||{};if(it.kind==='choice')return typeof ctx.check==='function'&&Array.isArray(it.o)&&it.o.length>2;return Array.isArray(it.hint)&&it.hint.length>1;}
function seeLink(ctx){const id=ctx.item&&ctx.item.see;if(!id||!D.getElementById(id))return '';const t=(typeof META!=='undefined'&&META[id]&&META[id].title)||id;return ` <a href="#${esc(id)}" data-go="${esc(id)}">Re-read ${esc(t)}</a>.`;}
function showHint(item,ctx,which,quiet){const it=ctx.item||{},steps=Array.isArray(it.hint)?it.hint:it.hint?[String(it.hint)]:[];
  if(which==='narrow'&&it.kind==='choice'&&typeof ctx.check==='function'){const wrong=it.o.map((_,i)=>i).filter(i=>{try{return !ctx.check(i);}catch(e){return false;}});
    const drop=wrong.slice().sort((a,b)=>((a*7919+it.id.length)%13)-((b*7919+it.id.length)%13)).slice(0,Math.floor(wrong.length/2));
    drop.forEach(i=>{const b=$(`[data-opt="${i}"]`,item);if(b){b.disabled=true;b.classList.add('sg-struck');b.setAttribute('aria-label',b.textContent.trim()+', ruled out by a hint');}});return;}
  if($(`.sg-hint[data-w="${which}"]`,item))return;const txt=which==='narrow'?(steps[1]||steps[0]||''):(steps[0]||'');
  const p=D.createElement('p');p.className='sg-hint';p.dataset.w=which;p.innerHTML=(txt?esc(txt):'Read the question again slowly, then the section it comes from.')+(which==='nudge'?seeLink(ctx):'');
  const bar=$('.sg-hintbar',item);(bar||item).insertAdjacentElement(bar?'afterend':'beforeend',p);if(!quiet&&!RM())p.classList.add('sg-hint-in');}
D.addEventListener('click',e=>{const b=e.target.closest('[data-sg-hint]');if(!b||b.disabled)return;const bar=b.closest('.sg-hintbar'),ctx=bar&&bar._ctx,item=bar&&bar._item,g=G();if(!ctx||!g)return;
  if(testing()||!hintAllowed(ctx.tier,false)){paintHintBar(bar);return;}
  const w=b.dataset.sgHint,p=hintPrice(ctx.level,w),got=rw(g).hints[ctx.item.id]||[];if(got.includes(w))return;
  if(!spend(g,p)){paintHintBar(bar);return;}
  rw(g).hints[ctx.item.id]=[...got,w];item.dataset.hinted='1';save();
  emit('hint_bought',{assessment:ctx.assessment,item:ctx.item.id,which:w,price:p,level:ctx.level});
  showHint(item,ctx,w,false);paintHintBar(bar);const s=SG();if(s&&s.renderHeader)s.renderHeader(true);});
const SGHints={offer(itemEl,ctx){if(!itemEl||!ctx||!ctx.item||!ctx.item.id)return false;if(!hintAllowed(ctx.tier,testing()))return false;
  let bar=$('.sg-hintbar',itemEl);if(!bar){bar=D.createElement('div');bar.className='sg-hintbar';itemEl.appendChild(bar);}
  bar._ctx=ctx;bar._item=itemEl;const g=G();if(g&&(rw(g).hints[ctx.item.id]||[]).length)itemEl.dataset.hinted='1';paintHintBar(bar);return true;},
  price:hintPrice};
window.SGHints=SGHints;
/* ---- boot: after game.js, so window.SG exists ---- */
function boot(){if(!SG()){setTimeout(boot,0);return;}dailySignIn();renderRig();
  D.addEventListener('visibilitychange',()=>{if(!D.hidden)dailySignIn();});}
if(D.readyState==='loading')D.addEventListener('DOMContentLoaded',()=>setTimeout(boot,0));else setTimeout(boot,0);
return Object.assign({},PURE,{pointsFor,waypointFor,gearOpen,balanceNow:()=>{const g=G();return g?balance(g):0;},etaText,renderRig});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=SGRewards;
