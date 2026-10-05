import * as path from 'path';
import { SupportedLanguage, TraceLensError, TraceRequest } from '../models/TraceTypes';
import { findTypeScript } from '../utils/paths';
import { JavaScriptTracer } from './JavaScriptTracer';

/**
 * TypeScript support = JavaScript tracing + on-the-fly transpilation with the project's own `typescript`
 * package (nothing is installed automatically). Source maps map trace locations back to .ts lines.
 */
export class TypeScriptTracer extends JavaScriptTracer {
  override readonly languageId: SupportedLanguage = 'typescript';
  override readonly displayName: string = 'TypeScript';

  protected override async extraConfig(request: TraceRequest): Promise<Record<string, unknown>> {
    const tsPath = findTypeScript(path.dirname(request.filePath));
    if (!tsPath) {
      throw new TraceLensError(
        'TYPESCRIPT_MISSING',
        "TraceLens needs the 'typescript' package to run .ts files, but none was found in this project. Install it with `npm install --save-dev typescript` and try again (TraceLens never installs packages for you)."
      );
    }
    return { tsPath };
  }
}
