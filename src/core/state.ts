import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathsForScope, scopedRelative, type Scope } from './paths.js';
import { WorkbenchError } from './errors.js';

export interface LinkTargetRecord { target: string; agents?: string[]; backup?: string; linkedAt: string; }
export interface LinkRecord { source: string; target: string; backup?: string; linkedAt: string; targets?: LinkTargetRecord[]; }
export interface WorkbenchState { version: 1; scope: Scope; links: Record<string, LinkRecord>; }

export async function loadState(scope: Scope = 'project'): Promise<WorkbenchState> {
  const stateFile = pathsForScope(scope).stateFile;
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<WorkbenchState>;
    if (parsed.version !== 1 || !parsed.links || typeof parsed.links !== 'object') throw new WorkbenchError(`${stateFile} 状态格式无效。`, 'INVALID_STATE', 2);
    return { version: 1, scope, links: parsed.links as Record<string, LinkRecord> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, scope, links: {} };
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(`${stateFile} 不是有效 JSON。`, 'INVALID_STATE', 2);
  }
}

export async function saveState(state: WorkbenchState): Promise<void> {
  const paths = pathsForScope(state.scope);
  await mkdir(paths.workbenchDir, { recursive: true });
  const temp = path.join(paths.workbenchDir, `state.json.tmp-${process.pid}`);
  const { scope: _scope, ...persisted } = state;
  void _scope;
  await writeFile(temp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  await rename(temp, paths.stateFile);
}

export function toStatePath(absPath: string, scope: Scope = 'project'): string { return scopedRelative(absPath, scope); }
