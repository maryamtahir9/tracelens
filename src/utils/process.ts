import { ChildProcess, spawn, spawnSync } from 'child_process';

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the process could not be started at all (ENOENT, EACCES, ...). */
  spawnError?: NodeJS.ErrnoException;
}

/** Terminates a process and all of its children. */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } else {
      try {
        process.kill(-pid, 'SIGKILL'); // whole process group (we spawn detached)
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Runs a child process with a hard timeout and cancellation support.
 * The promise resolves once the process has actually exited (it never rejects).
 */
export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'
      });
    } catch (e) {
      resolve({ exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: e as NodeJS.ErrnoException });
      return;
    }

    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (result: RunProcessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void => {
      cancelled = true;
      killProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, opts.timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => opts.onStdout?.(d));
    child.stderr?.on('data', (d: string) => opts.onStderr?.(d));
    child.on('error', (err: NodeJS.ErrnoException) => finish({ exitCode: null, signal: null, timedOut, cancelled, spawnError: err }));
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig, timedOut, cancelled }));
  });
}

export interface ProbeResult {
  ok: boolean;
  output: string;
}

/** Synchronously runs `command args` to check availability (short timeout). */
export function probe(command: string, args: string[], env?: NodeJS.ProcessEnv): ProbeResult {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, env });
    if (r.error || r.status !== 0) return { ok: false, output: '' };
    return { ok: true, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch {
    return { ok: false, output: '' };
  }
}
