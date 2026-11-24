# 技能看板（Skill dashboard）

一个 DeepSeek Harness 插件：把每个 Agent 的 skill 集中到一处 —— 装了什么、哪些编程 Agent 能看到、
模型实际调用了多少次，以及一个开关，用来把过度频繁的 skill 从模型手里收回来。

它会在 Web UI 左侧栏的 `插件`、`自动化任务` 下方新增一个 **技能看板** 入口，并在中央列新增整页面板
（panel id `skill-dashboard`）。

## 功能

**已安装** —— 所有 Agent 预设的 skill 放进一本账。

- 顶部概览技能库、模型可调用数、已检测 Agent 与累计调用；按名称、描述或来源即时搜索。
- 组合 Agent 与调用状态筛选，按调用最多、名称或最近使用排序；空结果可一键清除筛选。

- 逐个预设读取目录（`agentPresets` + `skills.list({ scope })`），只在某个预设可见的 skill 只出现一行，
  并用 `N 个 Agent` 标出可见范围，不会重复列。
- 从各自的 skill 根目录检测真正会读取技能目录的编程 Agent —— Claude Code、Codex、Cursor、
  Gemini CLI、GitHub Copilot、OpenCode、Amp、Cline、Droid、Kilo Code、Kimi Code CLI、Pi、Warp、
  Zed、fx —— 并在每一行标出读取它的 Agent。清单对齐 `skills` CLI 的注册表
  （`vercel-labs/skills/src/agents.ts`）：通用的 `.agents/skills` 根目录对所有读取它的 Agent 生效，
  而 DSH 始终能看到全部 skill。
- 显示来源（`user-agents`、`user-dsh`、`project-*`、`custom`、`bundled`）、调用次数；位于 DSH 安装目录
  （bundled 与 `app.asar` 内）的 skill 标 `只读`，插件不会去改它。
- 每行两个开关：**模型自动调用** 与 **`/name` 手动调用**，悬停可看说明。
- 行菜单：**更新**、**删除**、**查看路径**。可写但没有来源记录的技能，菜单显示 **关联来源**：
  填一个引用（`multi-search-engine`、`owner/repo`、`owner/repo@分支#路径` 或 GitHub 链接），
  关联来源并同时完成一次更新。已有来源的技能在描述下方多一行 `来源 <ref>`。
- `高频` 标记：调用次数 ≥ 3 且高于面板自身 75 分位的 skill，无需打开统计页就能看到它被过度使用。
- **预览** —— 点击已安装的技能行或发现卡片即可阅读技能文件。

**发现** —— 从两个公开源安装，也可以直接从 GitHub 安装；全部经由 Host 进程代理。

- **skills.sh** —— 社区 skill 目录，索引的是 Git 仓库；条目按 `owner/repo` 经
  `raw.githubusercontent.com` 拉取，路径通过 GitHub tree 接口发现（缓存 10 分钟）。
- **腾讯 SkillHub**（`api.skillhub.cn`）—— 国内源；中文标题、版本号、下载量，按文件逐个下载。
- **从 GitHub 安装** —— 搜索框下方的直接引用输入框，接受 `owner/repo`、`owner/repo@rev`、
  `owner/repo#skills/pdf`、`/tree/<rev>/<路径>` 链接和 `/blob/…/SKILL.md` 链接。仓库里有多个
  技能又没指定路径时返回 `subpath-required` 并列出候选，而不是猜一个。安装记录会固定写入的准确提交。
- 安装先落到被监听目录之外的临时区，带重试地移入 `$DSH_AGENTS_HOME`（通常是 `~/.agents/skills`），
  因此 skill 提供方的文件监听不会看到写了一半的 skill。

**统计** —— 到底在用哪些。

- 可选今天、近 7/14/30/60 天或自定义日期范围；显示周期调用数、周期活跃技能数、
  可搜索排序的逐技能次数/占比表，以及全部技能或单个技能的趋势和逐日明细。
- 搜索只筛选表格，占比始终按周期内全部调用计算；选择技能只改变趋势，不改变周期汇总。
  当前技能库之外的技能只要有历史调用仍会列出，已安装但零调用的技能也会显示。
- 累计调用与最近活动明确标注为不随周期变化；模型/用户渠道计数是累计值，
  没有保存历史逐日渠道拆分，因此不会伪造周期内的渠道数据。
- 逐日数据保留 60 天，保存在 `$DSH_HOME/skill-dashboard/usage.json`；只统计看板启用后观察到的调用。

**诊断** —— 哪些真的在用，哪些已经冷到可以收走。

- 每个技能一个结论，由 Host 依据已记录的调用历史计算：**在用**（近 14 天有调用）、
  **调用减少**（15–29 天）、**久未调用**（30 天以上没调用但有过调用记录）、**从未调用**、
  **已保留**，以及历史不足时的**观察中**。
- 观察窗口直接写在页面上：`观察自 <日期> · <N> 天`。从未调用的技能要观察满 3 天才下结论；
  看板开始观察之后才创建的技能单独按自己的在库时长计算，所以昨天刚装的技能不会被说成“几个月没用”。
- 五个分组覆盖全库并带 Host 计数：**可清理 / 已停用 / 在用 / 已保留 / 观察中**。每行先给证据：
  静默天数与调用次数、最近调用日期，或者已观察的时长。
- 清理沿用插件本来就有的机制：**停用**一次写入两个 frontmatter 键，技能仍留在磁盘上；
  **删除**在行内二次确认后移除技能目录；**保留**停止提醒，直到它再次被调用。看板改不动的技能
  （bundled 与 `app.asar` 内的）标 `只读`，只提供保留。
- 勾选多行后可以一次处理整批。批量按行降级：只读或已消失的技能单独报错，其余照常生效。
  删除一定确认；停用不确认，因为同一行就能改回来。
- 已经两个开关都关闭的技能会进入**已停用**，那里只剩**删除**，所以不会建议停用一个已经停用的技能。
- 页脚的「判断依据」复述三个阈值与保留规则，不用读源码也能核对结论。

## “关闭 skill”是怎么实现的

DSH 里没有单独的开关字段，也不需要：文件系统 skill 提供方本来就认这两个 frontmatter 键。

```yaml
---
name: code-review
description: …
disable-model-invocation: true   # 从模型目录与 `skill` 工具中隐藏
user-invocable: false            # 从 `/skill` 手势中隐藏
---
```

所以开关就是一次 **逐字节精确的 frontmatter 修改**：

- 关闭 `模型自动调用` 会写入 `disable-model-invocation: true`（恢复默认时删掉这一行）。`SKILL.md`
  其余内容——描述、嵌套 `metadata`、CRLF 换行——逐字节保留；重新打开会还原成完全相同的文件
  （已在 65 个真实 skill × 3 次编辑上验证，并在真实 `code-review` 上用 SHA-256 比对通过）。
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

两个源 API 都不带 CORS 头，所以所有源请求都在 Host 进程里完成，浏览器只访问
`/skill-dashboard/*`。外发请求有界（10 秒、4 MiB、并发 4），结果会缓存（搜索 60 秒、提交
60 秒、tree 与内容 10 分钟）。失败会以 `source-unavailable` / `source-rate-limited` 报出，
页面提示改用另一个源。

GitHub 提交来自 `api.github.com/repos/{o}/{r}/commits`，被限流时退到仓库的
`/commits/<rev>.atom` feed（不占 API 配额）；40 位 `rev` 本身就是固定的提交，不发请求。
Host 环境里已有 `GITHUB_TOKEN` / `GH_TOKEN` 时会带上。

## 文件

| 文件 | 作用 |
|:--|:--|
| `index.js` | Host：目录读写、用量存储、两个源适配、三个精确 HTTP 路由 |
| `client.js` | Client：侧栏图标、面板、页签、样式（无构建步骤、无 JSX） |
| `locale/*.json` | 插件页显示的 `meta.title` / `meta.description`，以及界面字典 |
| `icon.svg` | 原创图标 |
| `cordis.patch.yml` | 插入 `skill-dashboard` 的 Host 行 |
| `test/*.mjs` | 辅助函数、路由、真实安装的断言脚本 |

三个路由（`GET /skill-dashboard/state`、`POST /skill-dashboard/action`、
`POST /skill-dashboard/discover`）都先执行连接信任检查，全部返回 JSON，任何 handler 都不会把异常
抛给 carrier。

## 插件自己保存的数据

- `$DSH_HOME/skill-dashboard/usage.json` —— 每个 skill 的调用次数、去重会话数、60 天分桶、最近活动，
  以及三项诊断事实：`since`（观察起点，只写一次）、`catalog`（每个技能名第一次出现的时间）、
  `keptAt`（调用历史推不出来的那个决定）。文件损坏或缺失时按空数据启动。
- `$DSH_HOME/skill-dashboard/installed.json` —— 本看板安装或关联过的技能溯源：
  `{ source, ref, commit, name, version, installedAt, path }`，并镜像到
  `<skill>/.skill-source.json`（不含 `path`），手工复制走的 skill 也保留来源。记录只描述写入时
  所在的那个目录，同名但另一个目录的技能不会借用它。
- 除此之外不写任何东西。看板不会修改可写根之外的文件（`$DSH_HOME/skills`、
  `$DSH_AGENTS_HOME/skills`、项目内 `.dsh/skills` / `.agents/skills`），对 bundled/`app.asar`
  内的 skill 一律返回 `read-only`。

## 测试

```sh
npm ci --ignore-scripts
npm run ci          # 语法检查 + 客户端/辅助/路由/预览/统计周期离线测试
npm run test:live   # 手动集成检查：需要真实技能目录和网络，CI 不运行
```

`test/real-skills.test.mjs` 依赖本机 DSH 安装和在线技能源，因此不在常规 CI 中执行。

## 已知限制

- GitHub 安装会把写入内容的 40 位提交记录进 `installed.json` 与 `.skill-source.json`。更新会重新拉取
  跟踪的引用并逐字节比对，所以 `changed` 永远是真实比较；如果只有 jsDelivr 退路能提供内容，记录
  会写 `commit: null`，而不是猜一个提交。
- `skills.sh` 没有版本字段也没有详情 API，所以从发现卡片更新是按文件内容比对后报告 `changed`，
  而不是版本升级。
- 更新不会重命名技能：来源 `SKILL.md` 声明了另一个名字时返回 `name-mismatch`，不写任何文件。
  上游改名请删除后重新安装。
- 扁平 `<name>.md` 技能无法就地更新（会变成目录），返回 `flat-skill`。
- 仓库里有多个技能又无法判断是哪一个时返回 `subpath-required`，最多列出 5 个 `#路径` 候选，而不是猜。
- 内容有变化的更新会整目录替换（暂存、旧树备份、换入），上游不再提供的文件会消失，手工加进该
  skill 目录的文件也会消失；手工改过的 `SKILL.md` 会被替换，来源没变化时只重写溯源记录。
  本地附加内容请放在 skill 目录之外。
- 已安装插件的 Host 半改动会在下次启动 App 时生效；Client 半随页面刷新生效。
- 诊断只依据看板观察到的数据。刚装上时所有技能都是**观察中**，满 3 天后才开始出现可清理技能；
  删除永远需要手动确认，保留随时可以取消。
