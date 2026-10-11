/*
 * Bulín 360 · lector de canales (Airbnb, VRBO y motores directos) · core compartido 1.0.0.
 * ÚNICA fuente: la extensión Revenue Worker lo inyecta en la pestaña y el worker de Home Assistant lo carga con addScriptTag.
 * Protocolo: bulin360.channel.reader-envelope.v1 (ver api/revenue/_channels.php). run(job) devuelve el cuerpo del resultado:
 *   {status, reason, listing:{external_id}, calendar:[{date,available,checkin,checkout,min_nights,price}], price:{checkin,checkout,guests,total,
 *    accommodation_total,fees_total,currency,min_nights,rooms_available}, probe:{engine,engine_url}, final_url, error_detail}
 * Basado en páginas reales revisadas el 11-10-2026:
 *  - Airbnb: calendario por la API de la propia página (PdpAvailabilityCalendarV2Query, 12 meses, sin precio por día);
 *    precio en el bloque de reserva [data-testid="book-it-default"] («300 € en total», tasas incluidas).
 *  - VRBO: calendario en el selector de fechas (.uitk-day-button + uitk-background-available|unavailable|am-unavailable|pm-unavailable,
 *    2 meses por pantalla y botón «siguiente»); precio en [data-stid="product-price-summary"] («275 € … por 2 noches … incluye tasas»).
 *  - Amenitiz: API pública del motor en la web del alojamiento (/<idioma>/api_public/v1/client_booking_engine/availability y room_availability).
 *  - Avirato: booking.avirato.com/?code=…&startDate&endDate&adults&rooms → «160,00 € en total» por habitación o «Sin disponibilidad».
 *  - MisterPlan (reservaonline.support, mrplan.io), Availroom (bookingv3.availroom.com), Avaibook…: solo detección por la sonda.
 * Las funciones parse… y detect… son puras y se prueban en Node (tests/extension-channels.test.mjs).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BulinChannelReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const READER_VERSION = 'ch1.0.0';
  const AIRBNB_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20'; // clave pública de la web de Airbnb (también se lee de la página)
  const AIRBNB_CAL_HASH = 'bfd57b0552df2e8870f68d5cf501868a0e08417267469f55faefa78aca0234f4'; // respaldo si la página aún no lo ha pedido
  const ENGINES = {
    avirato: ['avirato.com', 'avirato.es'], availroom: ['availroom.com', 'availroom.es'], misterplan: ['misterplan.es', 'misterplan.com', 'reservaonline.support', 'mrplan.io'],
    avaibook: ['avaibook.com', 'avaibook.net', 'avaibook.es'], amenitiz: ['amenitiz.io', 'amenitiz.com', 'amenitiz.net'], lodgify: ['lodgify.com'], smoobu: ['smoobu.com'], beds24: ['beds24.com'],
    octorate: ['octorate.com'], cloudbeds: ['cloudbeds.com'], roomcloud: ['roomcloud.net'], neobookings: ['neobookings.com'], mirai: ['mirai.com'], siteminder: ['thebookingbutton.com', 'siteminder.com'], hotetec: ['hotetec.com'],
  };
  const SUPPORTED_DIRECT = ['amenitiz', 'avirato'];
  const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

  const s = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const nights = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

  /* ───────── Puras ───────── */

  /** «1.234,56 €», «€ 1,234.56», «300 €» → número; null si no hay importe. */
  function parseEuroAmount(text) {
    const t = s(text); const m = t.match(/(?:€\s*)?(\d{1,3}(?:[.,\s  ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|EUR)?/);
    if (!m || !/€|EUR/.test(t)) return null;
    let v = m[1].replace(/[\s  ]/g, '');
    if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.'); else if (/\.\d{1,2}$/.test(v) && /,/.test(v)) v = v.replace(/,/g, ''); else if (/^\d{1,3}(\.\d{3})+$/.test(v)) v = v.replace(/\./g, ''); else if (/^\d{1,3}(,\d{3})+$/.test(v)) v = v.replace(/,/g, '');
    const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }
  /** Todos los importes «X € en total» de un texto (Avirato, Airbnb). */
  function totalsInText(text) {
    return [...String(text || '').matchAll(/(\d[\d.\s  ]*(?:,\d{1,2})?)\s*€\s*(?:en total|in total|total)/gi)].map((m) => parseEuroAmount(m[1] + ' €')).filter((x) => x != null);
  }
  function classifyBlock(text, title) {
    const t = s(text).slice(0, 20000) + ' ' + s(title);
    if (/captcha|verify you are human|verifica que eres humano|comprueba que eres humano|are you a robot|eres un robot|press (?:&|and) hold/i.test(t)) return { status: 'CAPTCHA', reason: 'captcha_or_human_verification' };
    if (/access denied|request blocked|too many requests|error 429|tr[aá]fico inusual|unusual traffic|acceso denegado/i.test(t)) return { status: 'BLOQUEADO', reason: 'block_or_rate_limit' };
    return null;
  }
  function airbnbGlobalId(id) { const raw = 'DemandStayListing:' + id; return typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64'); }
  /** Respuesta de PdpAvailabilityCalendarV2Query → días. */
  function parseAirbnbCalendar(json) {
    const months = json && json.data && json.data.node && json.data.node.pdpAvailabilityCalendar && json.data.node.pdpAvailabilityCalendar.calendarMonths;
    if (!Array.isArray(months)) return null;
    const out = [];
    for (const m of months) for (const d of (m.days || [])) {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.calendarDate || '')) continue;
      out.push({ date: d.calendarDate, available: !!d.available, checkin: d.availableForCheckin == null ? null : !!d.availableForCheckin, checkout: d.availableForCheckout == null ? null : !!d.availableForCheckout, min_nights: Number(d.minNights) > 0 ? Number(d.minNights) : null, price: null });
    }
    return out;
  }
  /** Texto del bloque de reserva de Airbnb → total / no disponible / estancia mínima. */
  function parseAirbnbBookIt(text) {
    const t = s(text);
    if (/fechas no disponibles|no est[aá] disponible|those dates are(?:n['’]t| not) available|dates? (?:are )?unavailable/i.test(t)) return { unavailable: true };
    const mn = t.match(/estancia m[ií]nima (?:es )?de (\d+)|minimum stay (?:is )?(\d+)/i); if (mn) return { restriction: true, min_nights: Number(mn[1] || mn[2]) };
    const tot = totalsInText(t); if (tot.length) return { total: tot[0] };
    return {};
  }
  /** «viernes, 13 de noviembre de 2026» / «Friday, November 13, 2026» → 2026-11-13. */
  function parseDayLabel(label) {
    const t = s(label).toLowerCase();
    let m = t.match(/(\d{1,2}) de ([a-zé]+) de (\d{4})/); if (m && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1]);
    m = t.match(/([a-z]+) (\d{1,2}),? (\d{4})/); if (m && MONTHS[m[1]]) return iso(+m[3], MONTHS[m[1]], +m[2]);
    return null;
  }
  /** Clase de fondo del día en VRBO → estado de la noche. am-unavailable: la mañana está ocupada (salida de otro), la noche libre. */
  function vrboDayState(cls) {
    const m = String(cls || '').match(/uitk-background-((?:am-|pm-)?unavailable|available)/); if (!m) return null;
    return { available: { available: true, checkin: true, checkout: true }, 'am-unavailable': { available: true, checkin: true, checkout: false }, 'pm-unavailable': { available: false, checkin: false, checkout: true }, unavailable: { available: false, checkin: false, checkout: false } }[m[1]];
  }
  function parseVrboPriceSummary(text) {
    const t = s(text); if (!t) return {};
    if (/no disponible|not available|fechas no v[aá]lidas|unavailable/i.test(t) && !/€/.test(t)) return { unavailable: true };
    const n = t.match(/por (\d+) noches?|for (\d+) nights?/i);
    return { total: parseEuroAmount(t.split(/\n| El precio| The price/)[0]) ?? parseEuroAmount(t), nights: n ? Number(n[1] || n[2]) : null, taxes_included: /incluye tasas|includes taxes/i.test(t) };
  }
  function parseAmenitizAvailability(json) {
    const a = json && json.data && json.data.availabilities; if (!Array.isArray(a)) return null;
    return a.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date || '')).map((d) => ({ date: d.date, available: !!d.is_available && !d.closed, checkin: !d.closed_to_arrival, checkout: !d.closed_to_departure, min_nights: Number(d.min_stay) > 0 ? Number(d.min_stay) : null, price: null }));
  }
  /** room_availability → precio más bajo para el grupo (habitaciones con capacidad suficiente) y unidades disponibles. */
  function parseAmenitizRooms(json, guests) {
    const rooms = json && json.data && json.data.rooms; if (!Array.isArray(rooms)) return null;
    const g = Number(guests) || 1; let best = null; let units = 0; let fit = 0;
    for (const r of rooms) {
      const cap = Number(r.max_occupancy || r.max_adults || 0); if (cap && cap < g) continue; fit++; units += Number(r.number_of_rooms || 1);
      for (const p of (r.rate_plans || [])) { const v = Number(p.total_price_with_allocation || p.total_price); if (v > 0 && (best == null || v < best)) best = Math.round(v * 100) / 100; }
    }
    return { total: best, rooms_available: units, rooms_listed: rooms.length, rooms_fit: fit, currency: (json.data.currency || 'EUR').toUpperCase(), city_tax_included: json.data.hotel_city_tax_included !== false };
  }
  function parseAviratoText(text) {
    const t = String(text || '');
    if (/buscando\.\.\.|actualizando disponibilidad/i.test(t) && !/€/.test(t)) return { loading: true };
    const tot = totalsInText(t); const rooms = (t.match(/Habitaciones\s*\n\s*(\d+)/) || [])[1];
    if (tot.length) return { total: Math.min(...tot), rooms_available: rooms != null ? Number(rooms) : null };
    if (/sin disponibilidad|no hay disponibilidad|no availability/i.test(t)) return { unavailable: true, rooms_available: 0 };
    return {};
  }
  /** Motor de reservas a partir del HTML y la URL de la web del competidor. */
  function detectEngine(html, pageUrl) {
    // El propio lector puede estar en el DOM como <script> (Home Assistant lo inyecta con addScriptTag): nunca cuenta como firma.
    const h = String(html || '').replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*BulinChannelReader(?:(?!<\/script>)[\s\S])*<\/script>/gi, ''); let origin = ''; try { origin = new URL(pageUrl).origin; } catch (e) { /* sin URL */ }
    const links = [...h.matchAll(/(?:src|href|action|data-src)\s*=\s*["']([^"']+)["']/gi)].map((m) => { try { return new URL(m[1].replace(/&amp;/g, '&'), pageUrl || undefined).href; } catch (e) { return ''; } }).filter(Boolean);
    const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
    const matches = (host, d) => host === d || host.endsWith('.' + d);
    const score = {}; const first = {};
    for (const u of links) { const host = hostOf(u); for (const [k, ds] of Object.entries(ENGINES)) if (ds.some((d) => matches(host, d))) { score[k] = (score[k] || 0) + 1; if (!first[k] && !/\.(js|css|png|jpe?g|svg|woff2?)(\?|$)/i.test(u)) first[k] = u; } }
    if (/cloudinary-cloud-name["']\s+content=["']amenitiz|desarrollado con amenitiz|powered by amenitiz|api_public\/v1\/client_booking_engine/i.test(h)) {
      score.amenitiz = (score.amenitiz || 0) + 3;
      const lang = (links.find((u) => origin && u.startsWith(origin) && /\/[a-z]{2}\/booking\/room/.test(u)) || '').match(/\/([a-z]{2})\/booking\/room/);
      first.amenitiz = first.amenitiz || (origin ? origin + '/' + (lang ? lang[1] : 'es') + '/booking/room' : '');
    }
    const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    if (!best) return { engine: null, engine_url: null, candidates: [] };
    let url = first[best[0]] || null; if (url && !/^https:/i.test(url)) url = null;
    return { engine: best[0], engine_url: url, candidates: Object.keys(score) };
  }
  /** Enlaces de la misma web que llevan a reservar (para que la sonda los mire si la portada no basta). */
  function bookingLinks(html, pageUrl) {
    let origin = ''; try { origin = new URL(pageUrl).origin; } catch (e) { return []; }
    const out = [];
    for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) { let u; try { u = new URL(m[1], pageUrl).href; } catch (e) { continue; } if (u.startsWith(origin) && /reserv|booking|book-now|disponibilidad/i.test(u) && !out.includes(u) && u !== pageUrl) out.push(u); }
    return out.slice(0, 3);
  }

  /* ───────── En la página ───────── */

  function defaultEnv() {
    return { doc: typeof document !== 'undefined' ? document : null, loc: typeof location !== 'undefined' ? location : null, fetch: typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      perf: typeof performance !== 'undefined' ? performance : null, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
  }
  async function waitFor(env, fn, timeoutMs, stepMs) { const t0 = env.now(); for (;;) { const v = await fn(); if (v) return v; if (env.now() - t0 > timeoutMs) return null; await env.sleep(stepMs || 500); } }
  const result = (status, extra) => Object.assign({ status, reader_version: READER_VERSION }, extra || {});
  function bodyText(env) { return env.doc && env.doc.body ? String(env.doc.body.innerText || env.doc.body.textContent || '') : ''; }
  function blocked(env) { return classifyBlock(bodyText(env), env.doc && env.doc.title); }
  function clampDays(days, job) { return days.filter((d) => (!job.range_from || d.date >= job.range_from) && (!job.range_to || d.date <= job.range_to)); }
  function qp(env) { try { return new URL(env.loc.href).searchParams; } catch (e) { return new URLSearchParams(); } }

  async function airbnbCalendar(job, env) {
    const id = String(job.external_id || ''); if (!/^\d+$/.test(id)) return result('ERROR', { reason: 'missing_external_id' });
    const pathId = (String(env.loc.pathname || '').match(/\/rooms\/(?:plus\/)?(\d+)/) || [])[1]; if (pathId && pathId !== id) return result('INCONSISTENTE', { reason: 'property_mismatch', listing: { external_id: pathId } });
    const key = ((env.doc && env.doc.documentElement ? env.doc.documentElement.innerHTML : '').match(/"api_config":\{"key":"([a-z0-9]+)"/) || [])[1] || AIRBNB_KEY;
    const seen = await waitFor(env, () => (env.perf ? env.perf.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('PdpAvailabilityCalendar')) : null), 12000, 600);
    const base = seen ? new URL(seen) : new URL(env.loc.origin + '/api/v3/PdpAvailabilityCalendarV2Query/' + AIRBNB_CAL_HASH + '?operationName=PdpAvailabilityCalendarV2Query&locale=es&currency=EUR');
    if (!seen) base.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: AIRBNB_CAL_HASH } }));
    base.searchParams.set('currency', 'EUR');
    const from = job.range_from || new Date().toISOString().slice(0, 10); const to = job.range_to || addDays(from, 365); let days = []; let cursor = from.slice(0, 7);
    for (let i = 0; i < 3 && cursor <= to.slice(0, 7); i++) {
      const [y, m] = cursor.split('-').map(Number);
      base.searchParams.set('variables', JSON.stringify({ listingId: airbnbGlobalId(id), input: { count: 12, month: m, year: y, returnPropertyLevelCalendarIfApplicable: false } }));
      const r = await env.fetch(base.toString(), { headers: { 'X-Airbnb-API-Key': key, Accept: 'application/json' }, credentials: 'include' });
      if (r.status === 429 || r.status === 403) return result('BLOQUEADO', { reason: 'airbnb_http_' + r.status });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      const part = parseAirbnbCalendar(j); if (!part) return result('ESTRUCTURA_CAMBIADA', { reason: 'airbnb_calendar_shape', error_detail: 'HTTP ' + r.status });
      days = days.concat(part); const nm = new Date(Date.UTC(y, m - 1 + 12, 1)); cursor = nm.toISOString().slice(0, 7);
    }
    days = [...new Map(days.map((d) => [d.date, d])).values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return result('OK', { listing: { external_id: id }, calendar: clampDays(days, job), currency: 'EUR', final_url: env.loc.href });
  }
  async function airbnbPrice(job, env) {
    const p = qp(env); const pathId = (String(env.loc.pathname || '').match(/\/rooms\/(?:plus\/)?(\d+)/) || [])[1];
    if (pathId && job.external_id && pathId !== String(job.external_id)) return result('INCONSISTENTE', { reason: 'property_mismatch', listing: { external_id: pathId } });
    if (p.get('check_in') !== job.checkin || p.get('check_out') !== job.checkout || Number(p.get('adults')) !== Number(job.guests)) return result('INCONSISTENTE', { reason: 'context_mismatch', error_detail: 'url_params' });
    const read = await waitFor(env, () => {
      const b = env.doc.querySelector('[data-testid="book-it-default"]') || env.doc.querySelector('[data-section-id="BOOK_IT_SIDEBAR"]');
      const txt = b ? [b.innerText || b.textContent, ...[...b.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label'))].join('\n') : '';
      const r = parseAirbnbBookIt(txt || bodyText(env).slice(0, 0)); return r.total || r.unavailable || r.restriction ? r : (/fechas no disponibles|those dates are not available/i.test(bodyText(env)) ? { unavailable: true } : null);
    }, 20000, 700);
    const base = { listing: { external_id: pathId || job.external_id }, final_url: env.loc.href };
    if (!read) return result('ESTRUCTURA_CAMBIADA', Object.assign(base, { reason: 'airbnb_bookit_not_found' }));
    if (read.unavailable) return result('SIN_DISPONIBILIDAD', Object.assign(base, { reason: 'dates_not_available', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests } }));
    if (read.restriction) return result('RESTRICCION', Object.assign(base, { reason: 'min_nights', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests, min_nights: read.min_nights } }));
    return result('OK', Object.assign(base, { price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests, total: read.total, currency: 'EUR' } }));
  }
  async function vrboCalendar(job, env) {
    const d = env.doc; const opened = await waitFor(env, () => { if (d.querySelector('.uitk-day-button')) return true; const t = d.querySelector('[data-stid="uitk-date-selector-input1-default"]'); if (t) t.click(); return false; }, 15000, 800);
    if (!opened) return result('ESTRUCTURA_CAMBIADA', { reason: 'vrbo_calendar_not_found', final_url: env.loc.href });
    const to = job.range_to || addDays(new Date().toISOString().slice(0, 10), 365); const map = new Map();
    const readAll = () => { for (const b of d.querySelectorAll('.uitk-day-button')) { const lab = b.querySelector('.uitk-day-aria-label'); const date = parseDayLabel(lab && lab.getAttribute('aria-label')); const bg = b.querySelector('[class*="uitk-background-"]'); const st = vrboDayState(bg && bg.className); if (date && st) map.set(date, Object.assign({ date, min_nights: null, price: null }, st)); } };
    for (let i = 0; i < 9; i++) {
      readAll(); const last = [...map.keys()].sort().pop(); if (last && last >= to) break;
      const n = d.querySelector('[data-stid="uitk-calendar-navigation-controls-next-button"]'); if (!n || n.disabled) break; n.click(); await env.sleep(700);
    }
    if (!map.size) return result('ESTRUCTURA_CAMBIADA', { reason: 'vrbo_days_unreadable', final_url: env.loc.href });
    return result('OK', { listing: { external_id: job.external_id }, calendar: clampDays([...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), job), currency: 'EUR', final_url: env.loc.href });
  }
  async function vrboPrice(job, env) {
    const p = qp(env); const ci = p.get('chkin') || p.get('startDate'); const co = p.get('chkout') || p.get('endDate');
    if (ci !== job.checkin || co !== job.checkout || Number(p.get('adults')) !== Number(job.guests)) return result('INCONSISTENTE', { reason: 'context_mismatch', error_detail: 'url_params' });
    const read = await waitFor(env, () => { const el = env.doc.querySelector('[data-stid="product-price-summary"]'); const r = parseVrboPriceSummary(el ? el.innerText || el.textContent : ''); if (r.total || r.unavailable) return r;
      return /(?:no est[aá] disponible|not available) (?:para|for) (?:esas|these|las) fechas|fechas no disponibles/i.test(bodyText(env)) ? { unavailable: true } : null; }, 20000, 700);
    const base = { listing: { external_id: job.external_id }, final_url: env.loc.href };
    if (!read) return result('ESTRUCTURA_CAMBIADA', Object.assign(base, { reason: 'vrbo_price_not_found' }));
    if (read.unavailable) return result('SIN_DISPONIBILIDAD', Object.assign(base, { reason: 'dates_not_available', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests } }));
    if (read.nights && read.nights !== nights(job.checkin, job.checkout)) return result('INCONSISTENTE', Object.assign(base, { reason: 'context_mismatch', error_detail: 'nights_' + read.nights }));
    return result('OK', Object.assign(base, { price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests, total: read.total, currency: 'EUR' } }));
  }
  function amenitizBase(env) { const lang = (String(env.loc.pathname || '').match(/^\/([a-z]{2})(?:\/|$)/) || [])[1] || 'es'; return env.loc.origin + '/' + lang + '/api_public/v1/client_booking_engine/'; }
  async function amenitizCalendar(job, env) {
    const from = job.range_from || new Date().toISOString().slice(0, 10); const to = job.range_to || addDays(from, 365); let days = []; let cur = from;
    for (let i = 0; i < 6 && cur <= to; i++) {
      const end = [addDays(cur, 109), to].sort()[0];
      const r = await env.fetch(amenitizBase(env) + 'availability?start_date=' + cur + '&end_date=' + end, { headers: { Accept: 'application/json' }, credentials: 'include' });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      const part = parseAmenitizAvailability(j); if (!part) return result('ESTRUCTURA_CAMBIADA', { reason: 'amenitiz_availability_shape', error_detail: 'HTTP ' + r.status });
      days = days.concat(part); cur = addDays(end, 1);
    }
    return result('OK', { calendar: clampDays(days, job), currency: 'EUR', final_url: env.loc.href });
  }
  async function amenitizPrice(job, env) {
    const r = await env.fetch(amenitizBase(env) + 'room_availability?arrival_date=' + job.checkin + '&departure_date=' + job.checkout + '&total_adults=' + Number(job.guests) + '&total_children=0&children_ages=', { headers: { Accept: 'application/json' }, credentials: 'include' });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    const p = parseAmenitizRooms(j, job.guests); if (!p) return result('ESTRUCTURA_CAMBIADA', { reason: 'amenitiz_rooms_shape', error_detail: 'HTTP ' + r.status });
    const price = { checkin: job.checkin, checkout: job.checkout, guests: job.guests, currency: p.currency, rooms_available: p.rooms_available };
    if (!p.total) return result('SIN_DISPONIBILIDAD', { reason: p.rooms_listed ? 'no_room_for_group' : 'no_rooms', price, final_url: env.loc.href });
    return result('OK', { price: Object.assign(price, { total: p.total }), final_url: env.loc.href });
  }
  async function aviratoPrice(job, env) {
    const p = qp(env); if (p.get('startDate') !== job.checkin || p.get('endDate') !== job.checkout || Number(p.get('adults')) !== Number(job.guests)) return result('INCONSISTENTE', { reason: 'context_mismatch', error_detail: 'url_params' });
    const read = await waitFor(env, () => { const r = parseAviratoText(bodyText(env)); return r.total || r.unavailable ? r : null; }, 25000, 800);
    const price = { checkin: job.checkin, checkout: job.checkout, guests: job.guests, currency: 'EUR' };
    if (!read) return result('ESTRUCTURA_CAMBIADA', { reason: 'avirato_rooms_not_found', final_url: env.loc.href });
    if (read.unavailable) return result('SIN_DISPONIBILIDAD', { reason: 'no_rooms', price: Object.assign(price, { rooms_available: 0 }), final_url: env.loc.href });
    return result('OK', { price: Object.assign(price, { total: read.total, rooms_available: read.rooms_available }), final_url: env.loc.href });
  }
  async function probe(job, env) {
    const html = env.doc && env.doc.documentElement ? env.doc.documentElement.outerHTML : '';
    let det = detectEngine(html, env.loc.href);
    if (!det.engine) for (const u of bookingLinks(html, env.loc.href)) {
      try { const r = await env.fetch(u, { credentials: 'include' }); const h = await r.text(); const d2 = detectEngine(h, u); if (d2.engine) { det = d2; break; } } catch (e) { /* siguiente enlace */ }
    }
    return result('OK', { probe: { engine: det.engine, engine_url: det.engine_url, candidates: det.candidates }, final_url: env.loc.href });
  }

  /** Ejecuta el trabajo en la página actual. Nunca lanza: los fallos vuelven como ERROR con el detalle. */
  async function run(job, envIn) {
    const env = Object.assign(defaultEnv(), envIn || {}); const t0 = env.now();
    try {
      await waitFor(env, () => env.doc && env.doc.readyState !== 'loading', 10000, 300);
      const b = blocked(env); if (b) return result(b.status, { reason: b.reason, final_url: env.loc.href, duration_ms: env.now() - t0 });
      const k = job.run_kind; const ch = job.channel; const eng = job.engine;
      let r;
      if (k === 'probe') r = await probe(job, env);
      else if (ch === 'airbnb') r = k === 'calendar' ? await airbnbCalendar(job, env) : await airbnbPrice(job, env);
      else if (ch === 'vrbo') r = k === 'calendar' ? await vrboCalendar(job, env) : await vrboPrice(job, env);
      else if (ch === 'direct' && eng === 'amenitiz') r = k === 'calendar' ? await amenitizCalendar(job, env) : await amenitizPrice(job, env);
      else if (ch === 'direct' && eng === 'avirato' && k === 'price') r = await aviratoPrice(job, env);
      else r = result('ERROR', { reason: 'unsupported_' + ch + '_' + (eng || '') + '_' + k });
      const b2 = r.status !== 'OK' ? blocked(env) : null; if (b2) r = result(b2.status, { reason: b2.reason, final_url: env.loc.href });
      r.duration_ms = env.now() - t0; return r;
    } catch (e) { return result('ERROR', { reason: 'reader_exception', error_detail: String(e && e.message || e).slice(0, 500), duration_ms: env.now() - t0, final_url: env.loc && env.loc.href }); }
  }
  /** Capacidades que anuncia el worker (claim.capabilities). */
  function capabilities(opts) { const o = opts || {}; return { channels: o.direct === false ? ['airbnb', 'vrbo'] : ['airbnb', 'vrbo', 'direct'], direct_engines: SUPPORTED_DIRECT.slice(), channel_reader: VERSION }; }

  return { VERSION, READER_VERSION, SUPPORTED_DIRECT, run, capabilities, parseEuroAmount, totalsInText, classifyBlock, airbnbGlobalId, parseAirbnbCalendar, parseAirbnbBookIt, parseDayLabel, vrboDayState,
    parseVrboPriceSummary, parseAmenitizAvailability, parseAmenitizRooms, parseAviratoText, detectEngine, bookingLinks, _internal: { airbnbCalendar, airbnbPrice, vrboPrice, amenitizCalendar, amenitizPrice, aviratoPrice, probe, addDays } };
});
