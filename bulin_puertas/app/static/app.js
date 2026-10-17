// Bulín Puertas · panel local de Home Assistant (1.0.0). Cerraduras y portales de esta casa, agrupados por alojamiento según el Panel.
const $ = (id) => document.getElementById(id);
const S = { data: null, busy: new Set() };
const ICON = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>',
  gate: '<path d="M4 20V8l8-4 8 4v12"/><path d="M9 20v-7h6v7"/>',
  battery: '<rect x="3" y="8" width="16" height="9" rx="2"/><path d="M21 11v3"/>',
  door: '<path d="M6 21V4h10v17"/><path d="M4 21h16"/><path d="M13 12h.01"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4.5"/><path d="M12 17.2v.3"/>',
};
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v); else el.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function icon(n, cls = '') { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', `ic ${cls}`); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[n]; return s; }
let tt = 0; function toast(m, err = false) { const t = $('toast'); t.textContent = m; t.dataset.tone = err ? 'error' : 'ok'; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; }, err ? 8000 : 3500); }
function confirmDlg(title, text, ok, danger) {
  const d = $('confirm'); $('c-title').textContent = title; $('c-text').textContent = text; const b = $('c-ok'); b.textContent = ok; b.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  return new Promise((res) => { d.returnValue = ''; d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }); d.showModal(); });
}
async function load() {
  try { const r = await fetch('api/state', { cache: 'no-store' }); S.data = await r.json(); } catch { S.data = { ok: false, items: [], local_error: 'No se pudo leer el estado de la app.' }; }
  paint();
}

const isOpen = (x) => x.kind === 'lock' && ['unlocked', 'open', 'opening', 'unlocking'].includes(x.state);
const isClosed = (x) => x.kind === 'lock' && ['locked', 'locking'].includes(x.state);
const issue = (x) => x.offline || x.jammed || (x.battery != null && x.battery < 20) || isOpen(x);

function paint() {
  const d = S.data || {}; const items = d.items || []; const p = d.panel || {};
  $('sub').textContent = p.connected ? `Conectado al Panel${p.device ? ` · ${p.device}` : ''}` : (p.configured ? 'Sin conexión con el Panel' : 'Solo local (sin token del Panel)');
  const conn = $('conn'); conn.hidden = !(p.error || d.local_error); conn.textContent = d.local_error || p.error || '';
  const locks = items.filter((x) => x.kind === 'lock');
  $('tiles').replaceChildren(
    tile('Abiertas', locks.filter(isOpen).length, locks.some(isOpen) ? 'warn' : ''), tile('Batería baja', items.filter((x) => x.battery != null && x.battery < 20).length, items.some((x) => x.battery != null && x.battery < 20) ? 'bad' : ''),
    tile('Sin conexión', items.filter((x) => x.offline).length, items.some((x) => x.offline) ? 'bad' : ''), tile('Puertas', items.length, ''));
  // agrupar por alojamiento con las relaciones del Panel
  const names = Object.fromEntries((d.properties || []).map((x) => [x.id, x.name])); const links = d.links || {};
  const spaces = Object.fromEntries((d.spaces || []).map((x) => [x.id, x.name])); const spaceLinks = d.space_links || {};
  const groups = new Map();
  for (const x of items) {
    const ids = (links[x.entity_id] || []).filter((i) => names[i]);
    const sp = spaces[spaceLinks[x.entity_id]];
    const keys = [...ids.map((i) => names[i]), ...(sp ? [`${sp} · servicio`] : [])];
    if (!keys.length) keys.push('Sin asignar a un alojamiento');
    for (const k of keys) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  }
  const rank = (k) => (k.startsWith('Sin asignar') ? 2 : k.endsWith(' · servicio') ? 1 : 0);
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'es'));
  $('list').replaceChildren(...(items.length ? order.map((k) => h('section', { class: 'group' }, h('h2', { class: 'group__head' }, k), h('div', { class: 'group__list' }, ...groups.get(k).map(card)))) : [h('p', { class: 'empty' }, d.local_error ? 'No se pudieron leer las cerraduras de Home Assistant.' : 'No hay cerraduras ni portales en este Home Assistant.')]));
  $('foot').textContent = `Bulín Puertas ${d.version || ''}${p.last_sync ? ` · sincronizado ${p.last_sync}` : ''}${d.user ? ` · ${d.user}` : ''}`;
}
function tile(label, n, tone) { return h('div', { class: `tile${tone ? ` tile--${tone}` : ''}` }, h('strong', {}, String(n)), h('span', {}, label)); }
function card(x) {
  const busy = S.busy.has(x.entity_id); const portal = x.kind === 'portal'; const open = isOpen(x); const closed = isClosed(x);
  const stateTxt = portal ? 'Portal · solo pulsar' : x.offline ? 'Sin conexión' : x.jammed ? 'Bloqueada' : open ? 'Abierta' : closed ? 'Cerrada' : (x.state || '—');
  return h('article', { class: `door${issue(x) ? ' is-issue' : ''}${open ? ' is-open' : ''}` },
    h('span', { class: `door__ic${open ? ' is-open' : closed ? ' is-closed' : ''}${x.offline || x.jammed ? ' is-bad' : ''}` }, icon(portal ? 'gate' : open ? 'unlock' : 'lock')),
    h('div', { class: 'door__txt' }, h('strong', {}, x.name), h('small', {}, stateTxt, x.model ? ` · ${x.model}` : ''),
      h('span', { class: 'chips' },
        x.battery != null ? h('span', { class: `chip${x.battery < 20 ? ' chip--bad' : x.battery < 40 ? ' chip--warn' : ''}` }, icon('battery'), `${x.battery} %`) : null,
        x.door_open != null ? h('span', { class: `chip${x.door_open ? ' chip--warn' : ''}` }, icon('door'), x.door_open ? 'Puerta abierta' : 'Puerta cerrada') : null,
        x.jammed ? h('span', { class: 'chip chip--bad' }, icon('alert'), 'Atascada') : null)),
    h('div', { class: 'door__acts' },
      (portal || !open) ? h('button', { class: 'btn btn--primary', type: 'button', disabled: busy || x.offline, onClick: () => run(x, 'open') }, busy ? '…' : (portal ? 'Abrir portal' : 'Abrir')) : null,
      (!portal && !closed) ? h('button', { class: 'btn', type: 'button', disabled: busy || x.offline, onClick: () => run(x, 'close') }, busy ? '…' : 'Cerrar') : null));
}
async function run(x, action) {
  const verb = action === 'open' ? 'Abrir' : 'Cerrar';
  if (S.data?.confirm !== false && !(await confirmDlg(`${verb} ${x.name}`, x.kind === 'portal' ? 'Se enviará un pulso de apertura al portal.' : (action === 'open' && x.can_open ? 'Se abrirá también el resbalón.' : ''), verb, action === 'open'))) return;
  S.busy.add(x.entity_id); paint();
  try { const r = await fetch('api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_id: x.entity_id, action }) }); const j = await r.json(); toast(j.message || j.error || (r.ok ? 'Hecho' : 'Error'), !r.ok); }
  catch { toast('No se pudo enviar la orden.', true); }
  finally { S.busy.delete(x.entity_id); await load(); }
}
$('refresh').addEventListener('click', load);
setInterval(() => { if (document.visibilityState === 'visible' && !S.busy.size) load(); }, 10000);
load();
