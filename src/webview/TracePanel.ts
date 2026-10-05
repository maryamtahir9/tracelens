import * as fs from 'fs';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { Thresholds, TraceSession, TraceSummary } from '../models/TraceTypes';

export type PanelState =
  | { kind: 'empty' }
  | { kind: 'running'; label: string; startedAt: number }
  | { kind: 'failure'; title: string; message: string }
  | {
      kind: 'trace';
      session: TraceSession;
      summary: TraceSummary;
      thresholds: Thresholds;
      showArguments: boolean;
      showReturnValues: boolean;
      workspaceRoot?: string;
    };

export interface PanelHandlers {
  openSource(file: string, line: number, column: number): void;
  cancel(): void;
  traceCurrent(): void;
  rerun(): void;
  onDidDispose(): void;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number; column: number }
  | { type: 'cancel' }
  | { type: 'traceCurrent' }
  | { type: 'rerun' };

function isWebviewMessage(m: unknown): m is WebviewMessage {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { type?: unknown }).type;
  if (t === 'open') {
    const o = m as Record<string, unknown>;
    return typeof o.file === 'string' && typeof o.line === 'number' && typeof o.column === 'number';
  }
  return t === 'ready' || t === 'cancel' || t === 'traceCurrent' || t === 'rerun';
}

/** The main TraceLens webview. Only one instance exists; it is recreated on demand after being closed. */
export class TracePanel {
  private static instance: TracePanel | undefined;
  private ready = false;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  static get current(): TracePanel | undefined {
    return TracePanel.instance;
  }

  static show(extensionUri: vscode.Uri, handlers: PanelHandlers, state: PanelState, reveal: boolean): TracePanel {
    if (TracePanel.instance) {
      if (reveal) TracePanel.instance.panel.reveal(undefined, true);
      TracePanel.instance.setState(state);
      return TracePanel.instance;
    }
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('tracelens.trace', 'TraceLens', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true, localResourceRoots: [mediaRoot], retainContextWhenHidden: false
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'tracelens-activity.svg');
    TracePanel.instance = new TracePanel(panel, extensionUri, handlers, state);
    return TracePanel.instance;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
    private state: PanelState
  ) {
    panel.webview.html = this.buildHtml(extensionUri);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible && this.ready) this.post(); })
    );
  }

  setState(state: PanelState): void {
    this.state = state;
    if (this.ready) this.post();
  }

  private post(): void {
    if (this.disposed) return;
    this.panel.webview.postMessage({ type: 'state', state: this.state }).then(undefined, () => undefined);
  }

  private onMessage(m: unknown): void {
    if (!isWebviewMessage(m)) return;
    switch (m.type) {
      case 'ready': this.ready = true; this.post(); break;
      case 'open': this.handlers.openSource(m.file, m.line, m.column); break;
      case 'cancel': this.handlers.cancel(); break;
      case 'traceCurrent': this.handlers.traceCurrent(); break;
      case 'rerun': this.handlers.rerun(); break;
    }
  }

  private buildHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const media = (file: string): string => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)).toString();
    const template = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'media', 'webview.html').fsPath, 'utf8');
    return template
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cssUri}}/g, media('webview.css'))
      .replace(/{{jsUri}}/g, media('webview.js'));
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    TracePanel.instance = undefined;
    this.handlers.onDidDispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
