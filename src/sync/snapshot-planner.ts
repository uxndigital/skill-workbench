import { WorkbenchError } from '../core/errors.js';
import { commitRelation, currentBranch, readHead, readRef, readUpstream, type CommitRelation, type UpstreamRef } from './git-ops.js';

export interface RepoSnapshot {
  branch: string;
  upstream: UpstreamRef;
  headOid: string;
  upstreamOid: string;
  relation: CommitRelation;
}

export type ReconcileStrategy = 'auto' | 'abort' | 'local-wins' | 'remote-wins';
export type SyncAction = 'noop' | 'retain-local' | 'fast-forward' | 'merge' | 'local-wins' | 'remote-wins' | 'abort';

export interface SyncPlan { action: SyncAction; relation: CommitRelation; upstream: UpstreamRef; remoteOid: string; }

export async function captureSnapshot(repoPath: string): Promise<RepoSnapshot> {
  const branch = await currentBranch(repoPath);
  if (!branch) throw new WorkbenchError('当前处于 detached HEAD，拒绝自动同步。', 'DETACHED_HEAD', 1);
  const upstream = await readUpstream(repoPath);
  if (!upstream) throw new WorkbenchError('当前分支没有 upstream，拒绝自动同步。', 'NO_UPSTREAM', 1);
  const headOid = await readHead(repoPath);
  const upstreamOid = await readRef(repoPath, upstream.fullName);
  return { branch, upstream, headOid, upstreamOid, relation: await commitRelation(repoPath, upstream.fullName) };
}

export function planSync(snapshot: RepoSnapshot, reconcile: ReconcileStrategy): SyncPlan {
  if (snapshot.relation === 'equal') return { action: 'noop', relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
  if (snapshot.relation === 'local-ahead') {
    const action = reconcile === 'local-wins' ? 'local-wins' : reconcile === 'remote-wins' ? 'remote-wins' : 'retain-local';
    return { action, relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
  }
  if (snapshot.relation === 'remote-ahead') {
    const action = reconcile === 'local-wins' ? 'local-wins' : reconcile === 'remote-wins' ? 'remote-wins' : reconcile === 'abort' ? 'abort' : 'fast-forward';
    return { action, relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
  }
  if (reconcile === 'local-wins') return { action: 'local-wins', relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
  if (reconcile === 'remote-wins') return { action: 'remote-wins', relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
  if (reconcile === 'abort') return { action: 'abort', relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
  return { action: 'merge', relation: snapshot.relation, upstream: snapshot.upstream, remoteOid: snapshot.upstreamOid };
}
