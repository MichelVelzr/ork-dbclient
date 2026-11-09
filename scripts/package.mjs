import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'release');

const files = ['orca-plugin.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md'];
const dirs = ['dist', 'assets'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of files) {
  await cp(join(root, name), join(out, name)).catch(() => {});
}
for (const name of dirs) {
  await cp(join(root, name), join(out, name), { recursive: true });
}

let entries = 0;
let bytes = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    entries += 1;
    if (entry.isDirectory()) await walk(join(dir, entry.name));
    else bytes += (await stat(join(dir, entry.name))).size;
  }
}
await walk(out);
console.log(`Release ready: release/ (${entries} entries, ${(bytes / 1024 / 1024).toFixed(2)} MB)`);
