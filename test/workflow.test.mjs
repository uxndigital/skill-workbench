import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(projectRoot, 'dist', 'cli.js');

async function run(cwd, args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', ...options });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function syncedRepo(app) {
  const config = JSON.parse(await readFile(path.join(app, '.skill-workbench', 'config.json'), 'utf8'));
  return path.resolve(app, config.repoPath);
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'skill-workbench-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const app = path.join(root, 'app');
  await mkdir(path.join(source, 'skills', 'demo'), { recursive: true });
  await mkdir(path.join(source, 'skills', 'second'), { recursive: true });
  await mkdir(app, { recursive: true });
  await writeFile(path.join(source, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  await writeFile(path.join(source, 'skills', 'second', 'SKILL.md'), '# Second\n');
  await git(source, ['init', '-q']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test']);
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'initial']);
  await git(source, ['branch', '-M', 'main']);
  await git(root, ['init', '--bare', '-q', remote]);
  await git(source, ['remote', 'add', 'origin', remote]);
  await git(source, ['push', '-qu', 'origin', 'main']);
  return { root, source, remote, app };
}

test('status lists local skills available to link when no links exist', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);

  const status = await run(app, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Available to link:\n  demo \(skills\/demo\)/);
  assert.match(status.stdout, /Links:\n  \(none\)/);
});

test('sync, link, status and unlink complete the local workflow', async () => {
  const { remote, app } = await setup();
  const synced = await run(app, ['sync', remote]);
  assert.equal(synced.code, 0, synced.stderr);

  const linked = await run(app, ['link', 'demo']);
  assert.equal(linked.code, 0, linked.stderr);
  const target = path.join(app, '.agents', 'skills', 'demo');
  assert.equal((await lstat(target)).isSymbolicLink(), true);
  const repo = await syncedRepo(app);
  assert.equal(path.resolve(path.dirname(target), await readlink(target)), path.join(repo, 'skills', 'demo'));

  await writeFile(path.join(repo, 'skills', 'demo', 'changed.md'), 'changed\n');
  const status = await run(app, ['status']);
  assert.equal(status.code, 1);
  assert.match(status.stdout, /demo/);
  assert.match(status.stdout, /changed\.md/);

  const unlinked = await run(app, ['unlink', 'demo']);
  assert.equal(unlinked.code, 0, unlinked.stderr);
  await assert.rejects(() => lstat(target));
});


test('link defaults to .agents/skills', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);

  const linked = await run(app, ['link', 'demo']);
  assert.equal(linked.code, 0, linked.stderr);
  assert.equal((await lstat(path.join(app, '.agents', 'skills', 'demo'))).isSymbolicLink(), true);
});

test('link accepts multiple skills and -a cursor uses the shared .agents/skills target', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);

  const linked = await run(app, ['link', 'demo', 'second', '-a', 'cursor']);
  assert.equal(linked.code, 0, linked.stderr);
  assert.equal((await lstat(path.join(app, '.agents', 'skills', 'demo'))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(app, '.agents', 'skills', 'second'))).isSymbolicLink(), true);
  await assert.rejects(() => lstat(path.join(app, '.cursor', 'skills', 'demo')));
});

test('invalid agent fails before creating any link', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);

  const result = await run(app, ['link', 'demo', '-a', 'unknown']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /INVALID_AGENT/);
  await assert.rejects(() => lstat(path.join(app, '.agents', 'skills', 'demo')));
});

test('link --agent values are additive and always include the default .agents target', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);

  const linked = await run(app, ['link', 'demo', '--agent', 'codex', '-a', 'claude']);
  assert.equal(linked.code, 0, linked.stderr);
  assert.equal((await lstat(path.join(app, '.agents', 'skills', 'demo'))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(app, '.claude', 'skills', 'demo'))).isSymbolicLink(), true);

  const state = JSON.parse(await readFile(path.join(app, '.skill-workbench', 'state.json'), 'utf8'));
  assert.deepEqual(state.links.demo.targets.map((target) => target.target), [
    '.agents/skills/demo',
    '.claude/skills/demo'
  ]);
});

test('unlink without agents removes all linked targets in non-interactive mode', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  assert.equal((await run(app, ['link', 'demo', '-a', 'claude'])).code, 0);

  const unlinked = await run(app, ['unlink', 'demo']);
  assert.equal(unlinked.code, 0, unlinked.stderr);
  await assert.rejects(() => lstat(path.join(app, '.agents', 'skills', 'demo')));
  await assert.rejects(() => lstat(path.join(app, '.claude', 'skills', 'demo')));
});

test('unlinking one agent removes its physical target without affecting other targets', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  assert.equal((await run(app, ['link', 'demo', '-a', 'cursor', '-a', 'claude'])).code, 0);

  const unlinkedCodex = await run(app, ['unlink', 'demo', '-a', 'codex']);
  assert.equal(unlinkedCodex.code, 0, unlinkedCodex.stderr);
  await assert.rejects(() => lstat(path.join(app, '.agents', 'skills', 'demo')));
  assert.equal((await lstat(path.join(app, '.claude', 'skills', 'demo'))).isSymbolicLink(), true);

  assert.equal((await run(app, ['unlink', 'demo', '-a', 'cursor'])).code, 0);
  assert.equal((await run(app, ['unlink', 'demo', '-a', 'claude'])).code, 0);
  await assert.rejects(() => lstat(path.join(app, '.agents', 'skills', 'demo')));
  await assert.rejects(() => lstat(path.join(app, '.claude', 'skills', 'demo')));
});

test('sync selects and switches the Git branch with --branch', async () => {
  const { remote, source, app } = await setup();
  await git(source, ['checkout', '-qb', 'feat/todd']);
  await writeFile(path.join(source, 'skills', 'demo', 'branch.md'), 'branch\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'feature branch']);
  await git(source, ['push', '-qu', 'origin', 'feat/todd']);

  assert.equal((await run(app, ['sync', remote])).code, 0);
  const switched = await run(app, ['sync', remote, '--branch', 'feat/todd']);
  assert.equal(switched.code, 0, switched.stderr);

  const repo = await syncedRepo(app);
  const current = (await execFileAsync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' })).stdout.trim();
  assert.equal(current, 'feat/todd');
  const config = JSON.parse(await readFile(path.join(app, '.skill-workbench', 'config.json'), 'utf8'));
  assert.equal(config.repoUrl, remote);
  assert.equal(config.repoPath, '.skill-workbench/remote');
  assert.equal(config.branch, undefined);
});

test('push refuses unrelated pre-existing staged changes', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);
  await writeFile(path.join(repo, 'skills', 'demo', 'changed.md'), 'changed\n');
  await writeFile(path.join(repo, 'README.md'), 'unrelated\n');
  await git(repo, ['add', 'README.md']);
  const result = await run(app, ['push', 'demo', '--message', 'test']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNRELATED_STAGED_CHANGES/);
});


test('push stages, commits and pushes only the requested skill', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);
  await writeFile(path.join(repo, 'skills', 'demo', 'changed.md'), 'changed\n');
  await writeFile(path.join(repo, 'README.md'), 'unrelated\n');

  const result = await run(app, ['push', 'demo', '--message', 'update demo']);
  assert.equal(result.code, 0, result.stderr);
  const { stdout } = await execFileAsync('git', ['--git-dir', remote, 'show', 'main:skills/demo/changed.md'], { encoding: 'utf8' });
  assert.equal(stdout, 'changed\n');
  const files = (await execFileAsync('git', ['-C', repo, 'show', '--format=', '--name-only', 'HEAD'], { encoding: 'utf8' })).stdout;
  assert.match(files, /skills\/demo\/changed\.md/);
  assert.doesNotMatch(files, /README\.md/);
});

test('sync automatically merges divergent local and remote commits', async () => {
  const { remote, source, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);
  await writeFile(path.join(repo, 'skills', 'demo', 'local.md'), 'local\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'local change']);

  await writeFile(path.join(source, 'skills', 'demo', 'remote.md'), 'remote\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'remote change']);
  await git(source, ['push', '-qu', 'origin', 'main']);

  const result = await run(app, ['sync']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path.join(repo, 'skills', 'demo', 'local.md'), 'utf8'), 'local\n');
  assert.equal(await readFile(path.join(repo, 'skills', 'demo', 'remote.md'), 'utf8'), 'remote\n');
});

test('sync --autostash restores local worktree changes after remote update', async () => {
  const { remote, source, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);
  await writeFile(path.join(repo, 'skills', 'demo', 'local.md'), 'uncommitted\n');

  await writeFile(path.join(source, 'skills', 'demo', 'remote.md'), 'remote\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'remote change']);
  await git(source, ['push', '-qu', 'origin', 'main']);

  const result = await run(app, ['sync', '--autostash']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path.join(repo, 'skills', 'demo', 'local.md'), 'utf8'), 'uncommitted\n');
  assert.equal(await readFile(path.join(repo, 'skills', 'demo', 'remote.md'), 'utf8'), 'remote\n');
});

test('global sync and install use the user home scope', async () => {
  const { remote, root } = await setup();
  const userHome = path.join(root, 'user-home');
  const workbenchHome = path.join(root, 'global-workbench');
  const env = { ...process.env, SKILL_WORKBENCH_USER_HOME: userHome, SKILL_WORKBENCH_HOME: workbenchHome };
  const synced = await run(root, ['sync', remote, '-g'], { env });
  assert.equal(synced.code, 0, synced.stderr);
  const installed = await run(root, ['install', 'demo', '-g'], { env });
  assert.equal(installed.code, 0, installed.stderr);
  const target = path.join(userHome, '.agents', 'skills', 'demo');
  assert.equal((await lstat(target)).isSymbolicLink(), true);
  const globalConfig = JSON.parse(await readFile(path.join(workbenchHome, 'config.json'), 'utf8'));
  assert.equal(globalConfig.repoPath, 'remote');
});

test('local-wins uses force-with-lease and remote-wins restores a backup ref', async () => {
  const { remote, source, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);

  await writeFile(path.join(repo, 'skills', 'demo', 'local.md'), 'local\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'local change']);
  await writeFile(path.join(source, 'skills', 'demo', 'remote.md'), 'remote\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'remote change']);
  await git(source, ['push', '-qu', 'origin', 'main']);

  const localWins = await run(app, ['sync', '--reconcile', 'local-wins', '--yes']);
  assert.equal(localWins.code, 0, localWins.stderr);
  const remoteHeadAfterLocalWins = (await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim();
  const localHead = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  assert.equal(remoteHeadAfterLocalWins, localHead);

  await writeFile(path.join(repo, 'skills', 'demo', 'local2.md'), 'local2\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'second local change']);
  const remoteWins = await run(app, ['sync', '--reconcile', 'remote-wins', '--yes']);
  assert.equal(remoteWins.code, 0, remoteWins.stderr);
  await assert.rejects(() => lstat(path.join(repo, 'skills', 'demo', 'local2.md')));
  const refs = (await execFileAsync('git', ['-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/skill-workbench/backup'], { encoding: 'utf8' })).stdout;
  assert.match(refs, /refs\/skill-workbench\/backup\/local-/);
});

test('sync --continue completes a stash restore conflict after manual resolution', async () => {
  const { remote, source, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);
  const skillFile = path.join(repo, 'skills', 'demo', 'SKILL.md');
  await writeFile(skillFile, '# Local\n');

  await writeFile(path.join(source, 'skills', 'demo', 'SKILL.md'), '# Remote\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'remote conflict']);
  await git(source, ['push', '-qu', 'origin', 'main']);

  const syncing = await run(app, ['sync', '--autostash']);
  assert.equal(syncing.code, 2);
  assert.match(syncing.stderr, /AUTOSTASH_CONFLICT/);
  await writeFile(skillFile, '# Resolved\n');
  await git(repo, ['add', skillFile]);
  const continued = await run(app, ['sync', '--continue']);
  assert.equal(continued.code, 0, continued.stderr);
  assert.equal(await readFile(skillFile, 'utf8'), '# Resolved\n');
});

test('sync refuses to restore autostash onto a different branch', async () => {
  const { remote, source, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const repo = await syncedRepo(app);
  await git(repo, ['checkout', '-qb', 'feature']);
  await writeFile(path.join(repo, 'skills', 'demo', 'branch-local.md'), 'local\n');
  const result = await run(app, ['sync', '--branch', 'main', '--autostash']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /BRANCH_AUTOSTASH_CONFLICT/);
  assert.equal(await readFile(path.join(repo, 'skills', 'demo', 'branch-local.md'), 'utf8'), 'local\n');
});

test('autostash cannot be combined with destructive reconcile strategies', async () => {
  const { remote, app } = await setup();
  assert.equal((await run(app, ['sync', remote])).code, 0);
  const result = await run(app, ['sync', '--autostash', '--reconcile', 'remote-wins']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /INVALID_RECONCILE/);
});

test('sync accepts -g as the global scope shorthand', async () => {
  const { remote, root } = await setup();
  const userHome = path.join(root, 'user-home-short-flag');
  const workbenchHome = path.join(root, 'global-workbench-short-flag');
  const env = { ...process.env, SKILL_WORKBENCH_USER_HOME: userHome, SKILL_WORKBENCH_HOME: workbenchHome };
  const result = await run(root, ['sync', remote, '-g', '-b', 'main'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await lstat(path.join(workbenchHome, 'remote'))).isDirectory(), true);
});
