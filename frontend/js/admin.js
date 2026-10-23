/**
 * NEW: Administration module (js/admin.js)
 *  - Settings tab: REST API / connection configuration (with "Test connection"),
 *    environment & resource configuration (incl. env variables), notification preferences.
 *  - Roles tab: active-role switcher + per-role permission matrix (RBAC).
 * The server enforces every permission; the UI only enables/disables controls for clarity.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;

  const PERM_LABELS = {
    'jobs:read': 'View jobs', 'jobs:write': 'Create / edit / delete jobs', 'jobs:run': 'Trigger jobs',
    'runs:read': 'View runs & logs', 'runs:cancel': 'Cancel runs',
    'ide:read': 'Read workspace files', 'ide:edit': 'Edit workspace files (IDE Edit menu)',
    'notifications:read': 'View notifications',
    'settings:read': 'View settings', 'settings:write': 'Change settings',
    'roles:manage': 'Manage roles & permissions'
  };

  // ── Settings tab ───────────────────────────────────────────────────────────
  // NOTE: The Settings tab was removed (change #1). This function is kept for
  // reference but #settings-body no longer exists in the DOM, so we guard.
  async function loadSettings() {
    const body = $('#settings-body');
    if (!body) return; // Settings tab removed — no-op when element is absent
    if (!Bob.can('settings:read')) { clear(body).append(Bob.empty('Your role cannot view settings.')); return; }
    if (!body.firstChild) body.append(Bob.loading());
    try {
      const { settings } = await Bob.api('/settings');
      Bob.timeoutMs = settings.connection.timeoutMs;
      Bob.pollSec = settings.connection.pollIntervalSec;
      renderSettings(settings);
    } catch (err) { clear(body).append(Bob.errorState(err, loadSettings)); }
  }

  function renderSettings(s) {
    const body = clear($('#settings-body'));
    const canWrite = Bob.can('settings:write');
    const row = (id, label, input, help) => el('div', { class: 'form-row' }, el('label', { for: id }, label), input, help ? el('small', { class: 'hint' }, help) : null);
    const num = (id, v, min, max) => el('input', { id, type: 'number', value: v, min, max, step: 1, disabled: !canWrite });
    const chk = (id, v) => el('input', { id, type: 'checkbox', checked: v, disabled: !canWrite });

    // Connection (REST API)
    const baseUrl = el('input', { id: 'st-base', type: 'url', value: s.connection.baseUrl, maxlength: 200, disabled: !canWrite, autocomplete: 'off' });
    const timeoutMs = num('st-timeout', s.connection.timeoutMs, 1000, 120000);
    const pollSec = num('st-poll', s.connection.pollIntervalSec, 1, 60);
    const testOut = el('span', { class: 'hint', role: 'status' });
    const testBtn = el('button', { type: 'button', class: 'btn-small' }, 'Test connection');
    testBtn.addEventListener('click', () => Bob.withBusy(testBtn, async () => {
      const t0 = performance.now();
      try {
        await Bob.api('/health', { timeoutMs: Number(timeoutMs.value) || 15000 });
        testOut.textContent = `Healthy (${Math.round(performance.now() - t0)} ms)`;
      } catch (err) { testOut.textContent = `Failed: ${err.message}`; }
    }, 'Testing…'));

    // Environment & resources
    const envName = el('select', { id: 'st-env', disabled: !canWrite }, ...['dev', 'test', 'prod'].map((n) => el('option', { value: n, selected: s.environment.name === n }, n)));
    const maxConc = num('st-conc', s.environment.maxConcurrent, 1, 8);
    const defTimeout = num('st-deftimeout', s.environment.defaultTimeoutSec, 10, 3600);
    const mem = num('st-mem', s.environment.memoryMb, 256, 16384);

    // Environment variables editor
    const varsBox = el('div', { class: 'vars-box' });
    const addVarRow = (k = '', v = '') => {
      const key = el('input', { type: 'text', 'aria-label': 'Variable name', value: k, maxlength: 64, placeholder: 'NAME', disabled: !canWrite });
      const val = el('input', { type: 'text', 'aria-label': 'Variable value', value: v, maxlength: 256, placeholder: 'value', disabled: !canWrite });
      const rm = el('button', { type: 'button', class: 'btn-small btn-small-danger', 'aria-label': 'Remove variable', disabled: !canWrite }, '×');
      const r = el('div', { class: 'var-row' }, key, val, rm);
      rm.addEventListener('click', () => r.remove());
      varsBox.append(r);
    };
    s.environment.vars.forEach((x) => addVarRow(x.key, x.value));

    // Notification preferences
    const nFail = chk('st-nfail', s.notifications.onFailure);
    const nOk = chk('st-nok', s.notifications.onSuccess);
    const nStart = chk('st-nstart', s.notifications.onStart);

    const saveBtn = el('button', { type: 'button', class: 'btn-small btn-small-primary', disabled: !canWrite }, 'Save settings');
    saveBtn.addEventListener('click', () => Bob.withBusy(saveBtn, async () => {
      const vars = [...varsBox.querySelectorAll('.var-row')].map((r) => { const [k, v] = r.querySelectorAll('input'); return { key: k.value.trim(), value: v.value }; }).filter((x) => x.key || x.value);
      const payload = {
        connection: { baseUrl: baseUrl.value.trim(), timeoutMs: Number(timeoutMs.value), pollIntervalSec: Number(pollSec.value) },
        environment: { name: envName.value, maxConcurrent: Number(maxConc.value), defaultTimeoutSec: Number(defTimeout.value), memoryMb: Number(mem.value), vars },
        notifications: { onFailure: nFail.checked, onSuccess: nOk.checked, onStart: nStart.checked }
      };
      await Bob.api('/settings', { method: 'PUT', body: payload });
      Bob.toast('Settings saved.', 'success');
      await loadSettings();
    }, 'Saving…'));

    body.append(
      el('fieldset', { class: 'card' }, el('legend', null, 'REST API / connection'),
        row('st-base', 'Base URL', baseUrl, 'https:// required (http:// allowed only for localhost). Never put credentials in the URL; the API key stays in the left panel.'),
        el('div', { class: 'form-grid' }, row('st-timeout', 'Request timeout (ms)', timeoutMs), row('st-poll', 'Poll interval (s)', pollSec)),
        el('div', { class: 'toolbar-actions' }, testBtn, testOut)),
      el('fieldset', { class: 'card' }, el('legend', null, 'Environment & resources'),
        el('div', { class: 'form-grid' }, row('st-env', 'Environment', envName), row('st-conc', 'Max concurrent runs', maxConc), row('st-deftimeout', 'Default timeout (s)', defTimeout), row('st-mem', 'Memory limit (MB)', mem)),
        el('div', { class: 'form-row' }, el('span', { class: 'label-like', id: 'vars-label' }, 'Environment variables'),
          el('small', { class: 'hint' }, 'Do not store secrets here; names containing SECRET, TOKEN, PASSWORD or KEY are rejected.'), varsBox,
          el('button', { type: 'button', class: 'btn-small', disabled: !canWrite, onclick: () => addVarRow() }, '＋ Add variable'))),
      el('fieldset', { class: 'card' }, el('legend', null, 'Notifications'),
        el('label', { class: 'check-item', for: 'st-nfail' }, nFail, ' Alert when a job fails'),
        el('label', { class: 'check-item', for: 'st-nok' }, nOk, ' Alert when a job completes'),
        el('label', { class: 'check-item', for: 'st-nstart' }, nStart, ' Alert when a job starts')),
      el('div', { class: 'toolbar-actions' }, saveBtn, canWrite ? null : el('span', { class: 'hint' }, 'Read-only: your role lacks settings:write.')));
  }

  // ── Roles tab ──────────────────────────────────────────────────────────────
  // NOTE: The Roles tab was removed (change #2). Kept for reference only.
  async function loadRoles() {
    const body = $('#roles-body');
    if (!body) return; // Roles tab removed — no-op when element is absent
    if (!body.firstChild) body.append(Bob.loading());
    try {
      const canManage = Bob.can('roles:manage');
      const matrix = canManage ? await Bob.api('/roles') : null;
      clear(body);

      // Active role switcher (demo sign-in; production must use SAML / OIDC SSO)
      const sel = el('select', { id: 'role-switch' }, ...Bob.session.roles.map((r) => el('option', { value: r, selected: r === Bob.session.role }, r)));
      const apply = el('button', { type: 'button', class: 'btn-small btn-small-primary' }, 'Switch role');
      apply.addEventListener('click', () => Bob.withBusy(apply, async () => {
        await Bob.api('/session/role', { method: 'PUT', body: { role: sel.value } });
        await Bob.loadSession();
        Bob.toast(`Now acting as ${sel.value}.`, 'success');
        await loadRoles();
      }, 'Switching…'));
      body.append(el('fieldset', { class: 'card' }, el('legend', null, 'Active role'),
        el('p', { class: 'hint' }, 'Simulated sign-in for this local workspace. A production deployment must authenticate users via SAML or OpenID Connect and map them to these roles. Stepping up to a more privileged role requires roles:manage.'),
        el('div', { class: 'toolbar-actions' }, el('label', { for: 'role-switch' }, 'Role'), sel, apply)));

      if (!canManage) { body.append(Bob.empty('Your role cannot manage permissions.')); return; }

      // Permission matrix: rows = permissions, columns = roles. Admin column is fixed.
      const roles = Bob.session.roles;
      const boxes = {};
      const head = el('tr', null, el('th', { scope: 'col' }, 'Permission'), roles.map((r) => el('th', { scope: 'col' }, r)));
      const rows = matrix.all.map((p) => el('tr', null,
        el('th', { scope: 'row' }, PERM_LABELS[p] || p, el('div', { class: 'cell-sub' }, p)),
        roles.map((r) => {
          const cb = el('input', {
            type: 'checkbox', checked: matrix.roles[r].includes(p), disabled: r === 'admin',
            'aria-label': `${r} can ${PERM_LABELS[p] || p}`
          });
          (boxes[r] = boxes[r] || {})[p] = cb;
          return el('td', { class: 'cell-center' }, cb);
        })));
      const save = el('button', { type: 'button', class: 'btn-small btn-small-primary' }, 'Save permissions');
      save.addEventListener('click', () => Bob.withBusy(save, async () => {
        for (const r of roles.filter((x) => x !== 'admin')) {
          const permissions = matrix.all.filter((p) => boxes[r][p].checked);
          await Bob.api(`/roles/${r}`, { method: 'PUT', body: { permissions } });
        }
        await Bob.loadSession(); // the active role's own permissions may have changed
        Bob.toast('Permissions saved.', 'success');
        await loadRoles();
      }, 'Saving…'));
      body.append(el('fieldset', { class: 'card' }, el('legend', null, 'Role permissions'),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data-table perm-table' }, el('caption', { class: 'sr-only' }, 'Permission matrix'), el('thead', null, head), el('tbody', null, rows))),
        el('div', { class: 'toolbar-actions' }, save, el('span', { class: 'hint' }, 'The admin role always has every permission.'))));
    } catch (err) { clear(body).append(Bob.errorState(err, loadRoles)); }
  }

  // Settings and Roles tabs removed from UI (changes #1 and #2).
  // admin.js is kept for its loadSettings() helper (used by app.js boot) but the
  // tab listeners and the Roles panel are no longer wired to any visible tab.
  Bob.admin = {
    init() {
      // No tab listeners needed — Settings and Roles tabs have been removed.
    },
    loadSettings
  };
})();
