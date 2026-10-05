import { SupportedLanguage, TraceRequest } from '../models/TraceTypes';
import { RunnerCommand, RunnerTracer } from './LanguageTracer';

/**
 * Traces CommonJS JavaScript in a separate Node.js process. User modules are instrumented at load time
 * (see runners/instrument.js) so every call, duration and exception is observed for real.
 */
export class JavaScriptTracer extends RunnerTracer {
  readonly languageId: SupportedLanguage = 'javascript';
  readonly displayName: string = 'JavaScript';

  protected async buildCommand(request: TraceRequest, configPath: string): Promise<RunnerCommand> {
    const node = await this.toolchain.resolveNode(request);
    return { command: node.command, args: [...node.args, this.runnerPath('node_runner.js'), configPath], env: node.env };
  }
}
