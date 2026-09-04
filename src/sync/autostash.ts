import { git, gitOutput, statusEntries } from '../core/git.js';
import { WorkbenchError } from '../core/errors.js';

export async function createAutostash(repoPath: string): Promise<string | undefined> {
  if ((await statusEntries(repoPath)).length === 0) return undefined;
  await git(repoPath, ['stash', 'push', '--include-untracked', '-m', `skill-workbench sync ${new Date().toISOString()}`]);
  const stash = (await gitOutput(repoPath, ['rev-parse', 'stash@{0}'])).trim();
  if (!stash) throw new WorkbenchError('自动 stash 未生成可恢复的 stash。', 'AUTOSTASH_FAILED', 1);
  return stash;
}

async function stashReference(repoPath: string, stash: string): Promise<string> {
  const list = (await gitOutput(repoPath, ['stash', 'list', '--format=%H'])).split('\n').filter(Boolean);
  const index = list.findIndex((value) => value === stash);
  if (index < 0) throw new WorkbenchError(`找不到自动 stash，拒绝继续以避免丢失工作区改动：${stash}`, 'AUTOSTASH_MISSING', 2);
  return `stash@{${index}}`;
}

export async function restoreAutostash(repoPath: string, stash: string | undefined): Promise<void> {
  if (!stash) return;
  const reference = await stashReference(repoPath, stash);
  try {
    await git(repoPath, ['stash', 'apply', reference]);
  } catch {
    throw new WorkbenchError(`Git 同步已完成，但自动 stash 恢复发生冲突；stash 仍保留：${stash}`, 'AUTOSTASH_CONFLICT', 2);
  }
  try {
    await dropAutostash(repoPath, stash);
  } catch {
    throw new WorkbenchError(`工作区已恢复，但自动 stash 删除失败；stash 仍保留：${stash}`, 'AUTOSTASH_DROP_FAILED', 2);
  }
}

export async function dropAutostash(repoPath: string, stash: string): Promise<void> {
  const reference = await stashReference(repoPath, stash);
  await git(repoPath, ['stash', 'drop', reference]);
}

export async function ensureCleanOrStash(repoPath: string, enabled: boolean): Promise<string | undefined> {
  const dirty = await statusEntries(repoPath);
  if (dirty.length === 0) return undefined;
  if (!enabled) {
    throw new WorkbenchError(
      `skill 仓库有未提交或未跟踪改动，默认拒绝同步；可先 commit/stash，或重试 --autostash：\n  ${dirty.map((entry) => `${entry.index}${entry.worktree} ${entry.path}`).join('\n  ')}`,
      'DIRTY_REPO',
      1
    );
  }
  return createAutostash(repoPath);
}
