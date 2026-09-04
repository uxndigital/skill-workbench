import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(projectRoot, 'dist', 'cli.js');

async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd: projectRoot, encoding: 'utf8' });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('completion prints a zsh script at runtime', async () => {
  const result = await run(['completion', 'zsh']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^#compdef skillw/);
  assert.match(result.stdout, /completion:输出 shell 补全脚本/);
  assert.match(result.stdout, /--autostash/);
  assert.match(result.stdout, /\{\-g,--global\}/);
});

test('completion without shell defaults to zsh and is valid zsh syntax', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillw-completion-'));
  try {
    const result = await run(['completion']);
    assert.equal(result.code, 0, result.stderr);
    const script = path.join(root, '_skillw');
    await writeFile(script, result.stdout, 'utf8');
    await execFileAsync('zsh', ['-n', script], { encoding: 'utf8' });
    assert.equal(await readFile(script, 'utf8'), result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completion rejects unsupported shells', async () => {
  const result = await run(['completion', 'bash']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /INVALID_ARGUMENTS/);
});

test('completion exposes the same short global flag accepted by the CLI', async () => {
  const result = await run(['completion']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\{\-g,--global\}/);
});
