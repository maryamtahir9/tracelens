import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  ConsoleOutput, SupportedLanguage, TraceLensError, TraceOptions, TraceRequest, TraceSession, TraceError
} from '../models/TraceTypes';
import { runProcess } from '../utils/process';
import { makeTempDir, removeDir } from '../utils/paths';
import { parseTrace } from './TraceParser';
import { collectFiles } from './TraceSession';

/** Command line (plus environment) used to start a runner. */
export interface RunnerCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the tools needed to run code. The VS Code implementation looks at the Python extension and
 * the user's settings; tests supply a trivial implementation.
 */
export interface ToolchainResolver {
  resolvePython(req: TraceRequest): Promise<RunnerCommand>;
  resolveNode(req: TraceRequest): Promise<RunnerCommand>;
}

const MAX_CONSOLE_BYTES = 256 * 1024;

export class ConsoleCollector {
  private bytes = 0;
  private readonly out: ConsoleOutput = { chunks: [], truncated: false };
  constructor(private readonly enabled: boolean) {}

  push(stream: 'stdout' | 'stderr', text: string): void {
    if (!this.enabled) return;
    if (this.bytes >= MAX_CONSOLE_BYTES) { this.out.truncated = true; return; }
    let t = text;
    if (this.bytes + Buffer.byteLength(t) > MAX_CONSOLE_BYTES) {
      t = t.slice(0, Math.max(0, MAX_CONSOLE_BYTES - this.bytes));
      this.out.truncated = true;
    }
    this.bytes += Buffer.byteLength(t);
    const last = this.out.chunks[this.out.chunks.length - 1];
    if (last && last.stream === stream) last.text += t; else this.out.chunks.push({ stream, text: t });
  }

  result(): ConsoleOutput {
    return this.out;
  }
}

/** Public contract every language implements. Adding a language = implementing this interface. */
export interface LanguageTracer {
  readonly languageId: SupportedLanguage;
  readonly displayName: string;
  trace(request: TraceRequest, options: TraceOptions, signal?: AbortSignal): Promise<TraceSession>;
}

/**
 * Shared implementation for tracers that run a bundled runner script in a child process and read
 * back a JSON-lines event file. Subclasses only decide how to start the runner.
 */
export abstract class RunnerTracer implements LanguageTracer {
  abstract readonly languageId: SupportedLanguage;
  abstract readonly displayName: string;

  constructor(protected readonly extensionPath: string, protected readonly toolchain: ToolchainResolver) {}

  /** Builds the command that starts the runner with the given config file. */
  protected abstract buildCommand(request: TraceRequest, configPath: string): Promise<RunnerCommand>;

  /** Adds language specific values to the runner config (for example the TypeScript location). */
  protected async extraConfig(_request: TraceRequest): Promise<Record<string, unknown>> {
    return {};
  }

  protected runnerPath(file: string): string {
    return path.join(this.extensionPath, 'runners', file);
  }

  async trace(request: TraceRequest, options: TraceOptions, signal?: AbortSignal): Promise<TraceSession> {
    if (!fs.existsSync(request.filePath)) {
      throw new TraceLensError('FILE_NOT_FOUND', `The file ${request.filePath} no longer exists. Save the file and try again.`);
    }
    if (request.mode === 'function' && !request.functionName) {
      throw new TraceLensError('NO_FUNCTION', 'No function was specified to trace.');
    }
    if (request.mode === 'block' && !request.selectionText?.trim()) {
      throw new TraceLensError('INVALID_SELECTION', 'The selection is empty. Select the code you want to trace.');
    }

    let tmp: string;
    try {
      tmp = await makeTempDir();
    } catch (e) {
      throw new TraceLensError('PERMISSION', `TraceLens could not create a temporary directory: ${(e as Error).message}`);
    }
    try {
      const outFile = path.join(tmp, 'events.jsonl');
      const configPath = path.join(tmp, 'config.json');
      const config = {
        file: request.filePath, mode: request.mode, functionName: request.functionName, argsJson: request.argsJson,
        selectionText: request.selectionText, startLine: request.startLine, endLine: request.endLine, label: request.label,
        workspaceRoot: request.workspaceRoot ?? path.dirname(request.filePath), outFile,
        maxEvents: options.maxEvents, captureArgs: options.captureArgs, captureReturn: options.captureReturn,
        ...(await this.extraConfig(request))
      };
      await fs.promises.writeFile(configPath, JSON.stringify(config), 'utf8');
      const cmd = await this.buildCommand(request, configPath);

      const consoleOut = new ConsoleCollector(options.captureConsole);
      const startedAt = new Date();
      const wallStart = process.hrtime.bigint();
      const result = await runProcess({
        command: cmd.command, args: cmd.args, cwd: config.workspaceRoot as string,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...cmd.env },
        timeoutMs: options.timeoutMs, signal,
        onStdout: (c) => consoleOut.push('stdout', c), onStderr: (c) => consoleOut.push('stderr', c)
      });
      const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

      if (result.spawnError) {
        const code = result.spawnError.code;
        if (code === 'ENOENT') throw new TraceLensError(this.languageId === 'python' ? 'NO_INTERPRETER' : 'NO_NODE', `Could not start "${cmd.command}". Check that it is installed and on your PATH.`);
        if (code === 'EACCES' || code === 'EPERM') throw new TraceLensError('PERMISSION', `Permission denied while starting "${cmd.command}".`);
        throw new TraceLensError('SPAWN_FAILED', `Could not start the traced process: ${result.spawnError.message}`);
      }

      let text = '';
      try {
        text = await fs.promises.readFile(outFile, 'utf8');
      } catch {
        text = '';
      }
      const parsed = parseTrace(text, { syntheticRootName: request.label, syntheticRootFile: request.filePath });
      const stderrTail = consoleOutTail(consoleOut);

      let status: TraceSession['status'] = 'success';
      let error: TraceError | undefined;
      if (result.cancelled) {
        status = 'cancelled';
      } else if (result.timedOut) {
        status = 'timeout';
        error = { type: 'Timeout', message: `The traced code did not finish within ${options.timeoutMs} ms and was terminated. The trace shows what ran until then (unfinished calls are marked incomplete).` };
      } else if (parsed.end) {
        if (parsed.end.status === 'error') { status = 'error'; error = parsed.end.error ?? { type: 'Error', message: 'Execution failed.' }; }
      } else {
        status = 'error';
        error = {
          type: 'ProcessError',
          message: `The traced process ended unexpectedly (exit code ${result.exitCode ?? 'none'}${result.signal ? `, signal ${result.signal}` : ''}).${stderrTail ? ` Last output: ${stderrTail}` : ''}`
        };
      }

      const root = parsed.root;
      const duration = root ? root.duration : Math.max(0, parsed.lastTimestamp);
      return {
        id: randomUUID(), label: request.label, language: this.languageId, filePath: request.filePath, mode: request.mode,
        functionName: request.functionName, startLine: request.startLine, endLine: request.endLine,
        startedAt: startedAt.toISOString(), duration: root ? duration : wallMs, status, error, root,
        console: consoleOut.result(), truncated: parsed.end?.truncated === true, warnings: [...(request.notes ?? []), ...parsed.warnings],
        eventCount: parsed.eventCount, files: collectFiles(root, [request.filePath, ...(error?.filePath ? [error.filePath] : [])])
      };
    } finally {
      await removeDir(tmp);
    }
  }
}

function consoleOutTail(c: ConsoleCollector): string {
  const err = c.result().chunks.filter((k) => k.stream === 'stderr').map((k) => k.text).join('').trim();
  return err.split('\n').slice(-3).join(' ').slice(0, 300);
}
