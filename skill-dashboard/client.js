window.__ModuleLoader__.load({
  id: '@local/dsh-skill-dashboard',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } = React;

    /** Drops the falsy branch of a conditional child, so JSX-free trees stay readable. */
    const el = (type, props, ...children) => h(type, props, ...children.filter(
      (child) => child !== null && child !== undefined && child !== false && child !== true,
    ));

    // Local React adapters use shadcn/ui's source-owned component/variant model.
    // Styling is scoped CSS because the DSH module loader does not compile Tailwind or JSX.
    const Button = React.forwardRef(function Button({ className = 'skd-button', variant, ...props }, ref) {
      return h('button', { type: 'button', ...props, ref, className, 'data-slot': 'button',
        'data-variant': props['data-variant'] ?? variant });
    });
    const Input = React.forwardRef(function Input({ className = 'skd-input', ...props }, ref) {
      return h('input', { ...props, ref, className, 'data-slot': 'input' });
    });
    function Badge({ className = 'skd-badge', ...props }) {
      return h('span', { ...props, className, 'data-slot': 'badge' });
    }
    function Card({ className = 'skd-card', ...props }) {
      return h('article', { ...props, className, 'data-slot': 'card' });
    }

    // ---------------------------------------------------------------- constants
    const PACKAGE_ID = '@local/dsh-skill-dashboard';
    const NS = 'skill-dashboard';
    const ROUTE_STATE = 'skill-dashboard/state';
    const ROUTE_ACTION = 'skill-dashboard/action';
    const ROUTE_DISCOVER = 'skill-dashboard/discover';
    const ROUTE_PREVIEW = 'skill-dashboard/preview';
    /** A tab switch reloads only when the snapshot is older than this. */
    const STALE_AFTER_MS = 5000;
    /**
     * One delayed re-read after a mutation. The Host patches its cache synchronously, but
     * the skill provider's own watcher needs ~200–500 ms to republish, so a single settle
     * read at 800 ms is what makes a lagging watcher agree without a stuck spinner.
     */
    const SETTLE_RETRY_MS = 800;
    const REQUEST_TIMEOUT_MS = 10000;
    const DISCOVER_LIMIT = 20;
    /** 高频 needs a real run of calls, not one lucky invocation: this many calls … */
    const MIN_FREQUENT_CALLS = 3;
    /** … and at least this many skills with calls, so the percentile means something. */
    const MIN_FREQUENT_PEERS = 3;

    // ---------------------------------------------------------------- locale
    /** Simplified Chinese dictionary; the key set the English one mirrors. */
    const zh = {
      'preview.restore': '还原窗口',
      'preview.maximize': '最大化窗口',
      'preview.grow': '放大窗口',
      'preview.shrink': '缩小窗口',
      'preview.refresh': '刷新预览',
      'usage.recentAllTime': '最近调用记录，不随周期筛选。',
      'usage.noMatchingSkills': '没有匹配的技能。',
      'usage.showTrend': '查看 {name} 的周期趋势',
      'usage.removed': '不在当前技能库',
      'usage.tableCaption': '{range} · 每个技能的周期调用次数及占全部调用的比例',
      'usage.sort.descending': '降序',
      'usage.sort.ascending': '升序',
      'usage.column.share': '周期调用占比',
      'usage.column.count': '调用次数',
      'usage.column.name': '技能名称',
      'usage.tableResults': '显示 {count} / {total} 个技能 · 按{column}{direction}',
      'usage.searchTableOnly': '搜索只筛选表格；占比按周期内全部调用计算。点击技能名称查看趋势。',
      'usage.searchPlaceholder': '输入技能名称…',
      'usage.searchSkills': '搜索技能名称',
      'usage.perSkill': '逐技能统计',
      'usage.periodChartSummary': '{name} · {range} · 共 {count} 次，单日最高 {peak} 次。下方可展开逐日明细。',
      'usage.allSkills': '全部技能',
      'usage.trendSkill': '趋势范围',
      'usage.periodTrend': '周期调用趋势',
      'usage.periodActiveHint': '所选日期内至少调用一次，含当前技能库之外的技能',
      'usage.periodActive': '周期内活跃技能',
      'usage.periodCalls': '周期内调用',
      'usage.rangeError.bounds': '日期必须在 {start} 至 {end} 之间。',
      'usage.rangeError.order': '开始日期不能晚于结束日期。',
      'usage.rangeError.invalid': '请输入有效日期。',
      'usage.rangeError.required': '请选择开始日期和结束日期。',
      'usage.rangeError.unavailable': '暂无逐日统计，请刷新或更新插件。',
      'usage.boundedRange': '所选周期超出保留范围，当前仅统计 {start} 至 {end}，更早日期不计入统计。',
      'usage.availableRange': '可用日期：{start} 至 {end}',
      'usage.endDate': '结束日期',
      'usage.startDate': '开始日期',
      'usage.period.custom': '自定义日期',
      'usage.period.60': '近 60 天',
      'usage.period.30': '近 30 天',
      'usage.period.14': '近 14 天',
      'usage.period.7': '近 7 天',
      'usage.period.today': '今天',
      'usage.period': '统计周期',
      'usage.periodBody': '按周期查看每个技能的调用情况，统计覆盖全部 Agent。',
      'preview.action': '预览',
      'preview.title': '技能预览',
      'preview.open': '查看 {name} 的详情',
      'preview.close': '关闭预览',
      'preview.files': '技能文件',
      'preview.content': '文件内容',
      'preview.instructions': '技能说明',
      'preview.view': '内容显示方式',
      'preview.read': '阅读',
      'preview.source': '原文',
      'preview.loading': '正在读取技能内容…',
      'preview.failed': '无法读取预览内容，请稍后重试。',
      'preview.filesLimited': '文件列表已达到预览上限，仅显示部分文件。',
      'preview.noFiles': '暂无可预览文件。',
      'preview.truncated': '文件较大，当前仅显示开头部分。',
      'preview.emptyFile': '这是一个空文件。',
      'preview.binaryShort': '二进制',
      'preview.binary': '这是二进制文件，暂不支持内容预览。',
      'preview.unavailable': '此文件暂时无法读取。',
      'preview.readOnlyNotice': '只读预览，不会执行文件',
      'preview.remoteNotice': '在线文件按需加载，二进制文件仅展示信息。',
      'error.preview-unavailable': '此技能无法预览；如果刚更新插件，请重新加载插件后再试。',
      'error.preview-failed': '无法读取预览内容，请稍后重试。',
      'error.skill-not-found': '技能已不在当前目录中，请刷新技能列表。',
      'error.file-not-found': '文件已不存在或不能预览，请选择其他文件。',
      'panel.label': '技能看板',
      'panel.title': '技能看板',
      'panel.subtitle': '{skills} 个技能 · {agents} 个 Agent · {invocable} 个模型可调用',
      'tab.list': '技能看板视图',
      'tab.installed': '已安装',
      'tab.discover': '发现',
      'tab.usage': '统计',
      'filter.label': '按 Agent 筛选',
      'filter.all': '全部',
      'filter.agentOption': '{name} ({count})',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.cancel': '取消',
      'action.search': '搜索',
      'action.switch': '切换',
      'action.reload': '重新加载页面',
      'action.dismiss': '关闭',
      'skill.runtimesOne': '仅 {agent}',
      'skill.runtimesSome': '{count}/{total} 个 Agent',
      'skill.calls': '已调用 {count} 次',
      'skill.callsLabel': '调用',
      'skill.usageTitle': '共 {count} 次 · 模型 {model} · 手动 {user}',
      'skill.readonly': '只读',
      'skill.frequent': '高频',
      'skill.closed': '已关闭',
      'skill.model': '模型可调用',
      'skill.user': '/name 可调用',
      'skill.modelSwitchAria': '模型可调用：{name}',
      'skill.userSwitchAria': '/name 可调用：{name}',
      'skill.menuAria': '更多操作：{name}',
      'skill.menu.update': '更新',
      'skill.menu.remove': '删除',
      'skill.menu.showPath': '查看路径',
      'skill.menu.hidePath': '隐藏路径',
      'skill.path': '路径',
      'skill.empty.title': '还没有可管理的技能',
      'skill.empty.body': '在「发现」里安装技能，或把 SKILL.md 放进个人技能目录。',
      'skill.emptyFiltered': '这个 Agent 下没有技能。',
      'skill.loading': '正在读取技能目录…',
      'skill.removeConfirm': '删除「{name}」？技能目录会一并移除，无法撤销。',
      'skill.removeConfirmAction': '确认删除',
      'skill.busy': '正在保存…',
      'discover.source': '技能来源',
      'discover.placeholder': '技能名或仓库，回车搜索',
      'discover.searchLabel': '搜索技能',
      'discover.idle.title': '从一个来源开始',
      'discover.idle.body': '在 skills.sh 或腾讯技能源里搜索，然后一键安装到个人技能目录。',
      'discover.loading': '正在搜索…',
      'discover.empty.title': '没有匹配的技能',
      'discover.empty.body': '换个关键词，或切换到另一个来源。',
      'discover.error.title': '这个来源暂时不可用',
      'discover.error.hint': '先切到另一个来源，或稍后重试。',
      'discover.otherSource': '换到 {source}',
      'discover.install': '安装',
      'discover.installAria': '安装：{name}',
      'discover.installBlockedAria': '无法安装 {name}：{reason}',
      'discover.notInstallable': '这个来源的条目无法直接安装',
      'discover.installing': '正在安装…',
      'discover.installed': '已安装',
      'discover.version': 'v{version}',
      'discover.updated': '更新于 {date}',
      'discover.installs': '{count} 次安装',
      'discover.note.suggestions': '空查询按热门排序展示',
      'usage.total': '总调用',
      'usage.active': '活跃技能',
      'usage.today': '今日调用',
      'usage.totalHint': '全部 Agent 累计',
      'usage.split': '模型 {model} · 手动 {user}',
      'usage.activeHint': '至少用过一次',
      'usage.todayHint': '近 14 天 {count} 次',
      'usage.chart': '调用趋势',
      'usage.dayTitle': '{date} · {count} 次',
      'usage.recent': '最近活动',
      'usage.recentEmpty': '还没有调用记录。',
      'usage.note': '统计仅包含看板启用后采集的调用。逐日数据保留 60 天，累计次数不受周期筛选影响。',
      'usage.unknownAgent': '未知 Agent',
      'status.updatedAt': '更新于 {time}',
      'status.counts': '{skills} 个技能 · {agents} 个 Agent',
      'status.saved': '已保存',
      'status.removed': '已删除 {name}',
      'status.installed': '已安装 {name}',
      'status.updatedSkill': '已更新 {name}',
      'status.upToDate': '{name} 已是最新版本',
      'status.busy': '正在处理…',
      'status.failed': '{action}失败：{message}',
      'status.failedPlain': '操作失败',
      'status.offlineInline': '连不上 Host，改动状态未知。',
      'offline.title': '连不上技能看板的 Host',
      'offline.body': '插件路由没有响应。确认 Host 已加载该插件，然后重试。',
      'crash.title': '技能看板渲染失败',
      'crash.body': '重新加载页面会重新挂载插件；如果反复失败，请查看浏览器控制台。',
      'error.read-only': '只读技能，无法修改',
      'error.source-unavailable': '来源暂时不可用',
      'error.invalid-response': 'Host 返回了无法读取的数据',
      'panel.eyebrow': 'SKILLS / 工作空间',
      'panel.intro': '管理技能、调用权限与使用情况。',
      'overview.skills': '技能库',
      'overview.enabled': '模型可调用',
      'overview.agents': '已检测 Agent',
      'overview.calls': '累计调用',
      'installed.title': '已安装技能',
      'installed.body': '查找、筛选技能并管理调用权限。',
      'installed.search': '搜索已安装技能',
      'installed.placeholder': '搜索技能名称、描述或来源…',
      'installed.results': '显示 {count} / {total} 个技能',
      'installed.noMatches': '没有符合条件的技能',
      'installed.noMatchesBody': '试试其他关键词，或清除筛选条件。',
      'installed.reset': '清除筛选',
      'installed.status': '调用状态',
      'installed.all': '全部状态',
      'installed.enabled': '模型已开启',
      'installed.disabled': '模型已关闭',
      'installed.writable': '可管理',
      'installed.sort': '排序方式',
      'installed.sort.usage': '调用最多',
      'installed.sort.name': '名称 A–Z',
      'installed.sort.recent': '最近使用',
      'installed.permissions': '调用权限',
      'installed.hint': '模型调用用于自动选择技能；手动调用用于 /技能名 指令。共享技能的权限调整会影响所有关联 Agent。',
      'discover.title': '发现技能',
      'discover.body': '浏览社区技能，为 Agent 添加合适的能力。',
      'discover.popular': '浏览热门技能',
      'discover.results': '{count} 个搜索结果',
      'discover.queryScope': '{source} · 关键词：{query}',
      'discover.unavailableTitle': '暂无可用技能源',
      'discover.unavailableBody': '刷新看板以重新检查技能源。',
      'usage.title': '使用概览',
      'usage.body': '查看所有 Agent 的调用趋势与最近活动。',
      'usage.breakdown': '逐日调用明细',
      'usage.date': '日期',
      'usage.count': '调用次数',
      'status.ready': '目录已同步',
      'action.discover': '发现新技能',
      'action.backLibrary': '返回技能库',
      'source.tencent': '腾讯 SkillHub',
      'action.skipContent': '跳到主要内容',
      'usage.chartSummary': '近 14 天共调用 {count} 次，单日最高 {peak} 次。下方可展开逐日明细。',
    };

    /** English dictionary; read in channels that name no registered language. */
    const en = {
      'preview.restore': 'Restore preview',
      'preview.maximize': 'Maximize preview',
      'preview.grow': 'Enlarge preview',
      'preview.shrink': 'Shrink preview',
      'preview.refresh': 'Refresh preview',
      'usage.recentAllTime': 'Latest calls, independent of the selected period.',
      'usage.noMatchingSkills': 'No matching skills.',
      'usage.showTrend': 'Show period trend for {name}',
      'usage.removed': 'Outside current library',
      'usage.tableCaption': '{range} · Calls per skill and share of all calls in this period',
      'usage.sort.descending': 'descending',
      'usage.sort.ascending': 'ascending',
      'usage.column.share': 'Share of period calls',
      'usage.column.count': 'Calls',
      'usage.column.name': 'Skill name',
      'usage.tableResults': 'Showing {count} of {total} skills · {column}, {direction}',
      'usage.searchTableOnly': 'Search filters this table. Shares use all calls in the period. Select a skill to view its trend.',
      'usage.searchPlaceholder': 'Enter a skill name…',
      'usage.searchSkills': 'Search skill names',
      'usage.perSkill': 'Usage by skill',
      'usage.periodChartSummary': '{name} · {range} · {count} calls, with a daily peak of {peak}. Expand daily details below.',
      'usage.allSkills': 'All skills',
      'usage.trendSkill': 'Trend scope',
      'usage.periodTrend': 'Calls over selected period',
      'usage.periodActiveHint': 'Called in this period, including skills outside the current library',
      'usage.periodActive': 'Active skills in period',
      'usage.periodCalls': 'Calls in period',
      'usage.rangeError.bounds': 'Dates must fall between {start} and {end}.',
      'usage.rangeError.order': 'The start date must be on or before the end date.',
      'usage.rangeError.invalid': 'Enter valid dates.',
      'usage.rangeError.required': 'Choose both a start and an end date.',
      'usage.rangeError.unavailable': 'No daily statistics available. Refresh or update the plugin.',
      'usage.boundedRange': 'This period exceeds retained history. Showing only {start} to {end}; earlier dates are excluded.',
      'usage.availableRange': 'Available dates: {start} to {end}',
      'usage.endDate': 'End date',
      'usage.startDate': 'Start date',
      'usage.period.custom': 'Custom dates',
      'usage.period.60': 'Last 60 days',
      'usage.period.30': 'Last 30 days',
      'usage.period.14': 'Last 14 days',
      'usage.period.7': 'Last 7 days',
      'usage.period.today': 'Today',
      'usage.period': 'Period',
      'usage.periodBody': 'View each skill’s calls over a selected period across all agents.',
      'preview.action': 'Preview',
      'preview.title': 'Skill preview',
      'preview.open': 'View details: {name}',
      'preview.close': 'Close preview',
      'preview.files': 'Skill files',
      'preview.content': 'File content',
      'preview.instructions': 'Instructions',
      'preview.view': 'Content display',
      'preview.read': 'Read',
      'preview.source': 'Source',
      'preview.loading': 'Loading skill content…',
      'preview.failed': 'Could not load the preview. Please retry.',
      'preview.filesLimited': 'The preview limit was reached. Only some files are listed.',
      'preview.noFiles': 'No files available to preview.',
      'preview.truncated': 'This file is large. Only its beginning is shown.',
      'preview.emptyFile': 'This file is empty.',
      'preview.binaryShort': 'Binary',
      'preview.binary': 'This is a binary file. Content preview is unavailable.',
      'preview.unavailable': 'This file cannot be read right now.',
      'preview.readOnlyNotice': 'Read-only preview. Files are never executed.',
      'preview.remoteNotice': 'Online files load on demand. Binary files show metadata only.',
      'error.preview-unavailable': 'Preview is unavailable. Reload the plugin if it was just updated.',
      'error.preview-failed': 'Could not load the preview. Please retry.',
      'error.skill-not-found': 'The skill is no longer in the catalog. Refresh the library.',
      'error.file-not-found': 'The file no longer exists or cannot be previewed. Choose another file.',
      'panel.label': 'Skill dashboard',
      'panel.title': 'Skill dashboard',
      'panel.subtitle': '{skills} skills · {agents} agents · {invocable} model-invocable',
      'tab.list': 'Skill dashboard views',
      'tab.installed': 'Installed',
      'tab.discover': 'Discover',
      'tab.usage': 'Usage',
      'filter.label': 'Filter by agent',
      'filter.all': 'All',
      'filter.agentOption': '{name} ({count})',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel',
      'action.search': 'Search',
      'action.switch': 'Switch',
      'action.reload': 'Reload the page',
      'action.dismiss': 'Dismiss',
      'skill.runtimesOne': '{agent} only',
      'skill.runtimesSome': '{count}/{total} agents',
      'skill.calls': '{count} calls',
      'skill.callsLabel': 'Calls',
      'skill.usageTitle': '{count} calls · {model} by model · {user} manual',
      'skill.readonly': 'Read-only',
      'skill.frequent': 'Frequent',
      'skill.closed': 'Off',
      'skill.model': 'Model',
      'skill.user': '/name invocable',
      'skill.modelSwitchAria': 'Model invocable: {name}',
      'skill.userSwitchAria': '/name invocable: {name}',
      'skill.menuAria': 'More actions: {name}',
      'skill.menu.update': 'Update',
      'skill.menu.remove': 'Delete',
      'skill.menu.showPath': 'Show path',
      'skill.menu.hidePath': 'Hide path',
      'skill.path': 'Path',
      'skill.empty.title': 'No skills to manage yet',
      'skill.empty.body': 'Install one from Discover, or drop a SKILL.md into your skill folder.',
      'skill.emptyFiltered': 'This agent resolves no skills.',
      'skill.loading': 'Reading the skill catalog…',
      'skill.removeConfirm': 'Delete “{name}”? Its skill folder is removed and this cannot be undone.',
      'skill.removeConfirmAction': 'Delete',
      'skill.busy': 'Saving…',
      'discover.source': 'Skill source',
      'discover.placeholder': 'Skill name or repo, then Enter',
      'discover.searchLabel': 'Search skills',
      'discover.idle.title': 'Start with a source',
      'discover.idle.body': 'Search skills.sh or the Tencent source, then install into your skill folder in one click.',
      'discover.loading': 'Searching…',
      'discover.empty.title': 'No matching skills',
      'discover.empty.body': 'Try another keyword, or switch to the other source.',
      'discover.error.title': 'This source is unavailable',
      'discover.error.hint': 'Switch to the other source, or retry later.',
      'discover.otherSource': 'Try {source}',
      'discover.install': 'Install',
      'discover.installAria': 'Install: {name}',
      'discover.installBlockedAria': 'Cannot install {name}: {reason}',
      'discover.notInstallable': 'This entry cannot be installed from this source',
      'discover.installing': 'Installing…',
      'discover.installed': 'Installed',
      'discover.version': 'v{version}',
      'discover.updated': 'Updated {date}',
      'discover.installs': '{count} installs',
      'discover.note.suggestions': 'Empty search fell back to a popular listing',
      'usage.total': 'Total calls',
      'usage.active': 'Active skills',
      'usage.today': 'Calls today',
      'usage.totalHint': 'Across all agents',
      'usage.split': '{model} by model · {user} manual',
      'usage.activeHint': 'Used at least once',
      'usage.todayHint': '{count} in the last 14 days',
      'usage.chart': 'Call trend',
      'usage.dayTitle': '{date} · {count} calls',
      'usage.recent': 'Recent activity',
      'usage.recentEmpty': 'No calls recorded yet.',
      'usage.note': 'Only calls observed while the dashboard is enabled are recorded. Daily history is kept for 60 days; cumulative counts are independent of the period.',
      'usage.unknownAgent': 'Unknown agent',
      'status.updatedAt': 'Updated {time}',
      'status.counts': '{skills} skills · {agents} agents',
      'status.saved': 'Saved',
      'status.removed': 'Deleted {name}',
      'status.installed': 'Installed {name}',
      'status.updatedSkill': 'Updated {name}',
      'status.upToDate': '{name} is up to date',
      'status.busy': 'Working…',
      'status.failed': '{action} failed: {message}',
      'status.failedPlain': 'The action failed',
      'status.offlineInline': 'Host unreachable; the change is unconfirmed.',
      'offline.title': 'Cannot reach the skill dashboard host',
      'offline.body': 'The plugin route did not answer. Make sure the host loaded this plugin, then retry.',
      'crash.title': 'The skill dashboard failed to render',
      'crash.body': 'Reloading the page re-mounts the plugin; check the browser console if it keeps failing.',
      'error.read-only': 'Read-only skill; it cannot be changed',
      'error.source-unavailable': 'The source is temporarily unavailable',
      'error.invalid-response': 'The host returned data this page cannot read',
      'panel.eyebrow': 'SKILLS / WORKSPACE',
      'panel.intro': 'Manage skills, invocation, and activity.',
      'overview.skills': 'Skill library',
      'overview.enabled': 'Model enabled',
      'overview.agents': 'Coding agents',
      'overview.calls': 'Total calls',
      'installed.title': 'Installed skills',
      'installed.body': 'Find and filter skills, then manage invocation permissions.',
      'installed.search': 'Search installed skills',
      'installed.placeholder': 'Search by name, description, or source…',
      'installed.results': 'Showing {count} of {total} skills',
      'installed.noMatches': 'No skills match your filters',
      'installed.noMatchesBody': 'Try another keyword, or clear your filters.',
      'installed.reset': 'Clear filters',
      'installed.status': 'Invocation status',
      'installed.all': 'All statuses',
      'installed.enabled': 'Model enabled',
      'installed.disabled': 'Model disabled',
      'installed.writable': 'Manageable',
      'installed.sort': 'Sort by',
      'installed.sort.usage': 'Most used',
      'installed.sort.name': 'Name A–Z',
      'installed.sort.recent': 'Recently used',
      'installed.permissions': 'Invocation permissions',
      'installed.hint': 'Model invocation lets an agent choose a skill automatically. Manual invocation uses /skill-name. Changes to shared skills affect every associated agent.',
      'discover.title': 'Discover skills',
      'discover.body': 'Find community skills to extend what your agents can do.',
      'discover.popular': 'Browse popular skills',
      'discover.results': '{count} search results',
      'discover.queryScope': '{source} · Search for “{query}”',
      'discover.unavailableTitle': 'No sources available',
      'discover.unavailableBody': 'Refresh the dashboard to check the sources again.',
      'usage.title': 'Usage overview',
      'usage.body': 'Call trends and recent activity across all agents.',
      'usage.breakdown': 'Daily call details',
      'usage.date': 'Date',
      'usage.count': 'Calls',
      'status.ready': 'Catalog synced',
      'action.discover': 'Discover skills',
      'action.backLibrary': 'Back to library',
      'source.tencent': 'Tencent SkillHub',
      'action.skipContent': 'Skip to main content',
      'usage.chartSummary': '{count} calls in the last 14 days, with a daily peak of {peak}. Expand the daily details below.',
    };

    // ---------------------------------------------------------------- css
    /**
     * Scoped semantic colours follow the host theme. Container queries respond to the
     * panel width even when the surrounding app changes its sidebar layout. The skd-
     * prefix prevents collisions with host styles.
     */
    const CSS = `
.skd-page{--skd-bg:var(--dsw-alias-bg-base,#fff);--skd-fg:var(--dsw-alias-label-primary,#20252d);--skd-muted:color-mix(in srgb,var(--skd-fg) 70%,var(--skd-bg));--skd-soft:color-mix(in srgb,var(--skd-fg) 4%,var(--skd-bg));--skd-line:color-mix(in srgb,var(--skd-fg) 13%,var(--skd-bg));--skd-control-line:color-mix(in srgb,var(--skd-fg) 16%,var(--skd-bg));--skd-accent:var(--dsw-alias-state-business-primary,#416fe1);--skd-accent-label:color-mix(in srgb,var(--skd-accent) 70%,var(--skd-fg));--skd-on-accent:var(--dsw-alias-label-primary-foreground,#fff);--skd-radius:12px;box-sizing:border-box;container:dashboard / inline-size;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;color:var(--skd-fg);background:var(--skd-bg);font-family:"IBM Plex Sans","Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:0.875rem;line-height:1.6;overflow:hidden;font-variant-numeric:tabular-nums}
.skd-page *{box-sizing:border-box}
.skd-wrap{width:100%;max-width:1280px;margin:0 auto;padding-inline:clamp(20px,4cqw,56px)}
.skd-top{flex:none;border-bottom:1px solid var(--skd-line);background:var(--skd-bg)}
.skd-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:24px;padding-top:32px;padding-bottom:24px}
[data-platform=darwin] .skd-header{padding-top:calc(32px + var(--dsh-frame-top-clearance,0px))}
.skd-headText{min-width:0;flex:1}
.skd-eyebrow{display:block;margin-bottom:8px;font-size:0.6875rem;line-height:1.636;font-weight:600;letter-spacing:.12em;color:var(--skd-muted)}
.skd-title{margin:0;font-size:1.875rem;font-weight:650;line-height:1.25;letter-spacing:-.035em;text-wrap:balance}
.skd-subtitle{margin:8px 0 0;color:var(--skd-muted);font-size:0.875rem;line-height:1.571;overflow-wrap:anywhere;text-wrap:balance;max-width:60ch}
.skd-headerTools{display:flex;align-items:center;gap:10px;flex:none}
.skd-tabbar{display:flex;flex-wrap:wrap;align-items:stretch;column-gap:1.75rem;row-gap:0;min-height:48px}
.skd-tab{position:relative;display:inline-flex;align-items:center;gap:8px;padding:0 2px 14px;border:0;background:none;color:var(--skd-muted);font:inherit;font-size:0.875rem;font-weight:500;cursor:pointer;transition:color .15s}
.skd-tab:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:transparent}
.skd-tab[aria-selected=true]{color:var(--skd-accent);font-weight:600}
.skd-tab[aria-selected=true]:after{background:var(--skd-accent)}
.skd-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.skd-content{padding-top:28px;padding-bottom:48px}
.skd-panel{display:flex;flex-direction:column;gap:20px;min-width:0}
.skd-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-bottom:32px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);background:var(--skd-soft);overflow:hidden}
.skd-overviewItem{display:flex;flex-direction:column;gap:4px;padding:18px 24px;border-inline-end:1px solid var(--skd-line)}
.skd-overviewItem:last-child{border:0}
.skd-overviewLabel{font-size:0.75rem;color:var(--skd-muted)}
.skd-overviewValue{font-size:1.625rem;line-height:1.308;font-weight:600;letter-spacing:-.03em}
.skd-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:20px}
.skd-sectionTitle{margin:0;font-size:1.25rem;font-weight:600;line-height:1.4;letter-spacing:-.025em;text-wrap:balance}
.skd-sectionBody{margin:5px 0 0;color:var(--skd-muted);font-size:0.8125rem;line-height:1.615;max-width:72ch;text-wrap:pretty}
.skd-toolbar{display:flex;flex-direction:column;gap:14px;padding:16px;background:var(--skd-soft);border:1px solid var(--skd-line);border-radius:var(--skd-radius)}
.skd-field{display:flex;align-items:center;gap:8px;min-width:0;color:var(--skd-muted);font-size:0.75rem}
.skd-field>span{flex-shrink:0;white-space:normal;overflow-wrap:anywhere}
.skd-select{max-width:100%;min-width:120px;min-height:36px;padding:6px 30px 6px 10px;border:1px solid var(--skd-control-line);border-radius:7px;background:var(--skd-bg);color:var(--skd-fg);font:inherit;font-size:0.8125rem;cursor:pointer}
.skd-searchBox{position:relative;display:flex;align-items:center;flex:1;min-width:160px;gap:8px}
.skd-searchBox>svg{position:absolute;left:12px;pointer-events:none;color:var(--skd-muted)}
.skd-searchBox .skd-input{padding-left:38px;width:100%}
.skd-resultLine{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--skd-muted);font-size:0.75rem;min-height:24px}
.skd-tableHeading{display:grid;grid-template-columns:minmax(0,1fr) 3.5rem 10.5rem 2.25rem;gap:0 20px;padding:0 17px 7px;margin-bottom:0;color:var(--muted-foreground);font-size:.6875rem;letter-spacing:.02em;border-bottom:0}
.skd-tableHeading span:nth-child(2){text-align:right}
.skd-footer{flex:none;border-top:1px solid var(--skd-line);background:var(--skd-bg)}
.skd-footerInner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:40px;font-size:0.6875rem;line-height:1.636;color:var(--skd-muted)}
.skd-footerStats,.skd-footerNote{display:flex;align-items:center;gap:.75rem;min-width:0;flex-wrap:wrap;overflow-wrap:anywhere}
.skd-footerNote{gap:0;text-align:right;justify-content:flex-end}
.skd-footerNote[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.skd-footerNote[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.skd-statusDot{flex:none;width:6px;height:6px;border-radius:50%;margin-right:8px;background:var(--skd-muted)}
.skd-statusDot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}
.skd-statusDot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
.skd-micro{font-size:0.6875rem;line-height:1.636;color:var(--skd-muted);font-weight:500}
.skd-iconButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;padding:0;border:1px solid transparent;border-radius:8px;background:none;color:var(--skd-muted);cursor:pointer;transition:background-color .15s,color .15s}
.skd-headerTools .skd-iconButton{border-color:var(--skd-line);width:40px;height:40px}
.skd-iconButton[data-open]{background:var(--skd-soft);color:var(--skd-fg)}
.skd-iconButton:disabled{opacity:.45;cursor:default}
.skd-iconButton[data-spinning] svg{animation:skd-spin .9s linear infinite}
@keyframes skd-spin{to{transform:rotate(360deg)}}
.skd-segmented{display:inline-flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--skd-line);border-radius:9px;background:var(--skd-soft);max-width:100%;overflow-x:auto}
.skd-segment{flex:none;max-width:176px;min-height:34px;padding:5px 14px;border:1px solid transparent;border-radius:6px;background:none;color:var(--skd-muted);font:inherit;font-size:0.8125rem;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background-color .15s,color .15s}
.skd-segment[data-active]{border-color:var(--skd-line);background:var(--skd-bg);color:var(--skd-fg);font-weight:600}
.skd-segment:disabled{opacity:.45;cursor:default}
.skd-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;min-height:36px;padding:7px 14px;border:1px solid var(--input);border-radius:8px;background:var(--skd-bg);color:var(--skd-fg);font:inherit;font-size:0.8125rem;font-weight:500;line-height:1.538;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s,transform .1s}
.skd-button:active:not(:disabled),.skd-iconButton:active:not(:disabled){transform:translateY(1px)}
.skd-button:disabled{opacity:.5;cursor:default}
.skd-button[data-variant=primary]{border-color:transparent;background:var(--skd-accent);color:var(--skd-on-accent)}
.skd-button[data-variant=danger]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
.skd-button[data-variant=text]{padding:2px 4px;border-color:transparent;background:none;color:var(--skd-accent)}
.skd-button[data-done]{border-color:transparent;background:var(--skd-soft);color:var(--skd-muted)}
.skd-input{flex:1;min-width:0;min-height:40px;padding:9px 12px;border:1px solid var(--skd-line);border-radius:8px;background:var(--skd-bg);color:var(--skd-fg);font:inherit;font-size:0.8125rem;line-height:1.538;transition:border-color .15s}
.skd-input:focus{border-color:var(--skd-accent)}
.skd-input::placeholder{color:var(--skd-muted)}
.skd-searchRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:16px;background:var(--skd-soft);border:1px solid var(--skd-line);border-radius:var(--skd-radius)}
.skd-searchRow>.skd-input{min-width:160px}
.skd-searchRow>.skd-button{min-height:40px}
.skd-list{margin:0;padding:0;list-style:none;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--card)}
.skd-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 3.5rem 10.5rem 2.25rem;gap:4px 20px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--skd-line);transition:background-color .15s}
.skd-list>li:last-child .skd-row{border-bottom:0}
.skd-row[data-busy]{opacity:.72}
.skd-rowMain{display:flex;flex-direction:column;gap:3px;min-width:0}
.skd-rowHead{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
.skd-rowName{min-width:0;max-width:100%;font-size:0.875rem;font-weight:600;line-height:1.571;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.skd-badge{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-height:20px;padding:1px 6px;border-radius:4px;background:var(--skd-soft);color:var(--skd-muted);font-size:0.6875rem;line-height:1.636;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skd-badge[data-tone=accent]{background:color-mix(in srgb,var(--skd-accent) 10%,var(--skd-bg));color:var(--skd-accent-label)}
.skd-badge[data-tone=muted]{border:1px solid var(--skd-line);background:none;color:var(--skd-muted)}
.skd-rowDesc{margin:0;max-width:96ch;color:var(--muted-foreground);font-size:.78125rem;line-height:1.55;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:1;line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.skd-rowRail{display:grid;grid-template-columns:subgrid;grid-column:2 / -1;align-items:center}
.skd-metric{display:flex;flex-direction:column;align-items:flex-end;gap:2px;width:auto;text-align:end}
.skd-metric .skd-micro{display:none}
.skd-metricValue{font-size:.9375rem;line-height:1.5;font-weight:550}
.skd-switchGroup{display:flex;flex-direction:column;gap:2px;width:auto;border:0;padding:0}
.skd-switchRow{display:flex;align-items:center;min-width:0}
.skd-switchControl{position:relative;display:grid;grid-template-columns:1fr auto;align-items:center;column-gap:10px;min-block-size:1.5rem;width:100%;cursor:pointer}
.skd-switchControl:has(:disabled){cursor:default;opacity:.6}
.skd-switchLabel{color:var(--skd-muted);font-size:0.6875rem;line-height:1.5;overflow-wrap:anywhere}
.skd-switchInput{position:absolute;clip-path:inset(50%);overflow:hidden;inline-size:1px;block-size:1px;margin:-1px;padding:0;border:0;white-space:nowrap;accent-color:var(--skd-accent)}
.skd-switch{position:relative;flex:none;inline-size:2rem;block-size:1.125rem;border:1px solid var(--skd-control-line);border-radius:1rem;background:color-mix(in srgb,var(--skd-fg) 22%,var(--skd-bg));transition:background-color .16s}
.skd-switchThumb{position:absolute;inset-block-start:2px;inset-inline-start:2px;inline-size:.875rem;block-size:.875rem;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .16s}
.skd-switchInput:checked~.skd-switch{border-color:var(--skd-accent);background:var(--skd-accent)}
.skd-switchInput:checked~.skd-switch .skd-switchThumb{transform:translateX(.875rem)}
.skd-switchControl:has(.skd-switchInput:focus-visible) .skd-switch{outline:2px solid var(--skd-accent);outline-offset:3px}
.skd-menuWrap{position:relative;flex:none}
.skd-menu{position:fixed;inset:auto;margin:0;z-index:20;min-inline-size:10.5rem;max-inline-size:calc(100vw - 1rem);max-block-size:calc(100dvh - 1rem);overflow:auto;padding:6px;border:1px solid var(--skd-control-line);border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--skd-bg));color:var(--skd-fg);font:inherit;box-shadow:0 8px 32px color-mix(in srgb,var(--skd-fg) 12%,transparent)}
.skd-menu[hidden]{display:none}
.skd-menu[popover]:not(:popover-open){display:none}
.skd-menuGroup{display:flex;flex-direction:column;gap:2px}
.skd-page .skd-menu[data-position-fallback]{position-area:none;left:var(--skd-menu-left);top:var(--skd-menu-top);margin:0}
@supports(position-area:block-end){.skd-menu[popover]{position-area:block-end span-inline-start;position-try-fallbacks:flip-block,flip-inline,flip-block flip-inline;margin-block:6px}}
@supports not (position-area:block-end){.skd-menu[popover]{left:var(--skd-menu-left);top:var(--skd-menu-top)}}
.skd-menuItem{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:8px 10px;border:0;border-radius:5px;background:none;color:var(--skd-fg);font:inherit;font-size:0.8125rem;line-height:1.538;text-align:left;white-space:nowrap;cursor:pointer}
.skd-menuItem:disabled{opacity:.45;cursor:default}
.skd-menuItem[data-danger]{color:var(--dsw-alias-state-error-primary)}
.skd-confirm{grid-column:1 / -1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger)}
.skd-confirmText{flex:1;min-width:160px;font-size:0.8125rem;line-height:1.615}
.skd-path{grid-column:1 / -1;display:flex;align-items:baseline;gap:10px;min-width:0;padding:12px;border-radius:6px;background:var(--skd-soft)}
.skd-pathValue{min-width:0;color:var(--skd-muted);font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:0.75rem;line-height:1.667;overflow-wrap:anywhere}
.skd-empty,.skd-state{display:flex;flex-direction:column;gap:8px;align-items:center;padding:56px 24px;text-align:center;border:1px dashed var(--skd-line);border-radius:var(--skd-radius);background:var(--skd-soft)}
.skd-stateTitle{margin:0;font-size:1rem;font-weight:600;line-height:1.5}
.skd-stateBody{margin:0;max-width:52ch;color:var(--skd-muted);font-size:0.8125rem;line-height:1.692;overflow-wrap:anywhere}
.skd-stateActions{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;justify-content:center}
.skd-stateIcon{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--skd-line);border-radius:12px;margin-bottom:10px;color:var(--skd-accent);background:var(--skd-bg)}
.skd-skeleton{display:flex;flex-direction:column;gap:10px;padding:16px 0;width:min(360px,80%)}
.skd-skeletonRow{height:14px;border-radius:5px;background:var(--dsw-alias-bg-skeleton,var(--skd-line));animation:skd-pulse 1.4s ease-in-out infinite}
.skd-skeletonRow:nth-child(2n){width:72%}
@keyframes skd-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.skd-cardList{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:0;padding:0}
.skd-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:22px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);transition:border-color .15s,background-color .15s}
.skd-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.skd-cardTitleWrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;flex:1}
.skd-cardName{margin:0;font-size:0.9375rem;font-weight:600;line-height:1.6;overflow-wrap:anywhere}
.skd-cardDesc{margin:0;color:var(--skd-muted);font-size:0.8125rem;line-height:1.692;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.skd-cardFoot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:auto;padding-top:16px;border-top:1px solid var(--skd-line)}
.skd-metaList{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.skd-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.skd-statCard{display:flex;flex-direction:column;gap:10px;padding:24px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);background:var(--skd-soft)}
.skd-statValue{font-size:2.25rem;line-height:1.222;font-weight:600;letter-spacing:-.04em}
.skd-statHint{color:var(--skd-muted);font-size:0.75rem;line-height:1.667}
.skd-panelCard{margin:0;min-width:0;padding:24px;border:1px solid var(--skd-line);border-radius:var(--skd-radius)}
.skd-cardTitleRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.skd-cardTitleRow .skd-micro{margin:0;font-size:0.875rem;font-weight:600;color:var(--skd-fg)}
.skd-chart{display:flex;align-items:flex-end;gap:8px;height:200px;padding:12px 4px 0;border-bottom:1px solid var(--skd-line);background:repeating-linear-gradient(to top,transparent 0,transparent calc(25% - 1px),var(--skd-line) calc(25% - 1px),var(--skd-line) 25%)}
.skd-chartCol{position:relative;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;flex:1;min-width:0;height:100%;outline-offset:3px}
.skd-bar{width:100%;max-width:48px;border-radius:4px 4px 0 0;background:color-mix(in srgb,var(--skd-accent) 72%,var(--skd-bg));transition:background-color .15s}
.skd-chartCol:hover .skd-bar,.skd-chartCol:focus-visible .skd-bar{background:var(--skd-accent)}
.skd-chartCol:after{content:attr(data-count);position:absolute;bottom:100%;font-size:0.6875rem;color:var(--skd-muted);opacity:0}
.skd-chartCol:hover:after,.skd-chartCol:focus-visible:after{opacity:1}
.skd-bar[data-empty]{background:var(--skd-line)}
.skd-slug{min-width:0;max-width:100%;color:var(--skd-muted);font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:0.6875rem;line-height:1.636;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-chartAxis{display:flex;justify-content:space-between;margin-top:10px;color:var(--skd-muted);font-size:0.6875rem;line-height:1.636}
.skd-chartDetails{margin-top:16px;color:var(--skd-muted);font-size:0.75rem}
.skd-chartDetails summary{cursor:pointer;min-height:32px;padding:6px 0}
.skd-chartDetails table{width:100%;border-collapse:collapse;text-align:left}
.skd-chartDetails td,.skd-chartDetails th{padding:6px 10px;border-bottom:1px solid var(--skd-line)}
.skd-activity{display:flex;flex-direction:column;margin:0;padding:0}
.skd-activityRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid var(--skd-line)}
.skd-activityRow:last-child{border-bottom:0}
.skd-activityMain{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
.skd-activityName{min-width:0;color:var(--skd-fg);font-size:0.8125rem;font-weight:500;line-height:1.538;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.skd-activityTime{flex:none;color:var(--skd-muted);font-size:0.75rem;line-height:1.5}
.skd-noteLine{margin:0;max-width:92ch;color:var(--skd-muted);font-size:0.75rem;line-height:1.75;overflow-wrap:anywhere}
.skd-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0 0;padding:12px 16px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:0.8125rem;line-height:1.538}
.skd-offline{display:flex;flex-direction:column;align-items:center;gap:12px;padding-block:72px;text-align:center}
.skd-offlineTitle{margin:0;font-size:1.25rem;font-weight:600;line-height:1.4}
.skd-offlineBody{margin:0;max-width:52ch;color:var(--skd-muted);font-size:0.875rem;line-height:1.571}
.skd-page :focus-visible{outline:2px solid var(--skd-accent);outline-offset:3px}
.skd-page .skd-input:focus-visible,.skd-page .skd-select:focus-visible{outline-offset:1px}
.skd-page .skd-menuItem:focus-visible{outline-offset:-2px}
@media (hover:hover){.skd-tab:hover,.skd-segment:not(:disabled):hover{color:var(--skd-fg)}.skd-row:hover,.skd-menuItem:not(:disabled):hover,.skd-iconButton:not(:disabled):hover,.skd-button:not(:disabled):hover{background:var(--skd-soft)}.skd-button[data-variant=primary]:not(:disabled):hover{background:color-mix(in srgb,var(--skd-accent) 88%,var(--skd-fg))}.skd-card:hover{border-color:color-mix(in srgb,var(--skd-fg) 30%,var(--skd-bg))}.skd-input:hover,.skd-select:hover{border-color:var(--skd-muted)}}
@container dashboard (max-width:800px){.skd-wrap{padding-inline:24px}.skd-row{padding-inline:8px;gap:16px}.skd-rowRail{gap:12px}.skd-tableHeading{padding-inline:8px;gap:12px}.skd-overviewItem{padding:16px}.skd-cardList{grid-template-columns:minmax(0,1fr)}.skd-header{align-items:flex-start}.skd-headerTools .skd-button{padding-inline:10px}}
@container dashboard (max-width:600px){.skd-wrap{padding-inline:18px}.skd-header{gap:16px;padding-top:24px;padding-bottom:20px;flex-wrap:wrap}.skd-title{font-size:1.625rem}.skd-headerTools{width:100%;justify-content:space-between}.skd-subtitle{font-size:0.8125rem}.skd-tabbar{gap:24px}.skd-content{padding-top:20px}.skd-overview{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:24px}.skd-overviewItem:nth-child(2){border-inline-end:0}.skd-overviewItem:nth-child(-n+2){border-bottom:1px solid var(--skd-line)}.skd-overviewValue{font-size:1.5rem}.skd-sectionTitle{font-size:1.125rem}.skd-sectionHead{align-items:flex-start}.skd-tableHeading{display:none}.skd-row{grid-template-columns:minmax(0,1fr);padding:18px 0}.skd-rowRail{justify-content:space-between;width:100%}.skd-metric{width:auto;align-items:flex-start}.skd-metric .skd-micro{display:block}.skd-switchGroup{width:auto;flex:1;max-width:220px;border:0;padding:0;gap:8px}.skd-switchRow{min-height:36px}.skd-iconButton{width:44px;height:44px}.skd-input,.skd-button,.skd-select,.skd-segment{min-height:44px}.skd-select{min-width:0;width:100%}.skd-searchRow>.skd-segmented{width:100%}.skd-searchRow .skd-segment{flex:1;max-width:none}.skd-toolbar{padding:12px}.skd-stats{grid-template-columns:minmax(0,1fr);gap:12px}.skd-statCard{display:grid;grid-template-columns:1fr auto;gap:4px;padding:18px}.skd-statValue{grid-column:2;grid-row:1 / 3;font-size:1.875rem}.skd-panelCard,.skd-card{padding:18px}.skd-chart{gap:5px;height:160px}.skd-footerNote{max-width:65%}.skd-activityRow{align-items:flex-start}.skd-activityTime{font-size:0.6875rem}.skd-panel{gap:16px}.skd-menuItem{min-height:44px}}
@container dashboard (max-width:600px){.skd-header{flex-wrap:nowrap;padding-top:20px;gap:12px}.skd-eyebrow{font-size:0.625rem;margin-bottom:6px}.skd-headerTools{width:auto;align-items:flex-start;gap:8px}.skd-headerTools .skd-buttonLabel{display:none}.skd-headerTools .skd-button{width:44px;padding:0}.skd-headerTools .skd-iconButton{width:44px;height:44px}.skd-overviewItem{flex-direction:row;align-items:center;justify-content:space-between;gap:8px;padding:12px}.skd-overviewLabel{font-size:0.6875rem}.skd-overviewValue{font-size:1.375rem;line-height:1.364}}
@media (prefers-reduced-motion:reduce){.skd-page *,.skd-page *:before,.skd-page *:after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}

.skd-visuallyHidden{position:absolute;clip-path:inset(50%);overflow:hidden;width:1px;height:1px;margin:-1px;padding:0;border:0;white-space:nowrap}
.skd-skipLink{position:absolute;inset-block-start:8px;inset-inline-start:8px;z-index:30;padding:.625rem 1rem;background:var(--skd-bg);color:var(--skd-fg);border:2px solid var(--skd-accent);border-radius:8px;transform:translateY(-200%)}
.skd-skipLink:focus{transform:none}
.skd-searchField{display:flex;flex-direction:column;gap:.375rem;flex:1;min-inline-size:min(100%,12rem)}
.skd-fieldLabel{font-size:.75rem;color:var(--skd-muted);line-height:1.5}
.skd-field{flex-direction:column;align-items:stretch;gap:.375rem}
.skd-searchRow{align-items:flex-end}
.skd-chartSummary{margin-block-end:1rem}
.skd-rowName,.skd-cardName{overflow-wrap:anywhere;white-space:normal}
.skd-menuItem{font-size:.8125rem;white-space:normal;overflow-wrap:anywhere}
.skd-confirmText{min-inline-size:min(100%,12rem)}
@container dashboard (max-width:600px){.skd-header{flex-wrap:wrap}.skd-headText{flex-basis:100%}.skd-headerTools{margin-inline-start:auto}.skd-headerTools .skd-buttonLabel{display:inline}.skd-headerTools .skd-button{width:auto;padding-inline:12px}.skd-searchRow>.skd-searchField{flex-basis:100%}.skd-searchRow>.skd-segmented{width:100%}.skd-searchRow .skd-segment{flex:1;max-width:none}.skd-switchControl{min-height:3rem}.skd-input,.skd-select,.skd-button,.skd-segment,.skd-menuItem,.skd-iconButton{min-block-size:3rem}.skd-input,.skd-select{font-size:max(1rem,1em)}.skd-overviewItem{flex-wrap:wrap}.skd-overviewLabel{overflow-wrap:anywhere}}
@media(pointer:coarse){.skd-switchControl{min-block-size:3rem}.skd-button,.skd-select,.skd-input,.skd-iconButton,.skd-segment,.skd-menuItem{min-block-size:3rem;min-inline-size:3rem}.skd-input,.skd-select{font-size:max(1rem,1em)}}
@media(max-height:35rem){.skd-page{display:block;overflow:auto}.skd-scroll{overflow:visible}.skd-top,.skd-footer{position:static}.skd-header{padding-block:16px}.skd-content{padding-block:20px}.skd-overview{margin-block-end:20px}}
@media(forced-colors:active){.skd-page{--skd-bg:Canvas;--skd-fg:CanvasText;--skd-muted:CanvasText;--skd-soft:Canvas;--skd-line:ButtonText;--skd-control-line:ButtonText;--skd-accent:Highlight;--skd-accent-label:Highlight;--skd-on-accent:HighlightText}.skd-button[data-variant=primary]{background:ButtonFace;color:ButtonText;border-color:ButtonText}.skd-button[data-variant=primary] .skd-buttonLabel{color:ButtonText;background:ButtonFace}.skd-switch{border:1px solid ButtonText;background:Canvas}.skd-switchThumb{forced-color-adjust:none;background:ButtonText}.skd-switchInput:checked~.skd-switch{background:Canvas;border-color:Highlight}.skd-switchInput:checked~.skd-switch .skd-switchThumb{background:Highlight}.skd-tab[aria-selected=true]{border-block-end:2px solid Highlight}.skd-tab:after{display:none}.skd-menu{background:Canvas;color:CanvasText;box-shadow:none}.skd-switchControl:has(:disabled){color:GrayText}.skd-bar{forced-color-adjust:none;background:Highlight}.skd-bar[data-empty]{background:GrayText}.skd-statusDot{forced-color-adjust:none;background:CanvasText}}
/* Source-owned, shadcn-style semantic layer; values are inherited from DSH. */
.skd-page{--background:var(--skd-bg);--foreground:var(--skd-fg);--card:var(--background);--card-foreground:var(--foreground);--muted:var(--skd-soft);--muted-foreground:var(--skd-muted);--primary:var(--foreground);--primary-foreground:var(--background);--border:var(--skd-line);--input:color-mix(in srgb,var(--skd-fg) 50%,var(--skd-bg));--ring:var(--skd-accent);font-family:var(--dsw-font-family,system-ui,"Segoe UI","Microsoft YaHei",sans-serif);color-scheme:inherit}
.skd-wrap{max-width:1680px;padding-inline:clamp(24px,2.6cqw,44px)}
.skd-top{border-bottom:1px solid var(--border)}
.skd-header{padding-top:20px;padding-bottom:14px;gap:16px}
.skd-headText{display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:12px}
.skd-pageMark{display:grid;place-items:center;grid-row:1 / 3;inline-size:34px;block-size:34px;border:1px solid var(--border);border-radius:10px;background:var(--muted);color:var(--foreground)}
.skd-title{font-size:1.3125rem;letter-spacing:-.03em;font-weight:600;line-height:1.35}
.skd-subtitle{font-size:.8125rem;line-height:1.5;margin-top:3px;max-width:70ch;text-wrap:pretty}
.skd-headerTools{gap:8px}
.skd-button{border-radius:7px;min-height:36px;font-size:.8125rem;font-weight:500;box-shadow:0 1px 2px color-mix(in srgb,var(--foreground) 4%,transparent)}
.skd-button[data-variant=primary]{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.skd-button[data-variant=text]{box-shadow:none}
.skd-button svg{pointer-events:none;flex-shrink:0}
.skd-iconButton{border-radius:7px}
.skd-headerTools .skd-iconButton{width:36px;height:36px;background:var(--background)}
.skd-tabbar{gap:4px;padding:4px;background:var(--muted);width:fit-content;max-width:100%;border-radius:8px;min-height:0;margin-bottom:18px}
.skd-tab{gap:7px;min-height:32px;padding:5px 13px;border-radius:5px;font-size:.8125rem;color:var(--muted-foreground)}
.skd-tab:after{display:none}
.skd-tab[aria-selected=true]{background:var(--background);color:var(--foreground);font-weight:500;box-shadow:0 1px 3px color-mix(in srgb,var(--foreground) 10%,transparent)}
.skd-tabIcon{display:flex;align-items:center;opacity:.85}
.skd-content{padding-top:20px}
.skd-panel{gap:14px}
.skd-sectionHead{align-items:baseline;gap:16px}
.skd-sectionTitle{font-size:.9375rem;line-height:1.5;letter-spacing:-.015em;font-weight:600}
.skd-sectionBody{font-size:.75rem;line-height:1.6;margin-top:2px;max-width:96ch}
.skd-overview{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 28px;background:none;border:0;border-radius:0;margin:0 0 18px;padding:0 0 14px;border-bottom:1px solid var(--border);overflow:visible}
.skd-overviewItem{flex:0 0 auto;flex-direction:row;align-items:baseline;gap:7px;padding:0;border:0}
.skd-overviewLabel{font-size:.75rem;color:var(--muted-foreground)}
.skd-overviewValue{font-size:1.0625rem;line-height:1.35;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.skd-toolbar{padding:16px;border-radius:10px;background:var(--background);gap:12px}
.skd-input,.skd-select{border-color:var(--input);border-radius:8px;min-height:36px;background:var(--background);box-shadow:none;font-size:.8125rem;transition:border-color .15s,background-color .15s}
.skd-input{padding-block:7px}
.skd-fieldLabel,.skd-field{font-size:.75rem}
.skd-searchRow{padding:0;border:0;background:none;gap:12px;align-items:flex-end}
.skd-searchRow>.skd-button{min-height:36px;padding-inline:18px}
.skd-sourceField{display:flex;flex-direction:column;gap:6px;min-width:0}
.skd-segmented{border:0;padding:3px;background:var(--muted);border-radius:7px;gap:2px}
.skd-segment{min-height:30px;padding:4px 12px;border-radius:4px;font-size:.75rem}
.skd-segment[data-active]{border-color:transparent;box-shadow:0 1px 3px color-mix(in srgb,var(--foreground) 10%,transparent);font-weight:500}
.skd-resultLine{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-block:0;color:var(--muted-foreground);font-size:.75rem;flex:none;min-height:0}
.skd-cardList{gap:18px}
.skd-card{border-radius:11px;padding:20px;gap:13px;background:var(--card);color:var(--card-foreground);box-shadow:0 1px 2px color-mix(in srgb,var(--foreground) 3%,transparent)}
.skd-cardHead{gap:10px;align-items:flex-start;flex-wrap:nowrap}
.skd-cardIdentity{display:flex;gap:12px;align-items:center;min-width:0;flex:1}
.skd-skillMark{display:grid;place-items:center;flex:none;inline-size:36px;block-size:36px;border:1px solid var(--border);border-radius:8px;background:var(--muted);color:var(--muted-foreground)}
.skd-cardTitleWrap{display:block;min-width:0}
.skd-cardName{font-size:.875rem;line-height:1.6;font-weight:600;letter-spacing:-.015em;margin:0}
.skd-cardName .skd-nameButton{display:-webkit-box;max-inline-size:100%;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:clip}
.skd-cardVersion{flex:none;padding-top:3px;color:var(--muted-foreground);font-size:.6875rem}
.skd-cardDesc{font-size:.8125rem;line-height:1.8;-webkit-line-clamp:3;line-clamp:3;color:var(--muted-foreground)}
.skd-cardFoot{padding-top:13px;gap:12px;border-top:1px solid var(--border)}
.skd-cardFoot .skd-button{min-height:32px;font-size:.75rem;padding:5px 11px}
.skd-cardFoot .skd-metaList{gap:4px}
.skd-cardDownloads{font-size:.6875rem;color:var(--muted-foreground)}
.skd-slug{font-family:inherit;font-size:.6875rem;opacity:.9}
.skd-badge{min-height:18px;padding:1px 7px;border-radius:999px;background:var(--muted);color:var(--muted-foreground);font-size:.6875rem;line-height:1.6;letter-spacing:.01em}
.skd-badge[data-tone=accent]{background:color-mix(in srgb,var(--skd-accent) 12%,var(--background));color:var(--skd-accent-label)}
.skd-badge[data-tone=muted]{background:none}
.skd-rowDesc{font-size:.8125rem;line-height:1.75}
.skd-statCard{background:var(--background);padding:20px;gap:6px;border-radius:10px;box-shadow:0 1px 2px color-mix(in srgb,var(--foreground) 3%,transparent)}
.skd-statValue{font-size:1.875rem;line-height:1.4;font-weight:550}
.skd-panelCard{border-radius:10px;padding:20px;background:var(--background)}
.skd-footerInner{min-height:34px;font-size:.6875rem}
.skd-statusDot{width:5px;height:5px}
.skd-empty,.skd-state{border:1px dashed var(--border);background:none;padding-block:48px}
/* One flat control bar, not a tinted form slab: the border does the grouping. */
.skd-filterBar{display:grid;grid-template-columns:minmax(12rem,1fr) auto auto auto;align-items:end;gap:10px 12px;padding:0 0 14px;border:0;border-bottom:1px solid var(--border);border-radius:0;background:none}
.skd-filterBar>.skd-field>.skd-select{inline-size:100%;min-inline-size:8.5rem;max-inline-size:16rem}
/* Customisable select: base-select paints the trigger and its top-layer picker in host tokens. */
@supports (appearance:base-select){
.skd-select,.skd-select::picker(select){appearance:base-select}
.skd-select{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-block-size:36px;padding:7px 10px 7px 12px;border:1px solid var(--input);border-radius:8px;background:var(--background);color:var(--foreground);font-size:.8125rem;line-height:1.45;white-space:nowrap;overflow:hidden;cursor:pointer;box-shadow:0 1px 1.5px color-mix(in srgb,var(--foreground) 4%,transparent)}
.skd-select::picker-icon{flex:none;margin-inline-start:4px;color:var(--muted-foreground);font-size:.625rem;transition:transform .18s cubic-bezier(.2,.8,.2,1)}
.skd-select:open::picker-icon{transform:rotate(180deg)}
.skd-select:hover{border-color:color-mix(in srgb,var(--foreground) 62%,var(--background));background:color-mix(in srgb,var(--foreground) 3%,var(--background))}
.skd-select:open{border-color:var(--ring);background:var(--background)}
.skd-page .skd-select:focus-visible{outline:2px solid var(--ring);outline-offset:1px;border-color:var(--ring)}
.skd-select::picker(select){margin-block-start:6px;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--background));color:var(--foreground);box-shadow:0 16px 40px -.75rem color-mix(in srgb,var(--foreground) 22%,transparent);min-inline-size:anchor-size(width);max-inline-size:min(30rem,calc(100vw - 2rem));max-block-size:min(20rem,48dvh);overflow:auto;overscroll-behavior:contain;opacity:0;translate:0 -4px;transition:opacity .16s ease,translate .16s ease,display .16s allow-discrete,overlay .16s allow-discrete}
.skd-select:open::picker(select){opacity:1;translate:0}
.skd-select option{padding:7px 10px;border-radius:7px;font-size:.8125rem;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skd-select option:hover,.skd-select option:focus{background:color-mix(in srgb,var(--foreground) 7%,var(--background))}
.skd-select option:checked{font-weight:600;background:color-mix(in srgb,var(--foreground) 6%,var(--background))}
.skd-select option::checkmark{color:var(--foreground)}
@media(prefers-reduced-motion:reduce){.skd-select::picker(select),.skd-select::picker-icon{transition:none}}
}
@starting-style{.skd-select:open::picker(select){opacity:0;translate:0 -4px}}
@media(forced-colors:active){.skd-select{border-color:ButtonText}.skd-select::picker(select){border-color:CanvasText;background:Canvas;color:CanvasText;box-shadow:none}.skd-select option:checked{forced-color-adjust:none;background:Highlight;color:HighlightText;font-weight:700}}
@media(hover:hover){.skd-button[data-variant=primary]:not(:disabled):hover{background:color-mix(in srgb,var(--primary) 90%,var(--background))}.skd-card:hover{border-color:color-mix(in srgb,var(--foreground) 25%,var(--background));box-shadow:0 3px 12px color-mix(in srgb,var(--foreground) 5%,transparent)}.skd-tab:hover{color:var(--foreground)}.skd-row:hover{background:color-mix(in srgb,var(--foreground) 3.5%,var(--card))}.skd-list>li:hover .skd-rowName{color:var(--foreground)}}
@container dashboard (min-width:1200px){.skd-cardList{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container dashboard (max-width:800px){.skd-wrap{padding-inline:22px}.skd-cardList{grid-template-columns:repeat(2,minmax(0,1fr))}.skd-card{padding:17px}.skd-row{padding-inline:8px;column-gap:12px}.skd-filterBar{grid-template-columns:repeat(3,minmax(0,1fr))}.skd-searchField{grid-column:1 / -1}.skd-filterBar>.skd-field>.skd-select{max-inline-size:none}.skd-overview{gap:18px}}
@container dashboard (max-width:600px){.skd-wrap{padding-inline:18px}.skd-header{padding-block:20px;gap:16px}.skd-headText{flex-basis:100%;column-gap:12px}.skd-title{font-size:1.25rem}.skd-pageMark{inline-size:38px;block-size:38px}.skd-headerTools{margin-inline-start:0;width:100%;justify-content:flex-end}.skd-headerTools .skd-button{width:auto}.skd-headerTools .skd-iconButton{width:44px;height:44px}.skd-tabbar{margin-bottom:16px;width:100%}.skd-tab{flex:1;justify-content:center;min-height:40px;padding-inline:7px}.skd-overview{gap:20px 24px;padding-bottom:20px}.skd-overviewItem{flex-direction:column;align-items:flex-start;gap:6px;padding:0;border:0!important}.skd-overviewLabel{font-size:.75rem}.skd-overviewValue{font-size:1.5rem}.skd-cardList{grid-template-columns:minmax(0,1fr)}.skd-sourceField{width:100%}.skd-sourceField .skd-segmented{display:flex;width:100%}.skd-segment{flex:1;min-height:42px}.skd-searchRow>.skd-searchField{flex-basis:calc(100% - 84px);min-inline-size:0}.skd-searchRow>.skd-button{min-height:48px;padding-inline:15px}.skd-cardFoot .skd-button{min-height:44px}.skd-input,.skd-select{font-size:1rem;min-height:48px}.skd-filterBar{grid-template-columns:minmax(0,1fr)}.skd-filterBar>.skd-field>.skd-select{min-inline-size:0;max-inline-size:none}.skd-rowRail{display:flex;grid-column:auto;align-items:flex-start;gap:14px}.skd-metric{flex-direction:column;align-items:flex-start;gap:0;min-inline-size:3rem;padding-inline-end:14px;border-inline-end:1px solid var(--border)}.skd-metric .skd-micro{display:block}.skd-metricValue{font-size:1rem}.skd-switchGroup{flex:1;max-width:none;gap:6px}.skd-switchControl{grid-template-columns:1fr auto}.skd-cardDesc{min-height:0}.skd-tableHeading{display:none}.skd-toolbar{padding:14px}.skd-row{padding-block:18px}.skd-switchControl{min-height:44px}.skd-footerInner{min-height:38px}}
@media(forced-colors:active){.skd-page{--primary:ButtonText;--primary-foreground:ButtonFace}.skd-tab[aria-selected=true]{border:1px solid Highlight}.skd-card,.skd-input,.skd-select{box-shadow:none}.skd-button[data-variant=primary]{background:ButtonFace;color:ButtonText}.skd-tabIcon{opacity:1}}
.skd-nameButton{display:inline;padding:0;border:0;background:none;color:inherit;font:inherit;font-weight:600;text-align:start;cursor:pointer;text-decoration:none;border-radius:3px}
.skd-nameButton:hover{color:var(--skd-accent-label);text-decoration:underline;text-underline-offset:3px}
.skd-cardName .skd-nameButton{color:var(--skd-accent-label);text-decoration:underline;text-decoration-color:var(--skd-control-line);text-underline-offset:.2em;overflow-wrap:anywhere}
.skd-previewDialog{box-sizing:border-box;inline-size:min(1120px,calc(100vw - 48px));block-size:min(800px,calc(100dvh - 48px));max-inline-size:none;max-block-size:none;padding:0;border:1px solid var(--dsw-alias-border-l2,#d5d7dc);border-radius:14px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#20252d);box-shadow:0 24px 90px #0004;overflow:auto;font:inherit}
.skd-previewDialog:modal{overscroll-behavior:contain}
.skd-previewDialog::backdrop{background:#10141c66;backdrop-filter:blur(3px);overflow:hidden;overscroll-behavior:contain}
.skd-previewRoot{height:100%;min-height:0;overflow:hidden;display:flex!important}
.skd-previewHeader{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:22px 24px;border-bottom:1px solid var(--skd-line);flex:none}
.skd-previewIdentity{min-width:0;max-width:90%}
.skd-previewEyebrow{font-size:.6875rem;color:var(--skd-muted)}
.skd-previewTitle{margin:3px 0 6px;font-size:1.25rem;line-height:1.4;letter-spacing:-.025em;font-weight:600;overflow-wrap:anywhere}
.skd-previewDescription{margin:0 0 10px;color:var(--skd-muted);font-size:.8125rem;line-height:1.6;max-width:85ch;max-height:4.8em;overflow:auto}
.skd-previewHeader form{flex:none;margin:0}
.skd-previewHeader .skd-iconButton{border:1px solid var(--skd-control-line);width:34px;height:34px}
.skd-previewLayout{display:grid;grid-template-columns:minmax(200px,260px) minmax(0,1fr);flex:1;min-height:0;min-width:0}
.skd-previewFiles{display:flex;flex-direction:column;min-height:0;min-width:0;border-right:1px solid var(--skd-line);background:var(--skd-soft)}
.skd-previewFilesHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:15px 16px 10px;flex:none}
.skd-previewFilesHead h3{margin:0;font-size:.75rem;line-height:1.5;font-weight:600}
.skd-fileList{list-style:none;margin:0;padding:0 8px 12px;overflow:auto;overscroll-behavior:contain;min-height:0}
.skd-fileButton{display:flex;align-items:flex-start;gap:8px;width:100%;min-height:36px;padding:9px 10px;border:1px solid transparent;border-radius:6px;background:none;color:var(--skd-muted);font:inherit;font-size:.75rem;line-height:1.6;text-align:start;cursor:pointer}
.skd-fileButton svg{flex:none;margin-top:2px}
.skd-fileButton>span:not(.skd-fileKind){min-width:0;overflow-wrap:anywhere}
.skd-fileButton:hover{background:var(--skd-bg);color:var(--skd-fg)}
.skd-fileButton[aria-pressed=true]{background:var(--skd-bg);color:var(--skd-fg);border-color:var(--skd-line);font-weight:500;box-shadow:0 1px 2px #00000008}
.skd-fileKind{flex:none;margin-left:auto;font-size:.625rem;color:var(--skd-muted)}
.skd-previewViewer{display:flex;flex-direction:column;min-width:0;min-height:0}
.skd-previewViewerHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-height:54px;padding:10px 20px;border-bottom:1px solid var(--skd-line);flex:none}
.skd-previewFilename{font-size:.75rem;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--skd-muted);min-width:0;overflow-wrap:anywhere}
.skd-previewViewerHead .skd-segmented{margin-left:auto}
.skd-previewViewerHead .skd-segment{min-height:26px;padding:2px 10px;font-size:.6875rem}
.skd-previewContent{min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px;flex:1}
.skd-prose{max-width:78ch;margin:0 auto;font-size:.875rem;line-height:1.85;overflow-wrap:anywhere}
.skd-prose h3,.skd-prose h4,.skd-prose h5,.skd-prose h6{margin:1.3em 0 .6em;font-size:1em;line-height:1.5;font-weight:600;color:var(--skd-fg)}
.skd-prose h3{font-size:1.25rem;letter-spacing:-.025em}
.skd-prose h4{font-size:1rem}
.skd-prose>:first-child{margin-top:0}
.skd-prose p{margin:.8em 0}
.skd-prose ul{padding-left:1.5em;margin:.8em 0}
.skd-prose li{margin:.35em 0}
.skd-prose code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:.85em;background:var(--skd-soft);padding:.15em .3em;border-radius:4px;box-decoration-break:clone}
.skd-prose pre{margin:1em 0;max-width:100%;padding:14px;border:1px solid var(--skd-line);border-radius:7px;background:var(--skd-soft);white-space:pre;overflow:auto;overscroll-behavior:contain}
.skd-prose pre code{padding:0;background:none}
.skd-fileCode{margin:0;max-width:100%;overflow:auto;white-space:pre;font: .75rem/1.8 var(--ds-font-family-code,ui-monospace,monospace);tab-size:2;overscroll-behavior:contain}
.skd-previewMessage{display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:28px;color:var(--skd-muted);font-size:.8125rem;text-align:center;line-height:1.75;overflow:auto}
.skd-previewNotice{margin:0 0 16px;padding:10px 12px;border:1px solid var(--skd-line);border-radius:7px;background:var(--skd-soft);font-size:.75rem;line-height:1.6;color:var(--skd-muted)}
.skd-previewFiles .skd-previewNotice{margin:10px;font-size:.6875rem;flex:none}
.skd-previewFooter{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;flex:none;padding:10px 20px;border-top:1px solid var(--skd-line);font-size:.6875rem;color:var(--skd-muted);line-height:1.5}
.skd-previewFooter>span:first-child{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:700px){.skd-previewDialog{inline-size:calc(100vw - 16px);block-size:calc(100dvh - 16px);border-radius:10px}.skd-previewHeader{padding:16px;gap:12px}.skd-previewTitle{font-size:1.125rem}.skd-previewDescription{max-height:3.2em}.skd-previewLayout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(100px,24%) minmax(0,1fr)}.skd-previewFiles{border-right:0;border-bottom:1px solid var(--skd-line)}.skd-previewFilesHead{padding:8px 14px}.skd-fileList{padding-bottom:8px}.skd-fileButton{min-height:44px;padding-block:10px}.skd-previewViewerHead{padding:8px 14px;min-height:48px}.skd-previewContent{padding:18px}.skd-previewHeader .skd-iconButton{min-width:44px;min-height:44px}.skd-previewFooter{padding:8px 14px}.skd-previewViewerHead .skd-segment{min-height:44px}}
@media(max-height:480px){.skd-previewDialog{block-size:calc(100dvh - 16px)}.skd-previewHeader{padding-block:12px}.skd-previewDescription,.skd-previewFooter{display:none}}
@media(forced-colors:active){.skd-previewDialog{border-color:CanvasText;box-shadow:none}.skd-previewDialog::backdrop{backdrop-filter:none}.skd-fileButton[aria-pressed=true]{outline:1px solid Highlight}.skd-nameButton{text-decoration:underline}}
.skd-previewDialog{inline-size:min(1440px,94vw);block-size:92dvh;min-inline-size:min(680px,calc(100vw - 24px));min-block-size:min(420px,calc(100dvh - 24px));max-inline-size:calc(100vw - 24px);max-block-size:calc(100dvh - 24px);resize:both}
.skd-previewDialog[data-maximized]{inline-size:calc(100vw - 16px);block-size:calc(100dvh - 16px);max-inline-size:calc(100vw - 16px);max-block-size:calc(100dvh - 16px);resize:none;border-radius:8px}
.skd-windowTools{display:flex;align-items:center;gap:6px;flex:none}
.skd-previewHeader .skd-previewIdentity{max-width:none;flex:1}
.skd-previewHeader .skd-windowTools form{margin:0}
.skd-previewFooter{padding-inline-end:28px}
.skd-fileList .skd-treeChildren{padding:0 0 0 16px;margin:0 0 0 12px;border-left:1px solid var(--skd-line);list-style:none}
.skd-folderLabel{display:flex;align-items:center;gap:7px;min-height:36px;padding:7px 8px;border-radius:5px;color:var(--skd-fg);font-size:.75rem;line-height:1.6;cursor:pointer;list-style:none}
.skd-folderLabel::-webkit-details-marker{display:none}
.skd-folderLabel>span{overflow-wrap:anywhere;min-width:0}
.skd-folderLabel svg{flex:none}
.skd-folderLabel>svg:first-child{transform:rotate(-90deg)}
.skd-folder[open]>.skd-folderLabel>svg:first-child{transform:rotate(0)}
.skd-folderLabel:hover{background:var(--skd-bg)}
.skd-treeChildren .skd-fileButton{padding-inline:8px}
@media(max-width:700px){.skd-previewDialog{inline-size:calc(100vw - 16px);block-size:calc(100dvh - 16px);max-inline-size:calc(100vw - 16px);max-block-size:calc(100dvh - 16px);min-inline-size:0;resize:none}.skd-windowTools{gap:4px}.skd-windowTools .skd-sizeStep{display:none}.skd-previewHeader .skd-iconButton{min-width:36px;min-height:44px;width:36px}.skd-folderLabel{min-height:44px}.skd-previewHeader{padding:14px;gap:8px}.skd-previewDescription{font-size:.75rem}.skd-previewTitle{font-size:1rem}}
@media(forced-colors:active){.skd-treeChildren{border-color:CanvasText}.skd-folderLabel:hover{outline:1px solid Highlight}}
.skd-top{background:color-mix(in srgb,var(--skd-soft) 50%,var(--skd-bg))}
.skd-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center}
.skd-headText{min-inline-size:0}
.skd-title{overflow-wrap:anywhere}
.skd-headerTools{width:auto}
.skd-sectionHead{flex-wrap:wrap;gap:.5rem 1rem}
.skd-sectionTitle{font-size:1.125rem}
.skd-sectionBody{font-size:.8125rem}
.skd-tab[aria-selected=true]{font-weight:650}
.skd-tab[aria-selected=true] .skd-tabIcon{color:var(--skd-accent-label)}
.skd-libraryResults,.skd-discoverResults{justify-content:space-between;flex-wrap:wrap;overflow-wrap:anywhere;min-block-size:1.5rem}
.skd-libraryResults .skd-button[data-variant=text]{color:var(--skd-accent-label);margin-inline-start:auto}
.skd-searchBox{min-inline-size:0}
.skd-searchBox>svg{left:auto;inset-inline-start:.75rem}
.skd-searchBox .skd-input{padding-left:.75rem;padding-inline-start:2.375rem}
.skd-previewFilesToggle{display:none}
@container dashboard (max-width:600px){
  .skd-header{padding-block:.75rem;gap:.75rem}
  .skd-headerTools{width:auto}
  .skd-pageMark{inline-size:2rem;block-size:2rem}
  .skd-subtitle{display:none}
  .skd-tabbar{margin-block-end:.75rem}
  .skd-tab{min-block-size:2.75rem;min-inline-size:0;white-space:normal;overflow-wrap:anywhere;text-align:center}
  .skd-content{padding-block-start:1rem}
  .skd-filterBar{grid-template-columns:repeat(auto-fit,minmax(min(100%,7.5rem),1fr));padding-inline:0}
  .skd-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem 1rem;margin-block-end:1rem;padding-block-end:.75rem}
  .skd-overviewItem{flex-direction:row;align-items:baseline;justify-content:space-between;gap:.25rem .5rem}
  .skd-overviewValue{font-size:1rem}
  .skd-searchRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem}
  .skd-searchRow>.skd-sourceField{grid-column:1 / -1}
  .skd-searchRow>.skd-searchField{grid-column:1}
}
@media(max-width:700px){
  .skd-previewLayout{grid-template-rows:auto minmax(0,1fr)}
  .skd-previewLayout[data-files-expanded]{grid-template-rows:auto auto minmax(0,1fr)}
  .skd-previewLayout:not([data-files-expanded]) .skd-previewFiles{display:none}
  .skd-previewFiles{max-block-size:min(38dvh,18rem);overflow:auto}
  .skd-previewFiles .skd-fileList{overflow:visible}
  .skd-previewFilesHead{display:none}
  .skd-previewFilesToggle{display:flex;align-items:center;justify-content:flex-start;border-width:0 0 1px;border-color:var(--skd-line);border-radius:0;padding-inline:.875rem;min-block-size:2.75rem}
  .skd-previewFilesToggle .skd-micro{margin-inline-start:auto}
  .skd-previewFilesToggle:focus-visible{outline-offset:-3px}
  .skd-previewHeader .skd-iconButton{inline-size:2.75rem;min-inline-size:2.75rem}
}
.skd-periodControls{display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-end;justify-content:flex-start;gap:12px}
.skd-periodField{display:flex;flex-direction:column;align-items:stretch;gap:6px;min-inline-size:0;font-size:.8125rem;color:var(--skd-muted)}
.skd-periodField .skd-input,.skd-periodField .skd-select{min-inline-size:0;max-inline-size:100%;color:var(--skd-fg)}
.skd-periodRange{flex:1 1 16rem;margin:0 0 8px;text-align:end}
.skd-periodValidation{flex-basis:100%}
.skd-periodValidation:empty{position:absolute;inline-size:1px;block-size:1px;clip-path:inset(50%)}
.skd-usagePanel .skd-statValue{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.skd-usagePanel .skd-panelCard>h3{margin:0 0 12px;color:var(--skd-fg);font-size:.875rem;font-weight:600}
.skd-usagePanel .skd-panelCard>.skd-periodField{margin-block-end:6px}
.skd-usagePanel .skd-activityName{white-space:normal;overflow-wrap:anywhere}
.skd-cardTitleRow>.skd-periodField{max-inline-size:min(100%,18rem)}
.skd-periodTrendTitle{scroll-margin-block-start:16px;border-radius:3px;overflow-wrap:anywhere}
.skd-periodTrendTitle:focus,.skd-periodTableScroll:focus-visible{outline:2px solid var(--skd-accent);outline-offset:3px}
.skd-periodChart{gap:clamp(2px,.5vw,8px)}
.skd-periodTableScroll{max-inline-size:100%;overflow:auto;overscroll-behavior-inline:contain;border:1px solid var(--skd-line);border-radius:8px;margin-block-start:12px;max-block-size:32rem;scroll-padding-block-start:3.5rem}
.skd-periodTable{--skd-cell-padding:12px;inline-size:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:.8125rem;line-height:1.45;text-align:start}
.skd-periodTable caption{padding:12px;text-align:start;color:var(--skd-muted);font-size:.75rem;overflow-wrap:anywhere}
.skd-periodTable th,.skd-periodTable td{padding:8px var(--skd-cell-padding);border-block-end:1px solid var(--skd-line);text-align:start;font-weight:400;overflow-wrap:anywhere}
.skd-periodTable thead th{position:sticky;inset-block-start:0;z-index:2;background:var(--skd-soft);font-weight:600;padding:0}
.skd-periodTable thead th:first-child{inline-size:50%}
.skd-periodTable th:not(:first-child),.skd-periodTable td{text-align:end;font-variant-numeric:tabular-nums}
.skd-periodTable td[colspan]{text-align:start}
.skd-periodSort{display:flex;justify-content:flex-end;align-items:center;gap:8px;inline-size:100%;min-block-size:44px;padding:8px var(--skd-cell-padding);border:0;background:transparent;color:inherit;font:inherit;font-weight:600;text-align:inherit;cursor:pointer}
.skd-periodTable th:first-child .skd-periodSort{justify-content:space-between}
.skd-periodSort>span:first-child{min-inline-size:0;overflow-wrap:anywhere}
.skd-periodSort>span:last-child{flex:none}
.skd-periodSort:hover{background:var(--skd-bg)}
.skd-periodSkill{display:block;max-inline-size:100%;border:0;background:transparent;color:var(--skd-accent-label,var(--skd-accent));font:inherit;font-weight:500;text-align:start;cursor:pointer;padding:4px;min-block-size:32px;overflow-wrap:anywhere}
.skd-periodSkill:hover,.skd-periodSkill[aria-pressed=true]{text-decoration:underline;text-underline-offset:4px}
.skd-periodSkill+.skd-badge{max-inline-size:100%;margin:3px 0 0 4px;white-space:normal;overflow-wrap:anywhere}
.skd-periodSkill:focus-visible,.skd-periodSort:focus-visible{outline:2px solid var(--skd-accent);outline-offset:-2px;border-radius:4px}
.skd-periodTable tbody tr:last-child>*{border-block-end:0}
@container dashboard (max-width:600px){
  .skd-periodControls>.skd-periodField{flex:1 1 8rem}
  .skd-periodControls>.skd-periodField:first-child,.skd-periodRange{flex-basis:100%}
  .skd-periodRange{text-align:start;margin:0}
  .skd-periodControls .skd-input,.skd-periodControls .skd-select{inline-size:100%}
  .skd-usagePanel .skd-panelCard{padding:14px}
  .skd-cardTitleRow>.skd-periodField{flex:1 1 100%;max-inline-size:100%}
  .skd-periodChart{gap:2px}
  .skd-periodTableScroll{scroll-padding-block-start:5rem}
  .skd-periodTable{--skd-cell-padding:8px}
  .skd-periodTable thead th:first-child{inline-size:44%}
  .skd-periodSort{gap:4px}
  .skd-periodSkill{min-block-size:44px}
}
@media(forced-colors:active){.skd-periodSkill{color:LinkText}.skd-periodTable thead th{background:Canvas}.skd-periodSkill[aria-pressed=true]{outline:1px solid Highlight}}
`;
    // ---------------------------------------------------------------- util
    /** A string field, or the empty string; missing fields are tolerated. */
    function textOf(value) {
      return typeof value === 'string' ? value : '';
    }

    /** A non-negative integer from a Host counter. */
    function countOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }

    /** A plain object field, or null. */
    function objectOf(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false ? value : null;
    }

    /** Only the string members of an array field. */
    function stringsOf(value) {
      return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
    }

    function formatNumber(value) {
      const lang = typeof document === 'object' ? document.documentElement?.lang : undefined;
      try { return new Intl.NumberFormat(lang || undefined).format(countOf(value)); }
      catch { return String(countOf(value)); }
    }

    const FORMATTERS = new Map();
    /** Intl formatter cached per kind, in the page's language; null when Intl rejects it. */
    function formatterOf(kind, intlSpec) {
      const lang = typeof document === 'object' && document.documentElement !== null ? textOf(document.documentElement.lang) : '';
      const key = kind + ':' + lang;
      let formatter = FORMATTERS.get(key);
      if (formatter === undefined) {
        try {
          formatter = new Intl.DateTimeFormat(lang === '' ? undefined : lang, intlSpec);
        } catch {
          formatter = null;
        }
        FORMATTERS.set(key, formatter);
      }
      return formatter;
    }

    /** Local date + time for a usage timestamp. */
    function formatStamp(millis) {
      if (Number.isFinite(millis) === false || millis <= 0) return '';
      const formatter = formatterOf('stamp', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (formatter === null) return '';
      try {
        return formatter.format(new Date(millis));
      } catch {
        return '';
      }
    }

    /** Local time of day, for the footer's freshness line. */
    function formatClock(millis) {
      if (Number.isFinite(millis) === false || millis <= 0) return '';
      const formatter = formatterOf('clock', { hour: '2-digit', minute: '2-digit' });
      if (formatter === null) return '';
      try {
        return formatter.format(new Date(millis));
      } catch {
        return '';
      }
    }

    /** `YYYY-MM-DD` as a local noon Date, so a timezone shift never moves the day. */
    function parseDay(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(textOf(value));
      if (match === null) return null;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    /** Short month/day label for the chart axis and bar titles. */
    function formatDay(value) {
      const date = parseDay(value);
      if (date === null) return '';
      const formatter = formatterOf('day', { month: 'numeric', day: 'numeric' });
      if (formatter === null) return '';
      try {
        return formatter.format(date);
      } catch {
        return '';
      }
    }

    /** Nearest-rank percentile over the positive call counts the Host listed. */
    function percentileOf(values, ratio) {
      const numbers = values.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
      if (numbers.length === 0) return Number.POSITIVE_INFINITY;
      const rank = Math.min(numbers.length, Math.max(1, Math.ceil(numbers.length * ratio)));
      return numbers[rank - 1];
    }

    /** Localized copy for a known Host error code; otherwise the Host message, otherwise a generic line. */
    function describeFailure(code, message, t) {
      if (code !== null && code !== undefined) {
        const key = 'error.' + String(code);
        const localized = t(key);
        if (localized !== key) return localized;
      }
      if (typeof message === 'string' && message !== '') return message;
      return t('status.failedPlain');
    }

    /** The footer note as one line, translated at render time so a language switch updates it. */
    function noteTextOf(note, t) {
      const entry = objectOf(note);
      if (entry === null) return '';
      if (entry.failKey !== undefined) {
        if (entry.offline === true) return t('status.offlineInline');
        return t('status.failed', { action: t(entry.failKey), message: describeFailure(entry.code, entry.message, t) });
      }
      return typeof entry.key === 'string' ? t(entry.key, entry.params) : '';
    }

    /** A discover hint code from the Host (`suggestions`) as localized copy, else the raw code. */
    function discoverNoteOf(code, t) {
      const value = textOf(code);
      if (value === '') return '';
      const key = 'discover.note.' + value;
      const localized = t(key);
      return localized === key ? value : localized;
    }

    // ---------------------------------------------------------------- store
    /** Shallow compare, so an unchanged snapshot never re-renders the panel. */
    function shallowEqual(left, right) {
      if (left === right) return true;
      if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      if (leftKeys.length !== rightKeys.length) return false;
      for (const key of leftKeys) if (left[key] !== right[key]) return false;
      return true;
    }

    /** Smallest observable snapshot store; no external dependency needed. */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          const previous = value;
          const candidate = typeof next === 'function' ? next(previous) : next;
          if (shallowEqual(previous, candidate)) return;
          value = candidate;
          for (const listener of listeners) listener();
        },
      };
    }

    // ---------------------------------------------------------------- transport
    /** Same-origin JSON, returning { ok: true, value } or a { ok: false, … } failure instead of throwing. */
    async function requestJson(route, init) {
      // A hung route must not wedge the panel; abort after ten seconds.
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(route, controller === null ? init : { ...init, signal: controller.signal });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (response.ok === false) {
          return {
            ok: false,
            status: response.status,
            code: objectOf(payload) === null ? null : payload.code ?? null,
            message: objectOf(payload) === null ? null : payload.message ?? null,
          };
        }
        if (objectOf(payload) === null) {
          return { ok: false, status: response.status, code: 'invalid-response', message: null };
        }
        if (payload.ok === false) {
          return { ok: false, status: response.status, code: payload.code ?? null, message: payload.message ?? null };
        }
        return { ok: true, value: payload };
      } catch {
        // A rejected fetch is the connection, not the payload: no status, no message.
        return { ok: false, offline: true, code: null, message: null };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    // ---------------------------------------------------------------- runtime
    /**
     * Own the snapshot: one read of `state`, the four mutations, and the discover search.
     * Every mutation re-reads the Host, so the panel never shows a guess.
     * @returns the store plus the actions the page and its rows call.
     */
    function createRuntime() {
      const store = createStore({
        data: null,
        status: 'idle',
        fetchedAt: 0,
        refreshing: false,
        pending: null,
        note: null,
        discover: { source: null, query: '', status: 'idle', items: [], error: null, note: null, at: 0 },
      });
      const patch = (fields) => store.set((current) => ({ ...current, ...fields }));
      const patchDiscover = (fields) => store.set((current) => ({
        ...current,
        discover: { ...current.discover, ...fields },
      }));

      /** Bumped by every mutation, so a read that started earlier cannot overwrite its result. */
      let revision = 0;
      let refreshes = Promise.resolve();
      let discoverToken = 0;
      /** Pending settle read; at most one, owned so unloading the plugin clears it. */
      let settleTimer = null;

      const loadState = async (silent) => {
        const started = revision;
        const before = store.getSnapshot();
        if (silent !== true) patch({ status: before.data === null ? 'loading' : before.status, refreshing: true });
        const result = await requestJson(ROUTE_STATE, { headers: { accept: 'application/json' } });
        if (started !== revision) {
          patch({ refreshing: false });
          return false;
        }
        if (result.ok !== true) {
          patch({ status: 'offline', refreshing: false });
          return false;
        }
        patch({ data: result.value, status: 'ready', refreshing: false, fetchedAt: Date.now() });
        return true;
      };

      /**
       * Read the Host snapshot. Reads are serialized, and a call that names a freshness
       * window returns the current snapshot instead of asking again.
       * @param staleAfterMs - skip the read when the snapshot is younger than this.
       * @param silent - settle read: leave the refresh control out of it.
       * @returns whether the read produced a fresh snapshot.
       */
      const refresh = ({ staleAfterMs = 0, silent = false } = {}) => {
        const snapshot = store.getSnapshot();
        if (staleAfterMs > 0 && snapshot.fetchedAt !== 0 && Date.now() - snapshot.fetchedAt < staleAfterMs) {
          return Promise.resolve(false);
        }
        const run = refreshes.then(() => loadState(silent)).catch(() => false);
        refreshes = run.then(() => undefined, () => undefined);
        return run;
      };

      /**
       * One delayed re-read after a mutation, for a provider watcher that republishes late.
       * At most one is outstanding; unloading the plugin clears it.
       */
      const refetchSoon = () => {
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          void refresh({ silent: true });
        }, SETTLE_RETRY_MS);
      };

      /** Drop the inline error banner without touching the data behind it. */
      const dismissNote = () => {
        if (store.getSnapshot().note !== null) patch({ note: null });
      };

      /** Release the settle timer when the plugin unloads. */
      const dispose = () => {
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = null;
      };

      /**
       * Post one action, then re-read the Host. A refusal lands in the inline banner with
       * the Host's own message, an unreachable Host also flips the connection status, and a
       * success schedules the single settle read that follows the immediate one.
       */
      const runAction = async (body, step) => {
        if (store.getSnapshot().pending !== null) return false;
        revision += 1;
        patch({ pending: { kind: step.kind, target: step.target }, note: null });
        const result = await requestJson(ROUTE_ACTION, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        patch({ pending: null });
        if (result.ok !== true) {
          patch({
            note: {
              tone: 'error',
              failKey: step.failKey,
              code: result.code ?? null,
              message: result.message ?? null,
              offline: result.offline === true,
            },
          });
          if (result.offline === true) patch({ status: 'offline' });
          return false;
        }
        PREVIEW_MEMORY.clear();
        patch({ note: step.success(result.value) });
        await refresh();
        refetchSoon();
        return true;
      };

      const setInvocation = (skill, changes) => {
        const path = textOf(skill?.path);
        if (path === '') return Promise.resolve(false);
        return runAction(
          { action: 'set-invocation', path, ...changes },
          {
            kind: 'invocation',
            target: path,
            failKey: 'action.switch',
            success: () => ({ tone: 'ok', key: 'status.saved' }),
          },
        );
      };

      const removeSkill = (skill) => {
        const name = textOf(skill?.name);
        const path = textOf(skill?.path);
        if (name === '' || path === '') return Promise.resolve(false);
        return runAction(
          { action: 'remove', name, path },
          {
            kind: 'remove',
            target: name,
            failKey: 'skill.menu.remove',
            success: () => ({ tone: 'ok', key: 'status.removed', params: { name } }),
          },
        );
      };

      const updateSkill = (skill) => {
        const name = textOf(skill?.name);
        if (name === '') return Promise.resolve(false);
        // The Host resolves source and ref from its provenance store when they are absent.
        return runAction(
          { action: 'update', name },
          {
            kind: 'update',
            target: name,
            failKey: 'skill.menu.update',
            success: (value) => ({
              tone: 'ok',
              key: objectOf(value) !== null && value.changed === true ? 'status.updatedSkill' : 'status.upToDate',
              params: { name },
            }),
          },
        );
      };

      const installSkill = (item, source) => {
        const name = textOf(item?.name);
        const ref = textOf(item?.ref);
        const sourceId = textOf(source);
        if (name === '' || ref === '' || sourceId === '') return Promise.resolve(false);
        return runAction(
          { action: 'install', source: sourceId, ref, name },
          {
            kind: 'install',
            target: name,
            failKey: 'discover.install',
            success: () => {
              // The installed card must not offer a second install while the catalog reloads.
              store.set((current) => ({
                ...current,
                discover: {
                  ...current.discover,
                  items: current.discover.items.map((entry) => (
                    textOf(objectOf(entry)?.name) === name ? { ...entry, installed: true } : entry
                  )),
                },
              }));
              return { tone: 'ok', key: 'status.installed', params: { name } };
            },
          },
        );
      };

      /** Select a discover source without searching; a search re-runs it when a query is set. */
      const selectSource = (source) => {
        const sourceId = textOf(source);
        if (sourceId === '' || store.getSnapshot().discover.source === sourceId) return;
        // Switching without a new query must invalidate the old source's in-flight result too.
        discoverToken += 1;
        patchDiscover({ source: sourceId, status: 'idle', items: [], error: null, note: null, query: '' });
      };

      /** Search one source; a slower earlier answer never replaces a newer one. */
      const runDiscover = async (source, query) => {
        const sourceId = textOf(source);
        if (sourceId === '') return false;
        discoverToken += 1;
        const token = discoverToken;
        const search = textOf(query);
        patchDiscover({ source: sourceId, query: search, status: 'loading', items: [], error: null, note: null });
        const result = await requestJson(ROUTE_DISCOVER, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: sourceId, query: search, limit: DISCOVER_LIMIT }),
        });
        if (token !== discoverToken) return false;
        if (result.ok !== true) {
          patchDiscover({
            status: 'error',
            items: [],
            error: {
              code: result.code ?? null,
              message: result.message ?? null,
              offline: result.offline === true,
            },
          });
          return false;
        }
        patchDiscover({
          status: 'ready',
          items: Array.isArray(result.value.items) ? result.value.items : [],
          error: null,
          note: textOf(result.value.note) === '' ? null : result.value.note,
          at: Date.now(),
        });
        return true;
      };

      return {
        store,
        refresh,
        setInvocation,
        removeSkill,
        updateSkill,
        installSkill,
        selectSource,
        runDiscover,
        dismissNote,
        dispose,
      };
    }

    // ---------------------------------------------------------------- glyphs
    /** The sidebar glyph: two layered cards plus a spark, readable at 16–18px. */
    function SkillDashboardIcon({ size, active }) {
      const edge = Number.isFinite(size) && size > 0 ? size : 18;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        'aria-hidden': true,
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active === true ? 1.9 : 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { display: 'block' },
      },
        h('path', { d: 'M8.4 5.2h8.2a2.2 2.2 0 0 1 2.2 2.2v8.2', opacity: 0.5 }),
        h('rect', { x: 3.2, y: 8.4, width: 11.6, height: 12, rx: 2.4 }),
        h('path', { d: 'M6.4 13.2h5.2M6.4 16.4h3.4', opacity: 0.8 }),
        h('path', { d: 'M19.1 2.5l.9 1.5 1.5.9-1.5.9-.9 1.5-.9-1.5-1.5-.9 1.5-.9z', fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** Refresh arrow for the header's icon button. */
    function RefreshGlyph({ size }) {
      const edge = Number.isFinite(size) ? size : 15;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        'aria-hidden': true,
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { display: 'block' },
      },
        h('path', { d: 'M19.4 12a7.6 7.6 0 1 1-2.2-5.35' }),
        h('path', { d: 'M19.6 3.8v4.2h-4.2' }),
      );
    }

    /** Row overflow glyph: three dots. */
    function OverflowGlyph({ size }) {
      const edge = Number.isFinite(size) ? size : 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        'aria-hidden': true,
        focusable: 'false',
        fill: 'currentColor',
        style: { display: 'block' },
      },
        h('circle', { cx: 5.5, cy: 12, r: 1.6 }),
        h('circle', { cx: 12, cy: 12, r: 1.6 }),
        h('circle', { cx: 18.5, cy: 12, r: 1.6 }),
      );
    }

    /** Compact, consistent outline glyphs without a runtime icon dependency. */
    function Glyph({ name = 'search', size = 18 }) {
      const paths = {
        search: 'M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
        plus: 'M12 5v14M5 12h14',
        minus: 'M5 12h14',
        chevron: 'M6 9l6 6 6-6',
        folder: 'M3 7V4h6l2 3h10v13H3z',
        maximize: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
        restore: 'M8 8H3v13h13v-5M8 8V3h13v13h-5M8 8h8v8',
        refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15',
        arrow: 'M5 12h14m-5-5 5 5-5 5',
        library: 'M3 5h5v15H3zM9 3h5v17H9zM16 5l4-1 3 15-4 1z',
        compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M16 8l-2.5 5.5L8 16l2.5-5.5z',
        chart: 'M4 4v16h16M8 15v-4M12 15V7M16 15v-6',
        close: 'M6 6l12 12M6 18 18 6',
        file: 'M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6',
      };
      return el('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        el('path', { d: paths[name] ?? paths.search }));
    }

    function SectionHeading({ title, body, children }) {
      return el('div', { className: 'skd-sectionHead' },
        el('div', null, el('h2', { className: 'skd-sectionTitle' }, title),
          el('p', { className: 'skd-sectionBody' }, body)), children);
    }

    function SelectField({ label, value, options, onChange }) {
      const id = 'skd-select-' + useId();
      return el('label', { className: 'skd-field', htmlFor: id }, el('span', null, label),
        el('select', { id, name: id, className: 'skd-select', value, onChange: (event) => onChange(event.target.value) },
          options.map((option) => el('option', { key: option.id, value: option.id }, option.label))));
    }

    /** Pure projection shared by the library controls: filtering never mutates the host snapshot. */
    function filterSkills(skills, { runtime = 'all', query = '', status = 'all', sort = 'usage' } = {}) {
      const needle = query.trim().toLocaleLowerCase();
      return skills.filter((skill) =>
        (runtime === 'all' || stringsOf(skill.runtimes).includes(runtime))
        && (needle === '' || [skill.name, skill.description, skill.source].some((value) => textOf(value).toLocaleLowerCase().includes(needle)))
        && (status === 'all' || (status === 'enabled' && skill.modelInvocable === true)
          || (status === 'disabled' && skill.modelInvocable !== true) || (status === 'writable' && skill.writable === true))
      ).sort((left, right) => {
        const alphabetical = textOf(left.name).localeCompare(textOf(right.name));
        if (sort === 'name') return alphabetical;
        const field = sort === 'recent' ? 'lastUsedAt' : 'count';
        return countOf(objectOf(right.usage)?.[field]) - countOf(objectOf(left.usage)?.[field]) || alphabetical;
      });
    }

    // ---------------------------------------------------------------- controls
    /**
     * The agent badge of one skill: nothing when every detected agent reads it,
     * the agent name when only one does, and a count when several but not all
     * of them do.
     *
     * @param {object} skill - the skill entry.
     * @param {{ id: string, title: string }[]} runtimes - the detected agents.
     * @returns {{ kind: 'none' | 'one' | 'some', agent: string, count: number, total: number, title: string }} the badge.
     */
    function runtimeBadge(skill, runtimes) {
      const total = Array.isArray(runtimes) ? runtimes.length : 0;
      const ids = stringsOf(skill?.runtimes);
      const titles = (Array.isArray(runtimes) ? runtimes : [])
        .map((runtime) => objectOf(runtime))
        .filter((runtime) => runtime !== null)
        .map((runtime) => ({ id: textOf(runtime.id), title: textOf(runtime.title) }));
      const titleOf = (id) => titles.find((runtime) => runtime.id === id)?.title ?? id;
      if (total <= 0 || ids.length === 0 || ids.length >= total) {
        return { kind: 'none', agent: '', count: 0, total, title: '' };
      }
      if (ids.length === 1) {
        const agent = titleOf(ids[0]);
        return { kind: 'one', agent, count: 1, total, title: agent };
      }
      return {
        kind: 'some',
        agent: '',
        count: ids.length,
        total,
        title: ids.map((id) => titleOf(id)).join(' · '),
      };
    }

    /** Segmented single-choice control: the agent filter and the discover source both use it. */
    function Segmented({ items, value, label, onChange }) {
      const buttons = useRef([]);
      const move = (event, index) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const enabled = items.map((item, at) => ({ ...item, at })).filter((item) => item.disabled !== true);
        if (enabled.length === 0) return;
        const at = enabled.findIndex((item) => item.at === index);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
          : (at + (event.key === 'ArrowLeft' ? -1 : 1) + enabled.length) % enabled.length;
        const item = enabled[next];
        onChange(item.id);
        buttons.current[item.at]?.focus?.();
      };
      return el('div', { className: 'skd-segmented', role: 'radiogroup', 'aria-label': label },
        items.map((item, index) => el(Button, {
          key: item.id,
          type: 'button',
          ref: (node) => { buttons.current[index] = node; },
          role: 'radio',
          className: 'skd-segment',
          'aria-checked': item.id === value,
          'data-active': item.id === value ? '' : undefined,
          tabIndex: item.disabled !== true && (item.id === value || (!items.some((entry) => entry.id === value && entry.disabled !== true) && index === items.findIndex((entry) => entry.disabled !== true))) ? 0 : -1,
          title: item.title,
          disabled: item.disabled === true,
          onClick: () => { if (item.disabled !== true) onChange(item.id); },
          onKeyDown: (event) => move(event, index),
        }, item.label)),
      );
    }

    /** Switch that only reports the requested state; the Host decides whether it sticks. */
    function Switch({ checked, disabled, label, busy, onChange, children }) {
      const id = 'skd-switch-' + useId();
      const nativeSwitch = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;
      return el('label', { className: 'skd-switchControl', htmlFor: id },
        el(Input, {
          id, name: id, type: 'checkbox', switch: '', className: 'skd-switchInput',
          role: nativeSwitch ? undefined : 'switch', checked: checked === true,
          'aria-label': label, 'aria-busy': busy === true || undefined,
          disabled: disabled === true,
          onChange: (event) => { if (!disabled) onChange(event.target.checked); },
        }),
        el('span', { className: 'skd-switchLabel' }, children),
        el('span', { className: 'skd-switch', 'aria-hidden': true },
          el('span', { className: 'skd-switchThumb' })),
      );
    }

    /** Underline tab bar shared by the three views. */
    function TabBar({ tabs, value, onChange, label, idPrefix }) {
      const buttons = useRef([]);
      const move = (event, index) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : (index + 1) % tabs.length;
        const tab = tabs[next];
        if (tab === undefined) return;
        onChange(tab.id);
        buttons.current[next]?.focus?.();
      };
      return el('div', { className: 'skd-tabbar', role: 'tablist', 'aria-label': label },
        tabs.map((tab, index) => el(Button, {
          key: tab.id,
          type: 'button',
          ref: (node) => { buttons.current[index] = node; },
          role: 'tab',
          id: idPrefix + '-tab-' + tab.id,
          className: 'skd-tab',
          'aria-selected': tab.id === value,
          'aria-controls': idPrefix + '-panel-' + tab.id,
          tabIndex: tab.id === value ? 0 : -1,
          onClick: () => onChange(tab.id),
          onKeyDown: (event) => move(event, index),
        },
          el('span', { className: 'skd-tabIcon', 'aria-hidden': true }, el(Glyph, { name: tab.id === 'installed' ? 'library' : tab.id === 'discover' ? 'compass' : 'chart', size: 15 })),
          tab.label,
        )),
      );
    }

    /** Native top-layer menu with feature-detected focus, invoker and positioning fallbacks. */
    function RowMenu({ skill, t, name, disabled, canUpdate, pathShown, onUpdate, onAskRemove, onTogglePath, returnFocusRef }) {
      const [open, setOpen] = useState(false);
      const internalTrigger = useRef(null);
      const triggerRef = returnFocusRef ?? internalTrigger;
      const menuRef = useRef(null);
      const groupRef = useRef(null);
      const enterOnOpen = useRef(false);
      const nativePopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
      const nativeInvoker = typeof HTMLButtonElement !== 'undefined' && 'commandForElement' in HTMLButtonElement.prototype;
      const nativeFocusGroup = typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;
      const nativeAnchor = typeof window.CSS?.supports === 'function' && window.CSS.supports('position-area: block-end');
      const id = 'skd-menu-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
      const path = textOf(skill?.path);
      const menuLabel = t('skill.menuAria', { name });
      const items = () => Array.from(groupRef.current?.querySelectorAll('button:not(:disabled)') ?? []);
      const isOpen = () => nativePopover ? menuRef.current?.matches(':popover-open') === true : open;
      const close = (restore = false) => {
        if (restore) triggerRef.current?.focus({ preventScroll: true });
        if (nativePopover && isOpen()) menuRef.current.hidePopover();
        if (!nativePopover) setOpen(false);
      };
      const position = () => {
        const menu = menuRef.current;
        const trigger = triggerRef.current;
        if (!menu || !trigger || (nativePopover && nativeAnchor)) return;
        const rect = trigger.getBoundingClientRect();
        const gutter = 8;
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const below = rect.bottom + gutter;
        const top = below + height <= window.innerHeight - gutter ? below : rect.top - height - gutter;
        const left = Math.max(gutter, Math.min(rect.right - width, window.innerWidth - width - gutter));
        const clampedTop = Math.max(gutter, Math.min(top, window.innerHeight - height - gutter));
        menu.style.setProperty('--skd-menu-left', left + 'px');
        menu.style.setProperty('--skd-menu-top', clampedTop + 'px');
        // A host container can establish a fixed-position containing block. Compensate its origin.
        const placed = menu.getBoundingClientRect();
        menu.style.setProperty('--skd-menu-left', left + (left - placed.left) + 'px');
        menu.style.setProperty('--skd-menu-top', clampedTop + (clampedTop - placed.top) + 'px');
      };
      const enter = () => {
        if (isOpen()) items()[0]?.focus({ preventScroll: true });
        else { enterOnOpen.current = true; triggerRef.current?.click(); }
      };
      useLayoutEffect(() => {
        if (nativePopover) return undefined;
        if (open) {
          position();
          if (enterOnOpen.current) items()[0]?.focus({ preventScroll: true });
          enterOnOpen.current = false;
        }
      }, [open]);
      useEffect(() => {
        if (!nativePopover) return undefined;
        const menu = menuRef.current;
        const toggle = (event) => {
          const next = event.newState === 'open';
          setOpen(next);
          if (next) {
            position();
            if (enterOnOpen.current) items()[0]?.focus({ preventScroll: true });
            enterOnOpen.current = false;
          } else if (menu.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
        };
        menu.addEventListener('toggle', toggle);
        return () => menu.removeEventListener('toggle', toggle);
      }, [nativePopover]);
      useEffect(() => {
        if (!open) return undefined;
        const outside = (event) => {
          if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
          close();
        };
        const reposition = () => position();
        document.addEventListener('focusin', outside);
        if (!nativePopover) document.addEventListener('pointerdown', outside, true);
        window.addEventListener('resize', reposition);
        document.addEventListener('scroll', reposition, true);
        return () => {
          document.removeEventListener('focusin', outside);
          document.removeEventListener('pointerdown', outside, true);
          window.removeEventListener('resize', reposition);
          document.removeEventListener('scroll', reposition, true);
        };
      }, [open]);
      const choose = (run) => () => { close(true); run(); };
      const itemProps = {
        type: 'button', className: 'skd-menuItem',
        role: nativeFocusGroup ? undefined : 'menuitem',
        tabIndex: nativeFocusGroup ? undefined : -1,
        onPointerMove: (event) => event.currentTarget.focus({ preventScroll: true, focusVisible: false }),
      };
      return el('div', { className: 'skd-menuWrap' },
        el(Button, {
          type: 'button', ref: triggerRef, id: id + '-trigger', className: 'skd-iconButton',
          'aria-label': menuLabel, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id,
          title: menuLabel, 'data-open': open ? '' : undefined,
          commandfor: nativePopover ? id : undefined, command: nativePopover ? 'toggle-popover' : undefined,
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); enter(); }
            if (event.key === 'Escape' && isOpen()) { event.preventDefault(); close(true); }
          },
          onClick: (event) => {
            enterOnOpen.current = event.detail === 0 && !isOpen();
            if (nativePopover && nativeInvoker) return;
            event.preventDefault();
            if (nativePopover) {
              if (isOpen()) close(true);
              else {
                // Explicit anchor works even on implementations without showPopover({source}).
                triggerRef.current.style.setProperty('anchor-name', '--' + id);
                menuRef.current.style.setProperty('position-anchor', '--' + id);
                menuRef.current.showPopover({ source: triggerRef.current });
              }
            } else setOpen((value) => !value);
          },
        }, el(OverflowGlyph, { size: 16 })),
        el('div', {
          ref: menuRef, id, className: 'skd-menu', popover: nativePopover ? 'auto' : undefined,
          hidden: nativePopover ? undefined : !open,
          'data-manual': nativePopover ? undefined : '',
          'data-position-fallback': !nativePopover || !nativeAnchor ? '' : undefined,
          onKeyDown: (event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
            if (event.key === 'Tab') { close(true); return; }
            const keys = nativeFocusGroup ? ['Home', 'End'] : ['ArrowDown', 'ArrowUp', 'Home', 'End'];
            if (!keys.includes(event.key)) return;
            const enabled = items();
            if (enabled.length === 0) return;
            event.preventDefault();
            const at = enabled.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
              : (at + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
            enabled[next]?.focus({ preventScroll: true });
          },
        }, el('div', {
          ref: groupRef, className: 'skd-menuGroup', focusgroup: 'menu nomemory',
          role: nativeFocusGroup ? undefined : 'menu', 'aria-labelledby': id + '-trigger',
        },
          canUpdate && el(Button, { ...itemProps, disabled, onClick: choose(onUpdate) }, t('skill.menu.update')),
          el(Button, { ...itemProps, 'data-danger': '', disabled, onClick: choose(onAskRemove) }, t('skill.menu.remove')),
          path !== '' && el(Button, { ...itemProps, onClick: choose(onTogglePath) }, t(pathShown ? 'skill.menu.hidePath' : 'skill.menu.showPath')),
        )),
      );
    }

    /** Safe, deliberately small Markdown reader: no HTML injection or remote resource loading. */
    function MarkdownPreview({ content }) {
      const lines = textOf(content).replace(/\r\n/g, '\n').split('\n');
      if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
        if (end > 0) lines.splice(0, end + 1);
      }
      const blocks = [];
      let paragraph = [], list = [], code = [], fence = false;
      const inline = (value, key) => value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
        part.startsWith('**') && part.endsWith('**') ? el('strong', { key: key + ':' + index }, part.slice(2, -2))
          : part.startsWith('`') && part.endsWith('`') ? el('code', { key: key + ':' + index }, part.slice(1, -1)) : part);
      const flush = () => {
        if (paragraph.length) { blocks.push(el('p', { key: 'p' + blocks.length }, inline(paragraph.join(' '), blocks.length))); paragraph = []; }
        if (list.length) { blocks.push(el('ul', { key: 'l' + blocks.length }, list.map((item, index) => el('li', { key: index }, inline(item, index))))); list = []; }
      };
      for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
          flush();
          if (fence) { blocks.push(el('pre', { key: 'c' + blocks.length }, el('code', null, code.join('\n')))); code = []; }
          fence = !fence; continue;
        }
        if (fence) { code.push(line); continue; }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
        if (heading) { flush(); blocks.push(el('h' + Math.min(heading[1].length + 2, 6), { key: 'h' + blocks.length }, inline(heading[2], blocks.length))); }
        else if (bullet) { if (paragraph.length) flush(); list.push(bullet[1]); }
        else if (line.trim() === '') flush();
        else { if (list.length) flush(); paragraph.push(line); }
      }
      flush();
      if (code.length) blocks.push(el('pre', { key: 'tail' }, el('code', null, code.join('\n'))));
      return el('div', { className: 'skd-prose' }, blocks);
    }

    /** Folder hierarchy uses native disclosures; full paths remain the file identities. */
    function previewFileTree(files) {
      const root = { name: '', path: '', children: new Map() };
      for (const entry of files) {
        const segments = textOf(entry.path).split('/').filter(Boolean);
        let node = root;
        segments.forEach((name, index) => {
          const path = segments.slice(0, index + 1).join('/');
          if (!node.children.has(name)) node.children.set(name, { name, path, children: new Map() });
          node = node.children.get(name);
          if (index === segments.length - 1) node.file = entry;
        });
      }
      const sorted = (node) => [...node.children.values()].sort((a, b) => Number(!a.children.size) - Number(!b.children.size) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      const fold = (node) => sorted(node).map((child) => ({ name: child.name, path: child.path, file: child.file, children: fold(child) }));
      return fold(root);
    }
    function PreviewFiles({ files, selected, onSelect, t }) {
      const tree = useMemo(() => previewFileTree(files), [files]);
      const render = (nodes, nested = false) => el('ul', { className: nested ? 'skd-treeChildren' : 'skd-fileList', role: 'list' }, nodes.map((node) => el('li', { key: node.path },
        node.children.length ? el('details', { className: 'skd-folder', open: true },
          el('summary', { className: 'skd-folderLabel', title: node.path },
            el(Glyph, { name: 'chevron', size: 12 }), el(Glyph, { name: 'folder', size: 16 }), el('span', null, node.name)),
          render(node.children, true))
          : el(Button, { className: 'skd-fileButton', 'aria-pressed': selected === node.path,
            'aria-label': node.path + (node.file?.kind === 'binary' ? ' ' + t('preview.binaryShort') : ''),
            onClick: () => onSelect(node.path), title: node.path },
            el(Glyph, { name: 'file', size: 16 }), el('span', null, node.name),
            node.file?.kind === 'binary' && el('span', { className: 'skd-fileKind', 'aria-hidden': true }, t('preview.binaryShort'))))));
      return render(tree);
    }

    const PREVIEW_MEMORY = new Map();
    const PREVIEW_MEMORY_TTL = 30_000;
    let previewWindowSize = null;
    const previewIdentity = (target) => target.path ? 'local:' + target.path : JSON.stringify([target.source, target.ref, target.name]);
    function previewMemoryEntry(key) {
      const entry = PREVIEW_MEMORY.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at > PREVIEW_MEMORY_TTL) { PREVIEW_MEMORY.delete(key); return null; }
      PREVIEW_MEMORY.delete(key); PREVIEW_MEMORY.set(key, entry);
      return entry;
    }
    function cachedPreview(key, path) {
      const entry = previewMemoryEntry(key);
      const file = entry?.contents.get(path || entry.defaultPath);
      return file ? { ...entry.summary, file } : null;
    }
    function rememberPreview(key, response) {
      const previous = PREVIEW_MEMORY.get(key);
      const summary = { ...(previous?.summary ?? {}), ...response };
      delete summary.file;
      const contents = previous?.contents ?? new Map();
      const file = objectOf(response.file);
      if (file && textOf(file.path)) {
        if (Array.isArray(summary.files)) summary.files = summary.files.map((entry) => entry.path === file.path ? { ...entry, size: file.size, kind: file.kind } : entry);
        contents.delete(file.path); contents.set(file.path, file);
        while (contents.size > 8) contents.delete(contents.keys().next().value);
      }
      const defaultPath = previous?.defaultPath || (Array.isArray(response.files) ? response.files.find((entry) => /(^|\/)skill\.md$/i.test(entry.path))?.path : '') || file?.path;
      const entry = { summary, contents, defaultPath, at: Array.isArray(response.files) ? Date.now() : previous?.at ?? Date.now() };
      PREVIEW_MEMORY.delete(key); PREVIEW_MEMORY.set(key, entry);
      while (PREVIEW_MEMORY.size > 6) PREVIEW_MEMORY.delete(PREVIEW_MEMORY.keys().next().value);
      return { ...summary, file };
    }

    /** Native dialog is created outside React's managed DOM; React owns only its portal contents. */
    function SkillPreview({ target, t, runtimes, onClose }) {
      const [dialog, setDialog] = useState(null);
      const [file, setFile] = useState('');
      const [mode, setMode] = useState('read');
      const [retry, setRetry] = useState(0);
      const identity = previewIdentity(target);
      const [snapshot, setSnapshot] = useState(() => {
        const cached = cachedPreview(identity, '');
        return { status: cached ? 'ready' : 'loading', data: cached, error: null };
      });
      const [maximized, setMaximized] = useState(false);
      const [filesExpanded, setFilesExpanded] = useState(false);
      const filesToggleRef = useRef(null);
      const normalSize = useRef(null);
      const refreshPreview = useRef(false);
      const closeRef = useRef(onClose);
      closeRef.current = onClose;
      const titleId = 'skd-preview-title-' + useId();
      useEffect(() => {
        const node = document.createElement('dialog');
        node.className = 'skd-previewDialog';
        node.setAttribute('aria-labelledby', titleId);
        node.setAttribute('closedby', 'closerequest');
        const closed = () => closeRef.current();
        node.addEventListener('close', closed);
        document.body.appendChild(node);
        setDialog(node);
        if (previewWindowSize && window.innerWidth > 700) {
          node.style.width = Math.min(previewWindowSize.width, window.innerWidth - 24) + 'px';
          node.style.height = Math.min(previewWindowSize.height, window.innerHeight - 24) + 'px';
        }
        node.showModal();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
          if (!node.hasAttribute('data-maximized') && window.innerWidth > 700) {
            const rect = node.getBoundingClientRect();
            previewWindowSize = { width: rect.width, height: rect.height };
          }
        }) : null;
        observer?.observe(node);
        return () => {
          observer?.disconnect();
          node.removeEventListener('close', closed);
          if (node.open) node.close();
          node.remove();
        };
      }, []);
      useEffect(() => {
        const force = refreshPreview.current;
        refreshPreview.current = false;
        if (force) PREVIEW_MEMORY.delete(identity);
        const cached = force ? null : cachedPreview(identity, file);
        if (cached) { setSnapshot({ status: 'ready', data: cached, error: null }); return; }
        let active = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        setSnapshot((current) => ({ status: 'loading', data: current.data, error: null }));
        const options = { ...(file ? { file } : {}), ...(force ? { refresh: true } : {}), ...(previewMemoryEntry(identity) ? { fileOnly: true } : {}) };
        const body = target.path ? { path: target.path, ...options }
          : { source: target.source, ref: target.ref, name: target.name, ...options };
        fetch(ROUTE_PREVIEW, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
          .then(async (response) => {
            const data = await response.json().catch(() => null);
            if (!active) return;
            if (!response.ok || !data || data.ok !== true) {
              if (file && data?.code === 'file-not-found') {
                PREVIEW_MEMORY.delete(identity);
                setFile('');
                return;
              }
              setSnapshot((current) => ({ status: 'error', data: current.data, error: { code: data?.code ?? (response.status === 404 ? 'preview-unavailable' : 'preview-failed') } }));
              return;
            }
            setSnapshot({ status: 'ready', data: rememberPreview(identity, data), error: null });
          }).catch(() => { if (active) setSnapshot((current) => ({ status: 'error', data: current.data, error: { code: 'preview-failed' } })); })
          .finally(() => clearTimeout(timeout));
        return () => { active = false; clearTimeout(timeout); controller.abort(); };
      }, [target, file, retry]);
      const changeSize = (step) => {
        if (!dialog) return;
        const rect = dialog.getBoundingClientRect();
        dialog.removeAttribute('data-maximized'); setMaximized(false);
        dialog.style.width = Math.min(window.innerWidth - 24, Math.max(Math.min(680, window.innerWidth - 24), rect.width + step * 120)) + 'px';
        dialog.style.height = Math.min(window.innerHeight - 24, Math.max(Math.min(400, window.innerHeight - 24), rect.height + step * 80)) + 'px';
      };
      const toggleMaximized = () => {
        if (!dialog) return;
        if (maximized) {
          dialog.removeAttribute('data-maximized');
          if (normalSize.current) { dialog.style.width = normalSize.current.width + 'px'; dialog.style.height = normalSize.current.height + 'px'; }
        } else {
          const rect = dialog.getBoundingClientRect(); normalSize.current = { width: rect.width, height: rect.height };
          dialog.style.width = ''; dialog.style.height = ''; dialog.setAttribute('data-maximized', '');
        }
        setMaximized(!maximized);
      };
      const data = objectOf(snapshot.data);
      const skill = objectOf(data?.skill) ?? target;
      const selected = objectOf(data?.file);
      const files = useMemo(() => Array.isArray(data?.files) ? data.files.filter((entry) => objectOf(entry) && textOf(entry.path)) : [], [data?.files]);
      const markdown = /\.(md|markdown)$/i.test(textOf(selected?.path));
      const name = textOf(skill.name) || textOf(target.title) || textOf(target.name);
      // The detected coding agents that read this skill, by their own titles.
      const agentTitles = stringsOf(skill.runtimes).map((id) => {
        const runtime = (Array.isArray(runtimes) ? runtimes : []).map(objectOf).find((entry) => entry !== null && textOf(entry.id) === id);
        return textOf(runtime?.title) !== '' ? textOf(runtime.title) : id;
      });
      const errorKey = 'error.' + textOf(snapshot.error?.code);
      const error = t(errorKey) !== errorKey ? t(errorKey) : t('preview.failed');
      const selectFile = (path) => {
        setFile(path);
        if (window.matchMedia('(max-width: 700px)').matches) {
          filesToggleRef.current?.focus({ preventScroll: true });
          setFilesExpanded(false);
        }
      };
      if (!dialog) return null;
      return createPortal(el('div', { className: 'skd-page skd-previewRoot' },
        el('header', { className: 'skd-previewHeader' },
          el('div', { className: 'skd-previewIdentity' },
            el('span', { className: 'skd-previewEyebrow' }, t('preview.title')),
            el('h2', { id: titleId, className: 'skd-previewTitle' }, name),
            el('p', { className: 'skd-previewDescription' }, textOf(skill.description) || textOf(target.description)),
            el('div', { className: 'skd-badges' },
              textOf(skill.source) && el(Badge, null, skill.source === 'tencent' ? t('source.tencent') : textOf(skill.source)),
              skill.readonly === true && el(Badge, { 'data-tone': 'muted' }, t('skill.readonly')),
              textOf(skill.version) && el(Badge, null, t('discover.version', { version: skill.version }))),
          ),
          el('div', { className: 'skd-windowTools' },
            el(Button, { className: 'skd-iconButton', 'aria-label': t('preview.refresh'), title: t('preview.refresh'), onClick: () => {
              refreshPreview.current = true;
              setRetry((value) => value + 1);
            } }, el(Glyph, { name: 'refresh', size: 16 })),
            el(Button, { className: 'skd-iconButton skd-sizeStep', 'aria-label': t('preview.shrink'), title: t('preview.shrink'), onClick: () => changeSize(-1) }, el(Glyph, { name: 'minus', size: 16 })),
            el(Button, { className: 'skd-iconButton skd-sizeStep', 'aria-label': t('preview.grow'), title: t('preview.grow'), onClick: () => changeSize(1) }, el(Glyph, { name: 'plus', size: 16 })),
            el(Button, { className: 'skd-iconButton skd-sizeStep', 'aria-label': t(maximized ? 'preview.restore' : 'preview.maximize'), title: t(maximized ? 'preview.restore' : 'preview.maximize'), onClick: toggleMaximized },
              el(Glyph, { name: maximized ? 'restore' : 'maximize', size: 16 })),
            el('form', { method: 'dialog' }, el(Button, {
              type: 'submit', autoFocus: true, className: 'skd-iconButton', 'aria-label': t('preview.close'), title: t('preview.close'),
            }, el(Glyph, { name: 'close', size: 20 })))), 
        ),
        el('div', { className: 'skd-previewLayout', 'data-files-expanded': filesExpanded ? '' : undefined },
          el(Button, {
            className: 'skd-button skd-previewFilesToggle', ref: filesToggleRef,
            'aria-expanded': filesExpanded, 'aria-controls': titleId + '-files',
            onClick: () => setFilesExpanded((value) => !value),
          }, el(Glyph, { name: 'folder', size: 16 }), t('preview.files'), el('span', { className: 'skd-micro' }, formatNumber(files.length))),
          el('aside', { className: 'skd-previewFiles', id: titleId + '-files', 'aria-label': t('preview.files') },
            el('div', { className: 'skd-previewFilesHead' }, el('h3', null, t('preview.files')),
              el('span', { className: 'skd-micro' }, String(files.length))),
            files.length > 0 && el(PreviewFiles, { files, selected: file || selected?.path, onSelect: selectFile, t }),
            !target.path && el('p', { className: 'skd-noteLine skd-previewNotice' }, t('preview.remoteNotice')),
            data?.truncatedFiles === true && el('p', { className: 'skd-noteLine skd-previewNotice' }, t('preview.filesLimited')),
            snapshot.status !== 'loading' && files.length === 0 && el('p', { className: 'skd-noteLine skd-previewNotice' }, t('preview.noFiles')),
          ),
          el('section', { className: 'skd-previewViewer', 'aria-label': t('preview.content'), 'aria-busy': snapshot.status === 'loading' },
            el('div', { className: 'skd-previewViewerHead' },
              el('span', { className: 'skd-previewFilename' }, file || textOf(selected?.path) || t('preview.instructions')),
              selected?.kind === 'text' && markdown && el(Segmented, {
                value: mode, label: t('preview.view'), onChange: setMode,
                items: [{ id: 'read', label: t('preview.read') }, { id: 'source', label: t('preview.source') }],
              })),
            snapshot.status === 'loading' ? el('div', { className: 'skd-previewMessage', role: 'status' }, t('preview.loading'))
              : snapshot.status === 'error' ? el('div', { className: 'skd-previewMessage', role: 'alert' },
                el('p', null, error), el(Button, { onClick: () => setRetry((value) => value + 1) }, t('action.retry')))
                : selected?.kind === 'text' ? el('div', { className: 'skd-previewContent' },
                  selected.truncated === true && el('p', { className: 'skd-previewNotice', role: 'note' }, t('preview.truncated')),
                  textOf(selected.content) === '' ? el('p', { className: 'skd-noteLine' }, t('preview.emptyFile'))
                    : markdown && mode === 'read' ? el(MarkdownPreview, { content: selected.content })
                      : el('pre', { className: 'skd-fileCode', tabIndex: 0, 'aria-label': textOf(selected.path) }, el('code', null, textOf(selected.content))))
                  : el('div', { className: 'skd-previewMessage' }, t(selected?.kind === 'binary' ? 'preview.binary' : 'preview.unavailable')),
          ),
        ),
        el('footer', { className: 'skd-previewFooter' },
          el('span', { title: textOf(skill.path) || textOf(target.ref) }, textOf(skill.path) || textOf(target.ref) || name),
          agentTitles.length > 0 && el('span', { title: agentTitles.join(' · ') }, agentTitles.join(' · ')),
          el('span', null, t('preview.readOnlyNotice'))),
      ), dialog);
    }

    /** One installed skill: identity, description, calls, both switches, and its menu. */
    function SkillRow(props) {
      const {
        skill, t, frequent, busy, writesLocked, pathShown, confirming, runtimes,
        onToggle, onUpdate, onAskRemove, onConfirmRemove, onCancelRemove, onTogglePath, onPreview,
      } = props;
      const name = textOf(skill?.name) !== '' ? textOf(skill.name) : '—';
      const path = textOf(skill?.path);
      const source = textOf(skill?.source);
      const description = textOf(skill?.description);
      const badge = runtimeBadge(skill, runtimes);
      const usage = objectOf(skill?.usage);
      const calls = countOf(usage?.count);
      const byModel = countOf(usage?.byModel);
      const byUser = countOf(usage?.byUser);
      const writable = skill?.writable === true;
      const modelInvocable = skill?.modelInvocable === true;
      const userInvocable = skill?.userInvocable === true;
      const closed = modelInvocable === false && userInvocable === false;
      // Update is offered only with both a writable file and Host-known provenance.
      const canUpdate = writable === true && objectOf(skill?.installed) !== null;
      const menuTriggerRef = useRef(null);
      const cancelRef = useRef(null);
      const confirmId = 'skd-confirm-' + useId();
      useEffect(() => { if (confirming) cancelRef.current?.focus({ preventScroll: true }); }, [confirming]);
      const cancel = () => { onCancelRemove(); menuTriggerRef.current?.focus({ preventScroll: true }); };

      return el('article', {
        className: 'skd-row',
        'aria-label': name,
        'data-closed': modelInvocable === false ? '' : undefined,
        'data-busy': busy === true ? '' : undefined,
        'aria-busy': busy === true || undefined,
      },
        el('div', { className: 'skd-rowMain' },
          el('div', { className: 'skd-rowHead' },
            el(Button, { className: 'skd-rowName skd-nameButton', title: t('preview.open', { name }),
              'aria-label': t('preview.open', { name }), onClick: () => onPreview(skill) }, name),
            el('div', { className: 'skd-badges' },
              source !== '' && el(Badge, { className: 'skd-badge' }, source),
              badge.kind === 'one' && el(Badge, { className: 'skd-badge' }, t('skill.runtimesOne', { agent: badge.agent })),
              badge.kind === 'some' && el(Badge, { className: 'skd-badge', title: badge.title },
                t('skill.runtimesSome', { count: badge.count, total: badge.total })),
              frequent && el(Badge, { className: 'skd-badge', 'data-tone': 'accent' }, t('skill.frequent')),
              closed && el(Badge, { className: 'skd-badge', 'data-tone': 'muted' }, t('skill.closed')),
              writable === false && el(Badge, { className: 'skd-badge', 'data-tone': 'muted' }, t('skill.readonly')),
            ),
          ),
          description !== '' && el('p', { className: 'skd-rowDesc', title: description }, description),
        ),
        el('div', { className: 'skd-rowRail' },
          el('div', { className: 'skd-metric' },
            // The micro label turns into the saving note while this row awaits its Host answer.
            el('span', { className: 'skd-micro' }, busy === true ? t('skill.busy') : t('skill.callsLabel')),
            el('span', {
              className: 'skd-metricValue',
              title: t('skill.usageTitle', { count: calls, model: byModel, user: byUser }),
            }, el('span', { 'aria-hidden': true }, String(calls)),
            el('span', { className: 'skd-visuallyHidden' }, t('skill.usageTitle', { count: calls, model: byModel, user: byUser }))),
          ),
          el('div', { className: 'skd-switchGroup' },
            el('div', { className: 'skd-switchRow' },
              el(Switch, {
                checked: modelInvocable,
                disabled: writable === false || writesLocked,
                busy,
                label: t('skill.modelSwitchAria', { name }),
                onChange: (next) => onToggle(skill, { modelInvocable: next }),
              }, t('skill.model')),
            ),
            el('div', { className: 'skd-switchRow' },
              el(Switch, {
                checked: userInvocable,
                disabled: writable === false || writesLocked,
                busy,
                label: t('skill.userSwitchAria', { name }),
                onChange: (next) => onToggle(skill, { userInvocable: next }),
              }, t('skill.user')),
            ),
          ),
          el(RowMenu, {
            returnFocusRef: menuTriggerRef,
            skill,
            t,
            name,
            disabled: writable === false || writesLocked,
            canUpdate,
            pathShown,
            onUpdate: () => onUpdate(skill),
            onAskRemove: () => onAskRemove(skill),
            onTogglePath: () => onTogglePath(path),
          }),
        ),
        pathShown && el('div', { className: 'skd-path' },
          el('span', { className: 'skd-micro' }, t('skill.path')),
          el('code', { className: 'skd-pathValue' }, path),
        ),
        confirming && el('div', {
          className: 'skd-confirm', role: 'group', 'aria-label': t('skill.menu.remove'), 'aria-describedby': confirmId,
          onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } },
        },
          el('span', { id: confirmId, className: 'skd-confirmText' }, t('skill.removeConfirm', { name })),
          el(Button, {
            type: 'button',
            className: 'skd-button',
            'data-variant': 'danger',
            disabled: writesLocked,
            onClick: (event) => {
              const item = event.currentTarget.closest('li');
              const next = (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector('.skd-nameButton');
              onConfirmRemove(skill, next);
            },
          }, t('skill.removeConfirmAction')),
          el(Button, {
            type: 'button',
            className: 'skd-button',
            ref: cancelRef,
            onClick: cancel,
          }, t('action.cancel')),
        ),
      );
    }

    /** The installed list: a row per skill, muted once the model can no longer call it. */
    function InstalledTab(props) {
      const {
        skills, t, frequentRule, pending, filtered, runtimes, onReset, onDiscover,
        expandedPath, confirmingPath, onToggle, onUpdate, onAskRemove, onConfirmRemove, onCancelRemove, onTogglePath, onPreview,
      } = props;

      if (skills.length === 0) {
        return el('div', { className: 'skd-empty' },
          el('span', { className: 'skd-stateIcon' }, el(Glyph, { name: 'search', size: 24 })),
          el('h3', { className: 'skd-stateTitle' }, t(filtered ? 'installed.noMatches' : 'skill.empty.title')),
          el('p', { className: 'skd-stateBody' }, t(filtered ? 'installed.noMatchesBody' : 'skill.empty.body')),
          el('div', { className: 'skd-stateActions' }, el(Button, {
            type: 'button', className: 'skd-button', onClick: filtered ? onReset : onDiscover,
          }, t(filtered ? 'installed.reset' : 'action.discover'))),
        );
      }

      // li contains the article and controls, preserving list count and interactive semantics.
      return el('ul', { className: 'skd-list', role: 'list' }, skills.map((skill) => {
        const path = textOf(skill?.path);
        const name = textOf(skill?.name);
        const calls = countOf(objectOf(skill?.usage)?.count);
        const busy = pending !== null && (
          (pending.kind === 'invocation' && textOf(pending.target) === path)
          || ((pending.kind === 'update' || pending.kind === 'remove') && textOf(pending.target) === name)
        );
        return el('li', { key: path !== '' ? path : 'name:' + name }, el(SkillRow, {
          skill,
          t,
          runtimes,
          frequent: frequentRule.active === true
            && calls >= MIN_FREQUENT_CALLS
            && calls >= frequentRule.threshold,
          busy,
          writesLocked: pending !== null,
          pathShown: path !== '' && expandedPath === path,
          confirming: path !== '' && confirmingPath === path,
          onToggle,
          onUpdate,
          onAskRemove,
          onConfirmRemove,
          onCancelRemove,
          onTogglePath,
          onPreview,
        }));
      }));
    }

    /**
     * One discover result with its one-click install. The heading is the display title
     * when the source sends one (Tencent sends a Chinese name), and the install identity
     * (`name`, the kebab slug) always appears as the mono sub-label, so a card can never
     * hide what would actually be installed.
     */
    function DiscoverCard({ item, t, installing, writesLocked, onInstall, onPreview }) {
      const slug = textOf(item?.name);
      const heading = textOf(item?.title) !== '' ? textOf(item.title) : slug !== '' ? slug : '—';
      const description = textOf(item?.description);
      const ref = textOf(item?.ref);
      const version = textOf(item?.version);
      const updatedAt = textOf(item?.updatedAt);
      const installs = countOf(item?.installs);
      const installed = item?.installed === true;
      // Some entries cannot be installed at all (a domain-like skills.sh source is not
      // "owner/repo"). The Host says so before the click; the button carries that reason
      // instead of letting the install fail. A Host that sends no flag stays installable.
      const blocked = item?.installable === false;
      const reason = textOf(item?.installableReason) !== '' ? textOf(item.installableReason) : t('discover.notInstallable');
      const buttonLabel = installed || installing
        ? t(installed ? 'discover.installed' : 'discover.installing') + ' · ' + heading
        : blocked ? t('discover.installBlockedAria', { name: heading, reason })
          : t('discover.installAria', { name: heading });
      return el(Card, { className: 'skd-card' },
        el('div', { className: 'skd-cardHead' },
          el('div', { className: 'skd-cardIdentity' },
            el('span', { className: 'skd-skillMark', 'aria-hidden': true }, el(Glyph, { name: 'library', size: 18 })),
            el('div', { className: 'skd-cardTitleWrap' }, el('h3', { className: 'skd-cardName' }, el(Button, {
              className: 'skd-nameButton', title: t('preview.open', { name: heading }),
              'aria-label': t('preview.open', { name: heading }), onClick: () => onPreview(item),
            }, heading)))),
          version !== '' && el('span', { className: 'skd-cardVersion' }, t('discover.version', { version })),
        ),
        description !== '' && el('p', { className: 'skd-cardDesc', title: description }, description),
        blocked && el('p', { className: 'skd-noteLine' }, reason),
        el('div', { className: 'skd-cardFoot' },
          el('div', { className: 'skd-metaList' },
            ref !== '' && el('span', { className: 'skd-slug', title: ref }, ref),
            slug !== '' && slug !== ref && el('span', { className: 'skd-slug', title: slug }, slug),
            installs > 0 && el('span', { className: 'skd-cardDownloads' }, t('discover.installs', { count: formatNumber(installs) })),
            updatedAt !== '' && el('span', { className: 'skd-micro' }, t('discover.updated', { date: updatedAt })),
          ),
          el(Button, {
            type: 'button', className: 'skd-button',
            'data-variant': 'outline',
            'data-done': installed ? '' : undefined,
            'aria-label': buttonLabel, 'aria-busy': installing || undefined,
            title: blocked ? buttonLabel : undefined,
            disabled: installed || blocked || writesLocked,
            onClick: () => onInstall(item),
          }, !installed && !installing && !blocked && el(Glyph, { name: 'plus', size: 14 }),
          installed ? t('discover.installed') : installing ? t('discover.installing') : t('discover.install')),
        ),
      );
    }

    /** Discover: pick a source, search it, install a result; every state is explicit. */
    function DiscoverTab(props) {
      const { t, discover, sources, queryDraft, onDraft, onSearch, onRetry, onSelectSource, onInstall, onPreview, pending } = props;
      const items = Array.isArray(discover.items) ? discover.items : [];
      const error = objectOf(discover.error);
      const note = discoverNoteOf(discover.note, t);
      const other = sources.find((source) => source.id !== discover.source && source.disabled === false);
      const sourceLabel = sources.find((source) => source.id === discover.source)?.label ?? textOf(discover.source);
      const submittedQuery = textOf(discover.query);
      const resultScope = submittedQuery !== ''
        ? t('discover.queryScope', { source: sourceLabel, query: submittedQuery })
        : sourceLabel;
      const installingName = pending !== null && pending.kind === 'install' ? textOf(pending.target) : '';
      const searchId = 'skd-discover-query-' + useId();

      let body;
      if (discover.status === 'loading') {
        body = el('div', { className: 'skd-state', 'aria-busy': true },
          el('h3', { className: 'skd-stateTitle' }, t('discover.loading')),
          el('div', { className: 'skd-skeleton' },
            el('div', { className: 'skd-skeletonRow' }),
            el('div', { className: 'skd-skeletonRow' }),
            el('div', { className: 'skd-skeletonRow' }),
          ),
        );
      } else if (discover.status === 'error') {
        body = el('div', { className: 'skd-state', role: 'alert' },
          el('h3', { className: 'skd-stateTitle' }, t('discover.error.title')),
          el('p', { className: 'skd-stateBody' },
            error !== null && error.offline === true
              ? t('status.offlineInline')
              : describeFailure(error?.code ?? null, error?.message ?? null, t),
          ),
          el('p', { className: 'skd-stateBody' }, resultScope),
          el('div', { className: 'skd-stateActions' },
            other !== undefined && el(Button, {
              type: 'button',
              className: 'skd-button',
              onClick: () => onSelectSource(other.id),
            }, t('discover.otherSource', { source: other.label })),
            el(Button, {
              type: 'button',
              className: 'skd-button',
              onClick: onRetry,
            }, t('action.retry')),
          ),
        );
      } else if (discover.status === 'ready' && items.length === 0) {
        body = el('div', { className: 'skd-state' },
          el('h3', { className: 'skd-stateTitle' }, t('discover.empty.title')),
          el('p', { className: 'skd-stateBody' }, t('discover.empty.body')),
        );
      } else if (discover.status === 'ready') {
        body = el('div', { className: 'skd-cardList' }, items.map((item) => {
          const key = textOf(item?.id) !== '' ? textOf(item.id) : textOf(item?.name);
          return el(DiscoverCard, {
            key,
            item,
            t,
            installing: installingName !== '' && textOf(item?.name) === installingName,
            writesLocked: pending !== null,
            onInstall: (entry) => onInstall(entry, discover.source),
            onPreview: (entry) => onPreview({ ...entry, source: discover.source }),
          });
        }));
      } else if (!sources.some((source) => !source.disabled)) {
        body = el('div', { className: 'skd-state' },
          el('h3', { className: 'skd-stateTitle' }, t('discover.unavailableTitle')),
          el('p', { className: 'skd-stateBody' }, t('discover.unavailableBody')),
        );
      } else {
        body = el('div', { className: 'skd-state' },
          el('span', { className: 'skd-stateIcon' }, el(Glyph, { name: 'search', size: 24 })),
          el('h3', { className: 'skd-stateTitle' }, t('discover.idle.title')),
          el('p', { className: 'skd-stateBody' }, t('discover.idle.body')),
          el('div', { className: 'skd-stateActions' }, el(Button, {
            type: 'button', className: 'skd-button', disabled: discover.source === null,
            onClick: () => onSearch(''),
          }, t('discover.popular'))),
        );
      }

      return el('div', { className: 'skd-panel' },
        el(SectionHeading, { title: t('discover.title'), body: t('discover.body') }),
        el('search', { 'aria-label': t('discover.searchLabel') },
          el('form', {
            className: 'skd-searchRow', action: ROUTE_DISCOVER, method: 'post', 'aria-label': t('discover.searchLabel'),
            onSubmit: (event) => {
              event.preventDefault();
              if (discover.source !== null && discover.status !== 'loading') onSearch();
            },
          },
          sources.length > 0 && el('div', { className: 'skd-sourceField' },
            el('span', { className: 'skd-fieldLabel' }, t('discover.source')),
            el(Segmented, {
            items: sources.map((source) => ({
              id: source.id,
              label: source.label,
              title: source.note,
              disabled: source.disabled,
            })),
            value: discover.source,
            label: t('discover.source'),
            onChange: onSelectSource,
          })),
          el(Input, { type: 'hidden', name: 'source', value: textOf(discover.source) }),
          el('div', { className: 'skd-searchField' },
            el('label', { className: 'skd-fieldLabel', htmlFor: searchId }, t('discover.searchLabel')),
            el('div', { className: 'skd-searchBox' }, el(Glyph, { name: 'search' }), el(Input, {
              id: searchId, name: 'query', className: 'skd-input', type: 'search', value: queryDraft,
              placeholder: t('discover.placeholder'), autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'search',
              disabled: discover.source === null,
              onChange: (event) => onDraft(event.target.value),
              onKeyDown: (event) => {
                // Let normal Enter use native form submission; suppress only IME confirmation.
                if (event.key === 'Enter' && (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229)) event.preventDefault();
              },
            }))),
          el(Button, {
            type: 'submit', className: 'skd-button', 'data-variant': 'primary',
            disabled: discover.source === null || discover.status === 'loading',
          }, t('action.search')),
        )),
        discover.status === 'ready' && el('div', { className: 'skd-resultLine skd-discoverResults', role: 'status' },
          el('span', null, resultScope),
          el('span', null, t('discover.results', { count: items.length }))),
        // A Host hint about how these results were chosen (an empty query falls back to a listing).
        discover.status === 'ready' && note !== '' && el('p', { className: 'skd-noteLine', role: 'note' }, note),
        body,
      );
    }

    // Date-labelled retained counts drive period views; cumulative totals remain separate.
    function usageValidDay(value) {
      const date = parseDay(value);
      return date !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        date.getFullYear() === Number(value.slice(0, 4)) &&
        date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
    }
    function usageShiftDay(value, offset) {
      const date = parseDay(value);
      if (date === null) return '';
      date.setDate(date.getDate() + offset);
      return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    }
    function usageDatedCounts(values) {
      const counts = new Map();
      for (const value of Array.isArray(values) ? values : []) {
        const bucket = objectOf(value);
        if (bucket && usageValidDay(bucket.date)) counts.set(bucket.date, countOf(bucket.count));
      }
      return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([date, count]) => ({ date, count }));
    }
    /** Pure projection: query affects rows only; selected affects trend only; summaries cover all skills. */
    function usagePeriodProjection(data, { period = '7', start = '', end = '', query = '', selected = '' } = {}) {
      const root = objectOf(data) || {};
      const usage = objectOf(root.usage) || {};
      const newHost = Array.isArray(usage.history);
      const rawHistory = newHost ? usage.history : usage.dayBuckets;
      const history = usageDatedCounts(rawHistory);
      const min = history[0]?.date || '';
      const max = history[history.length - 1]?.date || '';
      const days = ['1', '7', '14', '30', '60'].includes(String(period)) ? Number(period) : 7;
      const requestedStart = period === 'custom' ? start : max ? usageShiftDay(max, 1 - days) : '';
      const requestedEnd = period === 'custom' ? end : max;
      let error = '';
      if (!max) error = 'unavailable';
      else if (period === 'custom') {
        if (!start || !end) error = 'required';
        else if (!usageValidDay(start) || !usageValidDay(end)) error = 'invalid';
        else if (start > end) error = 'order';
        else if (start < min || end > max) error = 'bounds';
      }
      const from = requestedStart < min ? min : requestedStart;
      const to = requestedEnd;
      const bounded = !error && requestedStart < min;
      const buckets = error ? [] : history.filter((bucket) => bucket.date >= from && bucket.date <= to);
      const installed = (Array.isArray(root.skills) ? root.skills : []).map(objectOf).filter(Boolean);
      const catalog = new Set(installed.map((skill) => textOf(skill.name)).filter(Boolean));
      const stored = newHost ? (Array.isArray(usage.skillUsage) ? usage.skillUsage : Array.isArray(root.skillUsage) ? root.skillUsage : []) : [];
      const records = new Map();
      for (const value of stored) {
        const record = objectOf(value);
        const name = textOf(record?.name);
        if (name && (catalog.has(name) || countOf(record.count) > 0)) records.set(name, record);
      }
      for (const skill of installed) {
        const name = textOf(skill.name);
        if (!name || records.has(name)) continue;
        const legacy = objectOf(skill.usage) || {};
        // New Host data is authoritative; never substitute the old numeric days for it.
        const dayBuckets = !newHost && Array.isArray(legacy.days) && Array.isArray(rawHistory)
          ? rawHistory.map((bucket, index) => ({ date: objectOf(bucket)?.date, count: legacy.days[index] })) : [];
        records.set(name, { name, ...(!newHost ? legacy : {}), dayBuckets });
      }
      const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      const allRows = [...records].map(([name, record]) => {
        const dated = usageDatedCounts(record.dayBuckets);
        const count = error ? 0 : dated.reduce((sum, bucket) => sum + (bucket.date >= from && bucket.date <= to ? bucket.count : 0), 0);
        return { name, count, share: total > 0 ? count / total : 0, removed: !catalog.has(name),
          lastUsedAt: countOf(record.lastUsedAt), buckets: buckets.map((bucket) => ({ date: bucket.date, count: dated.find((day) => day.date === bucket.date)?.count || 0 })) };
      });
      const needle = textOf(query).trim().toLocaleLowerCase();
      const rows = allRows.filter((row) => row.name.toLocaleLowerCase().includes(needle));
      const selectedRow = allRows.find((row) => row.name === selected);
      const trend = selectedRow ? selectedRow.buckets : buckets;
      return { newHost, min, max, from, to, requestedStart, requestedEnd, error, bounded, buckets, trend,
        total, active: allRows.filter((row) => row.count > 0).length, rows, allRows,
        selected: selectedRow?.name ?? '',
        trendTotal: trend.reduce((sum, bucket) => sum + bucket.count, 0),
        peak: trend.reduce((peak, bucket) => Math.max(peak, bucket.count), 0) };
    }

    function UsageTab({ data, t, view, setView }) {
      const id = 'skd-period-' + useId();
      const { period, start, end, query, sort } = view;
      const trendHeading = useRef(null);
      const focusTrend = useRef(false);
      useLayoutEffect(() => {
        if (!focusTrend.current) return;
        focusTrend.current = false;
        trendHeading.current?.focus({ preventScroll: true });
        trendHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }, [view]);
      const p = usagePeriodProjection(data, view);
      const updateView = (fields) => setView((current) => ({ ...current, ...fields }));
      const changePeriod = (value) => setView((current) => ({
        ...current,
        period: value,
        ...(value === 'custom' ? { start: current.start || p.from || p.min, end: current.end || p.max } : {}),
      }));
      const selectFromTable = (name) => {
        focusTrend.current = true;
        updateView({ selected: name });
      };
      const usage = objectOf(objectOf(data)?.usage) || {};
      const agents = Array.isArray(data?.agents) ? data.agents : [];
      const recent = (Array.isArray(usage.recent) ? usage.recent : []).map(objectOf).filter(Boolean);
      const collator = useMemo(() => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }), []);
      const rows = [...p.rows].sort((a, b) => {
        const comparison = sort.key === 'name' ? collator.compare(a.name, b.name) : a[sort.key] - b[sort.key];
        return (sort.direction === 'ascending' ? 1 : -1) * comparison || collator.compare(a.name, b.name);
      });
      const switchSort = (key) => setView((current) => ({
        ...current,
        sort: { key, direction: current.sort.key === key && current.sort.direction === 'ascending' ? 'descending' : 'ascending' },
      }));
      const range = p.from && p.to ? p.from + ' – ' + p.to : '—';
      const subject = p.selected || t('usage.allSkills');
      const axes = p.trend.filter((_, index) => index === 0 || index === Math.floor((p.trend.length - 1) / 2) || index === p.trend.length - 1);
      const number = (value) => p.error ? '—' : formatNumber(value);
      const field = (name, label, control) => {
        const controlId = id + '-' + name;
        return el('div', { className: 'skd-field skd-periodField' },
          el('label', { htmlFor: controlId }, label), React.cloneElement(control, { id: controlId }));
      };
      const select = (value, onChange, options) => el('select', { className: 'skd-select', value, onChange: (event) => onChange(event.target.value) },
        options.map(([value, label]) => el('option', { key: value, value }, label)));
      const agentTitle = (value) => {
        const agent = agents.map(objectOf).find((entry) => entry && textOf(entry.id) === textOf(value));
        return textOf(agent?.title) || textOf(value) || t('usage.unknownAgent');
      };
      const heading = (key, label) => el('th', { scope: 'col', 'aria-sort': sort.key === key ? sort.direction : undefined },
        el(Button, { className: 'skd-periodSort', onClick: () => switchSort(key) }, el('span', null, label),
          el('span', { 'aria-hidden': true }, sort.key === key ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕')));
      return el('div', { className: 'skd-panel skd-usagePanel' },
        el(SectionHeading, { title: t('usage.title'), body: t('usage.periodBody') }),
        el('div', { className: 'skd-toolbar skd-periodControls' },
          field('period', t('usage.period'), select(period, changePeriod,
            [['1', t('usage.period.today')], ['7', t('usage.period.7')], ['14', t('usage.period.14')], ['30', t('usage.period.30')], ['60', t('usage.period.60')], ['custom', t('usage.period.custom')]])),
          period === 'custom' && field('start', t('usage.startDate'), el(Input, { type: 'date', value: start, min: p.min, max: p.max, required: true,
            'aria-invalid': Boolean(p.error), 'aria-describedby': id + '-validation', onChange: (event) => updateView({ start: event.target.value }) })),
          period === 'custom' && field('end', t('usage.endDate'), el(Input, { type: 'date', value: end, min: start && start >= p.min ? start : p.min, max: p.max, required: true,
            'aria-invalid': Boolean(p.error), 'aria-describedby': id + '-validation', onChange: (event) => updateView({ end: event.target.value }) })),
          el('p', { className: 'skd-noteLine skd-periodRange' }, t('usage.availableRange', { start: p.min || '—', end: p.max || '—' })),
          el('p', { id: id + '-validation', className: 'skd-noteLine skd-periodValidation', role: 'status' },
            p.error ? t('usage.rangeError.' + p.error, { start: p.min, end: p.max }) : p.bounded ? t('usage.boundedRange', { start: p.min, end: p.max }) : ''),
        ),
        el('div', { className: 'skd-stats' },
          [[t('usage.periodCalls'), p.total, range], [t('usage.periodActive'), p.active, t('usage.periodActiveHint')], [t('usage.total'), countOf(usage.totalCount), t('usage.totalHint')]].map(([label, value, hint], index) =>
            el('div', { className: 'skd-statCard', key: label }, el('span', { className: 'skd-micro' }, label),
              el('span', { className: 'skd-statValue' }, index === 2 ? formatNumber(value) : number(value)), el('span', { className: 'skd-statHint' }, hint)))),
        el('figure', { className: 'skd-panelCard', id: id + '-trend' },
          el('figcaption', { className: 'skd-cardTitleRow' },
            el('h3', { className: 'skd-micro skd-periodTrendTitle', ref: trendHeading, tabIndex: -1, 'aria-describedby': id + '-summary' }, t('usage.periodTrend')),
            field('trend-skill', t('usage.trendSkill'), select(p.selected, (value) => updateView({ selected: value }), [['', t('usage.allSkills')], ...p.allRows.map((row) => [row.name, row.name + (row.removed ? ' · ' + t('usage.removed') : '')])]))),
          el('p', { className: 'skd-noteLine skd-chartSummary', id: id + '-summary' }, t('usage.periodChartSummary', { name: subject, range, count: number(p.trendTotal), peak: number(p.peak) })),
          el('div', { className: 'skd-chart skd-periodChart', role: 'img', 'aria-label': t('usage.chart'), 'aria-describedby': id + '-summary' },
            p.trend.map((bucket) => el('div', { key: bucket.date, className: 'skd-chartCol', 'aria-hidden': true, 'data-count': bucket.count,
              title: t('usage.dayTitle', { date: bucket.date, count: bucket.count }) }, el('div', { className: 'skd-bar', 'data-empty': bucket.count === 0 ? '' : undefined,
                style: { height: bucket.count === 0 ? '2px' : Math.max(3, bucket.count / p.peak * 100) + '%' } })))),
          el('div', { className: 'skd-chartAxis' }, axes.map((bucket) => el('span', { key: bucket.date }, formatDay(bucket.date)))),
          p.trend.length > 0 && el('details', { className: 'skd-chartDetails' }, el('summary', null, t('usage.breakdown')),
            el('div', { className: 'skd-periodTableScroll', role: 'region', tabIndex: 0, 'aria-label': t('usage.breakdown') },
              el('table', null, el('caption', { className: 'skd-visuallyHidden' }, subject + ' · ' + range),
                el('thead', null, el('tr', null, el('th', { scope: 'col' }, t('usage.date')), el('th', { scope: 'col' }, t('usage.count')))),
                el('tbody', null, p.trend.map((bucket) => el('tr', { key: bucket.date }, el('th', { scope: 'row' }, bucket.date), el('td', null, formatNumber(bucket.count))))))))),
        el('section', { className: 'skd-panelCard', 'aria-labelledby': id + '-skills' },
          el('h3', { className: 'skd-micro', id: id + '-skills' }, t('usage.perSkill')),
          field('search', t('usage.searchSkills'), el(Input, { type: 'search', value: query, placeholder: t('usage.searchPlaceholder'), 'aria-describedby': id + '-searchHint', onChange: (event) => updateView({ query: event.target.value }) })),
          el('p', { className: 'skd-noteLine', id: id + '-searchHint' }, t('usage.searchTableOnly')),
          el('p', { className: 'skd-noteLine', role: 'status' }, t('usage.tableResults', { count: rows.length, total: p.allRows.length, column: t('usage.column.' + sort.key), direction: t('usage.sort.' + sort.direction) })),
          el('div', { className: 'skd-periodTableScroll', role: 'region', tabIndex: 0, 'aria-labelledby': id + '-caption' },
            el('table', { className: 'skd-periodTable', id: id + '-table' }, el('caption', { id: id + '-caption' }, t('usage.tableCaption', { range })),
              el('thead', null, el('tr', null, heading('name', t('usage.column.name')), heading('count', t('usage.column.count')), heading('share', t('usage.column.share')))),
              el('tbody', null, rows.length ? rows.map((row) => el('tr', { key: row.name },
                el('th', { scope: 'row' }, el(Button, { className: 'skd-periodSkill', 'aria-pressed': p.selected === row.name,
                  'aria-controls': id + '-trend', title: t('usage.showTrend', { name: row.name }), onClick: () => selectFromTable(row.name) }, row.name),
                  row.removed && el('span', { className: 'skd-badge' }, t('usage.removed'))),
                el('td', null, number(row.count)), el('td', null, p.error ? '—' : (row.share * 100).toFixed(1) + '%')))
                : el('tr', null, el('td', { colSpan: 3 }, t('usage.noMatchingSkills'))))))),
        el('div', { className: 'skd-panelCard' },
          el('div', { className: 'skd-cardTitleRow' }, el('h3', { className: 'skd-micro' }, t('usage.recent'))),
          el('p', { className: 'skd-noteLine' }, t('usage.recentAllTime')),
          recent.length === 0 ? el('p', { className: 'skd-noteLine' }, t('usage.recentEmpty'))
            : el('div', { className: 'skd-activity' }, recent.map((entry, index) => el('div', { key: textOf(entry.name) + ':' + index, className: 'skd-activityRow' },
              el('span', { className: 'skd-activityMain' }, el('span', { className: 'skd-activityName' }, textOf(entry.name) || '—'), el(Badge, null, agentTitle(entry.agentId))),
              el('span', { className: 'skd-activityTime' }, formatStamp(entry.at)))))),
        el('p', { className: 'skd-noteLine' }, t('usage.note')));
    }



    // ---------------------------------------------------------------- page
    /** The panel: header, tab bar, scrolling body, and the footer status line. */
    function SkillDashboardPage(props) {
      const {
        useDashboard, t, refresh, setInvocation, removeSkill, updateSkill,
        installSkill, selectSource, runDiscover, dismissNote,
      } = props;
      const snapshot = useDashboard((current) => current);
      const data = objectOf(snapshot.data);
      const status = textOf(snapshot.status) !== '' ? snapshot.status : 'idle';
      const pending = objectOf(snapshot.pending);
      const note = objectOf(snapshot.note);
      const refreshing = snapshot.refreshing === true;
      const [tab, setTab] = useState('installed');
      const [previewTarget, setPreviewTarget] = useState(null);
      const [agentFilter, setAgentFilter] = useState('all');
      const [expandedPath, setExpandedPath] = useState('');
      const [confirmingPath, setConfirmingPath] = useState('');
      const [queryDraft, setQueryDraft] = useState('');
      const [libraryQuery, setLibraryQuery] = useState('');
      const [invocationFilter, setInvocationFilter] = useState('all');
      const [sort, setSort] = useState('usage');
      const [usageView, setUsageView] = useState({ period: '7', start: '', end: '', query: '', selected: '', sort: { key: 'count', direction: 'descending' } });
      const scrollRef = useRef(null);
      const libraryInputRef = useRef(null);
      const contentRef = useRef(null);
      const scrollPositions = useRef(new Map());
      const focusNextPage = useRef(false);
      const pageId = 'skd-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
      const libraryInputId = pageId + '-query';

      const scrollContainer = () => {
        const scroller = scrollRef.current;
        if (!scroller) return null;
        return getComputedStyle(scroller).overflowY === 'visible' ? scroller.parentElement : scroller;
      };
      const changeTab = (next, focusPanel = false) => {
        if (next === tab) return;
        scrollPositions.current.set(tab, scrollContainer()?.scrollTop ?? 0);
        focusNextPage.current = focusPanel;
        setTab(next);
      };
      useLayoutEffect(() => {
        if (focusNextPage.current) {
          focusNextPage.current = false;
          contentRef.current?.focus({ preventScroll: true });
          scrollContainer()?.scrollTo({ top: 0 });
        } else {
          scrollContainer()?.scrollTo({ top: scrollPositions.current.get(tab) ?? 0 });
        }
      }, [tab]);

      useEffect(() => {
        if (tab === 'installed') scrollRef.current?.scrollTo({ top: 0 });
      }, [agentFilter, libraryQuery, invocationFilter, sort]);

      // One read drives the panel; a later tab switch only refreshes a stale snapshot.
      useEffect(() => {
        void refresh({ staleAfterMs: STALE_AFTER_MS });
      }, [refresh, tab]);

      // The detected coding agents, not the DSH presets: they say which agent
      // really reads a skill directory.
      const runtimes = useMemo(() => {
        const listed = data !== null && Array.isArray(data.runtimes) ? data.runtimes : [];
        return listed.map((runtime) => objectOf(runtime)).filter((runtime) => runtime !== null);
      }, [data]);

      const skills = useMemo(() => {
        const listed = data !== null && Array.isArray(data.skills) ? data.skills : [];
        return listed.map((skill) => objectOf(skill)).filter((skill) => skill !== null);
      }, [data]);

      // 高频 is relative to the skills that were actually called, and only when that
      // population is big enough for a 75th percentile to describe anything.
      const frequentRule = useMemo(() => {
        const counts = skills
          .map((skill) => countOf(objectOf(skill.usage)?.count))
          .filter((value) => value > 0);
        if (counts.length < MIN_FREQUENT_PEERS) return { active: false, threshold: Number.POSITIVE_INFINITY };
        return { active: true, threshold: percentileOf(counts, 0.75) };
      }, [skills]);

      const visible = useMemo(() => filterSkills(skills, {
        runtime: agentFilter, query: libraryQuery, status: invocationFilter, sort,
      }), [skills, agentFilter, libraryQuery, invocationFilter, sort]);
      const hasFilters = agentFilter !== 'all' || libraryQuery !== '' || invocationFilter !== 'all';
      const resetFilters = () => {
        setAgentFilter('all'); setLibraryQuery(''); setInvocationFilter('all');
        libraryInputRef.current?.focus({ preventScroll: true });
      };
      const [announcedResults, setAnnouncedResults] = useState('');
      const resultAnnouncement = t('installed.results', { count: visible.length, total: skills.length });
      useEffect(() => {
        const timer = setTimeout(() => setAnnouncedResults(resultAnnouncement), 350);
        return () => clearTimeout(timer);
      }, [resultAnnouncement]);
      useEffect(() => {
        if (agentFilter !== 'all' && !runtimes.some((runtime) => textOf(runtime.id) === agentFilter)) setAgentFilter('all');
      }, [runtimes, agentFilter]);

      const invocable = useMemo(() => skills.filter((skill) => skill.modelInvocable === true).length, [skills]);

      // DSH's translator keeps its identity when the language changes; derive localized labels each render.
      const sources = (() => {
        const listed = data !== null && Array.isArray(data.sources) ? data.sources : [];
        return listed.map((source) => objectOf(source)).filter((source) => source !== null).map((source) => {
          const id = textOf(source.id);
          const title = textOf(source.title);
          const noteText = textOf(source.note);
          const state = textOf(source.status);
          return {
            id,
            label: id === 'tencent' ? t('source.tencent') : id === 'skills-sh' ? 'skills.sh' : title !== '' ? title : id,
            note: noteText !== '' ? noteText : undefined,
            disabled: state !== '' && state !== 'ready',
          };
        }).filter((source) => source.id !== '');
      })();

      const discover = objectOf(snapshot.discover) ?? { source: null, query: '', status: 'idle', items: [], error: null, note: null, at: 0 };

      // Land on a usable source as soon as the Host names one.
      useEffect(() => {
        if (textOf(discover.source) !== '') return;
        const ready = sources.find((source) => source.disabled === false);
        if (ready === undefined) return;
        selectSource(ready.id);
      }, [discover.source, sources, selectSource]);

      const toggleInvocation = (skill, changes) => { void setInvocation(skill, changes); };
      const askRemove = (skill) => { setConfirmingPath(textOf(skill?.path)); };
      const cancelRemove = () => { setConfirmingPath(''); };
      const confirmRemove = (skill, next) => {
        (next ?? libraryInputRef.current)?.focus({ preventScroll: true });
        setConfirmingPath('');
        void removeSkill(skill);
      };
      const togglePath = (path) => { setExpandedPath((current) => (current === path ? '' : path)); };
      const search = (query) => {
        if (typeof query === 'string') setQueryDraft(query);
        void runDiscover(discover.source, (typeof query === 'string' ? query : queryDraft).trim());
      };

      const changeDiscoverSource = (id) => {
        if (id === discover.source) return;
        selectSource(id);
        if (discover.status !== 'idle') void runDiscover(id, textOf(discover.query));
      };

      const tabs = [
        { id: 'installed', label: t('tab.installed') },
        { id: 'discover', label: t('tab.discover') },
        { id: 'usage', label: t('tab.usage') },
      ];

      const filters = [
        { id: 'all', label: t('filter.all'), title: undefined },
        ...runtimes.map((runtime) => ({
          id: textOf(runtime.id),
          label: t('filter.agentOption', {
            name: textOf(runtime.title) !== '' ? textOf(runtime.title) : textOf(runtime.id),
            count: countOf(runtime.skillCount),
          }),
          title: undefined,
        })),
      ].filter((filter) => filter.id !== '');

      // A failed action is a banner over the body; a saved one is a quiet footer note.
      const errorText = pending === null && note !== null && note.tone === 'error' ? noteTextOf(note, t) : '';
      const footerNote = pending !== null ? t('status.busy') : note !== null && note.tone !== 'error' ? noteTextOf(note, t) : '';
      const footerTone = pending !== null ? 'idle' : note !== null && note.tone !== 'error' && textOf(note.tone) !== '' ? note.tone : 'idle';
      const fetchedAt = Number.isFinite(snapshot.fetchedAt) ? snapshot.fetchedAt : 0;

      // A blank page is never the answer: no snapshot plus an unreachable Host is a state.
      if (data === null && status === 'offline') {
        return el('section', { className: 'skd-page', 'aria-label': t('panel.label') },
          el('div', { className: 'skd-wrap skd-offline' },
            el('h2', { className: 'skd-offlineTitle' }, t('offline.title')),
            el('p', { className: 'skd-offlineBody' }, t('offline.body')),
            el('div', { className: 'skd-stateActions' },
              el(Button, {
                type: 'button',
                className: 'skd-button',
                'data-variant': 'primary',
                disabled: refreshing,
                onClick: () => { void refresh(); },
              }, t('action.retry')),
            ),
          ),
        );
      }

      if (data === null) {
        return el('section', { className: 'skd-page', 'aria-label': t('panel.label'), 'aria-busy': true },
          el('div', { className: 'skd-wrap skd-offline' },
            el('h2', { className: 'skd-offlineTitle' }, t('skill.loading')),
            el('div', { className: 'skd-skeleton' },
              el('div', { className: 'skd-skeletonRow' }),
              el('div', { className: 'skd-skeletonRow' }),
            ),
          ),
        );
      }

      return el('section', { className: 'skd-page', 'aria-label': t('panel.label') },
        el('a', {
          className: 'skd-skipLink', href: '#' + pageId + '-panel-' + tab,
          onClick: (event) => { event.preventDefault(); contentRef.current?.focus(); },
        }, t('action.skipContent')),
        el('header', { className: 'skd-top' },
          el('div', { className: 'skd-wrap' },
            el('div', { className: 'skd-header' },
              el('div', { className: 'skd-headText' },
                el('span', { className: 'skd-pageMark', 'aria-hidden': true }, el(Glyph, { name: 'library', size: 22 })),
                el('h1', { className: 'skd-title' }, t('panel.title')),
                el('p', { className: 'skd-subtitle' }, t('panel.intro')),
              ),
              el('div', { className: 'skd-headerTools' },
                el(Button, {
                  type: 'button',
                  className: 'skd-iconButton',
                  'aria-label': t('action.refresh'),
                  title: t('action.refresh'),
                  disabled: refreshing,
                  'data-spinning': refreshing ? '' : undefined,
                  onClick: () => { void refresh(); },
                }, el(RefreshGlyph, { size: 15 })),
              ),
            ),
            el(TabBar, { tabs, value: tab, onChange: changeTab, label: t('tab.list'), idPrefix: pageId }),
          ),
        ),
        status === 'offline' && el('div', { className: 'skd-wrap' },
          el('div', { className: 'skd-banner', role: 'alert' },
            el('span', null, t('status.offlineInline')),
            el(Button, {
              type: 'button',
              className: 'skd-button',
              disabled: refreshing,
              onClick: () => { void refresh(); },
            }, t('action.retry')),
          ),
        ),
        // A refused action says exactly what the Host said; it stays until the next action or a dismissal.
        errorText !== '' && el('div', { className: 'skd-wrap' },
          el('div', { className: 'skd-banner', role: 'alert' },
            el('span', null, errorText),
            el(Button, {
              type: 'button',
              className: 'skd-button',
              onClick: () => { if (typeof dismissNote === 'function') dismissNote(); },
            }, t('action.dismiss')),
          ),
        ),
        el('div', { className: 'skd-scroll', ref: scrollRef },
          el('div', { className: 'skd-wrap skd-content' },
            tab === 'installed' && el('div', { className: 'skd-overview', role: 'group', 'aria-label': t('panel.subtitle', { skills: skills.length, agents: runtimes.length, invocable }) },
              [
                { label: 'overview.skills', value: skills.length },
                { label: 'overview.enabled', value: invocable },
                { label: 'overview.agents', value: runtimes.length },
                { label: 'overview.calls', value: countOf(objectOf(data.usage)?.totalCount) },
              ].map((entry) => el('div', { key: entry.label, className: 'skd-overviewItem' },
                el('span', { className: 'skd-overviewLabel' }, t(entry.label)),
                el('span', { className: 'skd-overviewValue' }, String(entry.value))))),
            el('div', {
              className: 'skd-panel',
              role: 'tabpanel',
              id: pageId + '-panel-' + tab,
              ref: contentRef,
              'aria-labelledby': pageId + '-tab-' + tab,
              tabIndex: 0,
            },
              tab === 'installed' && el(SectionHeading, { title: t('installed.title'), body: t('installed.body') },
                skills.length > 0 && el(Button, { className: 'skd-button', onClick: () => changeTab('discover', true) },
                  el(Glyph, { name: 'plus', size: 16 }), t('action.discover'))),
              tab === 'installed' && el('search', { className: 'skd-toolbar skd-filterBar', 'aria-label': t('installed.search') },
                el('div', { className: 'skd-searchField' },
                  el('label', { className: 'skd-fieldLabel', htmlFor: libraryInputId }, t('installed.search')),
                  el('div', { className: 'skd-searchBox' }, el(Glyph, { name: 'search' }),
                    el(Input, {
                      id: libraryInputId, ref: libraryInputRef, name: 'query',
                      className: 'skd-input', type: 'search', value: libraryQuery,
                      placeholder: t('installed.placeholder'), autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'search',
                      onChange: (event) => setLibraryQuery(event.target.value),
                    }))),
                runtimes.length > 0 && el(SelectField, { label: t('filter.label'), value: agentFilter, onChange: setAgentFilter, options: filters }),
                el(SelectField, { label: t('installed.status'), value: invocationFilter, onChange: setInvocationFilter,
                  options: ['all', 'enabled', 'disabled', 'writable'].map((id) => ({ id, label: t('installed.' + id) })) }),
                el(SelectField, { label: t('installed.sort'), value: sort, onChange: setSort,
                  options: ['usage', 'name', 'recent'].map((id) => ({ id, label: t('installed.sort.' + id) })) })),
              tab === 'installed' && el('div', { className: 'skd-resultLine skd-libraryResults' },
                el('span', null, t('installed.results', { count: visible.length, total: skills.length })),
                el('span', { className: 'skd-visuallyHidden', role: 'status', 'aria-atomic': true }, announcedResults),
                hasFilters && visible.length > 0 && el(Button, { className: 'skd-button', 'data-variant': 'text', onClick: resetFilters }, t('installed.reset'))),
              tab === 'installed' && visible.length > 0 && el('p', { className: 'skd-noteLine' }, t('installed.hint')),
              tab === 'installed' && visible.length > 0 && el('div', { className: 'skd-tableHeading', 'aria-hidden': true },
                el('span', null, t('overview.skills')), el('span', null, t('skill.callsLabel')),
                el('span', null, t('installed.permissions')), el('span')),
              tab === 'installed' && el(InstalledTab, {
                skills: visible,
                t,
                runtimes,
                onPreview: setPreviewTarget,
                frequentRule,
                pending,
                filtered: hasFilters,
                onReset: resetFilters,
                onDiscover: () => changeTab('discover', true),
                expandedPath,
                confirmingPath,
                onToggle: toggleInvocation,
                onUpdate: (skill) => { void updateSkill(skill); },
                onAskRemove: askRemove,
                onConfirmRemove: confirmRemove,
                onCancelRemove: cancelRemove,
                onTogglePath: togglePath,
              }),
              tab === 'discover' && el(DiscoverTab, {
                t,
                discover,
                sources,
                queryDraft,
                pending,
                onDraft: setQueryDraft,
                onSearch: search,
                onRetry: () => { void runDiscover(discover.source, textOf(discover.query)); },
                onSelectSource: changeDiscoverSource,
                onInstall: (item, source) => { void installSkill(item, source); },
                onPreview: setPreviewTarget,
              }),
              tab === 'usage' && el(UsageTab, { data, t, view: usageView, setView: setUsageView }),
            ),
            tabs.filter((entry) => entry.id !== tab).map((entry) => el('div', {
              key: entry.id, hidden: true, role: 'tabpanel',
              id: pageId + '-panel-' + entry.id, 'aria-labelledby': pageId + '-tab-' + entry.id,
            })),
          ),
        ),
        el('footer', { className: 'skd-footer' },
          el('div', { className: 'skd-wrap skd-footerInner' },
            el('div', { className: 'skd-footerStats' },
              fetchedAt > 0 && el('span', null, t('status.updatedAt', { time: formatClock(fetchedAt) }))),
            el('span', { className: 'skd-footerNote', 'data-tone': footerTone, role: 'status' },
              el('span', { className: 'skd-statusDot', 'data-tone': footerTone, 'aria-hidden': 'true' }),
              footerNote !== '' ? footerNote : t(status === 'offline' ? 'status.offlineInline' : 'status.ready'),
            ),
          ),
        ),
        previewTarget !== null && el(SkillPreview, { target: previewTarget, t, runtimes, onClose: () => setPreviewTarget(null) }),
      );
    }

    /** Keeps a throwing descendant from blanking the slot entry. */
    class DashboardBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      render() {
        return this.state.failed === true ? this.props.fallback : this.props.children;
      }
    }

    /** Slot entry: the boundary plus the page, so a render failure still offers a way out. */
    function SkillDashboardSlot(props) {
      const { t } = props;
      const fallback = el('section', { className: 'skd-page', 'aria-label': t('panel.label') },
        el('div', { className: 'skd-wrap skd-offline' },
          el('h2', { className: 'skd-offlineTitle' }, t('crash.title')),
          el('p', { className: 'skd-offlineBody' }, t('crash.body')),
          el('div', { className: 'skd-stateActions' },
            el(Button, {
              type: 'button',
              className: 'skd-button',
              onClick: () => { window.location.reload(); },
            }, t('action.reload')),
          ),
        ),
      );
      return el(DashboardBoundary, { fallback }, el(SkillDashboardPage, props));
    }

    // ---------------------------------------------------------------- styles
    /**
     * Insert the one stylesheet. A dynamic Client half reaches the `styles` builtin; a
     * Module Loader package has no such seat, so it falls back to the style tag the loader
     * claims through data-plugin, with the same lifetime and the same effect cleanup.
     */
    function insertStyles(ctx) {
      let seat;
      try {
        seat = ctx.styles;
      } catch {
        seat = undefined;
      }
      if (seat !== undefined && seat !== null && typeof seat.insert === 'function') return seat.insert(CSS);
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_ID;
      tag.dataset.pluginCss = PACKAGE_ID + '/skill-dashboard.css';
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }

    // ---------------------------------------------------------------- mount
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const runtime = createRuntime();

        ctx.effect(() => insertStyles(ctx), 'skill-dashboard: stylesheet');
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-dashboard: dictionaries');
        ctx.effect(() => () => runtime.dispose(), 'skill-dashboard: settle timer');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'skill-dashboard',
          locale: NS,
          inject: () => ({
            hooks: { dashboard: runtime.store },
            refresh: runtime.refresh,
            setInvocation: runtime.setInvocation,
            removeSkill: runtime.removeSkill,
            updateSkill: runtime.updateSkill,
            installSkill: runtime.installSkill,
            selectSource: runtime.selectSource,
            runDiscover: runtime.runDiscover,
            dismissNote: runtime.dismissNote,
          }),
        }, SkillDashboardSlot));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'skill-dashboard',
          order: 20,
          locale: NS,
          label: () => t('panel.label'),
        }, SkillDashboardIcon));
      },
    };
  },
});
