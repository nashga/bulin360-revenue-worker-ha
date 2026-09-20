(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.BulinBookingReaderCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const VERSION='1.1.1';
  const RESULT_STATUSES=Object.freeze({
    OK:'OK', PARCIAL:'PARCIAL', SIN_DISPONIBILIDAD:'SIN_DISPONIBILIDAD',
    RESTRICCION:'RESTRICCION', PROPERTY_NOT_AVAILABLE_FOR_DATES:'PROPERTY_NOT_AVAILABLE_FOR_DATES', CAPTCHA:'CAPTCHA', BLOQUEADO:'BLOQUEADO',
    TIMEOUT:'TIMEOUT', ESTRUCTURA_CAMBIADA:'ESTRUCTURA_CAMBIADA',
    INCONSISTENTE:'INCONSISTENTE', ERROR:'ERROR'
  });

  const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
  const s=v=>v==null?'':String(v).trim();
  const arr=v=>Array.isArray(v)?v:[];
  const uniq=a=>[...new Set(a)];

  function classifyPage(doc,loc){
    const d=doc||((typeof document!=='undefined')?document:null);
    const l=loc||((typeof location!=='undefined')?location:{href:'',hostname:''});
    if(!d) return {status:RESULT_STATUSES.ERROR,reason:'document_missing'};
    const text=s(d.body&&d.body.innerText).replace(/\s+/g,' ').slice(0,200000);
    const title=s(d.title);
    const href=s(l.href);
    const hayCaptcha=/captcha|comprueba que eres humano|verify you are human|verifica que eres humano|security check/i.test(text+' '+title);
    if(hayCaptcha) return {status:RESULT_STATUSES.CAPTCHA,reason:'captcha_or_human_verification'};
    const blocked=/tr[aá]fico inusual|access denied|request blocked|temporarily blocked|error 403|error 429|too many requests/i.test(text+' '+title);
    if(blocked) return {status:RESULT_STATUSES.BLOQUEADO,reason:'booking_block_or_rate_limit'};
    const noAvail=/no hay disponibilidad|sin disponibilidad|no tenemos disponibilidad|agotado para tus fechas|no availability/i.test(text);
    if(noAvail) return {status:RESULT_STATUSES.SIN_DISPONIBILIDAD,reason:'explicit_no_availability'};
    const restriction=/estancia m[ií]nima|min(?:imum)? stay|no se puede hacer el check-in|closed to arrival|restricci[oó]n de estancia/i.test(text);
    if(restriction) return {status:RESULT_STATUSES.RESTRICCION,reason:'explicit_booking_restriction'};
    const hasRoomSelectors=!!d.querySelector('select');
    const explicitPropertyUnavailable=/no es posible realizar reservas en este hotel en nuestra p[aá]gina|currently not possible to make reservations at this hotel on our site|not possible to make a reservation at this property/i.test(text);
    if(explicitPropertyUnavailable&&!hasRoomSelectors) return {status:RESULT_STATUSES.PROPERTY_NOT_AVAILABLE_FOR_DATES,reason:'explicit_property_not_bookable_on_booking'};
    const hasBookingSignals=/booking\.com/i.test(s(l.hostname)+' '+href)||/Booking\.com/i.test(text.slice(0,5000));
    if(hasBookingSignals&&hasRoomSelectors) return {status:null,reason:'candidate_ready'};
    return {status:null,reason:'undetermined'};
  }

  function propertyIdentity(url,ctx){
    const c=ctx||{}; const expected=s(c.property_slug).toLowerCase();
    if(!expected) return {matched:null,redirected:false,reason:'property_slug_missing'};
    try{
      const u=new URL(url||((typeof location!=='undefined')?location.href:''));
      const path=decodeURIComponent(u.pathname||'').toLowerCase();
      if(path.includes(expected)) return {matched:true,redirected:false,reason:'property_slug_matched'};
      const general=/\/(?:searchresults|city|region|country|destination|landmark)(?:\/|$)/i.test(path) || !path.includes('/hotel/');
      return {matched:false,redirected:true,reason:general?'property_redirected_to_general_booking_page':'property_redirected_to_different_property'};
    }catch(e){return {matched:null,redirected:false,reason:'property_url_unreadable'};}
  }

  function queryEchoFromUrl(url){
    try{
      const u=new URL(url||((typeof location!=='undefined')?location.href:''));
      const p=u.searchParams;
      let b={};
      const m=(u.hash||'').match(/(?:^#|&)b360=([^&]+)/);
      if(m){const q=new URLSearchParams(decodeURIComponent(m[1]));b={checkin:q.get('checkin')||'',checkout:q.get('checkout')||'',adults:q.get('adults')||'',requested_rooms:q.get('rooms')||'',kind:q.get('kind')||''};}
      return {
        checkin:b.checkin||p.get('checkin')||'',
        checkout:b.checkout||p.get('checkout')||'',
        adults:b.adults||p.get('group_adults')||p.get('req_adults')||'',
        requested_rooms:b.requested_rooms||p.get('no_rooms')||'',
        kind:b.kind||''
      };
    }catch(e){return {checkin:'',checkout:'',adults:'',requested_rooms:'',kind:''};}
  }

  function contextMatchesUrl(url,ctx){
    const c=ctx||{}; const q=queryEchoFromUrl(url);
    const errors=[];
    if(c.checkin&&s(q.checkin)!==s(c.checkin)) errors.push('checkin_mismatch');
    if(c.checkout&&s(q.checkout)!==s(c.checkout)) errors.push('checkout_mismatch');
    if(c.adults&&n(q.adults)!==n(c.adults)) errors.push('adults_mismatch');
    return {ok:errors.length===0,errors,actual:q};
  }

  function validateResult(result,ctx){
    const r=result||{}; const meta=r.meta||{}; const c=ctx||{};
    const missing=[]; const errors=[]; const warnings=[];
    for(const k of ['checkin','checkout','adults']) if(!s(meta[k])) missing.push('meta.'+k);
    if(!s(meta.property)) warnings.push('property_missing');
    if(c.checkin&&s(meta.checkin)!==s(c.checkin)) errors.push('checkin_mismatch');
    if(c.checkout&&s(meta.checkout)!==s(c.checkout)) errors.push('checkout_mismatch');
    if(c.adults&&n(meta.adults)!==n(c.adults)) errors.push('adults_mismatch');
    if(c.property_slug&&s(meta.url)&&!s(meta.url).includes(c.property_slug)) warnings.push('property_slug_not_in_url');

    const inv=arr(r.inventory_summary); const offers=arr(r.offers);
    const seen=new Set();
    for(const row of inv){
      const rid=s(row.room_id); if(!rid) errors.push('inventory_room_id_missing');
      if(rid&&seen.has(rid)) errors.push('inventory_duplicate_room_id:'+rid); else if(rid) seen.add(rid);
      const stock=n(row.stock_count), sel=n(row.selector_max);
      if(stock!=null&&sel!=null&&stock>sel) errors.push('stock_gt_selector:'+rid);
    }
    const byRoom={};
    for(const o of offers){
      const rid=s(o.room_id); if(!rid) warnings.push('offer_room_id_missing');
      if(rid){byRoom[rid]=byRoom[rid]||[];byRoom[rid].push(o);}
    }
    for(const [rid,list] of Object.entries(byRoom)){
      const stocks=uniq(list.map(x=>n(x.stock_count)).filter(x=>x!=null));
      if(stocks.length>1) warnings.push('variant_stock_conflict:'+rid);
    }

    const comp=arr(meta.recommended_composition);
    if(comp.length&&n(meta.recommended_units)!=null){
      const units=comp.reduce((a,x)=>a+(n(x.units)||0),0);
      if(units!==n(meta.recommended_units)) errors.push('recommended_units_composition_mismatch');
      const cap=comp.reduce((a,x)=>a+(n(x.units)||0)*(n(x.occupancy)||0),0);
      if(n(meta.recommended_people)!=null&&cap&&cap<n(meta.recommended_people)) errors.push('recommended_capacity_insufficient');
    }
    const lowComp=arr(meta.lowest_visible_composition);
    if(lowComp.length&&n(meta.lowest_visible_units)!=null){
      const units=lowComp.reduce((a,x)=>a+(n(x.units)||0),0);
      if(units!==n(meta.lowest_visible_units)) errors.push('lowest_units_composition_mismatch');
      const subtotal=lowComp.reduce((a,x)=>a+(n(x.subtotal)!=null?n(x.subtotal):(n(x.units)||0)*(n(x.unit_price)||0)),0);
      if(n(meta.lowest_visible_total)!=null&&Math.abs(subtotal-n(meta.lowest_visible_total))>0.51) errors.push('lowest_total_composition_mismatch');
    }
    const rec=n(meta.recommended_total), cmp=n(meta.comparison_total);
    if(meta.comparison_basis==='booking_recommendation'&&rec!=null&&cmp!=null&&Math.abs(rec-cmp)>0.51) errors.push('comparison_not_equal_recommendation');
    if(n(meta.lowest_visible_total)!=null&&n(meta.lowest_visible_units)==null) warnings.push('lowest_units_missing');
    if(rec!=null&&n(meta.recommended_people)==null) warnings.push('recommended_people_missing');

    let status=RESULT_STATUSES.OK;
    if(errors.length) status=RESULT_STATUSES.INCONSISTENTE;
    else if(missing.length) status=RESULT_STATUSES.PARCIAL;
    return {status,fields_missing:missing,errors,warnings,valid:!errors.length};
  }

  function makeEnvelope(result,ctx,extra){
    const now=new Date().toISOString(); const ex=extra||{}; const c=ctx||{};
    const validation=validateResult(result,c);
    return {
      schema:'bulin360.booking.reader-envelope.v1',
      reader_core_version:VERSION,
      reader_version:s(ex.reader_version||'v14'),
      worker_version:s(ex.worker_version||''),
      job_id:s(c.job_id||''), attempt_id:s(c.attempt_id||''),
      competitor_id:s(c.competitor_id||''),
      status:ex.status||validation.status,
      status_reason:s(ex.status_reason||''),
      fields_missing:validation.fields_missing,
      validation_errors:validation.errors,
      validation_warnings:validation.warnings,
      final_url:s(ex.final_url||((result&&result.meta&&result.meta.url)||'')),
      duration_ms:n(ex.duration_ms),
      captured_at:s((result&&result.meta&&result.meta.captured_at)||now),
      payload:result||{}
    };
  }

  function fingerprintDocument(doc){
    const d=doc||((typeof document!=='undefined')?document:null); if(!d) return '';
    const rows=[...d.querySelectorAll('tr')].slice(0,80).map(r=>s(r.innerText).replace(/\s+/g,' ').slice(0,240));
    const sig=rows.join('|')+'#'+d.querySelectorAll('select').length;
    let h=2166136261; for(let i=0;i<sig.length;i++){h^=sig.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(16);
  }

  async function waitUntilReady(opts){
    const o=Object.assign({deadlineMs:30000,stableGapMs:650,pollMs:200,stableRequired:2},opts||{});
    const d=o.document||((typeof document!=='undefined')?document:null); const l=o.location||((typeof location!=='undefined')?location:null);
    if(!d) return {status:RESULT_STATUSES.ERROR,reason:'document_missing'};
    const start=Date.now(); let lastFp=''; let stableCount=0; let terminalSince=0;
    try{
      while(Date.now()-start<o.deadlineMs){
        const cls=classifyPage(d,l);
        if(cls.status) return Object.assign({duration_ms:Date.now()-start},cls);
        const bodyText=s(d.body&&d.body.innerText);
        const hasTerminalCandidate=!!d.querySelector('select')||d.querySelectorAll('tr').length>2||/no hay disponibilidad|sin disponibilidad|estancia m[ií]nima/i.test(bodyText);
        if(hasTerminalCandidate){
          if(!terminalSince) terminalSince=Date.now();
          const fp=fingerprintDocument(d);
          if(fp&&fp===lastFp) stableCount++; else stableCount=0;
          lastFp=fp;
          if(stableCount>=o.stableRequired) return {status:null,reason:'ready_stable_relevant_dom',duration_ms:Date.now()-start,fingerprint:fp};
          await new Promise(res=>setTimeout(res,o.stableGapMs));
          continue;
        }
        await new Promise(res=>setTimeout(res,o.pollMs));
      }
      const text=s(d.body&&d.body.innerText);
      const loading=/cargando|loading|spinner/i.test(text);
      return {status:loading?RESULT_STATUSES.TIMEOUT:RESULT_STATUSES.ESTRUCTURA_CAMBIADA,reason:loading?'deadline_while_loading':'deadline_without_terminal_signal',duration_ms:Date.now()-start};
    } finally {}
  }

  return {VERSION,RESULT_STATUSES,classifyPage,propertyIdentity,queryEchoFromUrl,contextMatchesUrl,validateResult,makeEnvelope,fingerprintDocument,waitUntilReady};
});
