/**
 * NEW (IBM Bob docs — https://internal.bob.ibm.com/docs/ide/): Bob Quick Actions panel
 * (js/bob-actions.js)
 *
 * Implements the "Quick Actions" panel visible in the right-side Bob sidebar.
 * Each button collects context from the active IDE editor (selection if present,
 * otherwise the full file) and sends a focused, mode-appropriate prompt to Bob
 * via the existing Bob.chat.send() path.  No new transport is needed — the same
 * /api/chat endpoint that handles typed messages is used.
 *
 * Actions implemented (per IBM Bob docs):
 *   Explain     — explain what the selected or current code does
 *   Fix         — identify and fix issues in the code
 *   Improve     — suggest concrete improvements
 *   Gen Tests   — generate unit tests (Jest/Mocha/pytest auto-detected)
 *   Gen Docs    — generate JSDoc / docstrings
 *   Commit Msg  — write a conventional git commit message from changed files
 *   Review      — a full code review with actionable comments
 *   New Task    — start a fresh task (delegates to Bob.chat.newTask)
 *
 * All actions:
 *   - Require the gateway to be connected (Bob.isConnected()).
 *   - Add the selected code or current file as a context pill so it travels
 *     with the prompt and does not clutter the conversation body.
 *   - Open the Bob sidebar if it is hidden so the user can see the reply.
 *   - Disable the clicked button while the send is in-flight to prevent
 *     double-sends; restore it (and any sibling buttons) when done.
 *   - Show a loading state on the button itself.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { $ } = Bob;

  // ── helpers ──────────────────────────────────────────────────────────────────

  /** Collect context from the IDE. Returns {label, text, kind} or null if no file is open. */
  function ideContext() {
    if (!Bob.ide) return null;
    const file = Bob.ide.getFileName();
    if (!file) return null;
    // selectionInfo() returns {text, file, startLine, endLine, hasSelection} or null.
    // Only use the selection when the user has actually selected something (not just the cursor line).
    const sel = Bob.ide.selectionInfo ? Bob.ide.selectionInfo() : null;
    if (sel && sel.hasSelection && sel.text && sel.text.trim()) {
      const label = `@/${file}:${sel.startLine}-${sel.endLine}`;
      return { label, text: `--- ${label} ---\n${sel.text.slice(0, 8000)}`, kind: 'selection' };
    }
    // No selection: use the full file.
    const code = Bob.ide.getCode();
    return code
      ? { label: `@/${file}`, text: `--- @/${file} ---\n${code.slice(0, 8000)}`, kind: 'file' }
      : null;
  }

  /** Collect a summary of recent git-style changes from the checkpoint review API. */
  async function changesContext() {
    try {
      const r = await Bob.api('/bob/review');
      if (!r.changes || !r.changes.length) return null;
      const lines = r.changes.map((c) => `${c.status.padEnd(9)} ${c.name} (+${c.added}/-${c.removed})`);
      const base = r.base ? `since checkpoint ${r.base.short} (${r.base.label})` : 'initial state';
      return { label: '@git-changes', text: `--- @git-changes (${base}) ---\n${lines.join('\n')}`, kind: 'git' };
    } catch (_) {
      return null;
    }
  }

  /**
   * Run a quick action:
   *  1. Ensure gateway is connected.
   *  2. Gather context (IDE selection / file / git changes).
   *  3. Make the Bob sidebar visible.
   *  4. Attach context pill(s) to the next Bob message.
   *  5. Send the prompt.
   */
  async function runAction(btn, prompt, { useGitChanges = false } = {}) {
    // Gateway guard — show a single deduplicated toast (the same pattern as requireConn in chat.js).
    if (!Bob.isConnected || !Bob.isConnected()) {
      Bob.toast('Please click "Connect Gateway" first.', 'error');
      return;
    }

    // Disable all quick-action buttons during the send so the user cannot queue
    // multiple simultaneous requests from this panel.
    const all = document.querySelectorAll('.bqa-btn');
    const originalLabel = btn.querySelector('span:last-child').textContent;
    all.forEach((b) => { b.disabled = true; });
    btn.querySelector('span:last-child').textContent = '…';
    btn.setAttribute('aria-busy', 'true');

    try {
      // Attach editor context as a pill.
      const ctx = ideContext();
      if (ctx) Bob.chat.addContext(ctx);

      // Attach git-changes context for commit message and review actions.
      if (useGitChanges && Bob.can('ide:read')) {
        const gc = await changesContext();
        if (gc) Bob.chat.addContext(gc);
      }

      // Make the Bob sidebar visible so the user can see the reply.
      Bob.layout.show('secondary');

      // Send the prompt through the normal chat pipeline.
      await Bob.chat.send(prompt);
    } catch (err) {
      Bob.errorToast(err);
    } finally {
      all.forEach((b) => { b.disabled = false; });
      btn.querySelector('span:last-child').textContent = originalLabel;
      btn.removeAttribute('aria-busy');
    }
  }

  // ── Quick Action button definitions ─────────────────────────────────────────
  // Each entry: [buttonId, promptText, options]
  const ACTIONS = [
    [
      'bqa-explain',
      'Explain what this code does, covering its purpose, inputs, outputs, and any notable patterns or side-effects.',
      {}
    ],
    [
      'bqa-fix',
      'Identify any bugs, errors, or issues in this code and provide the corrected version with a brief explanation of each fix.',
      {}
    ],
    [
      'bqa-improve',
      'Suggest concrete improvements to this code: performance, readability, maintainability, and adherence to best practices. Provide the improved version.',
      {}
    ],
    [
      'bqa-tests',
      'Generate comprehensive unit tests for this code. Use the same testing framework already present in the project (Jest, Mocha, pytest, JUnit, etc.) and cover all public functions, edge cases, and error paths.',
      {}
    ],
    [
      'bqa-docs',
      'Generate complete JSDoc / docstring documentation for every public function, class, and module export in this code. Follow the language conventions for the file type.',
      {}
    ],
    [
      'bqa-commit',
      'Write a conventional git commit message (type(scope): subject + body) for the changes shown in the context. Follow the Conventional Commits specification.',
      { useGitChanges: true }
    ],
    [
      'bqa-review',
      'Perform a thorough code review of this file. Comment on correctness, security, performance, naming, code style, and any potential edge cases. Be specific and actionable.',
      {}
    ]
  ];

  // ── init ─────────────────────────────────────────────────────────────────────
  Bob.bobActions = {
    init() {
      // Wire each quick-action button.
      ACTIONS.forEach(([id, prompt, opts]) => {
        const btn = $(`#${id}`);
        if (!btn) return;
        btn.addEventListener('click', () => runAction(btn, prompt, opts));
      });

      // New Task delegates directly to Bob.chat.newTask (no gateway needed).
      const newtaskBtn = $('#bqa-newtask');
      if (newtaskBtn) {
        newtaskBtn.addEventListener('click', () => {
          Bob.chat.newTask(false);
          Bob.layout.show('secondary');
        });
      }

      // Disable all buttons until the gateway connects; re-enable on connection.
      function applyConnState() {
        const connected = Bob.isConnected ? Bob.isConnected() : false;
        document.querySelectorAll('.bqa-btn:not(#bqa-newtask)').forEach((b) => {
          // Only update disabled state when not in-flight (aria-busy guards that).
          if (!b.getAttribute('aria-busy')) b.disabled = !connected;
          if (!connected) b.setAttribute('title', 'Connect the gateway first (left panel)');
          else b.removeAttribute('title');
        });
      }

      // Re-apply on connection state changes.
      Bob.on('connection', applyConnState);
      // Also apply once on session load (by which point isConnected is available).
      Bob.on('session', applyConnState);
      applyConnState();
    }
  };
})();
