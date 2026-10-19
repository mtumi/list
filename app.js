// list.secretprogress.com: the to-do list page, standalone at list.secretprogress.com.
// Same design and behaviour as the claude.ai page it replaces. What changed: it signs in to Supabase Auth
// itself (emailed link or code, no password) and calls the todo_api functions through the Supabase web
// interface. Every function checks the signed-in address in the database; this file decides nothing about
// who may see what. Updates arrive as a data-free Realtime signal on the private topic 'todo-list', with a
// slow poll as a safety net (a fast one when Realtime is not connected).
'use strict';

const CFG = window.LIST_CONFIG || {};
const AREA_COLOR = {'Job search':'--a1','Music':'--a2',"Will's recruiting":'--a3','Health':'--a4','AI/System':'--a5','System':'--a5','Home':'--a6','Other':'--a0'};
const POLL_FAST = 4000, POLL_SLOW = 30000;

let sb = null, session = null, started = false, channel = null, live = false, lastPoll = 0;
let data = null, timeData = null, stamp = null, fetchedAt = 0, lastOk = 0, busy = 0, busySince = 0, sentTo = '';
const busyStart = () => { busy += 1; busySince = Date.now(); };
const busyEnd = () => { busy = Math.max(0, busy - 1); };
const isBusy = () => busy > 0 && Date.now() - busySince < 20000;   // never block refreshes for more than 20 seconds
let view = {area:null, status:'open', mode:'list', time_since:null, label:'Everything', updated_at:null};
const openNotes = new Set();
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clean = s => String(s || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\*/g, '');
const color = a => `var(${AREA_COLOR[a] || '--a0'})`;
const fmtMin = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2,'0')}` : `${m} min`; };
const fmtClock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; };
const fmtTime = iso => new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
const SVG_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>';
const SVG_GRIP = '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.3"/><circle cx="6" cy="2" r="1.3"/><circle cx="2" cy="7" r="1.3"/><circle cx="6" cy="7" r="1.3"/><circle cx="2" cy="12" r="1.3"/><circle cx="6" cy="12" r="1.3"/></svg>';

// ---------- screens
function screen(name) {
  $('signin').hidden = name !== 'signin';
  $('denied').hidden = name !== 'denied';
  $('app').hidden = name !== 'app';
}
function signinStatus(text, kind) { const s = $('signinstatus'); s.textContent = text || ''; s.className = 'status' + (kind ? ' ' + kind : ''); }
function showStep() { $('step-email').hidden = false; }

// ---------- talking to Supabase
async function call(fn, args = {}, retried = false) {
  const {data: r, error, status} = await sb.rpc(fn, args);
  if (error) {
    const e = {code: error.code, status, message: error.message || 'Supabase refused that'};
    if (!retried && (error.code === 'PGRST301' || error.code === 'PGRST303' || /jwt expired/i.test(error.message || ''))) {
      const {error: re} = await sb.auth.refreshSession();
      if (!re) return call(fn, args, true);
    }
    throw e;
  }
  lastOk = Date.now(); setSync();
  return r;
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, msg.length > 200 ? 30000 : 3200); }
function banner(text, strong, action) {
  const b = $('banner'); if (!text) { b.hidden = true; b.replaceChildren(); return; }
  b.className = 'banner'; b.hidden = false; b.replaceChildren();
  if (strong) b.append(el('b', null, strong));
  b.append(el('span', null, text));
  if (action) { const btn = el('button', null, action.label); btn.type = 'button'; btn.onclick = action.run; b.append(btn); }
}
function showError(e, context) {
  const code = e && e.code, msg = String((e && e.message) || e || '');
  if (code === 'PGRST106' || /schema must be one of/i.test(msg)) {
    banner('Add todo_api to the exposed schemas in the Supabase dashboard (Data API settings), then reload.', 'Supabase is not serving the to-do functions yet. ');
  } else if (code === '42501') {
    // The database refused this address. Show the plain refusal screen.
    denied();
  } else if (e instanceof TypeError || /failed to fetch|network/i.test(msg)) {
    setSync('stale', 'Supabase did not answer; trying again');
  } else {
    toast((context ? context + ': ' : '') + msg.slice(0, 400));
  }
}
function setSync(kind, text) {
  const s = $('sync');
  if (kind) { s.className = 'sync ' + kind; $('synctext').textContent = text; return; }
  s.className = 'sync'; const ago = Math.round((Date.now() - lastOk) / 1000);
  $('synctext').textContent = !lastOk ? 'Connecting' : live && ago < 60 ? 'Live' : ago < 10 ? 'Up to date' : `Checked ${ago} s ago`;
}

// ---------- reading
async function refresh(listToo = true) {
  try {
    if (listToo) { data = await call('todo_list', {area: null, include_done: true}); fetchedAt = Date.now(); }
    if (view.mode === 'time') timeData = await call('todo_time_view');
    banner(null); render();
  } catch (e) { showError(e, 'Loading the list'); }
}
async function poll(force = false) {
  if (!started || isBusy()) return;
  if (!force && (document.hidden || Date.now() - lastPoll < (live ? POLL_SLOW : POLL_FAST) - 200)) return;
  lastPoll = Date.now();
  try {
    const r = await call('todo_view');
    const v = r.view || {};
    const viewChanged = v.updated_at !== view.updated_at;
    if (viewChanged) view = v;
    if (stamp !== null && r.stamp !== stamp) { stamp = r.stamp; await refresh(true); return; }
    stamp = r.stamp;
    if (viewChanged) { if (view.mode === 'time') await refresh(false); else render(); }
  } catch (e) { showError(e); }
}
let signalTimer = null;
function onSignal() { clearTimeout(signalTimer); signalTimer = setTimeout(() => poll(true), 250); }
async function listen() {
  if (channel) { await sb.removeChannel(channel); channel = null; }
  try { await sb.realtime.setAuth(session && session.access_token); } catch (e) { /* the poll covers it */ }
  channel = sb.channel('todo-list', {config: {private: true}})
    .on('broadcast', {event: 'changed'}, onSignal)
    .subscribe(status => { live = status === 'SUBSCRIBED'; setSync(); if (live) poll(true); });
}

// ---------- writing
async function act(fn, args, context, optimistic) {
  busyStart();
  try {
    if (optimistic) { optimistic(); render(); }
    const r = await call(fn, args);
    if (r && r.ok === false) {
      toast(r.message + (r.candidates ? ' ' + r.candidates.map(c => `${c.id}: ${clean(c.title).slice(0,40)}`).join('; ') : ''));
    } else if (r && r.message && !/^(Moved|Changed|Marked)/.test(r.message)) toast(r.message);
    return r;
  } catch (e) { showError(e, context); }
  finally { busyEnd(); await refresh(true); }
}
async function setView(text, local) {
  Object.assign(view, local); render();
  busyStart();
  try { const r = await call('todo_show', {view: text}); if (r && r.view) view = r.view; }
  catch (e) { showError(e, 'Changing the view'); }
  finally { busyEnd(); }
  if (view.mode === 'time') await refresh(false); else render();
}
function viewPhrase(area, status, mode) {
  if (mode === 'board') return (area || 'everything') + ' board';
  return (area || 'everything') + (status === 'doing' ? ' in progress' : status === 'all' ? ' with done' : '');
}

// ---------- drawing
function render() {
  if (!data) return;
  renderControls(); renderRunning(); renderToday();
  const main = $('main'); main.replaceChildren();
  $('viewnote').textContent = view.updated_by && view.updated_by !== 'web' && view.updated_at ? `Showing: ${view.label} (set by ${view.updated_by})` : '';
  if (view.mode === 'time') return renderTime(main);
  if (view.mode === 'board') return renderBoard(main);
  const board = el('div', 'board' + (view.area ? ' single' : ''));
  for (const a of data.areas) {
    if (view.area && a.area !== view.area) continue;
    const items = a.items.filter(t => view.status === 'all' ? true : view.status === 'doing' ? t.status === 'doing' : t.status !== 'done');
    if (view.status === 'doing' && !items.length && !view.area) continue;
    const box = el('section', 'area'); box.dataset.area = a.area;
    const h = el('h2'); const sw = el('span', 'sw'); sw.style.background = color(a.area);
    h.append(sw, el('span', null, a.area), el('span', 'n', `${a.open} open`)); box.append(h);
    const ul = el('ul', 'items'); ul.dataset.area = a.area;
    let group;
    for (const t of items) {
      if (t.group !== group) { group = t.group; if (group) { const g = el('li', 'group', clean(group)); g.title = clean(group); ul.append(g); } }
      ul.append(itemRow(t));
      if (openNotes.has(t.id) && t.notes) ul.append(el('li', 'notes', clean(t.notes)));
    }
    if (!items.length) ul.append(el('li', 'empty', view.status === 'doing' ? 'Nothing in progress here.' : 'Nothing open here.'));
    box.append(ul); board.append(box);
  }
  if (!board.children.length) board.append(el('div', 'empty', 'Nothing in progress right now.'));
  main.append(board);
}
function itemRow(t) {
  const li = el('li', 'item'); li.dataset.id = t.id; li.dataset.s = t.status;
  const st = el('button', 'st'); st.type = 'button'; st.dataset.s = t.status;
  const next = {todo:'doing', doing:'done', done:'todo'}[t.status];
  st.setAttribute('aria-label', `${clean(t.title)}: ${t.status === 'doing' ? 'in progress' : t.status === 'todo' ? 'to do' : 'done'}. Tap to mark ${next === 'doing' ? 'in progress' : next === 'todo' ? 'to do' : 'done'}.`);
  st.onclick = () => act('todo_status', {item: String(t.id), status: next}, 'Changing status', () => { t.status = next; });
  const title = el('span', 'title' + (t.notes ? ' has-notes' : ''), clean(t.title)); title.title = clean(t.title); title.tabIndex = 0;
  const toggle = () => { openNotes.has(t.id) ? openNotes.delete(t.id) : openNotes.add(t.id); render(); };
  title.onclick = toggle; title.onkeydown = e => { if (e.key === 'Enter') toggle(); };
  li.append(st, title);
  if (t.recurring) li.append(el('span', 'tag', t.cadence || 'repeats'));
  if (t.alongside) li.append(el('span', 'tag', 'alongside'));
  const running = !!t.running_since;
  const mins = (t.minutes_today || 0) + (running ? (Date.now() - fetchedAt) / 60000 : 0);
  if (mins >= 1 && !running) li.append(el('span', 'mins', fmtMin(mins)));
  if (running) { const c = el('span', 'mins'); c.dataset.since = t.running_since; c.textContent = fmtClock(Date.now() - Date.parse(t.running_since)); li.append(c); }
  const go = el('button', 'go' + (running ? ' on' : '')); go.type = 'button';
  go.innerHTML = running ? SVG_PAUSE : SVG_PLAY;
  go.setAttribute('aria-label', running ? `Pause ${clean(t.title)}` : `Start the clock on ${clean(t.title)}`);
  go.onclick = () => running ? act('todo_pause', {item: String(t.id)}, 'Pausing') : act('todo_start', {item: String(t.id)}, 'Starting');
  const grip = el('button', 'grip'); grip.type = 'button'; grip.innerHTML = SVG_GRIP; grip.setAttribute('aria-label', `Drag to reorder ${clean(t.title)}`);
  grip.addEventListener('pointerdown', e => startDrag(e, li, t));
  li.append(go, grip);
  return li;
}
function renderControls() {
  const chips = $('chips'); chips.replaceChildren();
  const board = view.mode === 'board';
  const mk = (label, area) => { const b = el('button', 'chip', label); b.type = 'button'; b.setAttribute('aria-pressed', String(view.mode !== 'time' && (view.area || null) === area));
    b.onclick = () => board ? setView(viewPhrase(area, 'open', 'board'), {area, mode:'board', status:'open', updated_by:'web'})
                            : setView(viewPhrase(area, view.status === 'all' || view.status === 'doing' ? view.status : 'open'), {area, mode:'list', updated_by:'web'}); return b; };
  chips.append(mk('Everything', null));
  for (const a of data.areas) chips.append(mk(a.area, a.area));
  for (const b of $('modeseg').children) {
    const m = b.dataset.mode; b.setAttribute('aria-pressed', String(m === 'board' ? board : view.mode === 'list'));
    b.onclick = () => m === 'board' ? setView(viewPhrase(view.area, 'open', 'board'), {mode:'board', status:'open', updated_by:'web'})
                                    : setView(viewPhrase(view.area, 'open'), {mode:'list', status:'open', updated_by:'web'});
  }
  for (const b of $('seg').children) {
    const s = b.dataset.status; b.hidden = board && s !== 'time';
    b.setAttribute('aria-pressed', String(s === 'time' ? view.mode === 'time' : view.mode === 'list' && view.status === s));
    b.onclick = () => s === 'time' ? setView('time today', {mode:'time', time_since:'today', updated_by:'web'})
                                   : setView(viewPhrase(view.area, s), {status:s, mode:'list', updated_by:'web'});
  }
  const sel = $('addarea');
  const names = data.areas.map(a => a.area);
  if ([...sel.options].map(o => o.value).join('|') !== names.join('|')) { const keep = sel.value; sel.replaceChildren(...names.map(n => new Option(n, n))); if (names.includes(keep)) sel.value = keep; }
  if (view.area && document.activeElement !== sel && document.activeElement !== $('addtext')) sel.value = view.area;
}
function renderRunning() {
  const box = $('running'); box.replaceChildren();
  const runs = data.running || [];
  if (!runs.length) box.append(el('span', 'idle', 'Nothing is running. Press the play mark on an item to start its clock.'));
  for (const r of runs) {
    const row = el('div', 'run'); row.append(el('span', 'dot'), el('span', 'what', clean(r.what)));
    if (r.alongside) row.append(el('span', 'side', 'alongside'));
    const c = el('span', 'clock'); c.dataset.since = r.started_at; c.textContent = fmtClock(Date.now() - Date.parse(r.started_at)); row.append(c);
    const p = el('button', 'btn', 'Pause'); p.type = 'button';
    p.onclick = () => act('todo_pause', r.item ? {item: String(r.item)} : {}, 'Pausing');
    row.append(p); box.append(row);
  }
  for (const n of data.needs_check || []) {
    const row = el('div', 'check');
    row.append(el('span', null, `${clean(n.what)} ran ${fmtMin(n.minutes)}${n.running ? ' and is still running' : ''}. It is left out of the totals until you say.`));
    const ok = el('button', 'btn', 'Count it'); ok.type = 'button'; ok.onclick = () => act('todo_time_fix', {entry: n.entry, confirm: true}, 'Confirming');
    const no = el('button', 'btn warn', 'Discard'); no.type = 'button'; no.onclick = () => act('todo_time_fix', {entry: n.entry, discard: true}, 'Discarding');
    row.append(ok, no); box.append(row);
  }
}
function renderToday() {
  const box = $('today'); box.replaceChildren();
  const extra = (Date.now() - fetchedAt) / 60000;
  const by = {}; for (const a of (data.time_today && data.time_today.by_area) || []) by[a.area] = a.minutes;
  for (const r of data.running || []) if (!r.needs_check) by[r.area || 'Other'] = (by[r.area || 'Other'] || 0) + extra;
  const total = Object.values(by).reduce((s, m) => s + m, 0);
  if (total < 1) { box.append(el('span', 'idle', 'No time logged yet today.')); return; }
  const strip = el('div', 'strip'), legend = el('div', 'legend');
  for (const [a, m] of Object.entries(by).sort((x, y) => y[1] - x[1])) {
    const s = el('span'); s.style.width = (100 * m / total) + '%'; s.style.background = color(a); s.title = `${a}: ${fmtMin(m)}`; strip.append(s);
    const l = el('span'); const sw = el('span', 'sw'); sw.style.background = color(a); l.append(sw, a + ' ', el('b', null, fmtMin(m))); legend.append(l);
  }
  const tot = el('span'); tot.append('Total ', el('b', null, fmtMin(total))); legend.prepend(tot);
  box.append(strip, legend);
}
function renderTime(main) {
  const t = timeData;
  if (!t) { main.append(el('div', 'loading', 'Loading the time log.')); return; }
  const wrap = el('div', 'time');
  const left = el('div', 'panel');
  left.append(el('div', 'label', `Time ${t.span || 'today'}`), el('h2', null, fmtMin(t.total_minutes)));
  const max = Math.max(1, ...t.by_area.map(a => a.minutes));
  const ra = el('div', 'rows');
  for (const a of t.by_area) { const r = el('div'); const row = el('div', 'row'); row.append(el('span', 't', a.area), el('span', 'v', fmtMin(a.minutes)));
    const bar = el('div', 'bar'); bar.style.width = (100 * a.minutes / max) + '%'; bar.style.background = color(a.area); r.append(row, bar); ra.append(r); }
  if (!t.by_area.length) ra.append(el('div', 'empty', 'No time logged in this stretch.'));
  left.append(ra, el('div', 'label', 'By item'));
  const ri = el('div', 'rows');
  for (const i of t.by_item) { const row = el('div', 'row'); const tt = el('span', 't', clean(i.what)); tt.title = clean(i.what); row.append(tt, el('span', 'v', fmtMin(i.minutes))); ri.append(row); }
  left.append(ri);
  const right = el('div', 'panel'); right.append(el('div', 'label', 'Entries'));
  const re = el('div', 'rows');
  for (const e of t.entries) { const row = el('div', 'row'); const tt = el('span', 't', `${fmtTime(e.started_at)} to ${e.ended_at ? fmtTime(e.ended_at) : 'now'}  ${clean(e.what)}`); tt.title = clean(e.what);
    row.append(tt, el('span', 'v', (e.needs_check ? 'check: ' : '') + fmtMin(e.minutes))); re.append(row); }
  if (!t.entries.length) re.append(el('div', 'empty', 'No entries.'));
  right.append(re, el('p', 'viewnote', 'Entries over two hours count only after you confirm them.'));
  wrap.append(left, right); main.append(wrap);
}

// ---------- the board: To do, In progress, Done
// One card per item: title, area, live clock, repeating and alongside markers. Tap a card to cycle its
// status as in the list. Drag by the grip (touch) or anywhere on the card (mouse) to another column to change
// status, or within a column to reorder. Into In progress starts the clock (todo_start, which pauses the main
// running item unless this one runs alongside); out of it stops the clock; into Done is todo_done.
let showOlderDone = false, suppressClick = false;
const STATUS_WORD = {todo:'to do', doing:'in progress', done:'done'};
function renderBoard(main) {
  const cols = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
  const items = data.areas.filter(a => !view.area || a.area === view.area).flatMap(a => a.items);
  const weekAgo = Date.now() - 7 * 864e5;
  const wrap = el('div', 'kanban');
  for (const [s, name] of cols) {
    let list = items.filter(t => t.status === s), older = 0;
    if (s === 'done') {
      list.sort((x, y) => Date.parse(y.done_at || 0) - Date.parse(x.done_at || 0));
      const recent = list.filter(t => t.done_at && Date.parse(t.done_at) >= weekAgo);
      older = list.length - recent.length;
      if (!showOlderDone) list = recent;
    }
    const col = el('section', 'col'); col.dataset.status = s;
    const h = el('h2'); h.append(el('span', 'mark'), el('span', null, name), el('span', 'n', String(list.length))); col.append(h);
    const ul = el('ul', 'cards'); ul.dataset.status = s;
    for (const t of list) ul.append(card(t));
    if (!list.length) ul.append(el('li', 'empty', s === 'doing' ? 'Nothing in progress.' : s === 'done' ? 'Nothing finished in the last 7 days.' : 'Nothing to do here.'));
    col.append(ul);
    if (s === 'done' && (older || showOlderDone)) {
      const b = el('button', 'link more', showOlderDone ? 'Show only the last 7 days' : `Show ${older} older (up to 30 days)`); b.type = 'button';
      b.onclick = () => { showOlderDone = !showOlderDone; render(); }; col.append(b);
    }
    wrap.append(col);
  }
  main.append(wrap);
}
function card(t) {
  const li = el('li', 'kcard'); li.dataset.id = t.id; li.dataset.s = t.status; li.dataset.area = t.area;
  li.style.setProperty('--area', color(t.area)); li.tabIndex = 0;
  const next = {todo:'doing', doing:'done', done:'todo'}[t.status];
  li.setAttribute('aria-label', `${clean(t.title)}, ${t.area}, ${STATUS_WORD[t.status]}. Press to mark ${STATUS_WORD[next]}.`);
  const row = el('div', 'crow'); const title = el('span', 'ctitle', clean(t.title)); title.title = clean(t.title);
  const grip = el('button', 'grip'); grip.type = 'button'; grip.innerHTML = SVG_GRIP; grip.setAttribute('aria-label', `Drag ${clean(t.title)} to another column or place`);
  row.append(title, grip);
  const meta = el('div', 'cmeta');
  const ar = el('span', 'carea'); const sw = el('span', 'sw'); sw.style.background = color(t.area); ar.append(sw, t.area); meta.append(ar);
  if (t.recurring) meta.append(el('span', 'tag', t.cadence || 'repeats'));
  if (t.alongside) meta.append(el('span', 'tag', 'alongside'));
  if (t.running_since) { const c = el('span', 'mins'); c.dataset.since = t.running_since; c.textContent = fmtClock(Date.now() - Date.parse(t.running_since)); meta.append(c); }
  else if ((t.minutes_today || 0) >= 1) meta.append(el('span', 'mins', fmtMin(t.minutes_today)));
  li.append(row, meta);
  const cycle = () => act('todo_status', {item: String(t.id), status: next}, 'Changing status', () => { t.status = next; });
  li.onclick = e => { if (suppressClick || e.target.closest('.grip')) return; cycle(); };
  li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycle(); } };
  grip.addEventListener('pointerdown', e => { e.stopPropagation(); startCardDrag(e, li, t, false); });
  li.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) startCardDrag(e, li, t, true); });
  return li;
}
function startCardDrag(e, li, t, needMove) {
  const x0 = e.clientX, y0 = e.clientY; let dragging = false, finished = false, ghost = null, offX = 0, offY = 0;
  const begin = () => {
    dragging = true; suppressClick = true; busyStart();
    const r = li.getBoundingClientRect(); offX = x0 - r.left; offY = y0 - r.top;
    ghost = li.cloneNode(true); ghost.classList.add('ghost'); ghost.style.width = r.width + 'px';
    ghost.style.transform = `translate(${r.left}px, ${r.top}px)`; document.body.append(ghost);
    li.classList.add('dragging');
  };
  if (!needMove) { e.preventDefault(); begin(); }
  const move = ev => {
    if (!dragging) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return; begin(); }
    ev.preventDefault();
    ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px)`;
    if (ev.clientY < 60) window.scrollBy(0, -14); else if (ev.clientY > innerHeight - 60) window.scrollBy(0, 14);
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const col = over && over.closest('.col'); if (!col) return;
    const ul = col.querySelector('.cards');
    const next = [...ul.querySelectorAll('.kcard')].filter(c => c !== li)
      .find(c => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (li.parentElement !== ul || li.nextElementSibling !== (next || null)) ul.insertBefore(li, next || null);
    const empty = ul.querySelector('.empty'); if (empty) empty.hidden = true;
  };
  const up = async () => {
    if (finished) return; finished = true;
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    if (!dragging) return;   // a tap: the click handler cycles the status
    ghost.remove(); li.classList.remove('dragging'); busyEnd();
    setTimeout(() => { suppressClick = false; }, 0);
    const to = li.parentElement.dataset.status;
    const sibs = [...li.parentElement.querySelectorAll('.kcard')], i = sibs.indexOf(li);
    const after = sibs.slice(i + 1).find(c => c.dataset.area === t.area);
    const before = sibs.slice(0, i).find(c => c.dataset.area === t.area);
    await moveCard(t, t.status, to, after ? after.dataset.id : null, !after && !!before);
  };
  window.addEventListener('pointermove', move, {passive: false}); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
// Change status first (with the clock rules above), then the place within the column, which is the same order
// as the list. Done is ordered by when items were finished, so a place there is not kept.
async function moveCard(t, from, to, beforeId, toEnd) {
  busyStart();
  try {
    if (to !== from) {
      const item = String(t.id);
      const r = to === 'doing' ? await call('todo_start', {item})
              : to === 'done' ? await call('todo_done', {item})
              : await call('todo_status', {item, status: 'todo'});
      if (r && r.ok === false) { toast(r.message); return; }
      if (r && r.message && to === 'doing') toast(r.message);
    }
    if (to !== 'done' && (beforeId || toEnd)) {
      const r = await call('todo_move', beforeId ? {item: String(t.id), before_item: beforeId} : {item: String(t.id), to_end: true});
      if (r && r.ok === false) toast(r.message);
    }
  } catch (e) { showError(e, 'Moving'); }
  finally { busyEnd(); await refresh(true); }
}

// ---------- drag to reorder, within an area (pointer events, so it works with touch on iPad)
function startDrag(e, li, t) {
  e.preventDefault();
  const ul = li.parentElement; let finished = false;
  li.classList.add('dragging'); busyStart();
  const move = ev => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest('.item');
    if (!target || target === li || target.parentElement !== ul) return;
    const r = target.getBoundingClientRect();
    ul.insertBefore(li, ev.clientY < r.top + r.height / 2 ? target : target.nextSibling);
  };
  // Listen on the window: moving the row in the page drops any pointer capture on the grip.
  const up = async () => {
    if (finished) return; finished = true;
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    li.classList.remove('dragging');
    let n = li.nextElementSibling; while (n && !n.classList.contains('item')) n = n.nextElementSibling;
    busyEnd();
    if (n) await act('todo_move', {item: String(t.id), before_item: n.dataset.id}, 'Moving');
    else await act('todo_move', {item: String(t.id), to_end: true}, 'Moving');
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

// ---------- signing in
function explainAuthError(error) {
  const m = String((error && error.message) || error || '');
  if (/rate limit|only request this after|too many/i.test(m)) return 'Too many emails asked for in a short time. Wait a minute, then try again.';
  if (/signups? not allowed|user not found/i.test(m)) return 'This address cannot sign in here.';
  if (/expired|invalid/i.test(m)) return 'That code or link has expired or is wrong. Ask for a new one.';
  if (/code verifier|both auth code and code verifier/i.test(m)) return 'That link was opened in a different browser from the one that asked for it. Type the code from the email instead.';
  if (/fetch|network/i.test(m)) return 'Supabase did not answer. Check the connection and try again.';
  return m.slice(0, 200) || 'Something went wrong.';
}
async function passwordSignIn() {
  const email = $('email').value.trim().toLowerCase(), password = $('password').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { signinStatus('Type a whole email address.', 'err'); return; }
  if (!password) { signinStatus('Type your password.', 'err'); $('password').focus(); return; }
  $('pwbtn').disabled = true; signinStatus('Signing in.');
  const {error} = await sb.auth.signInWithPassword({email, password});
  $('pwbtn').disabled = false;
  if (error) signinStatus(/invalid login/i.test(error.message || '') ? 'Wrong email or password.' : explainAuthError(error), 'err');
  else { signinStatus('Signed in.', 'good'); try { localStorage.setItem('list-last-email', email); } catch (e) { /* private mode */ } }
}
$('emailform').addEventListener('submit', e => { e.preventDefault(); passwordSignIn(); });
$('changepw').onclick = () => { $('newpw').value = ''; $('newpw2').value = ''; $('pwstatus').textContent = ''; $('pwdialog').showModal(); setTimeout(() => $('newpw').focus(), 50); };
$('pwcancel').onclick = () => $('pwdialog').close();
$('pwform').addEventListener('submit', async e => {
  e.preventDefault();
  const a = $('newpw').value, b = $('newpw2').value, st = $('pwstatus');
  st.className = 'status err';
  if (a.length < 8) { st.textContent = 'Use at least 8 characters.'; return; }
  if (a !== b) { st.textContent = 'The two passwords do not match.'; return; }
  $('pwsave').disabled = true; st.className = 'status'; st.textContent = 'Saving.';
  const {error} = await sb.auth.updateUser({password: a});
  $('pwsave').disabled = false;
  if (error) { st.className = 'status err'; st.textContent = String(error.message || 'Supabase refused that.').slice(0, 200); return; }
  st.className = 'status good'; st.textContent = 'Password changed.';
  setTimeout(() => $('pwdialog').close(), 900);
});
async function signOut() {
  started = false; data = null; stamp = null;
  if (channel) { try { await sb.removeChannel(channel); } catch (e) { /* ignore */ } channel = null; }
  await sb.auth.signOut({scope: 'local'});
}
$('signout').onclick = signOut;
$('deniedout').onclick = signOut;

function denied() {
  started = false;
  if (channel) { sb.removeChannel(channel); channel = null; }
  $('deniedas').textContent = (session && session.user && session.user.email) || 'this address';
  screen('denied');
}
function showSignin() {
  started = false; screen('signin'); showStep('email');
  try { const last = localStorage.getItem('list-last-email'); if (last && !$('email').value) $('email').value = last; } catch (e) { /* private mode */ }
}

// ---------- start, once signed in
async function start() {
  if (started) return;
  started = true;
  let allowed;
  try { allowed = await call('access'); }
  catch (e) {
    started = false;
    if (e.code === 'PGRST106' || /schema must be one of/i.test(e.message)) {
      screen('app'); setSync('off', 'Not served');
      $('main').replaceChildren(el('div', 'loading', 'Signed in. Supabase is not serving the to-do functions yet: add todo_api to the exposed schemas in the dashboard (Data API settings), then reload.'));
    } else { showSignin(); signinStatus(explainAuthError(e), 'err'); }
    return;
  }
  if (!allowed || allowed.ok !== true) { denied(); return; }
  screen('app');
  try {
    data = await call('todo_list', {area: null, include_done: true}); fetchedAt = Date.now();
    const v = await call('todo_view'); view = v.view; stamp = v.stamp; lastPoll = Date.now();
    if (view.mode === 'time') timeData = await call('todo_time_view');
    render(); listen();
  } catch (e) {
    setSync('off', 'Not loaded');
    showError(e, 'Loading the list');
  }
}

$('add').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('addtext').value.trim(); if (!text || !started) return;
  $('addtext').value = '';
  await act('todo_add', {area: $('addarea').value, what: text}, 'Adding');
});
setInterval(() => {
  for (const c of document.querySelectorAll('[data-since]')) c.textContent = fmtClock(Date.now() - Date.parse(c.dataset.since));
  if (lastOk && started) setSync();
}, 1000);
setInterval(() => { if (data && started && !isBusy()) renderToday(); }, 60000);
setInterval(() => poll(false), POLL_FAST);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });

(async () => {
  if (!window.supabase || !CFG.supabaseUrl || !CFG.publishableKey || /PASTE_/.test(CFG.publishableKey)) {
    screen('signin'); showStep('email'); $('pwbtn').disabled = true;
    signinStatus('This copy of the page has no Supabase key yet. Put the publishable key in config.js.', 'err');
    return;
  }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey, {
    auth: {flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'list-auth'},
    db: {schema: 'todo_api'},
  });

  // A link from the email: either ?code= (handled by the client, same browser only) or ?token_hash= (any browser).
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const linkError = q.get('error_description') || h.get('error_description');
  if (q.get('token_hash')) {
    const {error} = await sb.auth.verifyOtp({token_hash: q.get('token_hash'), type: q.get('type') || 'email'});
    if (error) { showSignin(); signinStatus(explainAuthError(error), 'err'); }
  }

  sb.auth.onAuthStateChange((event, s) => {
    session = s;
    // Calls back into Supabase must not run inside this callback.
    setTimeout(() => {
      if (s && !started) start();
      else if (!s) showSignin();
      if (s && event === 'TOKEN_REFRESHED' && channel) sb.realtime.setAuth(s.access_token);
    }, 0);
  });
  const {data: got, error} = await sb.auth.getSession();
  if (location.search || location.hash) history.replaceState(null, '', location.pathname);
  session = got && got.session;
  if (session) start();
  else { showSignin(); if (linkError || error) signinStatus(explainAuthError(linkError || error), 'err'); }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
