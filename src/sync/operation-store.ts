import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchError } from '../core/errors.js';
import { configRelativePath, pathsForScope, type Scope } from '../core/paths.js';

export type SyncPhase = 'syncing' | 'restoring-stash';

export interface SyncState {
  scope: Scope;
  repoPath: string;
  branch?: string;
  stash?: string;
  phase?: SyncPhase;
  createdAt: string;
}

export function stateFile(scope: Scope): string {
  return path.join(pathsForScope(scope).workbenchDir, 'sync-state.json');
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);
}

export async function loadSyncState(scope: Scope): Promise<SyncState | null> {
  const file = stateFile(scope);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SyncState>;
    const validBranch = parsed.branch === undefined || (typeof parsed.branch === 'string' && parsed.branch.length > 0);
    const validPhase = parsed.phase === undefined || parsed.phase === 'syncing' || parsed.phase === 'restoring-stash';
    if (
      parsed.scope !== scope ||
      typeof parsed.repoPath !== 'string' ||
      parsed.repoPath.length === 0 ||
      !validBranch ||
      (parsed.stash !== undefined && !isOid(parsed.stash)) ||
      !validPhase ||
      typeof parsed.createdAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new WorkbenchError(`${file} 状态格式无效。`, 'INVALID_STATE', 2);
    }
    return {
      scope,
      repoPath: parsed.repoPath,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      ...(parsed.stash ? { stash: parsed.stash } : {}),
      ...(parsed.phase ? { phase: parsed.phase } : {}),
      createdAt: parsed.createdAt
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(`${file} 不是有效 JSON。`, 'INVALID_STATE', 2);
  }
}

export async function assertSyncStateMatchesRepo(state: SyncState, repoPath: string, branch?: string): Promise<void> {
  const expected = configRelativePath(repoPath, state.scope, 'repo');
  if (state.repoPath !== expected || (state.branch && branch && state.branch !== branch)) {
    throw new WorkbenchError(
      `sync 状态对应的仓库或分支已变化：repo=${state.repoPath}, branch=${state.branch ?? '(unknown)'}；当前 repo=${expected}, branch=${branch ?? '(detached)'}`,
      'SYNC_STATE_MISMATCH',
      2
    );
  }
}

export async function saveSyncState(state: SyncState): Promise<void> {
  const dir = pathsForScope(state.scope).workbenchDir;
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `sync-state.json.tmp-${process.pid}`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, stateFile(state.scope));
}

export async function updateSyncPhase(scope: Scope, phase: SyncPhase): Promise<void> {
  const state = await loadSyncState(scope);
  if (state) await saveSyncState({ ...state, phase });
}

export async function clearSyncState(scope: Scope): Promise<void> {
  await rm(stateFile(scope), { force: true });
}
