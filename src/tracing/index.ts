import { SupportedLanguage } from '../models/TraceTypes';
import { LanguageTracer, ToolchainResolver } from './LanguageTracer';
import { JavaScriptTracer } from './JavaScriptTracer';
import { PythonTracer } from './PythonTracer';
import { TypeScriptTracer } from './TypeScriptTracer';

/** Registry of language tracers. Register a new LanguageTracer here to add a language. */
export function createTracers(extensionPath: string, toolchain: ToolchainResolver): Map<SupportedLanguage, LanguageTracer> {
  const tracers: LanguageTracer[] = [
    new PythonTracer(extensionPath, toolchain),
    new JavaScriptTracer(extensionPath, toolchain),
    new TypeScriptTracer(extensionPath, toolchain)
  ];
  return new Map(tracers.map((t) => [t.languageId, t]));
}
