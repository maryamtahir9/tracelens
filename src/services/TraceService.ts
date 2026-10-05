import * as vscode from 'vscode';
import { TraceHistory } from '../history/TraceHistory';
import { TraceLensSettings, toThresholds, toTraceOptions } from '../models/Settings';
import { TraceLensError, TraceRequest, TraceSession } from '../models/TraceTypes';
import { LanguageTracer } from '../tracing/LanguageTracer';
import { summarize } from '../tracing/TraceSession';
import { isFileInSession } from '../utils/locations';
import { openSource } from '../utils/sourceNavigation';
import { PanelState, TracePanel } from '../webview/TracePanel';
import { SupportedLanguage } from '../models/TraceTypes';

const MAX_CACHED_SESSIONS = 10;

/**
 * Owns everything stateful about tracing: the running process, the last session, history, the status bar
 * and the webview. Commands and views are thin layers on top of it.
 */
export class TraceService implements vscode.Disposable {
  private abort: AbortController | undefined;
  private runningLabel: string | undefined;
  private state: PanelState = { kind: 'empty' };
  private readonly cache = new Map<string, TraceSession>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  lastSession: TraceSession | undefined;
  lastRequest: TraceRequest | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tracers: Map<SupportedLanguage, LanguageTracer>,
    readonly history: TraceHistory,
    private readonly getSettings: () => TraceLensSettings
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusItem.name = 'TraceLens';
    this.statusItem.command = 'tracelens.show';
    this.renderStatus();
    this.statusItem.show();
  }

  get isTracing(): boolean { return this.abort !== undefined; }
  get currentLabel(): string | undefined { return this.runningLabel; }

  async run(request: TraceRequest): Promise<void> {
    if (this.abort) {
      void vscode.window.showWarningMessage('TraceLens: a trace is already running. Cancel it first (TraceLens: Cancel Current Trace).');
      return;
    }
    const tracer = this.tracers.get(request.languageId);
    if (!tracer) {
      void vscode.window.showErrorMessage(`TraceLens does not support ${request.languageId} yet. Supported: Python, JavaScript, TypeScript.`);
      return;
    }
    const settings = this.getSettings();
    const controller = new AbortController();
    this.abort = controller;
    this.runningLabel = request.label;
    this.lastRequest = request;
    void vscode.commands.executeCommand('setContext', 'tracelens.tracing', true);
    this.setState({ kind: 'running', label: request.label, startedAt: Date.now() }, true);
    this.renderStatus();
    this.emitter.fire();

    try {
      const session = await tracer.trace(request, toTraceOptions(settings), controller.signal);
      this.lastSession = session;
      this.remember(session);
      if (session.status !== 'cancelled') {
        await this.history.add(session, request, summarize(session, toThresholds(settings)).functionCount);
      }
      this.showSession(session, settings.autoOpenTrace);
      if (!settings.autoOpenTrace) {
        const choice = await vscode.window.showInformationMessage(`TraceLens: finished tracing ${session.label} (${session.status}).`, 'Open Trace');
        if (choice === 'Open Trace') this.showSession(session, true);
      }
    } catch (e) {
      const err = e instanceof TraceLensError ? e : new TraceLensError('SPAWN_FAILED', `Tracing failed: ${(e as Error).message}`);
      this.setState({ kind: 'failure', title: 'TraceLens could not trace this code', message: err.message }, true);
      if (err.actionHint === 'openSettings') {
        void vscode.window.showErrorMessage(`TraceLens: ${err.message}`, 'Open Settings').then((c) => {
          if (c === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'traceLens');
        });
      } else {
        void vscode.window.showErrorMessage(`TraceLens: ${err.message}`);
      }
    } finally {
      this.abort = undefined;
      this.runningLabel = undefined;
      void vscode.commands.executeCommand('setContext', 'tracelens.tracing', false);
      this.renderStatus();
      this.emitter.fire();
    }
  }

  cancel(): void {
    if (!this.abort) {
      void vscode.window.showInformationMessage('TraceLens: no trace is running.');
      return;
    }
    this.abort.abort();
  }

  showSession(session: TraceSession, reveal: boolean): void {
    const s = this.getSettings();
    this.setState({
      kind: 'trace', session, summary: summarize(session, toThresholds(s)), thresholds: toThresholds(s),
      showArguments: s.showArguments, showReturnValues: s.showReturnValues,
      workspaceRoot: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(session.filePath))?.uri.fsPath
    }, reveal);
  }

  /** Re-sends the current trace so threshold/setting changes take effect immediately. */
  refresh(): void {
    if (this.state.kind === 'trace') this.showSession(this.state.session, false);
    this.emitter.fire();
  }

  showPanel(): void {
    this.setState(this.state, true);
  }

  openLast(): void {
    if (this.lastSession) this.showSession(this.lastSession, true);
    else void vscode.window.showInformationMessage('TraceLens: there is no trace yet. Select a function and run "TraceLens: Trace Execution".');
  }

  cachedSession(id: string): TraceSession | undefined {
    return this.cache.get(id);
  }

  async clearHistory(): Promise<void> {
    await this.history.clear();
    this.cache.clear();
    this.emitter.fire();
  }

  private remember(session: TraceSession): void {
    this.cache.set(session.id, session);
    while (this.cache.size > MAX_CACHED_SESSIONS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private setState(state: PanelState, reveal: boolean): void {
    this.state = state;
    if (!reveal && !TracePanel.current) return;
    TracePanel.show(this.extensionUri, {
      openSource: (file, line, column) => {
        const session = this.state.kind === 'trace' ? this.state.session : undefined;
        if (isFileInSession(session, file)) void openSource({ filePath: file, line, column });
      },
      cancel: () => this.cancel(),
      traceCurrent: () => void vscode.commands.executeCommand('tracelens.traceCurrentFunction'),
      rerun: () => { if (this.lastRequest) void this.run(this.lastRequest); },
      onDidDispose: () => undefined
    }, this.state, reveal);
    this.emitter.fire();
  }

  private renderStatus(): void {
    if (this.abort) {
      this.statusItem.text = '$(sync~spin) Tracing...';
      this.statusItem.tooltip = `TraceLens is tracing ${this.runningLabel ?? ''}. Click to open the panel.`;
    } else {
      this.statusItem.text = '$(pulse) TraceLens';
      this.statusItem.tooltip = 'Open TraceLens';
    }
  }

  dispose(): void {
    this.abort?.abort();
    this.statusItem.dispose();
    this.emitter.dispose();
  }
}
