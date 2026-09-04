import { open, mkdir, rm } from 'node:fs/promises';
import { pathsForScope, type Scope } from './paths.js';
import { WorkbenchError } from './errors.js';

export async function withOperationLock<T>(operation: () => Promise<T>, scope: Scope = 'project'): Promise<T> {
  const paths = pathsForScope(scope);
  await mkdir(paths.workbenchDir, { recursive: true });
  let handle;
  try {
    handle = await open(paths.lockFile, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkbenchError(`已有另一个 skill-workbench 操作正在运行：${paths.lockFile}`, 'LOCKED', 1);
    throw error;
  }
  try { return await operation(); } finally { await handle.close(); await rm(paths.lockFile, { force: true }); }
}
