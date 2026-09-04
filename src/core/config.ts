import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_GLOBAL_REPO_PATH,
  DEFAULT_REPO_PATH,
  DEFAULT_TARGET_DIR,
  pathsForScope,
  resolveRepoPathValue,
  resolveTargetPathValue,
  type Scope
} from './paths.js';
import { WorkbenchError } from './errors.js';

export interface WorkbenchConfig {
  version: 1;
  scope: Scope;
  repoUrl?: string;
  repoPath: string;
  targetDir: string;
}

const defaults: Record<Scope, Omit<WorkbenchConfig, 'scope'>> = {
  project: { version: 1, repoPath: DEFAULT_REPO_PATH, targetDir: DEFAULT_TARGET_DIR },
  global: { version: 1, repoPath: DEFAULT_GLOBAL_REPO_PATH, targetDir: '.agents/skills' }
};

export const SUPPORTED_AGENTS = ['codex', 'cursor', 'claude', 'hermes'] as const;
export type Agent = (typeof SUPPORTED_AGENTS)[number];

const agentTargetDirs: Record<Agent, string> = {
  codex: '.agents/skills',
  cursor: '.agents/skills',
  claude: '.claude/skills',
  hermes: '.hermes/skills'
};

export interface AgentTarget {
  targetDir: string;
  agents: Agent[];
}

export function targetDirForAgent(agent: string): string {
  if (!Object.hasOwn(agentTargetDirs, agent)) {
    throw new WorkbenchError(`不支持的 agent：${agent}。可选值：${SUPPORTED_AGENTS.join('、')}`, 'INVALID_AGENT', 2);
  }
  return agentTargetDirs[agent as Agent];
}

export function targetDirsForAgents(agents: string[], config: WorkbenchConfig): AgentTarget[] {
  if (agents.length === 0) return [{ targetDir: config.targetDir, agents: [] }];

  const targets = new Map<string, Agent[]>();
  for (const agent of agents) {
    const relativeTargetDir = targetDirForAgent(agent);
    const targetDir = config.scope === 'global'
      ? path.resolve(pathsForScope('global').root, relativeTargetDir)
      : relativeTargetDir;
    const typedAgent = agent as Agent;
    const targetAgents = targets.get(targetDir) ?? [];
    if (!targetAgents.includes(typedAgent)) targetAgents.push(typedAgent);
    targets.set(targetDir, targetAgents);
  }

  return [...targets.entries()].map(([targetDir, targetAgents]) => ({ targetDir, agents: targetAgents }));
}

export async function loadConfig(scope: Scope = 'project'): Promise<WorkbenchConfig> {
  const defaultsForScope = defaults[scope];
  const configFile = pathsForScope(scope).configFile;
  let raw: string;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultsForScope, scope };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkbenchError(`${configFile} 不是有效 JSON。`, 'INVALID_CONFIG', 2);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new WorkbenchError(`${configFile} 配置格式无效。`, 'INVALID_CONFIG', 2);
  }

  const value = parsed as Record<string, unknown>;
  if (value.version !== 1) {
    throw new WorkbenchError(`${configFile} 的 version 不受支持，只支持 1。`, 'UNSUPPORTED_CONFIG_VERSION', 2);
  }

  const repoPath = typeof value.repoPath === 'string' ? value.repoPath : defaultsForScope.repoPath;
  const targetDir = typeof value.targetDir === 'string' ? value.targetDir : defaultsForScope.targetDir;
  resolveRepoPathValue(repoPath, 'repoPath', scope);
  resolveTargetPathValue(targetDir, 'targetDir', scope);

  if (value.repoUrl !== undefined && (typeof value.repoUrl !== 'string' || value.repoUrl.trim() === '')) {
    throw new WorkbenchError('repoUrl 必须是非空字符串。', 'INVALID_CONFIG', 2);
  }

  return {
    version: 1,
    scope,
    repoPath,
    targetDir,
    ...(typeof value.repoUrl === 'string' ? { repoUrl: value.repoUrl } : {})
  };
}

export async function saveConfig(config: WorkbenchConfig): Promise<void> {
  resolveRepoPathValue(config.repoPath, 'repoPath', config.scope);
  resolveTargetPathValue(config.targetDir, 'targetDir', config.scope);
  const paths = pathsForScope(config.scope);
  await mkdir(paths.workbenchDir, { recursive: true });
  const temp = path.join(paths.workbenchDir, `config.json.tmp-${process.pid}`);
  const { scope: _scope, ...persisted } = config;
  void _scope;
  await writeFile(temp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  await rename(temp, paths.configFile);
}

export function repoPathFromConfig(config: WorkbenchConfig): string {
  return resolveRepoPathValue(config.repoPath, 'repoPath', config.scope);
}

export function targetDirFromConfig(config: WorkbenchConfig): string {
  const pathValue = resolveTargetPathValue(config.targetDir, 'targetDir', config.scope);
  if (config.scope === 'global' && pathValue === pathsForScope('global').root) {
    throw new WorkbenchError('全局 targetDir 不能是全局工作目录本身。', 'INVALID_PATH', 2);
  }
  return pathValue;
}
