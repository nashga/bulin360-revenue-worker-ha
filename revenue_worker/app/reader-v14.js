(function(root){
'use strict';
function readBookingPageV14(){

const norm=s=>(s||'').replace(/\s+/g,' ').trim();
const parseNum=s=>{if(s==null)return null;const t=String(s).replace(/\s+/g,'').replace(/\./g,'').replace(',','.');const m=t.match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null};
const euroRe=/(?:€\s*([0-9.]+(?:,[0-9]{1,2})?)|([0-9.]+(?:,[0-9]{1,2})?)\s*€)/g;
const stockRe=/(?:Nos queda|Nos quedan|Solo queda|Solo quedan|Queda|Quedan)\s+(\d+)/i;
const blockRe=/(\d{6,}_[0-9_]{3,})/;
const params=new URLSearchParams(location.search);
function readB360Context(){try{const h=String(location.hash||'');const m=h.match(/(?:^#|&)b360=([^&]+)/);if(!m)return {};const q=new URLSearchParams(decodeURIComponent(m[1]));return {checkin:q.get('checkin')||'',checkout:q.get('checkout')||'',adults:q.get('adults')||'',requested_rooms:q.get('rooms')||'',kind:q.get('kind')||'',competitor_id:q.get('cid')||'',assist:q.get('assist')||'',token:q.get('token')||''}}catch(e){return {}}}
const b360Ctx=readB360Context();
function euros(text){const out=[];let m;euroRe.lastIndex=0;while((m=euroRe.exec(text||''))){const n=parseNum(m[1]||m[2]);if(Number.isFinite(n))out.push(n)}return [...new Set(out)]}
function getBlockId(el){let n=el;for(let i=0;n&&i<8;i++,n=n.parentElement){for(const a of Array.from(n.attributes||[])){const m=String(a.value||'').match(blockRe);if(m)return m[1]}}for(const key of ['name','id','value']){const m=String(el?.getAttribute?.(key)||'').match(blockRe);if(m)return m[1]}return ''}
function roomNameLike(t){t=norm(t);if(!t||t.length>=180)return false;if(/^(seleccionar habitaciones|selecciona habitaciones|reservar|ver disponibilidad|más info|mas info)$/i.test(t))return false;return /apartamento|habitaci[oó]n|casa|estudio|villa|suite|d[uú]plex|bungalow|chalet|loft/i.test(t)}
function getRoomNameFromRow(tr){if(!tr)return '';for(const sel of ['a','h3','h4','strong','b']){for(const el of tr.querySelectorAll(sel)){const t=norm(el.innerText);if(roomNameLike(t))return t}}for(const td of tr.querySelectorAll('td')){const t=norm(td.innerText);if(roomNameLike(t)&&t.length<180)return t}return ''}
function getInheritedRoomName(tr){if(!tr)return '';const rr=tr.getBoundingClientRect(),cy=(rr.top+rr.bottom)/2;const table=tr.closest('table')||document;for(const td of table.querySelectorAll('td[rowspan]')){const r=td.getBoundingClientRect();if(r.top<=cy&&r.bottom>=cy){const t=norm(td.innerText);if(roomNameLike(t))return t;for(const el of td.querySelectorAll('a,h3,h4,strong,b')){const x=norm(el.innerText);if(roomNameLike(x))return x}}}let p=tr.previousElementSibling;for(let i=0;p&&i<4;i++,p=p.previousElementSibling){for(const td of p.querySelectorAll('td[rowspan]')){const rs=Number(td.getAttribute('rowspan')||1);if(rs>i+1){const t=norm(td.innerText);if(roomNameLike(t))return t}}}return ''}
function findRecommendation(){
 const requested=Number(b360Ctx.adults||params.get('group_adults')||0)||'';
 const headingRe=/^Recomendado\s+para\s+(\d+)\s+(?:adultos|personas)$/i;
 const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],strong,b,span,div')]
   .map(el=>({el,t:norm(el.innerText)}))
   .filter(x=>x.t&&x.t.length<=90&&headingRe.test(x.t));
 let best=null;
 for(const {el,t:ht} of headings){
   const hm=ht.match(headingRe); const people=hm?Number(hm[1]):requested;
   if(requested&&people&&Number(requested)!==Number(people))continue;
   let n=el;
   for(let i=0;n&&i<8;i++,n=n.parentElement){
     const t=norm(n.innerText);
     if(!t||t.length>12000)continue;
     if(/Más info|Leer más|comentario|opinión|reseña|valoración|España [“"]|Reino Unido [“"]|Francia [“"]|Italia [“"]|Alemania [“"]/i.test(t))continue;
     const hasAction=/Reserva tu selecci[oó]n|Tu selecci[oó]n|Reservar|Precio total|Total de la estancia|Total/i.test(t);
     if(!hasAction)continue;
     const vals=euros(t).filter(v=>v>=20);
     if(!vals.length)continue;
     const score=(/Precio total|Total de la estancia/i.test(t)?8:0)+(/Reserva tu selecci[oó]n|Tu selecci[oó]n|Reservar/i.test(t)?6:0)+(/noches?/i.test(t)?2:0)-Math.min(t.length/3500,3);
     const total=Math.max(...vals);
     if(!best||score>best.score)best={label:ht,people,total,score};
   }
 }
 return best?{label:best.label,people:best.people,total:best.total}:{label:'',people:requested,total:''};
}
const recommendation=findRecommendation();
const raw=[];
for(const s of [...document.querySelectorAll('select')]){
  const tr=s.closest('tr'); if(!tr) continue;
  const block=getBlockId(s)||getBlockId(tr); if(!block) continue;
  const parts=block.split('_'); const room_id=parts[0]||'', rate_id=parts[1]||'';
  function detectOccupancy(tr,parts){
    const fromBlock=Number(parts[2]);
    if(Number.isFinite(fromBlock)&&fromBlock>0) return {value:fromBlock,source:'block_id'};
    const cells=[...tr.querySelectorAll('td')];
    const occCell=cells[1]||null;
    if(occCell){
      const candidates=[occCell.getAttribute('aria-label'),occCell.getAttribute('title'),...Array.from(occCell.querySelectorAll('[aria-label],[title]')).flatMap(el=>[el.getAttribute('aria-label'),el.getAttribute('title')])].filter(Boolean).join(' ');
      let mm=candidates.match(/(\d+)\s*(?:personas?|adultos?|guests?|people)/i);
      if(mm) return {value:Number(mm[1]),source:'aria'};
      const txt=norm(occCell.innerText);
      mm=txt.match(/(?:n[uú]mero de personas?\s*:?\s*)?(\d+)\s*(?:personas?|adultos?|guests?|people)/i);
      if(mm) return {value:Number(mm[1]),source:'text'};
    }
    return {value:'',source:'unknown'};
  }
  const occ=detectOccupancy(tr,parts), occupancy=occ.value, occupancy_source=occ.source;
  const text=norm(tr.innerText);
  const opts=[...s.options].map(o=>norm(o.textContent)).filter(Boolean);
  const nums=opts.map(x=>parseInt((x.match(/^\s*(\d+)/)||[])[1],10)).filter(Number.isFinite);
  const st=text.match(stockRe);
  raw.push({tr,block_id:block,room_id,rate_id,occupancy,explicit_name:getRoomNameFromRow(tr)||getInheritedRoomName(tr),explicit_stock_text:st?st[0]:'',explicit_stock_count:st?Number(st[1]):'',selector_max:nums.length?Math.max(...nums):'',price:(()=>{const cells=[...tr.querySelectorAll('td')];const cand=[];for(const td of cells){const vals=euros(norm(td.innerText)).filter(v=>v>=20);if(vals.length)cand.push({len:norm(td.innerText).length,vals});}cand.sort((a,b)=>a.len-b.len);return cand.length?cand[0].vals[0]:(euros(text).filter(v=>v>=20)[0]??'')})(),prices:(()=>{const cells=[...tr.querySelectorAll('td')];const cand=[];for(const td of cells){const vals=euros(norm(td.innerText)).filter(v=>v>=20);if(vals.length)cand.push({len:norm(td.innerText).length,vals});}cand.sort((a,b)=>a.len-b.len);return (cand.length?cand[0].vals:euros(text).filter(v=>v>=20)).join(' | ')})(),occupancy_source,rate_flags:[/No reembolsable/i.test(text)?'No reembolsable':'',/Cancelaci[oó]n gratis|Reembolsable/i.test(text)&&!/No reembolsable/i.test(text)?'Reembolsable':'',/Desayuno incluido/i.test(text)?'Desayuno incluido':''].filter(Boolean).join(' | ')});
}
const roomMeta=new Map();
for(const r of raw){let m=roomMeta.get(r.room_id)||{room_name:'',stock_text:'',stock_count:'',selector_max:'',prices_by_occ:[]};if(r.explicit_name&&!m.room_name)m.room_name=r.explicit_name;if(r.explicit_stock_text){m.stock_text=r.explicit_stock_text;m.stock_count=r.explicit_stock_count}if(r.selector_max!==''&&(m.selector_max===''||Number(r.selector_max)>Number(m.selector_max)))m.selector_max=r.selector_max;roomMeta.set(r.room_id,m)}
const rows=raw.map(r=>{const m=roomMeta.get(r.room_id)||{};const canonical=roomNameLike(m.room_name)?m.room_name:(roomNameLike(r.explicit_name)?r.explicit_name:'');return {room_name:canonical,block_id:r.block_id,room_id:r.room_id,rate_id:r.rate_id,occupancy:r.occupancy,tariff_occupancy:r.occupancy,stock_text:r.explicit_stock_text||m.stock_text||'',stock_count:r.explicit_stock_count!==''?r.explicit_stock_count:(m.stock_count??''),selector_max:r.selector_max!==''?r.selector_max:(m.selector_max??''),unit_price:r.price,prices:r.prices,rate_flags:r.rate_flags}});

const requestedAdults=Number(b360Ctx.adults||params.get('group_adults')||0)||0;
const requestedRooms=Number(b360Ctx.requested_rooms||params.get('no_rooms')||1)||1;

function solveVisibleCombination(targetAdults){
  if(!targetAdults||targetAdults<1)return {total:'',units:'',composition:[],complete:''};
  const types=[];
  for(const [roomId,m] of roomMeta.entries()){
    const stock=Number(m.stock_count);
    if(!Number.isFinite(stock)||stock<1)continue;
    const offers=rows.filter(r=>r.room_id===roomId&&Number.isFinite(Number(r.unit_price))&&Number(r.occupancy)>0);
    const bestByOcc=new Map();
    for(const r of offers){const occ=Number(r.occupancy),price=Number(r.unit_price);const cur=bestByOcc.get(occ);if(!cur||price<cur.price)bestByOcc.set(occ,{occ,price,room_id:roomId,room_name:r.room_name||m.room_name||'',block_id:r.block_id,rate_flags:r.rate_flags||''});}
    if(bestByOcc.size)types.push({room_id:roomId,room_name:m.room_name||'',stock:Math.min(stock,30),options:[...bestByOcc.values()]});
  }
  if(!types.length)return {total:'',units:'',composition:[],complete:''};
  const maxOcc=Math.max(1,...types.flatMap(t=>t.options.map(o=>o.occ)));
  const cap=Math.min(120,targetAdults+maxOcc);
  let dp=new Map([[0,{cost:0,units:0,items:[],ambiguous:false,sig:''}]]);
  for(const t of types){
    for(let copy=0;copy<t.stock;copy++){
      const next=new Map(dp);
      for(const [covered,state] of dp.entries()){
        for(const o of t.options){
          const nc=Math.min(cap,covered+o.occ),cost=state.cost+o.price,units=state.units+1;
          const prev=next.get(nc);const items=state.items.concat([o]);const sig=items.map(z=>`${z.room_id}:${z.block_id}:${z.occ}:${z.price}`).sort().join('|');
          if(!prev||cost<prev.cost-0.001||(Math.abs(cost-prev.cost)<0.001&&units<prev.units))next.set(nc,{cost,units,items,ambiguous:state.ambiguous||false,sig});
          else if(Math.abs(cost-prev.cost)<0.001&&units===prev.units&&sig!==prev.sig)prev.ambiguous=true;
        }
      }
      dp=next;
    }
  }
  let best=null,finalSigs=new Set(),finalAmbiguous=false;
  for(const [covered,state] of dp.entries())if(covered>=targetAdults){if(!best||state.cost<best.cost-0.001||(Math.abs(state.cost-best.cost)<0.001&&state.units<best.units)){best={...state,covered};finalSigs=new Set([state.sig]);finalAmbiguous=!!state.ambiguous}else if(Math.abs(state.cost-best.cost)<0.001&&state.units===best.units){finalSigs.add(state.sig);if(state.ambiguous)finalAmbiguous=true}}
  if(!best)return {total:'',units:'',composition:[],complete:0,ambiguous:false};
  let ambiguous=finalAmbiguous||finalSigs.size>1;
  const grouped=new Map();
  const totalExplicitStock=types.reduce((a,t)=>a+Number(t.stock||0),0);
  const forcedAllStock=best.units===totalExplicitStock;
  if(!ambiguous||forcedAllStock)for(const it of best.items){const k=forcedAllStock?String(it.room_id):[it.room_id,it.block_id,it.price,it.occ].join('|');const g=grouped.get(k)||{block_id:it.block_id,room_id:it.room_id,room_name:it.room_name,occupancy:it.occ,units:0,unit_price:it.price,subtotal:0,rate_flags:it.rate_flags};g.units++;g.subtotal=Number((Number(g.subtotal||0)+Number(it.price||0)).toFixed(2));if(Number(g.unit_price)!==Number(it.price)){g.unit_price='';g.block_id='';}grouped.set(k,g);}
  if(forcedAllStock)ambiguous=false;
  return {total:Number(best.cost.toFixed(2)),units:best.units,composition:ambiguous?[]:[...grouped.values()],complete:1,ambiguous};
}
const lowestVisible=solveVisibleCombination(requestedAdults);
if(lowestVisible.total===''&&requestedRooms===1&&requestedAdults>0&&requestedAdults<=2){const eligible=rows.filter(r=>Number.isFinite(Number(r.unit_price))&&(r.occupancy===''||Number(r.occupancy)===requestedAdults));if(eligible.length){eligible.sort((a,b)=>Number(a.unit_price)-Number(b.unit_price));const x=eligible[0];lowestVisible.total=Number(x.unit_price);lowestVisible.units=1;lowestVisible.composition=[{block_id:x.block_id,room_id:x.room_id,room_name:x.room_name,occupancy:x.occupancy||requestedAdults,units:1,unit_price:Number(x.unit_price),subtotal:Number(x.unit_price),rate_flags:x.rate_flags||''}];lowestVisible.complete=1;}}
let comparableTotal='',comparableLabel='',comparableBasis='',comparableComplete='';
if(recommendation.total!==''){comparableTotal=recommendation.total;comparableLabel=recommendation.label||'Recomendación Booking';comparableBasis='booking_recommendation';comparableComplete=1}
else if(lowestVisible.total!==''){comparableTotal=lowestVisible.total;comparableLabel=lowestVisible.units>1?`${lowestVisible.units} unidades · combinación visible mínima`:(lowestVisible.composition[0]?.room_name||'Tarifa visible mínima');comparableBasis=lowestVisible.units>1?'computed_minimum_visible_combination':'lowest_visible_eligible_rate';comparableComplete=lowestVisible.complete;}
const summary=[];
for(const [id,m] of roomMeta.entries()){
 const offers=rows.filter(r=>r.room_id===id);
 const occPrices=offers.map(r=>`${r.occupancy||'?'}p:${r.unit_price!==''?r.unit_price:'?'}€`).join(' | ');
 summary.push({room_id:id,room_name:m.room_name,stock_count:m.stock_count,selector_max:m.selector_max,variants:offers.length,occupancy_prices:occPrices});
}
function parseRecommendedComposition(){
 const spr=params.get('sr_pri_blocks')||'';
 if(!spr)return {units:'',composition:[]};
 const counted=new Map();
 for(const token of spr.split(',').map(x=>x.trim()).filter(Boolean)){
   const m=token.match(/^(.+?)__(\d+)$/); if(!m)continue;
   const blockId=m[1], unitPrice=Number(m[2])/100;
   const key=blockId+'|'+unitPrice;
   const cur=counted.get(key)||{block_id:blockId,unit_price:unitPrice,units:0};cur.units++;counted.set(key,cur);
 }
 const composition=[];
 for(const x of counted.values()){
   const r=rows.find(y=>y.block_id===x.block_id)||rows.find(y=>String(y.block_id||'').startsWith(String(x.block_id||'')))||{};
   const roomId=r.room_id||String(x.block_id).split('_')[0]||'';
   const rm=roomMeta.get(roomId)||{};
   const roomName=r.room_name||rm.room_name||'';
   composition.push({block_id:x.block_id,room_id:roomId,room_name:roomName,units:x.units,unit_price:x.unit_price,subtotal:Number((x.units*x.unit_price).toFixed(2))});
 }
 const units=composition.reduce((a,x)=>a+Number(x.units||0),0);
 return {units:units||'',composition};
}
const recComposition=parseRecommendedComposition();
function inferRecommendedUnits(total,targetAdults){
  if(total===''||!targetAdults)return '';
  const target=Number(total); if(!Number.isFinite(target))return '';
  const types=[];
  for(const [roomId,m] of roomMeta.entries()){
    const stock=Number(m.stock_count); if(!Number.isFinite(stock)||stock<1)continue;
    const opts=[]; const seen=new Set();
    for(const r of rows.filter(x=>x.room_id===roomId&&Number(x.occupancy)>0&&Number.isFinite(Number(x.unit_price)))){const k=`${Number(r.occupancy)}|${Number(r.unit_price)}`;if(!seen.has(k)){seen.add(k);opts.push({occ:Number(r.occupancy),price:Number(r.unit_price)})}}
    if(opts.length)types.push({stock:Math.min(stock,20),opts});
  }
  if(!types.length)return '';
  const maxOcc=Math.max(1,...types.flatMap(t=>t.opts.map(o=>o.occ))), cap=Math.min(120,targetAdults+maxOcc), targetC=Math.round(target*100);
  let dp=new Map([[`0|0`,new Set([0])]]);
  for(const t of types){for(let c=0;c<t.stock;c++){const next=new Map(dp);for(const [key,setU] of dp.entries()){const [covS,costS]=key.split('|');const cov=Number(covS),cost=Number(costS);for(const o of t.opts){const nc=Math.min(cap,cov+o.occ),nCost=cost+Math.round(o.price*100);if(nCost>targetC)continue;const nk=`${nc}|${nCost}`;const ns=next.get(nk)||new Set();for(const u of setU)ns.add(u+1);next.set(nk,ns)}}dp=next;}}
  const counts=new Set();for(const [key,setU] of dp.entries()){const [cov,cost]=key.split('|').map(Number);if(cov>=targetAdults&&cost===targetC)for(const u of setU)counts.add(u)}
  return counts.size===1?[...counts][0]:'';
}
let inferredRecommendedUnits=recComposition.units;
if(!inferredRecommendedUnits&&recommendation.total!=='')inferredRecommendedUnits=inferRecommendedUnits(recommendation.total,requestedAdults);
let urlEncodedTotal='';const spr=params.get('sr_pri_blocks');if(spr){const m=spr.match(/__(\d+)$/);if(m)urlEncodedTotal=Number(m[1])/100}
const property=document.querySelector('h2,h1')?.innerText||document.title;
const meta={property,checkin:b360Ctx.checkin||params.get('checkin')||'',checkout:b360Ctx.checkout||params.get('checkout')||'',adults:b360Ctx.adults||params.get('group_adults')||'',children:params.get('group_children')||'0',requested_rooms:b360Ctx.requested_rooms||params.get('no_rooms')||'',run_kind:b360Ctx.kind||((params.get('group_adults')||params.get('checkin'))?'price':''),context_source:(b360Ctx.checkin||b360Ctx.adults)?'bulin360_hash':'booking_url',recommended_label:recommendation.label,recommended_people:recommendation.people||b360Ctx.adults||params.get('group_adults')||'',recommended_total:recommendation.total||'',recommended_units:inferredRecommendedUnits,recommended_composition:recComposition.composition,lowest_visible_total:lowestVisible.total,lowest_visible_units:lowestVisible.units,lowest_visible_composition:lowestVisible.composition,lowest_visible_ambiguous:lowestVisible.ambiguous?1:0,comparison_label:comparableLabel,comparison_total:comparableTotal,comparison_basis:comparableBasis,comparison_complete:comparableComplete,url_encoded_total:urlEncodedTotal,captured_at:new Date().toISOString(),url:location.href};

return {meta:meta,inventory_summary:summary,offers:rows};
}
root.BulinBookingReadV14=readBookingPageV14;
})(typeof globalThis!=='undefined'?globalThis:this);
