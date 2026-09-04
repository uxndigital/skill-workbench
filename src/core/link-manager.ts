import { lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchError } from './errors.js';
import {
  assertExistingPathInsideScope,
  displayPath,
  isPathInside,
  pathExists,
  pathsForScope,
  resolveStatePath,
  type Scope
} from './paths.js';
import { loadState, saveState, toStatePath, type LinkRecord, type LinkTargetRecord, type WorkbenchState } from './state.js';
import type { SkillSource } from './skill-resolver.js';
import type { WorkbenchConfig } from './config.js';
import { targetDirFromConfig } from './config.js';
import { createInterface } from 'node:readline/promises';

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new WorkbenchError('当前环境不是交互终端，拒绝覆盖真实文件或目录。', 'NON_INTERACTIVE_CONFIRMATION', 1);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return ['y', 'yes'].includes((await readline.question(`${question} [y/N] `)).trim().toLowerCase()); }
  finally { readline.close(); }
}

async function lstatSafe(target: string) {
  try { return await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function linkTargetAbsolute(target: string, linkValue: string): string { return path.resolve(path.dirname(target), linkValue); }

async function createRelativeLink(source: string, target: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.skill-workbench-link-${process.pid}-${Date.now()}`);
  const linkValue = path.relative(path.dirname(target), source) || '.';
  try { await symlink(linkValue, temporary, 'dir'); await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

function backupPath(scope: Scope, skill: string, target: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetName = target.replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(pathsForScope(scope).workbenchDir, 'backups', skill, `${stamp}-${process.pid}-${targetName}`, 'payload');
}

function targetRecords(record: LinkRecord): LinkTargetRecord[] {
  if (record.targets && record.targets.length > 0) return record.targets;
  return [{ target: record.target, ...(record.backup ? { backup: record.backup } : {}), linkedAt: record.linkedAt }];
}

function makeLinkRecord(source: string, targets: LinkTargetRecord[]): LinkRecord {
  const primary = targets[0]!;
  return { source, target: primary.target, ...(primary.backup ? { backup: primary.backup } : {}), linkedAt: primary.linkedAt, targets };
}

function updateLinkState(state: WorkbenchState, skill: string, source: string, targets: LinkTargetRecord[]): void {
  if (targets.length === 0) delete state.links[skill];
  else state.links[skill] = makeLinkRecord(source, targets);
}

export async function linkSkill(config: WorkbenchConfig, source: SkillSource): Promise<void> {
  const scope = config.scope;
  const targetRoot = targetDirFromConfig(config);
  await mkdir(targetRoot, { recursive: true });
  await assertExistingPathInsideScope(targetRoot, 'targetDir', scope);
  const target = path.join(targetRoot, source.name);
  if (!isPathInside(targetRoot, target)) throw new WorkbenchError('skill 目标路径无效。', 'INVALID_PATH', 2);

  const existing = await lstatSafe(target);
  const state = await loadState(scope);
  const previous = state.links[source.name];
  const previousTargets = previous ? targetRecords(previous) : [];
  const targetStatePath = toStatePath(target, scope);
  const previousTarget = previousTargets.find((record) => record.target === targetStatePath);
  let backup = previousTarget?.backup;
  let movedBackup: string | undefined;

  if (existing && !existing.isSymbolicLink()) {
    const backupAbs = backupPath(scope, source.name, targetStatePath);
    const accepted = await confirm(`目标已存在且不是软链接，将备份到\n  ${displayPath(backupAbs, scope)}\n确认覆盖 ${displayPath(target, scope)}？`);
    if (!accepted) { console.log('已取消，原目标保持不变。'); return; }
    await mkdir(path.dirname(backupAbs), { recursive: true });
    await rename(target, backupAbs);
    backup = toStatePath(backupAbs, scope);
    movedBackup = backupAbs;
  } else if (existing?.isSymbolicLink()) await rm(target);

  try { await createRelativeLink(source.path, target); }
  catch (error) {
    if (movedBackup) await rename(movedBackup, target).catch(() => undefined);
    throw new WorkbenchError(`创建软链接失败：${(error as Error).message}`, 'LINK_FAILED', 1);
  }

  const linkedAt = new Date().toISOString();
  const nextTarget: LinkTargetRecord = { target: targetStatePath, ...(backup ? { backup } : {}), linkedAt };
  const remainingTargets = previousTargets.filter((record) => record.target !== targetStatePath);
  updateLinkState(state, source.name, toStatePath(source.path, scope), [...remainingTargets, nextTarget]);
  await saveState(state);
  console.log(`已安装 ${source.name}`);
  console.log(`  ${displayPath(target, scope)} -> ${displayPath(source.path, scope)}`);
}

export async function unlinkSkill(config: WorkbenchConfig, skill: string): Promise<void> {
  const scope = config.scope;
  const target = path.join(targetDirFromConfig(config), skill);
  const state = await loadState(scope);
  const stateRecord = state.links[skill];
  const records = stateRecord ? targetRecords(stateRecord) : [];
  const targetStatePath = toStatePath(target, scope);
  const targetRecord = records.find((record) => record.target === targetStatePath);
  const existing = await lstatSafe(target);

  if (!existing) {
    if (targetRecord) { updateLinkState(state, skill, stateRecord!.source, records.filter((record) => record.target !== targetStatePath)); await saveState(state); }
    console.log(`未找到 ${skill} 的软链接，视为已卸载。`);
    return;
  }
  if (!existing.isSymbolicLink()) throw new WorkbenchError(`目标不是软链接，拒绝删除：${displayPath(target, scope)}`, 'LINK_CONFLICT', 1);

  const actual = linkTargetAbsolute(target, await readlink(target));
  const expected = targetRecord ? resolveStatePath(stateRecord!.source, scope) : undefined;
  if (!expected) throw new WorkbenchError(`找不到 ${skill} 的 workbench 状态记录，拒绝删除未知软链接。`, 'UNMANAGED_LINK', 1);
  if (path.resolve(actual) !== path.resolve(expected)) throw new WorkbenchError(`软链接目标已变化，拒绝删除：${displayPath(target, scope)}`, 'WRONG_LINK_TARGET', 1);

  if (targetRecord?.backup) {
    const backup = resolveStatePath(targetRecord.backup, scope);
    if (!(await pathExists(backup))) throw new WorkbenchError(`备份不存在，拒绝卸载以避免不可恢复：${displayPath(backup, scope)}`, 'BACKUP_MISSING', 1);
    await rm(target, { force: true });
    await rename(backup, target);
  } else await rm(target, { force: true });

  updateLinkState(state, skill, stateRecord!.source, records.filter((record) => record.target !== targetStatePath));
  await saveState(state);
  console.log(`已卸载 ${skill}。`);
}

export interface LinkStatus { skill: string; status: 'OK' | 'BROKEN' | 'WRONG_TARGET' | 'MISSING' | 'CONFLICT'; target: string; detail?: string; }

export async function inspectLinks(config: WorkbenchConfig, state: WorkbenchState): Promise<LinkStatus[]> {
  const scope = config.scope;
  const result: LinkStatus[] = [];
  for (const [skill, record] of Object.entries(state.links)) {
    for (const targetRecord of targetRecords(record)) {
      const target = resolveStatePath(targetRecord.target, scope);
      const info = await lstatSafe(target);
      if (!info) { result.push({ skill, status: 'MISSING', target: targetRecord.target }); continue; }
      if (!info.isSymbolicLink()) { result.push({ skill, status: 'CONFLICT', target: targetRecord.target }); continue; }
      const actual = linkTargetAbsolute(target, await readlink(target));
      const expected = resolveStatePath(record.source, scope);
      if (path.resolve(actual) !== path.resolve(expected)) { result.push({ skill, status: 'WRONG_TARGET', target: targetRecord.target, detail: displayPath(actual, scope) }); continue; }
      const sourceInfo = await lstatSafe(expected);
      result.push({ skill, status: sourceInfo ? 'OK' : 'BROKEN', target: targetRecord.target, ...(sourceInfo ? {} : { detail: '源目录不存在' }) });
    }
  }
  return result;
}
