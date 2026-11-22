# 技能看板 UI 设计规范

本次优化针对工作区内的 Skill dashboard 插件，覆盖已安装、发现、统计三个视图及共享页头、状态反馈。沿用现有 React 无 JSX 客户端与 Host API，不增加生产依赖。

## 使用目标

1. 在大量技能中快速找到目标，支持名称、描述、来源搜索。
2. 清楚地区分模型自动调用与用户手动指令，并在调整前看到关联 Agent 数量。
3. 比较社区技能的名称、描述、来源身份及安装状态。
4. 根据真实调用趋势管理技能库，不暗示没有数据支持的性能或增长指标。

## 视觉与布局

- 中性工具型界面，沿用 Host 主题的单一强调色；错误、成功只用于语义反馈。
- 使用 `--skd-*` 语义令牌映射 Host 的背景、前景、强调色，次级文字由前景与背景混合生成，避免依赖原界面过浅的 caption 色。
- 字体优先跟随 DSH 的 --dsw-font-family，缺失时使用系统无衬线字体，不加载外部字体。数字采用 tabular figures。
- 页面最大宽度 1680px。统一使用紧凑页头、分段页签、可滚动主体与底部状态。切换页签时保留来源页的滚动位置。页面内的跨页入口将焦点移到目的页。主要操作使用中性反色，普通操作使用描边。
- 默认字号对应 22px 页面标题、17px 区块标题、13–14px 正文与 11–12px 元信息，使用 rem 与无单位行高，跟随用户默认文字大小。
- 装饰分隔线与控件边界分开：输入、选择器、菜单等采用更高对比度边界；强调色浅底标签使用独立前景色，满足正文对比要求。
- Windows 高对比度模式下使用 Canvas、CanvasText、ButtonText、Highlight 等系统色，开关保留可见轮廓与位置差异，当前页签使用真实边框标记。
- 默认轻量边框和低对比表面，菜单使用浮层阴影。避免装饰渐变、图像背景和无意义动效。
- 所有 CSS 使用 `skd-` 前缀，主题变量限定在面板内。

## 页面结构

### 已安装

概览显示全量技能、模型可调用数、已检测 Agent 数与累计调用。筛选仅作用于已安装列表，概览始终表示全量数据。

搜索名称、描述或来源，支持去除首尾空格和大小写不敏感匹配；可组合 Agent 筛选、模型已开启/关闭或可管理状态。排序支持调用最多、名称与最近使用；并列时按名称排序。列表显示结果数量和清除筛选入口，零匹配时提供恢复操作。

每行显示身份、描述、调用次数、模型和手动调用开关。菜单提供更新、删除和查看路径。提交写入期间，其他写入操作会暂时停用，仍可预览技能和查看路径。列表前说明共享权限会影响所有关联 Agent。删除使用行内确认，确认后将焦点移到相邻技能，没有相邻技能时移到搜索框。

### 发现

顶部显示无厚重底板的技能源选择与搜索。大面板三列、中等面板双列、窄面板单列。卡片使用统一图标、两行以内标题、独立版本号与次级安装数量；底部使用普通描边安装按钮。已安装、安装中、不可安装状态明确区分，不可安装原因直接显示。

点击技能名称可预览。搜索结果标注技能源与已提交的关键词。切换来源会废弃旧请求，并在新来源重跑已提交的搜索。重试使用失败请求的关键词。编辑中的草稿保留，等用户提交后才用于搜索。中文输入法组合输入期间的 Enter 不提交搜索。

### 统计

统计覆盖全部 Agent。周期支持今天、近 7、14、30、60 天及自定义日期。周期内的调用、活跃技能和占比与累计调用分开显示。切换页签时保留日期、搜索、排序和趋势对象。搜索仅筛选表格。点击表格内的技能名称会跳转并聚焦到对应趋势。窄面板仍显示三列，长名称换行。图表提供文字摘要和可用键盘展开的逐日明细。

## 响应式与可访问性

- 用命名容器 `dashboard` 的宽度判断布局，确保 Host 侧边栏变化时也能适配。
- ≥1200px：发现页三列；600–1199px：双列；≤600px：单列，并压缩横向间距。
- ≤600px：概览为紧凑 2×2，列表控制移到描述下；主按钮保留可见文字。窄屏及粗指针下主要操作区域至少 48px，输入使用至少 1rem 字号。
- 低高度视口改为整面板滚动，避免页头或底部状态挤掉正文；页签和状态文字允许换行。
- 搜索和筛选使用 search 地标；搜索框与选择器具有显式 for/id 标签、name 和输入提示。发现搜索通过 form submit 提交，阻止 IME 组合输入与 keyCode 229 的确认键，避免提前或重复提交。
- 权限开关使用 input[type=checkbox][switch]，原生 switch 不支持时采用同一个 checkbox 的 role=switch 与装饰轨道回退；标签是完整点击区，状态由 checked 管理。不增加运行时 polyfill 或外部加载依赖。
- 页签支持左右方向键与 Home/End；每个实例使用独立 id，所有 aria-controls 指向存在的面板。隐藏页签面板不包含可交互内容。
- 行菜单使用 popover=auto 与 command invoker，进入顶层避免滚动容器裁切；CSS anchor 与 flip 策略自动处理边缘。native focusgroup 支持时推导菜单角色，否则只在回退分支设置 menu/menuitem 并处理方向键。
- 对 Popover、Invoker、Focusgroup、Anchor 分别做能力检测；无 Popover 时以受控固定浮层回退，无 Anchor 时计算翻转与视口约束，并补偿宿主固定定位包含块的原点。
- 菜单支持 ArrowDown 进入、Home/End、Escape 恢复触发器、Tab 退出、外部聚焦关闭及动作后焦点恢复。删除确认先聚焦取消，Escape 关闭并返回行菜单触发器。
- 提供跳到主要内容链接；列表使用 ul/li 保留技能数量语义；清除筛选后焦点留在搜索框，结果朗读延后 350ms 防止每次输入都打断用户。
- 所有交互显示 focus-visible，开关通过原生 checked 暴露状态，加载使用 aria-busy。
- 低动态效果偏好下关闭动画和过渡。
- 保留原有离线、错误、空目录、加载和渲染失败恢复视图。

## 验证

执行 `node --test skill-dashboard/test/*.test.mjs`。客户端回归覆盖组合筛选、三种排序、来源切换时的成功/失败响应竞态、最新请求胜出及中英字典同步。

隔离浏览器验证脚本位于 `_verify/browser-check.mjs`，使用本机已有 Playwright 与 Chrome，测试运行时只加载 `_verify` 中的 React UMD，不增加生产依赖。覆盖搜索、组合筛选、清除筛选、权限开关与只读状态、发现入口、逐日明细，检查 1440/768/375px 的三个视图、深色及低动态效果，共 11 组无横向溢出检查。`_verify/select-checks.mjs` 另有 10 项可定制 select 检查：能力探测、触发器计算样式、仅用键盘改值并驱动真实筛选、`selectOption` 契约、弹层开合、深色无重渲染重绘、语言切换保留选中值、聚焦状态下 axe 扫描。`_verify/layout-run.mjs` 另外核对表头与行轨道逐像素对齐、控制带同一行、375px 行堆叠与 44px 触摸目标、320px/200% 文字无溢出；`_verify/real-theme-run.mjs` 用从已安装 DSH 提取的真实令牌表与 `body[data-ds-dark-theme]` 验证浅深重绘与语言切换。隔离用例采用固定测试数据，不代表线上指标。

第一轮视觉重设计已在实际桌面应用中刷新验证，能读取真实技能与调用记录；截图 `redesign-live-installed.png` 与 `redesign-live-usage.png` 位于 `_verify`。本轮 Modern Web Guidance 优化已通过下述浏览器验证，安装包使用工作区符号链接，最终改动随应用页面刷新生效。未对屏幕阅读器进行人工完整朗读验证，也未声明完整 WCAG 合规认证。

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

审阅了 dark-mode 与性能指南；保留宿主主题控制，不添加独立主题开关、不改宿主文档元数据，也未引入未经性能证据支持的虚拟列表或 content-visibility。

### 浏览器兼容性验证

`_verify/modern-web-checks.mjs` 扩展原浏览器脚本，共 26 项现代控件验证：

- 当前 Chrome 支持 Popover、Invoker、Focusgroup、Anchor；检查真实浏览器 Accessibility Tree 中的 menuitem 角色，而非仅依据测试库的 DOM 角色推断。
- 分别强制关闭 Invoker、Focusgroup、Anchor、Popover 检测结果，验证同一套组件的回退行为。每条路径验证键盘、指针、Tab 退出、路径操作、删除取消，以及宿主面板偏移下的边缘定位。
- 表单 Enter/按钮各提交一次，IME 确认不提交；开关支持原生 Space，显式标签关系正确；清除筛选后的焦点保留。
- axe-core 4.11 对三个视图分别运行浅色/深色 WCAG 2 A/AA、2.1 AA 与 2.2 AA 规则，共六次扫描，规则违规数为零。
- 320px 与 200% 根文字大小下三个视图无横向溢出；Windows forced-colors 下开关轨道、滑块、当前页签及主按钮文字可辨识。
- 回退分支验证在 Chromium 中模拟特性缺失，不能代替真实 Firefox、Safari、iOS 设备测试。axe 零违规不能代替用户测试或合规认证。

测试 React 与 axe 只用于隔离验证，不属于生产插件依赖。结果保存在 `_verify/browser-results.json`。
