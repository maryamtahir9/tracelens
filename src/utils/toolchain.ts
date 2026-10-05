import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TraceLensError, TraceRequest } from '../models/TraceTypes';
import { RunnerCommand, ToolchainResolver } from '../tracing/LanguageTracer';
import { probe } from './process';
import { readSettings } from './config';

interface PythonEnvironmentsApi {
  getActiveEnvironmentPath?(resource?: vscode.Uri): { id: string; path: string } | string | undefined;
  resolveEnvironment?(env: unknown): Thenable<{ executable?: { uri?: vscode.Uri } } | undefined>;
}
interface PythonExtensionApi {
  environments?: PythonEnvironmentsApi;
}

function acceptablePython(command: string, args: string[]): boolean {
  const r = probe(command, [...args, '--version']);
  const m = /Python\s+(\d+)\.(\d+)/.exec(r.output);
  return r.ok && !!m && Number(m[1]) === 3 && Number(m[2]) >= 8;
}

async function pythonFromExtension(resource: vscode.Uri): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension('ms-python.python');
  if (!ext) return undefined;
  try {
    const api = (ext.isActive ? ext.exports : await ext.activate()) as PythonExtensionApi | undefined;
    const envs = api?.environments;
    if (!envs?.getActiveEnvironmentPath) return undefined;
    const active = envs.getActiveEnvironmentPath(resource);
    if (envs.resolveEnvironment && active) {
      const resolved = await envs.resolveEnvironment(active);
      const fsPath = resolved?.executable?.uri?.fsPath;
      if (fsPath) return fsPath;
    }
    return typeof active === 'string' ? active : active?.path;
  } catch {
    return undefined;
  }
}

/** Resolves interpreters using TraceLens settings, the Python extension, and finally PATH. */
export class VsCodeToolchain implements ToolchainResolver {
  async resolvePython(req: TraceRequest): Promise<RunnerCommand> {
    const settings = readSettings();
    const resource = vscode.Uri.file(req.filePath);
    const candidates: { command: string; args: string[] }[] = [];
    if (settings.pythonPath) candidates.push({ command: settings.pythonPath, args: [] });
    const fromExt = await pythonFromExtension(resource);
    if (fromExt) candidates.push({ command: fromExt, args: [] });
    const configured = vscode.workspace.getConfiguration('python', resource).get<string>('defaultInterpreterPath');
    if (configured && configured !== 'python') candidates.push({ command: configured, args: [] });
    if (req.workspaceRoot) {
      for (const rel of process.platform === 'win32' ? ['.venv\\Scripts\\python.exe', 'venv\\Scripts\\python.exe'] : ['.venv/bin/python', 'venv/bin/python']) {
        const p = path.join(req.workspaceRoot, rel);
        if (fs.existsSync(p)) candidates.push({ command: p, args: [] });
      }
    }
    candidates.push(process.platform === 'win32' ? { command: 'py', args: ['-3'] } : { command: 'python3', args: [] }, { command: 'python', args: [] });
    for (const c of candidates) {
      if (acceptablePython(c.command, c.args)) return { command: c.command, args: c.args };
    }
    throw new TraceLensError('NO_INTERPRETER', 'TraceLens could not find a Python interpreter for this workspace. Select one with the Python extension ("Python: Select Interpreter") or set "traceLens.pythonPath". Python 3.8 or newer is required.', 'openSettings');
  }

  async resolveNode(_req: TraceRequest): Promise<RunnerCommand> {
    const settings = readSettings();
    const candidates = [settings.nodePath, 'node'].filter(Boolean);
    for (const c of candidates) {
      if (probe(c, ['--version']).ok) return { command: c, args: [] };
    }
    // VS Code ships a Node-compatible runtime; use it when no standalone Node.js is installed.
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    if (probe(process.execPath, ['--version'], { ...process.env, ...env }).ok) return { command: process.execPath, args: [], env };
    throw new TraceLensError('NO_NODE', 'TraceLens could not find Node.js. Install Node.js or set "traceLens.nodePath".', 'openSettings');
  }
}
