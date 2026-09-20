'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const WORKER_VERSION = 'ha-0.1.1';
const SOURCE_EXTENSION_VERSION = '0.3.103';
const READER_VERSION = 'v14.1-worker+settle5s';
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/chromium-browser';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function envBool(name, fallback = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}
function envInt(name, fallback, min, max) {
  let v = Number(process.env[name]);
  if (!Number.isFinite(v)) v = fallback;
  v = Math.round(v);
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  return v;
}
function normalizeBase(v) {
  return String(v || '').trim().replace(/\/+$/, '');
}
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function debug(...args) {
  if (CONFIG.debug) log('[debug]', ...args);
}
function redactUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    for (const key of [...u.searchParams.keys()]) {
      if (/token|auth|key|secret/i.test(key)) u.searchParams.set(key, 'REDACTED');
    }
    return u.toString();
  } catch (_) {
    return '';
  }
}

function bookingTargetUrl(raw) {
  const u = new URL(String(raw || ''));
  // El worker HA parte de un perfil Chromium nuevo, sin las preferencias
  // de moneda que sí tiene el Chrome de escritorio. Fijamos EUR para que
  // el Reader v14 reciba exactamente el mismo formato comercial.
  u.searchParams.set('selected_currency', 'EUR');
  return u.toString();
}

function hasComparablePrice(payload) {
  const meta = (payload && payload.meta) || {};
  const vals = [
    meta.comparison_total,
    meta.recommended_total,
    meta.booking_recommended_total,
    meta.lowest_visible_total,
  ];
  if (vals.some((v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0)) return true;
  const offers = Array.isArray(payload && payload.offers) ? payload.offers : [];
  return offers.some((o) => o && o.unit_price !== '' && o.unit_price !== null && Number.isFinite(Number(o.unit_price)) && Number(o.unit_price) > 0);
}

function payloadSummary(payload) {
  const meta = (payload && payload.meta) || {};
  const offers = Array.isArray(payload && payload.offers) ? payload.offers : [];
  const inventory = Array.isArray(payload && payload.inventory_summary) ? payload.inventory_summary : [];
  const priced = offers.filter((o) => o && o.unit_price !== '' && o.unit_price !== null && Number.isFinite(Number(o.unit_price)) && Number(o.unit_price) > 0).length;
  return {
    inventory: inventory.length,
    offers: offers.length,
    priced_offers: priced,
    comparison_total: meta.comparison_total ?? '',
    recommended_total: meta.recommended_total ?? '',
    lowest_visible_total: meta.lowest_visible_total ?? '',
  };
}

const CONFIG = {
  enabled: envBool('B360_ENABLED', true),
  backendBase: normalizeBase(process.env.B360_BACKEND_BASE),
  token: String(process.env.B360_WORKER_TOKEN || '').trim(),
  headless: envBool('B360_HEADLESS', true),
  leaseSeconds: envInt('B360_LEASE_SECONDS', 120, 60, 600),
  claimRetrySeconds: envInt('B360_CLAIM_RETRY_SECONDS', 5, 2, 30),
  navigationTimeoutMs: envInt('B360_NAVIGATION_TIMEOUT_SECONDS', 60, 20, 180) * 1000,
  readerDeadlineMs: envInt('B360_READER_DEADLINE_SECONDS', 18, 10, 60) * 1000,
  locale: String(process.env.B360_LOCALE || 'es-ES'),
  timezone: String(process.env.B360_TIMEZONE || 'Europe/Madrid'),
  debug: envBool('B360_DEBUG', false),
};

function isAllowedBookingUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' && /(^|\.)booking\.com$/i.test(u.hostname);
  } catch (_) {
    return false;
  }
}

async function api(endpoint, body) {
  if (!CONFIG.backendBase || !CONFIG.token) throw new Error('Worker sin configurar: backend_base/worker_token');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  try {
    const response = await fetch(`${CONFIG.backendBase}/api/revenue/worker/${endpoint}.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bulin-Worker-Token': CONFIG.token,
        'Authorization': `Bearer ${CONFIG.token}`,
        'User-Agent': `Bulin360RevenueWorker/${WORKER_VERSION}`,
      },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data.ok === false) {
      const code = data && data.code ? ` [${data.code}]` : '';
      const cv = data && data.claim_version ? ` claim=${data.claim_version}` : '';
      throw new Error(`${data.error || `HTTP ${response.status}`}${code}${cv}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function heartbeat(jobId) {
  try {
    return await api('heartbeat', {
      job_id: Number(jobId || 0),
      lease_seconds: CONFIG.leaseSeconds,
      ext_version: WORKER_VERSION,
      reader_version: READER_VERSION,
    });
  } catch (error) {
    debug('heartbeat error:', error.message || error);
    return null;
  }
}

async function submit(job, attemptId, envelope, payload) {
  const env = envelope || {};
  return api('result', {
    job_id: job.id,
    attempt_id: attemptId,
    status: env.status || 'ERROR',
    reason: env.status_reason || '',
    final_url: env.final_url || '',
    duration_ms: env.duration_ms || 0,
    reader_version: READER_VERSION,
    ext_version: WORKER_VERSION,
    payload: payload || {},
    envelope: env,
    error_detail: Array.isArray(env.validation_errors) ? env.validation_errors.join('; ') : '',
  });
}

const SCRIPT_DIR = __dirname;
const coreSource = fs.readFileSync(path.join(SCRIPT_DIR, 'booking-reader-core.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(SCRIPT_DIR, 'booking-reader-worker.js'), 'utf8');
const readerSource = fs.readFileSync(path.join(SCRIPT_DIR, 'reader-v14.js'), 'utf8');

async function injectReader(page) {
  await page.addScriptTag({ content: coreSource });
  await page.addScriptTag({ content: workerSource });
  await page.addScriptTag({ content: readerSource });
}

function contextForJob(job, attemptId) {
  let slug = '';
  try {
    slug = new URL(job.url).pathname.split('/').pop()?.replace(/\.html$/i, '') || '';
  } catch (_) {}
  return {
    job_id: String(job.id || ''),
    attempt_id: String(attemptId || ''),
    competitor_id: String(job.competitor_id || ''),
    checkin: job.checkin || '',
    checkout: job.checkout || '',
    adults: Number(job.requested_adults || 0),
    property_slug: slug,
  };
}

async function pageContext(page, ctx) {
  return page.evaluate((c) => globalThis.BulinBookingReaderCore.contextMatchesUrl(location.href, c), ctx);
}

async function waitForStableContext(page, ctx, timeoutMs = 22000) {
  const started = Date.now();
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const current = page.url();
    if (!isAllowedBookingUrl(current)) {
      stable = 0;
      await sleep(1000);
      continue;
    }
    let match = null;
    try { match = await pageContext(page, ctx); } catch (_) {}
    if (match && match.ok) {
      stable += 1;
      if (stable >= 2) return true;
      await sleep(1200);
    } else {
      stable = 0;
      await sleep(2500);
    }
  }
  return false;
}

async function navigateForJob(page, job, ctx) {
  const targetUrl = bookingTargetUrl(job.url);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeoutMs });
  await injectReader(page);
  let ok = await waitForStableContext(page, ctx, 22000);
  if (!ok) {
    debug('context not stable after first navigation; retrying clean goto', redactUrl(job.url));
    await page.goto('about:blank', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeoutMs });
    await injectReader(page);
    ok = await waitForStableContext(page, ctx, 22000);
  }
  if (!ok) return false;

  await sleep(5000);
  let match = null;
  try { match = await pageContext(page, ctx); } catch (_) {}
  return !!(match && match.ok);
}

async function runReader(page, ctx) {
  return page.evaluate(async ({ ctx, readerDeadlineMs, readerVersion, workerVersion }) => {
    const started = Date.now();
    const Core = globalThis.BulinBookingReaderCore;
    const Worker = globalThis.BulinBookingReaderWorker;
    if (!Core || !Worker || !globalThis.BulinBookingReadV14) throw new Error('reader_components_missing');

    const match = Core.contextMatchesUrl(location.href, ctx);
    if (!match.ok) {
      return { retry: true, reason: 'context_mismatch', validation_errors: match.errors, actual: match.actual, final_url: location.href };
    }

    const propertyState = Core.propertyIdentity(location.href, ctx);
    const cls = Core.classifyPage(document, location);
    if (cls.status) {
      const terminalPayload = { meta: { checkin: ctx.checkin, checkout: ctx.checkout, adults: ctx.adults, url: location.href, captured_at: new Date().toISOString() } };
      const env = Core.makeEnvelope(terminalPayload, ctx, {
        reader_version: readerVersion,
        worker_version: workerVersion,
        status: cls.status,
        status_reason: cls.reason,
        duration_ms: Date.now() - started,
        final_url: location.href,
      });
      return { envelope: env, payload: terminalPayload };
    }

    let env = await Worker.execute({
      deadlineMs: readerDeadlineMs,
      readerVersion,
      workerVersion,
      context: ctx,
      readBookingPage: async () => globalThis.BulinBookingReadV14(),
    });

    const payload = env.payload || {};
    const hasCommercialData = (Array.isArray(payload.inventory_summary) && payload.inventory_summary.length > 0)
      || (Array.isArray(payload.offers) && payload.offers.length > 0)
      || (Array.isArray(payload.rows) && payload.rows.length > 0);

    if (!hasCommercialData && propertyState.redirected && [
      Core.RESULT_STATUSES.PARCIAL,
      Core.RESULT_STATUSES.ESTRUCTURA_CAMBIADA,
    ].includes(env.status)) {
      env = Core.makeEnvelope(payload, ctx, {
        reader_version: readerVersion,
        worker_version: workerVersion,
        status: Core.RESULT_STATUSES.PROPERTY_NOT_AVAILABLE_FOR_DATES,
        status_reason: propertyState.reason,
        duration_ms: Date.now() - started,
        final_url: location.href,
      });
    }
    return { envelope: env, payload: env.payload || {} };
  }, { ctx, readerDeadlineMs: CONFIG.readerDeadlineMs, readerVersion: READER_VERSION, workerVersion: WORKER_VERSION });
}

function contextFailureEnvelope(job, attemptId, durationMs) {
  return {
    schema: 'bulin360.booking.reader-envelope.v1',
    reader_version: READER_VERSION,
    worker_version: WORKER_VERSION,
    job_id: String(job.id),
    attempt_id: String(attemptId),
    competitor_id: String(job.competitor_id || ''),
    status: 'INCONSISTENTE',
    status_reason: 'context_not_confirmed',
    fields_missing: [],
    validation_errors: ['context_not_confirmed'],
    validation_warnings: [],
    final_url: '',
    duration_ms: durationMs,
    captured_at: nowIso(),
    payload: {},
  };
}

async function processJob(browser, claim) {
  const job = claim.job;
  const attemptId = claim.attempt_id;
  const ctx = contextForJob(job, attemptId);
  const started = Date.now();

  log(`[job ${job.id}]`, job.competitor_name || 'competidor', `${job.requested_adults || 0}p`, job.checkin, '->', job.checkout);
  await heartbeat(job.id);

  if (!isAllowedBookingUrl(job.url)) {
    const env = {
      schema: 'bulin360.booking.reader-envelope.v1',
      reader_version: READER_VERSION,
      worker_version: WORKER_VERSION,
      job_id: String(job.id),
      attempt_id: String(attemptId),
      competitor_id: String(job.competitor_id || ''),
      status: 'ERROR',
      status_reason: 'invalid_job_url',
      fields_missing: [],
      validation_errors: ['invalid_job_url'],
      validation_warnings: [],
      final_url: '',
      duration_ms: 0,
      captured_at: nowIso(),
      payload: {},
    };
    const out = await submit(job, attemptId, env, {});
    return { paused: !!out.run_paused };
  }

  const page = await browser.newPage();
  const hb = setInterval(() => heartbeat(job.id), Math.max(30000, Math.floor(CONFIG.leaseSeconds * 500)));
  try {
    await page.setViewport({ width: 1365, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': `${CONFIG.locale},es;q=0.9,en;q=0.7` });
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeoutMs);
    page.setDefaultTimeout(Math.max(CONFIG.readerDeadlineMs, 30000));

    const contextOk = await navigateForJob(page, job, ctx).catch((error) => {
      debug(`[job ${job.id}] navigation`, error.message || error);
      return false;
    });

    if (!contextOk) {
      const env = contextFailureEnvelope(job, attemptId, Date.now() - started);
      const out = await submit(job, attemptId, env, {});
      log(`[job ${job.id}] INCONSISTENTE context_not_confirmed`);
      return { paused: !!out.run_paused };
    }

    let result;
    try {
      result = await runReader(page, ctx);

      // En Home Assistant Chromium puede pintar selectores/stock antes que los
      // precios. Para trabajos PRICE no aceptamos la primera lectura vacía:
      // reintentamos sobre el mismo DOM ya estabilizado antes de clasificarla.
      if (String(job.run_kind || '').toLowerCase() === 'price') {
        for (let priceTry = 1; priceTry <= 3; priceTry++) {
          const payloadNow = (result && result.payload) || {};
          if (hasComparablePrice(payloadNow)) break;
          if (result && result.envelope && !['OK', 'PARCIAL'].includes(String(result.envelope.status || ''))) break;

          debug(`[job ${job.id}] precio aún no resuelto · relectura ${priceTry}/3`, payloadSummary(payloadNow));
          await heartbeat(job.id);
          await sleep(5000);

          const matchAfterDelay = await pageContext(page, ctx).catch(() => null);
          if (!matchAfterDelay || !matchAfterDelay.ok) break;
          result = await runReader(page, ctx);
        }

        const finalPayload = (result && result.payload) || {};
        if (result && result.envelope && result.envelope.status === 'OK' && !hasComparablePrice(finalPayload)) {
          result.envelope.status = 'PARCIAL';
          result.envelope.status_reason = 'price_not_resolved_after_retries';
          const missing = Array.isArray(result.envelope.fields_missing) ? result.envelope.fields_missing : [];
          if (!missing.includes('meta.comparison_total')) missing.push('meta.comparison_total');
          result.envelope.fields_missing = missing;
        }
      }
    } catch (error) {
      const env = {
        schema: 'bulin360.booking.reader-envelope.v1', reader_version: READER_VERSION, worker_version: WORKER_VERSION,
        job_id: String(job.id), attempt_id: String(attemptId), competitor_id: String(job.competitor_id || ''),
        status: 'ERROR', status_reason: `reader_exception:${String(error.message || error)}`,
        fields_missing: [], validation_errors: [], validation_warnings: [], final_url: page.url(),
        duration_ms: Date.now() - started, captured_at: nowIso(), payload: {},
      };
      result = { envelope: env, payload: {} };
    }

    if (result && result.payload) {
      debug(`[job ${job.id}] resumen lector`, payloadSummary(result.payload));
    }

    if (result && result.retry && result.reason === 'context_mismatch') {
      const env = contextFailureEnvelope(job, attemptId, Date.now() - started);
      const out = await submit(job, attemptId, env, {});
      return { paused: !!out.run_paused };
    }

    const env = result.envelope || {};
    const payload = result.payload || {};
    const out = await submit(job, attemptId, env, payload);
    log(`[job ${job.id}] ${env.status || 'ERROR'}${out.run_paused ? ' -> PAUSADO' : ''}`);
    return { paused: !!out.run_paused };
  } finally {
    clearInterval(hb);
    await page.close().catch(() => {});
  }
}

async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    `--lang=${CONFIG.locale}`,
  ];
  return puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: CONFIG.headless,
    userDataDir: '/data/chromium',
    args,
    env: { ...process.env, TZ: CONFIG.timezone },
  });
}

async function main() {
  log(`Bulin360 Revenue Worker ${WORKER_VERSION} (source Chrome ${SOURCE_EXTENSION_VERSION}, reader ${READER_VERSION})`);
  if (!CONFIG.enabled) {
    log('Worker desactivado por configuración.');
    while (true) await sleep(60000);
  }
  if (!CONFIG.backendBase || !CONFIG.token) throw new Error('Configura backend_base y worker_token en el add-on');

  let browser = await launchBrowser();
  process.on('SIGTERM', async () => { await browser.close().catch(() => {}); process.exit(0); });
  process.on('SIGINT', async () => { await browser.close().catch(() => {}); process.exit(0); });

  while (true) {
    try {
      if (!browser.connected) browser = await launchBrowser();
      const claim = await api('claim', {
        lease_seconds: CONFIG.leaseSeconds,
        ext_version: WORKER_VERSION,
        reader_version: READER_VERSION,
      });
      if (claim.action === 'idle') {
        const retry = Math.max(2, Math.min(30, Number(claim.retry_after_seconds || CONFIG.claimRetrySeconds)));
        debug('idle', claim.queue || {}, `retry=${retry}s`);
        await sleep(retry * 1000);
        continue;
      }
      if (claim.action !== 'job' || !claim.job) throw new Error('Respuesta claim no válida');
      const result = await processJob(browser, claim);
      if (result.paused) {
        log('Barrido pausado por CAPTCHA/BLOQUEADO. Esperando antes de volver a consultar la cola.');
        await sleep(30000);
      }
    } catch (error) {
      log('ERROR', String(error && error.message || error));
      await sleep(5000);
    }
  }
}

main().catch((error) => {
  log('FATAL', String(error && error.stack || error));
  process.exit(1);
});
