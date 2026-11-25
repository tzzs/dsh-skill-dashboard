# 技能管理（Skills Manager）

一个 DeepSeek Harness 插件，将每个 Agent 的技能集中到一处。它展示已安装的技能、哪些编程 Agent 能看到它、实际调用次数，并提供直接开关用于关闭自动调用或手动调用。

它在插件页显示为**技能管理（Skills Manager）**，在 Web UI 左侧栏的 `插件`、`自动化任务` 下方新增**技能（Skills）**入口，并在中央列打开整页面板（panel id `skill-dashboard`）。

## 功能

**已安装。** 所有 Agent 预设的技能统一汇总在一张列表里。

- 顶部概览展示已安装技能数、自动调用数、已检测 Agent 与累计调用，支持按名称、描述或来源即时搜索。
- 组合 Agent 与调用状态筛选，按调用最多、名称或最近使用排序，空结果可一键清除筛选。
- 并行扫描各预设目录（`agentPresets` 与 `skills.list({ scope })`），被多个预设共享的技能只出现一行，页签附带已安装数量角标。
- 从各自的技能根目录检测编程 Agent（Claude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、OpenCode、Amp、Cline、Droid、Kilo Code、Kimi Code CLI、Pi、Warp、Zed、fx），并在每行标出读取它的 Agent。清单对齐 `skills` CLI 注册表（`vercel-labs/skills/src/agents.ts`），通用 `.agents/skills` 根目录对所有读取它的 Agent 生效，同时识别非通用 Agent 各自根目录下的单文件 `.md` 技能；DSH 始终能看到全部技能。
- 显示来源（`user-agents`、`user-dsh`、`project-*`、`custom`、`bundled`）与调用次数；位于 DSH 安装目录（bundled 与 `app.asar` 内）的技能标为`只读`，插件不会修改。
- 每行提供**自动调用**与 **`/name` 手动**两个开关，悬停显示说明；两者均关闭时标记为**已停用**。
- 行菜单提供**更新**、**删除**与**查看路径**。可写但没有来源记录的技能改为显示**关联来源**：填一个引用（`multi-search-engine`、`owner/repo`、`owner/repo@分支#路径` 或 GitHub 链接），关联来源并同时完成一次更新。已有来源的技能在描述下方多一行 `来源 <ref>`；压缩包地址显示为「域名 + 技能名」，完整地址放在提示里。
- `高频`标记标出调用次数 ≥ 3 且高于面板自身 75 分位的技能，无需打开统计页即可发现高频调用技能。

**发现。** 通过 Host 进程代理，从两个公开技能源或直接从 GitHub 搜索并安装。

- **skills.sh。** 社区技能目录，索引 Git 仓库；条目按 `owner/repo` 经 `raw.githubusercontent.com` 拉取，路径通过 GitHub tree 接口发现（缓存 10 分钟）。
- **腾讯 SkillHub**（`api.skillhub.cn`）。国内技能源，提供中文标题、版本号、下载量与按文件逐个下载。
- **从 GitHub 安装。** 搜索框下方的直接引用输入框：`owner/repo`、`owner/repo@rev`、`owner/repo#skills/pdf`、`/tree/<rev>/<路径>` 链接或 `/blob/…/SKILL.md` 链接。仓库里有多个技能又没指定路径时返回 `subpath-required` 并列出候选，而不是猜一个；安装记录会固定写入的准确提交。
- 依据实时目录并集判断已安装状态，加载过程展示 6 张与结果卡片结构一致的骨架屏。
- 安装先落到被监听目录之外的临时区，再带重试地移入预解析好的 `$DSH_AGENTS_HOME`（通常是 `~/.agents/skills`），文件监听不会看到写了一半的技能。

**统计。** 查看实际使用情况。

- 支持今天、近 7/14/30/60 天或自定义日期范围，显示时段调用、时段活跃技能、可搜索排序的逐技能次数与占比表，以及全部技能或单个技能的趋势和逐日明细。
- 搜索只筛选表格，占比始终按所选时段全部调用计算；选择技能只改变趋势，不改变时段汇总。当前技能库之外的技能只要有历史调用仍会列出，已安装但零调用的技能也会显示。
- 累计调用与最近活动明确标注为不受时段筛选影响；模型与用户渠道计数为累计值，不伪造历史逐日渠道拆分。
- 逐日数据保留 60 天，保存在 `$DSH_HOME/skill-dashboard/usage.json`，仅统计插件启用期间观察到的调用。手动 `/name` 调用在无预设上下文时自动回退归入 `'default'`。

**诊断。** 区分仍在使用的技能与长期静默、适合清理的技能。

- 由 Host 依据已记录的调用历史为每个技能计算结论：**使用中**（近 14 天有调用）、**近期未用**（15 至 29 天）、**久未调用**（30 天以上未调用但有过调用记录）、**从未调用**、**已保留**，以及历史不足时的**观察中**。
- 观察窗口直接写在页面上（`观察自 <日期> · 共 <N> 天`）。从未调用的技能至少观察满 3 天才下结论；观察开始之后才新增的技能单独按自己的在库时长计算。
- 五个互斥分组覆盖全库并带 Host 计数：**可清理 / 已停用 / 使用中 / 已保留 / 观察中**，诊断页签附带可清理数量角标。每行先展示判定证据（静默天数与调用次数、最近调用日期或已观察时长）。
- 清理沿用插件现有能力。**停用**一次写入两个 frontmatter 键并保留磁盘文件；**删除**在行内确认后移除技能目录，并等待溯源记录落盘完成；**保留**暂停清理提醒，直到技能再次被调用。只读技能（bundled 与 `app.asar` 内）标为`只读`并只提供保留。
- 勾选多行后可执行批量操作。批量按行降级，只读或已消失的技能单独报错，其余照常生效。删除始终需要确认，停用因为可逆而直接执行。切换调用权限与停用清理都会原子重算诊断状态。
- 两个调用路径都已关闭的技能会进入**已停用**分组，那里仅保留**删除**操作。
- 页尾的**判断规则**折叠区复述三个阈值与保留规则，不用读源码也能核对结论。

## 技能详情与文件预览

点击已安装列表行或发现结果卡片即可打开预览浮层（不是原生 `<dialog>`）。窄屏（`max-width: 700px`）下点击**技能文件**可展开文件树；点击刷新会绕过缓存重载当前文件。

- 浮层以 `position: fixed` 挂载在 `document.body` 上并直接继承全部 `--skd-*` DSH 令牌，加载时显示顶部不确定进度条与文件树、正文骨架屏。
- Escape、关闭按钮与点击背景遮罩都会关闭浮层；Tab 与 Shift+Tab 焦点被限制在面板内，关闭后焦点回到技能行；切换页签会关闭浮层。遮罩为纯半透明蒙层，不使用 `backdrop-filter` 模糊。
- 支持折叠文件夹、**阅读 / 原文**视图切换，以及大文件截断和二进制文件提示；内容永不执行，HTML 作为纯文本显示。
- 桌面默认最大尺寸为 `1280px`（`92vw`）× `860px`（`88dvh`），支持拖拽右下角缩放、快捷缩放按钮与最大化/还原，并在页面生命周期内记住常规尺寸。
- 本地目录列举仅读元数据（15 秒 Host 缓存，单技能最多 200 个常规文件、扫描上限 2,000 项与 6 层嵌套）；单文件文本预览上限 128 KiB；客户端保留 30 秒上限缓存，切换文件时用 `fileOnly: true` 复用目录清单。

## 加载、缓存与容错

- 首屏立即渲染完整 DSH 原生页壳（页头、状态胶囊与四页签栏），并展示 4 张 KPI 骨架卡片、筛选栏骨架与 6 行列表骨架，使用 `--dsw-alias-bg-skeleton` 脉冲动画（在 `prefers-reduced-motion` 下关闭）。
- Host 侧 `StateCache` 在插件激活时预热，合并并发的 SWR 读取（1.5 秒 TTL），并将 `skills/change` 事件合并去抖（250 毫秒）后刷新；预设目录扫描与 `detectAgentRuntimes()` I/O 并行执行，安装根提前解析。
- 客户端合并并发的 `refresh()` 请求；写入操作直接使用返回的权威状态，不再做盲目的 800 毫秒延迟二次拉取；后台刷新失败时保留已加载界面并显示内联重试横幅，不清空页面。
- 更新检查默认开启且只读：首屏数据到达后自动跑一次后台检查，每次请求覆盖 4 个已跟踪技能（`check-updates`，单技能 6 秒上限），结果保留 6 小时，手动「检查更新」才绕过；同一仓库的多个技能共享 10 分钟的 tree / payload 缓存，压缩包源按地址缓存同样 10 分钟。一个分块可能包含一次冷启动的 tree 预热加四次有界读取，因此只有它拿到 25 秒的请求上限，其余请求仍是 10 秒；分块仍然失败时从第一个未记录结果的技能重新走一遍，再失败则显示「检查中断」，已落盘的判定继续可见。更新结果收进已安装页页头：一个紧凑的「可更新 N」胶囊（点过「稍后」后变安静，没有更新时显示「已是最新」，首次检查前显示「检查更新」）展开一个小浮层，里面有「全部更新 (N)」「仅更新常用 (M)」（仅当部分可更新技能被调用过）、「只看可更新」（把调用状态筛选切到「可更新」）、「检查更新」「稍后」，以及「自动更新」开关与「选择 N」。更新仍顺序执行并逐行显示进度，结束给一条成功/失败回执。自动更新选择以 `{ enabled, names }` 存进 `localStorage`，勾选面板就在同一个浮层里（全选 / 清空 / 完成），每次检查结束后只自动更新勾选且仍可更新的技能，并使用单独的提示文案；未勾选的技能永远不会被自动更新。调用状态筛选因此多出「可更新」，同一组行可以单独筛出。检查既不写技能目录也不写溯源；旧版 Host 没有该 action 时不显示更新入口。
- 已安装列表每帧只渲染 15 行，未完成时标记 `aria-busy`，行组件做了 memo 缓存，技能很多时也不会一次性阻塞主线程；搜索输入框即时响应，过滤结果使用延迟值渲染。
- 诊断队列一次挂载、逐行 memo，离屏行用 `content-visibility` 跳过布局与绘制；行回调保持稳定，后台状态刷新不会给每行换新 props，滚动不写 React 状态。
- 发现结果卡片使用 memo，安装与预览回调保持稳定；空查询的热门列表单独标注，输入关键词或后台快照刷新不会重渲染卡片。
- 全部 25 个 Host 错误码均已在 `locale/en.json` 和 `locale/zh.json` 中本地化，用户界面文案不含内部 Host 术语。

## “关闭技能”是怎么实现的

DSH 不需要单独的启用开关字段，文件系统技能提供方原生识别这两个 frontmatter 键。

```yaml
---
name: code-review
description: …
disable-model-invocation: true   # 从模型目录与 `skill` 工具中隐藏
user-invocable: false            # 从 `/skill` 手势中隐藏
---
```

开关执行的是**逐字节精确的 frontmatter 修改**。

- 关闭**自动调用**会写入 `disable-model-invocation: true`（恢复默认时删掉这一行）。`SKILL.md` 其余内容（描述、嵌套 `metadata`、CRLF 换行）逐字节保留；重新打开会还原成完全相同的文件（已在 65 个真实 skill × 3 次编辑上验证，并在真实 `code-review` 上用 SHA-256 比对通过）。
- 提供方会监听技能目录，因此该 skill 在 Agent 下一次 `agent/pre-step` 就离开模型目录；之后再调用
  `skill` 会得到 `skill "<name>" is not available for model invocation`。
- 因为它是一次文件编辑：`git diff` 看得见、重启后依然有效、也可以手工还原。重新开启不依赖本插件
  是否加载。

被多个预设共享的 skill 文件会影响所有相关预设；行上的 Agent 标记告诉你哪些编程 Agent 读取它，
也就是改动前的影响范围。

## 数据源

| 来源 | 列表 | 内容 |
|:--|:--|:--|
| `skills-sh` | `GET https://skills.sh/api/search?q=…&limit=50`，或「从 GitHub 安装」里直接填写的引用 | `api.github.com/.../git/trees/{rev}?recursive=1` + `raw.githubusercontent.com`，失败时退到 `data.jsdelivr.com` 列表与 `cdn.jsdelivr.net` 内容 |
| `tencent` | `GET https://api.skillhub.cn/api/skills?page=1&pageSize=30&sortBy=score&keyword=…` | `GET /api/v1/skills/{slug}/files` + `/api/v1/skills/{slug}/file?path=…` |
| `well-known` | 无：锁文件为每个技能记录一个压缩包地址 | `GET <sourceUrl>`，一个 gzip tar 在 Host 内解开 |

`well-known` 源（飞书的 `open.feishu.cn` 就用这种方式发布技能）没有搜索也没有文件列表，
因此不会出现在「发现」里；它只跟随 `.skill-lock.json` 记录的压缩包地址。单次下载上限 8 MiB
（声明值与实际流均计），解压后 tar 上限 32 MiB；解析最多扫描 200 个条目，只保留路径安全且
属于文本的技能文件，常规的 40 个文件 / 1 MiB 内容上限仍然生效。

两个源 API 都不带 CORS 头，所以所有源请求都在 Host 进程里完成，浏览器只访问
`/skill-dashboard/*`。外发请求有界（10 秒、4 MiB、并发 4），结果会缓存（搜索 60 秒、提交
60 秒、tree 与内容 10 分钟；压缩包按地址缓存同样 10 分钟），而更新总是重新读取来源，不复用这些缓存。失败会以 `source-unavailable` / `source-rate-limited` 报出，
页面提示改用另一个源。

GitHub 提交来自 `api.github.com/repos/{o}/{r}/commits`，被限流时退到仓库的
`/commits/<rev>.atom` feed（不占 API 配额）；40 位 `rev` 本身就是固定的提交，不发请求。
Host 环境里已有 `GITHUB_TOKEN` / `GH_TOKEN` 时会带上。

## 文件

| 文件 | 作用 |
|:--|:--|
| `index.js` | Host：`StateCache` SWR 生命周期、并行目录与 Agent 扫描、用量存储、两个源适配、四个精确 HTTP 路由 |
| `client.js` | Client：侧栏图标、面板、页签、骨架屏加载、预览弹层、单层 DSH 原生样式（无构建步骤、无 JSX） |
| `locale/*.json` | 插件页显示的 `meta.title` / `meta.description`、界面字典与 25 个本地化错误码 |
| `icon.svg` | 原创图标：36×36 透明底，由宿主底板承载，浅色与深色主题下均与其它插件一致 |
| `cordis.patch.yml` | 插入 `skill-dashboard` 的 Host 行 |
| `test/*.mjs` | 客户端、辅助函数、路由、预览、统计周期、诊断断言脚本及手动实测脚本 |

四个路由（`GET /skill-dashboard/state`、`POST /skill-dashboard/action`、`POST /skill-dashboard/discover`、`POST /skill-dashboard/preview`）都先执行连接信任检查，全部返回 JSON，任何 handler 都不会把异常抛给 carrier。

## 插件自己保存的数据

- `$DSH_HOME/skill-dashboard/usage.json` 保存每个技能的调用次数、去重会话数、60 天分桶、最近活动，以及三项诊断事实（`since` 记录观察起点且只写一次，`catalog` 记录每个技能名首次出现的时间，`keptAt` 记录手动保留决策）。文件损坏或缺失时按空数据启动。
- `$DSH_HOME/skill-dashboard/installed.json` 保存本插件安装或关联过的技能溯源：
  `{ source, ref, commit, name, version, installedAt, path }`，同时镜像到
  `<skill>/.skill-source.json`（不含 `path`），手工复制的技能也会保留来源。记录只描述写入时所在的那个目录，同名但另一个目录的技能不会借用它。
  由 skills CLI 安装的技能没有这份记录，因此面板还会只读 `$DSH_AGENTS_HOME/.skill-lock.json`（5 秒缓存），当锁文件里的 `skillPath` 对应 `<installRoot>/<name>` 时报告为 `{ source: "github", ref }`。锁文件的键是安装名，所以它记录的目录可以和技能名不同（taste-skill 有十个技能装在名字不一致的目录里），多个技能也可以共用一个目录；`well-known` 条目则报告为 `{ source: "well-known", ref: <sourceUrl> }`。
- `$DSH_HOME/skill-dashboard/updates.json` 缓存每个技能最近一次更新检查：
  `{ version: 1, skills: { "<name>": { available, changedPaths, checkedAt } | { error, checkedAt } } }`。
  结果保留 6 小时；更新成功后清除该技能的记录。
- 除此之外不写任何文件。插件不会修改可写根之外的技能（`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills`、项目内 `.dsh/skills` / `.agents/skills`），对 bundled 与 `app.asar` 内的技能一律返回 `read-only`。

## 测试

```sh
npm ci --ignore-scripts
npm run ci          # 语法检查 + 客户端/辅助/路由/预览/统计周期/诊断离线测试
npm run test:live   # 手动集成检查：需要真实技能目录和网络，CI 不运行
```

`test/real-skills.test.mjs` 依赖本机 DSH 安装和在线技能源，因此不在常规 CI 中执行。

## 已知限制

- GitHub 安装会把写入内容的 40 位提交记录进 `installed.json` 与 `.skill-source.json`。更新会重新拉取跟踪的引用并逐字节比对，所以 `changed` 永远是真实比较；如果只有 jsDelivr 退路能提供内容，记录会写 `commit: null`，而不是猜一个提交。
- 更新不会重命名技能：来源 `SKILL.md` 声明了另一个名字时返回 `name-mismatch`，不写任何文件；上游改名请删除后重新安装。扁平 `<name>.md` 技能返回 `flat-skill`；仓库里有多个技能又无法判断是哪一个时返回 `subpath-required`，最多列出 5 个候选。
- `skills.sh` 没有版本字段也没有详情 API，所以从发现卡片更新是按文件内容比对后报告 `changed`，而不是版本升级。
- `well-known` 更新会下载整个技能压缩包，解出其中的文本文件后按同样方式比对。压缩包没有提交，所以记录 `commit: null`；上游不再打包的文件会在整目录替换时一并消失。
- 内容有变化的更新会整目录替换（暂存、旧树备份、换入），上游不再提供的文件会消失，手工加进该技能目录的文件也会消失；手工改过的 `SKILL.md` 会被替换，来源没变化时只重写溯源记录。本地附加内容请放在技能目录之外。
- 已安装插件的 Host 半改动会在下次启动 App 时生效；Client 半随页面刷新生效。
- 诊断只依据看板观察到的数据。刚装上时所有技能都是**观察中**，满 3 天后才开始出现可清理技能；
  删除永远需要手动确认，保留随时可以取消。
