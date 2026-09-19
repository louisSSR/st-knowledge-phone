import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const files = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) await walk(target);
    else if (item.name.endsWith('.js')) files.push(target);
  }
}
await walk(path.join(root, 'dist'));
let bytes = 0, gzipBytes = 0;
for (const file of files) { const body = await readFile(file); bytes += body.length; gzipBytes += gzipSync(body).length; }
const receipt = { schemaVersion: 1, version: '0.1.0', modules: files.length, bytes, gzipBytes,
  note: 'Sum of all JS modules; startup is smaller because controller/UI/worker are lazy loaded.' };
await writeFile(path.join(root, 'build-report.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Built ${files.length} ES modules. Total JS ${bytes} bytes / ${gzipBytes} gzip bytes.`);
