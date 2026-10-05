import { SupportedLanguage, TraceRequest } from '../models/TraceTypes';
import { RunnerCommand, RunnerTracer } from './LanguageTracer';

/** Traces Python with `sys.settrace` inside a separate interpreter process (standard library only). */
export class PythonTracer extends RunnerTracer {
  readonly languageId: SupportedLanguage = 'python';
  readonly displayName = 'Python';

  protected async buildCommand(request: TraceRequest, configPath: string): Promise<RunnerCommand> {
    const py = await this.toolchain.resolvePython(request);
    return { command: py.command, args: [...py.args, '-u', this.runnerPath('python_runner.py'), configPath], env: py.env };
  }
}
