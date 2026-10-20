// Secret progress: the to-do list page, standalone at list.secretprogress.com.
// Same design and behaviour as the claude.ai page it replaces. What changed: it signs in to Supabase Auth
// itself (emailed link or code, no password) and calls the todo_api functions through the Supabase web
// interface. Every function checks the signed-in address in the database; this file decides nothing about
// who may see what. Updates arrive as a data-free Realtime signal on the private topic 'todo-list', with a
// slow poll as a safety net (a fast one when Realtime is not connected).
'use strict';

const CFG = window.LIST_CONFIG || {};
const AREA_COLOR = {'Job search':'--a1','Music':'--a2',"Will's recruiting":'--a3','Will':'--a3','Health':'--a4','AI/System':'--a5','System':'--a5','Home':'--a6','Other':'--a0'};
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
const OWNER_WORD = {michael: 'Michael', claude: 'Claude', both: 'Michael with Claude'};
// The small markers on a row or card: Claude's item, steps done, workstream progress, an open call, waiting.
function markers(t) {
  const out = [];
  const tag = (cls, text, title) => { const e = el('span', 'tag ' + cls, text); if (title) e.title = title; out.push(e); };
  if (t.owner === 'claude') tag('claude', 'Claude', 'Claude does this one');
  else if (t.owner === 'both') tag('claude', 'with Claude', 'Michael with Claude');
  if (t.alongside) tag('bg', 'bg', 'Background: runs without your attention; its time stays out of focus time');
  if (t.children_total) tag('steps', `${t.children_done} of ${t.children_total} sub-items done`, 'Sub-items done');
  if (t.steps_total) tag('steps', `${t.steps_done}/${t.steps_total}`, `${t.steps_done} of ${t.steps_total} steps done`);
  if (t.workstream) tag('steps', `${t.workstream.items_done} of ${t.workstream.items_total} done`, 'Workstream items done');
  if (t.your_call) tag('call', 'Your call', t.question ? clean(t.question).slice(0, 200) : 'A workstream item is waiting for your call');
  if (t.waiting && t.waiting_on_title) tag('wait', 'Waiting on: ' + clean(t.waiting_on_title), 'Waiting on: ' + clean(t.waiting_on_title));
  return out;
}
const codeLabel = t => { const c = el('span', 'cid', t.code || ''); c.title = 'Say this code to name the item'; return c; };
// True when item `id` sits somewhere under item `ancestor`.
function isUnder(id, ancestor) { let x = itemById(id), n = 0; while (x && x.parent_id && n++ < 20) { if (x.parent_id === ancestor) return true; x = itemById(x.parent_id); } return false; }
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) { /* nothing more to try */ } ta.remove();
  }
  toast(done || 'Copied.');
}
// Workstream Briefs are short markdown: paragraphs, bullet lines and **bold**. Built from text nodes only.
function prose(text) {
  const box = el('div', 'prose');
  const inline = (parent, line) => {
    String(line).split(/(\*\*[^*]+\*\*)/g).forEach(part => {
      if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el('b', null, part.slice(2, -2).replace(/`/g, '')));
      else if (part) parent.append(linkified(part.replace(/`/g, '')));
    });
  };
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(l => l.trim());
    if (!lines.length) continue;
    if (lines.every(l => /^\s*([-*]|\d+[.)])\s+/.test(l))) {
      const ul = el('ul'); for (const l of lines) { const li = el('li'); inline(li, l.replace(/^\s*([-*]|\d+[.)])\s+/, '')); ul.append(li); } box.append(ul);
    } else { const p = el('p'); inline(p, lines.join(' ')); box.append(p); }
  }
  return box;
}

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
  shownIds = [];
  renderControls(); renderRunning(); renderToday(); renderStrip(); renderTally();
  const waiting = (data.notes_for_claude || []).length;
  $('notecount').hidden = !waiting; $('notecount').textContent = waiting === 1 ? '1 note waiting for Claude' : `${waiting} notes waiting for Claude`;
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
    const h = el('h2'); h.style.setProperty('--rail', color(a.area)); const sw = el('span', 'sw'); sw.style.background = color(a.area);
    h.append(sw, el('span', null, a.area), el('span', 'n', `${a.open} open`)); box.append(h);
    const ul = el('ul', 'items'); ul.dataset.area = a.area;
    let group;
    const here = new Set(items.map(t => t.id)), kids = {};
    for (const t of items) if (t.parent_id && here.has(t.parent_id)) (kids[t.parent_id] = kids[t.parent_id] || []).push(t);
    const addRow = (t, depth) => {
      ul.append(itemRow(t, depth));
      if (openNotes.has(t.id) && t.notes) ul.append(el('li', 'notes', clean(t.notes)));
      if (depth < 6) for (const c of kids[t.id] || []) addRow(c, depth + 1);
    };
    for (const t of items) {
      if (t.parent_id && here.has(t.parent_id)) continue;
      if (t.group !== group) { group = t.group; if (group) { const g = el('li', 'group', clean(group)); g.title = clean(group); ul.append(g); } }
      addRow(t, 0);
    }
    if (!items.length) ul.append(el('li', 'empty', view.status === 'doing' ? 'Nothing in progress here.' : 'Nothing open here.'));
    box.append(ul); board.append(box);
  }
  if (!board.children.length) board.append(el('div', 'empty', 'Nothing in progress right now.'));
  main.append(board);
}

// A single click opens the details after a short pause, so a double click can rename the title in place instead.
let clickTimer = null;
function clickOpen(t) { clearTimeout(clickTimer); clickTimer = setTimeout(() => openDetail(t), 240); }
function renameInline(span, t) {
  clearTimeout(clickTimer); if (span.querySelector('input')) return;
  const inp = document.createElement('input'); inp.className = 'rename'; inp.value = t.title || ''; inp.setAttribute('aria-label', 'Rename');
  span.replaceChildren(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async save => { if (done) return; done = true; const v = inp.value.trim();
    if (save && v && v !== t.title) { span.textContent = v; await act('todo_edit', {item: String(t.id), title: v}, 'Renaming', () => { t.title = v; }); }
    else span.textContent = clean(t.title); };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
  inp.onclick = e => e.stopPropagation(); inp.onpointerdown = e => e.stopPropagation();
  inp.onblur = () => finish(true);
}
// Earlier stretches today for an item, so a running clock shows the day's total rather than only the current stretch.
function earlierMs(itemId, since) { const it = itemById(itemId); if (!it || !since) return 0;
  return Math.max(0, (it.minutes_today || 0) * 60000 - Math.max(0, fetchedAt - Date.parse(since))); }
const tick = (c) => { c.textContent = fmtClock(Date.now() - Date.parse(c.dataset.since) + (+c.dataset.base || 0)); };

// One compact line at the top: what is running (with pause), focus and background time, and a toggle for the
// fuller counts and time panels (Michael, 2026-10-19: "too much junk up top").
let showMore = false; try { showMore = localStorage.getItem('list-more') === '1'; } catch (e) { /* private mode */ }
function renderStrip() {
  const box = $('strip1'); box.replaceChildren();
  $('moredetail').hidden = !showMore;
  const runs = data.running || [];
  if (!runs.length) box.append(el('span', 'idle', 'Nothing running.'));
  for (const r of runs) {
    const chip = el('span', 'runchip'); chip.append(el('span', 'dot'), el('span', 'what', clean(r.what)));
    if (r.alongside) chip.append(el('span', 'tag bg', 'bg'));
    const c = el('span', 'clock'); c.dataset.since = r.started_at; c.dataset.base = r.item ? earlierMs(r.item, r.started_at) : 0; tick(c); chip.append(c);
    const p = el('button', 'pz', 'Pause'); p.type = 'button'; p.onclick = () => act('todo_pause', r.item ? {item: String(r.item)} : {}, 'Pausing');
    chip.append(p); box.append(chip);
  }
  const tt = data.time_today || {}, extra = (Date.now() - fetchedAt) / 60000, live = runs.filter(r => !r.needs_check);
  const focus = (tt.focus_minutes || 0) + (live.some(r => !r.alongside) ? extra : 0);
  const bg = (tt.background_minutes || 0) + (live.some(r => r.alongside) ? extra : 0);
  const t = el('span', 'stripsum'); t.append('Focus ', el('b', null, fmtMin(focus)));
  if (bg >= 1) t.append(' · bg ', el('b', null, fmtMin(bg)));
  box.append(t);
  const more = el('button', 'out moretoggle', showMore ? 'Less' : 'More'); more.type = 'button';
  more.onclick = () => { showMore = !showMore; try { localStorage.setItem('list-more', showMore ? '1' : '0'); } catch (e) { /* private mode */ } render(); };
  box.append(more);
}
$('menubtn').onclick = e => { e.stopPropagation(); const m = $('hmenu'); m.hidden = !m.hidden; $('menubtn').setAttribute('aria-expanded', String(!m.hidden)); };
document.addEventListener('click', e => { if (!e.target.closest('.hmenuwrap')) { $('hmenu').hidden = true; $('menubtn').setAttribute('aria-expanded', 'false'); } });
// Dropping a card onto another turns it into a step of that card (Michael, 2026-10-20: "make drops create steps").
async function dropAsStep(t, targetId) {
  if (String(t.id) === String(targetId)) return;
  const r = await act('todo_step_add', {item: String(targetId), step: clean(t.title)}, 'Adding it as a step');
  if (r && r.ok !== false) await act('todo_remove', {item: String(t.id)}, 'Removing the card');
}
function itemRow(t, depth = 0) {
  shownIds.push(t.id);
  const li = el('li', 'item'); li.dataset.id = t.id; li.dataset.s = t.status;
  if (depth) { li.classList.add('sub'); li.style.setProperty('--depth', depth); }
  const st = el('button', 'st'); st.type = 'button'; st.dataset.s = t.status;
  const next = {todo:'doing', doing:'done', done:'todo'}[t.status];
  st.setAttribute('aria-label', `${clean(t.title)}: ${t.status === 'doing' ? 'in progress' : t.status === 'todo' ? 'to do' : 'done'}. Tap to mark ${next === 'doing' ? 'in progress' : next === 'todo' ? 'to do' : 'done'}.`);
  st.onclick = () => act('todo_status', {item: String(t.id), status: next}, 'Changing status', () => { t.status = next; });
  const title = el('span', 'title' + (t.notes ? ' has-notes' : ''), clean(t.title)); title.title = clean(t.title); title.tabIndex = 0;
  title.onclick = () => clickOpen(t); title.ondblclick = e => { e.stopPropagation(); renameInline(title, t); }; title.onkeydown = e => { if (e.key === 'Enter') openDetail(t); };
  attachMenu(li, t);
  li.append(st, title);
  if (t.waiting) li.classList.add('waiting');
  li.append(...markers(t));
  if (t.recurring) li.append(el('span', 'tag', t.cadence || 'repeats'));
  const running = !!t.running_since;
  const mins = (t.minutes_today || 0) + (running ? (Date.now() - fetchedAt) / 60000 : 0);
  if (mins >= 1 && !running) li.append(el('span', 'mins', fmtMin(mins)));
  if (running) { const c = el('span', 'mins'); c.dataset.since = t.running_since; c.dataset.base = earlierMs(t.id, t.running_since); tick(c); li.append(c); }
  const go = el('button', 'go' + (running ? ' on' : '')); go.type = 'button';
  go.innerHTML = running ? SVG_PAUSE : SVG_PLAY;
  go.setAttribute('aria-label', running ? `Pause ${clean(t.title)}` : `Start the clock on ${clean(t.title)}`);
  go.onclick = () => running ? act('todo_pause', {item: String(t.id)}, 'Pausing') : act('todo_start', {item: String(t.id)}, 'Starting');
  const grip = el('button', 'grip'); grip.type = 'button'; grip.innerHTML = SVG_GRIP; grip.setAttribute('aria-label', `Drag to reorder ${clean(t.title)}`);
  grip.addEventListener('pointerdown', e => startDrag(e, li, t));
  li.append(go, grip, codeLabel(t));
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
// The stat tiles under the title, as on the workstream board: open, in progress, done today, your calls,
// notes waiting for Claude, time today.
function renderTally() {
  const box = $('tally'); box.replaceChildren();
  $('eyebrow').textContent = new Date().toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'}) + ' · To-do list and time log';
  const items = data.areas.flatMap(a => a.items);
  const today = new Date().toDateString();
  const focusRunning = (data.running || []).some(r => !r.needs_check && !r.alongside);
  const mins = ((data.time_today && data.time_today.focus_minutes) || 0) + (focusRunning ? (Date.now() - fetchedAt) / 60000 : 0);
  const tiles = [
    [items.filter(t => t.status === 'todo').length, 'to do', ''],
    [items.filter(t => t.status === 'doing').length, 'in progress', 'is-you'],
    [items.filter(t => t.status === 'done' && t.done_at && new Date(t.done_at).toDateString() === today).length, 'done today', 'is-accent'],
    [items.filter(t => t.status !== 'done' && t.your_call).length, 'waiting for your call', 'is-you'],
    [(data.notes_for_claude || []).length, 'notes waiting for Claude', 'is-work'],
    [fmtMin(mins), 'focus time today', ''],
  ];
  for (const [n, l, cls] of tiles) { const s = el('div', 'stat ' + cls); s.append(el('span', 'n', String(n)), el('span', 'l', l)); box.append(s); }
}
function renderRunning() {
  const box = $('running'); box.replaceChildren();
  const runs = data.running || [];
  if (!runs.length) box.append(el('span', 'idle', 'Nothing is running. Press \u25b6 on any item to start its clock.'));
  for (const r of runs) {
    const row = el('div', 'run'); row.append(el('span', 'dot'), el('span', 'what', clean(r.what)));
    if (r.alongside) row.append(el('span', 'tag bg', 'bg'));
    const c = el('span', 'clock'); c.dataset.since = r.started_at; c.dataset.base = r.item ? earlierMs(r.item, r.started_at) : 0; tick(c); row.append(c);
    const p = el('button', 'btn', 'Pause'); p.type = 'button';
    p.onclick = () => act('todo_pause', r.item ? {item: String(r.item)} : {}, 'Pausing');
    row.append(p); box.append(row);
  }
  for (const n of data.needs_check || []) {
    const row = el('div', 'check');
    row.append(el('span', null, n.running
      ? `${clean(n.what)} has been running for ${fmtMin(n.minutes)}. Still going? Its time is left out of today's time until you confirm.`
      : `${clean(n.what)} ran for ${fmtMin(n.minutes)}. Is that right? Its time is left out of today's time until you confirm.`));
    const ok = el('button', 'btn', 'Yes, count it'); ok.type = 'button'; ok.onclick = () => act('todo_time_fix', {entry: n.entry, confirm: true}, 'Confirming');
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
  // Clocks can run at once: focus time counts overlapping clocks once, background items (laundry) apart.
  const tt = data.time_today || {}, runs = (data.running || []).filter(r => !r.needs_check);
  const focus = (tt.focus_minutes || 0) + (runs.some(r => !r.alongside) ? extra : 0);
  const bg = (tt.background_minutes || 0) + (runs.some(r => r.alongside) ? extra : 0);
  const tot = el('span'); tot.append('Focus ', el('b', null, fmtMin(focus)));
  const parts = [tot];
  if (bg >= 1) { const b = el('span'); b.append('Background ', el('b', null, fmtMin(bg))); parts.push(b); }
  if (Math.round(total) !== Math.round(focus + bg)) { const a = el('span'); a.title = 'Every item\'s own time added up; clocks that ran at once count twice'; a.append('All items added up ', el('b', null, fmtMin(total))); parts.push(a); }
  legend.prepend(...parts);
  box.append(strip, legend);
}
function renderTime(main) {
  const t = timeData;
  if (!t) { main.append(el('div', 'loading', 'Loading the time log.')); return; }
  const wrap = el('div', 'time');
  const left = el('div', 'panel');
  left.append(el('div', 'label', `Focus time ${t.span || 'today'}`), el('h2', null, fmtMin(t.focus_minutes ?? t.total_minutes)));
  left.append(el('p', 'viewnote', `Clocks that ran at once count once. Background (laundry and the like): ${fmtMin(t.background_minutes || 0)}. Every item's own time added up: ${fmtMin(t.total_minutes)}.`));
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
// One card per item: title, code, area, live clock, one-click play, and markers. Tap a card for its details;
// status changes only by a drag or the panel's buttons. Drag by the grip (touch) or anywhere on the card (mouse) to another column to change
// status, or within a column to reorder. In progress means planned for today: moving a card there does not
// start the clock (only Start does); moving it out stops a running clock; into Done is todo_done.
let showOlderDone = false, suppressClick = false;
const STATUS_WORD = {todo:'to do', doing:'in progress', done:'done'};
let boardKids = {};
const collapsedKids = new Set();
function renderBoard(main) {
  const cols = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
  const all = data.areas.filter(a => !view.area || a.area === view.area).flatMap(a => a.items);
  const here = new Set(all.map(t => t.id)); boardKids = {};
  for (const t of all) if (t.parent_id && here.has(t.parent_id)) (boardKids[t.parent_id] = boardKids[t.parent_id] || []).push(t);
  const items = all.filter(t => !(t.parent_id && here.has(t.parent_id)));
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
// Details for one item, opened by tapping a board card. Status changes only from these buttons or a drag.
function linkified(text) {
  const frag = document.createDocumentFragment();
  String(text || '').split(/((?:https?|readdle-spark):\/\/[^\s)]+)/g).forEach((part, i) => {
    if (i % 2) { const a = document.createElement('a'); a.href = part.replace(/[.,;]+$/, ''); a.target = '_blank'; a.rel = 'noopener'; a.textContent = part.includes('docs.google.com/spreadsheets') ? 'Open the song list' : part.startsWith('readdle-spark:') ? 'Open the email in Spark' : part.replace(/^https?:\/\//, '').slice(0, 60);
      if (part.startsWith('readdle-spark:')) a.removeAttribute('target'); frag.append(a); }
    else if (part) frag.append(document.createTextNode(part));
  });
  return frag;
}
function closeDetail() { $('itempanel').hidden = true; document.body.classList.remove('panel-open'); openId = null; }
let openId = null, shownIds = [];
function itemById(id) { for (const a of (data && data.areas) || []) for (const x of a.items) if (x.id === id) return x; return null; }
function step(dir) { const i = shownIds.indexOf(openId); const n = itemById(shownIds[i + dir]); if (n) openDetail(n); }
function openDetail(t) {
  openId = t.id;
  const p = $('itempanel'), body = $('itembody'); body.textContent = '';
  const short = g => clean(g || '').replace(/\s*\(.*$/, '');
  $('itemmeta').replaceChildren(...(t.code ? [codeLabel(t), ' '] : []), [t.area, short(t.group), STATUS_WORD[t.status]].filter(Boolean).join(' · '));
  const advance = fn => async () => { const i = shownIds.indexOf(t.id); const nid = shownIds[i + 1] ?? shownIds[i - 1];
    await fn(); const n = nid != null && itemById(nid); n ? openDetail(n) : closeDetail(); };
  const stay = fn => async () => { await fn(); const n = itemById(t.id); n ? openDetail(n) : closeDetail(); };
  const pos = shownIds.indexOf(t.id);
  $('itemprev').disabled = pos <= 0; $('itemnext').disabled = pos < 0 || pos >= shownIds.length - 1;
  $('itempos').textContent = pos >= 0 ? `${pos + 1} of ${shownIds.length}` : '';

  const ti = document.createElement('textarea'); ti.className = 'dtitle'; ti.rows = 1; ti.value = t.title || ''; ti.setAttribute('aria-label', 'Title');
  const fit = () => { ti.style.height = 'auto'; ti.style.height = ti.scrollHeight + 'px'; };
  ti.addEventListener('input', () => { if (ti.value.includes('\n')) ti.value = ti.value.replace(/\n+/g, ' '); fit(); }); body.append(ti); setTimeout(fit, 0);
  // Return or clicking out saves the title at once (no new line); Escape puts it back.
  let savingTitle = false;
  const commitTitle = async () => {
    const v = ti.value.trim();
    if (savingTitle || !v || v === t.title) return;
    savingTitle = true;
    await act('todo_edit', {item: String(t.id), title: v}, 'Renaming', () => { t.title = v; });
    savingTitle = false;
  };
  ti.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); ti.value = t.title || ''; fit(); ti.blur(); return; }
    if (e.key === 'Enter') { e.preventDefault(); ti.blur(); }
  });
  ti.addEventListener('blur', commitTitle);
  if (t.done_check) { const dc = el('p', 'ddone'); dc.append(el('b', null, 'Done when: '), linkified(clean(t.done_check))); body.append(dc); }
  if (t.waiting_on) {
    const wt = el('p', 'dwait' + (t.waiting ? ' on' : ''));
    wt.append(el('b', null, t.waiting ? 'Waiting on: ' : 'Was waiting on: '), clean(t.waiting_on_title || ('item ' + t.waiting_on)), t.waiting ? '' : ' (done)');
    body.append(wt);
  }

  const facts = [];
  if (t.owner && t.owner !== 'michael') facts.push('Owner: ' + OWNER_WORD[t.owner]);
  if (t.schedule) facts.push('Repeats ' + (t.cadence || t.schedule));
  else if (t.recurring) facts.push('Repeats: ' + (t.cadence || 'yes'));
  if (t.schedule && t.status === 'done' && t.next_due) facts.push('back on ' + t.next_due);
  if (t.schedule && t.done_this_week) facts.push(`done ${t.done_this_week} of the last 7 days`);
  if (t.alongside) facts.push('bg: runs in the background, without your attention');
  if (t.show_from) facts.push('hidden until ' + t.show_from);
  if (t.running_since) facts.push('clock running since ' + new Date(t.running_since).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}));
  else if ((t.minutes_today || 0) >= 1) facts.push('today ' + fmtMin(t.minutes_today));
  if (facts.length) body.append(el('p', 'dfacts', facts.join(' · ')));

  const bar = el('div', 'dbar');
  const btn = (label, cls, run, mode) => { const b = el('button', cls, label); b.type = 'button'; b.onclick = (mode === 'stay' ? stay : advance)(run); bar.append(b); };
  if (t.status !== 'done') btn('Mark done', 'primary', () => act('todo_done', {item: String(t.id)}, 'Marking done', () => { t.status = 'done'; }));
  else btn('Reopen', 'secondary', () => act('todo_status', {item: String(t.id), status: 'todo'}, 'Reopening', () => { t.status = 'todo'; }), 'stay');
  if (t.running_since) btn('Pause clock', 'secondary', () => act('todo_pause', {item: String(t.id)}, 'Pausing'), 'stay');
  else if (t.status !== 'done') btn('Start clock', 'secondary', () => act('todo_start', {item: String(t.id)}, 'Starting'), 'stay');
  body.append(bar);

  if (t.owner !== 'michael' && t.prompt) {
    const cp = el('button', 'secondary', 'Copy prompt for Claude'); cp.type = 'button';
    cp.onclick = () => copyText(t.prompt, 'Prompt copied. Paste it into a Claude session.');
    bar.append(cp);
  }

  if (t.parent_id) {
    const pp = el('p', 'dparent'); pp.append(el('b', null, 'Sub-item of: '));
    const par = itemById(t.parent_id);
    const pl = el('button', 'linkbtn', (par && par.code ? par.code + ' ' : '') + clean(t.parent_title || 'another item')); pl.type = 'button';
    pl.onclick = () => { if (par) openDetail(par); };
    const out = el('button', 'linkbtn', 'Take it out'); out.type = 'button';
    out.onclick = () => stay(() => act('todo_unnest', {item: String(t.id)}, 'Taking it out'))();
    pp.append(pl, ' · ', out); body.append(pp);
  }
  if ((t.children || []).length) {
    const cs = el('div', 'dsection'); cs.append(el('div', 'dlabel', `Sub-items · ${t.children_done} of ${t.children_total} done`));
    const ul = el('ul', 'dsubs');
    for (const c of t.children) {
      const li = el('li', 'dsub'); li.dataset.s = c.status;
      const b = el('button', 'dsubbtn'); b.type = 'button';
      b.append(el('span', 'st mini'), el('span', 'cid', c.code || ''), el('span', 'dsubtitle', clean(c.title)), el('span', 'dsubstat', STATUS_WORD[c.status] || c.status));
      b.querySelector('.st').dataset.s = c.status;
      b.onclick = () => { const x = itemById(c.id); if (x) openDetail(x); else toast('That sub-item is hidden or done more than 30 days ago.'); };
      li.append(b); ul.append(li);
    }
    cs.append(ul, el('p', 'dhint', 'Drag a card onto the middle of another card to make it a sub-item; drag it out between cards to take it out.'));
    body.append(cs);
  }

  if (t.question) {
    const qs = el('div', 'dsection dquestion'); qs.append(el('div', 'dlabel', t.answer ? 'Your call (answered)' : 'Your call'));
    qs.append(prose(t.question));
    if (t.answer) { const a = el('p', 'danswer'); a.append(el('b', null, 'Your answer: '), clean(t.answer)); qs.append(a); }
    const qa = document.createElement('textarea'); qa.rows = 3; qa.className = 'dnotesedit short'; qa.placeholder = 'Your answer, in your own words';
    qa.setAttribute('aria-label', 'Your answer');
    if (t.answer) qa.value = t.answer;
    const qb = el('button', 'secondary', t.answer ? 'Change answer' : 'Save answer'); qb.type = 'button';
    qb.onclick = () => { const v = qa.value.trim(); if (!v) return; stay(() => act('todo_answer', {item: String(t.id), answer: v}, 'Saving the answer'))(); };
    qs.append(qa, qb, el('p', 'dhint', 'Saving also leaves a note for Claude, so the next session acts on it.'));
    body.append(qs);
  }

  const ss = el('div', 'dsection'); ss.append(el('div', 'dlabel', t.steps_total ? `Steps · ${t.steps_done} of ${t.steps_total} done` : 'Steps'));
  const sl = el('ul', 'dsteps');
  for (const sp of (t.steps || [])) {
    const li = el('li', sp.done ? 'done' : ''); const lb = el('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sp.done;
    cb.onchange = () => stay(() => act(cb.checked ? 'todo_step_tick' : 'todo_step_untick', {item: String(t.id), step: String(sp.n)}, 'Ticking', () => { sp.done = cb.checked; }))();
    lb.append(cb, el('span', null, sp.text));
    const rm = el('button', 'stepx', '\u00d7'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove step: ' + sp.text);
    rm.onclick = () => stay(() => act('todo_step_remove', {item: String(t.id), step: String(sp.n)}, 'Removing the step'))();
    li.append(lb, rm); sl.append(li);
  }
  const sf = el('form', 'dstepadd'); sf.autocomplete = 'off';
  const si = document.createElement('input'); si.placeholder = 'Add a step'; si.setAttribute('aria-label', 'Add a step');
  const sb2 = el('button', 'secondary', 'Add'); sb2.type = 'submit';
  sf.append(si, sb2);
  sf.onsubmit = e => { e.preventDefault(); const v = si.value.trim(); if (!v) return; stay(() => act('todo_step_add', {item: String(t.id), step: v}, 'Adding the step'))(); };
  ss.append(sl, sf); body.append(ss);

  if (t.source === 'workstream') {
    const ws = el('div', 'dsection dws'); body.append(ws);
    if (wsCache[t.id]) renderWorkstream(ws, t, wsCache[t.id]); else ws.append(el('div', 'dlabel', 'Workstream'), el('p', 'dhint', 'Loading the workstream.'));
    call('todo_workstream', {item: String(t.id)}).then(w => {
      if (openId !== t.id) return;
      if (!w || w.ok === false) { ws.replaceChildren(el('div', 'dlabel', 'Workstream'), el('p', 'dhint', (w && w.message) || 'Not available.')); return; }
      wsCache[t.id] = w; renderWorkstream(ws, t, w);
    }).catch(e => showError(e, 'Loading the workstream'));
  }

  const hide = el('div', 'dsection'); hide.append(el('div', 'dlabel', 'Hide until'));
  const chips = el('div', 'dchips');
  const hideTo = v => advance(() => act('todo_hide_until', {item: String(t.id), until: v}, 'Hiding'));
  const plus = n => { const d0 = new Date(); d0.setDate(d0.getDate() + n); return d0.toLocaleDateString('en-CA'); };
  for (const [label, n] of [['Tomorrow', 1], ['In 2 days', 2], ['Next week', 7]]) { const c = el('button', 'chip', label); c.type = 'button'; c.onclick = hideTo(plus(n)); chips.append(c); }
  const inp = document.createElement('input'); inp.type = 'date'; inp.className = 'chipdate'; if (t.show_from) inp.value = t.show_from;
  inp.setAttribute('aria-label', 'Hide until date'); inp.onchange = () => { if (inp.value) hideTo(inp.value)(); };
  chips.append(inp);
  if (t.show_from) { const c = el('button', 'chip', 'Show now'); c.type = 'button'; c.onclick = stay(() => act('todo_hide_until', {item: String(t.id), until: null}, 'Showing')); chips.append(c); }
  hide.append(chips); body.append(hide);

  const ns = el('div', 'dsection'); ns.append(el('div', 'dlabel', 'Notes'));
  const na = document.createElement('textarea'); na.className = 'dnotesedit'; na.value = t.notes || ''; na.placeholder = 'Add notes';
  const view = el('div', 'dnotes'); view.append(linkified(clean(t.notes || '')));
  if (t.notes) ns.append(view);
  const editBtn = el('button', 'linkbtn', t.notes ? 'Edit notes' : 'Add notes'); editBtn.type = 'button';
  editBtn.onclick = () => { view.hidden = true; editBtn.hidden = true; na.hidden = false; na.focus(); };
  na.hidden = true; ns.append(editBtn, na); body.append(ns);

  const rs = el('div', 'dsection'); rs.append(el('div', 'dlabel', 'Repeats'));
  const sel = document.createElement('select'); sel.className = 'dselect';
  for (const [v, l] of [['', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekends', 'Weekends'], ['weekly', 'Once a week'], ['custom', 'Certain days']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = l; sel.append(o); }
  const cur = t.schedule || ''; sel.value = ['', 'daily', 'weekdays', 'weekends', 'weekly'].includes(cur) ? cur : 'custom';
  const dayBox = el('div', 'ddays'); const picked = new Set(sel.value === 'custom' ? cur.split(',') : []);
  for (const dn of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const lb = el('label', 'dday'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = dn; cb.checked = picked.has(dn);
    lb.append(cb, dn[0].toUpperCase() + dn.slice(1)); dayBox.append(lb); }
  dayBox.hidden = sel.value !== 'custom'; sel.onchange = () => { dayBox.hidden = sel.value !== 'custom'; };
  rs.append(sel, dayBox); body.append(rs);

  const ms = el('div', 'dsection');
  const field = (label, node) => { const lb = el('label', 'dfield'); lb.append(el('span', 'dlabel', label), node); ms.append(lb); return node; };
  const ow = document.createElement('select'); ow.className = 'dselect';
  for (const [v, l] of [['michael', 'Michael'], ['claude', 'Claude'], ['both', 'Michael with Claude']]) { const o = document.createElement('option'); o.value = v; o.textContent = l; ow.append(o); }
  ow.value = t.owner || 'michael'; field('Who does it', ow);
  const bgLb = el('label', 'dcheck'); const bgCb = document.createElement('input'); bgCb.type = 'checkbox'; bgCb.checked = !!t.alongside;
  bgCb.onchange = () => stay(() => act('todo_background', {item: String(t.id), background: bgCb.checked}, 'Saving'))();
  bgLb.append(bgCb, el('span', null, 'Background (runs without your attention, like laundry); its time stays out of focus time'));
  ms.append(bgLb);
  const pr = document.createElement('textarea'); pr.className = 'dnotesedit short'; pr.value = t.prompt || ''; pr.placeholder = 'What Claude should do, as a prompt you can paste';
  const prWrap = field('Prompt for Claude', pr).parentElement; prWrap.hidden = ow.value === 'michael';
  ow.onchange = () => { prWrap.hidden = ow.value === 'michael'; };
  const dcIn = document.createElement('input'); dcIn.className = 'dselect'; dcIn.value = t.done_check || ''; dcIn.placeholder = 'What counts as done'; field('Done when', dcIn);
  const qIn = document.createElement('textarea'); qIn.className = 'dnotesedit short'; qIn.value = t.question || ''; qIn.placeholder = 'A question you need to answer, if any'; field('Question for you', qIn);
  const wo = document.createElement('select'); wo.className = 'dselect';
  wo.append(new Option('Nothing', ''));
  for (const a of data.areas) for (const x of a.items) if (x.id !== t.id && (x.status !== 'done' || x.id === t.waiting_on)) wo.append(new Option(`${a.area}: ${clean(x.title).slice(0, 70)}`, String(x.id)));
  if (t.waiting_on && ![...wo.options].some(o => o.value === String(t.waiting_on))) wo.append(new Option(clean(t.waiting_on_title || 'item ' + t.waiting_on), String(t.waiting_on)));
  wo.value = t.waiting_on ? String(t.waiting_on) : ''; field('Waiting on', wo);
  body.append(ms);

  const save = el('button', 'primary savebtn', 'Save changes'); save.type = 'button';
  save.onclick = async () => {
    const title = ti.value.trim(), notes = na.hidden ? (t.notes || '') : na.value;
    const sched = sel.value === 'custom' ? [...dayBox.querySelectorAll('input:checked')].map(c => c.value).join(',') : sel.value;
    const args = {item: String(t.id)};
    if (title && title !== t.title) args.title = title;
    if (notes !== (t.notes || '')) args.notes = notes;
    if (ow.value !== (t.owner || 'michael')) args.owner = ow.value;
    if (pr.value.trim() !== (t.prompt || '')) args.prompt = pr.value;
    if (dcIn.value.trim() !== (t.done_check || '')) args.done_check = dcIn.value;
    if (qIn.value.trim() !== (t.question || '')) args.question = qIn.value;
    if (wo.value !== (t.waiting_on ? String(t.waiting_on) : '')) args.waiting_on = wo.value;
    await stay(async () => {
      if (Object.keys(args).length > 1) await act('todo_edit', args, 'Saving');
      if ((sched || '') !== (t.schedule || '')) await act('todo_schedule', {item: String(t.id), schedule: sched || 'none'}, 'Saving the repeat');
    })();
  };
  body.append(save);

  const box = el('div', 'dsection'); box.append(el('div', 'dlabel', 'Note for Claude'));
  for (const n of (t.notes_for_claude || [])) {
    const row = el('p', 'dnote' + (n.status === 'pending' ? ' pending' : ''));
    row.append(el('span', null, n.note), el('span', 'dnstat', n.status === 'pending' ? 'waiting' : 'handled' + (n.outcome ? ': ' + n.outcome : '')));
    box.append(row);
  }
  const ta = document.createElement('textarea'); ta.rows = 2; ta.className = 'dnotesedit'; ta.placeholder = 'For example: split this into two, or: done, Stephen cancelled';
  const send = el('button', 'secondary', 'Save note'); send.type = 'button';
  send.onclick = () => { const v = ta.value.trim(); if (!v) return; stay(() => act('todo_note_add', {item: String(t.id), note: v}, 'Saving the note'))(); };
  box.append(ta, send); body.append(box);

  const del = el('button', 'deletebtn', 'Delete this item'); del.type = 'button';
  del.onclick = advance(() => act('todo_remove', {item: String(t.id)}, 'Deleting'));
  body.append(del);

  p.hidden = false; p.scrollTop = 0; document.body.classList.add('panel-open');
}
// ---------- a linked workstream, in the side panel
// The drain copies the markdown (render_worklist.py's parse) every run; this draws that copy. A tick or a call made
// here is queued and written into the markdown at the next drain run, within 15 minutes.
const wsCache = {}, wsShowDone = new Set();
function renderWorkstream(box, t, w) {
  box.replaceChildren();
  const d = w.data || {}, items = d.items || [], s = w.summary || {};
  const pend = {}; for (const a of (w.pending || [])) pend[a.code + ':' + a.kind] = a;
  box.append(el('div', 'dlabel', 'Workstream'));
  box.append(el('h3', 'wstitle', clean(w.title || 'Workstream')));
  if (w.purpose) box.append(el('p', 'wspurpose', clean(w.purpose)));
  const sum = [`${s.items_done ?? 0} of ${s.items_total ?? items.length} done`];
  if (s.runnable_mine) sum.push(`${s.runnable_mine} ready for you`);
  if (s.open_calls) sum.push(`${s.open_calls} waiting for your call`);
  box.append(el('p', 'dfacts', sum.join(' · ')));
  if ((w.pending || []).length) box.append(el('p', 'dhint', `${w.pending.length} tick${w.pending.length === 1 ? '' : 's'} or call${w.pending.length === 1 ? '' : 's'} saved here, written to the workstream within 15 minutes.`));
  const tracks = (d.tracks || []).slice();
  if (items.some(i => !i.track || !tracks.some(tr => tr.code === i.track))) tracks.push({code: '', name: 'Other items'});
  const doneCount = items.filter(i => i.kind === 'DONE').length;
  const showDone = wsShowDone.has(t.id);
  const stayWs = fn => async () => { await fn(); delete wsCache[t.id]; const n = itemById(t.id); n ? openDetail(n) : closeDetail(); };
  for (const tr of tracks) {
    const its = items.filter(i => tr.code ? i.track === tr.code : (!i.track || !tracks.some(x => x.code && x.code === i.track)));
    if (!its.length) continue;
    const shown = its.filter(i => showDone || i.kind !== 'DONE');
    const sec = el('div', 'wstrack');
    sec.append(el('div', 'wstrackname', (tr.code ? `Track ${tr.code}: ` : '') + clean(tr.name) + ` · ${its.filter(i => i.kind === 'DONE').length} of ${its.length} done`));
    for (const it of shown) sec.append(wsItem(t, it, pend, stayWs));
    if (shown.length || !showDone) box.append(sec);
  }
  if (doneCount) {
    const b = el('button', 'linkbtn', showDone ? 'Hide done items' : `Show ${doneCount} done item${doneCount === 1 ? '' : 's'}`); b.type = 'button';
    b.onclick = () => { showDone ? wsShowDone.delete(t.id) : wsShowDone.add(t.id); renderWorkstream(box, t, w); };
    box.append(b);
  }
  const foot = el('p', 'dhint', `From ${w.path}` + (w.updated_at ? `, copied ${new Date(w.updated_at).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}` : ''));
  box.append(foot);
}
function wsItem(t, it, pend, stayWs) {
  const state = it.kind === 'DONE' ? 'done' : it.runnable ? 'ready' : 'waiting';
  const row = el('div', 'wsitem ' + state);
  const head = el('div', 'wshead');
  const ticked = pend[it.code + ':check'];
  const canTick = it.mine && it.runnable && it.kind !== 'DONE' && !it.decides;
  if (canTick || it.kind === 'DONE') {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = it.kind === 'DONE' || !!ticked; cb.disabled = it.kind === 'DONE';
    cb.setAttribute('aria-label', `${it.code} done`);
    cb.onchange = stayWs(() => act(cb.checked ? 'todo_ws_check' : 'todo_ws_undo', {item: String(t.id), code: it.code}, cb.checked ? 'Ticking' : 'Taking it back'));
    head.append(cb);
  } else head.append(el('span', 'wsdot'));
  head.append(el('span', 'wscode', it.code), el('span', 'wsname', clean(it.title)));
  row.append(head);
  let status = it.kind === 'DONE' ? 'Done' + (it.status_note ? ` (${it.status_note})` : '')
             : it.kind === 'BLOCKED' ? 'Blocked' + (it.status_note ? `: ${it.status_note}` : '')
             : it.waiting_on && it.waiting_on.length ? 'Waiting on ' + it.waiting_on.join(', ')
             : it.kind === 'IN PROGRESS' ? 'In progress' : 'Runnable now';
  if (ticked) status = 'Ticked here; written within 15 minutes';
  const meta = el('div', 'wsmeta', `${it.owner || 'No owner'} · ${status}`);
  if (ticked) { const u = el('button', 'linkbtn', 'Take back'); u.type = 'button'; u.onclick = stayWs(() => act('todo_ws_undo', {item: String(t.id), code: it.code}, 'Taking it back')); meta.append(' ', u); }
  row.append(meta);
  if (it.kind === 'DONE') { if (it.decides && it.decision) row.append(el('p', 'wscall', 'Call: ' + it.decision)); return row; }
  if (it.mine && it.runnable && (it.checklist || []).length) {
    const ul = el('ul', 'wscheck'); for (const c of it.checklist) ul.append(el('li', null, clean(c))); row.append(ul);
  }
  if (it.decides) {
    const fold = document.createElement('details'); fold.className = 'wsbrief'; fold.open = it.runnable;
    fold.append(el('summary', null, it.runnable ? 'Your call' : 'Your call, once ' + (it.waiting_on || []).join(', ') + ' is done'));
    if (it.brief) fold.append(prose(it.brief));
    const saved = pend[it.code + ':decide'];
    const ta = document.createElement('textarea'); ta.rows = 3; ta.className = 'dnotesedit short'; ta.placeholder = 'Your call, in your own words';
    ta.setAttribute('aria-label', `Your call on ${it.code}`); if (saved) ta.value = saved.text || '';
    const b = el('button', 'secondary', saved ? 'Change call' : 'Save call'); b.type = 'button';
    b.onclick = () => { const v = ta.value.trim(); if (!v) return; stayWs(() => act('todo_ws_decide', {item: String(t.id), code: it.code, decision: v}, 'Saving the call'))(); };
    fold.append(ta, b);
    if (saved) fold.append(el('p', 'dhint', 'Saved here; written to the workstream within 15 minutes.'));
    row.append(fold);
  } else if (it.brief && it.mine) {
    const fold = document.createElement('details'); fold.className = 'wsbrief'; fold.append(el('summary', null, 'Brief'), prose(it.brief)); row.append(fold);
  }
  if (!it.mine && it.runnable && it.prompt) {
    const cp = el('button', 'secondary small', 'Copy prompt'); cp.type = 'button';
    cp.onclick = () => copyText(it.prompt, `Prompt for ${it.code} copied. Paste it into a Claude Code session.`);
    row.append(cp);
  }
  return row;
}

// Right-click (or control-click) menu on cards and rows; long-press opens it on touch screens.
function closeMenu() { const m = document.getElementById('ctxmenu'); if (m) m.remove(); document.removeEventListener('pointerdown', menuOutside, true); }
function menuOutside(e) { if (!e.target.closest('#ctxmenu')) closeMenu(); }
function attachMenu(li, t) {
  li.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(t, e.clientX, e.clientY); });
  let timer = null, sx = 0, sy = 0;
  li.addEventListener('touchstart', e => { if (e.target.closest('.grip,button')) return; const p = e.touches[0]; sx = p.clientX; sy = p.clientY;
    timer = setTimeout(() => { timer = null; suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); openMenu(t, sx, sy); }, 550); }, {passive: true});
  const cancel = e => { if (!timer) return; if (e.type === 'touchmove') { const p = e.touches[0]; if (Math.hypot(p.clientX - sx, p.clientY - sy) < 8) return; } clearTimeout(timer); timer = null; };
  li.addEventListener('touchmove', cancel, {passive: true}); li.addEventListener('touchend', cancel); li.addEventListener('touchcancel', cancel);
}
function openMenu(t, x, y) {
  closeMenu();
  const m = el('div', 'ctxmenu'); m.id = 'ctxmenu'; m.setAttribute('role', 'menu');
  const head = el('div', 'cmhead'); if (t.code) head.append(codeLabel(t), ' '); head.append(clean(t.title).slice(0, 60)); m.append(head);
  const item = (label, run, cls) => { const b = el('button', 'cmitem' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.onclick = async () => { closeMenu(); await run(); }; m.append(b); return b; };
  const sep = () => m.append(el('div', 'cmsep'));
  const id = String(t.id);
  const inline = (btn, kind) => {
    m.querySelectorAll('.cmform').forEach(x => x.remove());
    const f = el('form', 'cmform'); const box = document.createElement(kind === 'rename' ? 'input' : 'textarea');
    box.className = 'cminput'; if (kind === 'rename') box.value = t.title || ''; else { box.rows = 3; box.placeholder = 'Note for Claude, for example: split this into two'; }
    const go = el('button', 'cmsave', kind === 'rename' ? 'Save name' : 'Save note'); go.type = 'submit';
    f.append(box, go); btn.after(f); box.focus(); if (kind === 'rename') box.select();
    f.onsubmit = async e => { e.preventDefault(); const v = box.value.trim(); if (!v) return; closeMenu();
      if (kind === 'rename') { if (v !== t.title) await act('todo_edit', {item: id, title: v}, 'Renaming'); }
      else await act('todo_note_add', {item: id, note: v}, 'Saving the note'); };
    box.onkeydown = e => { if (e.key === 'Enter' && (kind === 'rename' || e.metaKey || e.ctrlKey)) { e.preventDefault(); f.requestSubmit(); } if (e.key === 'Escape') closeMenu(); };
  };
  const rn = item('Rename', () => {}); rn.onclick = e => { e.stopPropagation(); inline(rn, 'rename'); };
  const nt = item('Note for Claude…', () => {}); nt.onclick = e => { e.stopPropagation(); inline(nt, 'note'); };
  const plus = n => { const d0 = new Date(); d0.setDate(d0.getDate() + n); return d0.toLocaleDateString('en-CA'); };
  item('Hide until tomorrow', () => act('todo_hide_until', {item: id, until: plus(1)}, 'Hiding'));
  item('Hide for 2 days', () => act('todo_hide_until', {item: id, until: plus(2)}, 'Hiding'));
  item('Hide for a week', () => act('todo_hide_until', {item: id, until: plus(7)}, 'Hiding'));
  item('Delete', () => act('todo_remove', {item: id}, 'Deleting'), 'danger');
  sep();
  if (t.status !== 'done') item('Mark done', () => act('todo_done', {item: id}, 'Marking done', () => { t.status = 'done'; }));
  item('Open details', () => openDetail(t));
  if (t.code) item('Copy code ' + t.code, async () => { try { await navigator.clipboard.writeText(t.code); toast('Copied ' + t.code); } catch (e) { toast(t.code); } });
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', menuOutside, true), 0);
}
function showSub(btn, entries) {
  const m = document.getElementById('ctxmenu'); if (!m) return;
  m.querySelectorAll('.cmsub').forEach(x => x.remove());
  const sub = el('div', 'cmsub');
  if (!entries.length) sub.append(el('div', 'cmempty', 'Nothing to choose'));
  for (const [label, run] of entries) { const b = el('button', 'cmitem', label); b.type = 'button'; b.onclick = async () => { closeMenu(); await run(); }; sub.append(b); }
  btn.after(sub);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('scroll', closeMenu, {passive: true});
function card(t) {
  shownIds.push(t.id);
  const li = el('li', 'kcard'); li.dataset.id = t.id; li.dataset.s = t.status; li.dataset.area = t.area;
  li.style.setProperty('--area', color(t.area)); li.tabIndex = 0;
  const next = {todo:'doing', doing:'done', done:'todo'}[t.status];
  li.setAttribute('aria-label', `${clean(t.title)}, ${t.area}, ${STATUS_WORD[t.status]}. Press for details.`);
  const row = el('div', 'crow'); const title = el('span', 'ctitle', clean(t.title)); title.title = clean(t.title);
  const grip = el('button', 'grip'); grip.type = 'button'; grip.innerHTML = SVG_GRIP; grip.setAttribute('aria-label', `Drag ${clean(t.title)} to another column or place`);
  row.append(title);
  if (t.status !== 'done') {   // one-click clock: start (which also marks it in progress) or pause, without opening the panel
    const running = !!t.running_since;
    const go = el('button', 'go cgo' + (running ? ' on' : '')); go.type = 'button'; go.innerHTML = running ? SVG_PAUSE : SVG_PLAY;
    go.setAttribute('aria-label', running ? `Pause ${clean(t.title)}` : `Start the clock on ${clean(t.title)}`);
    go.addEventListener('pointerdown', e => e.stopPropagation());
    go.onclick = e => { e.stopPropagation(); running ? act('todo_pause', {item: String(t.id)}, 'Pausing') : act('todo_start', {item: String(t.id)}, 'Starting'); };
    go.onkeydown = e => e.stopPropagation();
    row.append(go);
  }
  row.append(grip);
  const meta = el('div', 'cmeta');
  meta.append(codeLabel(t));
  const ar = el('span', 'carea'); const sw = el('span', 'sw'); sw.style.background = color(t.area); ar.append(sw, t.area); meta.append(ar);
  meta.append(...markers(t));
  if (t.waiting) li.classList.add('waiting');
  if (t.recurring) meta.append(el('span', 'tag', t.cadence || 'repeats'));
  if (t.running_since) { const c = el('span', 'mins'); c.dataset.since = t.running_since; c.dataset.base = earlierMs(t.id, t.running_since); tick(c); meta.append(c); }
  else if ((t.minutes_today || 0) >= 1) meta.append(el('span', 'mins', fmtMin(t.minutes_today)));
  li.append(row, meta);
  const kids = boardKids[t.id] || [];
  if (kids.length) {
    const shut = collapsedKids.has(t.id);
    const tog = el('button', 'ksubtoggle', `${shut ? '\u25b8' : '\u25be'} ${kids.length} sub-item${kids.length === 1 ? '' : 's'}`); tog.type = 'button';
    tog.setAttribute('aria-expanded', String(!shut));
    tog.onclick = e => { e.stopPropagation(); shut ? collapsedKids.delete(t.id) : collapsedKids.add(t.id); render(); };
    li.append(tog);
    if (!shut) {
      const ul = el('ul', 'ksubs');
      const addKid = (c, depth) => {
        shownIds.push(c.id);
        const k = el('li', 'ksub'); k.dataset.id = c.id; k.dataset.s = c.status; k.dataset.area = c.area; k.tabIndex = 0;
        if (depth) k.style.setProperty('--depth', depth);
        const dot = el('span', 'st mini'); dot.dataset.s = c.status;
        k.append(dot, el('span', 'ksubtitle', clean(c.title)), codeLabel(c));
        k.onclick = e => { e.stopPropagation(); if (suppressClick) return; openDetail(c); };
        k.onkeydown = e => { if (e.key === 'Enter') { e.stopPropagation(); openDetail(c); } };
        k.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.pointerType !== 'mouse' || e.button === 0) startCardDrag(e, k, c, true); });
        ul.append(k);
        if (depth < 5) for (const g of boardKids[c.id] || []) addKid(g, depth + 1);
      };
      for (const c of kids) addKid(c, 0);
      li.append(ul);
    }
  }
  li.onclick = e => { if (suppressClick || e.target.closest('.grip') || e.target.closest('.rename')) return; clickOpen(t); };
  title.ondblclick = e => { e.stopPropagation(); renameInline(title, t); };
  attachMenu(li, t);
  li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(t); } };
  grip.addEventListener('pointerdown', e => { e.stopPropagation(); startCardDrag(e, li, t, false); });
  li.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) startCardDrag(e, li, t, true); });
  return li;
}
// The column a drag is over: chosen by the pointer's left-right position, so a drop works at any height even
// when the next column is shorter. When the columns are stacked (narrow screens), by the nearest one up or down.
function columnAt(x, y) {
  const cols = [...document.querySelectorAll('.kanban .col')]; if (!cols.length) return null;
  const rects = cols.map(c => c.getBoundingClientRect());
  const sideBySide = rects.length > 1 && Math.abs(rects[0].left - rects[1].left) > 20;
  const dist = (r) => sideBySide ? (x < r.left ? r.left - x : x > r.right ? x - r.right : 0)
                                 : (y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0);
  let best = 0; rects.forEach((r, i) => { if (dist(r) < dist(rects[best])) best = i; });
  return cols[best];
}
function startCardDrag(e, li, t, needMove) {
  const x0 = e.clientX, y0 = e.clientY; let dragging = false, finished = false, ghost = null, offX = 0, offY = 0, nestOn = null;
  const begin = () => {
    dragging = true; suppressClick = true; busyStart();
    const r = li.getBoundingClientRect(); offX = x0 - r.left; offY = y0 - r.top;
    if (li.classList.contains('ksub')) { li.classList.add('kcard'); li.style.setProperty('--area', color(t.area)); }
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
    // Over the middle of another card: nest under it (highlighted), instead of placing between cards.
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const tc = over && over.closest('.cards > .kcard');
    let nest = null;
    if (tc && tc !== li && !li.contains(tc)) {
      const r = tc.getBoundingClientRect(), f = (ev.clientY - r.top) / r.height, tid = Number(tc.dataset.id);
      // A finished card never takes steps: dropping on one in Done just moves the card to Done.
      if (f > 0.25 && f < 0.75 && tid !== t.id && !isUnder(tid, t.id) && tc.dataset.s !== 'done') nest = tc;
    }
    if (nest !== nestOn) { if (nestOn) nestOn.classList.remove('nest-target'); nestOn = nest; if (nest) nest.classList.add('nest-target'); }
    if (nest) { document.querySelectorAll('.kanban .col.target').forEach(c => c.classList.remove('target')); return; }
    const col = columnAt(ev.clientX, ev.clientY); if (!col) return;
    document.querySelectorAll('.kanban .col.target').forEach(c => { if (c !== col) c.classList.remove('target'); });
    col.classList.add('target');
    const ul = col.querySelector('.cards');
    const next = [...ul.querySelectorAll(':scope > .kcard')].filter(c => c !== li)
      .find(c => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (li.parentElement !== ul || li.nextElementSibling !== (next || null)) ul.insertBefore(li, next || null);
    const empty = ul.querySelector('.empty'); if (empty) empty.hidden = true;
  };
  const up = async () => {
    if (finished) return; finished = true;
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    if (!dragging) return;   // a tap: the click handler opens the details
    ghost.remove(); li.classList.remove('dragging'); busyEnd();
    document.querySelectorAll('.kanban .col.target').forEach(c => c.classList.remove('target'));
    setTimeout(() => { suppressClick = false; }, 0);
    if (nestOn) { nestOn.classList.remove('nest-target'); await dropAsStep(t, nestOn.dataset.id); return; }
    if (!li.parentElement || !li.parentElement.dataset.status) { await refresh(true); return; }   // never left its parent card
    const to = li.parentElement.dataset.status;
    const sibs = [...li.parentElement.querySelectorAll(':scope > .kcard')], i = sibs.indexOf(li);
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
    if (t.parent_id && (boardKids[t.parent_id] || []).includes(t)) {   // a sub-item dragged out between cards or to another column comes out from under its parent
      const r = await call('todo_unnest', {item: String(t.id)});
      if (r && r.ok === false) { toast(r.message); return; }
    }
    if (to !== from) {
      const item = String(t.id);
      const r = to === 'done' ? await call('todo_done', {item})
              : await call('todo_status', {item, status: to});
      if (r && r.ok === false) { toast(r.message); return; }
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
  const ul = li.parentElement; let finished = false, nestOn = null, moved = false;
  li.classList.add('dragging'); busyStart();
  const setNest = n => { if (n !== nestOn) { if (nestOn) nestOn.classList.remove('nest-target'); nestOn = n; if (n) n.classList.add('nest-target'); } };
  const move = ev => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest('.item');
    if (!target || target === li) { setNest(null); return; }
    const r = target.getBoundingClientRect(), f = (ev.clientY - r.top) / r.height, tid = Number(target.dataset.id);
    // The middle of another row nests under it; the top or bottom edge places before or after it.
    if (f > 0.3 && f < 0.7 && tid !== t.id && !isUnder(tid, t.id) && target.dataset.s !== 'done') { setNest(target); return; }
    setNest(null);
    if (target.parentElement !== ul) return;
    moved = true;
    ul.insertBefore(li, f < 0.5 ? target : target.nextSibling);
  };
  // Listen on the window: moving the row in the page drops any pointer capture on the grip.
  const up = async () => {
    if (finished) return; finished = true;
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    li.classList.remove('dragging');
    let n = li.nextElementSibling; while (n && !n.classList.contains('item')) n = n.nextElementSibling;
    busyEnd();
    if (nestOn) { nestOn.classList.remove('nest-target'); await dropAsStep(t, nestOn.dataset.id); return; }
    if (!moved) return;
    if (t.parent_id) { busyStart(); try { await call('todo_unnest', {item: String(t.id)}); } catch (e) { showError(e, 'Taking it out'); } finally { busyEnd(); } }
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
$('itemclose').onclick = closeDetail;
$('itemprev').onclick = () => step(-1); $('itemnext').onclick = () => step(1);
document.addEventListener('keydown', e => {
  if ($('itempanel').hidden) return;
  if (e.key === 'Escape') { closeDetail(); return; }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
});
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
  for (const c of document.querySelectorAll('[data-since]')) tick(c);
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
