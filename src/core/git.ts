import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkbenchError } from './errors.js';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      shell: false
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = (failure.stderr || failure.message || '').trim();
    throw new WorkbenchError(`git ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`, 'GIT_FAILED', 3);
  }
}

export async function tryGit(cwd: string, args: string[]): Promise<GitResult | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

export interface StatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

export function parsePorcelainZ(output: string): StatusEntry[] {
  const tokens = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const index = token[0] ?? ' ';
    const worktree = token[1] ?? ' ';
    const path = token.slice(3);
    const entry: StatusEntry = { index, worktree, path };
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const originalPath = tokens[i + 1];
      if (originalPath) {
        entry.originalPath = originalPath;
        i += 1;
      }
    }
    entries.push(entry);
  }
  return entries;
}

export async function statusEntries(repoPath: string): Promise<StatusEntry[]> {
  const result = await git(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return parsePorcelainZ(result.stdout);
}

export async function stagedPaths(repoPath: string): Promise<string[]> {
  const result = await git(repoPath, ['diff', '--cached', '--name-only', '-z']);
  return result.stdout.split('\0').filter(Boolean);
}
