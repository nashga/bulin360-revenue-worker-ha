(function(root){
  'use strict';
  const Core=root.BulinBookingReaderCore;
  if(!Core) throw new Error('BulinBookingReaderCore no cargado');

  async function execute(opts){
    const o=opts||{}; const started=Date.now();
    const ready=await Core.waitUntilReady({deadlineMs:o.deadlineMs||30000});
    if(ready.status){
      return Core.makeEnvelope({},o.context||{}, {reader_version:o.readerVersion||'v14',worker_version:o.workerVersion||'core-1',status:ready.status,status_reason:ready.reason,duration_ms:Date.now()-started,final_url:location.href});
    }
    let payload;
    try{payload=await o.readBookingPage(o.context||{});}catch(e){
      return Core.makeEnvelope({},o.context||{}, {reader_version:o.readerVersion||'v14',worker_version:o.workerVersion||'core-1',status:Core.RESULT_STATUSES.ERROR,status_reason:'reader_exception:'+String(e&&e.message||e),duration_ms:Date.now()-started,final_url:location.href});
    }
    return Core.makeEnvelope(payload,o.context||{}, {reader_version:o.readerVersion||'v14',worker_version:o.workerVersion||'core-1',duration_ms:Date.now()-started,final_url:location.href});
  }

  root.BulinBookingReaderWorker={execute};
})(typeof globalThis!=='undefined'?globalThis:this);
