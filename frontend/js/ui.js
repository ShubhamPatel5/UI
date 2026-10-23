/**
 * NEW: Shared UI helpers used by every module (namespace: window.Bob).
 *  - el():       safe DOM builder. Never uses innerHTML, so user data cannot inject markup (XSS).
 *  - api():      fetch wrapper with timeout, JSON handling and friendly errors (no stack traces shown).
 *  - toast():    non-blocking notifications (replaces blocking alert()).
 *  - modal():    accessible dialog (focus trap, Esc to close, focus restore).
 *  - initTabs(): WAI-ARIA tabs with arrow-key navigation.
 *  - withBusy(): loading state for buttons + double-click protection.
 */
(function () {
  'use strict';
  const Bob = (window.Bob = window.Bob || {});

  // ── tiny pub/sub so modules stay decoupled ─────────────────────────────────
  const handlers = {};
  Bob.on = (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); };
  Bob.emit = (evt, data) => { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(`[Bob] handler for "${evt}" failed`, e); } }); };

  // ── DOM builder ────────────────────────────────────────────────────────────
  /** el('button', {class:'x', onclick: fn, 'aria-label':'y'}, 'text', childNode) */
  Bob.el = function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  };
  const el = Bob.el;
  Bob.clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  Bob.$ = (sel, root) => (root || document).querySelector(sel);

  // ── formatting ─────────────────────────────────────────────────────────────
  Bob.fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  Bob.fmtDuration = (ms) => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  Bob.runDuration = (r) => (r.startedAt ? Bob.fmtDuration((r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.startedAt)) : '—');
  /** Status chip: colour + text label (never colour alone, for accessibility). */
  Bob.statusChip = (status) => el('span', { class: `status-chip status-${status || 'idle'}` }, status || 'idle');

  // ── API client ─────────────────────────────────────────────────────────────
  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  Bob.ApiError = ApiError;

  Bob.api = async function api(path, { method = 'GET', body, timeoutMs = Bob.timeoutMs || 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`/api${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON body */ }
      if (!res.ok) {
        const msg = (data && data.error) || `Request failed (${res.status})`;
        if (res.status === 403) Bob.emit('forbidden', data);
        throw new ApiError(msg, res.status);
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new ApiError('The request timed out', 0);
      if (err instanceof ApiError) throw err;
      throw new ApiError('Cannot reach the server. Is it running?', 0);
    } finally { clearTimeout(timer); }
  };

  // ── permissions ────────────────────────────────────────────────────────────
  Bob.session = { role: '', permissions: [], roles: [], allPermissions: [] };
  /** UI-side check only for enabling/disabling controls. The server enforces every permission. */
  Bob.can = (perm) => {
    if (!Bob.session || !Bob.session.role) return true; // Optimistic fallback during initialization
    if (Bob.session.role === 'admin') return true;
    return (Bob.session.permissions && Bob.session.permissions.includes(perm));
  };
  Bob.loadSession = async () => {
    Bob.session = await Bob.api('/session');
    // role-chip removed from top nav (change #3) — guard is kept for safety
    const chip = document.getElementById('role-chip');
    if (chip) chip.textContent = `Role: ${Bob.session.role}`;
    Bob.emit('session', Bob.session);
    return Bob.session;
  };

  // ── toasts ─────────────────────────────────────────────────────────────────
  // NEW: optional action button, manual dismiss (×), pause-on-hover and a fade-out transition.
  Bob.toast = function toast(message, level = 'info', opts = {}) {
    const region = document.getElementById('toast-region');
    const t = el('div', { class: `toast toast-${level}`, role: level === 'error' ? 'alert' : 'status', 'data-testid': 'toast', 'data-level': level }, message);
    let timer = null;
    const dismiss = () => { clearTimeout(timer); t.classList.add('toast-out'); setTimeout(() => t.remove(), 180); };
    if (opts.action) t.append(el('button', { type: 'button', class: 'toast-action', onclick: () => { dismiss(); opts.action.run(); } }, opts.action.label));
    t.append(el('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss notification', onclick: dismiss }));
    const arm = () => { timer = setTimeout(dismiss, level === 'error' ? 7000 : (opts.action ? 6000 : 3500)); };
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', arm);
    region.append(t);
    while (region.children.length > 5) region.firstChild.remove(); // never let toasts pile up
    arm();
    return t;
  };
  Bob.errorToast = (err) => Bob.toast(err && err.message ? err.message : 'Something went wrong', 'error');

  // ── modal dialog ───────────────────────────────────────────────────────────
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  /**
   * Bob.modal({ title, body: Node, actions: [{label, primary, danger, onClick(close) -> may return Promise<false> to stay open}] })
   */
  Bob.modal = function modal({ title, body, actions = [], wide = false, className = '' }) {
    const previouslyFocused = document.activeElement;
    const titleId = `dlg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const errBox = el('div', { class: 'form-error', role: 'alert', hidden: true });
    const dialog = el('div', { class: `modal${wide ? ' modal-wide' : ''}${className ? ` ${className}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      el('div', { class: 'modal-head' },
        el('h3', { id: titleId }, title),
        el('button', { type: 'button', class: 'modal-x', 'aria-label': 'Close dialog', onclick: () => close() }, '×')),
      el('div', { class: 'modal-body' }, body, errBox),
      actions.length ? el('div', { class: 'modal-foot' }) : null);
    const overlay = el('div', { class: 'modal-overlay' }, dialog);
    document.body.append(overlay);

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const ctl = {
      close,
      el: dialog,
      showError: (msg) => { errBox.textContent = msg; errBox.hidden = !msg; }
    };
    const foot = dialog.querySelector('.modal-foot');
    actions.forEach((a) => {
      const btn = el('button', { type: 'button', class: `btn-small${a.primary ? ' btn-small-primary' : ''}${a.danger ? ' btn-small-danger' : ''}` }, a.label);
      btn.addEventListener('click', async () => {
        ctl.showError('');
        btn.disabled = true;
        try {
          const keepOpen = a.onClick ? await a.onClick(ctl) : undefined;
          if (keepOpen !== false) close();
        } catch (err) { ctl.showError(err.message || 'Something went wrong'); } finally { btn.disabled = false; }
      });
      foot.append(btn);
    });
    // Focus the first form control, else the first button.
    const first = dialog.querySelector('input,select,textarea') || dialog.querySelector('.modal-foot button') || dialog.querySelector('.modal-x');
    setTimeout(() => first && first.focus(), 0);
    return ctl;
  };

  /** Promise-based confirm dialog. */
  Bob.confirm = (message, { confirmLabel = 'Confirm', danger = false, title = 'Please confirm' } = {}) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const m = Bob.modal({
        title, body: el('p', null, message),
        actions: [
          { label: 'Cancel', onClick: () => finish(false) },
          { label: confirmLabel, primary: !danger, danger, onClick: () => finish(true) }
        ]
      });
      // Closing via Esc / X / backdrop counts as "cancel".
      const mo = new MutationObserver(() => { if (!document.body.contains(m.el)) { finish(false); mo.disconnect(); } });
      mo.observe(document.body, { childList: true });
    });

  // ── busy buttons ───────────────────────────────────────────────────────────
  /** Runs fn() while the button is disabled and shows a loading label. Errors become toasts. */
  Bob.withBusy = async function withBusy(btn, fn, busyLabel = 'Working…') {
    if (!btn || btn.disabled) return undefined;
    const original = btn.textContent;
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = busyLabel;
    try { return await fn(); } catch (err) { Bob.errorToast(err); return undefined; } finally {
      btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = original;
    }
  };

  /** Placeholder shown inside a panel while its data loads. */
  Bob.loading = (text = 'Loading…') => el('div', { class: 'state-msg', role: 'status' }, text);
  Bob.empty = (text) => el('div', { class: 'state-msg' }, text);
  Bob.errorState = (err, retry) => el('div', { class: 'state-msg state-error', role: 'alert' },
    err.message || 'Failed to load', retry ? el('button', { type: 'button', class: 'btn-small', onclick: retry }, 'Retry') : null);

  // ── tabs (WAI-ARIA, roving tabindex) ───────────────────────────────────────
  Bob.initTabs = function initTabs() {
    const strip = document.getElementById('main-tabs');
    const tabs = [...strip.querySelectorAll('[role=tab]')];
    function select(tab, focus) {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
      Bob.emit('tab', tab.id.replace('tab-', ''));
    }
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        let n = null;
        if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') n = tabs[0];
        else if (e.key === 'End') n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    Bob.showTab = (name) => select(document.getElementById(`tab-${name}`));
    select(tabs[0]);
  };

  /** Triggers a client-side file download (used by export and log download). */
  Bob.download = (filename, text, mime = 'application/json') => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = el('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();
