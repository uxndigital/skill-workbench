import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchError } from './errors.js';

export type Scope = 'project' | 'global';

export const PROJECT_ROOT = path.resolve(process.cwd());
export const USER_HOME = process.env.SKILL_WORKBENCH_USER_HOME
  ? path.resolve(process.env.SKILL_WORKBENCH_USER_HOME)
  : os.homedir();
export const GLOBAL_WORKBENCH_DIR = process.env.SKILL_WORKBENCH_HOME
  ? path.resolve(process.env.SKILL_WORKBENCH_HOME)
  : path.join(USER_HOME, '.skill-workbench');
export const WORKBENCH_DIR = path.join(PROJECT_ROOT, '.skill-workbench');
export const CONFIG_FILE = path.join(WORKBENCH_DIR, 'config.json');
export const STATE_FILE = path.join(WORKBENCH_DIR, 'state.json');
export const LOCK_FILE = path.join(WORKBENCH_DIR, 'operation.lock');

export const DEFAULT_REPO_PATH = '.skill-workbench/skills-repo';
export const DEFAULT_GLOBAL_REPO_PATH = 'skills-repo';
export const DEFAULT_TARGET_DIR = '.agents/skills';
export const DEFAULT_GLOBAL_TARGET_DIR = path.join(USER_HOME, '.agents', 'skills');

export interface ScopePaths {
  scope: Scope;
  root: string;
  workbenchDir: string;
  configFile: string;
  stateFile: string;
  lockFile: string;
}

export function pathsForScope(scope: Scope): ScopePaths {
  if (scope === 'global') {
    return { scope, root: USER_HOME, workbenchDir: GLOBAL_WORKBENCH_DIR, configFile: path.join(GLOBAL_WORKBENCH_DIR, 'config.json'), stateFile: path.join(GLOBAL_WORKBENCH_DIR, 'state.json'), lockFile: path.join(GLOBAL_WORKBENCH_DIR, 'operation.lock') };
  }
  return { scope, root: PROJECT_ROOT, workbenchDir: WORKBENCH_DIR, configFile: CONFIG_FILE, stateFile: STATE_FILE, lockFile: LOCK_FILE };
}

export function repositoryDirectoryName(gitUrl: string): string {
  const withoutQuery = gitUrl.trim().replace(/[/?]+$/, '').split(/[?#]/, 1)[0] ?? '';
  const lastSegment = withoutQuery.split(/[/:]/).pop() ?? '';
  const name = lastSegment.replace(/\.git$/i, '').trim();
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return safeName || 'skills-repo';
}

export function defaultRepoPathForUrl(gitUrl: string, scope: Scope = 'project'): string {
  return path.join('.skill-workbench', repositoryDirectoryName(gitUrl));
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateProjectRelativePath(value: string, label: string): string {
  if (!value || path.isAbsolute(value)) throw new WorkbenchError(`${label} 必须是项目内的相对路径。`, 'INVALID_PATH', 2);
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new WorkbenchError(`${label} 不能通过 .. 逃出项目目录。`, 'INVALID_PATH', 2);
  return normalized;
}

export function validateGlobalPath(value: string, label: string): string {
  if (!value) throw new WorkbenchError(`${label} 不能为空。`, 'INVALID_PATH', 2);
  const resolved = path.resolve(value.startsWith('~') ? path.join(USER_HOME, value.slice(1)) : path.isAbsolute(value) ? value : path.join(USER_HOME, value));
  if (!isPathInside(USER_HOME, resolved) || resolved === USER_HOME) throw new WorkbenchError(`${label} 必须位于用户目录内且不能是用户目录本身。`, 'INVALID_PATH', 2);
  return resolved;
}

export function resolveScopedPath(value: string, label: string, scope: Scope): string {
  if (scope === 'project') return path.resolve(PROJECT_ROOT, validateProjectRelativePath(value, label));
  return validateGlobalPath(value, label);
}

export function resolveRepoPathValue(value: string, label: string, scope: Scope): string {
  if (scope === 'project') return path.resolve(PROJECT_ROOT, validateProjectRelativePath(value, label));
  const resolved = path.resolve(GLOBAL_WORKBENCH_DIR, value);
  if (!isPathInside(GLOBAL_WORKBENCH_DIR, resolved) || resolved === GLOBAL_WORKBENCH_DIR) throw new WorkbenchError(`${label} 必须位于全局 workbench 目录内。`, 'INVALID_PATH', 2);
  return resolved;
}

export function resolveTargetPathValue(value: string, label: string, scope: Scope): string {
  if (scope === 'project') return path.resolve(PROJECT_ROOT, validateProjectRelativePath(value, label));
  return validateGlobalPath(value, label);
}

export function configRelativePath(absPath: string, scope: Scope, kind: 'repo' | 'target'): string {
  const root = scope === 'global' && kind === 'repo' ? GLOBAL_WORKBENCH_DIR : pathsForScope(scope).root;
  return path.relative(root, absPath) || '.';
}

export function resolveProjectPath(value: string, label: string): string {
  return resolveScopedPath(value, label, 'project');
}

export function projectRelative(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath) || '.';
}

export function displayPath(absPath: string, scope: Scope): string {
  const root = scope === 'global' ? USER_HOME : PROJECT_ROOT;
  const relative = path.relative(root, absPath);
  return scope === 'global' ? (relative ? `~/${relative}` : '~') : (relative || '.');
}

export function scopedRelative(absPath: string, scope: Scope): string {
  return path.relative(pathsForScope(scope).root, absPath) || '.';
}

export function resolveStatePath(value: string, scope: Scope): string {
  return path.resolve(pathsForScope(scope).root, value);
}

export async function assertExistingPathInsideScope(target: string, label: string, scope: Scope): Promise<void> {
  const root = pathsForScope(scope).root;
  const resolvedRoot = await realpath(root).catch(() => root);
  let current = target;
  while (true) {
    try {
      const resolved = await realpath(current);
      if (!isPathInside(resolvedRoot, resolved)) throw new WorkbenchError(`${label} 的真实路径逃出了 ${scope} 目录。`, 'PATH_ESCAPE', 2);
      return;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      if (current === root || current === path.dirname(current)) return;
      current = path.dirname(current);
    }
  }
}

export async function assertExistingPathInsideProject(target: string, label: string): Promise<void> {
  return assertExistingPathInsideScope(target, label, 'project');
}

export async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
