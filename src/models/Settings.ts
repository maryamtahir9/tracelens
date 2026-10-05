import { Thresholds, TraceOptions } from './TraceTypes';

export interface TraceLensSettings {
  executionTimeout: number;
  maxTraceEvents: number;
  slowThresholdMs: number;
  moderateThresholdMs: number;
  criticalThresholdMs: number;
  historyLimit: number;
  showArguments: boolean;
  showReturnValues: boolean;
  captureConsole: boolean;
  autoOpenTrace: boolean;
  pythonPath: string;
  nodePath: string;
}

export const DEFAULT_SETTINGS: TraceLensSettings = {
  executionTimeout: 10000,
  maxTraceEvents: 10000,
  slowThresholdMs: 250,
  moderateThresholdMs: 50,
  criticalThresholdMs: 1000,
  historyLimit: 20,
  showArguments: true,
  showReturnValues: true,
  captureConsole: true,
  autoOpenTrace: true,
  pythonPath: '',
  nodePath: ''
};

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** Validates and clamps raw configuration values. Invalid values fall back to defaults. */
export function normalizeSettings(raw: Partial<Record<keyof TraceLensSettings, unknown>>): TraceLensSettings {
  const d = DEFAULT_SETTINGS;
  const moderate = num(raw.moderateThresholdMs, d.moderateThresholdMs, 1, 3_600_000);
  const slow = Math.max(moderate, num(raw.slowThresholdMs, d.slowThresholdMs, 1, 3_600_000));
  const critical = Math.max(slow, num(raw.criticalThresholdMs, d.criticalThresholdMs, 1, 3_600_000));
  return {
    executionTimeout: Math.round(num(raw.executionTimeout, d.executionTimeout, 500, 600_000)),
    maxTraceEvents: Math.round(num(raw.maxTraceEvents, d.maxTraceEvents, 100, 1_000_000)),
    slowThresholdMs: slow,
    moderateThresholdMs: moderate,
    criticalThresholdMs: critical,
    historyLimit: Math.round(num(raw.historyLimit, d.historyLimit, 0, 100)),
    showArguments: bool(raw.showArguments, d.showArguments),
    showReturnValues: bool(raw.showReturnValues, d.showReturnValues),
    captureConsole: bool(raw.captureConsole, d.captureConsole),
    autoOpenTrace: bool(raw.autoOpenTrace, d.autoOpenTrace),
    pythonPath: str(raw.pythonPath, d.pythonPath),
    nodePath: str(raw.nodePath, d.nodePath)
  };
}

export function toTraceOptions(s: TraceLensSettings): TraceOptions {
  return {
    timeoutMs: s.executionTimeout,
    maxEvents: s.maxTraceEvents,
    captureConsole: s.captureConsole,
    captureArgs: s.showArguments,
    captureReturn: s.showReturnValues
  };
}

export function toThresholds(s: TraceLensSettings): Thresholds {
  return { moderateMs: s.moderateThresholdMs, slowMs: s.slowThresholdMs, criticalMs: s.criticalThresholdMs };
}
