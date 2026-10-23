/**
 * Docs & Defect Healing Reports module (js/docs.js)
 * Loads, parses, and interactively renders defect healing reports,
 * Xray mappings, and test case documentation from the repo-root docs/ folder.
 */
(function () {
  'use strict';
  const Bob = window.Bob;
  const { el, clear, $ } = Bob;

  let currentFile = 'defect-healing/DefectHealingReport-2026-10-13.md';
  let currentDocData = null;
  let viewMode = 'formatted'; // 'formatted' | 'raw'
  let isRefreshing = false;

  // ── Markdown Parser (Safe, structured DOM builder) ──────────────────────────
  function parseMarkdownToDOM(mdText) {
    const container = el('div', { class: 'docs-report-view' });
    const lines = mdText.split(/\r?\n/);
    let i = 0;

    // Report Header / Metadata Accumulator
    let reportTitle = 'Documentation Report';
    const metadata = {};
    const sections = [];
    let currentSection = null;

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('# ')) {
        reportTitle = line.replace(/^#\s+/, '').trim();
        i++;
        continue;
      }

      // Metadata lines like **Run Date**: 2026-10-13
      const metaMatch = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
      if (metaMatch && !currentSection) {
        metadata[metaMatch[1].trim()] = metaMatch[2].trim();
        i++;
        continue;
      }

      // Section Headings (## Heading)
      if (line.startsWith('## ')) {
        currentSection = {
          title: line.replace(/^##\s+/, '').trim(),
          items: []
        };
        sections.push(currentSection);
        i++;
        continue;
      }

      // Tables (| Col 1 | Col 2 |)
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          tableLines.push(lines[i].trim());
          i++;
        }
        if (currentSection) {
          currentSection.items.push({ type: 'table', lines: tableLines });
        }
        continue;
      }

      // Bullet points
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        const bulletLines = [];
        while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* ') || (lines[i].startsWith('  ') && lines[i].trim()))) {
          bulletLines.push(lines[i].trim());
          i++;
        }
        if (currentSection) {
          currentSection.items.push({ type: 'bullets', lines: bulletLines });
        }
        continue;
      }

      // Paragraph / text
      if (line.trim()) {
        if (currentSection) {
          currentSection.items.push({ type: 'text', text: line.trim() });
        }
      }

      i++;
    }

    // 1. Build Header Hero Card
    const metaEntries = Object.entries(metadata);
    const heroCard = el('div', { class: 'report-hero-card docs-hero-card', 'data-testid': 'docs-hero' },
      el('div', { class: 'hero-top-row' },
        el('div', { class: 'hero-title-group' },
          el('div', { class: 'hero-tag' }, 'SELENIUM DEFECT HEALING REPORT'),
          el('h3', { class: 'hero-agent-title', 'data-testid': 'docs-hero-title' }, reportTitle)
        ),
        el('div', { class: 'hero-badge-group' },
          el('span', { class: 'status-chip status-completed' }, '✓ Healed'),
          el('span', { class: 'duration-pill' }, '📅 2026-10-13')
        )
      ),
      metaEntries.length ? el('div', { class: 'hero-meta-grid' },
        ...metaEntries.map(([k, v]) => el('div', { class: 'meta-item' },
          el('span', { class: 'meta-label' }, `${k}:`),
          el('strong', null, v)
        ))
      ) : null
    );
    container.append(heroCard);

    // 2. Build Sections
    sections.forEach((sec) => {
      const secCard = el('div', { class: 'report-section-card', 'data-testid': 'docs-section' },
        el('div', { class: 'section-card-header' },
          el('h4', null, sec.title)
        )
      );

      sec.items.forEach((item) => {
        if (item.type === 'table') {
          secCard.append(renderMarkdownTable(item.lines));
        } else if (item.type === 'bullets') {
          const ul = el('ul', { class: 'docs-bullet-list' });
          item.lines.forEach((b) => {
            const clean = b.replace(/^[-*]\s+/, '');
            ul.append(el('li', null, renderInlineFormatting(clean)));
          });
          secCard.append(ul);
        } else if (item.type === 'text') {
          if (item.text.toLowerCase().startsWith('evidence:')) {
            secCard.append(el('div', { class: 'docs-evidence-box' },
              el('span', { class: 'evidence-badge' }, 'EVIDENCE'),
              el('p', null, renderInlineFormatting(item.text.replace(/^evidence:\s*/i, '')))
            ));
          } else {
            secCard.append(el('p', { class: 'docs-paragraph' }, renderInlineFormatting(item.text)));
          }
        }
      });

      container.append(secCard);
    });

    return container;
  }

  function renderInlineFormatting(text) {
    const span = el('span', null);
    // Parse `code`, **bold**, [link](url)
    const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    tokens.forEach((tok) => {
      if (tok.startsWith('`') && tok.endsWith('`')) {
        span.append(el('code', { class: 'inline-code' }, tok.slice(1, -1)));
      } else if (tok.startsWith('**') && tok.endsWith('**')) {
        span.append(el('strong', null, tok.slice(2, -2)));
      } else if (tok) {
        span.append(document.createTextNode(tok));
      }
    });
    return span;
  }

  function renderMarkdownTable(tableLines) {
    if (tableLines.length < 2) return el('div', null);

    const parseRow = (line) => line.split('|').slice(1, -1).map(c => c.trim());
    const headers = parseRow(tableLines[0]);
    const rows = tableLines.slice(2).map(parseRow);

    const thead = el('thead', null,
      el('tr', null, ...headers.map(h => el('th', null, h)))
    );

    const tbody = el('tbody', null,
      ...rows.map(row => el('tr', null,
        ...row.map((cell, colIdx) => {
          const colName = (headers[colIdx] || '').toLowerCase();
          let cellContent = renderInlineFormatting(cell);

          // Status & Badge enhancements
          if (cell === 'Healed' || cell === 'Passed' || cell === 'Verified') {
            cellContent = el('span', { class: 'status-chip status-completed' }, `✓ ${cell}`);
          } else if (cell === 'Yes') {
            cellContent = el('span', { class: 'status-chip status-completed' }, cell);
          } else if (cell === 'No' || cell === 'Failed') {
            cellContent = el('span', { class: 'status-chip status-failed' }, cell);
          } else if (colName.includes('key') || colName.includes('id') || colName.includes('tc')) {
            cellContent = el('span', { class: 'tag' }, cell);
          }

          return el('td', null, cellContent);
        })
      ))
    );

    return el('div', { class: 'table-wrap' },
      el('table', { class: 'data-table' }, thead, tbody)
    );
  }

  // ── CSV & JSON Renderers ───────────────────────────────────────────────────
  function renderCSVTable(csvText) {
    const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return Bob.empty('Empty CSV document.');

    const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
    const rows = lines.slice(1).map(line => {
      // Simple CSV regex matching quoted strings or unquoted commas
      const matches = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || line.split(',');
      return matches.map(c => c.trim().replace(/^["']|["']$/g, ''));
    });

    const thead = el('thead', null, el('tr', null, ...headers.map(h => el('th', null, h))));
    const tbody = el('tbody', null,
      ...rows.map(row => el('tr', null,
        ...row.map((val, idx) => {
          if (idx === 0) return el('td', null, el('span', { class: 'tag' }, val));
          if (val === 'Verified' || val === 'Passed') return el('td', null, el('span', { class: 'status-chip status-completed' }, val));
          return el('td', null, val);
        })
      ))
    );

    return el('div', { class: 'report-section-card', 'data-testid': 'docs-csv-table' },
      el('div', { class: 'section-card-header' },
        el('h4', null, `Data Table (${rows.length} records)`),
        el('span', { class: 'step-count-badge' }, `${headers.length} columns`)
      ),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data-table' }, thead, tbody)
      )
    );
  }

  function renderJSONView(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_) {
      return el('pre', { class: 'log-output' }, jsonText);
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      const rows = keys.map(k => {
        const item = parsed[k];
        return el('tr', null,
          el('td', null, el('span', { class: 'tag' }, k)),
          el('td', null, el('strong', null, item.tc_id || item.id || '—')),
          el('td', null, item.module || '—'),
          el('td', null, item.name || item.title || JSON.stringify(item))
        );
      });

      return el('div', { class: 'report-section-card' },
        el('div', { class: 'section-card-header' },
          el('h4', null, `Xray Test Case Mapping (${keys.length} Mappings)`),
          el('span', { class: 'step-count-badge' }, 'JSON Schema')
        ),
        el('div', { class: 'table-wrap' },
          el('table', { class: 'data-table' },
            el('thead', null, el('tr', null, el('th', null, 'Xray Key'), el('th', null, 'Test Case ID'), el('th', null, 'Module'), el('th', null, 'Specification / Name'))),
            el('tbody', null, rows)
          )
        )
      );
    }

    return el('pre', { class: 'log-output' }, JSON.stringify(parsed, null, 2));
  }

  // ── Main Document Loader ───────────────────────────────────────────────────
  async function loadDocument(filePath) {
    const file = filePath || currentFile;
    currentFile = file;

    const body = $('#docs-body');
    const subtitle = $('#docs-current-file');
    const fileSelect = $('#docs-file-select');

    if (fileSelect && fileSelect.value !== file) {
      fileSelect.value = file;
    }

    if (subtitle) {
      subtitle.textContent = file.includes('DefectHealing')
        ? 'Jira RCA Defect Healing Report'
        : (file.includes('xray') ? 'Jira Xray Integration Spec' : file);
    }

    if (body) {
      clear(body).append(Bob.loading(`Loading ${file}…`));
    }

    try {
      const res = await Bob.api(`/docs/content?file=${encodeURIComponent(file)}`);
      currentDocData = res;

      clear(body);

      // View toggle bar
      const toolbarRow = el('div', { class: 'docs-view-toolbar' },
        el('div', { class: 'docs-view-pills' },
          el('button', {
            type: 'button',
            'data-testid': 'docs-view-structured',
            class: `btn-small ${viewMode === 'formatted' ? 'btn-small-primary' : ''}`,
            onclick: () => { viewMode = 'formatted'; renderDocumentView(); }
          }, 'Structured Report View'),
          el('button', {
            type: 'button',
            'data-testid': 'docs-view-raw',
            class: `btn-small ${viewMode === 'raw' ? 'btn-small-primary' : ''}`,
            onclick: () => { viewMode = 'raw'; renderDocumentView(); }
          }, 'Raw Source View')
        ),
        el('span', { class: 'cell-sub' }, `Format: ${res.format.toUpperCase()} · Size: ${(res.size / 1024).toFixed(1)} KB`)
      );

      body.append(toolbarRow);

      const contentBox = el('div', { id: 'docs-content-view', 'data-testid': 'docs-content-view' });
      body.append(contentBox);

      renderDocumentView();
    } catch (err) {
      if (body) {
        clear(body).append(Bob.errorState(err, () => loadDocument(file)));
      }
    }
  }

  function renderDocumentView() {
    const contentBox = $('#docs-content-view');
    if (!contentBox || !currentDocData) return;

    clear(contentBox);

    if (viewMode === 'raw') {
      contentBox.append(
        el('pre', { class: 'log-output docs-raw-view', 'data-testid': 'docs-raw-view' }, currentDocData.content)
      );
      return;
    }

    // Formatted view depending on format
    if (currentDocData.format === 'markdown') {
      contentBox.append(parseMarkdownToDOM(currentDocData.content));
    } else if (currentDocData.format === 'csv') {
      contentBox.append(renderCSVTable(currentDocData.content));
    } else if (currentDocData.format === 'json') {
      contentBox.append(renderJSONView(currentDocData.content));
    } else {
      contentBox.append(el('pre', { class: 'log-output' }, currentDocData.content));
    }
  }

  // ── Reload Action ──────────────────────────────────────────────────────────
  async function reloadCurrentDoc() {
    if (isRefreshing) return;
    isRefreshing = true;

    const btn = $('#btn-refresh-docs');
    const icon = btn ? btn.querySelector('.refresh-icon') : null;
    const spinner = $('#docs-refresh-spinner');

    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('spinning');
    if (spinner) spinner.hidden = false;

    try {
      await loadDocument(currentFile);
      Bob.toast('Report reloaded successfully.', 'success');
    } catch (err) {
      Bob.toast(`Reload failed: ${err.message}`, 'error');
    } finally {
      isRefreshing = false;
      if (btn) btn.disabled = false;
      if (icon) icon.classList.remove('spinning');
      if (spinner) spinner.hidden = true;
    }
  }

  // ── Document Export / Download ─────────────────────────────────────────────
  function exportCurrentDoc() {
    if (!currentDocData || !currentDocData.content) {
      Bob.toast('No document loaded to export.', 'info');
      return;
    }

    const mimeMap = {
      markdown: 'text/markdown',
      json: 'application/json',
      csv: 'text/csv',
      text: 'text/plain'
    };

    const mime = mimeMap[currentDocData.format] || 'text/plain';
    const filename = currentDocData.name || 'DefectHealingReport-2026-10-13.md';
    Bob.download(filename, currentDocData.content, mime);
    Bob.toast(`Exported ${filename}`, 'success');
  }

  // ── Initialize Event Listeners ──────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const fileSelect = $('#docs-file-select');
    const btnRefresh = $('#btn-refresh-docs');
    const btnDownload = $('#btn-download-docs');

    if (fileSelect) {
      fileSelect.addEventListener('change', () => {
        loadDocument(fileSelect.value);
      });
    }

    if (btnRefresh) {
      btnRefresh.addEventListener('click', reloadCurrentDoc);
    }

    if (btnDownload) {
      btnDownload.addEventListener('click', exportCurrentDoc);
    }

    // Lazy load when switching to Docs tab
    Bob.on('tab', (tabName) => {
      if (tabName === 'docs' && !currentDocData) {
        loadDocument(currentFile);
      }
    });

    // Populate file list from server
    Bob.api('/docs').then((data) => {
      if (data && data.files && data.files.length && fileSelect) {
        clear(fileSelect);
        data.files.forEach((f) => {
          const opt = el('option', { value: f.path }, f.name);
          if (f.path === currentFile) opt.selected = true;
          fileSelect.append(opt);
        });
      }
    }).catch(() => {});
  });
})();
