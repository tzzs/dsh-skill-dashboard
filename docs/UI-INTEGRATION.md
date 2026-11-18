# 界面组件与 DSH 集成

## 当前组件栈与 shadcn/ui 选择

插件继续使用宿主 React、React.createElement 和 Module Loader，样式在面板内隔离，没有独立 React 实例、Tailwind 编译器或第三方运行时主题管理器。

本轮新增本地 Button / Input / Badge / Card 组件适配层，按钮与输入框通过 forwardRef 保留原生 ref；所有页面统一走这层组件。设计借鉴 shadcn/ui 的源码自持模式、语义颜色令牌及 default/outline/ghost 等变体思路，按 DSH 环境用普通 CSS 实现。它是 shadcn 风格的本地 React 适配，**没有宣称安装了原版 Radix/Base UI 组件库**。

官方参考：

- https://ui.shadcn.com/docs/installation/manual
- https://ui.shadcn.com/docs/theming
- https://ui.shadcn.com/r/styles/new-york/button.json

DSH 的 require 是模块表查找，不是 Node npm 解析；平台已有 React、ReactDOM 和 DSH primitives，没有预置 Radix。若以后要完整采用原版 shadcn 组件，应增加构建：打包所选 Radix/Base UI、工具依赖和组件 CSS，外置宿主 React/ReactDOM，再映射宿主颜色和深色选择器。仅 npm install 后直接 require Radix 不可用。本轮无需引入这套工具链即可保留已经验证的原生菜单、开关与表单交互。

## 本轮视觉调整

- 缩小页头，移除英文眉题与宣传式副标题，使用紧凑的图标、标题和功能说明。
- 页签改为轻量分段样式，选中态使用中性表面；普通按钮采用描边，主要操作采用前景/背景反色。
- 发现搜索去掉厚重底板，技能源、搜索框和搜索按钮形成单行操作区。
- 卡片统一图标、两行以内标题、次级版本号、三行描述与底部操作区；安装数量以次级文字显示，安装按钮不再整页高亮。
- 大面板三列，中等面板两列，窄面板一列；安装概览改为轻量指标行。
- 保留全部搜索、权限、安装、删除确认、菜单键盘交互、统计明细和响应式能力。

## 语言跟随

`locale: NS` 的 DSH 插槽通过 renderer 订阅宿主语言修订，为页面注入实时 t。ctx.locale.bind 本身读取当前语言；不会绑定为首次加载时的语言。继续使用这一机制，不建立第二套语言设置。

- 中文和英文文案按 DSH 当前语言切换。
- 受控搜索、筛选及页签状态在语言切换时不重置。
- 结果播报以翻译后的文本为 effect 依赖；技能源名称在每次渲染时生成，腾讯源不再固定沿用后端的中文标题。
- 日期和数字使用宿主设置的 html.lang；数量通过 Intl.NumberFormat 格式化。
- 技能名称、作者提供的描述与 Agent 预设名称属于来源数据，不自动翻译。

## 主题跟随

DSH ThemePresenter 更新 html.style.colorScheme、body[data-ds-dark-theme]、body 上的主题令牌与字体设置。插件只读取继承值，不修改宿主主题，不使用 .dark 作为 DSH 合约，不添加独立 next-themes Provider。

本地 background / foreground / primary / card / muted / border / input / ring 语义变量映射到 --dsw-*。默认按钮使用前景/背景反色；焦点和权限开关使用宿主强调色。CSS palette 变化无需 React 重渲染。原生输入、选择器和滚动条继承 color-scheme。

字体遵循 --dsw-font-family，代码路径使用宿主的 --ds-font-family-code。浅色、深色、跟随系统及用户自定义令牌均从宿主继承。

## 验证与限制

- 现有 11 组布局检查及 26 项现代控件检查通过。
- 新增 `_verify/host-follow-checks.mjs`：中英文来回切换且不重挂载页面，保留搜索内容并更新结果播报、技能源标签。
- 使用从当前已安装 DSH 提取的真实主题 CSS，切换 body 深色标记和 html color-scheme，验证浅深主题及 system 来源下的实际深色。主题切换不调用插件 render。
- 验证宿主自定义背景令牌和字体变量即时生效。
- 使用真实 DSH 浅深调色板，对三个视图分别运行 axe 扫描，六次扫描均为零违规。
- 客户端、辅助函数与路由回归通过。结果见 `_verify/browser-results.json`。

浏览器验证使用固定技能数据和宿主真实 palette；不等同于已经在实际设置菜单里手动切换。宿主 API 的结论来自当前安装版本源码，源码研究保存在 `_verify/host-reference/locale-theme-research.md`。客户端最终改动在重新加载应用页面后生效。

## 技能详情与文件预览

点击已安装技能名称，或发现卡片中的名称/预览按钮，可打开技能详情与文件阅读弹层。左侧按目录树展示文件，文件夹使用原生 details/summary，可独立展开/折叠，缩进和连线表现层级；右侧默认显示主说明；Markdown 提供阅读/原文切换，其他文本使用代码原文视图。阅读视图仅处理基本标题、列表、粗体、行内代码和代码块；其他 Markdown 语法保留文本，不注入 HTML、不加载远程图片、不执行脚本。

使用原生 dialog.showModal()，通过 ReactDOM portal 渲染内容。dialog 节点不由 React 管理，避免 top-layer 节点与渲染树发生重挂载冲突。关闭按钮使用 form method=dialog；浏览器提供 Esc、背景 inert 与焦点返回，未添加自定义键盘焦点陷阱。语言变更不会重建弹层或重置文件选择。

Modern Web Guidance 的 dialog 指南要求 “The browser returns it to the invoker”，因此让浏览器处理焦点返回；prevent-page-scroll-under-modal-dialog 指南要求在弹层和遮罩上设置 overscroll-behavior，并让遮罩形成 scroll container，因此设置 dialog:modal 的 contain 与 backdrop 的 overflow:hidden/contain，没有改动 html/body 的 overflow。滚动隔离作为渐进增强，旧浏览器仍保留原生模态语义。

预览浏览器检查现覆盖真实本地 Host 接口、目录层级与原生折叠键盘操作、文件切换及重复打开零请求缓存、只读当前文件响应、刷新绕过缓存、原生拖拽缩放与按钮缩放、最大化/还原、Markdown/原文、二进制及截断、异步竞态、失败重试、焦点/背景滚动、语言/配色、窄屏及 320px 大文字、Esc 返回焦点和发现技能预览。弹层 axe 扫描零违规；图片为 `_verify/skill-preview-desktop.png`、`_verify/skill-preview-desktop-dark.png`、`_verify/skill-preview-mobile.png`。预览接口有 17 项测试，周期统计接口有 4 项测试；远程请求使用 mock。

## 预览性能与窗口调整

此前每次选文件都会重新遍历目录并对所有文件读取 8 KiB；在线预览还会等待完整安装载荷。现在目录只读元信息，Host 目录缓存 15 秒且有容量上限，每次选中文件仍重验路径和真实目录边界。在线预览先取目录元信息，再读取当前文件的最多 128 KiB 前缀并取消剩余流；已知二进制文件不下载正文。切换文件使用 fileOnly:true，减少重复传输目录数据。

客户端缓存 30 秒，最多六个技能、每技能八个文件。返回已读文件或重新打开近期技能可零请求显示；刷新按钮发送 refresh:true 绕过两层缓存，成功修改技能后清除客户端缓存。测试通过 fs 调用计数证明首次只打开所选文件、缓存切换不重新 opendir；远程首次仅目录+当前文件两次请求，未选文件零下载。这里验证的是读取/请求工作量，没有宣称固定网络时延。

桌面默认窗口上限 1440px/94vw，高度 92dvh；右下角原生 resize:both，另有缩小、放大、最大化、还原按钮，避免只能拖拽。尺寸受视口约束，常规尺寸在当前页面会话内保留；窄屏接近全屏且不提供拖拽手柄。

## 按周期逐技能统计

Host 在兼容原 14 天响应的基础上新增 60 天 usage.history 与 usage.skillUsage[].dayBuckets，保留累计次数/累计渠道计数，并包含不在当前技能库的历史技能。界面使用今天、近 7/14/30/60 天或自定义包含首尾日期的范围，展示周期总数、周期活跃数、可搜索排序的技能次数/占比表、全体或单技能趋势及逐日明细。搜索只改变表格，选择技能只改变趋势；最近活动和累计总数明确不受周期筛选。未存储历史逐日渠道拆分，因此不把累计模型/用户次数伪装成周期次数。老 Host 只能提供 14 天时按实际日期限定范围并提示；无效日期不展示误导的零值。

五组周期浏览器检查使用真实 Host summarizeUsage 生成样本，核对所有预设、自定义范围、零调用技能、当前库外记录、占比、搜索和趋势独立性、排序后行节点/焦点保留、语言切换保留选择、真实 DSH 浅深配色 axe 与窄屏内滚动。图片为 `_verify/period-statistics.png`、`_verify/period-skill-table.png`、`_verify/period-statistics-mobile.png`。

本轮 Modern Web Guidance 应用：accordion 指南 “Do not add arrow key navigation”——目录用原生 disclosure，保留 Enter/Space 和正常 Tab，而不冒充需要 roving tabindex 的 ARIA tree；dialog 指南 “The browser returns it to the invoker”——调整尺寸时沿用原生模态语义和焦点返回；responsive-table 指南 “people using only a keyboard can consistently scroll the table”——给内滚动区域名称和键盘入口；sortable-table 指南 “currently sorted column only”——仅活动表头设置 aria-sort，支持原生自定义命令和不支持 Invoker 时的点击回退，React 稳定 key 保留行节点身份。

完整接口和上限见 `docs/CONTRACT.md`，使用说明见插件 README。本轮包含 Host 变更，已安装实例需要重启 DSH 加载新代码；仅刷新页面不会可靠地重载 Host 模块。
