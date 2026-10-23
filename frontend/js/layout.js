/**
 * NEW (Bob IDE parity): workbench layout (js/layout.js)
 *  - Activity bar with view buttons (Up/Down arrows move between them).
 *  - View > Appearance toggles: Secondary Side Bar (Bob), Primary Side Bar, Activity Bar, Panel, Status Bar.
 *  - Resizable splitters (mouse drag, touch, and keyboard arrows) with persisted sizes; double-click resets.
 *  - Bottom panel with Output / Terminal views.
 *  - Integrated terminal (a sandboxed, allow-listed command set served by /api/bob/terminal; nothing is run on the host).
 *  - Status bar (checkpoint, cursor, language, mode, role).
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;
  const cmds = Bob.commands;
  const KEY = 'bob_layout';
  const LANG_LABEL = { javascript: 'JavaScript', nodejs: 'Node.js', python: 'Python', java: 'Java', markdown: 'Markdown' };

  const DEFAULTS = { secondary: true, config: true, activity: true, panel: true, status: true, view: 'output', sizes: {} };
  let state = { ...DEFAULTS, sizes: {} };
  try { state = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; if (typeof state.sizes !== 'object' || !state.sizes) state.sizes = {}; } catch (_) { state = { ...DEFAULTS, sizes: {} }; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* quota */ } };

  // 'secondary' zone removed — Bob panel is a floating widget now (change #6)
  // 'split-bob' element no longer exists in the DOM
  const ZONES = {
    config: () => [$('#config-column'), $('#split-config')],
    activity: () => [$('#activity-bar')],
    panel: () => [$('#bottom-panel'), $('#split-bottom')],
    status: () => [$('#status-bar')]
  };

  function apply() {
    Object.entries(ZONES).forEach(([k, f]) => f().forEach((n) => { if (n) n.hidden = !state[k]; }));
    // The chat splitter / config splitter only make sense when the neighbouring tab is the IDE etc.; keep simple.
    syncActivity();
    Bob.emit('layout', { ...state });
    if (Bob.ide && Bob.ide.refreshLayout) setTimeout(Bob.ide.refreshLayout, 0);
  }

  function setZone(key, on) {
    state[key] = !!on; save(); apply();
  }

  // ── public API ─────────────────────────────────────────────────────────────
  Bob.layout = {
    is: (k) => !!state[k],
    toggle(k) { setZone(k, !state[k]); },
    show(k) { if (!state[k]) setZone(k, true); },
    hide(k) { if (state[k]) setZone(k, false); },
    reset() {
      state = { ...DEFAULTS, sizes: {} }; save();
      ['#config-column', '#panel-mode-chat', '#bottom-panel'].forEach((s) => { const n = $(s); n.style.width = ''; n.style.minWidth = ''; n.style.height = ''; });
      apply(); showView('output', false);
      Bob.toast('Layout reset.', 'info');
    },
    showView: (v, focus) => showView(v, focus !== false)
  };

  // ── splitters ──────────────────────────────────────────────────────────────
  /** cfg: {id, target, axis:'x'|'y', min, max(), measure(e,rect)->size, key, def} */
  function splitter(cfg) {
    const bar = $(cfg.id); const target = $(cfg.target);
    const clamp = (v) => Math.round(Math.max(cfg.min, Math.min(cfg.max(), v)));
    const setSize = (v, persist) => {
      const s = clamp(v);
      if (cfg.axis === 'x') { target.style.width = `${s}px`; target.style.minWidth = `${s}px`; } else target.style.height = `${s}px`;
      bar.setAttribute('aria-valuenow', String(s));
      bar.setAttribute('aria-valuemin', String(cfg.min));
      bar.setAttribute('aria-valuemax', String(Math.round(cfg.max())));
      if (persist) { state.sizes[cfg.key] = s; save(); }
      if (Bob.ide) Bob.ide.refreshLayout();
      return s;
    };
    const current = () => { const r = target.getBoundingClientRect(); return cfg.axis === 'x' ? r.width : r.height; };
    if (state.sizes[cfg.key]) setSize(state.sizes[cfg.key], false);
    else { bar.setAttribute('aria-valuenow', String(Math.round(current()))); bar.setAttribute('aria-valuemin', String(cfg.min)); }

    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging'); document.body.classList.add('resizing', cfg.axis === 'x' ? 'resizing-x' : 'resizing-y');
      const rect = target.getBoundingClientRect();
      const move = (ev) => setSize(cfg.measure(ev, rect), false);
      const up = () => {
        bar.releasePointerCapture(e.pointerId);
        bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
        bar.classList.remove('dragging'); document.body.classList.remove('resizing', 'resizing-x', 'resizing-y');
        setSize(current(), true);
      };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      const grow = cfg.axis === 'x' ? (cfg.grow === 'left' ? 'ArrowLeft' : 'ArrowRight') : 'ArrowUp';
      const shrink = cfg.axis === 'x' ? (cfg.grow === 'left' ? 'ArrowRight' : 'ArrowLeft') : 'ArrowDown';
      let v = null;
      if (e.key === grow) v = current() + step;
      else if (e.key === shrink) v = current() - step;
      else if (e.key === 'Home') v = cfg.min;
      else if (e.key === 'End') v = cfg.max();
      else if (e.key === 'Enter' || e.key === ' ') v = cfg.def;
      if (v !== null) { e.preventDefault(); setSize(v, true); }
    });
    bar.addEventListener('dblclick', () => { target.style.width = ''; target.style.minWidth = ''; target.style.height = ''; delete state.sizes[cfg.key]; save(); bar.setAttribute('aria-valuenow', String(Math.round(current()))); if (Bob.ide) Bob.ide.refreshLayout(); });
    window.addEventListener('resize', () => { if (state.sizes[cfg.key]) setSize(state.sizes[cfg.key], false); });
  }

  // ── bottom panel views ─────────────────────────────────────────────────────
  const VIEWS = { output: ['#bt-output', '#console-output'], terminal: ['#bt-terminal', '#bv-terminal'] };
  function showView(name, focus) {
    if (!VIEWS[name]) return;
    state.view = name; save();
    if (!state.panel) { state.panel = true; save(); apply(); }
    Object.entries(VIEWS).forEach(([k, [tabSel, viewSel]]) => {
      const on = k === name;
      const t = $(tabSel); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      $(viewSel).hidden = !on;
    });
    syncActivity();
    if (focus) {
      const inp = $('#terminal-input');
      const out = $('#console-output');
      if (name === 'terminal' && inp) inp.focus();
      else if (out) out.focus();
    }
  }

  function initBottomTabs() {
    if (!$('#bottom-panel')) return;
    const cons = $('#console-output');
    if (cons) cons.id = 'console-output';
    const bto = $('#bt-output');
    if (bto) bto.setAttribute('aria-controls', 'console-output');
    const tabs = Object.values(VIEWS).map(([t]) => $(t)).filter(Boolean);
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => showView(Object.keys(VIEWS)[i], false));
      t.addEventListener('keydown', (e) => {
        let n = null;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
        if (n !== null) { e.preventDefault(); showView(Object.keys(VIEWS)[n], false); tabs[n].focus(); }
      });
    });
    const hideBtn = $('#btn-panel-hide');
    if (hideBtn) hideBtn.addEventListener('click', () => Bob.layout.hide('panel'));
    showView(VIEWS[state.view] ? state.view : 'output', false);
  }

  // ── terminal ───────────────────────────────────────────────────────────────
  const term = { history: [], idx: -1, busy: false };
  function termWrite(text, cls) {
    const out = $('#terminal-output');
    if (!out) return;
    out.append(el('span', cls ? { class: cls } : null, `${text}\n`));
    while (out.childNodes.length > 400) out.removeChild(out.firstChild);   // bound DOM growth
    out.scrollTop = out.scrollHeight;
  }
  function initTerminal() {
    if (!$('#terminal-output') || !$('#terminal-form')) return;
    termWrite('Sandboxed Bob terminal. Only a small allow-list of read-only commands is available. Type "help".', 'term-note');
    const input = $('#terminal-input');

    const copyBtn = document.getElementById('term-btn-copy');
    const clearBtn = document.getElementById('term-btn-clear');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const txt = $('#terminal-output') ? $('#terminal-output').textContent : '';
        navigator.clipboard.writeText(txt).then(
          () => Bob.toast('Terminal output copied.', 'success'),
          () => Bob.toast('Clipboard access blocked.', 'error')
        );
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => { clear($('#terminal-output')); termWrite('Terminal cleared.', 'term-note'); });
    }

    const tForm = $('#terminal-form');
    if (tForm && input) {
      tForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const command = input.value.trim();
        if (!command || term.busy) return;
        input.value = '';
        term.history.push(command); term.idx = term.history.length;
        termWrite(`$ ${command}`, 'term-cmd');
        if (command === 'clear') { clear($('#terminal-output')); return; }
      });
    }
      term.busy = true; input.disabled = true; $('#bv-terminal').setAttribute('aria-busy', 'true');
      try {
        const r = await Bob.api('/bob/terminal', { method: 'POST', body: { command } });
        if (r.output) termWrite(r.output, r.exitCode ? 'term-err' : '');
      } catch (err) { termWrite(err.status === 403 ? 'Permission denied for this command.' : err.message, 'term-err'); }
      term.busy = false; input.disabled = false; $('#bv-terminal').removeAttribute('aria-busy'); input.focus();
      if (/^(run|jobs|runs)\b/.test(command)) Bob.emit('terminal-job');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && term.history.length) { e.preventDefault(); term.idx = Math.max(0, term.idx - 1); input.value = term.history[term.idx]; }
      else if (e.key === 'ArrowDown' && term.history.length) { e.preventDefault(); term.idx = Math.min(term.history.length, term.idx + 1); input.value = term.history[term.idx] || ''; }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clear($('#terminal-output')); }
    });
    $('#bv-terminal').addEventListener('mousedown', (e) => { if (e.target === $('#terminal-output') && !window.getSelection().toString()) setTimeout(() => input.focus(), 0); });
  }

  // ── status bar ─────────────────────────────────────────────────────────────
  function initStatusBar() {
    $('#sb-checkpoint').addEventListener('click', () => cmds.run('bob.checkpoints'));
    $('#sb-cursor').addEventListener('click', () => cmds.run('edit.gotoLine'));
    $('#sb-lang').addEventListener('click', () => { Bob.showTab('ide'); const s = $('#ide-lang-select'); if (!s.disabled) s.focus(); else Bob.toast('Open a file you can edit to change its language.', 'info'); });
    $('#sb-mode').addEventListener('click', () => cmds.run('bob.cycleMode'));
    // sb-role removed (change #2/#3 — Roles tab removed)
    Bob.on('cursor', (c) => { $('#sb-cursor').textContent = `Ln ${c.line}, Col ${c.col}${c.selected ? ` (${c.selected} selected)` : ''}`; });
    Bob.on('ide', (s) => { $('#sb-lang').textContent = s.language ? (LANG_LABEL[s.language] || s.language) : '—'; });
    Bob.on('session', () => { refreshCheckpointLabel(); });
    Bob.on('mode', (m) => { $('#sb-mode').textContent = m.name; });
    Bob.on('checkpoints', refreshCheckpointLabel);
  }
  async function refreshCheckpointLabel() {
    const b = $('#sb-checkpoint');
    if (!Bob.can('ide:read')) { b.textContent = '⎇ —'; return; }
    try {
      const { checkpoints } = await Bob.api('/bob/checkpoints');
      b.textContent = checkpoints.length ? `⎇ ${checkpoints[0].short} (${checkpoints.length})` : '⎇ no checkpoint';
    } catch (_) { /* status bar is best-effort */ }
  }

  // ── activity bar ───────────────────────────────────────────────────────────
  function syncActivity() {
    const set = (v, on) => { const b = $(`#activity-bar [data-view="${v}"]`); if (b && b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(on)); };
    set('config', state.config);
  }
  function initActivityBar() {
    const bar = $('#activity-bar');
    if (!bar) return;
    const btns = [...bar.querySelectorAll('button')];
    if (!btns.length) return;
    btns.forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
    const actions = {
      config: () => Bob.layout.toggle('config')
    };
    btns.forEach((b, i) => {
      b.addEventListener('click', () => { if (actions[b.dataset.view]) actions[b.dataset.view](); });
      b.addEventListener('keydown', (e) => {
        let n = null;
        if (e.key === 'ArrowDown') n = (i + 1) % btns.length; else if (e.key === 'ArrowUp') n = (i - 1 + btns.length) % btns.length;
        else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = btns.length - 1;
        if (n !== null) { e.preventDefault(); btns.forEach((x, j) => { x.tabIndex = j === n ? 0 : -1; }); btns[n].focus(); }
      });
    });
  }

  // ── commands ───────────────────────────────────────────────────────────────
  cmds.register([
    { id: 'view.config', title: 'Toggle Primary Side Bar', category: 'View', keys: ['Mod+B'], run: () => Bob.layout.toggle('config') },
    { id: 'view.activity', title: 'Toggle Activity Bar', category: 'View', run: () => Bob.layout.toggle('activity') },
    { id: 'view.status', title: 'Toggle Status Bar', category: 'View', run: () => Bob.layout.toggle('status') },
    { id: 'view.resetLayout', title: 'Reset Layout', category: 'View', run: () => Bob.layout.reset() },
    { id: 'tab.output', title: 'Go to Output', category: 'Go', run: () => Bob.showTab('output') },
    { id: 'tab.dashboard', title: 'Go to Dashboard', category: 'Go', run: () => Bob.showTab('dashboard') },
    { id: 'tab.docs', title: 'Go to Docs & Reports', category: 'Go', run: () => Bob.showTab('docs') },
    { id: 'tab.runs', title: 'Go to Runs & Logs', category: 'Go', run: () => Bob.showTab('runs') }
  ]);

  Bob.layout.init = function init() {
    initActivityBar();
    initBottomTabs();
    initTerminal();
    initStatusBar();
    if ($('#split-config') && $('#config-column')) {
      splitter({ id: '#split-config', target: '#config-column', axis: 'x', min: 220, max: () => Math.min(520, window.innerWidth * 0.4), measure: (e, r) => e.clientX - r.left, key: 'config', def: 300 });
    }
    if ($('#split-bottom') && $('#bottom-panel')) {
      splitter({ id: '#split-bottom', target: '#bottom-panel', axis: 'y', min: 80, max: () => Math.max(120, window.innerHeight * 0.6), measure: (e, r) => r.bottom - e.clientY, key: 'bottom', def: 200 });
    }
    apply();
    Bob.on('tab', () => { syncActivity(); });
  };
})();
