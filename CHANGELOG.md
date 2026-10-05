# Changelog

## 1.0.2

- Python tracebacks shown in the console no longer include TraceLens' own runner frames
- Timeline: the last time label is no longer clipped
- README with screenshots and demo GIF; demo scripts in `examples/`

## 1.0.1

- Show an explanation when a selection runs but makes no function calls
- Expand all / Collapse all are only shown on the Call Tree tab

## 1.0.0

- Real execution tracing: Python via `sys.settrace`, JavaScript/TypeScript via load-time instrumentation in a Node.js child process
- Python, JavaScript and TypeScript support behind a common `LanguageTracer` abstraction
- Call tree view (expand/collapse, keyboard navigation, selection) and timeline view built from measured start/end times
- Per-call durations, self time, arguments and return values (both can be switched off), slow-call thresholds
- Error tracing: failing call, propagation path, error location
- Console (stdout/stderr) capture with size limits
- Source navigation from the tree, timeline, search results, slowest list and error locations
- Search by function name, file name and error text
- Trace history (metadata only, configurable limit) and sidebar view
- Execution safety: separate process, timeout, cancellation, event cap
- Commands: Trace Execution, Trace Current Function, Open Last Trace, Clear Trace History, Show TraceLens, Cancel Current Trace
