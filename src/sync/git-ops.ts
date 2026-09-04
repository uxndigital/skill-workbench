import path from 'node:path';
import { git, gitOutput, tryGit } from '../core/git.js';
import { WorkbenchError } from '../core/errors.js';
import { pathExists } from '../core/paths.js';

export type GitOperation = 'MERGE_HEAD' | 'rebase-merge' | 'rebase-apply' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD';
export type CommitRelation = 'equal' | 'local-ahead' | 'remote-ahead' | 'diverged';

export interface UpstreamRef { remote: string; branch: string; fullName: string; }

export function parseUpstream(fullName: string): UpstreamRef {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) throw new WorkbenchError(`无法解析 upstream：${fullName}`, 'INVALID_UPSTREAM', 1);
  return { remote: fullName.slice(0, slash), branch: fullName.slice(slash + 1), fullName };
}

export async function validateBranch(repoPath: string, branch: string): Promise<void> {
  if (!branch || /[\0\x00-\x1f\x7f\s]/.test(branch) || branch.startsWith('-')) throw new WorkbenchError('分支名无效。', 'INVALID_BRANCH', 2);
  if (!(await tryGit(repoPath, ['check-ref-format', '--branch', branch]))) throw new WorkbenchError(`分支名无效：${branch}`, 'INVALID_BRANCH', 2);
}

export async function fetchPrune(repoPath: string): Promise<void> {
  await git(repoPath, ['fetch', '--prune']);
}

export async function currentBranch(repoPath: string): Promise<string> {
  return gitOutput(repoPath, ['branch', '--show-current']);
}

export async function switchToBranch(repoPath: string, branch: string): Promise<void> {
  if ((await currentBranch(repoPath)) === branch) return;
  if (await tryGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    await git(repoPath, ['switch', branch]);
    return;
  }
  if (await tryGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    await git(repoPath, ['switch', '--track', '-c', branch, `origin/${branch}`]);
    return;
  }
  throw new WorkbenchError(`找不到分支：${branch}`, 'BRANCH_NOT_FOUND', 1);
}

export async function readUpstream(repoPath: string): Promise<UpstreamRef | null> {
  const result = await tryGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const value = result?.stdout.trim();
  return value ? parseUpstream(value) : null;
}

export async function readHead(repoPath: string): Promise<string> {
  return gitOutput(repoPath, ['rev-parse', 'HEAD']);
}

export async function readRef(repoPath: string, ref: string): Promise<string> {
  return gitOutput(repoPath, ['rev-parse', ref]);
}

export async function commitRelation(repoPath: string, upstream: string): Promise<CommitRelation> {
  const head = await readHead(repoPath);
  const remote = await readRef(repoPath, upstream);
  if (head === remote) return 'equal';
  if (await tryGit(repoPath, ['merge-base', '--is-ancestor', upstream, 'HEAD'])) return 'local-ahead';
  if (await tryGit(repoPath, ['merge-base', '--is-ancestor', 'HEAD', upstream])) return 'remote-ahead';
  return 'diverged';
}

async function gitPath(repoPath: string, name: string): Promise<string> {
  return path.resolve(repoPath, await gitOutput(repoPath, ['rev-parse', '--git-path', name]));
}

export async function detectGitOperation(repoPath: string): Promise<GitOperation | null> {
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const) {
    if (await pathExists(await gitPath(repoPath, name))) return name;
  }
  return null;
}

export async function createBackupRef(repoPath: string, kind: 'local' | 'remote', ref: string): Promise<string> {
  const backup = `refs/skill-workbench/backup/${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await git(repoPath, ['update-ref', backup, ref]);
  return backup;
}

export async function pushLocalWins(repoPath: string, upstream: UpstreamRef, expectedRemoteOid: string): Promise<void> {
  await git(repoPath, ['push', upstream.remote, `HEAD:refs/heads/${upstream.branch}`, `--force-with-lease=refs/heads/${upstream.branch}:${expectedRemoteOid}`]);
}

export async function resetRemoteWins(repoPath: string, upstream: string, clean: boolean): Promise<void> {
  await git(repoPath, ['reset', '--hard', upstream]);
  if (clean) await git(repoPath, ['clean', '-fd']);
}
