"""TraceLens Python runner.

Executes a function, a block of code or a whole file under ``sys.settrace`` and writes one JSON
event per line to the file named in the config. Only the standard library is used.
Nothing is simulated: every event is produced by the interpreter's own call/return/exception hooks.
"""
import asyncio
import inspect
import json
import os
import runpy
import sys
import textwrap
import time
import traceback

RUNNER_FILE = os.path.normcase(os.path.abspath(__file__))

with open(sys.argv[1], "r", encoding="utf-8") as _f:
    CFG = json.load(_f)

OUT = open(CFG["outFile"], "w", encoding="utf-8", buffering=1)
T0 = time.perf_counter()
MAX_EVENTS = int(CFG["maxEvents"])
CAPTURE_ARGS = bool(CFG.get("captureArgs", True))
CAPTURE_RET = bool(CFG.get("captureReturn", True))
ROOT = os.path.normcase(os.path.abspath(CFG.get("workspaceRoot") or os.path.dirname(CFG["file"])))
ENTRY_FILE = os.path.normcase(os.path.abspath(CFG["file"]))
EXCLUDED_PARTS = {"site-packages", "dist-packages", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".git"}


def now():
    return (time.perf_counter() - T0) * 1000.0


def emit(obj):
    OUT.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str) + "\n")


def short(value, limit=160):
    try:
        text = repr(value)
    except Exception:  # user __repr__ may raise
        text = "<unrepresentable %s>" % type(value).__name__
    text = text.replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "\u2026"


_user_cache = {}


def is_user_file(filename):
    cached = _user_cache.get(filename)
    if cached is not None:
        return cached
    result = False
    if filename and not filename.startswith("<"):
        try:
            full = os.path.normcase(os.path.abspath(filename))
            inside = full == ENTRY_FILE or full == ROOT or full.startswith(ROOT + os.sep)
            parts = set(full.split(os.sep))
            result = inside and not (parts & EXCLUDED_PARTS) and full != RUNNER_FILE
        except Exception:
            result = False
    _user_cache[filename] = result
    return result


def error_info(exc, tb=None):
    """Return (type, message, file, line) for the innermost frame in user code."""
    file_, line = None, None
    try:
        for fs in traceback.extract_tb(tb if tb is not None else exc.__traceback__):
            if is_user_file(fs.filename):
                file_, line = os.path.abspath(fs.filename), fs.lineno
    except Exception:
        pass
    return type(exc).__name__, str(exc), file_, line


class Tracer:
    def __init__(self):
        self.next_id = 0
        self.stack = []
        self.ids = {}
        self.pending = {}
        self.seen_exc = set()
        self.truncated = False
        self.entry_pending = True

    # -- hooks -------------------------------------------------------------
    def global_trace(self, frame, event, arg):
        if event != "call":
            return None
        code = frame.f_code
        if not is_user_file(code.co_filename):
            return None
        if self.next_id >= MAX_EVENTS:
            self.truncated = True
            return None
        self.next_id += 1
        cid = self.next_id
        parent = self.stack[-1] if self.stack else 0
        name = getattr(code, "co_qualname", code.co_name)
        if code.co_name == "<module>":
            name = CFG["label"] if self.entry_pending else os.path.basename(code.co_filename) + " (module)"
        self.entry_pending = False
        args = None
        if CAPTURE_ARGS:
            args = []
            try:
                n = code.co_argcount + code.co_kwonlyargcount
                names = list(code.co_varnames[:n])
                flags = code.co_flags
                if flags & 0x04:
                    names.append(code.co_varnames[n])
                    n += 1
                if flags & 0x08:
                    names.append(code.co_varnames[n])
                loc = frame.f_locals
                for a in names:
                    if a in ("self", "cls"):
                        continue
                    if a in loc:
                        args.append([a, short(loc[a])])
            except Exception:
                args = []
        emit({"t": "call", "id": cid, "parent": parent, "name": name,
              "file": os.path.abspath(code.co_filename), "line": code.co_firstlineno, "col": 1,
              "ts": now(), "args": args})
        self.ids[id(frame)] = cid
        self.stack.append(cid)
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if event == "line":
            if self.pending:
                self.pending.pop(id(frame), None)
        elif event == "exception":
            exc_type, exc_value, _tb = arg
            if exc_type.__name__ not in ("StopIteration", "StopAsyncIteration", "GeneratorExit"):
                self.pending[id(frame)] = (exc_type, exc_value, _tb, frame.f_lineno)
        elif event == "return":
            fid = id(frame)
            cid = self.ids.pop(fid, None)
            if cid is None:
                return self.local_trace
            if self.stack and self.stack[-1] == cid:
                self.stack.pop()
            elif cid in self.stack:
                self.stack.remove(cid)
            pend = self.pending.pop(fid, None)
            ts = now()
            if pend is not None and arg is None:
                exc_type, exc_value, tb, lineno = pend
                key = id(exc_value)
                origin = key not in self.seen_exc
                self.seen_exc.add(key)
                _, msg, file_, line = error_info(exc_value, tb)
                emit({"t": "err", "id": cid, "ts": ts, "type": exc_type.__name__, "message": msg,
                      "file": file_ or os.path.abspath(frame.f_code.co_filename), "line": line or lineno,
                      "origin": origin})
            else:
                ev = {"t": "ret", "id": cid, "ts": ts, "endLine": frame.f_lineno}
                if CAPTURE_RET and arg is not None:
                    ev["value"] = short(arg)
                emit(ev)
        return self.local_trace

    def start(self):
        sys.settrace(self.global_trace)

    def stop(self):
        sys.settrace(None)


def resolve_target(namespace, dotted):
    parts = dotted.split(".")
    if parts[0] not in namespace:
        raise NameError("TraceLens could not find '%s' after loading %s" % (parts[0], CFG["file"]))
    obj = namespace[parts[0]]
    if len(parts) == 1:
        return obj
    attr = getattr(obj, parts[1])
    raw = inspect.getattr_static(obj, parts[1])
    if inspect.isclass(obj) and not isinstance(raw, (staticmethod, classmethod)):
        try:
            instance = obj()
        except TypeError as exc:
            raise TypeError("Cannot create an instance of %s without arguments to call %s: %s" % (obj.__name__, parts[1], exc))
        return getattr(instance, parts[1])
    return attr


def main():
    tracer = Tracer()
    mode = CFG["mode"]
    status, error, result_exc = "success", None, None
    emit({"t": "begin", "ts": now()})
    sys.path.insert(0, os.path.dirname(os.path.abspath(CFG["file"])))
    if CFG.get("workspaceRoot"):
        sys.path.insert(1, CFG["workspaceRoot"])
    sys.argv = [CFG["file"]]
    started = False
    try:
        if mode == "file":
            started = True
            tracer.start()
            runpy.run_path(CFG["file"], run_name="__main__")
        else:
            namespace = runpy.run_path(CFG["file"], run_name="__tracelens_module__")  # defines functions; not traced
            if mode == "block":
                code = "\n" * (int(CFG["startLine"]) - 1) + textwrap.dedent(CFG["selectionText"])
                compiled = compile(code, CFG["file"], "exec")
                started = True
                tracer.start()
                exec(compiled, namespace)
            else:
                target = resolve_target(namespace, CFG["functionName"])
                call_args = json.loads(CFG["argsJson"]) if CFG.get("argsJson") else []
                started = True
                tracer.start()
                if isinstance(call_args, dict):
                    res = target(**call_args)
                else:
                    res = target(*call_args)
                tracer.stop()
                if inspect.iscoroutine(res):
                    tracer.start()
                    asyncio.run(res)
    except SystemExit as exc:
        if exc.code not in (None, 0):
            status = "error"
            error = {"type": "SystemExit", "message": "Program exited with status %s" % (exc.code,)}
    except BaseException as exc:  # noqa: B902 - report everything the user code raised
        status = "error"
        t, m, f, l = error_info(exc)
        error = {"type": t, "message": m, "filePath": f, "line": l}
        result_exc = exc
    finally:
        if started:
            tracer.stop()
    if result_exc is not None:
        tb = result_exc.__traceback__
        while tb is not None and os.path.normcase(os.path.abspath(tb.tb_frame.f_code.co_filename)) == RUNNER_FILE:
            tb = tb.tb_next  # hide TraceLens' own frames from the user's traceback
        traceback.print_exception(type(result_exc), result_exc, tb)
    end = {"t": "end", "ts": now(), "status": status, "truncated": tracer.truncated}
    if error:
        end["error"] = error
    emit(end)
    OUT.close()
    sys.stdout.flush()
    sys.stderr.flush()
    return 1 if status == "error" else 0


if __name__ == "__main__":
    sys.exit(main())
