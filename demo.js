// Demo mode: a fictional list for showing the app to other people (Michael, 2026-10-22: "I don't want to keep
// showing off my personal information"). While it is on, app.js sends every call here instead of to Supabase,
// so nothing real is read or written. Changes made in demo mode last until the page reloads. The switch is in
// the menu and is remembered per browser, the same way The Pursuit's Demo switch works.
(function () {
  const KEY = 'list-demo';
  const now = () => new Date();
  const iso = d => d.toISOString();
  const ago = min => iso(new Date(Date.now() - min * 60000));
  const daysAgo = n => iso(new Date(Date.now() - n * 864e5));
  const dayStr = n => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };

  const AREAS = [
    {area: 'Work', intro: null, footer: null},
    {area: 'Home', intro: 'Around the house and the yard.', footer: null},
    {area: 'Health', intro: null, footer: null},
    {area: 'Music', intro: null, footer: null},
    {area: 'Family', intro: null, footer: null},
  ];
  const PREFIX = {Work: 'WORK', Home: 'HOME', Health: 'HEALTH', Music: 'MUSIC', Family: 'FAMILY'};

  let state;
  function blank(id, area, title, extra) {
    return Object.assign({
      id, area, code: null, group: null, notes: null, owner: 'michael', steps: [], title, answer: null, prompt: null,
      source: null, status: 'todo', cadence: null, done_at: null, waiting: false, children: [], next_due: null,
      position: 0, question: null, schedule: null, alongside: false, parent_id: null, recurring: false, show_from: null,
      your_call: false, done_check: null, source_ref: null, steps_done: 0, waiting_on: null, workstream: null,
      answered_at: null, steps_total: 0, parent_title: null, children_done: 0, minutes_today: 0, running_since: null,
      children_total: 0, done_this_week: 0, notes_for_claude: [], waiting_on_title: null, background: false,
    }, extra || {});
  }
  function seed() {
    let id = 100;
    const items = [];
    const add = (area, title, extra) => { const t = blank(++id, area, title, extra); items.push(t); return t; };
    const steps = list => list.map((text, i) => ({n: i + 1, id: 1000 + Math.floor(Math.random() * 1e6), done: false, text, done_at: null}));

    add('Health', 'Daily walk', {status: 'doing', recurring: true, cadence: 'every day', schedule: 'daily', running_since: ago(18)});
    add('Work', 'Daily planning: pick the three big things', {recurring: true, cadence: 'every day', schedule: 'daily'});
    add('Work', 'Draft the quarterly roadmap update', {status: 'doing', notes: 'Outline is in the team doc: https://example.com/roadmap-outline\nKeep it to one page.',
      steps: steps(['Pull the metrics from last quarter', 'Write the three themes', 'Share a draft with Jordan'])});
    add('Work', 'Reply to the vendor about the renewal date', {notes: 'They asked for an answer by Friday.'});
    add('Work', 'Prep questions for the design review', {question: 'Should the review cover the mobile flow too, or only desktop?', your_call: true});
    add('Work', 'Book a coffee with the new team lead', {});
    add('Work', 'Read the research summary', {show_from: dayStr(3)});
    add('Home', 'Fix the squeaky back door', {});
    add('Home', 'Clean out the gutters', {group: 'Yard', notes: 'Ladder is in the garage.'});
    add('Home', 'Rake the front lawn', {group: 'Yard'});
    add('Home', 'Replace the smoke detector batteries', {});
    add('Home', 'Sort the garage shelves', {steps: steps(['Paint cans', 'Camping gear', 'Donate pile'])});
    add('Home', 'Call the plumber about the slow drain', {show_from: dayStr(2)});
    add('Health', 'Schedule the annual checkup', {});
    add('Health', 'Stretching, 10 minutes', {recurring: true, cadence: '3 a week'});
    add('Music', 'Learn the bass line for the new song', {status: 'doing', steps: steps(['Verse', 'Chorus', 'Bridge'])});
    add('Music', 'Restring the acoustic guitar', {});
    add('Music', 'Pick two songs for Thursday rehearsal', {});
    add('Family', 'Plan the weekend trip', {notes: 'Two nights, somewhere within three hours.'});
    add('Family', 'Order a birthday present for Sam', {});
    add('Family', 'Sign the school permission form', {});
    // Finished in the last few days.
    add('Work', 'Send the meeting notes from Monday', {status: 'done', done_at: daysAgo(1)});
    add('Home', 'Take the recycling out', {status: 'done', done_at: ago(200)});
    add('Health', 'Refill the water filter', {status: 'done', done_at: daysAgo(1)});
    add('Music', 'Tune the piano', {status: 'done', done_at: daysAgo(2)});
    add('Family', 'Pick up the dry cleaning', {status: 'done', done_at: daysAgo(3)});

    const counters = {};
    for (const a of AREAS) {
      let p = 0;
      for (const t of items.filter(x => x.area === a.area)) {
        t.position = ++p;
        counters[a.area] = (counters[a.area] || 0) + 1;
        t.code = `${PREFIX[a.area]}-${counters[a.area]}`;
      }
    }
    const entries = [
      {entry: 1, item: items[2].id, what: items[2].title, area: 'Work', started_at: ago(150), ended_at: ago(95), background: false},
      {entry: 2, item: items[15].id, what: items[15].title, area: 'Music', started_at: ago(80), ended_at: ago(50), background: false},
    ];
    const run = items[0];
    entries.push({entry: 3, item: run.id, what: run.title, area: run.area, started_at: run.running_since, ended_at: null, background: false});
    return {items, entries, nextId: id, nextEntry: 4, stamp: 1,
      view: {mode: 'board', area: null, status: 'open', label: 'everything board', hidden: false, updated_at: iso(now()), updated_by: 'web'}};
  }

  const mins = e => Math.max(0, Math.round(((e.ended_at ? Date.parse(e.ended_at) : Date.now()) - Date.parse(e.started_at)) / 60000));
  const today = e => new Date(e.started_at).toDateString() === new Date().toDateString();
  const find = item => state.items.find(t => String(t.id) === String(item) || t.code === item);
  const ok = (message, extra) => { state.stamp++; return Object.assign({ok: true}, message ? {message} : {}, extra || {}); };
  const stopClock = t => {
    const e = state.entries.find(x => x.item === t.id && !x.ended_at);
    if (e) e.ended_at = iso(now());
    t.running_since = null;
  };
  const renumber = area => state.items.filter(t => t.area === area).forEach((t, i) => { t.position = i + 1; });

  function list() {
    const shown = t => !t.show_from || t.show_from <= dayStr(0);
    const recentDone = t => t.status === 'done' && t.done_at && Date.now() - Date.parse(t.done_at) < 30 * 864e5;
    for (const t of state.items) {
      t.steps_total = t.steps.length; t.steps_done = t.steps.filter(s => s.done).length;
      t.minutes_today = state.entries.filter(e => e.item === t.id && today(e)).reduce((a, e) => a + mins(e), 0);
    }
    const entryOut = e => ({area: e.area, item: e.item, note: null, what: e.what, entry: e.entry, minutes: mins(e), running: !e.ended_at,
      ended_at: e.ended_at, alongside: false, background: e.background, started_at: e.started_at, needs_check: false});
    const todays = state.entries.filter(today);
    const byArea = {};
    for (const e of todays) byArea[e.area] = (byArea[e.area] || 0) + mins(e);
    const total = todays.reduce((a, e) => a + mins(e), 0);
    return JSON.parse(JSON.stringify({
      ok: true, as_of: iso(now()),
      areas: AREAS.map(a => {
        const all = state.items.filter(t => t.area === a.area && t.status !== 'dropped').sort((x, y) => x.position - y.position);
        const items = all.filter(t => t.status !== 'done' ? shown(t) : recentDone(t));
        return {area: a.area, intro: a.intro, footer: a.footer, items,
          open: items.filter(t => t.status !== 'done').length, later: all.filter(t => !shown(t) && t.status !== 'done').length,
          done_recently: items.filter(t => t.status === 'done').length};
      }),
      later: state.items.filter(t => t.status !== 'done' && t.status !== 'dropped' && !shown(t))
        .map(t => ({id: t.id, area: t.area, title: t.title, show_from: t.show_from})),
      running: state.entries.filter(e => !e.ended_at).map(entryOut),
      time_today: {by_area: Object.entries(byArea).map(([area, minutes]) => ({area, minutes})), focus_minutes: total, total_minutes: total, background_minutes: 0},
      needs_check: [], notes_for_claude: [],
    }));
  }
  function timeView() {
    const todays = state.entries.filter(today);
    const byArea = {}, byItem = {};
    for (const e of todays) { byArea[e.area] = (byArea[e.area] || 0) + mins(e); byItem[e.what] = (byItem[e.what] || 0) + mins(e); }
    const total = todays.reduce((a, e) => a + mins(e), 0);
    return {ok: true, span: 'today', focus_minutes: total, total_minutes: total, background_minutes: 0,
      by_area: Object.entries(byArea).map(([area, minutes]) => ({area, minutes})).sort((a, b) => b.minutes - a.minutes),
      by_item: Object.entries(byItem).map(([what, minutes]) => ({what, minutes})).sort((a, b) => b.minutes - a.minutes),
      entries: todays.map(e => ({what: e.what, started_at: e.started_at, ended_at: e.ended_at, minutes: mins(e), needs_check: false}))};
  }

  async function call(fn, a = {}) {
    if (!state) state = seed();
    const t = a.item != null ? find(a.item) : null;
    const need = () => { if (!t) throw {message: 'No such item in the demo list.'}; };
    switch (fn) {
      case 'access': return {ok: true};
      case 'todo_list': return list();
      case 'todo_view': return {ok: true, view: state.view, stamp: String(state.stamp), now: iso(now())};
      case 'todo_time_view': return timeView();
      case 'todo_show': state.view.updated_at = iso(now()); return {ok: true};
      case 'todo_workstream': return {ok: false, message: 'No workstreams in the demo list.'};
      case 'todo_add': {
        const area = AREAS.some(x => x.area === a.area) ? a.area : 'Work';
        state.items.filter(x => x.area === area).forEach(x => { x.position++; });
        const n = state.items.filter(x => x.area === area).length + 1;
        state.items.push(blank(++state.nextId, area, a.what, {position: 1, code: `${PREFIX[area]}-${n + 20}`}));
        return ok('Added to ' + area + ': ' + a.what);
      }
      case 'todo_done': need(); stopClock(t); t.status = 'done'; t.done_at = iso(now()); return ok('Marked done.');
      case 'todo_status': need(); if (a.status !== 'doing') stopClock(t); t.status = a.status; t.done_at = a.status === 'done' ? iso(now()) : null; return ok('Changed.');
      case 'todo_start': {
        need();
        for (const x of state.items) if (x.running_since && !x.alongside && !x.background) stopClock(x);
        t.running_since = iso(now()); if (t.status === 'todo') t.status = 'doing';
        state.entries.push({entry: state.nextEntry++, item: t.id, what: t.title, area: t.area, started_at: t.running_since, ended_at: null, background: t.background});
        return ok('Started.');
      }
      case 'todo_pause': if (t) stopClock(t); else state.items.forEach(x => x.running_since && stopClock(x)); return ok('Paused.');
      case 'todo_edit': need();
        for (const k of ['title', 'notes', 'group_label', 'cadence', 'question']) if (a[k] !== undefined) t[k === 'group_label' ? 'group' : k] = a[k] === '' ? null : a[k];
        if (a.area && AREAS.some(x => x.area === a.area)) t.area = a.area;
        return ok('Changed.');
      case 'todo_remove': need(); stopClock(t); t.status = 'dropped'; return ok('Taken off the list: ' + t.title);
      case 'todo_move': {
        need();
        const before = a.before_item ? find(a.before_item) : null;
        const area = before ? before.area : t.area;
        const rest = state.items.filter(x => x.area === area && x !== t).sort((x, y) => x.position - y.position);
        const i = before ? rest.indexOf(before) : rest.length;
        rest.splice(i < 0 ? rest.length : i, 0, t); t.area = area;
        rest.forEach((x, j) => { x.position = j + 1; });
        return ok('Moved.');
      }
      case 'todo_step_add': need(); t.steps.push({n: t.steps.length + 1, id: Date.now(), done: false, text: a.step, done_at: null}); return ok();
      case 'todo_step_tick': case 'todo_step_untick': {
        need(); const s = t.steps.find(x => String(x.n) === String(a.step));
        if (s) { s.done = fn === 'todo_step_tick'; s.done_at = s.done ? iso(now()) : null; }
        return ok();
      }
      case 'todo_step_remove': need(); t.steps = t.steps.filter(x => String(x.n) !== String(a.step)).map((x, i) => Object.assign(x, {n: i + 1})); return ok();
      case 'todo_hide_until': need(); t.show_from = a.until || null; return ok();
      case 'todo_schedule': need(); t.schedule = a.schedule === 'none' ? null : a.schedule; t.recurring = !!t.schedule; t.cadence = t.schedule === 'daily' ? 'every day' : t.schedule; return ok();
      case 'todo_background': need(); t.background = !!a.background; return ok();
      case 'todo_answer': need(); t.answer = a.answer; t.answered_at = iso(now()); t.your_call = false; return ok();
      case 'todo_note_add': need(); t.notes_for_claude.push({at: iso(now()), id: Date.now(), note: a.note, status: 'open', outcome: null}); return ok('Note saved.');
      case 'todo_unnest': need(); t.parent_id = null; return ok();
      case 'todo_time_fix': return ok();
      default: return ok();
    }
  }

  let on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch (e) { /* private mode */ }
  window.DEMO = {
    get on() { return on; },
    set(v) { on = !!v; state = null; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* private mode */ } },
    call,
  };
})();
