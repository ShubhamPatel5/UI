/**
 * FIX (root cause of broken IDE Edit menu): dialogs.js was listed in index.html but DID NOT EXIST.
 * A missing <script> src causes a network error that halts all subsequent script execution.
 * Because app.js comes after dialogs.js in the load order, the ENTIRE application failed to boot:
 *   - Bob.ide.init() was never called → the IDE menubar (including the Edit menu) was never built
 *   - Bob.jobs.init(), Bob.monitor.init(), Bob.admin.init() were never called
 *   - Every interactive element in the UI was non-functional
 *
 * This file registers the commands that the rest of the application references but that are not
 * claimed by any other module:
 *   - bob.review        (Bob menu → Review)
 *   - bob.settings      (Bob menu → Settings, btn-bob-settings, /settings slash command)
 *   - bob.checkpoints   (Bob menu → Checkpoints, status-bar sb-checkpoint, Bob.dialogs.checkpoints())
 *   - help.directory    (Help menu → Help Directory, /help slash command)
 *   - help.shortcuts    (Help menu → Keyboard Shortcuts)
 *   - help.about        (Help menu → About)
 *
 * It also exposes Bob.dialogs.checkpoints() used by chat.js when a checkpoint is created.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;
  const cmds = Bob.commands;

  // ── Review dialog ─────────────────────────────────────────────────────────
  async function reviewDialog() {
    if (!Bob.can('ide:read')) return Bob.toast('Your role cannot view the review.', 'error');
    const body = el('div', null, Bob.loading());
    const dlg = Bob.modal({ title: 'Review Changes', body, wide: true, actions: [{ label: 'Close', primary: true }] });

    async function draw(baseId) {
      clear(body).append(Bob.loading());
      try {
        const url = baseId ? `/bob/review?base=${encodeURIComponent(baseId)}` : '/bob/review';
        const { base, changes, findings } = await Bob.api(url);

        // Checkpoint selector
        let cpSel = null;
        try {
          const { checkpoints } = await Bob.api('/bob/checkpoints');
          if (checkpoints.length > 1) {
            cpSel = el('div', { class: 'form-row', style: 'margin-bottom:10px' },
              el('label', { for: 'rv-base' }, 'Compare against'),
              el('select', { id: 'rv-base', class: 'toolbar-input', onchange: (e) => draw(e.target.value) },
                checkpoints.map((c) => el('option', { value: c.id, selected: c.id === (base && base.id) }, `${c.short}  ${c.label}  (${new Date(c.createdAt).toLocaleString()})`))));
          }
        } catch (_) { /* selector is best-effort */ }

        clear(body);
        if (cpSel) body.append(cpSel);
        body.append(el('p', { class: 'hint' }, base ? `Against checkpoint ${base.short}: ${base.label}` : 'No checkpoint — showing all files as added.'));

        if (!changes.length) { body.append(Bob.empty('No changes.')); }
        else {
          const rows = changes.map((c) => el('tr', null,
            el('td', null, el('button', { type: 'button', class: 'btn-small', onclick: () => { dlg.close(); Bob.showTab('ide'); Bob.ide.openFile(c.name); } }, c.name)),
            el('td', null, el('span', { class: `status-chip status-${c.status === 'deleted' ? 'failed' : c.status === 'added' ? 'completed' : 'running'}` }, c.status)),
            el('td', null, `+${c.added}`),
            el('td', null, `-${c.removed}`)));
          body.append(el('div', { class: 'table-wrap', style: 'margin-bottom:12px' },
            el('table', { class: 'data-table' },
              el('caption', { class: 'sr-only' }, 'Changed files'),
              el('thead', null, el('tr', null, ['File', 'Status', 'Added', 'Removed'].map((h) => el('th', { scope: 'col' }, h)))),
              el('tbody', null, rows))));
        }

        if (findings.length) {
          body.append(el('h4', { class: 'section-title' }, `Bob findings on changed files (${findings.length})`));
          body.append(el('ul', { class: 'plain-list' }, findings.slice(0, 20).map((f) => el('li', null,
            el('span', { class: `status-chip status-${f.severity === 'error' ? 'failed' : 'queued'}` }, f.severity),
            ` ${f.file}:${f.line} — ${f.message}`
          ))));
        }
      } catch (err) { clear(body).append(Bob.errorState(err, () => draw(baseId))); }
    }
    await draw(null);
    return dlg;
  }

  // ── Settings dialog (Bob IDE parity — extends the Settings tab) ───────────
  async function settingsDialog() {
    const body = el('div', null);

    // Keybindings section
    const kbBody = el('div', null, Bob.loading());
    async function drawKb() {
      clear(kbBody);
      const all = cmds.list().filter((c) => !c.hidden && (c.keys || cmds.isCustom(c.id)));
      if (!all.length) { kbBody.append(Bob.empty('No shortcuts defined.')); return; }
      const rows = all.map((c) => {
        const current = cmds.keyLabel(c.id);
        const custom = cmds.isCustom(c.id);
        const reset = el('button', { type: 'button', class: 'btn-small', 'aria-label': `Reset ${c.title} shortcut`, disabled: !custom, onclick: async () => { cmds.resetKey(c.id); await drawKb(); Bob.toast(`Shortcut for "${c.title}" reset.`, 'info'); } }, 'Reset');
        const edit = el('button', { type: 'button', class: 'btn-small btn-small-primary', 'aria-label': `Edit ${c.title} shortcut`, onclick: async () => {
          const v = await Bob.prompt({ title: `Rebind "${c.title}"`, label: 'Press a key combo (e.g. Ctrl+Shift+K)', value: '', help: 'Leave blank to remove the binding.', validate: (x) => x && x.length > 40 ? 'Too long' : '' });
          if (v === null) return;
          const conflict = v && cmds.conflictFor(c.id, v);
          if (conflict) { Bob.toast(`"${v}" is already used by "${conflict.title}". Reassign that first.`, 'error'); return; }
          cmds.setKey(c.id, v || '');
          await drawKb();
          Bob.toast(v ? `"${c.title}" bound to ${v}.` : `"${c.title}" unbound.`, 'success');
        } }, 'Edit');
        return el('tr', null,
          el('td', null, el('span', { class: 'tag' }, c.category), ` ${c.title}`),
          el('td', null, el('code', null, current || '—'), custom ? el('span', { class: 'tag tag-muted', style: 'margin-left:6px' }, 'custom') : null),
          el('td', null, el('div', { class: 'row-actions' }, edit, reset)));
      });
      kbBody.append(
        el('div', { class: 'toolbar-actions', style: 'margin-bottom:8px' },
          el('button', { type: 'button', class: 'btn-small btn-small-danger', onclick: async () => { if (!(await Bob.confirm('Reset all custom keybindings to defaults?', { confirmLabel: 'Reset all', danger: true, title: 'Reset keybindings' }))) return; cmds.resetAll(); await drawKb(); Bob.toast('All keybindings reset.', 'success'); } }, 'Reset all')),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
          el('caption', { class: 'sr-only' }, 'Keyboard shortcuts'),
          el('thead', null, el('tr', null, ['Command', 'Shortcut', ''].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', null, rows))));
    }
    await drawKb();

    body.append(
      el('fieldset', { class: 'card' }, el('legend', null, 'Keyboard shortcuts'),
        el('p', { class: 'hint' }, 'These bindings apply across all modes. Commands without a shortcut can be run from the Command Palette (Ctrl+Shift+P).'),
        kbBody),
      el('fieldset', { class: 'card' }, el('legend', null, 'Editor'),
        el('p', { class: 'hint' }, 'Additional editor and environment settings are in the Settings tab (⚙ Settings). Connection, environment variables and notification preferences are also found there.')));

    Bob.modal({ title: 'Bob Settings', body, wide: true, actions: [{ label: 'Done', primary: true }] });
  }

  // ── Checkpoints dialog ────────────────────────────────────────────────────
  async function checkpointsDialog() {
    if (!Bob.can('ide:read')) return Bob.toast('Your role cannot view checkpoints.', 'error');
    const body = el('div', null, Bob.loading());
    const dlg = Bob.modal({ title: 'Checkpoints', body, wide: true, actions: [] });

    async function draw() {
      clear(body).append(Bob.loading());
      try {
        const { checkpoints } = await Bob.api('/bob/checkpoints');
        clear(body);

        if (Bob.can('ide:edit')) {
          const createBtn = el('button', { type: 'button', class: 'btn-small btn-small-primary', style: 'margin-bottom:12px' }, '+ Create checkpoint');
          createBtn.addEventListener('click', () => Bob.withBusy(createBtn, async () => {
            const label = await Bob.prompt({ title: 'New checkpoint', label: 'Label (optional)', value: '', help: 'A short description of the current state.' });
            if (label === null) return;
            await Bob.api('/bob/checkpoints', { method: 'POST', body: { label: label || 'Checkpoint' } });
            Bob.toast('Checkpoint created.', 'success');
            Bob.emit('checkpoints');
            await draw();
          }, 'Creating…'));
          body.append(createBtn);
        }

        if (!checkpoints.length) { body.append(Bob.empty('No checkpoints yet.')); return; }

        const canEdit = Bob.can('ide:edit');
        const rows = checkpoints.map((cp) => el('tr', null,
          el('td', null, el('code', null, cp.short), el('div', { class: 'cell-sub' }, new Date(cp.createdAt).toLocaleString())),
          el('td', null, cp.label),
          el('td', null, `${cp.files} file(s)`),
          el('td', null, el('div', { class: 'row-actions' },
            el('button', { type: 'button', class: 'btn-small', 'aria-label': `Review from ${cp.short}`, onclick: () => { dlg.close(); reviewDialog().then(() => { /* dialog handles close */ }); } }, 'Review'),
            el('button', { type: 'button', class: 'btn-small btn-small-primary', disabled: !canEdit, 'aria-label': `Restore checkpoint ${cp.short}`, onclick: async (e) => {
              if (!(await Bob.confirm(`Restore workspace to checkpoint "${cp.short} — ${cp.label}"? Current files will be overwritten (a safety checkpoint is taken first).`, { confirmLabel: 'Restore', danger: true, title: 'Restore checkpoint' }))) return;
              await Bob.withBusy(e.currentTarget, async () => {
                await Bob.api(`/bob/checkpoints/${cp.id}/restore`, { method: 'POST' });
                Bob.toast('Workspace restored.', 'success');
                Bob.emit('checkpoints');
                await Bob.ide.refresh();
                await draw();
              }, 'Restoring…');
            } }, 'Restore'),
            el('button', { type: 'button', class: 'btn-small btn-small-danger', disabled: !canEdit, 'aria-label': `Delete checkpoint ${cp.short}`, onclick: async (e) => {
              if (!(await Bob.confirm(`Delete checkpoint "${cp.short}"?`, { confirmLabel: 'Delete', danger: true, title: 'Delete checkpoint' }))) return;
              await Bob.withBusy(e.currentTarget, async () => {
                await Bob.api(`/bob/checkpoints/${cp.id}`, { method: 'DELETE' });
                Bob.emit('checkpoints');
                await draw();
              }, '…');
            } }, 'Delete')))));

        body.append(el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
          el('caption', { class: 'sr-only' }, 'Checkpoints'),
          el('thead', null, el('tr', null, ['ID', 'Label', 'Files', 'Actions'].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', null, rows))));
      } catch (err) { clear(body).append(Bob.errorState(err, draw)); }
    }
    await draw();
    return dlg;
  }

  // ── Help dialogs ──────────────────────────────────────────────────────────
  function helpDirectoryDialog() {
    const sec = (title, items) => el('section', null,
      el('h4', { class: 'section-title' }, title),
      el('ul', { class: 'plain-list' }, items.map(([k, v]) => el('li', null, el('code', null, k), ` ${v}`))));
    Bob.modal({
      title: 'Help Directory', wide: true,
      body: el('div', null,
        sec('Workspace tabs', [
          ['IDE', 'Edit files; the File / Edit / View / Run menubar is along the top of the editor.'],
          ['Dashboard', 'Job statistics, run counts, success rate, recent runs.'],
          ['Jobs', 'Create, edit, schedule, manually trigger, enable/disable, delete, import / export.'],
          ['Runs & Logs', 'Run history with status filtering, cancel, and the log viewer.'],
          ['Workflow', 'Dependency graph — visualises which jobs depend on which.']
          // Settings and Roles tabs removed (changes #1 and #2)
        ]),
        sec('IDE shortcuts', [
          ['Ctrl/⌘+S', 'Save current file'],
          ['Ctrl/⌘+Z / Ctrl/⌘+Y', 'Undo / Redo'],
          ['Ctrl/⌘+X / C / V', 'Cut / Copy / Paste'],
          ['Ctrl/⌘+F / H', 'Find / Replace (requires a file open)'],
          ['Ctrl/⌘+/', 'Toggle line comment'],
          ['Ctrl/⌘+Shift+P  or  F1', 'Command Palette (all commands searchable)'],
          ['Ctrl/⌘+K', 'Inline Chat — ask Bob about the selection'],
          ['Ctrl/⌘+I', 'Toggle Literate Coding mode'],
          ['Ctrl/⌘+.', 'Code Actions (Fix, Explain, Improve)'],
          ['F10', 'Focus the IDE menubar (then Arrow keys to navigate, Enter to open)']
        ]),
        sec('Bob chat', [
          ['/code /ask /plan /advanced /orchestrator', 'Switch Bob mode'],
          ['/newtask', 'Start a fresh task'],
          ['/history', 'Browse saved tasks'],
          ['/review', 'Review changes since the last checkpoint'],
          ['/run <command>', 'Run a sandboxed terminal command (requires approval)'],
          ['/help', 'Open this dialog'],
          ['/clear', 'Clear the conversation'],
          ['@/file.js', 'Attach a workspace file as context'],
          ['@terminal', 'Attach recent console output as context'],
          ['Shift+Enter', 'Add a new line without sending']
        ]),
        // Roles section removed (change #2)
        ),
      actions: [{ label: 'Close', primary: true }]
    });
  }

  function helpShortcutsDialog() {
    const all = cmds.list().filter((c) => !c.hidden && (c.keys && c.keys.length));
    const byCategory = {};
    all.forEach((c) => { (byCategory[c.category] = byCategory[c.category] || []).push(c); });
    const rows = Object.entries(byCategory).flatMap(([cat, items]) => [
      el('tr', null, el('td', { colspan: '2', class: 'section-title', style: 'padding-top:10px' }, cat)),
      ...items.map((c) => el('tr', null, el('td', null, c.title), el('td', null, el('code', null, cmds.keyLabel(c.id)))))
    ]);
    Bob.modal({
      title: 'Keyboard Shortcuts', wide: true,
      body: el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
        el('caption', { class: 'sr-only' }, 'Keyboard shortcuts'),
        el('thead', null, el('tr', null, [el('th', { scope: 'col' }, 'Action'), el('th', { scope: 'col' }, 'Shortcut')])),
        el('tbody', null, rows))),
      actions: [{ label: 'Close', primary: true }]
    });
  }

  function helpAboutDialog() {
    Bob.modal({
      title: 'About IBM Bob',
      body: el('div', { class: 'form-stack' },
        el('p', null, 'IBM Bob is an AI coding assistant integrated into this workspace. It provides code editing (IDE), job scheduling, batch execution monitoring, workflow visualisation, and an AI chat pipeline powered by Anthropic Claude.'),
        el('p', null, el('strong', null, 'Version:'), ' 1.0.0'),
        el('p', null, el('strong', null, 'Backend:'), ' Node.js + Express, running at ', el('code', null, window.location.origin)),
        el('p', null, el('strong', null, 'Code editor:'), ' CodeMirror 5 (served locally; no CDN).'),
        el('p', { class: 'hint' }, 'Users should independently verify the accuracy of AI-generated content.')),
      actions: [{ label: 'Close', primary: true }]
    });
  }

  // ── Register commands ─────────────────────────────────────────────────────
  cmds.register([
    {
      id: 'bob.review', title: 'Review Changes…', category: 'Bob',
      run: reviewDialog,
      enabled: () => Bob.can('ide:read')
    },
    {
      id: 'bob.settings', title: 'Bob Settings…', category: 'Bob',
      run: settingsDialog
    },
    {
      id: 'bob.checkpoints', title: 'Checkpoints…', category: 'Bob',
      run: checkpointsDialog,
      enabled: () => Bob.can('ide:read')
    },
    {
      id: 'help.directory', title: 'Help Directory', category: 'Help',
      run: helpDirectoryDialog,
      global: true  // accessible from within a modal (e.g., from the palette)
    },
    {
      id: 'help.shortcuts', title: 'Keyboard Shortcuts', category: 'Help',
      run: helpShortcutsDialog
    },
    {
      id: 'help.about', title: 'About IBM Bob', category: 'Help',
      run: helpAboutDialog
    }
  ]);

  // ── Public API (Bob.dialogs) ──────────────────────────────────────────────
  // chat.js calls Bob.dialogs.checkpoints() when a new checkpoint is created and the user clicks "View".
  Bob.dialogs = {
    review: reviewDialog,
    settings: settingsDialog,
    checkpoints: checkpointsDialog,
    helpDirectory: helpDirectoryDialog,
    helpShortcuts: helpShortcutsDialog,
    helpAbout: helpAboutDialog
  };

  // Wire the Help Directory nav button (re-maps the handler originally in app.js,
  // now that dialogs.js owns this command).
  const helpBtn = document.getElementById('qa-trigger-help');
  if (helpBtn) helpBtn.addEventListener('click', helpDirectoryDialog);
})();
