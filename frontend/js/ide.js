/**
 * IDE module (js/ide.js)
 *
 * FIX for "Edit option missing under IDE":
 *   Root cause: the original IDE markup had no menu bar at all (only a file-name header and a language
 *   dropdown), and the CodeMirror editor itself never initialised because its CDN links were invalid.
 *   This module renders a real File / Edit / View / Run / Terminal / Bob / Help menubar and binds every Edit
 *   item to a working CodeMirror command. Edit items are DISABLED (never hidden) for read-only roles so the
 *   option is always discoverable.
 *
 * Previously added: workspace file management, syntax highlighting, unsaved-changes tracking.
 *
 * NEW (Bob IDE parity, this revision):
 *   - Editor tabs: open several files, per-tab undo history and dirty marker, close, reorder (mouse drag or
 *     Ctrl+Shift+Left/Right), tab context menu, restore open tabs after reload.
 *   - Menubar rebuilt on the shared menu component: submenus (View > Appearance), shortcuts shown from the
 *     command registry, Terminal / Bob / Help menus.
 *   - Editor + explorer context menus, drag-and-drop (file -> chat context, OS file -> explorer upload).
 *   - Code actions: lightbulb in the gutter, Ctrl/Cmd+. (Add to Context, Inline Chat, Move to Chat,
 *     Explain / Fix / Improve).
 *   - Inline Chat (Ctrl/Cmd+K) as an inline widget; Move to Chat (Ctrl/Cmd+L).
 *   - Literate coding (Ctrl/Cmd+I): instruction comments are highlighted blue, Generate shows an inline diff,
 *     Accept all (Ctrl/Cmd+Enter) / Reject (Ctrl/Cmd+Shift+Backspace) / Exit.
 *   - Bob tips: purple underline on complex / long functions with a "Fix with Bob" hover card, plus problem
 *     underlines. Findings come from the server-side analyzer.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;
  const cmds = Bob.commands;

  const MODE_BY_LANG = { javascript: 'javascript', nodejs: 'javascript', python: 'python', java: 'text/x-java', markdown: 'markdown' };
  const LANG_LABEL = { javascript: 'JavaScript', nodejs: 'Node.js', python: 'Python', java: 'Java', markdown: 'Markdown' };
  const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
  const MOD = Bob.isMac ? '⌘' : 'Ctrl+';
  const hasCM = typeof window.CodeMirror !== 'undefined';
  const TABS_KEY = 'bob_open_tabs';

  let cm = null;                // CodeMirror instance (or minimal fallback adapter)
  let files = [];               // [{name, language, size, updatedAt}] from the server
  let tabs = [];                // open editors: [{name, language, doc|content, dirty}]
  let current = null;           // the active tab (or null)
  let loading = false;          // true while we programmatically replace content
  let readOnly = true;          // derived from permission "ide:edit"
  let fontSize = 14;
  let menus = [];               // [{label, build, btn, ml}]
  let openIdx = -1;
  let findings = [];            // analyzer output for all files
  let tipMarks = [];
  let lit = { on: false, pending: null };   // literate-coding state
  let inlineWidget = null;

  // ── small helpers ──────────────────────────────────────────────────────────
  const ideVisible = () => !$('#panel-ide').hidden;
  const canEdit = () => !readOnly;
  const hasFile = () => !!current;
  const dirtyTabs = () => tabs.filter((t) => t.dirty);
  const langOf = (name) => (/\.py$/i.test(name) ? 'python' : /\.java$/i.test(name) ? 'java' : /\.md$/i.test(name) ? 'markdown' : 'javascript');
  const editorFocused = () => !!cm && (hasCM ? cm.hasFocus() : document.activeElement === $('#code-editor-canvas'));

  // ── editor bootstrap ───────────────────────────────────────────────────────
  function createEditor() {
    const ta = $('#code-editor-canvas');
    if (hasCM) {
      cm = window.CodeMirror.fromTextArea(ta, {
        lineNumbers: true, mode: 'javascript', theme: 'neo', tabSize: 2, lineWrapping: true,
        matchBrackets: true, autoCloseBrackets: true, readOnly: true, gutters: ['CodeMirror-linenumbers'],
        extraKeys: { 'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment', 'Ctrl-H': 'replace', 'Esc': false }
      });
      // Accessibility: expose the real input element with a name and keep Tab usable.
      cm.getInputField().setAttribute('aria-label', 'Code editor');
    } else {
      // Fallback so the editor is never blank even if CodeMirror failed to load.
      ta.hidden = false; ta.className = 'fallback-editor'; ta.readOnly = true;
      cm = {
        getValue: () => ta.value, setValue: (v) => { ta.value = v; },
        setOption: (k, v) => { if (k === 'readOnly') ta.readOnly = !!v; },
        getOption: () => false, focus: () => ta.focus(), refresh: () => {}, clearHistory: () => {},
        getSelection: () => ta.value.slice(ta.selectionStart, ta.selectionEnd),
        somethingSelected: () => ta.selectionStart !== ta.selectionEnd,
        replaceSelection: (t) => ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end'),
        on: (evt, fn) => { if (evt === 'change') ta.addEventListener('input', fn); },
        historySize: () => ({ undo: 1, redo: 1 }), hasFocus: () => document.activeElement === ta
      };
      Bob.toast('Code editor library failed to load; using a basic text area.', 'error');
    }
    cm.on('change', () => {
      if (loading || !current) return;
      if (!current.dirty) { current.dirty = true; renderTabs(); renderExplorer(); }
      showDirty();
      scheduleLitRefresh();
    });
    if (hasCM) {
      cm.on('cursorActivity', onCursor);
      cm.on('blur', () => setTimeout(() => { if (!editorFocused() && !(document.activeElement && document.activeElement.closest('.lightbulb'))) hideBulb(); }, 120));
      cm.on('scroll', hideBulb);
    }
  }

  function showDirty() {
    $('#ide-dirty-flag').hidden = !(current && current.dirty);
    Bob.emit('ide', stateInfo());
  }
  const stateInfo = () => ({ file: current ? current.name : '', language: current ? current.language : '', dirty: !!(current && current.dirty), tabs: tabs.length });

  function applyMode(language) {
    if (hasCM) cm.setOption('mode', MODE_BY_LANG[language] || 'javascript');
    $('#ide-lang-select').value = language;
  }

  function showCurrentName() {
    $('#ide-filename-display').textContent = current ? `📄 ${current.name}` : '📄 (no file open)';
    $('#editor-empty').hidden = !!current;
  }

  // ── permissions ────────────────────────────────────────────────────────────
  function applyPermissions() {
    readOnly = !Bob.can('ide:edit');
    if (cm) cm.setOption('readOnly', readOnly || !current);
    $('#ide-readonly-flag').hidden = !readOnly;
    $('#ide-lang-select').disabled = readOnly || !current;
    $('#btn-literate').disabled = readOnly || !current;
    if (readOnly && lit.on) exitLiterate(true);
    renderExplorer(); renderTabs();
    refreshMenus();
  }

  // ── file operations (all hit the REST API; errors become toasts) ───────────
  async function refreshFiles(opts = {}) {
    if (!Bob.can('ide:read')) {
      files = []; tabs = []; current = null; renderExplorer(); renderTabs(); showCurrentName();
      if (!opts.silent) Bob.toast('Your role cannot read workspace files.', 'error');
      return;
    }
    try { files = (await Bob.api('/files')).files; } catch (err) { Bob.errorToast(err); files = []; }
    // Drop tabs whose files vanished on the server (deleted elsewhere).
    const names = new Set(files.map((f) => f.name));
    const gone = tabs.filter((t) => !names.has(t.name));
    if (gone.length) { gone.forEach((t) => removeTab(t, true)); }
    renderExplorer();
    if (!tabs.length) {
      // Restore the tabs from the previous session, else open the first file.
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem(TABS_KEY) || '[]'); } catch (_) { saved = []; }
      const restore = (Array.isArray(saved) ? saved : []).filter((n) => typeof n === 'string' && names.has(n)).slice(0, 8);
      if (!restore.length && files.length) restore.push(files[0].name);
      for (const n of restore) await openFile(n, { activate: n === restore[restore.length - 1] || n === restore[0] && restore.length === 1 });
      if (!current && tabs.length) activateTab(tabs[0]);
    }
    loadFindings();
  }

  function persistTabs() { try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => t.name))); } catch (_) { /* quota */ } }

  /** Opens a file in a tab (or activates the existing tab). */
  async function openFile(name, { activate = true, line } = {}) {
    const existing = tabs.find((t) => t.name === name);
    if (existing) { if (activate) activateTab(existing); if (line) gotoLine(line); return existing; }
    try {
      const { file } = await Bob.api(`/files/${encodeURIComponent(name)}`);
      const tab = { name: file.name, language: file.language, dirty: false, content: file.content, doc: hasCM ? new window.CodeMirror.Doc(file.content, MODE_BY_LANG[file.language] || 'javascript') : null };
      tabs.push(tab);
      if (activate) activateTab(tab); else renderTabs();
      persistTabs();
      if (line) gotoLine(line);
      return tab;
    } catch (err) { Bob.errorToast(err); return null; }
  }

  function activateTab(tab) {
    if (!tab) return;
    if (lit.pending) rejectLiterate(true);                // pending generation never leaks across files
    closeInline();
    if (!hasCM && current && current !== tab) current.content = cm.getValue();
    current = tab;
    loading = true;
    if (hasCM) cm.swapDoc(tab.doc); else cm.setValue(tab.content);
    loading = false;
    applyMode(tab.language);
    showCurrentName(); showDirty();
    cm.setOption('readOnly', readOnly || !current);
    $('#ide-lang-select').disabled = readOnly;
    $('#btn-literate').disabled = readOnly;
    renderTabs(); renderExplorer();
    applyTips(); refreshLitHighlights();
    if (hasCM) setTimeout(() => cm.refresh(), 0);
    persistTabs();
  }

  function removeTab(tab, silent) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (current === tab) {
      current = null;
      const next = tabs[Math.min(i, tabs.length - 1)];
      if (next) activateTab(next);
      else {
        loading = true;
        if (hasCM) cm.swapDoc(new window.CodeMirror.Doc('', 'javascript')); else cm.setValue('');
        loading = false;
        cm.setOption('readOnly', true);
        showCurrentName(); showDirty(); applyPermissions(); clearTips();
      }
    }
    if (!silent) { renderTabs(); renderExplorer(); }
    persistTabs();
  }

  async function closeTab(tab, { force = false } = {}) {
    if (!tab) return false;
    if (tab.dirty && !force) {
      const ok = await Bob.confirm(`"${tab.name}" has unsaved changes. Close without saving?`, { confirmLabel: 'Discard', danger: true, title: 'Unsaved changes' });
      if (!ok) return false;
    }
    removeTab(tab);
    return true;
  }

  async function saveTab(tab) {
    if (!tab) return Bob.toast('No file is open.', 'error');
    if (readOnly) return Bob.toast('Your role cannot edit files.', 'error');
    try {
      if (tab === current) tab.language = $('#ide-lang-select').value;
      const content = tab === current ? cm.getValue() : (hasCM ? tab.doc.getValue() : tab.content);
      await Bob.api(`/files/${encodeURIComponent(tab.name)}`, { method: 'PUT', body: { content, language: tab.language } });
      tab.dirty = false;
      showDirty(); renderTabs();
      Bob.toast(`Saved ${tab.name}`, 'success');
      await refreshFiles({ silent: true });
    } catch (err) { Bob.errorToast(err); }
  }
  const save = () => saveTab(current);
  async function saveAll() {
    const list = dirtyTabs();
    if (!list.length) return Bob.toast('Nothing to save.', 'info');
    for (const t of list) await saveTab(t);
  }

  function nameDialog({ title, initialName = '', initialLang = 'javascript', withLang, submitLabel, onSubmit }) {
    const nameIn = el('input', { type: 'text', id: 'ide-name-input', value: initialName, maxlength: 64, required: true, autocomplete: 'off', 'aria-describedby': 'ide-name-help' });
    const langSel = el('select', { id: 'ide-name-lang' }, ...Object.keys(MODE_BY_LANG).map((l) => el('option', { value: l, selected: l === initialLang }, l)));
    const body = el('div', { class: 'form-stack' },
      el('label', { for: 'ide-name-input' }, 'File name'), nameIn,
      el('small', { id: 'ide-name-help', class: 'hint' }, 'Letters, digits, _ . - only (max 64). No folders.'),
      withLang ? el('label', { for: 'ide-name-lang' }, 'Language') : null, withLang ? langSel : null);
    const m = Bob.modal({
      title, body,
      actions: [
        { label: 'Cancel' },
        {
          label: submitLabel, primary: true, onClick: async (ctl) => {
            const name = nameIn.value.trim();
            if (!NAME_RE.test(name)) { ctl.showError('Invalid file name.'); return false; }
            try { await onSubmit(name, langSel.value); } catch (err) { ctl.showError(err.message); return false; }
            return undefined;
          }
        }
      ]
    });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.btn-small-primary').click(); } });
    if (withLang) nameIn.addEventListener('input', () => { langSel.value = langOf(nameIn.value); });
  }

  function newFile() {
    nameDialog({
      title: 'New file', initialName: 'new_script.js', withLang: true, submitLabel: 'Create',
      onSubmit: async (name, language) => {
        await Bob.api('/files', { method: 'POST', body: { name, language, content: '' } });
        await refreshFiles({ silent: true });
        await openFile(name);
        Bob.toast(`Created ${name}`, 'success');
      }
    });
  }

  function renameFile(name = current && current.name) {
    if (!name) return;
    nameDialog({
      title: 'Rename file', initialName: name, submitLabel: 'Rename',
      onSubmit: async (newName) => {
        if (newName === name) return;
        await Bob.api(`/files/${encodeURIComponent(name)}`, { method: 'PUT', body: { newName } });
        const t = tabs.find((x) => x.name === name);
        if (t) t.name = newName;
        if (current === t) showCurrentName();
        persistTabs();
        await refreshFiles({ silent: true });
        renderTabs();
        Bob.toast(`Renamed to ${newName}`, 'success');
      }
    });
  }

  async function deleteFile(name = current && current.name) {
    if (!name) return;
    if (!(await Bob.confirm(`Delete "${name}"? This cannot be undone.`, { confirmLabel: 'Delete', danger: true, title: 'Delete file' }))) return;
    try {
      await Bob.api(`/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const t = tabs.find((x) => x.name === name);
      if (t) removeTab(t);
      Bob.toast(`Deleted ${name}`, 'success');
      await refreshFiles({ silent: true });
    } catch (err) { Bob.errorToast(err); }
  }

  async function downloadFile(name = current && current.name) {
    if (!name) return;
    const t = tabs.find((x) => x.name === name);
    if (t) return Bob.download(name, t === current ? cm.getValue() : (hasCM ? t.doc.getValue() : t.content), 'text/plain');
    try { Bob.download(name, (await Bob.api(`/files/${encodeURIComponent(name)}`)).file.content, 'text/plain'); } catch (err) { Bob.errorToast(err); }
    return undefined;
  }

  /** Upload text files dropped from the OS onto the explorer. */
  async function uploadFiles(list) {
    if (readOnly) return Bob.toast('Your role cannot create files.', 'error');
    let n = 0;
    for (const f of [...list].slice(0, 10)) {
      if (!NAME_RE.test(f.name)) { Bob.toast(`Skipped "${f.name.slice(0, 40)}": invalid file name.`, 'error'); continue; }
      if (f.size > 200 * 1024) { Bob.toast(`Skipped ${f.name}: larger than 200 KB.`, 'error'); continue; }
      try {
        const content = await f.text();
        await Bob.api('/files', { method: 'POST', body: { name: f.name, language: langOf(f.name), content } });
        n++;
      } catch (err) { Bob.toast(`${f.name}: ${err.message}`, 'error'); }
    }
    if (n) { Bob.toast(`Uploaded ${n} file(s).`, 'success'); await refreshFiles({ silent: true }); }
    return undefined;
  }

  // ── Edit-menu helpers (each maps to a real CodeMirror command) ─────────────
  async function clipCopy(cut) {
    const text = cm.getSelection();
    if (!text) return Bob.toast('Nothing is selected.', 'info');
    try {
      await navigator.clipboard.writeText(text);
      if (cut) cm.replaceSelection('');
    } catch (_) { Bob.toast(`Clipboard access was blocked. Use ${MOD}${cut ? 'X' : 'C'} instead.`, 'error'); }
    cm.focus();
    return undefined;
  }
  async function clipPaste() {
    try {
      const text = await navigator.clipboard.readText();
      cm.replaceSelection(text);
    } catch (_) { Bob.toast(`Clipboard access was blocked. Use ${MOD}V instead.`, 'error'); }
    cm.focus();
  }
  const runCM = (name) => () => { cm.focus(); if (cm.execCommand) cm.execCommand(name); };

  function setFont(px) {
    fontSize = Math.max(10, Math.min(24, px));
    const node = $('#panel-ide .CodeMirror') || $('#code-editor-canvas');
    if (node) node.style.fontSize = `${fontSize}px`;
    if (hasCM) cm.refresh();
  }

  function gotoLine(n) {
    if (!hasCM || !current) return;
    const line = Math.max(1, Math.min(cm.lineCount(), n | 0)) - 1;
    cm.setCursor({ line, ch: 0 });
    cm.scrollIntoView({ line, ch: 0 }, 120);
    cm.focus();
  }

  // ── selection info (shared by code actions, inline chat and the chat panel) ─
  function selectionInfo() {
    if (!current || !hasCM) return null;
    const sel = cm.somethingSelected();
    const from = sel ? cm.getCursor('from') : { line: cm.getCursor().line, ch: 0 };
    const to = sel ? cm.getCursor('to') : { line: from.line, ch: cm.getLine(from.line).length };
    const endLine = sel && to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    const text = sel ? cm.getSelection() : cm.getLine(from.line);
    return { file: current.name, startLine: from.line + 1, endLine: endLine + 1, text: text.slice(0, 4000), hasSelection: sel };
  }
  const refLabel = (s) => (s.startLine === s.endLine ? `@${s.file}:${s.startLine}` : `@${s.file}:${s.startLine}:${s.endLine}`);

  // ── Bob actions that start from the editor ─────────────────────────────────
  function addToContext() {
    const s = selectionInfo();
    if (!s) return Bob.toast('Open a file first.', 'info');
    Bob.chat.addContext({ label: refLabel(s), text: `--- ${refLabel(s)} ---\n${s.text}`, kind: 'selection' });
    Bob.toast(`Added ${refLabel(s)} to Bob's context.`, 'success');
    return undefined;
  }
  function moveToChat() {
    const s = selectionInfo();
    if (s) Bob.chat.addContext({ label: refLabel(s), text: `--- ${refLabel(s)} ---\n${s.text}`, kind: 'selection' });
    Bob.layout.show('secondary');
    Bob.chat.focus();
  }
  function bobAction(verb) {
    const s = selectionInfo();
    if (!s) return Bob.toast('Open a file first.', 'info');
    Bob.chat.addContext({ label: refLabel(s), text: `--- ${refLabel(s)} ---\n${s.text}`, kind: 'selection' });
    Bob.layout.show('secondary');
    Bob.chat.send(`${verb} ${refLabel(s)}`);
    return undefined;
  }

  // ── Inline Chat (Ctrl/Cmd+K) ────────────────────────────────────────────────
  function closeInline() {
    if (!inlineWidget) return;
    inlineWidget.handle.clear();
    inlineWidget = null;
  }
  function openInline() {
    const s = selectionInfo();
    if (!s) return Bob.toast('Open a file first.', 'info');
    closeInline();
    const input = el('input', { type: 'text', class: 'inline-chat-input', maxlength: 400, 'aria-label': 'Ask Bob about the selected code', placeholder: `Ask Bob about ${refLabel(s)}…`, autocomplete: 'off' });
    const answer = el('div', { class: 'inline-chat-answer', role: 'status', 'aria-live': 'polite', hidden: true });
    const send = el('button', { type: 'button', class: 'btn-small btn-small-primary' }, 'Ask');
    const move = el('button', { type: 'button', class: 'btn-small', onclick: () => { closeInline(); moveToChat(); } }, 'Move to chat');
    const box = el('div', { class: 'inline-chat', role: 'group', 'aria-label': 'Inline chat' },
      el('div', { class: 'inline-chat-row' }, el('span', { class: 'inline-chat-tag' }, '✨ Bob'), input, send,
        move, el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close inline chat', onclick: () => { closeInline(); cm.focus(); } }, '×')), answer);
    const handle = cm.addLineWidget(s.endLine - 1, box, { coverGutter: false, noHScroll: true });
    inlineWidget = { handle, box };
    async function ask() {
      const q = input.value.trim();
      if (!q) return;
      send.disabled = true; input.disabled = true;
      answer.hidden = false; answer.textContent = 'Thinking…';
      const reply = await Bob.chat.ask(`${q}\n\n--- ${refLabel(s)} ---\n${s.text}`, { label: `Inline: ${q}` });
      send.disabled = false; input.disabled = false;
      answer.textContent = reply === null ? 'Connect the gateway first (left panel).' : reply;
      handle.changed();
      input.focus();
    }
    send.addEventListener('click', ask);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ask(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeInline(); cm.focus(); }
    });
    setTimeout(() => input.focus(), 0);
    return undefined;
  }

  // ── Literate coding (Ctrl/Cmd+I) ────────────────────────────────────────────
  const instrRe = () => (current && current.language === 'python' ? /^\s*#\s?(.+)$/ : current && current.language === 'markdown' ? null : /^\s*\/\/\s?(.+)$/);
  let litTimer = null;
  const scheduleLitRefresh = () => { if (lit.on) { clearTimeout(litTimer); litTimer = setTimeout(refreshLitHighlights, 150); } };

  function refreshLitHighlights() {
    if (!hasCM) return;
    cm.operation(() => {
      for (let i = 0; i < cm.lineCount(); i++) { cm.removeLineClass(i, 'background', 'lit-instr'); cm.removeLineClass(i, 'text', 'lit-instr-text'); }
      const re = instrRe();
      if (!lit.on || !re) return;
      for (let i = 0; i < cm.lineCount(); i++) {
        const m = re.exec(cm.getLine(i));
        if (m && !/TODO\(bob\)/.test(m[1])) { cm.addLineClass(i, 'background', 'lit-instr'); cm.addLineClass(i, 'text', 'lit-instr-text'); }
      }
    });
  }

  function toggleLiterate() {
    if (lit.on) return exitLiterate(false);
    if (readOnly || !current) return Bob.toast('Open a file you can edit to use literate coding.', 'info');
    lit.on = true;
    $('#literate-bar').hidden = false;
    $('#btn-literate').setAttribute('aria-pressed', 'true');
    setLitUi();
    refreshLitHighlights();
    Bob.toast('Literate coding on. Write instructions as comments, then Generate.', 'info');
    return undefined;
  }
  function exitLiterate(quiet) {
    if (lit.pending) rejectLiterate(true);
    lit.on = false;
    $('#literate-bar').hidden = true;
    $('#btn-literate').setAttribute('aria-pressed', 'false');
    refreshLitHighlights();
    if (!quiet) Bob.toast('Literate coding off.', 'info');
  }
  function setLitUi() {
    const pending = !!lit.pending;
    $('#lit-generate').hidden = pending; $('#lit-accept').hidden = !pending; $('#lit-reject').hidden = !pending;
    $('#literate-msg').textContent = pending
      ? `${lit.pending.count} change(s) ready. Accept all (${MOD}Enter) or Reject (${MOD}Shift+Backspace).`
      : 'Instructions are highlighted in blue. Press Generate to draft code below them.';
  }

  const words = (s) => s.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 5);
  function stubFor(instr, lang) {
    const w = words(instr);
    const camel = w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join('') || 'generated';
    if (lang === 'python') return [`def ${w.map((x) => x.toLowerCase()).join('_') || 'generated'}():`, `    # TODO(bob): ${instr.slice(0, 80)}`, '    pass', ''];
    if (lang === 'java') return [`void ${camel}() {`, `  // TODO(bob): ${instr.slice(0, 80)}`, '}', ''];
    return [`function ${camel}() {`, `  // TODO(bob): ${instr.slice(0, 80)}`, '}', ''];
  }

  function generateLiterate() {
    const re = instrRe();
    if (!re) return Bob.toast('Literate coding needs a code file.', 'info');
    const before = cm.getValue();
    const range = cm.somethingSelected() ? [cm.getCursor('from').line, cm.getCursor('to').line] : [0, cm.lineCount() - 1];
    const jobs = [];
    for (let i = range[0]; i <= range[1]; i++) {
      const m = re.exec(cm.getLine(i));
      if (!m || /TODO\(bob\)/.test(m[1])) continue;
      const next = cm.getLine(i + 1) || '';
      if (/function \w+\(|def \w+\(|void \w+\(/.test(next)) continue;   // already has code directly below
      jobs.push({ line: i, lines: stubFor(m[1], current.language) });
    }
    if (!jobs.length) return Bob.toast('No new instructions found. Add a comment describing what you want.', 'info');
    let offset = 0; let count = 0; const added = [];
    cm.operation(() => {
      jobs.forEach((j) => {
        const at = j.line + 1 + offset;
        cm.replaceRange(`${j.lines.join('\n')}\n`, { line: at, ch: 0 });
        for (let k = 0; k < j.lines.length; k++) { cm.addLineClass(at + k, 'background', 'lit-added'); added.push(at + k); }
        offset += j.lines.length; count++;
      });
    });
    lit.pending = { before, count, added };
    setLitUi();
    Bob.toast('Draft generated as a local stub (no model is attached). Review the green lines.', 'info');
    return undefined;
  }
  function clearAdded() { if (lit.pending) cm.operation(() => lit.pending.added.forEach((l) => cm.removeLineClass(l, 'background', 'lit-added'))); }
  function acceptLiterate() {
    if (!lit.pending) return;
    clearAdded(); lit.pending = null; setLitUi(); refreshLitHighlights();
    Bob.toast('Changes accepted. Remember to save.', 'success');
  }
  function rejectLiterate(quiet) {
    if (!lit.pending) return;
    const { before } = lit.pending;
    clearAdded(); lit.pending = null;
    const last = cm.lastLine();
    cm.replaceRange(before, { line: 0, ch: 0 }, { line: last, ch: cm.getLine(last).length });
    setLitUi(); refreshLitHighlights();
    if (!quiet) Bob.toast('Changes rejected.', 'info');
  }

  // ── Findings / Bob tips ────────────────────────────────────────────────────
  function clearTips() { tipMarks.forEach((m) => m.clear()); tipMarks = []; }
  // Settings > Findings can switch the purple "Bob tip" underlines off (problems stay visible).
  const tipsEnabled = () => localStorage.getItem('bob_tips') !== 'off';
  function applyTips() {
    clearTips();
    if (!hasCM || !current) return;
    cm.operation(() => {
      findings.filter((f) => f.file === current.name && f.line <= cm.lineCount() && (f.kind !== 'tip' || tipsEnabled())).forEach((f) => {
        const text = cm.getLine(f.line - 1);
        if (!text) return;
        const cls = f.kind === 'tip' ? 'bob-tip' : `bob-problem bob-problem-${f.severity}`;
        tipMarks.push(cm.markText({ line: f.line - 1, ch: 0 }, { line: f.line - 1, ch: text.length }, { className: cls, attributes: { 'data-msg': f.message, 'data-kind': f.kind, 'data-line': String(f.line) } }));
      });
    });
  }
  async function loadFindings() {
    if (!Bob.can('ide:read')) return;
    try { findings = (await Bob.api('/bob/findings')).findings; } catch (_) { return; }
    Bob.emit('findings', findings);
    applyTips();
  }

  // Hover card for a tip: message + "Fix with Bob".
  let tipCard = null; let tipHideTimer = null;
  function hideTipCard() { if (tipCard) { tipCard.remove(); tipCard = null; } }
  function showTipCard(target) {
    clearTimeout(tipHideTimer);
    hideTipCard();
    const msg = target.getAttribute('data-msg'); if (!msg) return;
    const kind = target.getAttribute('data-kind'); const line = Number(target.getAttribute('data-line'));
    const r = target.getBoundingClientRect();
    const card = el('div', { class: 'tip-card', role: 'dialog', 'aria-label': 'Bob tip' },
      el('div', { class: 'tip-title' }, kind === 'tip' ? '💜 Bob tip' : '⚠ Problem'), el('div', null, msg),
      el('button', { type: 'button', class: 'btn-small btn-small-primary', disabled: readOnly && false, onclick: () => { hideTipCard(); fixWithBob(line, msg); } }, 'Fix with Bob'));
    card.addEventListener('mouseenter', () => clearTimeout(tipHideTimer));
    card.addEventListener('mouseleave', () => { tipHideTimer = setTimeout(hideTipCard, 250); });
    document.body.append(card);
    const cr = card.getBoundingClientRect();
    card.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - cr.width - 8))}px`;
    card.style.top = `${r.bottom + 4 + cr.height > window.innerHeight ? Math.max(4, r.top - cr.height - 4) : r.bottom + 4}px`;
    tipCard = card;
  }
  function fixWithBob(line, msg) {
    if (!current) return;
    const text = cm.getLine(line - 1) || '';
    Bob.chat.addContext({ label: `@${current.name}:${line}`, text: `--- @${current.name}:${line} ---\n${text}`, kind: 'selection' });
    Bob.layout.show('secondary');
    Bob.chat.send(`Fix with Bob: ${msg} (@${current.name}:${line})`);
  }

  // ── lightbulb (code actions) ───────────────────────────────────────────────
  let bulb = null; let bulbTimer = null;
  function hideBulb() { if (bulb) bulb.hidden = true; }
  function onCursor() {
    const c = cm.getCursor();
    Bob.emit('cursor', { line: c.line + 1, col: c.ch + 1, selected: cm.somethingSelected() ? cm.getSelection().length : 0 });
    clearTimeout(bulbTimer);
    bulbTimer = setTimeout(() => {
      if (!current || !cm.hasFocus() || !bulb) return hideBulb();
      const onTip = findings.some((f) => f.file === current.name && f.line === c.line + 1);
      if (!cm.somethingSelected() && !onTip) return hideBulb();
      const wrap = cm.getWrapperElement().parentElement.getBoundingClientRect();
      const pt = cm.cursorCoords(cm.getCursor('head'), 'window');
      bulb.style.top = `${Math.max(0, pt.top - wrap.top)}px`;
      bulb.hidden = false;
      return undefined;
    }, 100);
  }

  function codeActionItems() {
    const s = selectionInfo();
    const tip = s && findings.find((f) => f.file === s.file && f.line >= s.startLine && f.line <= s.endLine);
    return [
      { cmd: 'bob.addToContext' }, { cmd: 'bob.inlineChat' }, { cmd: 'bob.moveToChat' }, { sep: true },
      { cmd: 'bob.explain' }, { cmd: 'bob.fix' }, { cmd: 'bob.improve' },
      ...(tip ? [{ sep: true }, { label: `Fix with Bob: ${tip.rule}`, run: () => fixWithBob(tip.line, tip.message) }] : [])
    ];
  }
  function openCodeActions() {
    if (!current) return Bob.toast('Open a file first.', 'info');
    const pt = cm.cursorCoords(cm.getCursor('head'), 'window');
    Bob.contextMenu(codeActionItems(), pt.left + 6, pt.bottom + 2, { label: 'Code actions', restoreFocus: cm.getInputField() });
    return undefined;
  }

  function editorContextItems() {
    return [
      { cmd: 'edit.cut' }, { cmd: 'edit.copy' }, { cmd: 'edit.paste' }, { sep: true },
      { cmd: 'edit.selectAll' }, { sep: true },
      { label: 'Bob', items: codeActionItems },
      { sep: true }, { cmd: 'edit.comment' }, { cmd: 'file.save' }
    ];
  }

  // ── command registry ───────────────────────────────────────────────────────
  cmds.register([
    // File
    { id: 'file.new', title: 'New File…', category: 'File', keys: ['Alt+N'], run: newFile, enabled: canEdit },
    { id: 'file.save', title: 'Save', category: 'File', keys: ['Mod+S'], run: save, enabled: () => canEdit() && hasFile(), when: ideVisible },
    { id: 'file.saveAll', title: 'Save All', category: 'File', keys: ['Mod+Alt+S'], run: saveAll, enabled: () => canEdit() && dirtyTabs().length > 0 },
    { id: 'file.rename', title: 'Rename…', category: 'File', run: () => renameFile(), enabled: () => canEdit() && hasFile() },
    { id: 'file.download', title: 'Download', category: 'File', run: () => downloadFile(), enabled: hasFile },
    { id: 'file.close', title: 'Close Editor', category: 'File', keys: ['Alt+W'], run: () => closeTab(current), enabled: hasFile, when: ideVisible },
    { id: 'file.closeAll', title: 'Close All Editors', category: 'File', run: async () => { for (const t of [...tabs]) { if (!(await closeTab(t))) break; } }, enabled: () => tabs.length > 0 },
    { id: 'file.delete', title: 'Delete File…', category: 'File', run: () => deleteFile(), enabled: () => canEdit() && hasFile() },
    { id: 'editor.next', title: 'Next Editor', category: 'View', keys: ['Mod+Alt+Right'], run: () => { const i = tabs.indexOf(current); activateTab(tabs[(i + 1) % tabs.length]); }, enabled: () => tabs.length > 1, when: ideVisible },
    { id: 'editor.prev', title: 'Previous Editor', category: 'View', keys: ['Mod+Alt+Left'], run: () => { const i = tabs.indexOf(current); activateTab(tabs[(i - 1 + tabs.length) % tabs.length]); }, enabled: () => tabs.length > 1, when: ideVisible },
    // Edit (shortcuts are handled natively by CodeMirror; `hint` is display-only)
    { id: 'edit.undo', title: 'Undo', category: 'Edit', hint: 'Mod+Z', run: () => { cm.focus(); cm.undo(); }, enabled: () => canEdit() && hasCM && hasFile() && cm.historySize().undo > 0 },
    { id: 'edit.redo', title: 'Redo', category: 'Edit', hint: Bob.isMac ? 'Mod+Shift+Z' : 'Mod+Y', run: () => { cm.focus(); cm.redo(); }, enabled: () => canEdit() && hasCM && hasFile() && cm.historySize().redo > 0 },
    { id: 'edit.cut', title: 'Cut', category: 'Edit', hint: 'Mod+X', run: () => clipCopy(true), enabled: () => canEdit() && !!cm.getSelection() },
    { id: 'edit.copy', title: 'Copy', category: 'Edit', hint: 'Mod+C', run: () => clipCopy(false), enabled: () => !!cm.getSelection() },
    { id: 'edit.paste', title: 'Paste', category: 'Edit', hint: 'Mod+V', run: clipPaste, enabled: () => canEdit() && hasFile() },
    { id: 'edit.selectAll', title: 'Select All', category: 'Edit', hint: 'Mod+A', run: runCM('selectAll'), enabled: () => hasCM && hasFile() },
    { id: 'edit.find', title: 'Find…', category: 'Edit', hint: 'Mod+F', run: runCM('find'), enabled: () => hasCM && hasFile() },
    { id: 'edit.findNext', title: 'Find Next', category: 'Edit', hint: 'Mod+G', run: runCM('findNext'), enabled: () => hasCM && hasFile() },
    { id: 'edit.replace', title: 'Replace…', category: 'Edit', hint: 'Mod+H', run: runCM('replace'), enabled: () => canEdit() && hasCM && hasFile() },
    { id: 'edit.comment', title: 'Toggle Line Comment', category: 'Edit', hint: 'Mod+/', run: () => { cm.focus(); cm.toggleComment(); }, enabled: () => canEdit() && hasCM && hasFile() },
    {
      id: 'edit.gotoLine', title: 'Go to Line…', category: 'Edit', enabled: () => hasCM && hasFile(),
      run: async () => { const v = await Bob.prompt({ title: 'Go to line', label: 'Line number', value: '1', validate: (x) => (/^\d{1,6}$/.test(x) ? '' : 'Enter a positive number.') }); if (v) gotoLine(Number(v)); }
    },
    // View
    { id: 'view.wrap', title: 'Toggle Line Wrapping', category: 'View', run: () => cm.setOption('lineWrapping', !cm.getOption('lineWrapping')), enabled: () => hasCM },
    { id: 'view.fontUp', title: 'Increase Font Size', category: 'View', run: () => setFont(fontSize + 1), enabled: () => fontSize < 24 },
    { id: 'view.fontDown', title: 'Decrease Font Size', category: 'View', run: () => setFont(fontSize - 1), enabled: () => fontSize > 10 },
    // Run
    { id: 'run.code', title: 'Run Code Script', category: 'Run', run: () => $('#btn-run-code').click() },
    { id: 'run.clear', title: 'Clear Output', category: 'Run', run: () => $('#btn-clear-console').click() },
    // Bob editor actions (documented: Inline Chat Ctrl+K, Move to chat Ctrl+L, Literate Ctrl+I, Code actions Ctrl+.)
    { id: 'bob.codeActions', title: 'Code Actions…', category: 'Bob', keys: ['Mod+.'], run: openCodeActions, enabled: () => hasFile() && hasCM, when: () => ideVisible() && editorFocused() },
    { id: 'bob.addToContext', title: 'Add to Context', category: 'Bob', run: addToContext, enabled: () => hasFile() && hasCM },
    { id: 'bob.inlineChat', title: 'Inline Chat', category: 'Bob', keys: ['Mod+K'], run: openInline, enabled: () => hasFile() && hasCM, when: ideVisible },
    { id: 'bob.moveToChat', title: 'Move to Chat', category: 'Bob', keys: ['Mod+L'], run: moveToChat, enabled: () => true },
    { id: 'bob.explain', title: 'Explain Code', category: 'Bob', run: () => bobAction('Explain'), enabled: () => hasFile() && hasCM },
    { id: 'bob.fix', title: 'Fix Code', category: 'Bob', run: () => bobAction('Fix'), enabled: () => hasFile() && hasCM },
    { id: 'bob.improve', title: 'Improve Code', category: 'Bob', run: () => bobAction('Improve'), enabled: () => hasFile() && hasCM },
    { id: 'bob.literate', title: 'Toggle Literate Coding', category: 'Bob', keys: ['Mod+I'], run: toggleLiterate, enabled: () => canEdit() && hasFile() && hasCM, when: ideVisible },
    { id: 'bob.literateAccept', title: 'Literate: Accept All', category: 'Bob', keys: ['Mod+Enter'], run: acceptLiterate, enabled: () => !!lit.pending, when: () => !!lit.pending, hidden: true },
    { id: 'bob.literateReject', title: 'Literate: Reject', category: 'Bob', keys: ['Mod+Shift+Backspace'], run: () => rejectLiterate(false), enabled: () => !!lit.pending, when: () => !!lit.pending, hidden: true },
    { id: 'menu.focus', title: 'Focus Menu Bar', category: 'View', keys: ['F10'], run: () => { if (menus[0]) { menus[0].btn.focus(); } }, global: false, hidden: true, when: ideVisible }
  ]);

  // ── menubar definition ─────────────────────────────────────────────────────
  const checked = (key) => () => (Bob.layout ? Bob.layout.is(key) : true);
  const MENU_DEFS = [
    { label: 'File', items: () => [{ cmd: 'file.new' }, { cmd: 'file.save' }, { cmd: 'file.saveAll' }, { cmd: 'file.rename' }, { cmd: 'file.download' }, { cmd: 'file.close' }, { sep: true }, { cmd: 'file.delete' }] },
    // ★ THE EDIT MENU - this is the option that was missing.
    { label: 'Edit', items: () => [{ cmd: 'edit.undo' }, { cmd: 'edit.redo' }, { sep: true }, { cmd: 'edit.cut' }, { cmd: 'edit.copy' }, { cmd: 'edit.paste' }, { cmd: 'edit.selectAll' }, { sep: true }, { cmd: 'edit.find' }, { cmd: 'edit.findNext' }, { cmd: 'edit.replace' }, { sep: true }, { cmd: 'edit.comment' }, { cmd: 'edit.gotoLine' }] },
    {
      label: 'View', items: () => [
        { label: 'Command Palette…', cmd: 'palette.open' },
        {
          label: 'Appearance', items: () => [
            { label: 'Secondary Side Bar (Bob)', cmd: 'view.secondary', checked: checked('secondary') },
            { label: 'Primary Side Bar', cmd: 'view.config', checked: checked('config') },
            { label: 'Activity Bar', cmd: 'view.activity', checked: checked('activity') },
            { label: 'Panel', cmd: 'view.panel', checked: checked('panel') },
            { label: 'Status Bar', cmd: 'view.status', checked: checked('status') }
          ]
        },
        { sep: true }, { cmd: 'view.wrap' }, { cmd: 'view.fontUp' }, { cmd: 'view.fontDown' }, { sep: true },
        { cmd: 'view.resetLayout' }
      ]
    },
    { label: 'Run', items: () => [{ cmd: 'run.code' }, { cmd: 'run.clear' }] },
    { label: 'Terminal', items: () => [{ cmd: 'term.open' }, { cmd: 'term.clear' }, { cmd: 'view.panel' }] },
    {
      label: 'Bob', items: () => [
        { cmd: 'bob.newTask' }, { cmd: 'bob.history' }, { cmd: 'bob.openChat' }, { sep: true },
        { cmd: 'bob.inlineChat' }, { cmd: 'bob.moveToChat' }, { cmd: 'bob.addToContext' }, { cmd: 'bob.literate' }, { cmd: 'bob.codeActions' }, { sep: true },
        { cmd: 'bob.cycleMode' }, { cmd: 'bob.review' }, { cmd: 'bob.init' }, { cmd: 'bob.checkpoint' }, { cmd: 'bob.checkpoints' }, { sep: true },
        { cmd: 'bob.settings' }
      ]
    },
    { label: 'Help', items: () => [{ cmd: 'help.directory' }, { cmd: 'help.shortcuts' }, { cmd: 'help.about' }] }
  ];

  // ── menubar rendering + keyboard model (WAI-ARIA menubar pattern) ──────────
  function buildMenubar() {
    const bar = clear($('#ide-menubar'));
    menus = MENU_DEFS.map((m, mi) => {
      const btnId = `ide-menu-btn-${mi}`;
      const btn = el('button', {
        type: 'button', id: btnId, role: 'menuitem', class: 'menu-top',
        'aria-haspopup': 'true', 'aria-expanded': 'false', tabindex: mi === 0 ? '0' : '-1'
      }, m.label);
      const ml = Bob.menuList(m.items, {
        labelledby: btnId, depth: 0,
        onDone: (ret) => closeMenus(ret),
        onEdgeKey: (e) => {
          if (e.key === 'ArrowRight') moveTop(mi, 1);
          else if (e.key === 'ArrowLeft') moveTop(mi, -1);
          else if (e.key === 'Escape') closeMenus(true);
          else if (e.key === 'Tab') closeMenus(false);
        }
      });
      ml.ul.hidden = true;
      btn.addEventListener('click', () => (openIdx === mi ? closeMenus(true) : openMenu(mi, false)));
      btn.addEventListener('mouseenter', () => { if (openIdx >= 0 && openIdx !== mi) openMenu(mi, false); });
      btn.addEventListener('keydown', (e) => topKey(e, mi));
      bar.append(el('div', { class: 'menu-wrap' }, btn, ml.ul));
      return { label: m.label, btn, ml };
    });
  }

  /** Re-evaluates enabled/checked state for every menu (called when permissions or the layout change). */
  function refreshMenus() { menus.forEach((m) => m.ml.refresh()); }

  function openMenu(mi, focusFirst) {
    closeMenus(false);
    const m = menus[mi];
    m.ml.refresh();
    m.ml.ul.hidden = false;
    m.btn.setAttribute('aria-expanded', 'true');
    openIdx = mi;
    if (focusFirst) m.ml.focusFirst();
  }
  function closeMenus(returnFocus) {
    if (openIdx < 0) return;
    const m = menus[openIdx];
    m.ml.ul.hidden = true;
    m.btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) m.btn.focus();
    openIdx = -1;
  }
  function moveTop(from, delta) {
    const n = (from + delta + menus.length) % menus.length;
    menus.forEach((m, i) => { m.btn.tabIndex = i === n ? 0 : -1; });
    if (openIdx >= 0) openMenu(n, true); else menus[n].btn.focus();
  }
  function topKey(e, mi) {
    if (e.key === 'ArrowRight') { e.preventDefault(); moveTop(mi, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveTop(mi, -1); }
    else if (['ArrowDown', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openMenu(mi, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(mi, false); menus[mi].ml.focusLast(); }
    else if (e.key === 'Escape') closeMenus(true);
  }

  // ── editor tabs ────────────────────────────────────────────────────────────
  function tabMenuItems(tab) {
    return [
      { label: 'Close', run: () => closeTab(tab) },
      { label: 'Close Others', run: async () => { for (const t of tabs.filter((x) => x !== tab)) { if (!(await closeTab(t))) break; } }, enabled: () => tabs.length > 1 },
      { label: 'Close All', cmd: 'file.closeAll' }, { sep: true },
      { label: 'Save', run: () => saveTab(tab), enabled: () => canEdit() && tab.dirty },
      { label: 'Rename…', run: () => renameFile(tab.name), enabled: canEdit },
      { label: 'Copy File Name', run: () => navigator.clipboard.writeText(tab.name).then(() => Bob.toast('Copied.', 'info'), () => Bob.toast('Clipboard access was blocked.', 'error')) },
      { label: 'Add File to Bob Context', run: () => addFileContext(tab.name) }
    ];
  }

  let dragName = null;
  function renderTabs() {
    const strip = clear($('#editor-tabs'));
    strip.hidden = tabs.length === 0;
    tabs.forEach((t, i) => {
      const active = t === current;
      const main = el('button', {
        type: 'button', role: 'tab', id: `etab-${i}`, class: 'etab-main', 'aria-selected': String(active), tabindex: active ? '0' : '-1',
        title: t.name
      }, t.name, t.dirty ? el('span', { class: 'etab-dot', 'aria-label': 'unsaved changes' }, ' ●') : null);
      const close = el('button', { type: 'button', class: 'etab-close', 'aria-label': `Close ${t.name}`, tabindex: '-1', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, '×');
      const wrap = el('div', { class: `etab${active ? ' active' : ''}`, role: 'presentation', draggable: 'true' }, main, close);
      main.addEventListener('click', () => activateTab(t));
      wrap.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
      wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); Bob.contextMenu(tabMenuItems(t), e.clientX, e.clientY, { restoreFocus: main }); });
      main.addEventListener('keydown', (e) => {
        const focusAt = (n) => { const b = strip.querySelectorAll('.etab-main')[n]; if (b) b.focus(); };
        if (e.ctrlKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault(); moveTab(i, i + (e.key === 'ArrowLeft' ? -1 : 1), true);
        } else if (e.key === 'ArrowRight') { e.preventDefault(); focusAt((i + 1) % tabs.length); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt((i - 1 + tabs.length) % tabs.length); }
        else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
        else if (e.key === 'End') { e.preventDefault(); focusAt(tabs.length - 1); }
        else if (e.key === 'Delete') { e.preventDefault(); closeTab(t); }
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); Bob.contextMenuAt(tabMenuItems(t), main, { restoreFocus: main }); }
      });
      // Drag to reorder (also carries the file name so it can be dropped into the chat).
      wrap.addEventListener('dragstart', (e) => { dragName = t.name; e.dataTransfer.setData('text/bob-file', t.name); e.dataTransfer.setData('text/plain', t.name); e.dataTransfer.effectAllowed = 'copyMove'; wrap.classList.add('dragging'); });
      wrap.addEventListener('dragend', () => { dragName = null; wrap.classList.remove('dragging'); strip.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over')); });
      wrap.addEventListener('dragover', (e) => { if (dragName && dragName !== t.name) { e.preventDefault(); wrap.classList.add('drag-over'); } });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
      wrap.addEventListener('drop', (e) => {
        e.preventDefault(); wrap.classList.remove('drag-over');
        const from = tabs.findIndex((x) => x.name === dragName);
        if (from >= 0 && from !== i) moveTab(from, i, false);
      });
      strip.append(wrap);
    });
    const a = strip.querySelector('.etab.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function moveTab(from, to, keepFocus) {
    if (to < 0 || to >= tabs.length || from === to) return;
    const [t] = tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    renderTabs(); persistTabs();
    if (keepFocus) { const b = $('#editor-tabs').querySelectorAll('.etab-main')[to]; if (b) b.focus(); }
  }

  // ── explorer ───────────────────────────────────────────────────────────────
  function addFileContext(name) {
    Bob.chat.addContext({ label: `@/${name}`, file: name, kind: 'file' });
    Bob.layout.show('secondary');
    Bob.toast(`Added @/${name} to Bob's context.`, 'success');
  }
  function fileMenuItems(name) {
    return [
      { label: 'Open', run: () => openFile(name) },
      { label: 'Rename…', run: () => renameFile(name), enabled: canEdit },
      { label: 'Download', run: () => downloadFile(name) },
      { label: 'Add to Bob Context', run: () => addFileContext(name) },
      { label: 'Copy File Name', run: () => navigator.clipboard.writeText(name).then(() => Bob.toast('Copied.', 'info'), () => Bob.toast('Clipboard access was blocked.', 'error')) },
      { sep: true },
      { label: 'Delete…', run: () => deleteFile(name), enabled: canEdit }
    ];
  }
  function renderExplorer() {
    // #ide-file-list was removed when the File Explorer bar was removed from the UI.
    // Guard against null so callers (applyPermissions, refreshFiles, openFile, etc.)
    // do not throw and abort the init sequence.
    const ul = $('#ide-file-list');
    if (!ul) return;
    clear(ul);
    if (!files.length) { ul.append(el('li', { class: 'hint empty-hint' }, Bob.can('ide:read') ? 'No files yet. Use ＋ to create one.' : 'No access')); return; }
    files.forEach((f) => {
      const tab = tabs.find((t) => t.name === f.name);
      const active = current && current.name === f.name;
      const btn = el('button', {
        type: 'button', class: `file-item${active ? ' active' : ''}`, 'aria-current': active ? 'true' : null, draggable: 'true',
        title: `${f.name} (${f.size} bytes)`, 'data-name': f.name
      }, f.name, tab && tab.dirty ? el('span', { class: 'etab-dot' }, ' ●') : null);
      btn.addEventListener('click', () => openFile(f.name));
      btn.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bob-file', f.name); e.dataTransfer.setData('text/plain', `@/${f.name}`); e.dataTransfer.effectAllowed = 'copy'; });
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); Bob.contextMenu(fileMenuItems(f.name), e.clientX, e.clientY, { restoreFocus: btn }); });
      btn.addEventListener('keydown', (e) => {
        const all = [...ul.querySelectorAll('.file-item')]; const i = all.indexOf(btn);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); (all[i + 1] || all[0]).focus(); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); (all[i - 1] || all[all.length - 1]).focus(); }
        else if (e.key === 'F2' && canEdit()) { e.preventDefault(); renameFile(f.name); }
        else if (e.key === 'Delete' && canEdit()) { e.preventDefault(); deleteFile(f.name); }
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); Bob.contextMenuAt(fileMenuItems(f.name), btn, { restoreFocus: btn }); }
      });
      ul.append(el('li', null, btn));
    });
  }

  /** Re-reads every unmodified open tab from the server (used after a checkpoint restore). */
  async function reloadClean() {
    await refreshFiles({ silent: true });
    for (const t of tabs.filter((x) => !x.dirty)) {
      try {
        const { file } = await Bob.api(`/files/${encodeURIComponent(t.name)}`);
        const isCur = t === current;
        if (hasCM) {
          if (isCur) loading = true;
          t.doc.setValue(file.content); t.doc.clearHistory();
          if (isCur) loading = false;
        } else {
          t.content = file.content;
          if (isCur) { loading = true; cm.setValue(file.content); loading = false; }
        }
      } catch (_) { loading = false; }
    }
    applyTips();
  }

  // ── public API ─────────────────────────────────────────────────────────────
  Bob.ide = {
    reloadClean, applyTips,
    getCode: () => (cm ? cm.getValue().trim() : ''),
    getFileName: () => (current ? current.name : ''),
    refresh: refreshFiles,
    isDirty: () => dirtyTabs().length > 0,
    focus: () => cm && cm.focus(),
    refreshLayout: () => { if (hasCM && cm) cm.refresh(); },
    openFile, gotoLine, saveAll, selectionInfo, loadFindings,
    getFindings: () => findings,
    listFiles: () => files.map((f) => f.name),
    hasEditorFocus: editorFocused,
    closeMenus: () => closeMenus(false),
    refreshMenus,
    /** Replaces the current selection (or inserts at the cursor) - used by chat "apply to editor". */
    insertText(text) { if (current && !readOnly) { cm.replaceSelection(text); cm.focus(); } },
    init() {
      // Empty-state overlay shown when no file is open.
      const wrapper = $('.code-editor-viewport-wrapper');
      wrapper.append(el('div', { id: 'editor-empty', class: 'editor-empty' }, 'No file open', el('small', null, 'Pick a file in the explorer, or press Alt+N to create one.')));
      createEditor();
      // Lightbulb button lives inside the editor wrapper so it follows the layout.
      bulb = el('button', { type: 'button', class: 'lightbulb', hidden: true, 'aria-label': 'Show code actions', 'data-tip': `Code actions (${MOD}.)` }, '💡');
      bulb.addEventListener('mousedown', (e) => e.preventDefault());   // keep the selection and editor focus
      bulb.addEventListener('click', openCodeActions);
      wrapper.append(bulb);

      buildMenubar();

      // Close menus on outside click.
      document.addEventListener('mousedown', (e) => { if (openIdx >= 0 && !e.target.closest('.menu-wrap')) closeMenus(false); });

      // Language dropdown: switches syntax highlighting and marks the file as modified.
      $('#ide-lang-select').addEventListener('change', (e) => {
        if (readOnly || !current) { applyMode(current ? current.language : 'javascript'); return; }
        current.language = e.target.value;
        applyMode(e.target.value);
        current.dirty = true; showDirty(); renderTabs(); refreshLitHighlights();
      });

      // Explorer header buttons + empty-area context menu + OS file drop.
      const bnew = $('#btn-explorer-new'); if (bnew) bnew.addEventListener('click', () => cmds.run('file.new'));
      const bref = $('#btn-explorer-refresh'); if (bref) bref.addEventListener('click', () => { refreshFiles({ silent: true }).then(() => Bob.toast('Explorer refreshed.', 'info')); });
      const exp = $('#ide-explorer');
      if (exp) {
        exp.addEventListener('contextmenu', (e) => { if (e.target.closest('.file-item')) return; e.preventDefault(); Bob.contextMenu([{ cmd: 'file.new' }, { label: 'Refresh', run: () => bref && bref.click() }], e.clientX, e.clientY); });
        exp.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); exp.classList.add('drop-target'); } });
        exp.addEventListener('dragleave', () => exp.classList.remove('drop-target'));
        exp.addEventListener('drop', (e) => { exp.classList.remove('drop-target'); if (e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); } });
      }

      // Editor context menu (right-click or the Menu key).
      cm.getWrapperElement().addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!current) return;
        let x = e.clientX; let y = e.clientY;
        if (!x && !y && hasCM) { const p = cm.cursorCoords(null, 'window'); x = p.left; y = p.bottom; }
        Bob.contextMenu(editorContextItems(), x, y, { restoreFocus: cm.getInputField(), label: 'Editor context menu' });
      });
      // Tip hover card (delegated from the editor).
      cm.getWrapperElement().addEventListener('mouseover', (e) => { const t = e.target.closest && e.target.closest('.bob-tip, .bob-problem'); if (t) showTipCard(t); });
      cm.getWrapperElement().addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('.bob-tip, .bob-problem')) tipHideTimer = setTimeout(hideTipCard, 300); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTipCard(); }, true);

      // Literate coding toolbar.
      $('#btn-literate').addEventListener('click', toggleLiterate);
      $('#lit-generate').addEventListener('click', generateLiterate);
      $('#lit-accept').addEventListener('click', acceptLiterate);
      $('#lit-reject').addEventListener('click', () => rejectLiterate(false));
      $('#lit-exit').addEventListener('click', () => exitLiterate(false));

      // Keep unsaved work safe.
      window.addEventListener('beforeunload', (e) => { if (dirtyTabs().length) { e.preventDefault(); e.returnValue = ''; } });

      Bob.on('session', applyPermissions);
      Bob.on('layout', refreshMenus);
      Bob.on('tab', (name) => { if (name === 'ide') Bob.ide.refreshLayout(); });
      applyPermissions();
      showCurrentName();
    }
  };
})();
