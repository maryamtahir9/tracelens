'use strict';
// Checks the manifest and (if present) the generated VSIX. Exit code 1 on any problem.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

need(fs.existsSync(path.join(root, pkg.main)), `main file missing: ${pkg.main} (run npm run compile)`);
need(fs.existsSync(path.join(root, pkg.icon)), 'icon missing');
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md', '.vscodeignore']) need(fs.existsSync(path.join(root, f)), `${f} missing`);
const declared = new Set(pkg.contributes.commands.map((c) => c.command));
for (const [menu, items] of Object.entries(pkg.contributes.menus)) for (const i of items) need(declared.has(i.command), `menu ${menu} references undeclared command ${i.command}`);
for (const c of declared) need(fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8').includes(`'${c}'`), `command ${c} is not registered in extension.ts`);
need(/^\d+\.\d+\.\d+$/.test(pkg.version), 'version must be semver');
need(pkg.engines && pkg.engines.vscode, 'engines.vscode missing');

const required = ['extension/package.json', 'extension/icon.png', 'extension/README.md', 'extension/LICENSE.txt', 'extension/CHANGELOG.md', 'extension/out/src/extension.js',
  'extension/runners/python_runner.py', 'extension/runners/node_runner.js', 'extension/runners/instrument.js', 'extension/runners/sourcemap.js',
  'extension/media/webview.html', 'extension/media/webview.css', 'extension/media/webview.js', 'extension/media/tracelens-activity.svg', 'extension/node_modules/acorn/package.json'];
const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
if (fs.existsSync(vsix)) {
  const buf = fs.readFileSync(vsix);
  const entries = [];
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  need(eocd >= 0, 'not a zip file');
  if (eocd >= 0) {
    let off = buf.readUInt32LE(eocd + 16);
    const count = buf.readUInt16LE(eocd + 10);
    for (let i = 0; i < count; i++) {
      const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
      entries.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
    }
    const lower = entries.map((e) => e.toLowerCase());
    for (const r of required) need(lower.includes(r.toLowerCase()), `VSIX is missing ${r}`);
    need(entries.includes('extension.vsixmanifest') && entries.includes('[Content_Types].xml'), 'VSIX manifest files missing');
    for (const bad of ['extension/src/', 'extension/examples/', 'extension/out/src/test/', 'extension/node_modules/jsdom/', 'extension/node_modules/typescript/'])
      need(!entries.some((e) => e.startsWith(bad)), `VSIX should not contain ${bad}`);
    console.log(`VSIX ${path.basename(vsix)}: ${entries.length} files, ${(buf.length / 1024).toFixed(0)} KB`);
  }
} else {
  console.log('No VSIX found yet (run npm run package); manifest checks only.');
}
if (problems.length) { console.error('Problems:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log('Package verification OK');
