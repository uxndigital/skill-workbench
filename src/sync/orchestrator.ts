import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, repoPathFromConfig, saveConfig, type WorkbenchConfig } from '../core/config.js';
import { WorkbenchError } from '../core/errors.js';
import { git, statusEntries, tryGit } from '../core/git.js';
import { withOperationLock } from '../core/lock.js';
import { configRelativePath, defaultRepoPathForUrl, displayPath, pathExists, pathsForScope, resolveRepoPathValue, type Scope } from '../core/paths.js';
import { createBackupRef, currentBranch, detectGitOperation, fetchPrune, pushLocalWins, resetRemoteWins, switchToBranch, validateBranch, type UpstreamRef } from './git-ops.js';
import { captureSnapshot, planSync, type ReconcileStrategy } from './snapshot-planner.js';
import { dropAutostash, ensureCleanOrStash, restoreAutostash } from './autostash.js';
import { assertSyncStateMatchesRepo, clearSyncState, loadSyncState, saveSyncState, updateSyncPhase, type SyncState } from './operation-store.js';

interface SyncOptions {
  scope: Scope;
  reconcile: ReconcileStrategy;
  autostash: boolean;
  yes: boolean;
  clean: boolean;
}

export type SyncCommandOptions = {
  scope?: Scope | undefined;
  reconcile?: ReconcileStrategy | undefined;
  autostash?: boolean | undefined;
  yes?: boolean | undefined;
  clean?: boolean | undefined;
};

function scopeName(scope: Scope): string { return scope === 'global' ? '全局' : '项目'; }
function displayRepo(repoPath: string, scope: Scope): string { return displayPath(repoPath, scope); }
async function requireRepo(config: WorkbenchConfig): Promise<string> {
  const repoPath = repoPathFromConfig(config);
  try {
    const info = await lstat(repoPath);
    if (!info.isDirectory()) throw new Error('not-directory');
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    const otherScope: Scope = config.scope === 'global' ? 'project' : 'global';
    const otherConfig = await loadConfig(otherScope);
    const otherRepoPath = repoPathFromConfig(otherConfig);
    let hint = '';
    try {
      const otherInfo = await lstat(otherRepoPath);
      if (otherInfo.isDirectory() && await tryGit(otherRepoPath, ['rev-parse', '--show-toplevel'])) {
        hint = `\n提示：检测到${otherScope === 'global' ? '全局' : '项目级'}仓库 ${displayRepo(otherRepoPath, otherScope)}，是否想使用 ${otherScope === 'global' ? '--global' : '--project'}？`;
      }
    } catch {}
    throw new WorkbenchError(`skill 仓库不存在：${displayRepo(repoPath, config.scope)}，请先运行 sync。${hint}`, 'REPO_NOT_FOUND', 1);
  }
  if (!(await tryGit(repoPath, ['rev-parse', '--show-toplevel']))) throw new WorkbenchError(`不是 Git 仓库：${displayRepo(repoPath, config.scope)}`, 'NOT_GIT_REPO', 1);
  return repoPath;
}

async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new WorkbenchError('非交互环境执行破坏性同步必须使用 --yes。', 'CONFIRMATION_REQUIRED', 2);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} [y/N] `)).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) throw new WorkbenchError('已取消破坏性同步。', 'OPERATION_CANCELLED', 1);
  } finally { readline.close(); }
}

async function executeLocalWins(repoPath: string, upstream: UpstreamRef, remoteOid: string, options: SyncOptions): Promise<void> {
  await confirm(`即将用本地 HEAD 覆盖 ${upstream.fullName}（远端 ${remoteOid.slice(0, 12)}）。继续？`, options.yes);
  const backup = await createBackupRef(repoPath, 'remote', upstream.fullName);
  try {
    await pushLocalWins(repoPath, upstream, remoteOid);
  } catch (error) {
    throw new WorkbenchError(`本地覆盖远端失败；远端备份 ref：${backup}`, 'LOCAL_WINS_FAILED', 1);
  }
  console.log(`已用本地版本覆盖 ${upstream.fullName}。远端旧版本保存在本地 ref：${backup}`);
}

async function executeRemoteWins(repoPath: string, upstream: string, options: SyncOptions): Promise<void> {
  await confirm(`即将丢弃本地提交并重置到 ${upstream}；未跟踪文件默认保留。继续？`, options.yes);
  if (options.clean) await confirm('即将额外删除所有未跟踪文件。继续？', options.yes);
  const backup = await createBackupRef(repoPath, 'local', 'HEAD');
  await resetRemoteWins(repoPath, upstream, options.clean);
  console.log(`已使用远端版本覆盖本地。原本地版本保存在：${backup}`);
}

export async function syncCommand(gitUrl: string | undefined, branch: string | undefined, options: SyncCommandOptions = {}): Promise<void> {
  const scope = options.scope ?? 'project';
  const syncOptions: SyncOptions = { scope, reconcile: options.reconcile ?? 'auto', autostash: options.autostash ?? false, yes: options.yes ?? false, clean: options.clean ?? false };
  await withOperationLock(async () => {
    if (branch && /[\0\x00-\x1f\x7f\s]/.test(branch)) throw new WorkbenchError('分支名无效。', 'INVALID_BRANCH', 2);
    if (syncOptions.autostash && syncOptions.reconcile !== 'auto') throw new WorkbenchError('--autostash 目前只能与 --reconcile auto 一起使用，不能用于覆盖策略。', 'INVALID_RECONCILE', 2);
    if (syncOptions.clean && syncOptions.reconcile !== 'remote-wins') throw new WorkbenchError('--clean 只能与 --reconcile remote-wins 一起使用。', 'INVALID_RECONCILE', 2);

    const configFile = pathsForScope(scope).configFile;
    const configExists = await pathExists(configFile);
    const config = await loadConfig(scope);
    let repoPath = repoPathFromConfig(config);
    if (!configExists && gitUrl && !(await pathExists(repoPath))) {
      const defaultPath = defaultRepoPathForUrl(gitUrl, scope);
      repoPath = resolveRepoPathValue(scope === 'global' ? path.join(pathsForScope(scope).workbenchDir, path.basename(defaultPath)) : defaultPath, 'repoPath', scope);
    }

    if (!(await pathExists(repoPath))) {
      if (!gitUrl) throw new WorkbenchError('首次 sync 必须提供 git 地址。', 'GIT_URL_REQUIRED', 2);
      await mkdir(path.dirname(repoPath), { recursive: true });
      const cloneArgs = ['clone'];
      if (branch) cloneArgs.push('--branch', branch);
      cloneArgs.push(gitUrl, repoPath);
      await git(path.dirname(repoPath), cloneArgs);
      await saveConfig({ ...config, scope, repoUrl: gitUrl, repoPath: configRelativePath(repoPath, scope, 'repo') });
      console.log(`已 clone ${scopeName(scope)} skill 仓库到 ${displayRepo(repoPath, scope)}`);
      return;
    }

    const remote = await tryGit(repoPath, ['config', '--get', 'remote.origin.url']);
    if (!remote) throw new WorkbenchError(`目标路径已存在但不是可用 Git 仓库：${displayRepo(repoPath, scope)}`, 'NOT_GIT_REPO', 1);
    const origin = remote.stdout.trim();
    if (gitUrl && gitUrl !== origin) throw new WorkbenchError('传入的 git 地址与现有 origin 不一致，拒绝自动切换远程仓库。', 'REMOTE_MISMATCH', 1);
    if (config.repoUrl && config.repoUrl !== origin) throw new WorkbenchError('配置中的 repoUrl 与现有 origin 不一致，请人工修正配置。', 'REMOTE_MISMATCH', 1);

    if (branch) await validateBranch(repoPath, branch);
    const operation = await detectGitOperation(repoPath);
    if (operation) throw new WorkbenchError(`仓库正在进行 Git ${operation} 操作，请先完成或中止该操作。`, 'GIT_OPERATION_IN_PROGRESS', 1);
    const currentBeforeStash = await currentBranch(repoPath);
    if (branch && syncOptions.autostash) {
      const dirty = await statusEntries(repoPath);
      if (dirty.length > 0 && currentBeforeStash && currentBeforeStash !== branch) throw new WorkbenchError('切换分支时不能使用 --autostash 恢复当前分支的改动到另一分支，请先手动处理工作区。', 'BRANCH_AUTOSTASH_CONFLICT', 1);
    }
    const stash = await ensureCleanOrStash(repoPath, syncOptions.autostash);
    const state: SyncState = { scope, repoPath: configRelativePath(repoPath, scope, 'repo'), ...((branch ?? currentBeforeStash) ? { branch: branch ?? currentBeforeStash } : {}), ...(stash ? { stash, phase: 'syncing' as const } : {}), createdAt: new Date().toISOString() };
    try {
      await saveSyncState(state);
    } catch (error) {
      if (stash) await restoreAutostash(repoPath, stash).catch(() => undefined);
      throw error;
    }
    try {
      await fetchPrune(repoPath);
      if (branch) await switchToBranch(repoPath, branch);
      const snapshot = await captureSnapshot(repoPath);
      const plan = planSync(snapshot, syncOptions.reconcile);
      if (plan.action === 'abort') throw new WorkbenchError('本地和远端历史发生分叉，已按 abort 策略停止。', 'DIVERGED', 1);
      if (plan.action === 'fast-forward') await git(repoPath, ['merge', '--ff-only', plan.upstream.fullName]);
      else if (plan.action === 'merge') {
        try { await git(repoPath, ['merge', '--no-edit', plan.upstream.fullName]); }
        catch { throw new WorkbenchError('自动合并发生冲突，已保留冲突现场；解决后运行 sync --continue，或运行 sync --abort。', 'MERGE_CONFLICT', 2); }
        console.log(`已自动合并 ${plan.upstream.fullName}，未自动推送。`);
      } else if (plan.action === 'local-wins') await executeLocalWins(repoPath, plan.upstream, plan.remoteOid, syncOptions);
      else if (plan.action === 'remote-wins') await executeRemoteWins(repoPath, plan.upstream.fullName, syncOptions);
      else if (plan.action === 'retain-local') console.log(`本地领先 ${plan.upstream.fullName}，未自动推送。`);
      else console.log('本地与远端已一致。');

      if (stash) await updateSyncPhase(scope, 'restoring-stash');
      await restoreAutostash(repoPath, stash);
      await clearSyncState(scope);
      await saveConfig({ ...config, scope, repoUrl: origin, repoPath: configRelativePath(repoPath, scope, 'repo') });
      console.log(`已同步 ${scopeName(scope)}仓库 ${displayRepo(repoPath, scope)}`);
      console.log(`当前分支：${snapshot.branch}`);
    } catch (error) {
      if (error instanceof WorkbenchError && ['MERGE_CONFLICT', 'AUTOSTASH_CONFLICT', 'AUTOSTASH_DROP_FAILED', 'AUTOSTASH_MISSING'].includes(error.code)) throw error;
      if (stash) {
        await updateSyncPhase(scope, 'restoring-stash');
        try {
          await restoreAutostash(repoPath, stash);
        } catch (restoreError) {
          throw restoreError;
        }
      }
      await clearSyncState(scope).catch(() => undefined);
      throw error;
    }
  }, scope);
}

export async function syncContinueCommand(scope: Scope = 'project'): Promise<void> {
  await withOperationLock(async () => {
    const config = await loadConfig(scope);
    const repoPath = await requireRepo(config);
    const state = await loadSyncState(scope);
    if (state) await assertSyncStateMatchesRepo(state, repoPath, await currentBranch(repoPath));
    const operation = await detectGitOperation(repoPath);
    if (operation && operation !== 'MERGE_HEAD') throw new WorkbenchError(`当前仓库正在进行 ${operation}，请直接使用 Git 处理，sync 不会自动继续该操作。`, 'GIT_OPERATION_IN_PROGRESS', 1);
    if (operation === 'MERGE_HEAD') {
      const unresolved = (await tryGit(repoPath, ['diff', '--name-only', '--diff-filter=U']))?.stdout.trim();
      if (unresolved) throw new WorkbenchError(`仍有未解决的冲突：\n  ${unresolved.split('\n').join('\n  ')}`, 'MERGE_CONFLICT', 2);
      await git(repoPath, ['commit', '--no-edit']);
      if (state?.stash) await updateSyncPhase(scope, 'restoring-stash');
      await restoreAutostash(repoPath, state?.stash);
      await clearSyncState(scope);
      console.log('已完成 merge。');
      return;
    }
    if (state?.stash && state.phase === 'restoring-stash') {
      const unresolved = (await tryGit(repoPath, ['diff', '--name-only', '--diff-filter=U']))?.stdout.trim();
      if (unresolved) throw new WorkbenchError(`自动 stash 恢复仍有冲突：\n  ${unresolved.split('\n').join('\n  ')}`, 'AUTOSTASH_CONFLICT', 2);
      await dropAutostash(repoPath, state.stash);
      await clearSyncState(scope);
      console.log('已完成自动 stash 恢复。');
      return;
    }
    if (state?.stash) {
      await restoreAutostash(repoPath, state.stash);
      await clearSyncState(scope);
      console.log('已完成自动 stash 恢复。');
      return;
    }
    throw new WorkbenchError('当前没有待继续的 merge 或 stash 恢复。', 'NO_MERGE_IN_PROGRESS', 1);
  }, scope);
}

export async function syncAbortCommand(scope: Scope = 'project'): Promise<void> {
  await withOperationLock(async () => {
    const config = await loadConfig(scope);
    const repoPath = await requireRepo(config);
    const state = await loadSyncState(scope);
    if (state) await assertSyncStateMatchesRepo(state, repoPath, await currentBranch(repoPath));
    const operation = await detectGitOperation(repoPath);
    if (!operation && !state?.stash) throw new WorkbenchError('当前没有可中止的同步操作。', 'NO_SYNC_IN_PROGRESS', 1);
    if (operation === 'MERGE_HEAD') await git(repoPath, ['merge', '--abort']);
    else if (operation === 'rebase-merge' || operation === 'rebase-apply') await git(repoPath, ['rebase', '--abort']);
    else if (operation === 'CHERRY_PICK_HEAD' || operation === 'REVERT_HEAD') throw new WorkbenchError(`当前仓库正在进行 ${operation}，请直接使用 Git 处理，sync 不会自动中止该操作。`, 'GIT_OPERATION_IN_PROGRESS', 1);
    if (state?.stash && state.phase !== 'restoring-stash') await restoreAutostash(repoPath, state.stash);
    else if (state?.stash && state.phase === 'restoring-stash') throw new WorkbenchError('stash 恢复已经开始，不能自动回滚；请解决冲突后运行 sync --continue。', 'AUTOSTASH_CONFLICT', 2);
    await clearSyncState(scope);
    console.log('已中止同步并恢复工作区。');
  }, scope);
}

