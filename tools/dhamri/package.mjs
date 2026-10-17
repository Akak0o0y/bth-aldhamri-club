// Build a distribution from an explicit allowlist. Never package the workspace,
// environment files, browser profiles, account data, or node_modules wholesale.
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run } from './process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = process.argv[2] || '0.2.0-rc1';
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9]+)?$/.test(version)) throw new Error('Use a semantic release version.');
const go = process.argv[3] || 'go';
const destination = join(root, 'artifacts', `dhamri-windows-${version}`);
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination); // Refuse to overwrite an existing package.
const files = ['dhamri.cmd', 'setup-dhamri.cmd'];
for (const file of await readdir(join(root, 'tools', 'dhamri'))) {
  if (file.endsWith('.mjs') || file.endsWith('.ps1') || file === 'build-native.cmd') files.push(`tools/dhamri/${file}`);
}
for (const file of await walk(join(root, 'tools/dhamri/native'))) {
  if (file.endsWith('.go') || file === 'go.mod' || file === 'go.sum') files.push(`tools/dhamri/native/${file}`);
}
for (const file of ['index.html', 'viewer.mjs', 'viewer.css', 'geometry.mjs']) files.push(`tools/dhamri/viewer/${file}`);
files.push('tools/dhamri/bin/dhamri-whip.exe', 'tools/dhamri/bin/dhamri-input.exe');
for (const file of files) {
  const target = join(destination, file);
  await mkdir(dirname(target), { recursive: true });
  if (file.endsWith('.cmd')) {
    const source = await readFile(join(root, file), 'utf8');
    await writeFile(target, source.replace(/\r?\n/g, '\r\n'));
  } else await copyFile(join(root, file), target);
}
await copyFile(join(root, 'docs', 'native-broadcaster.md'), join(destination, 'README.md'));

const native = join(root, 'tools', 'dhamri', 'native');
// Enumerate modules that contribute compiled packages. The full module graph
// can include unused test dependencies whose source directories do not exist.
const modules = await run(go, ['-C', native, 'list', '-deps', '-f', '{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}', './...'], { timeout: 60000 });
if (modules.code !== 0) throw new Error('Could not enumerate native dependency licenses.');
const goroot = await run(go, ['env', 'GOROOT']);
const sections = [`Go runtime\nhttps://go.dev/\n${await readFile(join(goroot.stdout.trim(), 'LICENSE'), 'utf8')}`];
for (const line of new Set(modules.stdout.trim().split(/\r?\n/))) {
  const [name, moduleVersion, directory] = line.split('|');
  if (!moduleVersion) continue;
  if (!directory) throw new Error(`Missing source directory for ${name}.`);
  const names = (await readdir(directory)).filter(file => /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(file));
  if (!names.length) throw new Error(`No license found for ${name}.`);
  for (const nameOfFile of names) sections.push(`${name} ${moduleVersion}\n${nameOfFile}\n${await readFile(join(directory, nameOfFile), 'utf8')}`);
}
await writeFile(join(destination, 'THIRD_PARTY_LICENSES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n'));
await writeFile(join(destination, 'VERSION.txt'), `${version}\nSource: https://github.com/Akak0o0y/bth-aldhamri-club\nFFmpeg and Node.js are installed separately, not redistributed in this ZIP.\n`);

async function walk(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await walk(join(directory, entry.name), relative + '/'));
    else result.push(relative);
  }
  return result;
}
const manifest = [];
for (const file of (await walk(destination)).sort()) manifest.push(`${createHash('sha256').update(await readFile(join(destination, file))).digest('hex')}  ${file}`);
await writeFile(join(destination, 'SHA256SUMS.txt'), manifest.join('\n') + '\n');
const zip = resolve(`${destination}.zip`);
// Pass file paths as arguments, not interpolated shell code.
const script = fileURLToPath(new URL('./zip.ps1', import.meta.url));
const packed = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, destination, zip], { timeout: 60000 });
if (packed.code !== 0) throw new Error('Could not create the release ZIP.');
const hash = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(`${zip}.sha256`, `${hash}  dhamri-windows-${version}.zip\n`);
console.log(JSON.stringify({ zip, sha256: hash, files: manifest.length }, null, 2));
