import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { JavaScriptTracer } from '../tracing/JavaScriptTracer';
import { summarize } from '../tracing/TraceSession';
import { ROOT, EXAMPLES, options, request, toolchain } from './helpers';

/** Loads the real webview.html/js in jsdom, feeds it a REAL trace and inspects the DOM. */
async function load(): Promise<{ dom: JSDOM; sent: unknown[]; push: (state: unknown) => void }> {
  const html = fs.readFileSync(path.join(ROOT, 'media', 'webview.html'), 'utf8')
    .replace(/{{cspSource}}/g, 'vscode-resource:').replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'x.css').replace(/<script[^>]*src="{{jsUri}}"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent: unknown[] = [];
  (dom.window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => sent.push(m) });
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8'));
  const push = (state: unknown): void => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state } })); };
  return { dom, sent, push };
}

test('webview: empty state, running state with cancel, failure state', async () => {
  const { dom, sent, push } = await load();
  const d = dom.window.document;
  assert.equal(JSON.stringify(sent[0]), '{"type":"ready"}');
  assert.match(d.body.textContent ?? '', /Understand what your code actually does/);
  assert.match(d.body.textContent ?? '', /TraceLens: Trace Execution/);
  push({ kind: 'running', label: 'fib()', startedAt: Date.now() });
  const cancel = Array.from(d.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
  cancel.click();
  assert.equal(JSON.stringify(sent.at(-1)), '{"type":"cancel"}');
  push({ kind: 'failure', title: 'TraceLens could not trace this code', message: 'No interpreter' });
  assert.match(d.querySelector('[role=alert]')!.textContent ?? '', /No interpreter/);
});

test('webview: renders summary, call tree, timeline, search, details and source navigation from a real trace', async () => {
  const tracer = new JavaScriptTracer(ROOT, toolchain);
  const file = path.join(EXAMPLES, 'javascript', 'order.js');
  const session = await tracer.trace(request({ languageId: 'javascript', filePath: file, functionName: 'processOrder', argsJson: '[{"id":2,"items":{"a":1},"card":"declined"}]' }), options);
  const thresholds = { moderateMs: 50, slowMs: 250, criticalMs: 1000 };
  const { dom, sent, push } = await load();
  const d = dom.window.document;
  push({ kind: 'trace', session, summary: summarize(session, thresholds), thresholds, showArguments: true, showReturnValues: true, workspaceRoot: EXAMPLES });
  const text = d.body.textContent ?? '';
  assert.match(text, /Trace Summary/);
  assert.match(text, /ERROR: Error/);
  assert.match(text, /card declined/);
  assert.match(text, /processOrder\(\)\s+→\s+chargeCard\(\)/); // error path
  const rows = Array.from(d.querySelectorAll('#main .row'));
  assert.ok(rows.length >= 5);
  assert.ok(rows.some((r) => /chargeCard\(\)/.test(r.textContent ?? '') && /ERROR/.test(r.textContent ?? '')));
  assert.equal(d.querySelector('[role=tree]')?.getAttribute('aria-label'), 'Call tree');
  assert.ok(d.querySelector('#details')!.textContent!.includes('Open Source'));
  // slowest list
  assert.match(d.body.textContent!, /Slowest Functions/);
  // select a node and open its source
  const charge = rows.find((r) => /chargeCard\(\)/.test(r.textContent ?? '')) as HTMLElement;
  charge.click();
  assert.match(d.querySelector('#details')!.textContent!, /javascript\/order\.js/);
  const open = Array.from(d.querySelectorAll('#details button')).find((b) => b.textContent === 'Open Source') as HTMLElement;
  open.click();
  const msg = sent.at(-1) as { type: string; file: string; line: number };
  assert.equal(msg.type, 'open');
  assert.equal(msg.file, file);
  assert.ok(msg.line > 0);
  // keyboard: ArrowDown moves selection
  charge.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  // timeline
  (d.getElementById('tab-timeline') as HTMLElement).click();
  const bars = d.querySelectorAll('#main .tl-row');
  assert.equal(bars.length, rows.length);
  assert.ok(d.querySelector('#main .bar.err'), 'failed call is drawn with the error pattern');
  // search
  const input = d.querySelector('input.search') as HTMLInputElement;
  input.value = 'charge';
  input.dispatchEvent(new dom.window.Event('input'));
  const results = d.querySelectorAll('#main button.item');
  assert.equal(results.length, 1);
  assert.match(results[0].textContent!, /chargeCard\(\).*order\.js:\d+/);
  (results[0] as HTMLElement).click();
  assert.equal((sent.at(-1) as { type: string }).type, 'open');
  // console output
  assert.match(d.querySelector('pre.out')!.textContent!, /Processing order 2/);
});

test('webview: block with no calls shows an explanation; Expand/Collapse are hidden on the Timeline tab', async () => {
  const thresholds = { moderateMs: 50, slowMs: 250, criticalMs: 1000 };
  const root = { id: 1, functionName: 'Selection', filePath: '/p/a.js', startTime: 0, endTime: 1, duration: 1, selfTime: 1, startLine: 49, endLine: 49, column: 1,
    parentId: null, children: [], depth: 0, status: 'success' };
  const session = { id: 's', label: 'Selection', language: 'javascript', filePath: '/p/a.js', mode: 'block', startLine: 49, endLine: 49, startedAt: new Date().toISOString(),
    duration: 1, status: 'success', root, console: { chunks: [], truncated: false }, truncated: false, warnings: [], eventCount: 2, files: ['/p/a.js'] };
  const { dom, push } = await load();
  const d = dom.window.document;
  push({ kind: 'trace', session, summary: { totalDuration: 1, functionCount: 1, errorCount: 0, slowCount: 0, maxDepth: 1 }, thresholds, showArguments: true, showReturnValues: true });
  assert.match(d.body.textContent ?? '', /No function calls in this selection/);
  const expand = Array.from(d.querySelectorAll('button')).find((b) => b.textContent === 'Expand all') as unknown as { hidden: boolean };
  assert.equal(expand.hidden, false);
  (d.getElementById('tab-timeline') as unknown as { click(): void }).click();
  assert.equal(expand.hidden, true);
});
