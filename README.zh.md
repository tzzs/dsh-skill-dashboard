# 技能看板（DSH Skill Dashboard）

[![CI](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/tzzs/dsh-skill-dashboard)](https://github.com/tzzs/dsh-skill-dashboard/releases)

一个 DeepSeek Harness（DSH）插件：把每个 Agent 的 skill 集中到一处 —— 装了什么、哪些
编程 Agent 能看到、实际被调用了多少次、哪些值得留下，以及只读的文件预览。

[English](README.md)

## 功能

**已安装** —— 所有 Agent 预设的 skill 放进一本账。

- 合并各预设的目录：被两个预设共享的 skill 只出现一行。
- 从各自的 skill 根目录检测真正会读取技能目录的编程 Agent —— Claude Code、Codex、Cursor、
  Gemini CLI、GitHub Copilot、OpenCode 等 —— 并在每行标出读取它的 Agent。
- 显示来源、调用次数；位于 DSH 安装目录内的 skill 标为只读，看板不会修改它。
- 每行两个开关（模型自动调用、`/name` 手动调用），修改的是 skill 的 YAML frontmatter；
  行菜单提供更新、删除和查看路径。
- 支持按名称搜索、按 Agent 与调用状态筛选，以及按调用次数、名称或最近使用排序。

**发现** —— 通过 Host 从两个公开技能源安装。

- `skills.sh`（Git 仓库）与腾讯 SkillHub（`api.skillhub.cn`）。两个 API 都不发 CORS 头，
  因此全部请求都由 Host 进程代理。
- 安装先落到被监听目录之外的临时区，再移入技能根，文件监听不会看到写了一半的 skill。

**统计** —— 今天、近 7/14/30/60 天或自定义日期范围。

- 逐技能的调用次数与占比、全部技能或单个技能的趋势，以及 60 天逐日数据。
- 累计总数与最近活动单独标注；搜索和趋势选择不会改变周期汇总。

**诊断** —— 哪些真的在用，哪些已经冷到可以收走。

- 依据已记录的调用给每个技能一个结论：在用、调用减少、久未调用、从未调用、已保留，
  或历史不足时的观察中。观察窗口直接显示在页面上。
- 五个分组带计数：可清理、已停用、在用、已保留、观察中。每行给出结论背后的证据。
- 单行或整批都可以停用（可逆）、删除（需确认）、保留（停止提醒）。批量按行降级，
  只读技能只提供保留。

**预览** —— 点击技能行或卡片即可阅读。

- 可折叠文件树、Markdown 阅读视图或原始源码，二进制与超限文件有明确提示。
- 按需加载，Host 与客户端都有上限缓存；窗口可缩放、可最大化。
- 文件内容不会被执行，skill 里的 HTML 只作为文本显示。

**DSH 集成** —— 面板跟随 Host 的语言、配色与字体，不引入第二套设置，所有控件都可用
键盘操作。

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

`npm run ci` 用临时目录和模拟的技能源响应，运行客户端、辅助函数、路由、预览和统计周期
五组测试。`test:live` 依赖真实 DSH 安装与在线技能源，因此不进 CI。

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
| `skill-dashboard/index.js` | Host 半：目录读取、frontmatter 编辑、用量存储、技能源、四个 HTTP 路由 |
| `skill-dashboard/client.js` | Client 半：面板、页签、预览弹层与样式（无构建、无 JSX） |
| `skill-dashboard/locale/*.json` | 界面词典与插件页元数据 |
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

插件只读取 DSH 已经暴露的技能根，只写入你在面板里切换的那两个 frontmatter 键（以及你显式
删除的文件）。自身状态保存在 `$DSH_HOME/skill-dashboard/`，技能源请求由 Host 发出，
浏览器不直接访问外部 API。

## 许可证

[MIT](LICENSE) © 2026 tzzs
