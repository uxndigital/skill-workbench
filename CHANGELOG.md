# 重构：更符合直觉的参数语义

## 变更概述

重新设计了 `install`、`uninstall`、`status`、`push` 命令的参数语义，使其更符合 npm/pnpm 等工具的使用习惯。

## 主要变更

### 1. 自动仓库发现

`install`、`uninstall`、`status`、`push` 命令不再强制要求 `--global` 参数。默认行为：
- 优先查找项目仓库（`.skill-workbench/skills-repo`）
- 找不到则自动查找全局仓库（`~/.skill-workbench/*`）
- 两个都没有则给出清晰的错误提示

**旧行为**：
```bash
skill-workbench sync <url> -g
skill-workbench install <skill> -g  # 必须加 -g，否则找不到仓库
skill-workbench status -g           # 必须加 -g，否则找不到仓库
```

**新行为**：
```bash
skill-workbench sync <url> -g
skill-workbench install <skill>     # 自动发现全局仓库
skill-workbench status              # 自动发现全局仓库
```

### 2. `-g` 语义变更：安装目标，而非仓库来源

`-g / --global` 现在只控制**安装目标**（符合 npm 习惯）：
- 不加 `-g`：安装到项目目录（`.agents/skills`）
- 加 `-g`：安装到全局目录（`~/.agents/skills`）

**示例**：
```bash
# 从全局仓库安装到项目目录（最常用）
skill-workbench install my-skill

# 从全局仓库全局安装
skill-workbench install my-skill -g

# 从项目仓库全局安装（如果有项目仓库）
skill-workbench install my-skill -g
```

### 3. 新增 `--repo` 参数：强制指定仓库来源

当自动发现不够用时，可以用 `--repo <project|global>` 强制指定：

```bash
# 强制使用全局仓库（即使项目仓库存在）
skill-workbench install <skill> --repo global

# 强制使用项目仓库
skill-workbench install <skill> --repo project

# 组合使用：从全局仓库读取，安装到全局目录
skill-workbench install <skill> --repo global -g
```

### 4. sync 命令保持不变

`sync` 命令的 `-g` 仍然控制**仓库作用域**（在哪里创建仓库），这个语义是合理的：

```bash
skill-workbench sync <url>      # 项目仓库
skill-workbench sync <url> -g   # 全局仓库
```

## 向后兼容性

**测试通过**：所有 23 个测试用例通过，核心功能未受影响。

**行为变化**：
- 旧代码 `install <skill> -g` 的行为变为 `install <skill> --repo global -g`
- 但由于自动发现机制，大部分场景下只需 `install <skill>` 或 `install <skill> -g`

## 改进的用户体验

### 错误提示更清晰

当仓库不存在时，错误信息会列出所有查找位置：

```
[REPO_NOT_FOUND] 未找到 skill 仓库。
  项目仓库：.skill-workbench/skills-repo
  全局仓库：~/.skill-workbench/skills-repo
请先运行 sync 创建仓库。
```

### 减少认知负担

用户不需要记住"这个仓库是项目还是全局的"，工具会自动找到它。

### 符合直觉的语义

`-g` = 全局安装，就像 `npm install -g` 一样。
