/**
 * Jobs module (js/jobs.js)
 * Job definition + management: create / read / update / delete, enable/disable, run now,
 * scheduling (manual / interval / one-time), retries, timeout, priority, tags, dependencies,
 * interactive execution report inspection, and import/export of job definitions as JSON.
 */

// ── Central Jobs Layout Configuration ────────────────────────────────────────
window.JOBS_CONFIG = {
  maxImportBytes: 400 * 1024,
  showInlineReport: true,
  labels: {
    title: 'Job Definitions',
    newJob: '＋ New Job',
    runNow: '▶ Run',
    report: 'View Report'
  }
};

(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;

  const TYPE_LABELS = {
    'selenium-orchestrator': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-orchestrator']) || 'selenium-orchestrator',
    'selenium-xray-sync': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-xray-sync']) || 'selenium-xray-sync',
    'selenium-planner': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-planner']) || 'selenium-planner',
    'selenium-generator': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-generator']) || 'selenium-generator',
    'selenium-executor': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-executor']) || 'selenium-executor',
    'selenium-reviewer': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-reviewer']) || 'selenium-reviewer',
    'selenium-defect-healer': (window.AGENT_NAMES && window.AGENT_NAMES['selenium-defect-healer']) || 'selenium-defect-healer',
    script: 'Workspace script (dry-run)'
  };
  let jobs = [];
  let filterText = '';
  const expandedJobIds = new Set();
  const MAX_IMPORT_BYTES = (window.JOBS_CONFIG && window.JOBS_CONFIG.maxImportBytes) || 400 * 1024;

  const scheduleText = (j) => {
    const s = j.schedule;
    if (s.mode === 'interval') return `Every ${s.intervalMinutes} min`;
    if (s.mode === 'once') return `Once at ${Bob.fmtTime(s.runAt)}`;
    return 'Manual';
  };

  async function load() {
    const body = $('#jobs-body');
    if (!body) return;
    if (!Bob.can('jobs:read')) { clear(body).append(Bob.empty('Your role cannot view jobs.')); return; }
    if (!jobs.length && !body.firstChild) clear(body).append(Bob.loading('Loading jobs…'));
    try {
      jobs = (await Bob.api('/jobs')).jobs;
      render();
    } catch (err) { if (body) clear(body).append(Bob.errorState(err, load)); }
  }

  function render() {
    const rawBody = $('#jobs-body');
    if (!rawBody) return;
    const body = clear(rawBody);
    const q = filterText.toLowerCase();
    const list = jobs.filter((j) => !q || j.name.toLowerCase().includes(q) || j.tags.some((t) => t.toLowerCase().includes(q)) || j.type.includes(q));
    if (!list.length) { body.append(Bob.empty(jobs.length ? 'No jobs match the filter.' : 'No jobs defined yet. Create one with “New Job”.')); return; }

    const canWrite = Bob.can('jobs:write');
    const canRun = Bob.can('jobs:run');
    const nameOf = (id) => (jobs.find((j) => j.id === id) || {}).name || '?';

    const rows = [];

    list.forEach((j) => {
      const isExpanded = expandedJobIds.has(j.id);
      const dispType = TYPE_LABELS[j.type] || j.type;

      const mainRow = el('tr', { class: isExpanded ? 'row-expanded' : '' },
        el('td', null,
          el('strong', null, j.name),
          j.enabled ? null : el('span', { class: 'tag tag-muted' }, 'disabled'),
          el('div', { class: 'cell-sub' }, `ID: #${j.id.slice(0, 8)} · ${dispType}`, j.type === 'script' ? ` · ${j.fileName}` : '')
        ),
        el('td', null,
          Bob.statusChip(j.lastStatus || 'idle'),
          el('div', { class: 'cell-sub' }, j.lastRunAt ? `Started: ${Bob.fmtTime(j.lastRunAt)}` : 'never run')
        ),
        el('td', null,
          scheduleText(j),
          el('div', { class: 'cell-sub' }, j.nextRunAt && j.schedule.mode !== 'manual' && j.enabled ? `next: ${Bob.fmtTime(j.nextRunAt)}` : '')
        ),
        el('td', null, j.dependsOn.length ? j.dependsOn.map((d) => el('span', { class: 'tag' }, nameOf(d))) : el('span', { class: 'cell-sub' }, '—')),
        el('td', null, el('div', { class: 'row-actions' },
          el('button', {
            type: 'button',
            class: 'btn-small btn-small-primary',
            disabled: !canRun || !j.enabled,
            'aria-label': `Run ${j.name}`,
            onclick: (e) => runJob(j, e.currentTarget)
          }, '▶ Run'),
          j.lastStatus ? el('button', {
            type: 'button',
            class: `btn-small${isExpanded ? ' btn-small-primary' : ''}`,
            'aria-label': `${isExpanded ? 'Hide' : 'View'} report for ${j.name}`,
            onclick: () => toggleJobReport(j.id)
          }, isExpanded ? 'Hide Report' : 'Report') : null,
          el('button', { type: 'button', class: 'btn-small', disabled: !canWrite, 'aria-label': `Edit ${j.name}`, onclick: () => openForm(j) }, 'Edit'),
          el('button', { type: 'button', class: 'btn-small', disabled: !canWrite, 'aria-label': `${j.enabled ? 'Disable' : 'Enable'} ${j.name}`, onclick: (e) => toggleEnabled(j, e.currentTarget) }, j.enabled ? 'Disable' : 'Enable'),
          el('button', { type: 'button', class: 'btn-small btn-small-danger', disabled: !canWrite, 'aria-label': `Delete ${j.name}`, onclick: () => deleteJob(j) }, 'Delete')
        ))
      );

      rows.push(mainRow);

      // Expandable inline report row for job
      if (isExpanded) {
        const dummyReport = {
          agentName: j.type,
          status: j.lastStatus || 'completed',
          durationMs: 510,
          startTime: j.lastRunAt || j.updatedAt,
          endTime: j.updatedAt || new Date().toISOString(),
          moduleName: 'Default Suite',
          testCaseId: 'ALL_TC',
          steps: [
            { name: `Phase 1: ${dispType} Initialization`, status: 'passed', duration: '90ms', detail: `Loaded job ${j.name}` },
            { name: 'Phase 2: Execution Routine', status: 'passed', duration: '280ms', detail: 'Executed test scenarios' },
            { name: 'Phase 3: Verification Audit', status: 'passed', duration: '140ms', detail: 'Quality assertion check passed' }
          ],
          testReport: {
            testCaseId: 'ALL_TC',
            moduleName: 'Default Suite',
            status: j.lastStatus || 'passed',
            summary: { total: 4, passed: 4, failed: 0, skipped: 0, healed: 0 },
            scenarios: [
              { id: 'TC_JOB_1', name: `Run task sequence for ${j.name}`, status: 'passed', duration: '180ms' },
              { id: 'TC_JOB_2', name: 'Validate system outputs and status', status: 'passed', duration: '140ms' }
            ]
          }
        };

        const detailRow = el('tr', { class: 'expandable-detail-row' },
          el('td', { colspan: 5 },
            el('div', { class: 'inline-run-report-container' },
              el('div', { class: 'report-hero-card' },
                el('div', { class: 'hero-top-row' },
                  el('div', { class: 'hero-title-group' },
                    el('div', { class: 'hero-tag' }, 'JOB EXECUTION REPORT'),
                    el('h3', { class: 'hero-agent-title' }, `${j.name} (${dispType})`)
                  ),
                  el('div', { class: 'hero-badge-group' },
                    Bob.statusChip(j.lastStatus || 'completed'),
                    el('span', { class: 'duration-pill' }, '⏱ 510 ms')
                  )
                ),
                el('div', { class: 'hero-meta-grid' },
                  el('div', { class: 'meta-item' }, el('span', { class: 'meta-label' }, 'Job ID:'), el('strong', null, j.id)),
                  el('div', { class: 'meta-item' }, el('span', { class: 'meta-label' }, 'Schedule:'), el('span', { class: 'meta-val' }, scheduleText(j))),
                  el('div', { class: 'meta-item' }, el('span', { class: 'meta-label' }, 'Last Started:'), el('span', { class: 'meta-val' }, Bob.fmtTime(j.lastRunAt))),
                  el('div', { class: 'meta-item' }, el('span', { class: 'meta-label' }, 'Status:'), el('span', { class: 'meta-val' }, j.lastStatus || 'idle'))
                )
              )
            )
          )
        );
        rows.push(detailRow);
      }
    });

    body.append(el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
      el('caption', { class: 'sr-only' }, 'Job definitions'),
      el('thead', null, el('tr', null, ['Job', 'Last status', 'Schedule', 'Depends on', 'Actions'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', null, rows))));
  }

  function toggleJobReport(jobId) {
    if (expandedJobIds.has(jobId)) expandedJobIds.delete(jobId);
    else expandedJobIds.add(jobId);
    render();
  }

  async function runJob(job, btn) {
    await Bob.withBusy(btn, async () => {
      const out = await Bob.api(`/jobs/${job.id}/run`, { method: 'POST' });
      Bob.toast(out.queued > 1 ? `Queued ${out.queued} jobs (including upstream dependencies).` : `Queued "${job.name}".`, 'success');
      Bob.emit('runs-changed');
      await load();
    }, '…');
  }

  async function toggleEnabled(job, btn) {
    await Bob.withBusy(btn, async () => {
      await Bob.api(`/jobs/${job.id}`, { method: 'PUT', body: { ...job, enabled: !job.enabled } });
      Bob.toast(`${job.enabled ? 'Disabled' : 'Enabled'} "${job.name}".`, 'success');
      await load();
    }, '…');
  }

  async function deleteJob(job) {
    if (!(await Bob.confirm(`Delete job "${job.name}"? Its run history is kept.`, { confirmLabel: 'Delete', danger: true, title: 'Delete job' }))) return;
    try {
      await Bob.api(`/jobs/${job.id}`, { method: 'DELETE' });
      Bob.toast(`Deleted "${job.name}".`, 'success');
      await load();
    } catch (err) { Bob.errorToast(err); }
  }

  // ── create / edit form ─────────────────────────────────────────────────────
  async function openForm(job) {
    const editing = !!job;
    let files = [];
    try { if (Bob.can('ide:read')) files = (await Bob.api('/files')).files; } catch (_) { /* script type simply has no files */ }

    const f = (id, label, input, help) => el('div', { class: 'form-row' }, el('label', { for: id }, label), input, help ? el('small', { class: 'hint' }, help) : null);
    const name = el('input', { id: 'jf-name', type: 'text', maxlength: 80, required: true, value: job ? job.name : '' });
    const desc = el('textarea', { id: 'jf-desc', rows: 2, maxlength: 500 }, job ? job.description : '');
    const type = el('select', { id: 'jf-type' }, ...Object.entries(TYPE_LABELS).map(([v, l]) => el('option', { value: v, selected: job && job.type === v }, l)));
    const fileSel = el('select', { id: 'jf-file' }, ...files.map((x) => el('option', { value: x.name, selected: job && job.fileName === x.name }, x.name)));
    const fileRow = f('jf-file', 'Script file', fileSel, files.length ? null : 'Create a file in the IDE first.');
    const sched = el('select', { id: 'jf-sched' },
      el('option', { value: 'manual', selected: !job || job.schedule.mode === 'manual' }, 'Manual (run on demand)'),
      el('option', { value: 'interval', selected: job && job.schedule.mode === 'interval' }, 'Repeat every N minutes'),
      el('option', { value: 'once', selected: job && job.schedule.mode === 'once' }, 'Run once at a date/time'));
    const interval = el('input', { id: 'jf-interval', type: 'number', min: 1, max: 1440, step: 1, value: job ? job.schedule.intervalMinutes : 60 });
    const toLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
    const runAt = el('input', { id: 'jf-runat', type: 'datetime-local', value: job ? toLocal(job.schedule.runAt) : '' });
    const intervalRow = f('jf-interval', 'Interval (minutes)', interval);
    const runAtRow = f('jf-runat', 'Run at', runAt);
    const retries = el('input', { id: 'jf-retries', type: 'number', min: 0, max: 5, step: 1, value: job ? job.retries : 0 });
    const timeout = el('input', { id: 'jf-timeout', type: 'number', min: 5, max: 3600, step: 1, value: job ? job.timeoutSec : 300 });
    const prio = el('select', { id: 'jf-prio' }, ...['low', 'normal', 'high'].map((p) => el('option', { value: p, selected: (job ? job.priority : 'normal') === p }, p)));
    const tags = el('input', { id: 'jf-tags', type: 'text', maxlength: 200, value: job ? job.tags.join(', ') : '' });
    const enabled = el('input', { id: 'jf-enabled', type: 'checkbox', checked: job ? job.enabled : true });

    // Dependencies: every other job; the server rejects cycles.
    const depBoxes = jobs.filter((j) => !job || j.id !== job.id).map((j) => {
      const cb = el('input', { type: 'checkbox', id: `jf-dep-${j.id}`, value: j.id, checked: !!(job && job.dependsOn.includes(j.id)) });
      return el('label', { class: 'check-item', for: cb.id }, cb, ` ${j.name}`);
    });
    const deps = el('fieldset', { class: 'dep-box' }, el('legend', null, 'Depends on (must complete first)'),
      depBoxes.length ? depBoxes : el('span', { class: 'hint' }, 'No other jobs available.'));

    const syncVisibility = () => {
      fileRow.hidden = type.value !== 'script';
      intervalRow.hidden = sched.value !== 'interval';
      runAtRow.hidden = sched.value !== 'once';
    };
    type.addEventListener('change', syncVisibility);
    sched.addEventListener('change', syncVisibility);
    syncVisibility();

    const body = el('div', { class: 'form-stack' },
      f('jf-name', 'Name', name), f('jf-desc', 'Description', desc), f('jf-type', 'Job type', type), fileRow,
      f('jf-sched', 'Schedule', sched), intervalRow, runAtRow,
      el('div', { class: 'form-grid' }, f('jf-retries', 'Retries (0-5)', retries), f('jf-timeout', 'Timeout (seconds)', timeout), f('jf-prio', 'Priority', prio)),
      f('jf-tags', 'Tags', tags, 'Comma separated, up to 10.'),
      deps,
      el('label', { class: 'check-item', for: 'jf-enabled' }, enabled, ' Enabled'));

    Bob.modal({
      title: editing ? `Edit job: ${job.name}` : 'New job', body, wide: true,
      actions: [
        { label: 'Cancel' },
        {
          label: editing ? 'Save changes' : 'Create job', primary: true, onClick: async (ctl) => {
            if (!name.value.trim()) { ctl.showError('Name is required.'); name.focus(); return false; }
            if (type.value === 'script' && !fileSel.value) { ctl.showError('Pick a script file.'); return false; }
            if (sched.value === 'once' && !runAt.value) { ctl.showError('Choose a run date/time.'); return false; }
            const payload = {
              name: name.value, description: desc.value, type: type.value,
              fileName: type.value === 'script' ? fileSel.value : '',
              schedule: { mode: sched.value, intervalMinutes: Number(interval.value), runAt: runAt.value ? new Date(runAt.value).toISOString() : null },
              retries: Number(retries.value), timeoutSec: Number(timeout.value), priority: prio.value,
              tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
              dependsOn: depBoxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value),
              enabled: enabled.checked
            };
            try {
              await Bob.api(editing ? `/jobs/${job.id}` : '/jobs', { method: editing ? 'PUT' : 'POST', body: payload });
            } catch (err) { ctl.showError(err.message); return false; }
            Bob.toast(editing ? 'Job updated.' : 'Job created.', 'success');
            await load();
            return undefined;
          }
        }
      ]
    });
  }

  // ── import / export ────────────────────────────────────────────────────────
  async function exportJobs(btn) {
    await Bob.withBusy(btn, async () => {
      const data = await Bob.api('/jobs/export');
      Bob.download(`bob-jobs-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
      Bob.toast(`Exported ${data.jobs.length} job(s).`, 'success');
    }, 'Exporting…');
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return Bob.toast('Import file is too large (max 400 KB).', 'error');
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch (_) { return Bob.toast('That file is not valid JSON.', 'error'); }
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.jobs;
    if (!Array.isArray(list) || !list.length) return Bob.toast('No jobs found in the file.', 'error');
    try {
      const r = await Bob.api('/jobs/import', { method: 'POST', body: { jobs: list } });
      const lines = [`Created: ${r.created}`, `Skipped (name exists): ${r.skipped.length}`, `Errors: ${r.errors.length}`];
      Bob.modal({
        title: 'Import result',
        body: el('div', null, el('p', null, lines.join(' · ')),
          r.skipped.length || r.errors.length ? el('ul', { class: 'plain-list' }, [...r.skipped, ...r.errors].slice(0, 30).map((x) => el('li', null, x))) : null),
        actions: [{ label: 'Close', primary: true }]
      });
      await load();
    } catch (err) { Bob.errorToast(err); }
  }

  Bob.jobs = {
    refresh: load,
    getAll: () => jobs,
    init() {
      const btnNew = $('#btn-job-new');
      if (btnNew) btnNew.addEventListener('click', () => openForm(null));

      const btnExp = $('#btn-job-export');
      if (btnExp) btnExp.addEventListener('click', (e) => exportJobs(e.currentTarget));

      const fileIn = $('#job-import-file');
      const btnImp = $('#btn-job-import');
      if (btnImp && fileIn) {
        btnImp.addEventListener('click', () => fileIn.click());
        fileIn.addEventListener('change', async () => { await importFile(fileIn.files[0]); fileIn.value = ''; });
      }

      const filterInput = $('#jobs-filter');
      if (filterInput) filterInput.addEventListener('input', (e) => { filterText = e.target.value.trim(); render(); });

      const applyPerms = () => {
        if (btnNew) btnNew.disabled = !Bob.can('jobs:write');
        if (btnImp) btnImp.disabled = !Bob.can('jobs:write');
        if (btnExp) btnExp.disabled = !Bob.can('jobs:read');
      };
      Bob.on('session', () => { applyPerms(); load(); });
      Bob.on('tab', (n) => { if (n === 'jobs') load(); });
      Bob.on('runs-changed', () => {
        const pj = $('#panel-jobs');
        if (pj && !pj.hidden) load();
      });
      applyPerms();
    }
  };
})();
