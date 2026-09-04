import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchError } from './errors.js';
import { isPathInside } from './paths.js';

export interface SkillSource {
  name: string;
  path: string;
  relativePath: string;
}

export function validateSkillName(skill: string): void {
  if (!skill || skill === '.' || skill === '..' || skill.includes('/') || skill.includes('\\') || /[\0\x00-\x1f\x7f]/.test(skill)) {
    throw new WorkbenchError(`Invalid skill name: ${skill}`, 'INVALID_SKILL_NAME', 2);
  }
}

async function directoryRealPath(candidate: string, repoRealPath: string): Promise<string | null> {
  try {
    const info = await lstat(candidate);
    if (!info.isDirectory() && !info.isSymbolicLink()) return null;
    const resolved = await realpath(candidate);
    if (!isPathInside(repoRealPath, resolved)) {
      throw new WorkbenchError(`Skill source directory escapes repository: ${candidate}`, 'PATH_ESCAPE', 2);
    }
    const resolvedInfo = await lstat(resolved);
    return resolvedInfo.isDirectory() ? resolved : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof WorkbenchError) throw error;
    return null;
  }
}

export async function resolveSkill(repoPath: string, skill: string): Promise<SkillSource> {
  validateSkillName(skill);
  const repoRealPath = await realpath(repoPath).catch(() => {
    throw new WorkbenchError(`Skill repository does not exist: ${repoPath}`, 'REPO_NOT_FOUND', 1);
  });
  const candidates = [
    path.join(repoPath, skill),
    path.join(repoPath, 'skills', skill),
    path.join(repoPath, '.agents', 'skills', skill)
  ];
  const resolved = new Map<string, string>();
  for (const candidate of candidates) {
    const actual = await directoryRealPath(candidate, repoRealPath);
    if (actual) resolved.set(actual, candidate);
  }

  if (resolved.size === 0) {
    throw new WorkbenchError(`Skill not found: ${skill}`, 'SKILL_NOT_FOUND', 1);
  }
  if (resolved.size > 1) {
    throw new WorkbenchError(`Ambiguous skill source: ${skill}`, 'AMBIGUOUS_SKILL_SOURCE', 1);
  }

  const sourcePath = [...resolved.keys()][0]!;
  return { name: skill, path: sourcePath, relativePath: path.relative(repoRealPath, sourcePath) };
}

export async function discoverSkillSources(repoPath: string): Promise<SkillSource[]> {
  const repoRealPath = await realpath(repoPath);
  const candidates: string[] = [];
  const roots = [repoRealPath, path.join(repoRealPath, 'skills'), path.join(repoRealPath, '.agents', 'skills')];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.skill-workbench' || (root === repoRealPath && (entry.name === 'skills' || entry.name === '.agents'))) continue;
      const candidate = path.join(root, entry.name);
      const source = await directoryRealPath(candidate, repoRealPath);
      if (source) candidates.push(source);
    }
  }

  const unique = [...new Set(candidates)];
  return unique.map((sourcePath) => ({
    name: path.basename(sourcePath),
    path: sourcePath,
    relativePath: path.relative(repoRealPath, sourcePath)
  }));
}

export function pathBelongsToSkill(relativePath: string, skillRelativePath: string): boolean {
  const normalizedPath = relativePath.split(path.sep).join('/');
  const normalizedSkill = skillRelativePath.split(path.sep).join('/').replace(/\/$/, '');
  return normalizedPath === normalizedSkill || normalizedPath.startsWith(`${normalizedSkill}/`);
}
