<h1 align="center">TraceLens</h1>

<p align="center"><b>See what happens when your code runs.</b></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Mythra.tracelens"><img alt="Version" src="https://img.shields.io/visual-studio-marketplace/v/Mythra.tracelens?label=marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Mythra.tracelens"><img alt="Installs" src="https://img.shields.io/visual-studio-marketplace/i/Mythra.tracelens"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Mythra.tracelens"><img alt="Rating" src="https://img.shields.io/visual-studio-marketplace/r/Mythra.tracelens"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

<p align="center"><img alt="TraceLens demo" src="https://raw.githubusercontent.com/maryamtahir9/tracelens/main/docs/images/tracelens-demo.gif" width="860"></p>

TraceLens runs a function or code block you select, records what **actually** happened — every call, how long it took, what went in and came out, and where it failed — and shows it as a call tree and timeline inside VS Code. Click any call to jump to its source.

Everything runs locally. No server, no API key, no network access, no telemetry. Your code never leaves your machine.

## Why TraceLens?

A debugger tells you the state *right now*. A profiler tells you where time goes *on average*. TraceLens answers a simpler question: **"what did this one run do, in what order, and what was slow or broken?"** — without breakpoints and without leaving the editor.

## Features

- **Real runtime data only.** Calls, timings, arguments, return values and exceptions come from the running program. No sample data: with no trace you see an empty state, and a failure shows the real error.
- **Call tree** with expand/collapse, keyboard navigation and slow/error indicators.
- **Timeline** drawn from measured start and end times.
- **Details panel** per call: file, line, duration, self time, status, arguments, return value, parent, children, error.
- **Error tracing:** the failing call, the path from the root to it, the message and a clickable source location.
- **Performance flags:** configurable *moderate* (50 ms), *slow* (250 ms) and *critical* (1000 ms) thresholds, shown with text labels as well as colour.
- **Search** across function names, file names and error messages.
- **Slowest functions**, **trace summary** and **console output** capture.
- **History** of recent traces (metadata only) in a sidebar view.
- **Safe execution:** separate process, timeout, a Cancel button that really kills the process, and a cap on recorded calls.
- Follows your VS Code theme (light, dark, high contrast) and works from the keyboard.

## Screenshots

### Call tree and call details
Every call with its real duration, severity, arguments and return value. Select a call to see its details, then **Open Source** to jump to the code.

<img alt="Call tree and details (dark theme)" src="https://raw.githubusercontent.com/maryamtahir9/tracelens/main/docs/images/call-tree-dark.png" width="860">

### Timeline
Bars are placed by measured start and end times, so you can see what ran when, and what waited on what.

<img alt="Timeline (dark theme)" src="https://raw.githubusercontent.com/maryamtahir9/tracelens/main/docs/images/timeline-dark.png" width="860">

### Errors
The failing call, the call path that led to it, and the exact source location.

<img alt="Error trace (dark theme)" src="https://raw.githubusercontent.com/maryamtahir9/tracelens/main/docs/images/error-trace-dark.png" width="860">

### Light theme
TraceLens adapts to your VS Code theme.

<img alt="Call tree (light theme)" src="https://raw.githubusercontent.com/maryamtahir9/tracelens/main/docs/images/call-tree-light.png" width="860">

<sub>Screenshots show the TraceLens panel rendered from real traces of the demo scripts in <a href="https://github.com/maryamtahir9/tracelens/tree/main/examples"><code>examples/</code></a>.</sub>

## Supported languages

| Language | How it is traced | Requirements |
|---|---|---|
| Python 3.8+ | `sys.settrace` in a child process (standard library only) | An interpreter: the one selected in the Python extension, `traceLens.pythonPath`, a workspace `.venv`, or `python3` / `py` on PATH |
| JavaScript (CommonJS) | Load-time instrumentation in a Node.js child process | Node.js (VS Code's bundled runtime is used as a fallback) |
| TypeScript | Transpiled on the fly with **your project's** `typescript` package; source maps map locations back to `.ts` | `typescript` installed in the project (TraceLens never installs packages) |

## Installation

Install **TraceLens** from the VS Code Marketplace (search for "TraceLens"), or from a `.vsix` file:

```
code --install-extension tracelens-1.0.2.vsix
```

## Quick start

1. Open a Python, JavaScript or TypeScript file.
2. Select a function (or put the cursor inside it), right-click, and choose **TraceLens: Trace Execution** (or **Trace Current Function**).
3. If the function takes parameters, enter them as JSON, e.g. `[1042, "card"]`. Python also accepts an object for keyword arguments.
4. Inspect the trace. Double-click a call, or press **Open Source**, to jump to the code.

**What a selection means:** a selection that starts on a function header or covers a whole function traces that function. Any other selection is run as a block in the module's scope. With nothing selected, the function around the cursor is used; if there is none, you can trace the whole file.

Try it on the demo scripts: `examples/javascript/payment.js` (`processPayment`, argument `[{"orderId":1042,"items":["sku-1","sku-2","sku-3"]}]`) and `examples/python/payment.py` (`process_payment`, argument `[{"id":1042,"user":7}]`, which fails with a real `ConnectionError`).

## Commands

| Command | Description |
|---|---|
| TraceLens: Trace Execution | Trace the selection (or the current function) |
| TraceLens: Trace Current Function | Trace the function around the cursor |
| TraceLens: Open Last Trace | Reopen the most recent trace |
| TraceLens: Clear Trace History | Forget recent traces |
| TraceLens: Show TraceLens | Open the TraceLens panel |
| TraceLens: Cancel Current Trace | Terminate the running trace |

The status bar shows `$(pulse) TraceLens`, and `$(sync~spin) Tracing...` while a trace runs.

## Settings

| Setting | Default | Description |
|---|---|---|
| `traceLens.executionTimeout` | 10000 | Max run time (ms) before the process is killed |
| `traceLens.maxTraceEvents` | 10000 | Max calls recorded per trace |
| `traceLens.moderateThresholdMs` / `slowThresholdMs` / `criticalThresholdMs` | 50 / 250 / 1000 | Duration thresholds |
| `traceLens.historyLimit` | 20 | Recent traces remembered (0 disables) |
| `traceLens.showArguments` | true | Capture arguments |
| `traceLens.showReturnValues` | true | Capture return values |
| `traceLens.captureConsole` | true | Capture stdout/stderr |
| `traceLens.autoOpenTrace` | true | Open the panel when a trace finishes |
| `traceLens.pythonPath` / `traceLens.nodePath` | empty | Override the interpreter / Node.js |

## Architecture

```
src/
  extension.ts            activation, command registration
  commands/               traceExecution (shared by both trace commands), traceCurrentFunction, traceHistory
  services/TraceService   running process, last trace, history, status bar, panel state
  tracing/                LanguageTracer (+ RunnerTracer base), PythonTracer, JavaScriptTracer,
                          TypeScriptTracer, TraceParser (events -> tree), TraceSession (analysis)
  models/                 TraceTypes (strict types), Settings (validation)
  history/TraceHistory    bounded, metadata-only history
  providers/              sidebar TreeDataProvider
  webview/TracePanel.ts   webview host (CSP + nonce, message validation)
  utils/                  process (timeout/kill tree), functionDetection, locations, toolchain, sourceNavigation
runners/                  python_runner.py, node_runner.js, instrument.js, sourcemap.js  (run in the child process)
media/                    webview.html / .css / .js, icons
```

Each run: the extension writes a small config file and starts a runner in a child process. The runner writes one JSON event per line (call / return / error), and `TraceParser` turns the events into a `TraceSession` tree. To add a language, implement `LanguageTracer` and register it in `src/tracing/index.ts`.

## Privacy

Nothing leaves your machine. History stores only metadata (label, file path, line range, duration, status) — never source code, arguments, return values or console output. Argument text you type is kept in memory only. The last 10 traces are kept in memory for the current session.

## Security

TraceLens **executes your code** (and, for functions, the top level of the file that defines them, so the functions are available). Only trace code you trust, as you would only run code you trust. Execution happens in a separate process with a timeout and a cancel button; it is not a sandbox and has the same permissions as VS Code. The webview uses a strict Content Security Policy with a nonce, loads no remote resources, renders trace data as text, and the extension only opens source files that appear in the current trace.

## Limitations

- Timings include tracing overhead. Python's `settrace` is the more expensive; hot loops run noticeably slower while traced.
- Trace targets must be top-level functions or methods of top-level classes. Methods are called on an instance created with no constructor arguments.
- Selected blocks run in module scope; local variables of an enclosing function are not available.
- The top level of the target file runs once, untraced, to define the functions (so `if __name__ == "__main__"` and `require.main === module` guards do not fire).
- Python: only the main thread is traced; generators and coroutines appear as one call per resume. Frames in `site-packages`, virtual environments and the standard library are not recorded.
- JavaScript: CommonJS only (no native ES modules or `.mjs`); generator functions are not instrumented; calls made by code inside `node_modules` are not recorded. TypeScript uses transpile-only compilation (no type checking; `paths` aliases are not resolved).
- Async attribution uses `AsyncLocalStorage`; callbacks that outlive the traced function are attached under it.
- Function detection is heuristic (no full parser); unusual formatting may be missed.
- Function arguments must be JSON values.

## Troubleshooting

- **"could not find a Python interpreter"** — select one with the Python extension, or set `traceLens.pythonPath`.
- **"needs the 'typescript' package"** — run `npm install --save-dev typescript` in your project.
- **Trace ends with "Timed out"** — raise `traceLens.executionTimeout`, or check for an infinite loop; the partial trace shows where it was.
- **Trace is "limited"** — raise `traceLens.maxTraceEvents` or trace a smaller function.
- **ES module error** — convert to CommonJS, or write the code in TypeScript (compiled to CommonJS for tracing).

## Development

```
npm install
npm run compile      # tsc
npm run watch
npm run lint
npm test             # compiles, then runs unit + real-execution integration tests
npm run verify       # compile + lint + tests + package manifest checks
```

Press **F5** in VS Code to launch an Extension Development Host. `examples/` contains small Python, JavaScript and TypeScript projects used by the tests and for trying the extension.

## Testing

`npm test` covers: the trace model and call-tree construction, event parsing (including malformed and truncated streams), timing, function detection, source-location mapping, source-map decoding, history, settings, plus integration tests that **really execute** Python, JavaScript and TypeScript (timeouts, cancellation, event cap, exceptions, async parent attribution), and a jsdom test that renders the real webview from a real trace. Tests that need Python are skipped if `python3` is missing. The VS Code UI integration (menus, panel inside the editor) is not covered by automated tests.

## Packaging

```
npm run package      # produces tracelens-<version>.vsix
```

## Roadmap

- ES module JavaScript, Python threads, a flame-graph view, trace export/import, diffing two runs
- More languages through the `LanguageTracer` interface; remote and container workspaces

## Contributing

Issues and pull requests are welcome at <https://github.com/maryamtahir9/tracelens>. Please run `npm run verify` before submitting.

## License

[MIT](LICENSE)
