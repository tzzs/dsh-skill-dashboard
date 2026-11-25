# 技能管理 UI 设计规范

本规范面向工作区内的 `skill-dashboard`（界面标题**技能管理 / Skills Manager**，侧栏入口**技能 / Skills**）插件，覆盖已安装、发现、统计、诊断四个视图，以及共享页壳、骨架屏加载、预览弹窗与状态反馈。沿用现有 React 无 JSX 客户端与 Host API，不增加生产依赖，并移除未使用的 `@deepseek-ai/dsh-client-ui-renderer` 注入项。

## 使用目标

1. 在大量技能中快速找到目标，支持名称、描述、来源搜索。
2. 清楚地区分**自动调用（Auto-invoke）**与 **`/name` 手动（`/name` manual）**，并在调整前看到关联 Agent 数量。
3. 比较社区技能的名称、描述、来源身份及实时安装状态。
4. 根据真实调用趋势与诊断结论管理技能库，不暗示没有数据支持的性能或增长指标。

## 视觉与布局

- 单层 DSH 原生样式：删去多层覆盖表、合成 shadcn 垫片和硬编码运行期十六进制颜色，`--skd-*` 语义令牌直接绑定 DSH 的 `--dsw-*` / `--ds-*` 令牌。`.skd-page` 与挂载在 `document.body` 的 `.skd-previewOverlay` 共享同一组 `--skd-*` 令牌定义，避免浮层脱离页面树后丢失主题色。
- 字体跟随 `--dsw-font-family`，等宽字体跟随 `--ds-font-family-code`，缺失时回退系统字体，不加载外部字体。数字统一使用 `tabular-nums`。
- 页壳对齐同级 DSH 页面：内容最大宽度 `1120px`，页面标题 `<h1>` 为 `1.25rem`（20px，行高 1.4 即 28px），不放置装饰性页面图标框。状态胶囊（`.skd-statusPill`）内联在页头工具区，取消底部常驻 40px 页脚和已安装视图中的冗余区块标题，并在已安装与诊断页签上显示数量角标（诊断可清理计数带警示色调）。
- 更新状态收进页头：`可更新 N` 胶囊与「更新于」同组，点开是操作浮层，不再占用独立横幅；列表用「调用状态 → 可更新」筛选同一组行。
- 切换页签时保留来源页的滚动位置；页面内的跨页入口将焦点移到目的页。主操作按钮使用 `--dsw-alias-button-primary-fill`（`--skd-accent-fill`），描边按钮 `[data-variant="outline"]` 显式绑定控件边框、背景与前景令牌。
- 控件字号全部使用 `rem` 与无单位行高（标题 `1.25rem`、区块标题 `1rem`、正文 `0.875rem`、表单与行文本 `0.8125rem`、元信息 `0.75rem`/`0.6875rem`），跟随用户默认文字大小。
- 悬停态规则统一收敛到 `@media (hover: hover)` 内，避免触控设备产生黏滞悬停效果。
- 开关几何尺寸：`32×18px` 轨道、`12px` 滑块、`14px` 选中位移动程，滑块表面跟随 `--dsw-alias-switch-thumb`。
- 分段单选控件（技能来源、诊断分组、预览视图）统一显示单选圆点与选中态：选中项使用 `--skd-accent-bg` 底色、38% 强调色描边与强调色文字，圆点填充；未选中项圆点空心。轨道使用 `--skd-surface-2`，避免白底白块的低对比选中态。
- Windows 高对比度模式下为弹窗、批量条与菜单启用 `CanvasText` 边框，主按钮使用 `ButtonFace`/`ButtonText`，当前页签与选中文件项使用 `Highlight` 标记。
- 所有 CSS 使用 `skd-` 前缀，主题变量限定在面板和预览弹窗内。

## 插件图标

- `skill-dashboard/icon.svg` 采用 `36×36` 画布，**背景完全透明**，由 Host 的插件管理器绘制底板与边框。旧版图标内嵌 `#141A24` 深色圆角方块，在浅色主题下与其它插件图标不一致，已改为透明底。
- 图形语言与官方插件保持一致：蓝色渐变卡片（`#7EB8EA` → `#5A6FD6`）作为主体，紫蓝渐变四角星（`#A797FC` → `#658EFF`）作为辅助标记，中间留出连接弧线表示技能栈。
- 只使用平铺填充与短渐变，不使用发光、投影、高光或 emoji；不含 `<script>`、`<style>`、动画、`<image>` 与 `<foreignObject>`，字形不依赖外部字体。
- 在 Host 实际显示尺寸（列表行 `30px`、卡片 `36px`）下与 `dsh-skill-badge`、`dsh-personalized-recommendations` 等官方图标并排比对，主体清晰、光色主题下均无裁切。

## 加载体验与容错

- 首屏加载直接渲染完整页壳（页头、四页签栏），主体展示 4 张 KPI 骨架卡片、4 格筛选工具栏骨架与 6 行技能列表骨架。骨架块使用 `--dsw-alias-bg-skeleton` 与 `2s cubic-bezier(0.36, 0, 0.64, 1) infinite` 脉冲动画，在 `prefers-reduced-motion: reduce` 下停止动画。
- 发现页请求期间展示与 `DiscoverCard` 布局一致的 6 张卡片骨架网格。
- 预览弹窗加载期间展示顶部 2px 不确定进度条（`.skd-previewProgress`）及文件树、正文骨架屏。
- 后台刷新失败时不再用整页离线态替换已有内容，而是保留已加载界面，在页头下方展示带重试按钮的内联横幅（`.skd-banner`）。并发 `refresh()` 请求自动合并，写入操作完成后直接使用接口返回的最新状态，不再发起盲目的 800ms 延迟二次刷新。
- 面向用户的界面文案移除内部 "Host" 术语，并在中英词典中完整本地化全部 25 个服务错误码。

## 页面结构

### 已安装

顶部概览以 4 列卡片显示已安装技能、自动调用数、已检测 Agent 数与累计调用。筛选仅作用于列表，概览始终表示全量数据。

支持按名称、描述或来源进行去首尾空格、大小写不敏感搜索，可组合 Agent 筛选与调用状态筛选（全部状态、自动调用已开、自动调用已关、可管理）。排序支持调用最多、名称 A–Z 与最近使用，并列时按名称排序。列表显示结果数量和清除筛选入口，零匹配时提供一键重置。

每行显示身份、描述、调用次数，以及**自动调用**和 **`/name` 手动**开关（两者都关闭时显示`已停用`徽章）。菜单提供更新、删除和查看路径。提交写入期间暂时停用其他写入操作，同时仍可预览技能和查看路径。删除使用行内确认，确认后将焦点移到相邻技能，没有相邻技能时移到搜索框。

### 发现

顶部提供技能来源选择、关键词输入与搜索按钮。容器宽度 `≥1060px` 三列、`601–1059px` 双列、`≤600px` 单列。卡片包含统一图标、两行以内标题、版本号与次级安装数量，底部放置操作按钮，明确区分已安装（基于实时目录并集判断）、安装中与不可安装状态。

点击技能行或卡片打开页内预览浮层。浮层通过 portal 挂到 `document.body`，固定定位并自带遮罩，不使用原生 `<dialog>` / top layer 与背景模糊；Esc、点击遮罩或关闭按钮都会关闭，焦点限制在浮层内并在关闭后回到触发按钮。桌面默认尺寸最大为 `1280px`（`92vw`）× `860px`（`88dvh`），文件侧栏宽 `210–270px`，阅读正文列最大 `86ch`（`0.9rem`，行高 `1.75`）；文件数显示为「共 N 个文件」胶囊，窗口工具合并成一组。切换来源会废弃旧请求并在新来源重跑已提交搜索，编辑中的草稿在提交前保留，IME 组合输入期间的 Enter 不触发提交。

### 统计

统计覆盖全部 Agent。周期支持今天、近 7、14、30、60 天及自定义日期。周期内的调用、活跃技能和占比与累计调用分开显示。切换页签时保留日期、搜索、排序和趋势对象。搜索仅筛选表格，点击表格内的技能名称跳转并聚焦到对应趋势。窄面板仍显示三列，长名称换行。图表提供文字摘要和可用键盘展开的逐日明细。

### 诊断

诊断是判断页，回答当前应该处理哪些技能，而统计回答历史用了多少。

页头之后先给出观察边界：`观察自 <日期> · 共 <N> 天 · <总数> 个技能，其中 <在用数> 个近 14 天内被调用过`。窗口短于判断阈值时直接说明观察时长，不用空列表暗示没有可清理项。

五个互斥分组为可点击筛选条并附带服务侧计数：**可清理**、**已停用**、**使用中**、**已保留**、**观察中**。结论徽章统一为**使用中（In use）**、**近期未用（Idle recently）**、**久未调用（Unused）**、**从未调用（Never used）**、**已保留（Kept）**、**观察中（Observing）**。默认进入可清理，可清理为空时落到使用中，用户手动选过之后不再被默认值覆盖。

队列每行包含复选框、技能名（点击打开预览）、结论徽章与只读/已停用标记、证据行与操作按钮。操作按可用性出现，而不是整排置灰。停用可逆且不弹确认，删除复用行内确认（默认聚焦取消，Escape 取消），保留与取消保留复用同一按钮的两种状态，只读技能仅出现保留。切换调用权限或停用清理会原子重算诊断结论。

队列一次挂载并逐行 memo，离屏行用 `content-visibility` 跳过布局与绘制，滚动不写 React 状态。搜索与排序保留选择，切换分组重新开始选择；粘性批量条是选择的持续反馈。

勾选后底部出现粘性批量条：`已选 N · 可停用 N · 可删除 N · 只读 N`，提供停用、删除、保留与取消全选。超过单次上限（100）时只提交前 100 个，其余保持选中。失败行留在原处并显示本地化错误说明，成功行照常离开队列。

页尾的**判断规则（Diagnosis rules）**折叠块复述三个阈值与保留规则。结论文字与数字均来自词典和服务端，客户端不自行比较天数与阈值。

## 响应式与可访问性

- 使用命名容器 `dashboard` 的内联尺寸判断布局，确保 DSH 侧边栏伸缩时自动适配。
- `≥1060px`：发现页卡片三列；`601–1059px`：双列。
- `≤820px`：已安装筛选栏的搜索框独占首行、三个选择器排在第二行；诊断队列搜索与行操作区折行到技能信息下方，避免操作按钮挤压内容。
- `≤600px`：隐藏页头副标题与状态胶囊以留出首屏空间；概览转为紧凑 2×2；已安装列表行与发现页卡片转为单列堆叠；触控行开关高度提升至 `40px`（粗指针 `@media (pointer: coarse)` 下至少 `44px`）。
- `@media (max-width: 700px)`：预览弹窗切为近全屏布局，隐藏步进缩放按钮，文件树默认收起并通过顶栏切换按钮展开。
- 搜索和筛选使用 `search` 地标，输入框与选择器具备显式 `for`/`id` 标签与 `name`。发现搜索通过原生 `form submit` 提交，拦截 IME 组合输入与 `keyCode 229`。
- 权限开关使用 `input[type=checkbox][switch]`，原生不支持时以同一 checkbox 配合 `role=switch` 与自定义轨道回退；标签覆盖整个点击区，状态由 `checked` 驱动。
- 页签支持左右方向键与 `Home`/`End`，每个实例使用独立 `id`，`aria-controls` 均指向存在的面板。
- 行菜单使用 `popover=auto`、command invoker 与 CSS anchor 翻转策略；缺少对应能力时自动回退至受控固定定位与视口边界计算。
- 提供跳到主要内容链接；列表使用 `ul`/`li` 保留数量语义；清除筛选后焦点留在搜索框，结果朗读延后 350ms 避免频繁打断。
- 所有交互元素提供 `focus-visible` 轮廓，加载态使用 `aria-busy`，`prefers-reduced-motion: reduce` 下关闭所有骨架脉冲、进度条、旋转与过渡动画。
- 保留离线、后台刷新失败内联横幅、空目录、骨架屏加载与渲染异常恢复视图。

## 验证

执行 `node --test skill-dashboard/test/*.test.mjs`。客户端回归覆盖组合筛选、三种排序、来源切换时的成功/失败响应竞态、最新请求胜出及中英字典同步。

隔离浏览器验证脚本位于 `_verify/browser-check.mjs`，使用本机已有 Playwright 与 Chrome，测试运行时只加载 `_verify` 中的 React UMD，不增加生产依赖。覆盖搜索、组合筛选、清除筛选、权限开关与只读状态、发现入口、逐日明细，检查 1440/768/375px 的三个视图、深色及低动态效果，共 11 组无横向溢出检查。`_verify/select-checks.mjs` 另有 10 项可定制 select 检查：能力探测、触发器计算样式、仅用键盘改值并驱动真实筛选、`selectOption` 契约、弹层开合、深色无重渲染重绘、语言切换保留选中值、聚焦状态下 axe 扫描。`_verify/layout-run.mjs` 另外核对表头与行轨道逐像素对齐、控制带同一行、375px 行堆叠与 44px 触摸目标、320px/200% 文字无溢出；`_verify/real-theme-run.mjs` 用从已安装 DSH 提取的真实令牌表与 `body[data-ds-dark-theme]` 验证浅深重绘与语言切换。隔离用例采用固定测试数据，不代表线上指标。

第一轮视觉重设计已在实际桌面应用中刷新验证，能读取真实技能与调用记录；截图 `redesign-live-installed.png` 与 `redesign-live-usage.png` 位于 `_verify`。本轮 Modern Web Guidance 优化已通过下述浏览器验证，安装包使用工作区符号链接，最终改动随应用页面刷新生效。未对屏幕阅读器进行人工完整朗读验证，也未声明完整 WCAG 合规认证。

诊断页的隔离验证位于 `_verify/diagnosis-browser-check.mjs`：用真实 `index.js` 的 `diagnoseSkills` 读取本机真实调用记录与技能目录生成状态文档，再挂载真实 `client.js` 渲染，不手写结论。覆盖分组计数与划分、默认分组回退、证据行、只读行只留保留、批量计数、删除确认与取消、批量停用上限、单行停用/保留/删除、已停用与已保留分组的操作差异、大小写不敏感搜索与空结果、判断规则，并检查 1440/768/375px 无横向溢出、深色与英文切换、axe WCAG 2.2 AA 无严重违规、无控制台错误。`_verify/diagnosis-runtime-check.mjs` 用同一份源码校验客户端实际发出的 `cleanup`/`keep` 请求体，以及每批只读一次状态。

## Modern Web Guidance 复核

检索工具版本标记：`2026_11_10-47b4c80e`。按每类控件先 search，再 retrieve 全文；没有运行 legacy-scan。

| 指南 | 应用规则原文 | 实施 |
| --- | --- | --- |
| `menu` | “Do not add a second roving-tabindex system inside a focusgroup.” | 原生 focusgroup 使用浏览器的方向键行为，仅回退分支实现 Up/Down；统一补齐 Home/End、Tab、Escape 与恢复焦点。 |
| `viewport-aware-dropdowns` | “define \"try tactics\" that the browser should attempt if the default position overflows.” | popover 顶层 + CSS anchor 翻转；缺少 Anchor 时提供定位回退，不留下居中的菜单。 |
| `forms` | “DO use visible labels” | 已安装和发现搜索、排序与筛选均具备持久可见标签及显式 for/id；发现页使用原生 form submit。 |
| `ime-safe-enter-submit` | “Native implicit submission of a `<form>` from an `<input>` with no custom `Enter` handler needs no explicit handling” | 不再手工调用 Enter 搜索；只拦截组合输入和 229 确认键，正常 Enter 交给浏览器表单。 |
| `switch` | “listen for `change` (or `input`) events and read `.checked` rather than `.value`.” | 开关使用原生 checkbox 的 checked 和 change，switch 属性作为增强；不支持时提供样式与语义回退。 |
| `accessibility` | “Debounce frequently-changing regions” | 结果数量延迟朗读；补齐跳转链接、语义列表、图表摘要和带 caption 的表格，移除静态柱的冗余停靠点。 |
| `color` | “Maintain a minimum contrast ratio of 3:1 for user interface component boundaries and states” | 控件边界（输入框、下拉框、按钮）用 50% 前景混合令牌，浅色实测 3.1:1、深色 4.6:1；分区线与徽章用更轻的 16% 令牌，只承担装饰性分隔；forced-colors 使用系统色、真实边框与可见状态标记。 |
| `branded-select-styling` | “Apply `appearance: base-select` to both the `<select>` element and the `::picker(select)` pseudo-element” | 触发器与弹层同时接管，弹层用宿主令牌绘制；option 内容保持纯文本，不支持时自动回退为系统下拉框。 |
| `animated-select-picker` | “DO NOT set `overflow: hidden` on `::picker(select)`” | 弹层只做 opacity 与 translate 入场，保持可滚动，不引入 `interpolate-size`，不改宿主文档。 |
| `typography` | “DON'T use `px` for font-size.” | 所有插件字号改成 rem，不更改宿主 html/:root 的字号。 |
| `respect-os-text-scale` | “Use unitless values for line heights so they scale proportionally with each element's computed font size.” | 行高无单位，权限列用相对宽度，允许标签/页签换行，低高度模式整页滚动。 |

审阅了 dark-mode 与性能指南；保留宿主主题控制，不添加独立主题开关、不改宿主文档元数据。诊断队列的 `content-visibility` 由实测驱动：同一 130 行队列、1.75 DPR、4x CPU 节流下，关闭时滚动帧最长约 2150ms，开启后 16.8ms。

### 浏览器兼容性验证

`_verify/modern-web-checks.mjs` 扩展原浏览器脚本，共 26 项现代控件验证：

- 当前 Chrome 支持 Popover、Invoker、Focusgroup、Anchor；检查真实浏览器 Accessibility Tree 中的 menuitem 角色，而非仅依据测试库的 DOM 角色推断。
- 分别强制关闭 Invoker、Focusgroup、Anchor、Popover 检测结果，验证同一套组件的回退行为。每条路径验证键盘、指针、Tab 退出、路径操作、删除取消，以及宿主面板偏移下的边缘定位。
- 表单 Enter/按钮各提交一次，IME 确认不提交；开关支持原生 Space，显式标签关系正确；清除筛选后的焦点保留。
- axe-core 4.11 对三个视图分别运行浅色/深色 WCAG 2 A/AA、2.1 AA 与 2.2 AA 规则，共六次扫描，规则违规数为零。
- 320px 与 200% 根文字大小下三个视图无横向溢出；Windows forced-colors 下开关轨道、滑块、当前页签及主按钮文字可辨识。
- 回退分支验证在 Chromium 中模拟特性缺失，不能代替真实 Firefox、Safari、iOS 设备测试。axe 零违规不能代替用户测试或合规认证。

测试 React 与 axe 只用于隔离验证，不属于生产插件依赖。结果保存在 `_verify/browser-results.json`。
