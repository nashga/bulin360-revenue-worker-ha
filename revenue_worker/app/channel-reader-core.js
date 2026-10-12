/*
 * Bulín 360 · lector de canales (Airbnb, VRBO y motores directos) · core compartido 1.1.0 (motores directos: Availroom v3, MisterPlan, Avaibook, HBook y Thelis).
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
 *  - Availroom v3: API pública bookingv3.availroom.com/api/booking-engine (environmentId + propertyId; roomTypes con price, available, unitsFree).
 *  - MisterPlan: JSONP mrplan.io …/accion.TSimpleSearch.php (id_casa + id_punto_venta) → HTML por habitación «Sólo 1 Disponible … para 2 … Total: 290,00€».
 *  - Avaibook: www.avaibook.com/reservas/nueva_reserva.php?f_ini&f_fin&capacidad&cod_alojamiento → «Total 720.00 €» o «no hay disponibilidad».
 *  - HBook (WordPress): calendario en la variable de la página hb_status_days_all (fully-taken / taken-start / taken-end).
 *  - Thelis (campings): thelisresa.webcamp.fr/list.php?camping&begin&end&nb_pers → .thr-search-product con precio o sin bloque de precio.
 *  - Resto de motores: solo detección por la sonda.
 * Las funciones parse… y detect… son puras y se prueban en Node (tests/extension-channels.test.mjs).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BulinChannelReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.1.2';
  const READER_VERSION = 'ch1.1.2';
  const AIRBNB_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20'; // clave pública de la web de Airbnb (también se lee de la página)
  const AIRBNB_CAL_HASH = 'bfd57b0552df2e8870f68d5cf501868a0e08417267469f55faefa78aca0234f4'; // respaldo si la página aún no lo ha pedido
  const ENGINES = {
    avirato: ['avirato.com', 'avirato.es'], availroom: ['availroom.com', 'availroom.es'], misterplan: ['misterplan.es', 'misterplan.com', 'reservaonline.support', 'mrplan.io'],
    avaibook: ['avaibook.com', 'avaibook.net', 'avaibook.es'], amenitiz: ['amenitiz.io', 'amenitiz.com', 'amenitiz.net'], lodgify: ['lodgify.com'], smoobu: ['smoobu.com'], beds24: ['beds24.com'],
    octorate: ['octorate.com'], thelis: ['thelisresa.webcamp.fr', 'thelis.fr'], cloudbeds: ['cloudbeds.com'], roomcloud: ['roomcloud.net'], neobookings: ['neobookings.com'], mirai: ['mirai.com'], siteminder: ['thebookingbutton.com', 'siteminder.com'], hotetec: ['hotetec.com'],
  };
  const SUPPORTED_DIRECT = ['amenitiz', 'avirato', 'availroom', 'misterplan', 'avaibook', 'hbook', 'thelis'];
  /** Enlaces a la web comercial del motor (pie «Software de reservas …») no son firma: solo cuentan recursos o enlaces al motor en sí. */
  const MARKETING_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i;
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
    if (/fechas no disponibles|no est[aá] disponible|no hay [a-zñáéíóú ]{0,40}disponibles|ya no (?:est[aá]|quedan) .{0,30}disponib|those dates are(?:n['’]t| not) available|dates? (?:are )?unavailable|no [a-z ]{0,30}available for (?:these|those) dates|sold out/i.test(t)) return { unavailable: true };
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
  /** «Este alojamiento no está disponible en Vrbo para tus fechas» (y variantes en inglés). */
  function vrboUnavailableText(text) {
    return /no est[aá] disponible(?: en [a-z]+)? (?:para|en) (?:tus|esas|estas|las) fechas|fechas no disponibles|(?:is ?n['’]?o?t|not) available(?: on [a-z]+)? for (?:your|these|those) dates/i.test(s(text));
  }
  /** Selector sin colores de ocupación: solo los días futuros marcados «no está disponible» (aria-disabled) se dan por cerrados. */
  function vrboDayStateAria(label, btn, today) {
    const date = parseDayLabel(label); if (!date || date < today) return null;
    const off = /no est[aá] disponible|not available|unavailable/i.test(s(label)) || (btn && btn.getAttribute && btn.getAttribute('aria-disabled') === 'true');
    return off ? { available: false, checkin: false, checkout: null } : null;
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
  /* ── Motores directos 1.1.0 ── */
  /** environmentId/propertyId de Availroom (32 hex) en una URL, HTML o lista de recursos. */
  function availroomIdsFromText(text) {
    const t = String(text || '');
    const e = t.match(/environment(?:Id)?=([A-F0-9]{32})/i); const p = t.match(/(?:approute=property\/|property(?:Id)?=|property\/)([A-F0-9]{32})/i);
    return e && p ? { environment: e[1].toUpperCase(), property: p[1].toUpperCase() } : null;
  }
  /** Respuesta de bookingv3 → precio más bajo para el grupo y unidades libres. no_rates: tipos sin tarifa cargada (precio 0). */
  function parseAvailroomV3(json, guests) {
    const prop = json && Array.isArray(json.properties) ? json.properties[0] : null; if (!prop) return json && Array.isArray(json.properties) ? { total: null, rooms_listed: 0, rooms_available: 0 } : null;
    const rts = Array.isArray(prop.roomTypes) ? prop.roomTypes : []; const g = Number(guests) || 1;
    let best = null; let units = 0; let fit = 0; let zero = 0;
    for (const r of rts) {
      const cap = Number(r.maxCapacity || 0); if (cap && cap < g) continue; fit++;
      const price = Number(r.price || 0); if (!(price > 0)) { zero++; continue; }
      if (r.available === false || Number(r.unitsFree) === 0) continue;
      units += Number(r.unitsFree || 1); if (best == null || price < best) best = Math.round(price * 100) / 100;
    }
    return { total: best, rooms_available: units, rooms_listed: rts.length, rooms_fit: fit, no_rates: rts.length > 0 && zero === rts.length };
  }
  /** id_casa / id_punto_venta de MisterPlan en URLs de recursos, HTML o una URL con #id_casa=…&id_punto_venta=… */
  function misterplanIdsFromText(text) {
    const t = String(text || '');
    const c = t.match(/id_casa=(\d{3,9})/) || t.match(/id_elemento=(\d{3,9})&tipo_elemento=2/); const v = t.match(/id_punto_venta=(\d{1,9})/);
    return c && v ? { id_casa: c[1], id_punto_venta: v[1] } : null;
  }
  const htmlText = (h) => String(h || '').replace(/\[br\]/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&euro;/g, '€').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  /** resultado (HTML) de TSimpleSearch → habitaciones {name, units, options:[{guests,total}]} y la mejor para el grupo. */
  function parseMisterplanResult(json, guests) {
    if (!json || typeof json !== 'object' || typeof json.resultado !== 'string') return null;
    const chunks = json.resultado.split(/class="[^"]*TSS8_capa_habitacion_padre/).slice(1); const g = Number(guests) || 1; const rooms = [];
    for (const ch of chunks) {
      const t = htmlText('<x ' + ch);
      const units = t.match(/(\d+)\s+Disponibles?/i); const name = s((t.split(/S[óo]lo \d+ Disponible|\d+ Disponibles?/i)[0] || '').replace(/^[^>]*>/, '')).slice(0, 120);
      const options = [...t.matchAll(/para (\d+)\b[\s\S]*?Total:\s*([\d.,]+)\s*€/gi)].map((m) => ({ guests: Number(m[1]), total: parseEuroAmount(m[2] + ' €') })).filter((o) => o.total);
      rooms.push({ name, units: units ? Number(units[1]) : 1, options });
    }
    let best = null; let units = 0;
    for (const r of rooms) {
      const ok = r.options.filter((o) => o.guests === g); const opts = ok.length ? ok : r.options.filter((o) => o.guests > g);
      if (!opts.length) continue; units += r.units;
      const v = Math.min(...opts.map((o) => o.total)); if (best == null || v < best) best = v;
    }
    return { total: best, rooms_available: units, rooms_listed: rooms.length, error_code: String(json.error_code ?? ''), error_msg: s(json.error_msg), full: /est[aá\ufffd]+ completo|no hay disponibilidad/i.test(htmlText(json.resultado)) };
  }
  /** Página de Avaibook (nueva_reserva.php) → total o sin disponibilidad. Solo vale la línea «Total» (no depósito, resto ni fianza). */
  function parseAvaibookText(text) {
    const t = String(text || '');
    if (/no hay disponibilidad para las fechas|no availability for the selected dates|alojamiento no est[aá] disponible/i.test(t)) return { unavailable: true };
    const lines = t.split(/\n+/).map(s).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (/^total\b/i.test(lines[i]) && !/dep[oó]sito|resto|fianza|pagar ahora|a pagar/i.test(lines[i])) {
        const v = parseEuroAmount(lines[i]) ?? (lines[i + 1] ? parseEuroAmount(lines[i + 1]) : null); if (v) return { total: v };
      }
    }
    return {};
  }
  /** hb_status_days_all (fecha → clases; o {alojamiento: {fecha → clases}}) → días. La noche está ocupada si el día está lleno o empieza una reserva. */
  function parseHbookStatus(status, from, to) {
    if (!status || typeof status !== 'object') return null;
    const maps = Object.values(status).some((v) => v && typeof v === 'object') ? Object.values(status).filter((v) => v && typeof v === 'object') : [status];
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      let free = 0; let arrive = 0;
      for (const m of maps) { const c = String(m[d] || ''); const taken = /fully-taken|taken-start/.test(c); if (!taken) free++; if (!/fully-taken/.test(c) && !/taken-start/.test(c)) arrive++; }
      out.push({ date: d, available: free > 0, checkin: arrive > 0, checkout: true, min_nights: null, price: null, units_free: free });
      if (out.length > 800) break;
    }
    return out;
  }
  /** Productos de Thelis (texto de cada .thr-search-product) → precio más bajo con capacidad suficiente. */
  function parseThelisProducts(items, guests) {
    if (!Array.isArray(items)) return null; const g = Number(guests) || 1; let best = null; let units = 0; let fit = 0;
    for (const it of items) {
      const cap = (String(it.text || '').match(/m²\s*(\d{1,2})\b/) || [])[1]; if (cap && Number(cap) < g) continue; fit++;
      if (!it.price) continue; const v = parseEuroAmount(it.price); if (!v) continue; units++; if (best == null || v < best) best = v;
    }
    return { total: best, rooms_available: units, rooms_listed: items.length, rooms_fit: fit };
  }
  /** Motor de reservas a partir del HTML y la URL de la web del competidor. */
  function detectEngine(html, pageUrl) {
    // El propio lector puede estar en el DOM como <script> (Home Assistant lo inyecta con addScriptTag): nunca cuenta como firma.
    const h = String(html || '').replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*BulinChannelReader(?:(?!<\/script>)[\s\S])*<\/script>/gi, ''); let origin = ''; try { origin = new URL(pageUrl).origin; } catch (e) { /* sin URL */ }
    const links = [...h.matchAll(/(?:src|href|action|data-src)\s*=\s*["']([^"']+)["']/gi)].map((m) => { try { return new URL(m[1].replace(/&amp;/g, '&'), pageUrl || undefined).href; } catch (e) { return ''; } }).filter(Boolean);
    const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
    const matches = (host, d) => host === d || host.endsWith('.' + d);
    const score = {}; const first = {};
    for (const u of links) {
      const host = hostOf(u); let path = '/'; let query = ''; try { const x = new URL(u); path = x.pathname; query = x.search; } catch (e) { /* nada */ }
      for (const [k, ds] of Object.entries(ENGINES)) if (ds.some((d) => matches(host, d))) {
        if (ds.some((d) => host === d || host === 'www.' + d) && MARKETING_PATH.test(path) && !query) continue; // enlace a la web comercial del motor
        score[k] = (score[k] || 0) + 1; if (!first[k] && !/\.(js|css|png|jpe?g|svg|woff2?)(\?|$)/i.test(u)) first[k] = u;
      }
    }
    if (/hb_status_days_all|\/wp-content\/plugins\/hbook\//i.test(h)) { score.hbook = (score.hbook || 0) + 3; first.hbook = first.hbook || pageUrl || ''; }
    const ar = availroomIdsFromText(h); if (ar) { score.availroom = (score.availroom || 0) + 2; first.availroom = 'https://bookingengine.availroom.com/?environment=' + ar.environment + '&approute=property/' + ar.property; }
    if (/TExpReverseInc\.php|core_search\/lib\/accion\.TSimpleSearch/i.test(h)) score.misterplan = (score.misterplan || 0) + 2;
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
      perf: typeof performance !== 'undefined' ? performance : null, win: typeof window !== 'undefined' ? window : globalThis, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
  }
  async function waitFor(env, fn, timeoutMs, stepMs) { const t0 = env.now(); for (;;) { const v = await fn(); if (v) return v; if (env.now() - t0 > timeoutMs) return null; await env.sleep(stepMs || 500); } }
  const result = (status, extra) => Object.assign({ status, reader_version: READER_VERSION }, extra || {});
  function bodyText(env) { return env.doc && env.doc.body ? String(env.doc.body.innerText || env.doc.body.textContent || '') : ''; }
  /** 0.5.4 · pista de lo que vio el worker cuando no encuentra lo esperado (aparece en «Últimos errores de lectura»). */
  function pageHint(env) {
    const d = env.doc; if (!d) return '';
    const v = (sel) => { const e = d.querySelector(sel); return e ? s(e.value || e.innerText || e.textContent || '').slice(0, 40) : '-'; };
    const parts = ['título: ' + s(d.title).slice(0, 60), 'url: ' + String(env.loc.href).replace(/^https?:\/\/[^/]+/, '').slice(0, 110),
      'fechas: ' + v('[data-stid="uitk-date-selector-input1-default"]') + ' → ' + v('[data-stid="uitk-date-selector-input2-default"]'),
      'bloques: ' + ['product-price-summary', 'alternate-availability', 'error-messages', 'submit-hotel-reserve'].filter((x) => d.querySelector('[data-stid="' + x + '"]')).join(',') + (d.querySelector('[data-testid="book-it-default"]') ? ',book-it' : ''),
      'ancho: ' + ((typeof window !== 'undefined' && window.innerWidth) || '?')];
    return parts.join(' · ').slice(0, 380);
  }
  /** 0.5.4 · aviso de cookies (OneTrust de VRBO/Expedia y similares): se rechazan las no necesarias para poder usar la página. */
  function dismissConsent(env) {
    const d = env.doc; if (!d || !d.querySelector) return false;
    let btn = d.querySelector('#onetrust-reject-all-handler, .ot-pc-refuse-all-handler, #didomi-notice-disagree-button, [data-testid="reject-all-cookies"]');
    if (!btn && typeof d.querySelectorAll === 'function') btn = [...d.querySelectorAll('button')].find((x) => /^(rechazar(las)? todas(?: las cookies)?|rechazar todo|solo (?:las )?(?:cookies )?necesarias|reject all(?: cookies)?|only necessary(?: cookies)?)$/i.test(s(x.innerText || x.textContent)));
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) { return false; }
  }
  function blocked(env) { return classifyBlock(bodyText(env), env.doc && env.doc.title); }
  function clampDays(days, job) { return days.filter((d) => (!job.range_from || d.date >= job.range_from) && (!job.range_to || d.date <= job.range_to)); }
  function qp(env) { try { return new URL(env.loc.href).searchParams; } catch (e) { return new URLSearchParams(); } }

  /** Días del calendario de Airbnb (API de la propia página) entre from y to. Devuelve { days } o { error: result(...) }. */
  async function airbnbCalendarDays(id, env, from, to, waitMs) {
    const key = ((env.doc && env.doc.documentElement ? env.doc.documentElement.innerHTML : '').match(/"api_config":\{"key":"([a-z0-9]+)"/) || [])[1] || AIRBNB_KEY;
    const seen = await waitFor(env, () => (env.perf ? env.perf.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('PdpAvailabilityCalendar')) : null), waitMs, 600);
    const base = seen ? new URL(seen) : new URL(env.loc.origin + '/api/v3/PdpAvailabilityCalendarV2Query/' + AIRBNB_CAL_HASH + '?operationName=PdpAvailabilityCalendarV2Query&locale=es&currency=EUR');
    if (!seen) base.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: AIRBNB_CAL_HASH } }));
    base.searchParams.set('currency', 'EUR');
    let days = []; let cursor = from.slice(0, 7);
    for (let i = 0; i < 3 && cursor <= to.slice(0, 7); i++) {
      const [y, m] = cursor.split('-').map(Number);
      base.searchParams.set('variables', JSON.stringify({ listingId: airbnbGlobalId(id), input: { count: 12, month: m, year: y, returnPropertyLevelCalendarIfApplicable: false } }));
      const r = await env.fetch(base.toString(), { headers: { 'X-Airbnb-API-Key': key, Accept: 'application/json' }, credentials: 'include' });
      if (r.status === 429 || r.status === 403) return { error: result('BLOQUEADO', { reason: 'airbnb_http_' + r.status }) };
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      const part = parseAirbnbCalendar(j); if (!part) return { error: result('ESTRUCTURA_CAMBIADA', { reason: 'airbnb_calendar_shape', error_detail: 'HTTP ' + r.status }) };
      days = days.concat(part); const nm = new Date(Date.UTC(y, m - 1 + 12, 1)); cursor = nm.toISOString().slice(0, 7);
    }
    return { days: [...new Map(days.map((d) => [d.date, d])).values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
  }
  /** ¿Se puede reservar la estancia según el calendario? null si el calendario no lo deja claro. */
  function airbnbStayFromCalendar(days, checkin, checkout) {
    const by = new Map(days.map((d) => [d.date, d])); const nights = []; for (let d = checkin; d < checkout; d = addDays(d, 1)) nights.push(d);
    if (!nights.length || nights.some((d) => !by.has(d))) return null;
    if (nights.some((d) => !by.get(d).available)) return { unavailable: true, reason: 'calendar_night_unavailable' };
    const first = by.get(checkin); if (first.checkin === false) return { unavailable: true, reason: 'calendar_no_checkin' };
    const out = by.get(checkout); if (out && out.checkout === false) return { unavailable: true, reason: 'calendar_no_checkout' };
    if (first.min_nights && first.min_nights > nights.length) return { restriction: true, min_nights: first.min_nights };
    return null;
  }
  async function airbnbCalendar(job, env) {
    const id = String(job.external_id || ''); if (!/^\d+$/.test(id)) return result('ERROR', { reason: 'missing_external_id' });
    const pathId = (String(env.loc.pathname || '').match(/\/rooms\/(?:plus\/)?(\d+)/) || [])[1]; if (pathId && pathId !== id) return result('INCONSISTENTE', { reason: 'property_mismatch', listing: { external_id: pathId } });
    const from = job.range_from || new Date().toISOString().slice(0, 10); const to = job.range_to || addDays(from, 365);
    const c = await airbnbCalendarDays(id, env, from, to, 12000); if (c.error) return c.error;
    return result('OK', { listing: { external_id: id }, calendar: clampDays(c.days, job), currency: 'EUR', final_url: env.loc.href });
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
    if (!read) {
      // Sin bloque de reserva: Airbnb lo oculta cuando las fechas no se pueden reservar. El calendario de la propia página lo confirma.
      const id = String(pathId || job.external_id || ''); const c = /^\d+$/.test(id) ? await airbnbCalendarDays(id, env, job.checkin, job.checkout, 1500) : null;
      const st = c && c.days ? airbnbStayFromCalendar(c.days, job.checkin, job.checkout) : null;
      if (st && st.unavailable) return result('SIN_DISPONIBILIDAD', Object.assign(base, { reason: st.reason, price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests } }));
      if (st && st.restriction) return result('RESTRICCION', Object.assign(base, { reason: 'min_nights', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests, min_nights: st.min_nights } }));
      const cap = bodyText(env).match(/m[aá]ximo de (\d+) (?:hu[eé]spedes|personas|viajeros)|maximum of (\d+) guests/i);
      if (cap && Number(cap[1] || cap[2]) < Number(job.guests)) return result('RESTRICCION', Object.assign(base, { reason: 'max_guests', error_detail: 'máximo ' + (cap[1] || cap[2]) + ' huéspedes', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests } }));
      return result('ESTRUCTURA_CAMBIADA', Object.assign(base, { reason: 'airbnb_bookit_not_found', error_detail: pageHint(env) }));
    }
    if (read.unavailable) return result('SIN_DISPONIBILIDAD', Object.assign(base, { reason: 'dates_not_available', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests } }));
    if (read.restriction) return result('RESTRICCION', Object.assign(base, { reason: 'min_nights', price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests, min_nights: read.min_nights } }));
    return result('OK', Object.assign(base, { price: { checkin: job.checkin, checkout: job.checkout, guests: job.guests, total: read.total, currency: 'EUR' } }));
  }
  async function vrboCalendar(job, env) {
    if (vrboNotListed(env)) return result('ESTRUCTURA_CAMBIADA', { reason: 'listing_not_on_vrbo', error_detail: 'VRBO redirige a una búsqueda: este id no es un alquiler de VRBO', final_url: env.loc.href });
    const d = env.doc; const opened = await waitFor(env, () => { if (d.querySelector('.uitk-day-button')) return true; const t = d.querySelector('[data-stid="uitk-date-selector-input1-default"]'); if (t) t.click(); return false; }, 15000, 800);
    // ch1.1.1 · VRBO (oct-2026) solo abre el selector de fechas con un clic real del usuario: un clic por script no lo abre. Si el botón está y el
    // calendario no aparece, no es un cambio de estructura: lectura parcial (la disponibilidad sale de las lecturas de precio; el worker de HA hace el clic real).
    if (!opened) return d.querySelector('[data-stid="uitk-date-selector-input1-default"]') ? result('PARCIAL', { reason: 'vrbo_calendar_needs_real_click', listing: { external_id: job.external_id }, calendar: [], currency: 'EUR', final_url: env.loc.href })
      : result('ESTRUCTURA_CAMBIADA', { reason: 'vrbo_calendar_not_found', error_detail: pageHint(env), final_url: env.loc.href });
    const today = new Date().toISOString().slice(0, 10); const to = job.range_to || addDays(today, 365); const map = new Map();
    const readAll = () => { for (const b of d.querySelectorAll('.uitk-day-button')) { const lab = b.querySelector('.uitk-day-aria-label'); const date = parseDayLabel(lab && lab.getAttribute('aria-label')); const bg = b.querySelector('[class*="uitk-background-"]'); const st = vrboDayState(bg && bg.className) || vrboDayStateAria(lab && lab.getAttribute('aria-label'), b, today); if (date && st) map.set(date, Object.assign({ date, min_nights: null, price: null }, st)); } };
    for (let i = 0; i < 9; i++) {
      readAll(); const last = [...map.keys()].sort().pop(); if (last && last >= to) break;
      const n = d.querySelector('[data-stid="uitk-calendar-navigation-controls-next-button"]'); if (!n || n.disabled) break; n.click(); await env.sleep(700);
    }
    if (!map.size) {
      // Fichas tipo alojamiento (con «apartamento/habitación»): VRBO no pinta la ocupación en el selector; la disponibilidad sale de las lecturas de precio.
      if (d.querySelector('.uitk-day-button .uitk-day-aria-label')) return result('PARCIAL', { reason: 'vrbo_calendar_without_availability', listing: { external_id: job.external_id }, calendar: [], currency: 'EUR', final_url: env.loc.href });
      return result('ESTRUCTURA_CAMBIADA', { reason: 'vrbo_days_unreadable', error_detail: pageHint(env), final_url: env.loc.href });
    }
    return result('OK', { listing: { external_id: job.external_id }, calendar: clampDays([...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), job), currency: 'EUR', final_url: env.loc.href });
  }
  /** VRBO redirige a una búsqueda cuando el id (p. ej. un hotel de Expedia /pdp/lo/<id>) no es un alquiler suyo. */
  function vrboNotListed(env) { return /\/(?:alquiler-vacacional|vacation-rentals|search)(?:\/|\?|$)/.test(String(env.loc.pathname || '')) && !env.doc.querySelector('[data-stid="product-price-summary"], .uitk-day-button'); }
  async function vrboPrice(job, env) {
    if (vrboNotListed(env)) return result('ESTRUCTURA_CAMBIADA', { reason: 'listing_not_on_vrbo', error_detail: 'VRBO redirige a una búsqueda: este id no es un alquiler de VRBO', final_url: env.loc.href });
    const p = qp(env); const ci = p.get('chkin') || p.get('startDate'); const co = p.get('chkout') || p.get('endDate');
    if (ci !== job.checkin || co !== job.checkout || Number(p.get('adults')) !== Number(job.guests)) return result('INCONSISTENTE', { reason: 'context_mismatch', error_detail: 'url_params' });
    const read = await waitFor(env, () => { const el = env.doc.querySelector('[data-stid="product-price-summary"]'); const r = parseVrboPriceSummary(el ? el.innerText || el.textContent : ''); if (r.total || r.unavailable) return r;
      return vrboUnavailableText(bodyText(env)) || env.doc.querySelector('[data-stid="alternate-availability"]') ? { unavailable: true } : null; }, 20000, 700);
    const base = { listing: { external_id: job.external_id }, final_url: env.loc.href };
    if (!read) return result('ESTRUCTURA_CAMBIADA', Object.assign(base, { reason: 'vrbo_price_not_found', error_detail: pageHint(env) }));
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
    if (!p.total && p.rooms_listed && !p.rooms_fit) return result('PARCIAL', { reason: 'no_room_for_group', price, final_url: env.loc.href }); // ch1.1.2 · grupo mayor que cualquier habitación: no es «cerrado»
    if (!p.total) return result('SIN_DISPONIBILIDAD', { reason: 'no_rooms', price, final_url: env.loc.href });
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
  /* ── Motores directos 1.1.0 (en la página) ── */
  const priceBase = (job, extra) => Object.assign({ checkin: job.checkin, checkout: job.checkout, guests: job.guests, currency: 'EUR' }, extra || {});
  function resourcesText(env) { try { return env.perf ? env.perf.getEntriesByType('resource').map((e) => e.name).join('\n') : ''; } catch (e) { return ''; } }
  function pageHtml(env) { return env.doc && env.doc.documentElement ? String(env.doc.documentElement.outerHTML || '') : ''; }
  /** Busca los códigos del motor: parámetros del trabajo (engine_params), URL, recursos cargados, HTML y, si no, las páginas de reserva enlazadas. */
  async function engineIds(job, env, fromText, waitMs) {
    const pre = job.engine_params && typeof job.engine_params === 'object' ? job.engine_params : null;
    const direct = fromText([pre ? Object.entries(pre).map(([k, v]) => k + '=' + v).join('&') : '', job.url, job.engine_url, env.loc && env.loc.href].join('\n'));
    if (direct) return direct;
    const seen = await waitFor(env, () => fromText(resourcesText(env) + '\n' + pageHtml(env)), waitMs || 12000, 700); if (seen) return seen;
    for (const u of bookingLinks(pageHtml(env), env.loc.href)) { try { const r = await env.fetch(u, { credentials: 'include' }); const h = await r.text(); const x = fromText(h); if (x) return x; } catch (e) { /* siguiente */ } }
    return null;
  }
  async function availroomPrice(job, env) {
    const ids = await engineIds(job, env, availroomIdsFromText, 8000);
    if (!ids) return result('ESTRUCTURA_CAMBIADA', { reason: 'availroom_ids_not_found', error_detail: pageHint(env), final_url: env.loc.href });
    const u = 'https://bookingv3.availroom.com/api/booking-engine?environmentId=' + ids.environment + '&flow=property&adults=' + Number(job.guests) + '&rooms=1&fromDate=' + job.checkin + '&toDate=' + job.checkout + '&lang=es&propertyId=' + ids.property + '&languages=es%2Cen';
    const r = await env.fetch(u, { headers: { Accept: 'application/json' } }); let j = null; try { j = await r.json(); } catch (e) { j = null; }
    const p = parseAvailroomV3(j, job.guests); if (!p) return result('ESTRUCTURA_CAMBIADA', { reason: 'availroom_shape', error_detail: 'HTTP ' + r.status, final_url: env.loc.href });
    const price = priceBase(job, { rooms_available: p.rooms_available });
    if (!p.total && (p.no_rates || (p.rooms_listed && !p.rooms_fit))) return result('PARCIAL', { reason: p.no_rates ? 'no_rates_loaded' : 'no_room_for_group', price, final_url: env.loc.href }); // sin tarifas o grupo demasiado grande: no es «cerrado»
    if (!p.total) return result('SIN_DISPONIBILIDAD', { reason: 'no_rooms', price, final_url: env.loc.href });
    return result('OK', { price: Object.assign(price, { total: p.total }), final_url: env.loc.href });
  }
  function jsonpDefault(env, url, timeoutMs) {
    return new Promise((resolve) => {
      const w = env.win || globalThis; const cb = '__b360mp' + env.now() + Math.floor(Math.random() * 1e6); const sc = env.doc.createElement('script'); let done = false;
      const end = (v) => { if (done) return; done = true; try { delete w[cb]; } catch (e) { w[cb] = undefined; } try { sc.remove(); } catch (e) { /* nada */ } resolve(v); };
      w[cb] = (d) => end(d); sc.onerror = () => end(null); setTimeout(() => end(null), timeoutMs || 20000);
      sc.src = url + '&jsoncallback=' + cb; (env.doc.head || env.doc.documentElement).appendChild(sc);
    });
  }
  async function misterplanPrice(job, env) {
    const ids = await engineIds(job, env, misterplanIdsFromText, 12000);
    if (!ids) return result('ESTRUCTURA_CAMBIADA', { reason: 'misterplan_ids_not_found', error_detail: pageHint(env), final_url: env.loc.href });
    const dmy = (d) => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
    const u = 'https://mrplan.io/scr/modulos/core_search/lib/accion.TSimpleSearch.php?&smartphone=5&id_operador=1&id_oficina=0&id_idioma=0&id_casa=' + ids.id_casa + '&fecha_entrada=' + dmy(job.checkin) + '&fecha_salida=' + dmy(job.checkout) +
      '&n_noches=' + nights(job.checkin, job.checkout) + '&ruta_raiz=https://mrplan.io/scr/&modo=2&SimpleSearchV=9&app=&TSS_presupuesto_app=0&capa_resultado=x&ews_activar_mas_menos=1&id_punto_venta=' + ids.id_punto_venta + '&id_moneda=1';
    const j = await (env.jsonp ? env.jsonp(u) : jsonpDefault(env, u, 20000));
    const p = parseMisterplanResult(j, job.guests); if (!p) return result('ESTRUCTURA_CAMBIADA', { reason: 'misterplan_shape', error_detail: j ? 'sin resultado' : 'jsonp_timeout', final_url: env.loc.href });
    const price = priceBase(job, { rooms_available: p.rooms_available });
    if (!p.total && p.rooms_listed) return result('PARCIAL', { reason: 'no_room_for_group', price, final_url: env.loc.href }); // hay habitaciones, ninguna para este grupo
    if (!p.total && !p.full && /^ERROR/i.test(p.error_msg)) return result('ERROR', { reason: 'misterplan_engine_error', error_detail: p.error_msg.slice(0, 200), final_url: env.loc.href });
    if (!p.total) return result('SIN_DISPONIBILIDAD', { reason: 'no_rooms', price, final_url: env.loc.href });
    return result('OK', { price: Object.assign(price, { total: p.total }), final_url: env.loc.href });
  }
  async function avaibookPrice(job, env) {
    const p = qp(env); if (p.get('f_ini') !== job.checkin || p.get('f_fin') !== job.checkout || Number(p.get('capacidad')) !== Number(job.guests)) return result('INCONSISTENTE', { reason: 'context_mismatch', error_detail: 'url_params' });
    const read = await waitFor(env, () => { const r = parseAvaibookText(bodyText(env)); return r.total || r.unavailable ? r : null; }, 25000, 800);
    if (!read) return result('ESTRUCTURA_CAMBIADA', { reason: 'avaibook_total_not_found', error_detail: pageHint(env), final_url: env.loc.href });
    if (read.unavailable) return result('SIN_DISPONIBILIDAD', { reason: 'dates_not_available', price: priceBase(job, { rooms_available: 0 }), final_url: env.loc.href });
    return result('OK', { price: priceBase(job, { total: read.total }), final_url: env.loc.href });
  }
  async function hbookCalendar(job, env) {
    const w = env.win || globalThis; const st = await waitFor(env, () => w.hb_status_days_all || null, 15000, 600);
    if (!st) return result('ESTRUCTURA_CAMBIADA', { reason: 'hbook_status_not_found', error_detail: pageHint(env), final_url: env.loc.href });
    let from = job.range_from || new Date().toISOString().slice(0, 10); let to = job.range_to || addDays(from, 365);
    const acc = w.hb_accom_data_0 || {}; if (/^\d{4}-\d{2}-\d{2}$/.test(acc.min_date || '') && acc.min_date > from) from = acc.min_date; if (/^\d{4}-\d{2}-\d{2}$/.test(acc.max_date || '') && acc.max_date < to) to = acc.max_date;
    const days = parseHbookStatus(st, from, to); if (!days) return result('ESTRUCTURA_CAMBIADA', { reason: 'hbook_status_shape', final_url: env.loc.href });
    return result('OK', { calendar: days, currency: 'EUR', final_url: env.loc.href });
  }
  async function thelisPrice(job, env) {
    const p = qp(env); if (p.get('begin') !== job.checkin || p.get('end') !== job.checkout) return result('INCONSISTENTE', { reason: 'context_mismatch', error_detail: 'url_params' });
    const items = await waitFor(env, () => { const els = [...env.doc.querySelectorAll('.thr-search-product')]; return els.length ? els : null; }, 25000, 800);
    if (!items) {
      if (/no hay (?:ning[uú]n )?(?:alojamiento|producto|disponibilidad)|aucun|no availability/i.test(bodyText(env))) return result('SIN_DISPONIBILIDAD', { reason: 'no_rooms', price: priceBase(job, { rooms_available: 0 }), final_url: env.loc.href });
      return result('ESTRUCTURA_CAMBIADA', { reason: 'thelis_products_not_found', error_detail: pageHint(env), final_url: env.loc.href });
    }
    await env.sleep(1500);
    const data = [...env.doc.querySelectorAll('.thr-search-product')].map((el) => { const cur = el.querySelector('.thr-promotion-description-thumbs-price') || el.querySelector('.thr-search-product-stay-price'); return { text: s(el.innerText || el.textContent), price: cur ? s(cur.innerText || cur.textContent) : null }; });
    const r = parseThelisProducts(data, job.guests); const price = priceBase(job, { rooms_available: r.rooms_available });
    if (!r.total && !r.rooms_fit && r.rooms_listed) return result('PARCIAL', { reason: 'no_room_for_group', price, final_url: env.loc.href });
    if (!r.total) return result('SIN_DISPONIBILIDAD', { reason: 'no_rooms', price, final_url: env.loc.href });
    return result('OK', { price: Object.assign(price, { total: r.total }), final_url: env.loc.href });
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
      if (dismissConsent(env)) await env.sleep(1200);
      const b = blocked(env); if (b) return result(b.status, { reason: b.reason, final_url: env.loc.href, duration_ms: env.now() - t0 });
      const k = job.run_kind; const ch = job.channel; const eng = job.engine;
      let r;
      if (k === 'probe') r = await probe(job, env);
      else if (ch === 'airbnb') r = k === 'calendar' ? await airbnbCalendar(job, env) : await airbnbPrice(job, env);
      else if (ch === 'vrbo') r = k === 'calendar' ? await vrboCalendar(job, env) : await vrboPrice(job, env);
      else if (ch === 'direct' && eng === 'amenitiz') r = k === 'calendar' ? await amenitizCalendar(job, env) : await amenitizPrice(job, env);
      else if (ch === 'direct' && eng === 'avirato' && k === 'price') r = await aviratoPrice(job, env);
      else if (ch === 'direct' && eng === 'availroom' && k === 'price') r = await availroomPrice(job, env);
      else if (ch === 'direct' && eng === 'misterplan' && k === 'price') r = await misterplanPrice(job, env);
      else if (ch === 'direct' && eng === 'avaibook' && k === 'price') r = await avaibookPrice(job, env);
      else if (ch === 'direct' && eng === 'hbook' && k === 'calendar') r = await hbookCalendar(job, env);
      else if (ch === 'direct' && eng === 'thelis' && k === 'price') r = await thelisPrice(job, env);
      else r = result('ERROR', { reason: 'unsupported_' + ch + '_' + (eng || '') + '_' + k });
      const b2 = r.status !== 'OK' ? blocked(env) : null; if (b2) r = result(b2.status, { reason: b2.reason, final_url: env.loc.href });
      r.duration_ms = env.now() - t0; return r;
    } catch (e) { return result('ERROR', { reason: 'reader_exception', error_detail: String(e && e.message || e).slice(0, 500), duration_ms: env.now() - t0, final_url: env.loc && env.loc.href }); }
  }
  /** Capacidades que anuncia el worker (claim.capabilities). */
  function capabilities(opts) { const o = opts || {}; return { channels: o.direct === false ? ['airbnb', 'vrbo'] : ['airbnb', 'vrbo', 'direct'], direct_engines: SUPPORTED_DIRECT.slice(), channel_reader: VERSION, trusted_click: !!o.trustedClick }; } // trusted_click: el worker puede hacer clics reales (HA/Playwright) → recibe los calendarios de VRBO

  return { VERSION, READER_VERSION, SUPPORTED_DIRECT, run, capabilities, parseEuroAmount, totalsInText, classifyBlock, airbnbGlobalId, parseAirbnbCalendar, parseAirbnbBookIt, parseDayLabel, vrboDayState,
    parseVrboPriceSummary, vrboUnavailableText, vrboDayStateAria, parseAmenitizAvailability, parseAmenitizRooms, parseAviratoText, availroomIdsFromText, parseAvailroomV3, misterplanIdsFromText, parseMisterplanResult, parseAvaibookText, parseHbookStatus, parseThelisProducts, detectEngine, bookingLinks,
    _internal: { availroomPrice, misterplanPrice, avaibookPrice, hbookCalendar, thelisPrice, dismissConsent, airbnbCalendar, airbnbPrice, airbnbStayFromCalendar, vrboPrice, amenitizCalendar, amenitizPrice, aviratoPrice, probe, addDays } };
});
