import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Walks up from `startDir` looking for node_modules/typescript. Returns the path to typescript.js. */
export function findTypeScript(startDir: string, stopAt?: string): string | undefined {
  let dir = path.resolve(startDir);
  const stop = stopAt ? path.resolve(stopAt) : undefined;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (fs.existsSync(candidate)) return candidate;
    if (stop && dir === stop) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function makeTempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'tracelens-'));
}

export async function removeDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
