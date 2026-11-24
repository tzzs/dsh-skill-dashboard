# 技能管理（DSH Skill Dashboard）

[![CI](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/tzzs/dsh-skill-dashboard)](https://github.com/tzzs/dsh-skill-dashboard/releases)

一个 DeepSeek Harness（DSH）插件，在插件页显示为**技能管理**，侧边栏入口为**技能**。它将每个 Agent 的技能集中到一处，展示已安装清单、可见的编程 Agent、实际调用统计、未用技能诊断以及只读文件预览。

[English](README.md)

## 功能

**已安装。** 所有 Agent 预设的技能统一汇总在一张列表里。

- 合并各预设目录，多个预设共享的技能只出现一行，页签显示已安装数量角标。
- 从各自的技能根目录检测编程 Agent（包括 Claude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、OpenCode 等），同时识别目录型技能与非通用 Agent 根目录下的单文件 `.md` 技能。
- 显示来源与调用次数；位于 DSH 安装目录内的技能标为`只读`，插件不会修改。
- 每行提供**自动调用**与 **`/name` 手动**两个开关，直接修改技能的 YAML frontmatter；两者都关闭时显示`已停用`。行菜单提供更新、删除和查看路径。
- 更新从记录的来源（腾讯 SkillHub、skills.sh 或 GitHub）整目录原子替换。别的工具装的技能可以先「关联来源」，之后持续更新；从 GitHub 安装会记录写入的准确提交。
- 支持关键词搜索、按 Agent 与调用状态筛选，以及按调用次数、名称或最近使用排序。

**发现。** 通过 Host 进程代理，从两个公开技能源或直接从 GitHub 搜索并安装技能。

- 支持 `skills.sh`（Git 仓库）与腾讯 SkillHub（`api.skillhub.cn`）。两个 API 都不返回 CORS 头，全部请求由 Host 代理。
- 支持直接从 GitHub 安装：`owner/repo`、GitHub 链接、分支/标签/提交（`owner/repo@rev`）或子目录（`owner/repo#skills/pdf`）。文件从 `raw.githubusercontent.com` 拉取；该域名或 API 被拒时，列表与内容退回 jsDelivr，记录会如实标注未固定提交。
- 依据实时目录并集判断已安装状态，加载过程展示 6 张与结果卡片对齐的骨架屏。
- 安装先落到被监听目录之外的临时区再原子移入，文件监听不会看到写了一半的技能。

**统计。** 查看今天、近 7/14/30/60 天或自定义日期范围内的调用情况。

- 展示逐技能的调用次数与占比、全部技能或单个技能的趋势，以及 60 天逐日明细。
- 累计总数与最近活动单独标注，搜索和趋势选择不会改变周期汇总。
- 手动 `/name` 调用在无预设上下文时自动回退归入 `'default'`。

**诊断。** 区分仍在使用的技能与长期静默、适合清理的技能。

- 依据已记录的调用给出六类结论（`使用中`、`近期未用`、`久未调用`、`从未调用`、`已保留`、`观察中`），并在页面明确标出观察窗口。
- 划分为五个带计数的互斥分组（`可清理`、`已停用`、`使用中`、`已保留`、`观察中`），页签附带可清理数量角标，每行直接给出判定证据。
- 支持对单行或批量选择执行停用（可逆）、删除（需确认）或保留（暂停提醒）。批量操作按行降级，只读技能仅提供保留；切换调用权限或停用清理后会原子重算诊断状态。

**预览。** 点击已安装技能行或发现卡片即可阅读技能文件。

- 提供可折叠文件树、Markdown 阅读视图与原始源码切换，以及二进制和超限文件提示。
- 加载时显示顶部不确定进度条与文件树、正文骨架屏；支持 Host 与客户端上限缓存，弹窗可缩放、可最大化。
- 文件内容不会被执行，技能中的 HTML 只作为纯文本显示。

**DSH 集成。** 自动跟随 DSH 的语言、配色与字体，无需额外配置。

- 使用单层 DSH 原生 CSS，页面与预览 `<dialog>` 直接绑定 `--dsw-*` / `--ds-*` 令牌。
- 首屏先呈现完整页壳与 DSH 原生骨架屏；后台刷新失败时保留已加载内容并显示内联重试横幅。
- 完成中英双语界面与全部 25 个服务错误码的本地化，所有控件均支持键盘操作。

## 环境要求

- 一个 Host 暴露 `webServer` 与 `skills` 服务、并带 Web UI 的 DSH 版本。
- Node.js 20 或更高版本，用于开发、测试和打包。

## 安装

每个 Release 都附带打包好的插件（`local-dsh-skill-dashboard-<version>.tgz`）和
`SHA256SUMS`。解压到 profile 的模块目录后重启 DSH：

```sh
sha256sum --check SHA256SUMS
tar -xzf local-dsh-skill-dashboard-<version>.tgz --strip-components=1 \
  -C "<profile>/node_modules/@local/dsh-skill-dashboard"
```

插件包内含 `cordis.patch.yml`，会插入 `skill-dashboard` 这个 Host 条目
（`@local/dsh-skill-dashboard`）。Host 代码改动需要重启 DSH；面板本身随页面刷新生效。

包在 `package.json` 中标记为 `private`，不会发布到 npm：发版产物是 GitHub Release 附件，
而不是软件源条目。

## 开发与测试

```sh
npm ci --prefix skill-dashboard --ignore-scripts
npm run ci --prefix skill-dashboard          # 语法检查 + 离线测试
npm run test:live --prefix skill-dashboard   # 手动集成检查：真实技能目录 + 网络
```

`npm run ci` 用临时目录和模拟的技能源响应，运行客户端、辅助函数、路由、预览、统计周期和诊断六组测试。`test:live` 依赖真实 DSH 安装与在线技能源，因此不进 CI。

## 文档

| 文档 | 内容 |
|:--|:--|
| [docs/CONTRACT.md](docs/CONTRACT.md) | Host/Client 接口约定：路由、状态结构、路径防护 |
| [docs/UI-INTEGRATION.md](docs/UI-INTEGRATION.md) | 视觉体系、预览窗口与 DSH 语言/主题集成 |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | 布局、密度与可访问性决策 |
| [docs/registries.md](docs/registries.md) | 技能源与技能根的实测记录 |
| [docs/skills-internals.md](docs/skills-internals.md) | DSH 如何解析 skill |
| [skill-dashboard/README.zh.md](skill-dashboard/README.zh.md) | 插件使用说明（中文） |
| [skill-dashboard/README.md](skill-dashboard/README.md) | 插件说明（English） |

## 仓库结构

| 路径 | 作用 |
|:--|:--|
| `skill-dashboard/index.js` | Host 半：`StateCache` SWR 生命周期、并行目录与 Agent 扫描、frontmatter 编辑、用量存储、技能源、四个 HTTP 路由 |
| `skill-dashboard/client.js` | Client 半：面板、页签、骨架屏加载、预览弹层与单层 DSH 原生样式（无构建、无 JSX） |
| `skill-dashboard/locale/*.json` | 双语界面词典、25 个本地化错误码与插件页元数据 |
| `skill-dashboard/test/*.mjs` | 离线回归测试与手动实测脚本 |
| `.github/workflows/` | CI 与发布流程 |
| `scripts/check-release.mjs` | 发布元数据一致性检查 |

## CI 与发布

- `CI` 在 Ubuntu 与 Windows 上分别用 Node 20、22、24 运行：离线测试、发布元数据检查、
  打包内容检查，以及用校验过 checksum 的 actionlint 检查全部工作流。
- `Release please` 在 `main` 推送且 CI 通过后运行，依据 Conventional Commits 维护 Release
  PR；合并后创建 `vX.Y.Z` 标签和 GitHub Release，并附上插件压缩包与 `SHA256SUMS`。
- Dependabot 每周检查固定版本的 workflow action，汇总成一个 `ci` 前缀的 PR。

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，
版本号与发布说明都由此生成。

## 隐私

插件读取 DSH 已经暴露的技能根，写入你在面板里切换的两个 frontmatter 键、你安装或更新的技能，
以及你显式删除的文件。自身状态保存在 `$DSH_HOME/skill-dashboard/`，技能源与 GitHub 请求由 Host
发出，浏览器不直接访问外部 API。只有 Host 环境里本来就存在 `GITHUB_TOKEN` 或 `GH_TOKEN` 时才会
使用它，用来放宽 GitHub 的匿名限流。

## 许可证

[MIT](LICENSE) © 2026 tzzs
