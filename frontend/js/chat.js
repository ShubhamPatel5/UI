/**
 * NEW (Bob IDE parity): Bob chat panel (js/chat.js)
 *
 * Moved here from app.js and extended. PRESERVED behaviour: tool buttons, Documentation / Agent buttons, Clear All,
 * recent-task cards, same /api/chat endpoint, the original labels and CSS classes.
 *
 *  - Header: mode selector (built-in + custom modes), New task, Task history, Settings gear.
 *  - Context-window meter (200k tokens, 50k reserved).
 *  - Messages: Copy, click-to-expand/collapse, Rollback to a prompt, clickable file paths / https links,
 *    code blocks with Copy, large output collapsed.
 *  - Input: Enter sends, Shift+Enter = newline, big pasted text becomes a context pill, files can be dropped in.
 *  - Slash commands with fuzzy search and argument hints: modes, /help /clear /review /init /newtask /history
 *    /settings /run <cmd> and custom commands saved on the server ($1, $2 placeholders).
 *  - @ mentions: @/file @terminal @problems @issues @git-changes @<checkpoint id> @https://url
 *  - Approval cards (one at a time, editable command) honouring the auto-approve settings; task-level override.
 *  - Rules: global rules load first, workspace rules after; rules and custom-mode instructions travel in the
 *    separate "context" field of /api/chat.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;
  const cmds = Bob.commands;

  const BUILTIN_MODES = { agent: 'Agent', code: 'Code', plan: 'Plan', orchestrator: 'Orchestrator' };
  const CTX_MAX = 200000;
  const CTX_RESERVED = 50000;
  const COLLAPSE_LINES = 14;
  const COLLAPSE_CHARS = 1200;
  const LABELS = { user: 'User Input', bob: 'IBM BOB Agent', system: 'System Shell Trace' };

  // Actions and risk levels follow the IBM Bob "Auto-approve" documentation. Defaults are all OFF (manual approval).
  const AUTO_APPROVE = [
    ['read', 'Read', 'Medium', 'View files and directory content.'],
    ['edit', 'Edit', 'High', 'Create, edit and save files.'],
    ['execute', 'Execute', 'High', 'Run terminal commands.'],
    ['mcp', 'MCP', 'Medium-High', 'Use configured MCP servers.'],
    ['skill', 'Skill', 'Medium', 'Activate defined skills.'],
    ['todo', 'Todo', 'Low', 'Update the todo list.'],
    ['subtask', 'Subtask', 'Low', 'Create and complete subtasks.'],
    ['subagent', 'Subagent', 'Low', 'Spawn subagents for focused tasks.'],
    ['mode', 'Mode', 'Low', 'Switch modes to complete a task.']
  ];
  const riskOf = (type) => (AUTO_APPROVE.find((a) => a[0] === type) || [])[2] || 'Low';
  const labelOf = (type) => (AUTO_APPROVE.find((a) => a[0] === type) || [])[1] || type;
  const readApprovals = () => { try { return JSON.parse(localStorage.getItem('bob_auto_approve') || '{}') || {}; } catch (_) { return {}; } };

  let modes = { ...BUILTIN_MODES };   // slug -> display name (built-in + custom)
  let customModes = []; let customCmds = []; let rules = [];
  let entries = [];                   // [{m, block, body, toggle, collapsed}]
  let task = null;                    // {id} once the first prompt of a conversation was sent
  let taskPromise = null;
  let pills = [];                     // attached context: {label, text?, file?, kind}
  let taskApprove = {};               // task-level auto-approve overrides
  let openApprovals = [];             // resolvers of cards currently on screen
  let approvalChain = Promise.resolve();
  let suggestions = []; let suggestIdx = -1; let suggestKind = null;
  let saveTimer = null; let sending = false;

  const dom = {};
  const isConn = () => (Bob.isConnected ? Bob.isConnected() : false);

  // FIX: throttle the "Connect Gateway first" toast so rapid button clicks before
  // the gateway is connected don't stack unlimited identical error toasts.
  let _connToast = null;
  const requireConn = () => {
    if (!isConn()) {
      if (!_connToast || !document.body.contains(_connToast)) {
        _connToast = Bob.toast('Please click "Connect Gateway" first.', 'error');
      }
      return false;
    }
    return true;
  };
  const curMode = () => (dom.mode ? dom.mode.value : 'agent');
  const modeName = (slug) => modes[slug] || slug;
  const tokensOf = (s) => Math.ceil((s || '').length / 4);
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

  // ── context meter (change #4: token % = used / CTX_MAX clamped 0-100; battery badge wired here) ──
  function updateMeter() {
    const used = entries.reduce((n, e) => n + tokensOf(e.m.text), 0) + pills.reduce((n, p) => n + tokensOf(p.text || ''), 0);
    // Guard against CTX_MAX being 0 (should never happen but prevents division-by-zero).
    const pct = CTX_MAX > 0 ? Math.min(100, Math.max(0, Math.round((used / CTX_MAX) * 100))) : 0;
    const ctxLabel = $('#ctx-label');
    if (ctxLabel) ctxLabel.textContent = `${fmtK(used)} / 200k tokens`;
    const ctxFill = $('#ctx-fill');
    if (ctxFill) ctxFill.style.width = `${pct}%`;
    const meter = $('#ctx-meter');
    if (meter) {
      meter.setAttribute('aria-valuenow', String(used));
      meter.setAttribute('aria-valuetext', `${used.toLocaleString()} of ${CTX_MAX.toLocaleString()} tokens used, ${CTX_RESERVED.toLocaleString()} reserved`);
      meter.classList.toggle('warn', used > CTX_MAX - CTX_RESERVED);
    }
    // CHANGE #4: battery badge now reflects real token % (hard-coded "98%" removed from HTML).
    const batteryPct = document.getElementById('bob-battery-pct');
    if (batteryPct) batteryPct.textContent = `${pct}%`;
    // Broadcast token usage so any sidebar listener can react without coupling to this function.
    Bob.emit('tokens', { used, pct });
    return used;
  }

  // ── message rendering (DOM builder only: model/user text can never inject markup) ──
  function linkify(text, into) {
    const files = new Set(Bob.ide ? Bob.ide.listFiles() : []);
    const re = /(https:\/\/[^\s<>"')]+)|(@?\/?[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:js|py|java|md)(?::\d+(?::\d+)?)?)/g;
    let last = 0; let m;
    while ((m = re.exec(text))) {
      into.append(text.slice(last, m.index));
      if (m[1]) {
        const url = m[1].replace(/[.,;]+$/, '');
        into.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'msg-link' }, url));
        last = m.index + url.length; re.lastIndex = last;
      } else {
        const [, , raw] = m;
        const [fileName, line] = raw.replace(/^@?\/?/, '').split(':');
        if (files.has(fileName)) {
          into.append(el('button', { type: 'button', class: 'msg-link', title: `Open ${fileName}`, onclick: () => { Bob.showTab('ide'); Bob.ide.openFile(fileName, { line: line ? Number(line) : undefined }); } }, raw));
        } else into.append(raw);
        last = m.index + raw.length;
      }
    }
    into.append(text.slice(last));
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).then(() => Bob.toast('Copied to clipboard.', 'info'), () => Bob.toast('Clipboard access was blocked.', 'error'));
  }

  function fillBody(entry) {
    const { m, body } = entry;
    clear(body);
    if (m.role === 'bob' && m.text.includes('```')) {
      const re = /```([\w-]*)\n?([\s\S]*?)```/g; let last = 0; let x;
      while ((x = re.exec(m.text))) {
        if (x.index > last) linkify(m.text.slice(last, x.index), body);
        const code = x[2].replace(/\n$/, '');
        body.append(el('div', { class: 'code-block' },
          el('div', { class: 'code-head' }, el('span', null, x[1] || 'code'), el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Copy code', onclick: (e) => { e.stopPropagation(); copyText(code); } }, 'Copy')),
          el('pre', null, code)));
        last = x.index + x[0].length;
      }
      if (last < m.text.length) linkify(m.text.slice(last), body);
    } else linkify(m.text, body);
    const long = m.text.split('\n').length > COLLAPSE_LINES || m.text.length > COLLAPSE_CHARS;
    if (entry.collapsed === undefined) entry.collapsed = long;
    body.classList.toggle('collapsible', long);
    body.classList.toggle('collapsed', long && entry.collapsed);
    entry.toggle.hidden = !long;
    entry.toggle.textContent = entry.collapsed ? 'Show more' : 'Show less';
    entry.toggle.setAttribute('aria-expanded', String(!entry.collapsed));
  }

  function renderEntry(m) {
    const body = el('div', { class: m.role === 'user' ? 'message-user' : 'message-claude' });
    const entry = { m, body, collapsed: undefined };
    const flip = () => { entry.collapsed = !entry.collapsed; fillBody(entry); };
    entry.toggle = el('button', { type: 'button', class: 'msg-toggle', hidden: true, onclick: flip }, 'Show more');
    const actions = el('span', { class: 'msg-actions' },
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Copy message', 'data-tip': 'Copy', onclick: () => copyText(m.text) }, '⧉'),
      m.role === 'user' ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Roll back to this prompt', 'data-tip': 'Roll back to this prompt', onclick: () => rollback(entry) }, '↶') : null);
    entry.block = el('div', { class: 'message-block', dataset: { role: m.role } }, el('div', { class: 'message-label' }, LABELS[m.role] || 'Bob', actions), body, entry.toggle);
    // Click the message to expand or collapse it (ignored while selecting text or on links/buttons).
    body.addEventListener('click', (e) => {
      if (!body.classList.contains('collapsible') || e.target.closest('a, button') || String(window.getSelection())) return;
      flip();
    });
    fillBody(entry);
    return entry;
  }

  function addMessage(role, text, extra) {
    const m = { role, text: String(text), at: new Date().toISOString(), ...extra };
    const entry = renderEntry(m);
    entries.push(entry);
    dom.area.append(entry.block);
    dom.area.scrollTop = dom.area.scrollHeight;
    updateMeter();
    return entry;
  }
  function setText(entry, text) { entry.m.text = String(text); fillBody(entry); dom.area.scrollTop = dom.area.scrollHeight; updateMeter(); }
  function clearTimeline() { dom.area.querySelectorAll('.message-block, .approval-card').forEach((n) => n.remove()); entries = []; updateMeter(); }

  // ── tasks (history) ────────────────────────────────────────────────────────
  function ensureTask(title) {
    if (task || taskPromise || !Bob.can('ide:read')) return;
    taskPromise = Bob.api('/bob/tasks', { method: 'POST', body: { title: title.slice(0, 60), mode: curMode() } })
      .then((r) => { task = { id: r.task.id }; }).catch(() => { /* history is best-effort */ }).finally(() => { taskPromise = null; });
  }
  function saveTask() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (taskPromise) await taskPromise;
      if (!task) return;
      const msgs = entries.map((e) => {
        const o = { role: e.m.role, text: e.m.text, at: e.m.at };
        if (e.m.cp) o.cp = e.m.cp;
        return o;
      }).slice(-200);
      try { await Bob.api(`/bob/tasks/${task.id}`, { method: 'PUT', body: { messages: msgs, tokens: updateMeter(), mode: curMode() } }); renderRecent(); } catch (_) { /* best-effort */ }
    }, 400);
  }

  function newTask(quiet) {
    cancelApprovals();
    clearTimeline();
    task = null; taskPromise = null; pills = []; taskApprove = {};
    renderPills(); updateMeter();
    dom.input.value = ''; closeSuggest();
    if (!quiet) { Bob.toast('Started a new task.', 'info'); dom.input.focus(); }
  }

  async function loadTask(id) {
    try {
      const { task: t } = await Bob.api(`/bob/tasks/${encodeURIComponent(id)}`);
      newTask(true);
      task = { id: t.id };
      if (modes[t.mode]) setMode(t.mode, true);
      t.messages.forEach((m) => { const e = renderEntry({ ...m }); entries.push(e); dom.area.append(e.block); });
      updateMeter();
      dom.area.scrollTop = dom.area.scrollHeight;
      Bob.layout.show('secondary');
      Bob.toast(`Opened task "${t.title}".`, 'info');
    } catch (err) { Bob.errorToast(err); }
  }

  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`; return `${Math.floor(s / 86400)} d ago`;
  };

  async function renderRecent() {
    const box = $('#recent-tasks');
    if (!Bob.can('ide:read')) { clear(box); return; }
    try {
      const { tasks } = await Bob.api('/bob/tasks');
      clear(box);
      tasks.slice(0, 3).forEach((t) => box.append(el('button', { type: 'button', class: 'task-history-card', dataset: { task: t.id }, onclick: () => loadTask(t.id) },
        el('h4', null, t.title), el('div', { class: 'task-meta' }, `${ago(t.updatedAt)} • 💬 ${t.messageCount} • 🔗 ${(t.tokens / 1000).toFixed(3)}`))));
    } catch (_) { /* best-effort */ }
  }

  async function historyDialog() {
    if (!Bob.can('ide:read')) return Bob.toast('Your role cannot read task history.', 'error');
    const list = el('div', { class: 'task-list', 'aria-live': 'polite' }, Bob.loading());
    const search = el('input', { type: 'search', class: 'toolbar-input task-search', placeholder: 'Search tasks…', 'aria-label': 'Search tasks', maxlength: 60 });
    let all = [];
    const dlg = Bob.modal({
      title: 'Task history', wide: true, body: el('div', null, search, list),
      actions: [
        { label: 'Delete all', onClick: async () => { if (!all.length) return false; if (!(await Bob.confirm('Delete all saved tasks?', { danger: true, confirmLabel: 'Delete all' }))) return false; await Bob.api('/bob/tasks', { method: 'DELETE' }); await draw(); renderRecent(); return false; } },
        { label: 'Close', primary: true }
      ]
    });
    function paint() {
      clear(list);
      const q = search.value.trim();
      const rows = all.filter((t) => !q || Bob.fuzzy(q, t.title) > 0);
      if (!rows.length) { list.append(Bob.empty(all.length ? 'No matching tasks.' : 'No saved tasks yet. Send a prompt to start one.')); return; }
      rows.forEach((t) => list.append(el('div', { class: 'task-row' },
        el('button', { type: 'button', class: 'task-open', onclick: () => { dlg.close(); loadTask(t.id); } },
          el('strong', null, t.title), el('span', { class: 'cell-sub' }, `${modeName(t.mode)} • ${t.messageCount} messages • ${ago(t.updatedAt)}`)),
        el('button', { type: 'button', class: 'btn-small btn-small-danger', 'aria-label': `Delete task ${t.title}`, onclick: async () => { try { await Bob.api(`/bob/tasks/${t.id}`, { method: 'DELETE' }); if (task && task.id === t.id) task = null; await draw(); renderRecent(); } catch (err) { Bob.errorToast(err); } } }, 'Delete'))));
    }
    async function draw() { try { all = (await Bob.api('/bob/tasks')).tasks; paint(); } catch (err) { clear(list).append(Bob.errorState(err, draw)); } }
    search.addEventListener('input', paint);
    await draw();
    return dlg;
  }

  // ── rollback ───────────────────────────────────────────────────────────────
  async function rollback(entry) {
    const i = entries.indexOf(entry);
    if (i < 0) return;
    const later = entries.slice(i);
    const cp = later.map((e) => e.m.cp).find(Boolean);
    const msg = cp ? 'Roll back to this prompt? Messages after it are removed and workspace files are restored to the checkpoint taken at that point.' : 'Roll back to this prompt? Messages after it are removed.';
    if (!(await Bob.confirm(msg, { confirmLabel: 'Roll back', danger: true, title: 'Roll back' }))) return;
    if (cp && Bob.can('ide:edit')) {
      try { await Bob.api(`/bob/checkpoints/${encodeURIComponent(cp)}/restore`, { method: 'POST', body: {} }); await Bob.ide.reloadClean(); Bob.emit('checkpoints'); } catch (err) { Bob.errorToast(err); return; }
    }
    const prompt = entry.m.text.replace(/\n📎 .*$/s, '');
    later.forEach((e) => e.block.remove());
    entries = entries.slice(0, i);
    updateMeter(); saveTask();
    dom.input.value = prompt; dom.input.focus();
    Bob.toast('Rolled back. The prompt is back in the input box.', 'success');
  }

  // ── context pills ──────────────────────────────────────────────────────────
  function renderPills() {
    clear(dom.pills);
    pills.forEach((p, i) => dom.pills.append(el('span', { class: 'ctx-pill', title: p.text ? p.text.slice(0, 200) : p.label },
      el('span', null, p.label), el('button', { type: 'button', 'aria-label': `Remove ${p.label}`, onclick: () => { pills.splice(i, 1); renderPills(); updateMeter(); dom.input.focus(); } }, '×'))));
    dom.pills.hidden = pills.length === 0;
  }
  function addContext(p) {
    if (pills.some((x) => x.label === p.label && x.text === p.text)) return;
    if (pills.length >= 8) { Bob.toast('At most 8 context items can be attached.', 'error'); return; }
    pills.push(p); renderPills(); updateMeter();
  }
  async function dropFiles(files) {
    for (const f of [...files].slice(0, 5)) {
      if (f.size > 200 * 1024) { Bob.toast(`${f.name}: larger than 200 KB, skipped.`, 'error'); continue; }
      try { addContext({ label: f.name, text: `--- ${f.name} ---\n${(await f.text()).slice(0, 8000)}`, kind: 'drop' }); } catch (_) { Bob.toast(`${f.name} could not be read.`, 'error'); }
    }
  }

  // ── mentions & context assembly ────────────────────────────────────────────
  async function mentionText(token) {
    const lower = token.toLowerCase();
    try {
      if (token.startsWith('/')) {
        const name = token.slice(1).split(':')[0];
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) return '';
        const { file } = await Bob.api(`/files/${encodeURIComponent(name)}`);
        return `--- @/${file.name} ---\n${file.content.slice(0, 4000)}`;
      }
      if (lower === 'terminal') return `--- @terminal ---\n${$('#console-output').textContent.slice(-2000)}`;
      if (lower === 'problems' || lower === 'issues') {
        const { findings } = await Bob.api('/bob/findings');
        return `--- @${lower} ---\n${findings.length ? findings.map((f) => `${f.file}:${f.line} [${f.severity}] ${f.message}`).join('\n') : 'No problems detected.'}`;
      }
      if (lower === 'git-changes') {
        const r = await Bob.api('/bob/review');
        return `--- @git-changes (since ${r.base ? r.base.short : 'start'}) ---\n${r.changes.map((c) => `${c.status} ${c.name} (+${c.added}/-${c.removed})`).join('\n') || 'No changes.'}`;
      }
      if (/^[0-9a-f]{7,36}$/.test(lower)) {
        const { checkpoints } = await Bob.api('/bob/checkpoints');
        const cp = checkpoints.find((c) => c.id.startsWith(lower));
        if (!cp) return '';
        const r = await Bob.api(`/bob/review?base=${encodeURIComponent(cp.id)}`);
        return `--- @${cp.short} (${cp.label}) ---\n${r.changes.map((c) => `${c.status} ${c.name} (+${c.added}/-${c.removed})`).join('\n') || 'No changes since this checkpoint.'}`;
      }
      if (/^https:\/\//i.test(token)) return `--- @${token.slice(0, 200)} ---\n(URL reference only: this client does not fetch external pages.)`;
    } catch (_) { return `--- @${token.slice(0, 60)} --- (could not be read)`; }
    return '';
  }

  async function buildContext(sendText) {
    const parts = [];
    const mode = curMode();
    const custom = customModes.find((c) => c.slug === mode);
    if (custom) parts.push(`--- MODE ${custom.name} ---\n${custom.roleDefinition}\n${custom.customInstructions || ''}`.trim());
    // Global rules load first, workspace rules afterwards (so they can override).
    ['global', 'workspace'].forEach((scope) => rules.filter((r) => r.scope === scope && (!r.mode || r.mode === mode))
      .forEach((r) => parts.push(`--- RULE (${scope}: ${r.name}) ---\n${r.content}`)));
    pills.forEach((p) => { if (p.text) parts.push(p.text); });
    for (const p of pills.filter((x) => x.file)) {
      try { parts.push(`--- @/${p.file} ---\n${(await Bob.api(`/files/${encodeURIComponent(p.file)}`)).file.content.slice(0, 4000)}`); } catch (_) { parts.push(`--- @/${p.file} --- (could not be read)`); }
    }
    const seen = new Set();
    for (const m of sendText.matchAll(/(?:^|\s)@(\S+)/g)) {
      const tok = m[1].replace(/[.,;]+$/, '');
      if (seen.has(tok)) continue; seen.add(tok);
      const t = await mentionText(tok); if (t) parts.push(t);
    }
    return parts.join('\n\n').slice(0, 59000);
  }

  // ── sending ────────────────────────────────────────────────────────────────
  async function chatSend(display, { sendText = display } = {}) {
    if (!requireConn()) return false;
    if (sending) { Bob.toast('Bob is still working on the previous prompt.', 'info'); return false; }
    sending = true;
    const suffix = pills.length ? `\n📎 ${pills.map((p) => p.label).join(', ')}` : '';
    ensureTask(display);
    addMessage('user', display + suffix);
    const slot = addMessage('bob', '...');
    dom.send.disabled = true; dom.send.setAttribute('aria-busy', 'true');
    try {
      const context = await buildContext(sendText);
      // Send `mode` as a dedicated field so the backend can dispatch per-mode logic.
      // Do NOT embed "[Mode: X]" in the message string — the backend echoed that prefix
      // verbatim back in the chat bubble causing "[Mode: AGENT] Ready." to appear.
      const data = await Bob.api('/chat', {
        method: 'POST', timeoutMs: 60000,
        body: {
          message: sendText,
          mode:    curMode(),
          model:   $('#model-select') ? $('#model-select').value : 'claude-3-5-sonnet',
          context: context || undefined
        }
      });
      setText(slot, data.text || 'Done.');
    } catch (err) { setText(slot, `❌ ${err.message}`); } finally {
      dom.send.disabled = false; dom.send.removeAttribute('aria-busy'); sending = false;
      pills = []; renderPills(); saveTask(); updateMeter();
    }
    return true;
  }

  /** Inline chat helper: returns the reply text, or null when the gateway is not connected. Not added to the timeline. */
  async function ask(text) {
    if (!isConn()) return null;
    try {
      const context = await buildContext(text);
      const data = await Bob.api('/chat', {
        method: 'POST', timeoutMs: 60000,
        body: {
          message: text.split('\n')[0],
          mode:    curMode(),
          model:   $('#model-select') ? $('#model-select').value : 'claude-3-5-sonnet',
          context: context || undefined
        }
      });
      return data.text || 'Done.';
    } catch (err) { return `❌ ${err.message}`; }
  }

  // ── approvals (one at a time; honours Permissions + task-level override) ───
  function cancelApprovals() { openApprovals.splice(0).forEach((r) => r({ approved: false, cancelled: true })); }

  function requestApproval({ type, title, detail, command }) {
    if (readApprovals()[type] || taskApprove[type]) return Promise.resolve({ approved: true, command, auto: true });
    const p = approvalChain.then(() => new Promise((resolve) => {
      const input = command !== undefined ? el('input', { type: 'text', class: 'approval-cmd', maxlength: 200, value: command, 'aria-label': 'Command to run (editable)', spellcheck: 'false' }) : null;
      const remember = el('input', { type: 'checkbox', id: `apr-${Date.now()}` });
      let done = false;
      const finish = (approved) => {
        if (done) return; done = true;
        openApprovals = openApprovals.filter((r) => r !== finish.resolver);
        if (approved && remember.checked) taskApprove[type] = true;
        card.remove();
        resolve({ approved, command: input ? input.value.trim() : undefined });
      };
      finish.resolver = (v) => finish(v.approved);
      const approve = el('button', { type: 'button', class: 'btn-small btn-small-primary', onclick: () => finish(true) }, 'Approve');
      const reject = el('button', { type: 'button', class: 'btn-small btn-small-danger', onclick: () => finish(false) }, 'Reject');
      const card = el('div', { class: 'approval-card', role: 'group', 'aria-label': `Approval required: ${title}` },
        el('div', { class: 'approval-title' }, title, el('span', { class: `tag risk-${/High/.test(riskOf(type)) ? 'high' : 'low'}` }, `${labelOf(type)} • ${riskOf(type)} risk`)),
        detail ? el('div', { class: 'cell-sub' }, detail) : null, input,
        el('label', { class: 'check-item', for: remember.id }, remember, ` Auto-approve “${labelOf(type)}” for the rest of this task`),
        el('div', { class: 'approval-actions' }, approve, reject));
      card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      openApprovals.push(finish.resolver);
      dom.area.append(card); dom.area.scrollTop = dom.area.scrollHeight;
      (input || approve).focus();
    }));
    approvalChain = p.catch(() => {});
    return p;
  }

  async function makeCheckpoint(label, quiet) {
    if (!Bob.can('ide:edit')) { if (!quiet) Bob.toast('Your role cannot create checkpoints.', 'error'); return null; }
    try {
      const { checkpoint } = await Bob.api('/bob/checkpoints', { method: 'POST', body: { label } });
      Bob.emit('checkpoints');
      if (!quiet) Bob.toast(`Checkpoint ${checkpoint.short} created.`, 'success', { action: { label: 'View', run: () => Bob.dialogs.checkpoints() } });
      return checkpoint.id;
    } catch (err) { if (!quiet) Bob.errorToast(err); return null; }
  }

  // Guarded actions started from chat commands.
  async function runCommandFlow(command) {
    if (!command) { Bob.toast('Usage: /run <command>. Try /run help', 'info'); return; }
    addMessage('user', `/run ${command}`);
    const ap = await requestApproval({ type: 'execute', title: 'Bob wants to run a command', detail: 'You can edit the command before approving.', command });
    if (!ap.approved) { if (!ap.cancelled) addMessage('system', `Rejected: ${command}`); saveTask(); return; }
    try {
      const r = await Bob.api('/bob/terminal', { method: 'POST', body: { command: ap.command } });
      addMessage('system', `$ ${ap.command}${ap.auto ? '  (auto-approved)' : ''}\n${r.output || '(no output)'}`);
      if (/^run\b/.test(ap.command)) Bob.emit('terminal-job');
    } catch (err) { addMessage('system', `$ ${ap.command}\n${err.status === 403 ? 'Permission denied for this command.' : err.message}`); }
    saveTask();
  }

  async function initFlow() {
    if (!Bob.can('ide:edit')) { Bob.toast('Your role cannot create files.', 'error'); return; }
    const entry = addMessage('user', '/init');
    const ap = await requestApproval({ type: 'edit', title: 'Bob wants to create AGENTS.md', detail: 'A project guide summarising the workspace files and jobs.' });
    if (!ap.approved) { if (!ap.cancelled) addMessage('system', 'Rejected: /init'); saveTask(); return; }
    entry.m.cp = (await makeCheckpoint('Before /init', true)) || undefined;
    try {
      try { await Bob.api('/bob/init', { method: 'POST', body: {} }); } catch (err) {
        if (err.status !== 409) throw err;
        if (!(await Bob.confirm('AGENTS.md already exists. Overwrite it?', { confirmLabel: 'Overwrite', danger: true }))) { addMessage('system', 'AGENTS.md was left unchanged.'); return; }
        await Bob.api('/bob/init', { method: 'POST', body: { overwrite: true } });
      }
      await Bob.ide.reloadClean();
      await Bob.ide.openFile('AGENTS.md');
      addMessage('system', 'Created AGENTS.md. Open it from the explorer to edit.');
      Bob.ide.loadFindings();
    } catch (err) { addMessage('system', `/init failed: ${err.message}`); }
    saveTask();
  }

  // ── modes ──────────────────────────────────────────────────────────────────
  function setMode(slug, quiet) {
    if (!modes[slug]) return;
    dom.mode.value = slug;
    Bob.emit('mode', { slug, name: modeName(slug) });
    if (!quiet) Bob.toast(`Mode: ${modeName(slug)}`, 'info');
  }
  function cycleMode() {
    const opts = [...dom.mode.options];
    const i = opts.findIndex((o) => o.value === dom.mode.value);
    setMode(opts[(i + 1) % opts.length].value);       // wraps around, as documented
  }
  function syncModeOptions() {
    const keep = dom.mode.value;
    dom.mode.querySelectorAll('option[data-custom]').forEach((o) => o.remove());
    modes = { ...BUILTIN_MODES };
    customModes.forEach((c) => {
      if (BUILTIN_MODES[c.slug]) { modes[c.slug] = c.name; const o = [...dom.mode.options].find((x) => x.value === c.slug); if (o) o.textContent = `✨ ${c.name} Mode`; return; }
      modes[c.slug] = c.name;
      dom.mode.append(el('option', { value: c.slug, 'data-custom': '1' }, `✨ ${c.name} Mode`));
    });
    dom.mode.value = modes[keep] ? keep : 'agent';
    Bob.emit('mode', { slug: dom.mode.value, name: modeName(dom.mode.value) });
  }
  async function reloadExtras() {
    if (!Bob.can('ide:read')) { customModes = []; customCmds = []; rules = []; syncModeOptions(); return; }
    try {
      const [m, c, r] = await Promise.all([Bob.api('/bob/modes'), Bob.api('/bob/commands'), Bob.api('/bob/rules')]);
      customModes = m.items; customCmds = c.items; rules = r.items;
    } catch (_) { /* extras are optional */ }
    syncModeOptions();
  }

  // ── slash commands ─────────────────────────────────────────────────────────
  function slashItems() {
    const out = Object.keys(BUILTIN_MODES).map((slug) => ({ name: slug, desc: `Switch to ${BUILTIN_MODES[slug]} mode`, run: (arg) => { setMode(slug); if (arg) chatSend(arg); } }));
    out.push(
      { name: 'help', desc: 'Open the help directory', run: () => cmds.run('help.directory') },
      { name: 'clear', desc: 'Clear the conversation', run: () => $('#btn-clear').click() },
      { name: 'newtask', desc: 'Start a new task', run: () => newTask(false) },
      { name: 'history', desc: 'Browse task history', run: () => historyDialog() },
      { name: 'review', desc: 'Review changes since a checkpoint', run: () => cmds.run('bob.review') },
      { name: 'init', desc: 'Create AGENTS.md for this workspace', run: initFlow },
      { name: 'settings', desc: 'Open Bob settings', run: () => cmds.run('bob.settings') },
      { name: 'run', desc: 'Run a sandboxed terminal command (needs approval)', hint: '<command>', run: (arg) => runCommandFlow(arg) }
    );
    customModes.forEach((c) => { if (!out.some((x) => x.name === c.slug)) out.push({ name: c.slug, desc: `Switch to ${c.name} mode (custom)`, run: (arg) => { setMode(c.slug); if (arg) chatSend(arg); } }); });
    customCmds.forEach((c) => out.push({
      name: c.name, desc: c.description || 'Custom command', hint: c.argumentHint, custom: true,
      run: (arg) => {
        const args = arg.match(/"[^"]*"|\S+/g) || [];
        const body = c.body.replace(/\$(\d)/g, (_, n) => (args[Number(n) - 1] || '').replace(/^"|"$/g, ''));
        chatSend(`/${c.name}${arg ? ` ${arg}` : ''}`, { sendText: body });
      }
    }));
    return out;
  }

  function sendFromInput() {
    const text = dom.input.value.trim();
    if (!text && !pills.length) return;
    const slash = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text);
    const item = slash && slashItems().find((c) => c.name === slash[1].toLowerCase());
    if (item) { dom.input.value = ''; closeSuggest(); item.run(slash[2].trim()); return; }
    if (!requireConn()) return;                     // keep the draft when the gateway is not connected
    dom.input.value = ''; closeSuggest();
    chatSend(text || 'Use the attached context.');
  }

  // ── suggestions (/ and @) ──────────────────────────────────────────────────
  const closeSuggest = () => { dom.suggest.hidden = true; suggestions = []; suggestIdx = -1; dom.input.removeAttribute('aria-activedescendant'); };
  function drawSuggest() {
    clear(dom.suggest);
    suggestions.forEach((s, i) => dom.suggest.append(el('li', {
      role: 'option', id: `sg-${i}`, class: `suggest-item${i === suggestIdx ? ' active' : ''}`, 'aria-selected': String(i === suggestIdx),
      onmousedown: (e) => { e.preventDefault(); pickSuggestion(i); }          // mousedown keeps focus in the textarea
    }, el('strong', null, s.label), s.hint ? el('span', { class: 'arg-hint' }, ` ${s.hint}`) : null, el('span', { class: 'cell-sub' }, ` ${s.desc || ''}`))));
    dom.suggest.hidden = !suggestions.length;
    if (suggestIdx >= 0) dom.input.setAttribute('aria-activedescendant', `sg-${suggestIdx}`); else dom.input.removeAttribute('aria-activedescendant');
  }

  let cpCache = []; let cpAt = 0;
  async function checkpointList() {
    if (Date.now() - cpAt < 4000) return cpCache;
    cpAt = Date.now();
    try { cpCache = Bob.can('ide:read') ? (await Bob.api('/bob/checkpoints')).checkpoints : []; } catch (_) { cpCache = []; }
    return cpCache;
  }

  async function updateSuggestions() {
    const upto = dom.input.value.slice(0, dom.input.selectionStart);
    const slash = /^\/([\w-]*)$/.exec(upto);
    const at = /(?:^|\s)@([^\s]*)$/.exec(upto);
    if (slash) {
      suggestKind = 'slash';
      const q = slash[1];
      suggestions = slashItems().map((s) => ({ s, sc: Bob.fuzzy(q, s.name) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc)
        .map(({ s }) => ({ label: `/${s.name}`, hint: s.hint, desc: s.desc, item: s })).slice(0, 10);
    } else if (at) {
      suggestKind = 'at';
      const q = at[1].toLowerCase();
      const files = Bob.ide ? Bob.ide.listFiles() : [];
      const cps = await checkpointList();
      const base = [
        { label: '@terminal', desc: 'Recent console output', insert: '@terminal' },
        { label: '@problems', desc: 'Bob Findings', insert: '@problems' },
        { label: '@issues', desc: 'Bob Findings (alias)', insert: '@issues' },
        { label: '@git-changes', desc: 'Changes since the last checkpoint', insert: '@git-changes' },
        { label: '@https://', desc: 'Reference a URL', insert: '@https://' },
        ...files.map((n) => ({ label: `@/${n}`, desc: 'Workspace file', insert: `@/${n}` })),
        ...cps.map((c) => ({ label: `@${c.short}`, desc: `Checkpoint: ${c.label}`, insert: `@${c.short}` }))
      ];
      suggestions = base.map((s) => ({ ...s, sc: q ? Bob.fuzzy(q, s.label.slice(1)) : 1 })).filter((s) => s.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 8);
    } else { closeSuggest(); return; }
    suggestIdx = suggestions.length ? 0 : -1;
    drawSuggest();
  }

  function pickSuggestion(i) {
    const s = suggestions[i];
    if (!s) return;
    if (suggestKind === 'slash') {
      const it = s.item;
      closeSuggest();
      if (it.hint) { dom.input.value = `/${it.name} `; dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length); dom.input.focus(); return; }
      dom.input.value = '';
      it.run('');
      return;
    }
    const pos = dom.input.selectionStart;
    const before = dom.input.value.slice(0, pos).replace(/@[^\s]*$/, '');
    const space = s.insert.endsWith('//') ? '' : ' ';
    dom.input.value = `${before}${s.insert}${space}${dom.input.value.slice(pos)}`;
    const caret = before.length + s.insert.length + space.length;
    dom.input.setSelectionRange(caret, caret);
    closeSuggest(); dom.input.focus();
  }

  // ── permissions dialog + auto-approve bar ──────────────────────────────────
  function renderAABar() {
    const on = AUTO_APPROVE.filter(([k]) => readApprovals()[k]);
    clear(dom.aa);
    dom.aa.append(el('button', { type: 'button', class: 'aa-btn', 'aria-label': `Auto-approve settings: ${on.length ? on.map((a) => a[1]).join(', ') : 'all off'}`, onclick: openPermissions },
      el('span', { 'aria-hidden': 'true' }, '🛡 '), 'Auto-approve: ',
      on.length ? on.map((a) => el('span', { class: `aa-chip risk-${/High/.test(a[2]) ? 'high' : 'low'}` }, a[1])) : el('span', { class: 'aa-off' }, 'off (manual approval)')));
  }
  function openPermissions() {
    const current = readApprovals();
    const boxes = {};
    const list = el('ul', { class: 'plain-list perm-list' }, AUTO_APPROVE.map(([key, label, risk, desc]) => {
      const cb = el('input', { type: 'checkbox', id: `aa-${key}`, checked: !!current[key] });
      boxes[key] = cb;
      return el('li', null, el('label', { for: cb.id, class: 'check-item' }, cb, el('strong', null, ` ${label}`), el('span', { class: `tag risk-${risk.startsWith('High') || risk === 'Medium-High' ? 'high' : 'low'}` }, `${risk} risk`)), el('div', { class: 'cell-sub' }, desc));
    }));
    Bob.modal({
      title: 'Auto-approve permissions',
      body: el('div', null,
        el('p', { class: 'warn-box', role: 'note' }, 'Auto-approve skips confirmation prompts and can cause data loss or file corruption. Enable only actions you fully trust. Leave everything off to approve each action manually (safest).'), list),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save', primary: true, onClick: () => {
            const next = {};
            for (const [k] of AUTO_APPROVE) next[k] = boxes[k].checked;
            localStorage.setItem('bob_auto_approve', JSON.stringify(next));
            const n = Object.values(next).filter(Boolean).length;
            Bob.toast(n ? `${n} action type(s) auto-approved.` : 'All actions require manual approval.', 'success');
            renderAABar();
          }
        }
      ]
    });
  }

  // ── commands ───────────────────────────────────────────────────────────────
  cmds.register([
    { id: 'bob.newTask', title: 'New Task', category: 'Bob', run: () => newTask(false) },
    { id: 'bob.history', title: 'Task History…', category: 'Bob', run: () => historyDialog(), enabled: () => Bob.can('ide:read') },
    { id: 'bob.openChat', title: 'Open Bob Chat', category: 'Bob', keys: ['Mod+Alt+B'], global: true, run: () => { Bob.layout.show('secondary'); dom.input.focus(); } },
    { id: 'bob.cycleMode', title: 'Switch Mode (next)', category: 'Bob', keys: ['Mod+.'], when: () => !(Bob.ide && Bob.ide.hasEditorFocus()), run: cycleMode },
    { id: 'bob.init', title: 'Initialize Project (/init → AGENTS.md)', category: 'Bob', run: initFlow, enabled: () => Bob.can('ide:edit') },
    { id: 'bob.checkpoint', title: 'Create Checkpoint', category: 'Bob', run: async () => {
      const label = await Bob.prompt({ title: 'Create checkpoint', label: 'Label', value: 'Checkpoint', submitLabel: 'Create', validate: (v) => (v.length > 80 ? 'At most 80 characters.' : '') });
      if (label !== null) makeCheckpoint(label || 'Checkpoint');
    }, enabled: () => Bob.can('ide:edit') },
    { id: 'bob.permissions', title: 'Auto-approve Permissions…', category: 'Bob', run: openPermissions },
    { id: 'chat.clear', title: 'Clear Conversation', category: 'Bob', run: () => $('#btn-clear').click() },
    { id: 'chat.focus', title: 'Focus Chat Input', category: 'Bob', run: () => dom.input.focus() }
  ]);

  // ── public API ─────────────────────────────────────────────────────────────
  Bob.chat = {
    addContext, ask, newTask, setMode, cycleMode, reloadExtras, tokens: updateMeter, makeCheckpoint, openPermissions,
    mode: curMode, modeName,
    focus: () => dom.input.focus(),
    send: (text) => chatSend(text),
    sendFromInput,
    init() {
      Object.assign(dom, {
        area: $('#response-area'), input: $('#user-message'), send: $('#btn-send'), mode: $('#bob-mode-select'),
        suggest: $('#bob-suggest'), pills: $('#ctx-pills'), aa: $('#auto-approve-bar')
      });

      // Tool / capability buttons (original behaviour, now keyboard-accessible buttons)
      const trace = (tool, detail) => { if (requireConn()) addMessage('system', `[${tool.toUpperCase()}] ${detail}`); };
      const wire = (id, tool, detail) => { const n = $(id); if (n) n.addEventListener('click', (e) => { e.stopPropagation(); trace(tool, detail); }); };
      wire('#tool-file-access', 'File Access', 'Reading project filesystem workspace context logs... [OK]');
      wire('#tool-run-cmd', 'Run Command', 'Terminal shell workspace process initialization standing by...');
      wire('#tool-mcp', 'MCP Link', 'Model Context Protocol server extensions bound successfully.');
      wire('#tool-shell', 'Bob Shell', 'Bob Shell interactive terminal hook attached onto background nodes.');
      // #btn-trigger-docs REMOVED (change #5 — Documentation button removed)

      // FIX: #btn-add-agent now opens the OS file picker via the hidden #bob-attach-file input.
      // Previously it only logged a trace; it now lets users attach files/images as context pills.
      const attachInput = $('#bob-attach-file');
      const attachBtn   = $('#btn-add-agent');
      if (attachBtn && attachInput) {
        attachBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Reset so selecting the same file twice still fires 'change'.
          attachInput.value = '';
          attachInput.click();
        });
        attachInput.addEventListener('change', () => {
          if (attachInput.files && attachInput.files.length) {
            dropFiles(attachInput.files);
            // Reset after reading so repeated selections always trigger change.
            attachInput.value = '';
          }
        });
      }

      // FIX: "Clear All" had no handler. It clears the conversation (not the welcome card / task shortcuts).
      $('#btn-clear').addEventListener('click', () => { cancelApprovals(); clearTimeline(); task = null; Bob.toast('Conversation cleared.', 'info'); });
      $('#btn-new-task').addEventListener('click', () => newTask(false));
      // #btn-history (clock button) REMOVED from header (task 4). historyDialog() still wired to /history slash cmd.
      $('#btn-bob-settings').addEventListener('click', () => cmds.run('bob.settings'));
      $('#btn-permissions').addEventListener('click', openPermissions);

      // FIX: previously only fired when the card element itself was the click target (not its <h4>/<div> children).
      dom.area.addEventListener('click', (e) => {
        const card = e.target.closest('.selector-card-btn');
        if (card) chatSend(`Triggering action pass: ${card.querySelector('h4').textContent}`);
      });

      dom.mode.addEventListener('change', () => setMode(dom.mode.value, true));
      dom.send.addEventListener('click', sendFromInput);

      // TASK 2: auto-grow textarea up to max-height, then scroll internally.
      function autoGrowInput() {
        dom.input.style.height = 'auto';
        dom.input.style.height = `${Math.min(dom.input.scrollHeight, 140)}px`;
      }
      dom.input.addEventListener('input', (e) => { updateSuggestions(e); autoGrowInput(); });
      autoGrowInput();
      dom.input.addEventListener('blur', () => setTimeout(closeSuggest, 120));
      dom.input.addEventListener('keydown', (e) => {
        if (!dom.suggest.hidden && suggestions.length) {
          if (e.key === 'ArrowDown') { e.preventDefault(); suggestIdx = (suggestIdx + 1) % suggestions.length; drawSuggest(); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); suggestIdx = (suggestIdx - 1 + suggestions.length) % suggestions.length; drawSuggest(); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSuggestion(suggestIdx); return; }
          if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFromInput(); }
      });

      // Large pasted text becomes a compact context pill instead of flooding the input.
      dom.input.addEventListener('paste', (e) => {
        const t = e.clipboardData && e.clipboardData.getData('text');
        if (t && (t.length > 500 || t.split('\n').length > 8)) {
          e.preventDefault();
          addContext({ label: `Pasted text (${t.split('\n').length} lines)`, text: `--- pasted text ---\n${t.slice(0, 8000)}`, kind: 'paste' });
        }
      });

      // Drag & drop: explorer / editor tabs (internal) and files from the OS.
      const dropZones = [dom.area, $('#bob-input-dock')];
      dropZones.forEach((z) => {
        z.addEventListener('dragover', (e) => { const t = [...e.dataTransfer.types]; if (t.includes('text/bob-file') || t.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; $('#panel-mode-chat').classList.add('drop-target'); } });
        z.addEventListener('dragleave', (e) => { if (!z.contains(e.relatedTarget)) $('#panel-mode-chat').classList.remove('drop-target'); });
        z.addEventListener('drop', (e) => {
          $('#panel-mode-chat').classList.remove('drop-target');
          const name = e.dataTransfer.getData('text/bob-file');
          if (name) { e.preventDefault(); addContext({ label: `@/${name}`, file: name, kind: 'file' }); Bob.toast(`Added @/${name} to context.`, 'success'); }
          else if (e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); dropFiles(e.dataTransfer.files); }
        });
      });

      Bob.on('session', () => { reloadExtras(); renderRecent(); });
      Bob.on('bob-config', reloadExtras);
      renderAABar(); renderPills(); updateMeter(); renderRecent();

      // ── TASK 5: side-by-side layout toggle ─────────────────────────────────
      // When the panel opens the workspace viewport gets class 'bob-open' which
      // CSS uses to shrink #workspace-main and reveal #panel-mode-chat side-by-side.
      // The floating button stays fixed as the toggle handle.
      const floatBtn = document.getElementById('bob-float-btn');
      const panel = document.getElementById('panel-mode-chat');
      const closeBtn = document.getElementById('bob-panel-close');
      const viewport = document.querySelector('.workspace-viewport');

      // Trigger CodeMirror / splitter relayout after transition so the editor
      // repaints at the new width.
      function refreshEditorLayout() {
        if (Bob.ide && Bob.ide.refreshLayout) Bob.ide.refreshLayout();
      }

      function openBobPanel() {
        if (!panel || !viewport) return;
        panel.hidden = false;
        // Double rAF: first frame removes [hidden], second frame starts the transition.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          viewport.classList.add('bob-open');
          panel.classList.add('bob-panel-open');
        }));
        if (floatBtn) {
          floatBtn.setAttribute('aria-expanded', 'true');
          floatBtn.setAttribute('aria-label', 'Close IBM Bob assistant');
        }
        panel.addEventListener('transitionend', refreshEditorLayout, { once: true });
        const firstFocusable = panel.querySelector('select,button,textarea,input');
        if (firstFocusable) setTimeout(() => firstFocusable.focus(), 260);
      }

      function closeBobPanel() {
        if (!panel || !viewport) return;
        viewport.classList.remove('bob-open');
        panel.classList.remove('bob-panel-open');
        if (floatBtn) {
          floatBtn.setAttribute('aria-expanded', 'false');
          floatBtn.setAttribute('aria-label', 'Open IBM Bob assistant');
        }
        // Re-hide after the CSS transition completes (~240 ms).
        panel.addEventListener('transitionend', () => {
          panel.hidden = true;
          refreshEditorLayout();
        }, { once: true });
        if (floatBtn) setTimeout(() => floatBtn.focus(), 260);
      }

      if (floatBtn) {
        floatBtn.addEventListener('click', () => {
          if (panel && !panel.hidden) { closeBobPanel(); } else { openBobPanel(); }
        });
      }
      if (closeBtn) closeBtn.addEventListener('click', closeBobPanel);

      // Escape closes the panel when it is open.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel && !panel.hidden) { e.stopPropagation(); closeBobPanel(); }
      });

      // Extend Bob.layout.show/hide to handle the 'secondary' zone (Bob panel),
      // without overwriting the existing layout.js implementations that handle
      // 'panel', 'config', 'activity', etc.  Save the original methods first.
      Bob.layout = Bob.layout || {};
      const _layoutShow = Bob.layout.show ? Bob.layout.show.bind(Bob.layout) : null;
      const _layoutHide = Bob.layout.hide ? Bob.layout.hide.bind(Bob.layout) : null;
      Bob.layout.show = (zone) => {
        if (zone === 'secondary') { openBobPanel(); return; }
        if (_layoutShow) _layoutShow(zone);
      };
      Bob.layout.hide = (zone) => {
        if (zone === 'secondary') { closeBobPanel(); return; }
        if (_layoutHide) _layoutHide(zone);
      };
    }
  };
})();
