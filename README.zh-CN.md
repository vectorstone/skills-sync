# Agent Skills Sync

[English](README.md)

`agent-skills-sync` 是一个仅操作文件系统的 Node.js CLI，用受管理的符号链接向 Claude Code 暴露一组经过选择的 Agent Skills。

它将 `.agents/skills` 视为唯一规范来源，并在 `.claude/skills` 中创建链接。这样既能避免复制技能内容，也能避免两个目录发生漂移。

## 项目状态

本仓库包含 `0.1.0` 初始版本的实现约定。该包面向 Node.js 20 或更高版本，支持 macOS 和 Linux。原生 Windows 上的文件系统命令会被拒绝，并提示使用 WSL。其他 POSIX 系统仅提供尽力支持，不属于受支持的测试目标。

本项目是公开项目，但本文档不表示任何版本已经发布，也不表示任何测试已经通过。请针对当前检出版本运行下文的本地验证命令。

## 功能

- 使用严格的 `.agents/skills-sync.json` JSON 配置。
- 默认使用项目作用域，也支持显式全局作用域。
- 只暴露明确选择的技能。
- 应用前先生成计划。
- 使用符号链接保持单一来源，不复制内容。
- 提供确定性的人类可读输出和带版本号的 `--json` 结果契约。
- 保守判断链接所有权，只清理能够验证为受管理链接的陈旧项。
- 运行时不访问网络、不收集遥测、不调用 API，也不做双向同步。

它不会复制技能内容、双向同步，也不支持已经废弃的“一个公共源同步到两个目标”脚本流程。

## 安装

软件包发布后：

```sh
npm install --global agent-skills-sync
```

在源码检出目录中，先构建再调用生成的命令：

```sh
npm install
npm run build
node dist/cli.js --help
```

## 快速开始

在包含 `.agents/skills/<技能名>/SKILL.md` 的项目中执行：

```sh
agent-skills-sync init
agent-skills-sync add review
agent-skills-sync sync
agent-skills-sync check
```

`init` 创建项目配置以及标准源目录和目标目录。`add` 选择已有的源技能。`sync` 先规划操作，并在需要变更时确认，然后创建或更新受管理符号链接。`check` 是只读命令。

只查看计划，不修改文件系统：

```sh
agent-skills-sync sync --dry-run
agent-skills-sync list --available
```

显式使用全局配置：

```sh
agent-skills-sync --global init
agent-skills-sync --global add review
agent-skills-sync --global sync
```

通过绝对路径选择其他项目根目录：

```sh
agent-skills-sync --project=/absolute/path/to/project list
```

## 配置

默认项目配置文件是 `.agents/skills-sync.json`：

```json
{
  "schemaVersion": 1,
  "source": ".agents/skills",
  "target": ".claude/skills",
  "skills": ["review"]
}
```

`skills` 必须按 Unicode 码点排序、不得重复，并使用安全的 1–128 字符 ASCII 名称。源目录和目标目录必须相互独立且不能嵌套，并且必须保留在所选作用域中。自定义配置路径也必须保留在该作用域中。

## 命令和选项

### `init`

创建配置和安全的目录布局。已有配置不会被静默替换。

### `add <name...>` / `remove <name...>`

添加或删除选中的技能名。变更会经过校验并原子写入。这些命令不创建链接；之后需要运行 `sync`。

### `list`

显示已配置技能及其当前链接状态。`--available` 还会显示有效但尚未选择的源技能。

### `check`

只读检查漂移。已配置链接缺失或无效时返回退出码 4。仅存在陈旧受管理链接时默认返回 0；使用 `--strict` 时返回 4。

### `sync`

串行应用共享计划。`--dry-run` 只渲染计划。`--force` 可以替换无效的受管理符号链接，但永远不会替换非符号链接项。`--prune` 只删除能够验证为曾受管理的陈旧链接。如果没有操作需要执行，就不会创建目标目录。

通用选项：

- `--global` — 选择用户级全局作用域。
- `--project` 或 `--project=DIR` — 选择项目作用域；提供 `DIR` 时必须使用绝对路径。
- `--config=FILE` — 使用所选作用域内的配置路径。
- `--json` — 业务命令只输出一个机器可读 JSON 文档。
- `--quiet` — 隐藏成功情况下的普通人类可读输出。
- `--no-color` — 禁用彩色输出；也支持 `NO_COLOR`。
- `--help`、`--version` — 输出命令帮助或软件包版本。

## JSON 和退出码

JSON 输出包含 `outputVersion: 1`、命令和模式、所选作用域、解析后及原始路径、状态、退出码、稳定的汇总计数、已排序条目、警告和错误。应用模式的条目包含 `outcome: succeeded`、`failed` 或 `skipped`；计划和检查结果不表示操作已经完成。

退出码：

| 代码 | 含义                                   |
| ---: | -------------------------------------- |
|    0 | 成功；没有漂移，或请求的操作已完成     |
|    2 | 用法或配置错误                         |
|    3 | 必需的源、项目、主目录或配置缺失       |
|    4 | 检测到漂移，或严格陈旧链接检查失败     |
|    5 | 文件系统项阻塞，或应用操作无法安全继续 |
|    6 | 用户取消确认                           |
|    7 | 文件系统 I/O 失败                      |
|  130 | 操作被中断                             |

## 安全模型

工具在修改前解析词法路径和真实文件系统路径，拒绝逃逸作用域以及源/目标嵌套，并在应用过程中重新验证对象身份。目标位置已有的非符号链接项会阻塞操作，即使使用 `--force` 也不会被覆盖。符号链接目标必须解析到最终源目录，并包含有效的 `SKILL.md`。

同步不会修改 Git 元数据。根据已批准的初始化契约，`init` 可能会向项目 `.gitignore` 添加受管理目标模式；提交前请在工作区审查该变更。

## 开发

仓库使用 TypeScript、ESM、npm、ESLint、Prettier、Vitest，并要求 Node.js 20 或更高版本。

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm audit --audit-level=high
```

以上是预期的本地验证顺序。本文档并不宣称这些检查已经在所有检出版本中通过。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 发布门禁

已批准的发布计划将源代码首次发布、打标签、npm 引导发布、可信发布者配置和 GitHub Release 发布视为彼此独立的外部操作门禁。本文档和拉取请求 CI 均不会执行或授权这些操作。

首次 `0.1.0` 引导发布需要重新确认、检查 npm 身份并审查精确的软件包内容。预期在本地执行 `npm publish --access public`，因此不会包含 GitHub OIDC 来源证明。引导版本存在后，需要为准确的 `vectorstone/skills-sync` 仓库和 `.github/workflows/release.yml` 工作流配置 npm trusted publishing。后续已发布的 GitHub Releases 会使用 `id-token: write` 进行无令牌 npm 发布，并根据 npm 的可信发布要求自动生成来源证明。发布工作流会验证软件包版本和匹配的带日期变更日志；如果精确版本已经发布，则识别该版本而不是重复发布。

CI 成功不等于获得发布授权。进入引导发布门禁前，应立即重新检查软件包名称是否可用。

## 支持和故障排查

- 使用 `--global` 前，先确认当前目录和所选作用域。
- 使用 `list --available` 发现有效的源技能。
- 使用 `sync --dry-run --json` 在不修改文件的情况下检查操作。
- 阻塞项不会被自动覆盖；检查路径后请自行移动或删除它。
- 只有所有权能够被证明的陈旧链接才可清理；外部链接会被忽略。
- 在 Windows 上请使用 WSL，不要使用原生 Windows 文件系统命令。

## 许可证

MIT。详见 [LICENSE](LICENSE)。
