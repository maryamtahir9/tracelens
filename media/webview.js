/* TraceLens webview. Plain JavaScript, no dependencies. All trace data is rendered with textContent. */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = { kind: 'empty' };
  let ui = { tab: 'tree', query: '', selectedId: null };
  let model = null;      // derived data for the current trace
  let timer = null;

  /* ------------------------------------------------------------ helpers */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'style') { for (const p of Object.keys(v)) el.style.setProperty(p, v[p]); }
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) for (const c of [].concat(children)) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const post = (m) => vscode.postMessage(m);
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();

  function relPath(file) {
    const root = state.workspaceRoot;
    if (root && file && file.toLowerCase().startsWith(root.toLowerCase())) {
      return file.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    }
    return baseName(file);
  }
  function fmt(ms) {
    if (ms < 1) return ms.toFixed(2) + ' ms';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(3) + ' s';
  }
  function sev(ms) {
    const t = state.thresholds;
    if (ms >= t.criticalMs) return 'critical';
    if (ms >= t.slowMs) return 'slow';
    if (ms >= t.moderateMs) return 'moderate';
    return 'normal';
  }
  const SEV_LABEL = { moderate: 'MODERATE', slow: 'SLOW', critical: 'CRITICAL' };
  const displayName = (n) => (n.functionName.startsWith('<') ? n.functionName : n.functionName + '()');
  function openSource(file, line, column) { if (file) post({ type: 'open', file, line: line || 1, column: column || 0 }); }
  function openNode(n) { openSource(n.filePath, n.startLine, n.column); }

  /* -------------------------------------------------------------- model */
  function buildModel(session) {
    const byId = new Map();
    const flat = [];
    if (session.root) {
      const stack = [session.root];
      while (stack.length) {
        const n = stack.pop();
        byId.set(n.id, n);
        flat.push(n);
        for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
      }
    }
    const synthetic = !!session.root && session.root.id === 0;
    const real = synthetic ? flat.slice(1) : flat;
    const t0 = session.root ? session.root.startTime : 0;
    let tEnd = t0;
    for (const n of flat) if (n.endTime > tEnd) tEnd = n.endTime;
    return { byId, flat, real, t0, span: Math.max(tEnd - t0, 0.001), synthetic, expanded: new Set() };
  }

  function errorPath(session) {
    // chain from the root to the call where the error originated
    const origin = model.flat.find((n) => n.status === 'error' && !n.propagated);
    if (!origin) return null;
    const chain = [];
    for (let n = origin; n; n = n.parentId !== null ? model.byId.get(n.parentId) : null) chain.unshift(n);
    return chain.filter((n) => n.id !== 0);
  }

  /* ------------------------------------------------------------ states */
  function render() {
    clearInterval(timer);
    app.replaceChildren();
    if (state.kind === 'empty') return renderEmpty();
    if (state.kind === 'running') return renderRunning();
    if (state.kind === 'failure') return renderFailure();
    renderTrace();
  }

  function renderEmpty() {
    app.append(h('div', { class: 'center' }, [
      h('h1', { text: 'TraceLens' }),
      h('p', { class: 'muted', text: 'Understand what your code actually does.' }),
      h('p', { text: 'Select a function or code block and run:' }),
      h('p', null, [h('code', { text: 'TraceLens: Trace Execution' })]),
      h('p', { class: 'muted', text: 'Supported languages:' }),
      h('ul', { class: 'langs' }, ['Python', 'JavaScript', 'TypeScript'].map((l) => h('li', { text: l }))),
      h('button', { class: 'btn', onclick: () => post({ type: 'traceCurrent' }), text: 'Trace Current Function' })
    ]));
  }

  function renderFailure() {
    app.append(h('div', { class: 'center' }, [
      h('h1', { text: state.title }),
      h('div', { class: 'banner error', role: 'alert' }, [h('div', { text: state.message })]),
      h('p', null, [h('button', { class: 'btn', onclick: () => post({ type: 'traceCurrent' }), text: 'Trace Current Function' })])
    ]));
  }

  function renderRunning() {
    const elapsed = h('span', { class: 'mono' });
    const tick = () => { elapsed.textContent = ((Date.now() - state.startedAt) / 1000).toFixed(1) + ' s'; };
    tick();
    timer = setInterval(tick, 200);
    app.append(h('div', { class: 'center', role: 'status' }, [
      h('h1', { text: 'Tracing…' }),
      h('p', null, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), state.label, ' ', elapsed]),
      h('p', { class: 'muted', text: 'The code is running in a separate process. Results appear when it finishes.' }),
      h('button', { class: 'btn secondary', onclick: () => post({ type: 'cancel' }), text: 'Cancel' })
    ]));
  }

  /* -------------------------------------------------------------- trace */
  function renderTrace() {
    const s = state.session;
    model = buildModel(s);
    if (ui.sessionId !== s.id) {
      ui = { tab: ui.tab, query: '', selectedId: null, sessionId: s.id };
      if (model.flat.length <= 400) model.flat.forEach((n) => model.expanded.add(n.id));
      else model.flat.forEach((n) => { if (n.depth < 3) model.expanded.add(n.id); });
      const firstErr = model.flat.find((n) => n.status === 'error' && !n.propagated);
      ui.selectedId = firstErr ? firstErr.id : (s.root ? s.root.id : null);
    } else {
      model.flat.forEach((n) => { if (n.depth < 3 || model.flat.length <= 400) model.expanded.add(n.id); });
    }

    const meta = [s.language, relPath(s.filePath), new Date(s.startedAt).toLocaleTimeString()].join(' · ');
    app.append(h('div', { class: 'header' }, [
      h('div', { class: 'title' }, [h('h1', { text: 'TraceLens · ' + s.label }), h('span', { class: 'sub', text: meta })]),
      h('button', { class: 'btn secondary', onclick: () => post({ type: 'rerun' }), text: 'Run again', title: 'Run the same trace again' })
    ]));

    renderBanners(s);

    app.append(h('h2', { text: 'Trace Summary' }));
    const sum = state.summary;
    const stat = (k, v) => h('div', { class: 'stat' }, [h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v })]);
    app.append(h('div', { class: 'summary' }, [
      stat('Total Duration', fmt(sum.totalDuration)), stat('Functions', String(sum.functionCount)), stat('Errors', String(sum.errorCount)),
      stat('Slow Calls', String(sum.slowCount)), stat('Maximum Depth', String(sum.maxDepth))
    ]));

    // toolbar
    const input = h('input', { class: 'search', type: 'search', placeholder: 'Search functions, files, errors…', 'aria-label': 'Search trace', value: ui.query });
    input.addEventListener('input', () => { ui.query = input.value; renderMain(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; ui.query = ''; renderMain(); } });
    const tabBtn = (id, label) => h('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(ui.tab === id), id: 'tab-' + id,
      onclick: () => {
        ui.tab = id;
        app.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.id === 'tab-' + id)));
        app.querySelectorAll('.tree-only').forEach((b) => { b.hidden = id !== 'tree'; });
        renderMain();
      }
    }, label);
    const toolbar = h('div', { class: 'toolbar' }, [input, h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Trace views' }, [tabBtn('tree', 'Call Tree'), tabBtn('timeline', 'Timeline')])]);
    toolbar.append(
      h('button', { class: 'btn secondary tree-only', hidden: ui.tab !== 'tree', onclick: () => { model.flat.forEach((n) => model.expanded.add(n.id)); renderMain(); }, text: 'Expand all' }),
      h('button', { class: 'btn secondary tree-only', hidden: ui.tab !== 'tree', onclick: () => { model.expanded.clear(); if (s.root) model.expanded.add(s.root.id); renderMain(); }, text: 'Collapse all' })
    );
    app.append(toolbar);

    app.append(h('div', { class: 'layout' }, [
      h('div', null, [h('div', { class: 'panel view', id: 'main', 'aria-label': 'Trace view' })]),
      h('aside', { class: 'panel details', id: 'details', 'aria-label': 'Selected call details' })
    ]));
    renderMain();
    renderDetails();

    // slowest
    app.append(h('h2', { text: 'Slowest Functions' }));
    const top = model.real.slice().sort((a, b) => b.duration - a.duration).slice(0, 5);
    app.append(top.length
      ? h('ol', { class: 'list panel', style: { 'list-style': 'none' } }, top.map((n, i) => h('li', null, [
          h('button', { class: 'item', onclick: () => { select(n.id); openNode(n); }, title: 'Open source' }, [
            h('span', { class: 'rank', text: (i + 1) + '.' }), h('span', { class: 'name', text: displayName(n) }),
            h('span', { class: 'grow' }), h('span', { class: 'dur', text: fmt(n.duration) }),
            SEV_LABEL[sev(n.duration)] ? h('span', { class: 'badge ' + sev(n.duration), text: SEV_LABEL[sev(n.duration)] }) : null
          ])
        ])))
      : h('div', { class: 'empty-note panel', text: 'No function calls were recorded.' }));

    renderConsole(s);
  }

  function renderBanners(s) {
    const add = (cls, head, body, extra) => app.append(h('div', { class: 'banner ' + cls, role: cls === 'error' ? 'alert' : 'status' }, [h('div', { class: 'head', text: head }), body ? h('div', { text: body }) : null, extra]));
    if (s.status === 'error' && s.error) {
      const e = s.error;
      const chain = errorPath(s);
      const loc = e.filePath ? h('div', null, [h('button', { class: 'link mono', onclick: () => openSource(e.filePath, e.line, e.column), text: relPath(e.filePath) + (e.line ? ':' + e.line : '') + ' — open error location' })]) : null;
      const pathEl = chain && chain.length ? h('div', { class: 'path', text: chain.map((n) => displayName(n)).join('  →  ') + '  ✖ ' + e.type }) : null;
      add('error', 'ERROR: ' + e.type, e.message, h('div', null, [loc, pathEl]));
    } else if (s.status === 'timeout') add('warn', 'Timed out', s.error ? s.error.message : null);
    else if (s.status === 'cancelled') add('info', 'Cancelled', 'The trace was stopped. Calls that had not finished are marked incomplete.');
    if (s.truncated) add('warn', 'Trace limited', 'The traceLens.maxTraceEvents limit was reached. Later calls were not recorded (their time is still included in their callers).');
    if (s.warnings && s.warnings.length) add('info', 'Notes', null, h('ul', null, s.warnings.map((w) => h('li', { text: w }))));
    if (s.status === 'success' && s.root && s.mode !== 'function' && s.root.children.length === 0) {
      add('info', 'No function calls in this selection', 'The selected code ran, but it did not call any traceable function (for example it only defines or exports things). Select a whole function, or put the cursor inside one and run "TraceLens: Trace Current Function", to see its call tree.');
    }
    if (s.status !== 'error' && !s.root && s.status !== 'cancelled') add('warn', 'No calls recorded', 'The run finished without any traceable function calls.');
  }

  /* ------------------------------------------------------- main (tree/tl) */
  function renderMain() {
    const host = document.getElementById('main');
    if (!host) return;
    host.replaceChildren();
    if (ui.query.trim()) return renderSearch(host);
    if (!state.session.root) return host.append(h('div', { class: 'empty-note', text: 'Nothing to show.' }));
    if (ui.tab === 'tree') renderTree(host); else renderTimeline(host);
  }

  function search(q) {
    const needle = q.trim().toLowerCase();
    return model.flat.filter((n) => [n.functionName, baseName(n.filePath), n.filePath, n.error ? n.error.type : '', n.error ? n.error.message : ''].some((x) => String(x).toLowerCase().includes(needle)));
  }

  function renderSearch(host) {
    const results = search(ui.query);
    host.append(h('div', { class: 'empty-note', role: 'status', text: results.length + ' result' + (results.length === 1 ? '' : 's') + ' for “' + ui.query.trim() + '”' }));
    const ul = h('ul', { class: 'list' }, results.slice(0, 500).map((n) => h('li', null, [
      h('button', { class: 'item', onclick: () => { select(n.id); openNode(n); } }, [
        h('span', { class: 'name', text: displayName(n) }), h('span', { class: 'loc', text: relPath(n.filePath) + ':' + n.startLine }),
        h('span', { class: 'grow' }), n.status === 'error' ? h('span', { class: 'badge error', text: 'ERROR' }) : null, h('span', { class: 'dur', text: fmt(n.duration) })
      ])
    ])));
    host.append(ul);
    enableRoving(ul, 'button.item');
  }

  function rowFor(n, level) {
    const hasKids = n.children.length > 0;
    const open = model.expanded.has(n.id);
    const sv = sev(n.duration);
    const rel = Math.min(100, (n.duration / model.span) * 100);
    const li = h('li', { role: 'treeitem', 'aria-level': level, 'aria-expanded': hasKids ? String(open) : undefined, 'aria-selected': String(ui.selectedId === n.id), 'data-id': n.id });
    const chev = h('span', { class: 'chev', 'aria-hidden': 'true', text: hasKids ? (open ? '▾' : '▸') : '' });
    chev.addEventListener('click', (e) => { e.stopPropagation(); toggle(n.id); });
    const row = h('div', {
      class: 'row sev-' + sv, tabindex: ui.selectedId === n.id ? '0' : '-1', 'aria-selected': String(ui.selectedId === n.id), 'data-id': n.id,
      style: { '--depth': String(level - 1) },
      title: displayName(n) + ' — ' + fmt(n.duration) + ' (' + sv + ')' + (n.status === 'error' ? ' — error: ' + (n.error ? n.error.type : '') : '')
    }, [
      chev, h('span', { class: 'name', text: displayName(n) }), h('span', { class: 'loc', text: relPath(n.filePath) + ':' + n.startLine }), h('span', { class: 'grow' }),
      n.status === 'error' ? h('span', { class: 'badge error', text: n.propagated ? 'ERROR ↑' : 'ERROR' }) : null,
      n.status === 'incomplete' ? h('span', { class: 'badge incomplete', text: 'INCOMPLETE' }) : null,
      SEV_LABEL[sv] ? h('span', { class: 'badge ' + sv, text: SEV_LABEL[sv] }) : null,
      h('span', { class: 'mini', 'aria-hidden': 'true' }, [h('i', { style: { '--w': rel.toFixed(1) + '%' } })]),
      h('span', { class: 'dur', text: fmt(n.duration) })
    ]);
    row.addEventListener('click', () => select(n.id));
    row.addEventListener('dblclick', () => openNode(n));
    li.append(row);
    if (hasKids && open) {
      const ul = h('ul', { role: 'group' });
      for (const c of n.children) ul.append(rowFor(c, level + 1));
      li.append(ul);
    }
    return li;
  }

  function renderTree(host) {
    const ul = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Call tree' });
    ul.append(rowFor(state.session.root, 1));
    host.append(ul);
    if (!ul.querySelector('.row[tabindex="0"]')) { const first = ul.querySelector('.row'); if (first) first.setAttribute('tabindex', '0'); }
    ul.addEventListener('keydown', onTreeKey);
  }

  function toggle(id) {
    if (model.expanded.has(id)) model.expanded.delete(id); else model.expanded.add(id);
    renderMain();
    focusRow(id);
  }

  function focusRow(id) {
    const row = app.querySelector('.row[data-id="' + id + '"], .tl-row[data-id="' + id + '"]');
    if (row) row.focus();
  }

  function onTreeKey(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const rows = Array.from(app.querySelectorAll('#main .row'));
    const i = rows.indexOf(row);
    const id = Number(row.getAttribute('data-id'));
    const n = model.byId.get(id);
    const go = (r) => { if (r) { e.preventDefault(); select(Number(r.getAttribute('data-id')), true); } };
    switch (e.key) {
      case 'ArrowDown': go(rows[i + 1]); break;
      case 'ArrowUp': go(rows[i - 1]); break;
      case 'Home': go(rows[0]); break;
      case 'End': go(rows[rows.length - 1]); break;
      case 'ArrowRight':
        e.preventDefault();
        if (n.children.length && !model.expanded.has(id)) toggle(id); else go(rows[i + 1]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (n.children.length && model.expanded.has(id)) toggle(id);
        else if (n.parentId !== null) select(n.parentId, true);
        break;
      case 'Enter': case ' ': e.preventDefault(); select(id); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) openNode(n); break;
      case 'o': openNode(n); break;
      default: break;
    }
  }

  /* --------------------------------------------------------------- roving */
  function enableRoving(container, selector) {
    const items = () => Array.from(container.querySelectorAll(selector));
    items().forEach((el, i) => el.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    container.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = Math.min(list.length - 1, i + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      if (next >= 0) { e.preventDefault(); list.forEach((el) => el.setAttribute('tabindex', '-1')); list[next].setAttribute('tabindex', '0'); list[next].focus(); }
    });
  }

  /* ------------------------------------------------------------- timeline */
  function renderTimeline(host) {
    const MAX_ROWS = 3000;
    const rows = model.flat.slice(0, MAX_ROWS);
    const ticks = h('div', { class: 'ticks', 'aria-hidden': 'true' });
    for (let i = 0; i <= 5; i++) ticks.append(h('span', { class: 'tick', style: { left: (i * 20) + '%' }, text: fmt((model.span * i) / 5) }));
    host.append(h('div', { class: 'axis' }, [h('div', { class: 'muted', style: { padding: '3px 6px' }, text: 'Function' }), ticks]));
    const list = h('div', { role: 'listbox', 'aria-label': 'Timeline' });
    for (const n of rows) {
      const left = ((n.startTime - model.t0) / model.span) * 100;
      const width = (n.duration / model.span) * 100;
      const sv = sev(n.duration);
      const bar = h('span', {
        class: 'bar sev-' + sv + (n.status === 'error' ? ' err' : '') + (n.status === 'incomplete' ? ' inc' : ''),
        style: { '--l': left.toFixed(3) + '%', '--w': Math.max(width, 0.2).toFixed(3) + '%' }
      });
      const btn = h('button', {
        class: 'tl-row', role: 'option', 'aria-selected': String(ui.selectedId === n.id), 'data-id': n.id, style: { '--depth': String(Math.min(n.depth, 20)) },
        title: displayName(n) + ' — start ' + fmt(n.startTime - model.t0) + ', duration ' + fmt(n.duration) + ' (' + sv + ')' + (n.status === 'error' ? ', error' : '')
      }, [
        h('span', { class: 'tl-label', text: displayName(n) }),
        h('span', { class: 'track' }, [bar, h('span', { class: 'bar-time', style: { '--l': left.toFixed(3) + '%', '--w': Math.max(width, 0.2).toFixed(3) + '%' }, text: fmt(n.duration) + (n.status === 'error' ? ' ✖' : '') })])
      ]);
      btn.addEventListener('click', () => select(n.id));
      btn.addEventListener('dblclick', () => openNode(n));
      list.append(btn);
    }
    host.append(list);
    enableRoving(list, 'button.tl-row');
    if (model.flat.length > MAX_ROWS) host.append(h('div', { class: 'empty-note', text: 'Showing the first ' + MAX_ROWS + ' of ' + model.flat.length + ' calls.' }));
  }

  /* ---------------------------------------------------------------- select */
  function select(id, focus) {
    ui.selectedId = id;
    app.querySelectorAll('[data-id]').forEach((el) => {
      const on = Number(el.getAttribute('data-id')) === id;
      el.setAttribute('aria-selected', String(on));
      if (el.classList.contains('row') || el.classList.contains('tl-row')) el.setAttribute('tabindex', on ? '0' : '-1');
    });
    // make sure the node is visible in the tree (expand ancestors)
    const n = model.byId.get(id);
    if (n && ui.tab === 'tree' && !ui.query.trim() && !app.querySelector('#main .row[data-id="' + id + '"]')) {
      for (let p = n.parentId !== null ? model.byId.get(n.parentId) : null; p; p = p.parentId !== null ? model.byId.get(p.parentId) : null) model.expanded.add(p.id);
      renderMain();
    }
    if (focus) focusRow(id);
    renderDetails();
  }

  function renderDetails() {
    const host = document.getElementById('details');
    if (!host) return;
    host.replaceChildren();
    const n = model.byId.get(ui.selectedId);
    if (!n) return host.append(h('div', { class: 'muted', text: 'Select a call to see its details.' }));
    const sv = sev(n.duration);
    const rows = [];
    const kv = (k, v, cls) => { rows.push(h('dt', { text: k })); rows.push(h('dd', { class: cls }, v)); };
    host.append(h('h3', { class: 'mono', text: displayName(n) }));
    kv('Function', n.functionName);
    kv('File', relPath(n.filePath));
    kv('Line', String(n.startLine) + (n.endLine > n.startLine ? '–' + n.endLine : ''));
    kv('Duration', fmt(n.duration) + (SEV_LABEL[sv] ? '  (' + sv + ')' : ''));
    kv('Self time', fmt(n.selfTime));
    kv('Starts at', '+' + fmt(n.startTime - model.t0));
    kv('Status', n.status === 'success' ? 'SUCCESS' : n.status === 'error' ? (n.propagated ? 'ERROR (propagated from a callee)' : 'ERROR') : 'INCOMPLETE (did not finish)');
    if (state.showArguments) kv('Arguments', n.arguments && n.arguments.length ? n.arguments.map((a) => a.name + ': ' + a.value).join('\n') : '—');
    if (state.showReturnValues) kv('Return Value', n.returnValue !== undefined ? n.returnValue : n.status === 'success' ? '— (none / undefined)' : '—');
    const parent = n.parentId !== null ? model.byId.get(n.parentId) : null;
    kv('Parent', parent ? h('button', { class: 'link mono', onclick: () => select(parent.id, true), text: displayName(parent) }) : '—');
    const kids = h('span', { class: 'chips' }, n.children.slice(0, 30).map((c) => h('button', { class: 'link', onclick: () => select(c.id, true), text: displayName(c) })));
    if (n.children.length > 30) kids.append(h('span', { class: 'muted', text: '+' + (n.children.length - 30) + ' more' }));
    kv('Children', n.children.length ? kids : '—');
    host.append(h('dl', { class: 'kv' }, rows));
    if (n.error) {
      const e = n.error;
      host.append(h('div', { class: 'errbox', role: 'group', 'aria-label': 'Error' }, [
        h('div', { class: 't', text: 'ERROR: ' + e.type }), h('div', { text: e.message }),
        e.filePath ? h('div', null, [h('button', { class: 'link mono', onclick: () => openSource(e.filePath, e.line, e.column), text: relPath(e.filePath) + (e.line ? ':' + e.line : '') })]) : null,
        n.propagated ? h('div', { class: 'muted', text: 'Raised in a callee and propagated through this call.' }) : null
      ]));
    }
    host.append(h('div', { class: 'actions' }, [h('button', { class: 'btn', onclick: () => openNode(n), text: 'Open Source' })]));
  }

  /* --------------------------------------------------------------- console */
  function renderConsole(s) {
    const chunks = s.console && s.console.chunks ? s.console.chunks : [];
    const pre = h('pre', { class: 'out', tabindex: '0', 'aria-label': 'Console output' });
    const MAX = 200000;
    let used = 0;
    let cut = false;
    for (const c of chunks) {
      if (used >= MAX) { cut = true; break; }
      const text = c.text.length + used > MAX ? c.text.slice(0, MAX - used) : c.text;
      used += text.length;
      if (c.stream === 'stderr') pre.append(h('span', { class: 'err' }, [h('span', { class: 'tag', text: 'stderr ' }), text]));
      else pre.append(document.createTextNode(text));
    }
    const d = h('details', { class: 'console', open: chunks.length > 0 ? true : undefined }, [
      h('summary', { text: 'Output' + (chunks.length ? '' : ' (nothing printed)') }),
      chunks.length ? pre : h('div', { class: 'empty-note', text: 'The traced code printed nothing to stdout or stderr (or console capture is disabled).' })
    ]);
    if (cut || (s.console && s.console.truncated)) d.append(h('div', { class: 'empty-note', text: 'Output was truncated.' }));
    app.append(d);
  }

  /* ---------------------------------------------------------------- wiring */
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'state' || !msg.state) return;
    state = msg.state;
    render();
  });
  render();
  post({ type: 'ready' });
})();
