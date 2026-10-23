/**
 * NEW (Bob IDE parity): command registry, Command Palette, keyboard shortcuts, reusable menu lists
 * (with submenus), context menus, prompt dialog and tooltips.   Namespace: window.Bob
 *
 *  - Every user-visible action is a *command* ({id, title, category, keys, run, enabled, when}).
 *    Menus, the palette, shortcuts and the status bar all call the same commands, so behaviour never diverges.
 *  - Shortcuts follow the IBM Bob documentation (Inline Chat, Move to chat, Literate coding, Open chat,
 *    Mode toggle, Code actions, Command Palette). Users can rebind them under Settings > General.
 *  - "Mod" means Ctrl on Windows/Linux and Cmd on macOS.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear } = Bob;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  Bob.isMac = isMac;

  // ── key combos ─────────────────────────────────────────────────────────────
  const CODE_NAMES = { Period: '.', Backquote: '`', Slash: '/', Comma: ',', Minus: '-', Equal: '=', Escape: 'Esc', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Backspace: 'Backspace', Enter: 'Enter', Space: 'Space', Tab: 'Tab', Delete: 'Delete', ContextMenu: 'ContextMenu' };
  /** KeyboardEvent -> canonical combo string such as "Mod+Shift+P" (modifiers always in the order Mod, Ctrl, Meta, Alt, Shift). */
  function eventCombo(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return '';
    const parts = [];
    if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
    if (isMac && e.ctrlKey) parts.push('Ctrl');
    if (!isMac && e.metaKey) parts.push('Meta');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let k = e.code || '';
    if (/^Key[A-Z]$/.test(k)) k = k.slice(3);
    else if (/^Digit\d$/.test(k)) k = k.slice(5);
    else if (/^F\d+$/.test(k)) { /* keep F1..F12 */ } else if (CODE_NAMES[k]) k = CODE_NAMES[k];
    else k = (e.key || '').length === 1 ? e.key.toUpperCase() : (e.key || '');
    parts.push(k);
    return parts.join('+');
  }
  /** Human readable combo: "Ctrl+Shift+P" on Windows/Linux, "⇧⌘P" on macOS. */
  function fmtCombo(c) {
    if (!c) return '';
    if (!isMac) return c.replace(/Mod/g, 'Ctrl');
    const sym = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
    const p = c.split('+');
    const key = p.pop();
    return p.map((m) => sym[m] || m).join('') + key;
  }
  Bob.fmtCombo = fmtCombo;

  // ── registry ───────────────────────────────────────────────────────────────
  const registry = new Map();
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem('bob_keybindings') || '{}') || {}; } catch (_) { overrides = {}; }
  const saveOverrides = () => localStorage.setItem('bob_keybindings', JSON.stringify(overrides));

  const keysOf = (c) => (Object.prototype.hasOwnProperty.call(overrides, c.id) ? (overrides[c.id] ? [overrides[c.id]] : []) : (c.keys || []));

  const api = {
    register(defs) { [].concat(defs).forEach((d) => registry.set(d.id, { category: 'Bob', ...d })); },
    get: (id) => registry.get(id),
    list: () => [...registry.values()],
    keysOf: (id) => (registry.has(id) ? keysOf(registry.get(id)) : []),
    // `hint` is a display-only shortcut for keys handled natively (e.g. CodeMirror's Ctrl+Z).
    keyLabel: (id) => fmtCombo(api.keysOf(id)[0] || (registry.get(id) || {}).hint || ''),
    /** Runs a command by id. Disabled commands are ignored (with a hint) instead of throwing. */
    run(id, arg) {
      const c = registry.get(id);
      if (!c) return undefined;
      let ok = true;
      try { ok = c.enabled ? !!c.enabled() : true; } catch (_) { ok = false; }
      if (!ok) { Bob.toast(`"${c.title}" is not available right now.`, 'info'); return undefined; }
      try { return c.run(arg); } catch (err) { console.error(`[commands] ${id} failed`, err); Bob.toast('That action failed.', 'error'); return undefined; }
    },
    /** Finds another command already using `combo`. */
    conflictFor(id, combo) { return [...registry.values()].find((c) => c.id !== id && keysOf(c).includes(combo) && !c.when); },
    setKey(id, combo) { overrides[id] = combo || ''; saveOverrides(); Bob.emit('keybindings'); },
    resetKey(id) { delete overrides[id]; saveOverrides(); Bob.emit('keybindings'); },
    resetAll() { overrides = {}; saveOverrides(); Bob.emit('keybindings'); },
    isCustom: (id) => Object.prototype.hasOwnProperty.call(overrides, id),
    exportKeys: () => ({ ...overrides }),
    importKeys(obj) {
      const clean = {};
      for (const [id, combo] of Object.entries(obj || {})) if (registry.has(id) && typeof combo === 'string' && combo.length < 40) clean[id] = combo;
      overrides = clean; saveOverrides(); Bob.emit('keybindings');
    },
    eventCombo, fmtCombo,
    capturing: false
  };
  Bob.commands = api;

  // ── global shortcut dispatcher (capture phase so it runs before CodeMirror / inputs) ──
  document.addEventListener('keydown', (e) => {
    if (api.capturing || e.isComposing) return;
    const combo = eventCombo(e);
    if (!combo) return;
    // Only chords (with Mod/Ctrl/Alt/Meta) or function keys; plain typing is never intercepted.
    if (!/^(Mod|Ctrl|Meta|Alt)/.test(combo) && !/^(Shift\+)?F\d+$/.test(combo)) return;
    if (document.querySelector('.palette-overlay') && combo !== 'Mod+Shift+P') return;
    const modalOpen = !!document.querySelector('.modal-overlay');
    for (const c of registry.values()) {
      if (!keysOf(c).includes(combo)) continue;
      if (modalOpen && !c.global) continue;           // dialogs are modal: only "global" commands pass through
      try { if (c.when && !c.when()) continue; if (c.enabled && !c.enabled()) continue; } catch (_) { continue; }
      e.preventDefault(); e.stopPropagation();
      api.run(c.id);
      return;
    }
  }, true);

  // ── fuzzy matching (used by the palette and the slash-command menu) ────────
  /** Returns a score > 0 when every query character appears in order in `text`, else 0. Higher is better. */
  Bob.fuzzy = function fuzzy(query, text) {
    const q = query.toLowerCase().replace(/\s+/g, ''); const t = text.toLowerCase();
    if (!q) return 1;
    let ti = 0; let score = 0; let streak = 0;
    for (const ch of q) {
      const at = t.indexOf(ch, ti);
      if (at < 0) return 0;
      streak = at === ti ? streak + 1 : 0;
      score += 1 + streak * 2 + (at === 0 || /[\s/:_-]/.test(t[at - 1]) ? 3 : 0);
      ti = at + 1;
    }
    return score - t.length * 0.01;
  };

  // ── Command Palette ────────────────────────────────────────────────────────
  function openPalette(initial = '') {
    if (document.querySelector('.palette-overlay')) { document.querySelector('.palette-overlay').remove(); return; }
    const prev = document.activeElement;
    const input = el('input', {
      type: 'text', class: 'palette-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list',
      'aria-autocomplete': 'list', 'aria-label': 'Type a command', placeholder: 'Type a command…', autocomplete: 'off', spellcheck: 'false', maxlength: 80
    });
    const list = el('ul', { id: 'palette-list', class: 'palette-list', role: 'listbox', 'aria-label': 'Commands' });
    const dialog = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command Palette' }, input, list);
    const overlay = el('div', { class: 'palette-overlay' }, dialog);
    document.body.append(overlay);
    let shown = []; let idx = 0;

    function enabledOf(c) { try { return c.enabled ? !!c.enabled() : true; } catch (_) { return false; } }
    function render() {
      const q = input.value.replace(/^>/, '').trim();
      shown = api.list().filter((c) => !c.hidden)
        .map((c) => ({ c, s: Bob.fuzzy(q, `${c.category} ${c.title}`) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.c.title.localeCompare(b.c.title)).slice(0, 60).map((x) => x.c);
      idx = Math.min(idx, Math.max(0, shown.length - 1));
      clear(list);
      if (!shown.length) list.append(el('li', { class: 'palette-empty', role: 'presentation' }, 'No matching commands'));
      shown.forEach((c, i) => {
        const on = enabledOf(c);
        list.append(el('li', {
          id: `pal-${i}`, role: 'option', class: `palette-item${i === idx ? ' active' : ''}${on ? '' : ' disabled'}`, 'aria-selected': String(i === idx), 'aria-disabled': String(!on),
          onmousemove: () => { if (idx !== i) { idx = i; mark(); } },
          onmousedown: (e) => { e.preventDefault(); choose(i); }
        }, el('span', { class: 'pal-cat' }, `${c.category}: `), el('span', { class: 'pal-title' }, c.title), el('span', { class: 'menu-shortcut' }, api.keyLabel(c.id))));
      });
      input.setAttribute('aria-activedescendant', shown.length ? `pal-${idx}` : '');
      list.setAttribute('aria-busy', 'false');
    }
    function mark() {
      [...list.children].forEach((li, i) => { li.classList.toggle('active', i === idx); li.setAttribute('aria-selected', String(i === idx)); });
      input.setAttribute('aria-activedescendant', `pal-${idx}`);
      const a = list.children[idx]; if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }
    function close(restore = true) { overlay.remove(); if (restore && prev && prev.focus) prev.focus(); }
    function choose(i) {
      const c = shown[i]; if (!c) return;
      if (!enabledOf(c)) { Bob.toast(`"${c.title}" is not available right now.`, 'info'); return; }
      close(true);
      setTimeout(() => api.run(c.id), 0);              // run after focus is restored so commands may move focus
    }
    input.addEventListener('input', () => { idx = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % Math.max(1, shown.length); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + shown.length) % Math.max(1, shown.length); mark(); }
      else if (e.key === 'Home') { e.preventDefault(); idx = 0; mark(); }
      else if (e.key === 'End') { e.preventDefault(); idx = Math.max(0, shown.length - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(idx); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') e.preventDefault();       // focus stays in the palette (focus trap)
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(true); });
    input.value = initial; render(); input.focus();
  }
  api.openPalette = openPalette;
  api.register({ id: 'palette.open', title: 'Show All Commands', category: 'View', keys: ['Mod+Shift+P', 'F1'], run: () => openPalette(), global: true });
  const btnPal = document.getElementById('btn-palette');
  if (btnPal) btnPal.addEventListener('click', () => openPalette());

  // ── reusable menu list (menubar + context menus) with submenu support ──────
  /**
   * Bob.menuList(items, { labelledby, depth, onDone(returnFocus), onEdgeKey(e) }) -> { ul, refresh(), focusFirst(), focusLast() }
   * item = { label | cmd, shortcut, run, enabled(), checked, items | () => items, sep }
   * Keyboard: Up/Down/Home/End move, Right opens a submenu, Left/Esc closes it, Enter/Space activate.
   */
  Bob.menuList = function menuList(itemsOrFn, opts = {}) {
    const depth = opts.depth || 0;
    const resolve = (v) => (typeof v === 'function' ? v() : v) || [];
    const ul = el('ul', { role: 'menu', class: `menu-list${depth ? ' submenu' : ''}`, 'aria-labelledby': opts.labelledby, hidden: depth > 0 });
    let parentBtn = null;

    const enabledBtns = () => [...ul.children].map((li) => li.firstElementChild).filter((b) => b && b.matches && b.matches('button.menu-item:not(:disabled)'));
    function closeSub(li) {
      const sub = li.querySelector(':scope > ul'); const b = li.firstElementChild;
      if (sub) { sub.hidden = true; b.setAttribute('aria-expanded', 'false'); }
    }
    function openSub(li, focusFirst) {
      [...ul.children].forEach((o) => { if (o !== li) closeSub(o); });
      const sub = li.querySelector(':scope > ul'); if (!sub) return;
      sub.hidden = false; li.firstElementChild.setAttribute('aria-expanded', 'true');
      if (focusFirst) { const f = [...sub.children].map((x) => x.firstElementChild).find((b) => b && b.matches && b.matches('button.menu-item:not(:disabled)')); if (f) f.focus(); }
    }

    function fill() {
      clear(ul);
      resolve(itemsOrFn).forEach((it) => {
        if (it.sep) { ul.append(el('li', { role: 'separator', class: 'menu-sep' })); return; }
        const cmd = it.cmd ? api.get(it.cmd) : null;
        const label = it.label || (cmd && cmd.title) || '';
        const shortcut = it.shortcut !== undefined ? it.shortcut : (it.cmd ? api.keyLabel(it.cmd) : '');
        let enabled = true;
        try { enabled = it.enabled ? !!it.enabled() : (cmd && cmd.enabled ? !!cmd.enabled() : true); } catch (_) { enabled = false; }
        const hasSub = !!it.items;
        const checkable = it.checked !== undefined;
        const btn = el('button', {
          type: 'button', role: checkable ? 'menuitemradio' : 'menuitem', class: 'menu-item', tabindex: '-1',
          disabled: !enabled, 'aria-disabled': String(!enabled), 'aria-checked': checkable ? String(!!it.checked) : null,
          'aria-haspopup': hasSub ? 'true' : null, 'aria-expanded': hasSub ? 'false' : null
        }, el('span', null, checkable ? (it.checked ? '✓ ' : '\u2003') : null, label), el('span', { class: 'menu-shortcut', 'aria-hidden': 'true' }, hasSub ? '▸' : shortcut));
        const li = el('li', { role: 'none', class: hasSub ? 'has-sub' : null }, btn);
        if (hasSub) {
          const sub = Bob.menuList(it.items, { depth: depth + 1, labelledby: null, onDone: opts.onDone, onEdgeKey: opts.onEdgeKey });
          sub.setParent(btn);
          sub.ul.setAttribute('aria-label', label);
          li.append(sub.ul);
          li._sub = sub;
          btn.addEventListener('click', () => (sub.ul.hidden ? openSub(li, false) : closeSub(li)));
          li.addEventListener('mouseenter', () => { if (enabled) openSub(li, false); });
        } else {
          btn.addEventListener('click', () => {
            if (opts.onDone) opts.onDone(true);
            try { const run = it.run || (it.cmd && (() => api.run(it.cmd))); if (run) run(); } catch (err) { console.error('[menu] action failed', err); Bob.toast('That action failed.', 'error'); }
          });
          li.addEventListener('mouseenter', () => [...ul.children].forEach(closeSub));
        }
        ul.append(li);
      });
      // Submenus must reflect current state too.
      [...ul.children].forEach((li) => { if (li._sub) li._sub.refresh(); });
    }

    ul.addEventListener('keydown', (e) => {
      const items = enabledBtns();
      const cur = items.indexOf(document.activeElement);
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'ArrowDown') { stop(); if (items.length) items[(cur + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { stop(); if (items.length) items[(cur - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { stop(); if (items.length) items[0].focus(); }
      else if (e.key === 'End') { stop(); if (items.length) items[items.length - 1].focus(); }
      else if (e.key === 'ArrowRight') {
        const li = document.activeElement && document.activeElement.closest('li');
        if (li && li._sub && ul.contains(li)) { stop(); openSub(li, true); } else { stop(); if (opts.onEdgeKey) opts.onEdgeKey(e); }
      } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        if (depth > 0 && parentBtn) { stop(); const li = parentBtn.closest('li'); closeSub(li); parentBtn.focus(); } else if (opts.onEdgeKey) { stop(); opts.onEdgeKey(e); }
      } else if (e.key === 'Tab') { if (opts.onEdgeKey) opts.onEdgeKey(e); }
    });

    fill();
    return {
      ul, refresh: fill,
      setParent: (b) => { parentBtn = b; },
      focusFirst: () => { const b = enabledBtns(); if (b.length) b[0].focus(); },
      focusLast: () => { const b = enabledBtns(); if (b.length) b[b.length - 1].focus(); }
    };
  };

  // ── context menu ───────────────────────────────────────────────────────────
  let activeCtx = null;
  /** Bob.contextMenu(items, x, y) opens a floating menu at viewport coordinates. Returns { close }. */
  Bob.contextMenu = function contextMenu(items, x, y, opts = {}) {
    if (activeCtx) activeCtx.close(false);
    const prev = opts.restoreFocus || document.activeElement;
    let closed = false;
    const ml = Bob.menuList(items, {
      labelledby: null,
      onDone: (ret) => close(ret),
      onEdgeKey: (e) => { if (e.key === 'Escape' || e.key === 'Tab') close(e.key === 'Escape'); }
    });
    ml.ul.hidden = false;
    ml.ul.setAttribute('aria-label', opts.label || 'Context menu');
    const wrap = el('div', { class: 'ctx-menu' }, ml.ul);
    document.body.append(wrap);
    const r = wrap.getBoundingClientRect();
    wrap.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    wrap.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    ml.focusFirst();

    function close(restore) {
      if (closed) return; closed = true;
      wrap.remove();
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onGone); window.removeEventListener('blur', onGone);
      document.removeEventListener('scroll', onGone, true);
      activeCtx = null;
      if (restore !== false && prev && prev.focus) prev.focus();
    }
    const onDown = (e) => { if (!wrap.contains(e.target)) close(false); };
    const onGone = () => close(false);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onGone); window.addEventListener('blur', onGone);
    document.addEventListener('scroll', onGone, true);
    activeCtx = { close };
    return { close };
  };
  /** Opens a context menu next to a keyboard-focused element (for Shift+F10 / the Menu key). */
  Bob.contextMenuAt = (items, node, opts) => { const r = node.getBoundingClientRect(); return Bob.contextMenu(items, r.left + 8, r.bottom, opts); };

  // ── prompt dialog (single text input) ──────────────────────────────────────
  /** Bob.prompt({title, label, value, help, validate(v) -> error|''}) -> Promise<string|null> */
  Bob.prompt = ({ title, label, value = '', help = '', submitLabel = 'OK', validate, type = 'text' }) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const id = `pr-${Math.random().toString(36).slice(2, 7)}`;
    const input = el('input', { type, id, value, maxlength: 120, autocomplete: 'off', 'aria-describedby': help ? `${id}-h` : null });
    const m = Bob.modal({
      title,
      body: el('div', { class: 'form-stack' }, el('label', { for: id }, label), input, help ? el('small', { id: `${id}-h`, class: 'hint' }, help) : null),
      actions: [
        { label: 'Cancel', onClick: () => finish(null) },
        {
          label: submitLabel, primary: true, onClick: (ctl) => {
            const v = input.value.trim();
            const err = validate ? validate(v) : '';
            if (err) { ctl.showError(err); return false; }
            finish(v); return undefined;
          }
        }
      ]
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.btn-small-primary').click(); } });
    const mo = new MutationObserver(() => { if (!document.body.contains(m.el)) { finish(null); mo.disconnect(); } });
    mo.observe(document.body, { childList: true });
  });

  // ── tooltips for [data-tip] (hover after a short delay, immediately on keyboard focus) ──
  const tip = el('div', { class: 'tooltip', id: 'bob-tooltip', role: 'tooltip', hidden: true });
  document.body.append(tip);
  let tipTimer = null; let tipFor = null;
  function showTip(node) {
    const text = node.getAttribute('data-tip'); if (!text) return;
    tip.textContent = text; tip.hidden = false; tipFor = node;
    node.setAttribute('aria-describedby', 'bob-tooltip');
    const r = node.getBoundingClientRect(); const t = tip.getBoundingClientRect();
    let top = r.bottom + 6; if (top + t.height > window.innerHeight - 4) top = r.top - t.height - 6;
    tip.style.left = `${Math.max(4, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 4))}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipFor) { tipFor.removeAttribute('aria-describedby'); tipFor = null; }
    tip.hidden = true;
  }
  document.addEventListener('mouseover', (e) => { const n = e.target.closest && e.target.closest('[data-tip]'); if (!n || n === tipFor) return; hideTip(); tipTimer = setTimeout(() => showTip(n), 450); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('[data-tip]')) hideTip(); });
  document.addEventListener('focusin', (e) => { const n = e.target.closest && e.target.closest('[data-tip]'); if (n && n.matches(':focus-visible')) { hideTip(); showTip(n); } });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); }, true);
  window.addEventListener('scroll', hideTip, true);
})();
