import * as vscode from 'vscode';
import { HistoryEntry } from '../history/TraceHistory';
import { TraceService } from '../services/TraceService';
import { formatDuration } from '../tracing/TraceSession';

type NodeKind = 'section' | 'group' | 'item';

interface TreeNode {
  kind: NodeKind;
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: vscode.Command;
  children?: TreeNode[];
}

/** Sidebar tree: current trace, recent traces, and quick actions. It complements (not duplicates) the main webview. */
export class TraceLensViewProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly service: TraceService) {
    service.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === 'item' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.command = node.command;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return node.children ?? [];
    return [this.currentSection(), this.recentSection(), this.actionsSection()];
  }

  private currentSection(): TreeNode {
    const s = this.service;
    let child: TreeNode;
    if (s.isTracing) {
      child = { kind: 'item', id: 'current.running', label: `Tracing ${s.currentLabel ?? ''}`, icon: 'sync~spin', command: { command: 'tracelens.show', title: 'Show TraceLens' } };
    } else if (s.lastSession) {
      const t = s.lastSession;
      child = {
        kind: 'item', id: 'current.last', label: t.label, icon: t.status === 'success' ? 'pass' : 'error',
        description: `${formatDuration(t.duration)} · ${t.status}`, tooltip: `${t.filePath}\n${t.startedAt}`,
        command: { command: 'tracelens.openLastTrace', title: 'Open Last Trace' }
      };
    } else {
      child = { kind: 'item', id: 'current.none', label: 'No trace yet', description: 'Run TraceLens: Trace Execution', icon: 'info' };
    }
    return { kind: 'section', id: 'current', label: 'Current Trace', children: [child] };
  }

  private recentSection(): TreeNode {
    const groups = this.service.history.grouped();
    const children: TreeNode[] = groups.length
      ? groups.map((g) => ({
          kind: 'group' as const, id: `recent.${g.title}`, label: g.title,
          children: g.entries.map((e) => this.entryNode(e))
        }))
      : [{ kind: 'item', id: 'recent.none', label: 'Nothing yet', icon: 'history' }];
    return { kind: 'section', id: 'recent', label: 'Recent Traces', children };
  }

  private entryNode(e: HistoryEntry): TreeNode {
    return {
      kind: 'item', id: `recent.${e.id}`, label: e.label, icon: e.status === 'success' ? 'pass' : 'warning',
      description: `${formatDuration(e.duration)} · ${e.functionCount} calls`,
      tooltip: `${e.filePath}\n${new Date(e.startedAt).toLocaleString()}\nStatus: ${e.status}`,
      command: { command: 'tracelens.openHistoryEntry', title: 'Open Trace', arguments: [e.id] }
    };
  }

  private actionsSection(): TreeNode {
    const mk = (id: string, label: string, icon: string, command: string): TreeNode => ({ kind: 'item', id: `action.${id}`, label, icon, command: { command, title: label } });
    const items = [
      mk('current', 'Trace Current Function', 'symbol-function', 'tracelens.traceCurrentFunction'),
      mk('last', 'Open Last Trace', 'history', 'tracelens.openLastTrace'),
      mk('clear', 'Clear History', 'clear-all', 'tracelens.clearHistory')
    ];
    if (this.service.isTracing) items.unshift(mk('cancel', 'Cancel Current Trace', 'debug-stop', 'tracelens.cancelTrace'));
    return { kind: 'section', id: 'actions', label: 'Actions', children: items };
  }
}
