window.__ModuleLoader__.load({
  id: '@local/dsh-skill-dashboard',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } = React;

    /** Drops the falsy branch of a conditional child, so JSX-free trees stay readable. */
    const el = (type, props, ...children) => h(type, props, ...children.filter(
      (child) => child !== null && child !== undefined && child !== false && child !== true,
    ));

    // The client test VM stubs React without memo or deferred values, so keep a plain fallback.
    const memo = typeof React.memo === 'function' ? React.memo : (component) => component;
    const deferredValue = typeof React.useDeferredValue === 'function' ? React.useDeferredValue : (value) => value;

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

    // ---------------------------------------------------------------- constants
    const PACKAGE_ID = '@local/dsh-skill-dashboard';
    const NS = 'skill-dashboard';
    const ROUTE_STATE = 'skill-dashboard/state';
    const ROUTE_ACTION = 'skill-dashboard/action';
    const ROUTE_DISCOVER = 'skill-dashboard/discover';
    const ROUTE_PREVIEW = 'skill-dashboard/preview';
    /** A tab switch reloads only when the snapshot is older than this. */
    const STALE_AFTER_MS = 5000;
    const REQUEST_TIMEOUT_MS = 10000;
    /**
     * One check chunk may legitimately run to a cold tree warm plus a bounded
     * per-skill read, so it gets a wider envelope than every other route. A chunk
     * that hits this bound is retried once from the start of the walk.
     */
    const UPDATE_CHECK_REQUEST_TIMEOUT_MS = 25000;
    const DISCOVER_LIMIT = 20;
    /** The Host accepts at most this many cleanup targets in one call (§4). */
    const CLEANUP_TARGET_LIMIT = 100;
    /** 高频 needs a real run of calls, not one lucky invocation: this many calls … */
    const MIN_FREQUENT_CALLS = 3;
    /** … and at least this many skills with calls, so the percentile means something. */
    const MIN_FREQUENT_PEERS = 3;
    /** Enough rows to fill the fold, few enough that one batch paints inside a single frame. */
    const ROW_BATCH = 15;
    /** One more batch, never past the filtered total, so the last frame mounts only the remainder. */
    function nextRowLimit(limit, total) {
      return Math.min(limit + ROW_BATCH, total);
    }
    /** One check result stays authoritative this long; the panel auto-checks once per window. */
    const UPDATES_TTL_MS = 6 * 60 * 60 * 1000;
    /** One check request covers this many tracked skills, so each route call stays inside the 10 s bound. */
    const UPDATE_CHECK_CHUNK = 4;
    /** A runaway name list must not lock the panel; one gesture applies the whole available set. */
    const UPDATE_APPLY_LIMIT = 500;
    /** The window-level home of the opt-in auto-update choice; one key, one shape. */
    const AUTO_UPDATE_KEY = 'dsh-skill-dashboard:auto-update';

    // ---------------------------------------------------------------- locale
    const zh = {
      'panel.label': '技能',
      'panel.title': '技能管理',
      'panel.intro': '管理本地技能、调用权限、使用统计与清理诊断。',
      'panel.subtitle': '{skills} 个技能 · {agents} 个 Agent · {invocable} 个已开启自动调用',
      'tab.list': '技能管理视图',
      'tab.installed': '已安装',
      'tab.discover': '发现',
      'tab.usage': '统计',
      'tab.diagnosis': '诊断',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.cancel': '取消',
      'action.search': '搜索',
      'action.switch': '切换',
      'action.reload': '重新加载页面',
      'action.dismiss': '关闭',
      'action.discover': '发现技能',
      'action.backLibrary': '返回已安装',
      'action.skipContent': '跳到主要内容',
      'status.ready': '已同步',
      'status.updatedAt': '更新于 {time}',
      'status.saved': '已保存',
      'status.removed': '已删除 {name}',
      'status.installed': '已安装 {name}',
      'status.updatedSkill': '已更新 {name}',
      'status.boundSource': '已记录 {name} 的来源',
      'status.upToDate': '{name} 已是最新版本',
      'status.busy': '正在处理…',
      'status.failed': '{action}失败：{message}',
      'status.failedPlain': '操作失败',
      'status.offlineInline': '暂时无法连接技能服务，当前显示缓存数据。',
      'filter.label': '按 Agent 筛选',
      'filter.all': '全部',
      'filter.agentOption': '{name} ({count})',
      'overview.skills': '已安装技能',
      'overview.enabled': '自动调用',
      'overview.agents': '已检测 Agent',
      'overview.calls': '累计调用',
      'installed.title': '已安装技能',
      'installed.body': '查找、筛选本地技能并调整调用权限。',
      'installed.search': '搜索已安装技能',
      'installed.placeholder': '搜索技能名称、描述或来源…',
      'installed.results': '显示 {count} / {total} 个技能',
      'installed.noMatches': '没有符合条件的技能',
      'installed.noMatchesBody': '换个关键词，或清除当前筛选条件。',
      'installed.reset': '清除筛选',
      'installed.status': '调用状态',
      'installed.all': '全部状态',
      'installed.enabled': '自动调用已开',
      'installed.disabled': '自动调用已关',
      'installed.writable': '可管理',
      'installed.updatable': '可更新',
      'installed.sort': '排序方式',
      'installed.sort.usage': '调用最多',
      'installed.sort.name': '名称 A–Z',
      'installed.sort.recent': '最近使用',
      'installed.permissions': '调用权限',
      'installed.hint': '自动调用由模型按需触发，/name 由你在对话中手动触发；共享技能的权限变更会影响全部关联 Agent。',
      'updates.check': '检查更新',
      'updates.checking': '正在检查更新 {done}/{total}',
      'updates.lastChecked': '上次检查 {time}',
      'updates.never': '尚未检查',
      'updates.pill': '可更新 {count}',
      'updates.pillChecking': '检查中 {done}/{total}',
      'updates.pillLatest': '已是最新',
      'updates.pillCheckingStart': '检查中…',
      'updates.pillInterrupted': '检查中断',
      'updates.pillNone': '检查更新',
      'updates.panelTitle': '技能更新',
      'updates.panelAvailable': '{count} 个技能可更新',
      'updates.onlyAvailable': '只看可更新',
      'updates.autoBack': '返回',
      'updates.interrupted': '检查中断，已完成 {done}/{total}，可再次检查',
      'updates.available': '可更新 {count} 个技能',
      'updates.applyAll': '全部更新 ({count})',
      'updates.applyCommon': '仅更新常用 ({count})',
      'updates.applying': '正在更新 {done}/{total}',
      'updates.dismiss': '稍后',
      'updates.applied': '已更新 {ok} 个技能，{failed} 个失败',
      'updates.appliedAuto': '已自动更新 {ok} 个技能，{failed} 个失败',
      'updates.autoToggle': '自动更新',
      'updates.autoChoose': '选择 {count}',
      'updates.autoPicker': '自动更新技能',
      'updates.autoHint': '只自动更新勾选的技能，每次检查结束后执行一次。',
      'updates.autoAll': '全选',
      'updates.autoNone': '清空',
      'updates.autoDone': '完成',
      'updates.autoEmpty': '当前没有可勾选的更新。',
      'skill.runtimesOne': '仅 {agent}',
      'skill.runtimesSome': '{count}/{total} 个 Agent',
      'skill.callsLabel': '调用',
      'skill.usageTitle': '共 {count} 次 · 自动 {model} · 手动 {user}',
      'skill.readonly': '只读',
      'skill.frequent': '高频',
      'skill.updatable': '可更新',
      'skill.closed': '已停用',
      'skill.model': '自动调用',
      'skill.user': '/name 手动',
      'skill.modelSwitchAria': '自动调用：{name}',
      'skill.userSwitchAria': '/name 手动：{name}',
      'skill.modelHint': '允许模型根据技能描述自动决定是否调用。',
      'skill.userHint': '允许在对话中输入 /技能名 手动调用。',
      'skill.menuAria': '更多操作：{name}',
      'skill.menu.update': '更新',
      'skill.menu.bind': '关联来源',
      'skill.menu.remove': '删除',
      'skill.menu.showPath': '查看路径',
      'skill.menu.hidePath': '隐藏路径',
      'skill.path': '路径',
      'skill.empty.title': '还没有可管理的技能',
      'skill.empty.body': '前往「发现」安装社区技能，或将 SKILL.md 放入本地技能目录。',
      'skill.emptyFiltered': '该 Agent 下暂无技能。',
      'skill.loading': '正在加载技能…',
      'skill.removeConfirm': '删除「{name}」？对应技能目录会一并移除且无法撤销。',
      'skill.removeConfirmAction': '确认删除',
      'skill.busy': '正在保存…',
      'skill.bind.inputAria': '来源引用',
      'skill.bind.placeholder': '技能名、owner/repo 或 GitHub 链接',
      'skill.bind.hint': '关联后可从该来源更新；更新会用来源内容替换本地技能目录。',
      'skill.bind.submit': '关联并更新',
      'skill.origin': '来源 {ref}',
      'skill.originVersion': '来源 {ref} · v{version}',
      'source.tencent': '腾讯 SkillHub',
      'discover.title': '发现技能',
      'discover.body': '从社区技能源搜索并一键安装到本地目录。',
      'discover.source': '技能来源',
      'discover.placeholder': '输入技能名或仓库，按回车搜索',
      'discover.githubLabel': '从 GitHub 安装',
      'discover.githubPlaceholder': 'owner/repo、owner/repo@分支，或粘贴 GitHub 链接',
      'discover.githubSubmit': '安装',
      'discover.searchLabel': '搜索技能',
      'discover.popular': '浏览热门技能',
      'discover.popularScope': '{source} · 热门技能',
      'discover.popularResults': '{count} 个热门技能',
      'discover.results': '{count} 个搜索结果',
      'discover.queryScope': '{source} · 关键词：{query}',
      'discover.idle.title': '从技能来源开始浏览',
      'discover.idle.body': '在 skills.sh 或腾讯 SkillHub 中搜索技能，一键安装到本地技能目录。',
      'discover.loading': '正在搜索技能…',
      'discover.empty.title': '没有匹配的技能',
      'discover.empty.body': '换个关键词，或切换到另一个技能来源。',
      'discover.error.title': '该技能来源暂时不可用',
      'discover.otherSource': '切换到 {source}',
      'discover.unavailableTitle': '暂无可用技能来源',
      'discover.unavailableBody': '请刷新页面以重新检查可用技能来源。',
      'discover.install': '安装',
      'discover.installAria': '安装：{name}',
      'discover.installBlockedAria': '无法安装 {name}：{reason}',
      'discover.notInstallable': '暂不支持直接安装',
      'discover.installing': '正在安装…',
      'discover.installed': '已安装',
      'discover.version': 'v{version}',
      'discover.updated': '更新于 {date}',
      'discover.installsUnit': '次安装',
      'discover.columnRank': '排名',
      'discover.columnSkill': '技能',
      'discover.columnInstalls': '安装量',
      'discover.note.suggestions': '当前展示热门技能',
      'usage.title': '使用统计',
      'usage.periodBody': '按所选时段查看每个技能的调用趋势与占比，统计覆盖全部 Agent。',
      'usage.period': '统计时段',
      'usage.period.today': '今天',
      'usage.period.7': '近 7 天',
      'usage.period.14': '近 14 天',
      'usage.period.30': '近 30 天',
      'usage.period.60': '近 60 天',
      'usage.period.custom': '自定义日期',
      'usage.startDate': '开始日期',
      'usage.endDate': '结束日期',
      'usage.availableRange': '可用日期：{start} 至 {end}',
      'usage.boundedRange': '所选时段超出保留范围，当前仅统计 {start} 至 {end}，更早日期不计入。',
      'usage.rangeError.required': '请选择开始日期和结束日期。',
      'usage.rangeError.invalid': '请输入有效日期。',
      'usage.rangeError.order': '开始日期不能晚于结束日期。',
      'usage.rangeError.bounds': '日期必须在 {start} 至 {end} 之间。',
      'usage.rangeError.unavailable': '暂无逐日统计数据，请刷新或更新插件。',
      'usage.periodCalls': '时段调用',
      'usage.periodActive': '时段活跃技能',
      'usage.periodActiveHint': '所选时段内至少调用一次，含已移出技能库的技能',
      'usage.total': '累计调用',
      'usage.totalHint': '全部 Agent 累计',
      'usage.periodTrend': '时段调用趋势',
      'usage.trendSkill': '趋势范围',
      'usage.allSkills': '全部技能',
      'usage.periodChartSummary': '{name} · {range} · 共 {count} 次，单日最高 {peak} 次。下方可展开逐日明细。',
      'usage.chart': '调用趋势',
      'usage.dayTitle': '{date} · {count} 次',
      'usage.breakdown': '逐日调用明细',
      'usage.date': '日期',
      'usage.count': '调用次数',
      'usage.perSkill': '按技能统计',
      'usage.searchSkills': '搜索技能名称',
      'usage.searchPlaceholder': '输入技能名称…',
      'usage.searchTableOnly': '搜索仅筛选下方表格，占比按所选时段全部调用计算。点击技能名称可查看趋势。',
      'usage.tableResults': '显示 {count} / {total} 个技能 · 按{column}{direction}',
      'usage.column.name': '技能名称',
      'usage.column.count': '调用次数',
      'usage.column.share': '时段占比',
      'usage.sort.ascending': '升序',
      'usage.sort.descending': '降序',
      'usage.tableCaption': '{range} · 各技能在所选时段内的调用次数及占比',
      'usage.removed': '不在当前技能库',
      'usage.showTrend': '查看 {name} 的时段趋势',
      'usage.noMatchingSkills': '没有匹配的技能。',
      'usage.recent': '最近活动',
      'usage.recentAllTime': '最近调用记录，不受时段筛选影响。',
      'usage.recentEmpty': '还没有调用记录。',
      'usage.note': '仅统计插件启用期间记录的调用。逐日数据保留 60 天，累计次数不受时段筛选影响。',
      'usage.unknownAgent': '未知 Agent',
      'diagnosis.title': '技能诊断',
      'diagnosis.basis': '仅根据本插件记录的调用情况判断，不评价技能本身质量。',
      'diagnosis.horizon': '观察自 {date} · 共 {days} 天 · {total} 个技能，其中 {active} 个近 {activeDays} 天内被调用过。',
      'diagnosis.buckets': '按状态分组',
      'diagnosis.bucket.cleanup': '可清理',
      'diagnosis.bucket.dormant': '已停用',
      'diagnosis.bucket.active': '使用中',
      'diagnosis.bucket.kept': '已保留',
      'diagnosis.bucket.unknown': '观察中',
      'diagnosis.queueCount': '{bucket}：{count} 个',
      'diagnosis.searchLabel': '搜索技能名称',
      'diagnosis.searchPlaceholder': '输入技能名称…',
      'diagnosis.selectRow': '选择 {name}',
      'diagnosis.selectAll': '全选本组',
      'diagnosis.clearSelection': '取消全选',
      'diagnosis.verdict.active': '使用中',
      'diagnosis.verdict.cooling': '近期未用',
      'diagnosis.verdict.stale': '久未调用',
      'diagnosis.verdict.unused': '从未调用',
      'diagnosis.verdict.kept': '已保留',
      'diagnosis.verdict.unknown': '观察中',
      'diagnosis.closed': '已停用',
      'diagnosis.evidence.idle': '{idle} 天未调用 · 共调用 {count} 次',
      'diagnosis.evidence.never': '从未调用 · 已观察 {watched} 天',
      'diagnosis.evidence.lastUsed': '最近调用 {date}',
      'diagnosis.evidence.kept': '保留于 {date}',
      'diagnosis.disable': '停用',
      'diagnosis.remove': '删除',
      'diagnosis.keep': '保留',
      'diagnosis.unkeep': '取消保留',
      'diagnosis.rail': '批量操作',
      'diagnosis.tally': '已选 {selected} · 可停用 {disable} · 可删除 {remove} · 只读 {readonly}',
      'diagnosis.removeConfirmMany': '删除选中的 {count} 个技能（{names}{more}）？技能目录会一并移除且无法撤销。',
      'diagnosis.moreNames': ' 等 {count} 个',
      'diagnosis.policy': '判断规则',
      'diagnosis.policy.active': '近 {days} 天内有调用，归类为使用中。',
      'diagnosis.policy.stale': '超过 {days} 天没有调用，归类为久未调用并建议清理。',
      'diagnosis.policy.watch': '技能至少观察 {days} 天后，未调用才会被标记为可清理。',
      'diagnosis.policy.keep': '标记为保留后将暂停清理提醒，直到再次被调用。',
      'diagnosis.noCleanup.title': '暂无需要清理的技能',
      'diagnosis.noCleanup.body': '观察满 {days} 天且期间无调用的技能会出现在这里。',
      'diagnosis.noCleanup.action': '查看使用中的技能',
      'diagnosis.noMatches.title': '没有匹配的技能',
      'diagnosis.noMatches.body': '换个关键词，或清除搜索。',
      'diagnosis.noMatches.action': '清除搜索',
      'diagnosis.bucketEmpty': '当前分组下暂无技能。',
      'diagnosis.selectionStatus': '已选择 {count} 个技能',
      'diagnosis.disableNote': '停用完成：成功 {ok} 个，失败 {failed} 个。',
      'diagnosis.removeNote': '删除完成：成功 {ok} 个，失败 {failed} 个。',
      'diagnosis.keepNote': '已更新 {ok} 个，失败 {failed} 个。',
      'diagnosis.oldHost.title': '需要更新插件',
      'diagnosis.oldHost.body': '当前运行的服务版本暂不支持诊断数据，请更新并重新加载插件后重试。',
      'preview.action': '预览',
      'preview.title': '技能预览',
      'preview.open': '查看 {name} 的详情',
      'preview.close': '关闭预览',
      'preview.restore': '还原窗口',
      'preview.maximize': '最大化窗口',
      'preview.grow': '放大窗口',
      'preview.shrink': '缩小窗口',
      'preview.refresh': '刷新预览',
      'preview.files': '技能文件',
      'preview.fileCount': '共 {count} 个文件',
      'preview.content': '文件内容',
      'preview.instructions': '技能说明',
      'preview.view': '显示方式',
      'preview.read': '阅读',
      'preview.source': '原文',
      'preview.loading': '正在加载技能内容…',
      'preview.failed': '无法加载预览内容，请稍后重试。',
      'preview.filesLimited': '文件数已达到预览上限，仅展示部分文件。',
      'preview.noFiles': '暂无可预览文件。',
      'preview.truncated': '文件较大，当前仅显示开头部分。',
      'preview.emptyFile': '该文件为空。',
      'preview.binaryShort': '二进制',
      'preview.binary': '该文件为二进制格式，暂不支持预览内容。',
      'preview.unavailable': '该文件暂时无法读取。',
      'preview.readOnlyNotice': '只读预览，不会执行文件',
      'preview.remoteNotice': '在线文件按需加载，二进制文件仅展示基本信息。',
      'offline.title': '无法连接到技能服务',
      'offline.body': '技能服务未响应。请确认插件已启用，然后重试。',
      'crash.title': '技能管理页面渲染失败',
      'crash.body': '重新加载页面可重新挂载插件；若持续失败，请查看浏览器控制台。',
      'error.read-only': '只读技能，无法修改',
      'error.source-unavailable': '技能来源暂时不可用',
      'error.subpath-required': '这个仓库有多个技能，请用 owner/repo#路径 指定',
      'error.flat-skill': '扁平技能文件无法就地更新，请删除后重新安装',
      'error.source-rate-limited': '请求过于频繁，请稍后重试',
      'error.invalid-response': '技能服务返回了无法解析的数据',
      'error.preview-unavailable': '此技能暂不支持预览；如刚更新插件，请重新加载后再试',
      'error.preview-failed': '无法加载预览内容，请稍后重试',
      'error.skill-not-found': '技能已不在当前目录中，请刷新列表',
      'error.file-not-found': '文件不存在或无法预览，请选择其他文件',
      'error.bad-request': '请求参数无效',
      'error.not-found': '未找到目标技能或资源',
      'error.unknown-action': '不支持的操作类型',
      'error.unknown-source': '未知的技能来源',
      'error.invalid-frontmatter': 'SKILL.md 元数据格式无效，无法保存',
      'error.missing-frontmatter': 'SKILL.md 缺少元数据头，无法修改',
      'error.write-failed': '写入技能文件失败，请检查目录权限',
      'error.delete-failed': '删除技能目录失败，请检查文件占用或权限',
      'error.name-mismatch': '技能名与目录或来源不一致，已中止操作',
      'error.payload-too-large': '请求体过大，请减少批量选择数量后重试',
      'error.state-unavailable': '技能状态暂时无法读取，请稍后重试',
      'error.internal-error': '技能服务内部错误，请稍后重试',
      'error.already-installed': '该技能已安装，无需重复安装',
      'error.not-installed': '该技能尚未安装或缺少来源记录，无法更新',
      'error.not-installable': '该技能暂不支持直接安装',
      'error.install-failed': '安装技能失败，请检查网络后重试',
      'error.update-failed': '更新技能失败，请检查网络后重试',
    };

    const en = {
      'panel.label': 'Skills',
      'panel.title': 'Skills',
      'panel.intro': 'Manage local skills, invocation permissions, usage, and cleanup.',
      'panel.subtitle': '{skills} skills · {agents} agents · {invocable} auto-invoke enabled',
      'tab.list': 'Skills sections',
      'tab.installed': 'Installed',
      'tab.discover': 'Discover',
      'tab.usage': 'Usage',
      'tab.diagnosis': 'Diagnosis',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel',
      'action.search': 'Search',
      'action.switch': 'Switch',
      'action.reload': 'Reload page',
      'action.dismiss': 'Dismiss',
      'action.discover': 'Discover skills',
      'action.backLibrary': 'Back to installed',
      'action.skipContent': 'Skip to main content',
      'status.ready': 'Synced',
      'status.updatedAt': 'Updated {time}',
      'status.saved': 'Saved',
      'status.removed': 'Deleted {name}',
      'status.installed': 'Installed {name}',
      'status.updatedSkill': 'Updated {name}',
      'status.boundSource': 'Recorded the source of {name}',
      'status.upToDate': '{name} is up to date',
      'status.busy': 'Working…',
      'status.failed': '{action} failed: {message}',
      'status.failedPlain': 'Action failed',
      'status.offlineInline': 'Could not reach the skill service. Showing cached data.',
      'filter.label': 'Filter by agent',
      'filter.all': 'All',
      'filter.agentOption': '{name} ({count})',
      'overview.skills': 'Installed',
      'overview.enabled': 'Auto-invoke',
      'overview.agents': 'Detected agents',
      'overview.calls': 'Total calls',
      'installed.title': 'Installed skills',
      'installed.body': 'Find and filter local skills, then manage invocation permissions.',
      'installed.search': 'Search installed skills',
      'installed.placeholder': 'Search by name, description, or source…',
      'installed.results': 'Showing {count} of {total} skills',
      'installed.noMatches': 'No skills match your filters',
      'installed.noMatchesBody': 'Try another keyword, or clear your filters.',
      'installed.reset': 'Clear filters',
      'installed.status': 'Invocation status',
      'installed.all': 'All statuses',
      'installed.enabled': 'Auto-invoke on',
      'installed.disabled': 'Auto-invoke off',
      'installed.writable': 'Manageable',
      'installed.updatable': 'Update available',
      'installed.sort': 'Sort by',
      'installed.sort.usage': 'Most used',
      'installed.sort.name': 'Name A–Z',
      'installed.sort.recent': 'Recently used',
      'installed.permissions': 'Invocation permissions',
      'installed.hint': 'Auto-invoke lets agents choose a skill automatically; /name lets you invoke it explicitly. Changes to shared skills apply to all linked agents.',
      'updates.check': 'Check for updates',
      'updates.checking': 'Checking for updates {done}/{total}',
      'updates.lastChecked': 'Last checked {time}',
      'updates.never': 'Not checked yet',
      'updates.pill': '{count} to update',
      'updates.pillChecking': 'Checking {done}/{total}',
      'updates.pillLatest': 'Up to date',
      'updates.pillCheckingStart': 'Checking…',
      'updates.pillInterrupted': 'Check interrupted',
      'updates.pillNone': 'Check for updates',
      'updates.panelTitle': 'Skill updates',
      'updates.panelAvailable': '{count} skills can be updated',
      'updates.onlyAvailable': 'Show updates only',
      'updates.autoBack': 'Back',
      'updates.interrupted': 'Check stopped after {done}/{total}; check again',
      'updates.available': '{count} updates available',
      'updates.applyAll': 'Update all ({count})',
      'updates.applyCommon': 'Common only ({count})',
      'updates.applying': 'Updating {done}/{total}',
      'updates.dismiss': 'Later',
      'updates.applied': 'Updated {ok} skills, {failed} failed',
      'updates.appliedAuto': 'Auto-updated {ok} skills, {failed} failed',
      'updates.autoToggle': 'Auto-update',
      'updates.autoChoose': 'Choose {count}',
      'updates.autoPicker': 'Auto-update skills',
      'updates.autoHint': 'Only checked skills update automatically, once after each check.',
      'updates.autoAll': 'Select all',
      'updates.autoNone': 'Clear',
      'updates.autoDone': 'Done',
      'updates.autoEmpty': 'No updates to choose from right now.',
      'skill.runtimesOne': '{agent} only',
      'skill.runtimesSome': '{count}/{total} agents',
      'skill.callsLabel': 'Calls',
      'skill.usageTitle': '{count} calls · {model} auto · {user} manual',
      'skill.readonly': 'Read-only',
      'skill.frequent': 'Frequent',
      'skill.updatable': 'Update available',
      'skill.closed': 'Disabled',
      'skill.model': 'Auto-invoke',
      'skill.user': '/name manual',
      'skill.modelSwitchAria': 'Auto-invoke: {name}',
      'skill.userSwitchAria': '/name manual: {name}',
      'skill.modelHint': 'Allow agents to invoke this skill automatically based on its description.',
      'skill.userHint': 'Allow invoking this skill explicitly in chat with /skill-name.',
      'skill.menuAria': 'More actions: {name}',
      'skill.menu.update': 'Update',
      'skill.menu.bind': 'Link source',
      'skill.menu.remove': 'Delete',
      'skill.menu.showPath': 'Show path',
      'skill.menu.hidePath': 'Hide path',
      'skill.path': 'Path',
      'skill.empty.title': 'No skills to manage yet',
      'skill.empty.body': 'Install a skill from Discover, or add a SKILL.md into your local skills directory.',
      'skill.emptyFiltered': 'No skills found for this agent.',
      'skill.loading': 'Loading skills…',
      'skill.removeConfirm': 'Delete “{name}”? Its skill folder will be removed permanently.',
      'skill.removeConfirmAction': 'Delete',
      'skill.busy': 'Saving…',
      'skill.bind.inputAria': 'Source reference',
      'skill.bind.placeholder': 'Skill name, owner/repo, or a GitHub link',
      'skill.bind.hint': 'Updating replaces the local skill directory with the source content.',
      'skill.bind.submit': 'Link and update',
      'skill.origin': 'From {ref}',
      'skill.originVersion': 'From {ref} · v{version}',
      'source.tencent': 'Tencent SkillHub',
      'discover.title': 'Discover skills',
      'discover.body': 'Search community catalogs and install directly into your local skills directory.',
      'discover.source': 'Skill source',
      'discover.placeholder': 'Skill name or repo, then Enter',
      'discover.githubLabel': 'Install from GitHub',
      'discover.githubPlaceholder': 'owner/repo, owner/repo@branch, or a GitHub link',
      'discover.githubSubmit': 'Install',
      'discover.searchLabel': 'Search skills',
      'discover.popular': 'Browse popular skills',
      'discover.popularScope': '{source} · Popular skills',
      'discover.popularResults': '{count} popular skills',
      'discover.results': '{count} search results',
      'discover.queryScope': '{source} · “{query}”',
      'discover.idle.title': 'Browse a skill source',
      'discover.idle.body': 'Search skills.sh or Tencent SkillHub and install directly into your local skills directory.',
      'discover.loading': 'Searching skills…',
      'discover.empty.title': 'No matching skills',
      'discover.empty.body': 'Try another keyword, or switch to the other source.',
      'discover.error.title': 'This source is unavailable',
      'discover.otherSource': 'Switch to {source}',
      'discover.unavailableTitle': 'No sources available',
      'discover.unavailableBody': 'Refresh to check available skill sources again.',
      'discover.install': 'Install',
      'discover.installAria': 'Install: {name}',
      'discover.installBlockedAria': 'Cannot install {name}: {reason}',
      'discover.notInstallable': 'Not directly installable',
      'discover.installing': 'Installing…',
      'discover.installed': 'Installed',
      'discover.version': 'v{version}',
      'discover.updated': 'Updated {date}',
      'discover.installsUnit': 'installs',
      'discover.columnRank': 'Rank',
      'discover.columnSkill': 'Skill',
      'discover.columnInstalls': 'Installs',
      'discover.note.suggestions': 'Showing popular skills',
      'usage.title': 'Usage',
      'usage.periodBody': 'View per-skill call trends and shares over a selected period across all agents.',
      'usage.period': 'Period',
      'usage.period.today': 'Today',
      'usage.period.7': 'Last 7 days',
      'usage.period.14': 'Last 14 days',
      'usage.period.30': 'Last 30 days',
      'usage.period.60': 'Last 60 days',
      'usage.period.custom': 'Custom dates',
      'usage.startDate': 'Start date',
      'usage.endDate': 'End date',
      'usage.availableRange': 'Available dates: {start} to {end}',
      'usage.boundedRange': 'This period exceeds retained history. Showing only {start} to {end}; earlier dates are excluded.',
      'usage.rangeError.required': 'Choose both a start and an end date.',
      'usage.rangeError.invalid': 'Enter valid dates.',
      'usage.rangeError.order': 'Start date must be on or before end date.',
      'usage.rangeError.bounds': 'Dates must fall between {start} and {end}.',
      'usage.rangeError.unavailable': 'No daily statistics available. Refresh or update the plugin.',
      'usage.periodCalls': 'Calls in period',
      'usage.periodActive': 'Active in period',
      'usage.periodActiveHint': 'Called at least once in this period, including removed skills',
      'usage.total': 'Total calls',
      'usage.totalHint': 'Across all agents',
      'usage.periodTrend': 'Calls over period',
      'usage.trendSkill': 'Trend scope',
      'usage.allSkills': 'All skills',
      'usage.periodChartSummary': '{name} · {range} · {count} calls, daily peak {peak}. Expand daily details below.',
      'usage.chart': 'Call trend',
      'usage.dayTitle': '{date} · {count} calls',
      'usage.breakdown': 'Daily call details',
      'usage.date': 'Date',
      'usage.count': 'Calls',
      'usage.perSkill': 'By skill',
      'usage.searchSkills': 'Search skill names',
      'usage.searchPlaceholder': 'Enter a skill name…',
      'usage.searchTableOnly': 'Search filters this table only. Shares reflect all calls in the selected period. Click a skill to view its trend.',
      'usage.tableResults': 'Showing {count} of {total} skills · {column}, {direction}',
      'usage.column.name': 'Skill name',
      'usage.column.count': 'Calls',
      'usage.column.share': 'Share',
      'usage.sort.ascending': 'ascending',
      'usage.sort.descending': 'descending',
      'usage.tableCaption': '{range} · Calls per skill and share of all calls in this period',
      'usage.removed': 'Outside current library',
      'usage.showTrend': 'Show period trend for {name}',
      'usage.noMatchingSkills': 'No matching skills.',
      'usage.recent': 'Recent activity',
      'usage.recentAllTime': 'Latest calls, independent of the selected period.',
      'usage.recentEmpty': 'No calls recorded yet.',
      'usage.note': 'Includes calls observed while this plugin is enabled. Daily history is kept for 60 days; cumulative totals are independent of period filters.',
      'usage.unknownAgent': 'Unknown agent',
      'diagnosis.title': 'Skill diagnosis',
      'diagnosis.basis': 'Based only on calls observed by this plugin; not a measure of skill quality.',
      'diagnosis.horizon': 'Observed since {date} · {days} days · {total} skills, {active} called in the last {activeDays} days.',
      'diagnosis.buckets': 'Group by state',
      'diagnosis.bucket.cleanup': 'Clean up',
      'diagnosis.bucket.dormant': 'Disabled',
      'diagnosis.bucket.active': 'In use',
      'diagnosis.bucket.kept': 'Kept',
      'diagnosis.bucket.unknown': 'Observing',
      'diagnosis.queueCount': '{bucket}: {count}',
      'diagnosis.searchLabel': 'Search skill names',
      'diagnosis.searchPlaceholder': 'Enter a skill name…',
      'diagnosis.selectRow': 'Select {name}',
      'diagnosis.selectAll': 'Select group',
      'diagnosis.clearSelection': 'Clear selection',
      'diagnosis.verdict.active': 'In use',
      'diagnosis.verdict.cooling': 'Idle recently',
      'diagnosis.verdict.stale': 'Unused',
      'diagnosis.verdict.unused': 'Never used',
      'diagnosis.verdict.kept': 'Kept',
      'diagnosis.verdict.unknown': 'Observing',
      'diagnosis.closed': 'Disabled',
      'diagnosis.evidence.idle': 'Idle {idle} days · {count} calls',
      'diagnosis.evidence.never': 'Never called · observed {watched} days',
      'diagnosis.evidence.lastUsed': 'Last call {date}',
      'diagnosis.evidence.kept': 'Kept {date}',
      'diagnosis.disable': 'Disable',
      'diagnosis.remove': 'Delete',
      'diagnosis.keep': 'Keep',
      'diagnosis.unkeep': 'Unkeep',
      'diagnosis.rail': 'Bulk actions',
      'diagnosis.tally': '{selected} selected · {disable} disable · {remove} delete · {readonly} read-only',
      'diagnosis.removeConfirmMany': 'Delete {count} selected skills ({names}{more})? Their folders will be removed permanently.',
      'diagnosis.moreNames': ' and {count} more',
      'diagnosis.policy': 'Diagnosis rules',
      'diagnosis.policy.active': 'Called within the last {days} days: in use.',
      'diagnosis.policy.stale': 'No calls for more than {days} days: unused and ready to clean up.',
      'diagnosis.policy.watch': 'Skills are observed for at least {days} days before unused reminders apply.',
      'diagnosis.policy.keep': 'Keep pauses cleanup reminders until the skill is called again.',
      'diagnosis.noCleanup.title': 'Nothing to clean up',
      'diagnosis.noCleanup.body': 'Skills observed for {days} days without a call appear here.',
      'diagnosis.noCleanup.action': 'View skills in use',
      'diagnosis.noMatches.title': 'No matching skills',
      'diagnosis.noMatches.body': 'Try another keyword, or clear the search.',
      'diagnosis.noMatches.action': 'Clear search',
      'diagnosis.bucketEmpty': 'No skills in this group.',
      'diagnosis.selectionStatus': '{count} skills selected',
      'diagnosis.disableNote': 'Disabled {ok}, failed {failed}.',
      'diagnosis.removeNote': 'Deleted {ok}, failed {failed}.',
      'diagnosis.keepNote': 'Updated {ok}, failed {failed}.',
      'diagnosis.oldHost.title': 'Update the plugin',
      'diagnosis.oldHost.body': 'The running service does not provide diagnosis data yet. Update and reload the plugin, then try again.',
      'preview.action': 'Preview',
      'preview.title': 'Skill preview',
      'preview.open': 'View details: {name}',
      'preview.close': 'Close preview',
      'preview.restore': 'Restore preview',
      'preview.maximize': 'Maximize preview',
      'preview.grow': 'Enlarge preview',
      'preview.shrink': 'Shrink preview',
      'preview.refresh': 'Refresh preview',
      'preview.files': 'Skill files',
      'preview.fileCount': '{count} files',
      'preview.content': 'File content',
      'preview.instructions': 'Instructions',
      'preview.view': 'Display mode',
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
      'offline.title': 'Skill service unavailable',
      'offline.body': 'The skill service did not respond. Make sure the plugin is enabled, then try again.',
      'crash.title': 'Skills page failed to render',
      'crash.body': 'Reloading the page re-mounts the plugin; check the browser console if it keeps failing.',
      'error.read-only': 'Read-only skill; it cannot be changed',
      'error.source-unavailable': 'This skill source is temporarily unavailable',
      'error.subpath-required': 'This repository holds several skills; name one with owner/repo#path',
      'error.flat-skill': 'A flat skill file cannot be updated in place; remove and reinstall',
      'error.source-rate-limited': 'Too many requests; please try again shortly',
      'error.invalid-response': 'The skill service returned unreadable data',
      'error.preview-unavailable': 'Preview is unavailable. Reload the plugin if it was just updated.',
      'error.preview-failed': 'Could not load the preview. Please retry.',
      'error.skill-not-found': 'This skill is no longer in the catalog. Refresh the list.',
      'error.file-not-found': 'This file no longer exists or cannot be previewed. Choose another file.',
      'error.bad-request': 'Invalid request parameters',
      'error.not-found': 'Requested skill or resource was not found',
      'error.unknown-action': 'Unsupported action',
      'error.unknown-source': 'Unknown skill source',
      'error.invalid-frontmatter': 'Invalid SKILL.md frontmatter; cannot save changes',
      'error.missing-frontmatter': 'SKILL.md is missing frontmatter; cannot update',
      'error.write-failed': 'Failed to write skill file; check folder permissions',
      'error.delete-failed': 'Failed to delete skill folder; check permissions or open files',
      'error.name-mismatch': 'Skill name does not match its directory or source; action aborted',
      'error.payload-too-large': 'Request payload is too large; select fewer items and try again',
      'error.state-unavailable': 'Skill catalog state is temporarily unavailable',
      'error.internal-error': 'Internal skill service error; please retry',
      'error.already-installed': 'This skill is already installed',
      'error.not-installed': 'This skill is not managed by an install source and cannot be updated',
      'error.not-installable': 'This entry cannot be installed directly',
      'error.install-failed': 'Failed to install skill; check your network and retry',
      'error.update-failed': 'Failed to update skill; check your network and retry',
    };

    // ---------------------------------------------------------------- css
    const CSS = `
.skd-page,.skd-previewOverlay{
  --skd-bg:var(--dsw-alias-bg-base,#fff);
  --skd-surface:var(--dsw-alias-bg-layer-1,#f7f8fa);
  --skd-surface-2:var(--dsw-alias-bg-layer-2,#eff1f5);
  --skd-overlay:var(--dsw-alias-bg-overlay,var(--skd-bg));
  --skd-mask:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / .45));
  --skd-skeleton:var(--dsw-alias-bg-skeleton,var(--skd-surface-2));
  --skd-fg:var(--dsw-alias-label-primary,#1f2329);
  --skd-muted:var(--dsw-alias-label-secondary,#5a6270);
  --skd-subtle:var(--dsw-alias-label-tertiary,#848c99);
  --skd-line:var(--dsw-alias-border-l1,rgb(0 0 0 / .08));
  --skd-control-line:var(--dsw-alias-border-l2,rgb(0 0 0 / .14));
  --skd-hover:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / .04));
  --skd-active:var(--dsw-alias-interactive-bg-active,rgb(0 0 0 / .08));
  --skd-accent:var(--dsw-alias-state-business-primary,#4d6bfe);
  --skd-accent-fill:var(--dsw-alias-button-primary-fill,var(--skd-accent));
  --skd-accent-hover:var(--dsw-alias-button-primary-hover,var(--skd-accent));
  --skd-accent-bg:var(--dsw-alias-interactive-bg-hover-business,rgb(77 107 254 / .1));
  --skd-on-accent:var(--dsw-alias-label-primary-foreground,#fff);
  --skd-success:var(--dsw-alias-state-success-primary,#16a34a);
  --skd-error:var(--dsw-alias-state-error-primary,#dc2626);
  --skd-error-bg:var(--dsw-alias-interactive-bg-hover-danger,rgb(220 38 38 / .08));
  --skd-warn:var(--dsw-alias-state-warn-primary,#d97706);
  --skd-radius-sm:var(--dsw-radius-sm,6px);
  --skd-radius:var(--dsw-radius-md,10px);
  --skd-radius-lg:var(--dsw-radius-lg,12px);
  --skd-font:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  --skd-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  --skd-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));
  box-sizing:border-box;
  color:var(--skd-fg);
  font-family:var(--skd-font);
  font-size:.875rem;
  line-height:1.55;
  font-variant-numeric:tabular-nums;
}
.skd-page *,.skd-previewDialog *{box-sizing:border-box}
.skd-page{container:dashboard / inline-size;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--skd-bg);overflow:hidden}
.skd-wrap{width:100%;max-width:1120px;margin:0 auto;padding-inline:clamp(20px,3cqw,36px)}
.skd-visuallyHidden{position:absolute;inline-size:1px;block-size:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skd-skipLink{position:absolute;inset-block-start:8px;inset-inline-start:16px;z-index:40;padding:8px 14px;border-radius:var(--skd-radius-sm);background:var(--skd-accent-fill);color:var(--skd-on-accent);font-size:.8125rem;font-weight:500;text-decoration:none;transform:translateY(-200%)}
.skd-skipLink:focus{transform:translateY(0)}

.skd-top{flex:none;border-bottom:1px solid var(--skd-line);background:var(--skd-bg)}
.skd-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;padding:24px 0 14px}
[data-platform=darwin] .skd-header{padding-top:calc(24px + var(--dsh-frame-top-clearance,0px))}
.skd-headText{min-width:0}
.skd-title{margin:0;font-size:1.25rem;line-height:1.4;font-weight:600;letter-spacing:-.015em;overflow-wrap:anywhere}
.skd-subtitle{margin:3px 0 0;color:var(--skd-muted);font-size:.8125rem;line-height:1.5;overflow-wrap:anywhere}
.skd-headerTools{display:flex;align-items:center;gap:8px;flex:none}
.skd-statusPill{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 10px;border:1px solid var(--skd-line);border-radius:999px;background:var(--skd-surface);color:var(--skd-muted);font-size:.75rem;line-height:1.4;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-statusPill[data-tone=ok]{color:var(--skd-success)}
.skd-statusPill[data-tone=error]{border-color:color-mix(in srgb,var(--skd-error) 30%,transparent);background:var(--skd-error-bg);color:var(--skd-error)}
.skd-statusDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--skd-subtle)}
.skd-statusDot[data-tone=ok]{background:var(--skd-success)}
.skd-statusDot[data-tone=error]{background:var(--skd-error)}
.skd-statusDot[data-busy]{background:var(--skd-accent);animation:skd-skeleton-pulse 1.4s var(--skd-ease) infinite}

.skd-tabbar{display:flex;flex-wrap:nowrap;align-items:stretch;gap:22px;width:100%;overflow-x:auto;scrollbar-width:none}
.skd-tabbar::-webkit-scrollbar{display:none}
.skd-tab{position:relative;flex:none;display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:0 2px 10px;border:0;background:none;color:var(--skd-muted);font:inherit;font-size:.8125rem;font-weight:500;white-space:nowrap;cursor:pointer;transition:color .15s var(--skd-ease)}
.skd-tab[aria-selected=true]{color:var(--skd-fg);font-weight:600}
.skd-tab[aria-selected=true]::after{content:"";position:absolute;inset:auto 0 0;height:2px;border-radius:2px 2px 0 0;background:var(--skd-accent)}
.skd-tabIcon{display:inline-flex;align-items:center;opacity:.75}
.skd-tab[aria-selected=true] .skd-tabIcon{color:var(--skd-accent);opacity:1}
.skd-tabCount{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--skd-surface-2);color:var(--skd-muted);font-size:.6875rem;font-weight:500;line-height:1}
.skd-tab[aria-selected=true] .skd-tabCount{background:var(--skd-accent-bg);color:var(--skd-accent)}
.skd-tabCount[data-tone=warn]{background:color-mix(in srgb,var(--skd-warn) 14%,transparent);color:var(--skd-warn)}

.skd-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.skd-content{padding-top:20px;padding-bottom:44px}
.skd-panel{display:flex;flex-direction:column;gap:16px;min-width:0}
.skd-panel:focus{outline:none}

.skd-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0 0;padding:10px 14px;border:1px solid color-mix(in srgb,var(--skd-error) 28%,transparent);border-radius:var(--skd-radius);background:var(--skd-error-bg);color:var(--skd-error);font-size:.8125rem;line-height:1.5}
.skd-banner .skd-button{min-height:28px;padding:3px 10px;font-size:.75rem}

.skd-updateWrap{position:relative;flex:none}
.skd-updatePill{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:0 11px;border:1px solid var(--skd-line);border-radius:999px;background:var(--skd-surface);color:var(--skd-muted);font:inherit;font-size:.75rem;line-height:1.4;white-space:nowrap;cursor:pointer;transition:border-color .15s var(--skd-ease),background-color .15s var(--skd-ease),color .15s var(--skd-ease)}
.skd-updatePill[data-tone=accent]{border-color:color-mix(in srgb,var(--skd-accent) 34%,transparent);background:var(--skd-accent-bg);color:var(--skd-accent-fill);font-weight:600}
.skd-updatePill[data-tone=error]{border-color:color-mix(in srgb,var(--skd-error) 30%,transparent);background:var(--skd-error-bg);color:var(--skd-error)}
.skd-updateDot{flex:none;inline-size:7px;block-size:7px;border-radius:50%;background:var(--skd-success)}
.skd-updateDot[data-tone=accent]{background:var(--skd-accent-fill)}
.skd-updateDot[data-tone=error]{background:var(--skd-error)}
.skd-updateDot[data-busy]{animation:skd-pulse 1.2s ease-in-out infinite}
.skd-updatePanel:focus{outline:none}
.skd-updatePanel{position:absolute;top:calc(100% + 8px);right:0;z-index:40;width:min(360px,calc(100vw - 32px));padding:14px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius);background:var(--skd-overlay);box-shadow:0 14px 40px rgb(0 0 0 / .18);color:var(--skd-fg);font-size:.8125rem;line-height:1.5;text-align:start}
.skd-updatePanelBody{display:flex;flex-direction:column;gap:10px}
.skd-updatePanelHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.skd-updatePanelTitle{font-weight:600;color:var(--skd-fg)}
.skd-updatePanelStatus{color:var(--skd-muted);font-size:.75rem;white-space:nowrap}
.skd-updateSummary{margin:0;color:var(--skd-fg)}
.skd-updateSummaryQuiet{color:var(--skd-muted)}
.skd-updateActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.skd-updateAuto{display:flex;align-items:center;justify-content:space-between;gap:10px}
.skd-updateAuto .skd-switchControl{width:auto}
.skd-updateHint{margin:0;color:var(--skd-muted);font-size:.75rem;line-height:1.5}
.skd-updateFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid var(--skd-line)}
.skd-updateError{margin:0;color:var(--skd-error);font-size:.75rem}
.skd-updatePickerActions{display:flex;align-items:center;gap:4px}
.skd-updatePickerList{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;max-block-size:212px;overflow:auto}
.skd-updatePickerItem{display:flex;align-items:center;gap:8px;min-block-size:28px;font-size:.8125rem;line-height:1.5;cursor:pointer}
.skd-updateCheckInput{flex:none;margin:0;inline-size:1rem;block-size:1rem;accent-color:var(--skd-accent);cursor:inherit}

.skd-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:16px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);background:var(--skd-surface);overflow:hidden}
.skd-overviewItem{display:flex;flex-direction:column;gap:2px;padding:12px 16px;border-inline-end:1px solid var(--skd-line)}
.skd-overviewItem:last-child{border-inline-end:0}
.skd-overviewLabel{font-size:.75rem;color:var(--skd-muted);line-height:1.4}
.skd-overviewValue{font-size:1.375rem;line-height:1.3;font-weight:600;letter-spacing:-.02em;color:var(--skd-fg)}

.skd-sectionHead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px}
.skd-sectionTitle{margin:0;font-size:1rem;font-weight:600;line-height:1.4;letter-spacing:-.01em}
.skd-sectionBody{margin:2px 0 0;color:var(--skd-muted);font-size:.8125rem;line-height:1.5;max-width:72ch}
.skd-noteLine{margin:0;max-width:92ch;color:var(--skd-muted);font-size:.75rem;line-height:1.6;overflow-wrap:anywhere}
.skd-micro{font-size:.6875rem;line-height:1.5;color:var(--skd-muted);font-weight:500}
.skd-resultLine{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;color:var(--skd-muted);font-size:.75rem;min-height:22px}
.skd-libraryResults .skd-button[data-variant=text]{color:var(--skd-accent);margin-inline-start:auto}
.skd-libraryResults+.skd-noteLine{margin-top:-8px}

.skd-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;min-height:34px;padding:6px 12px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius-sm);background:var(--skd-bg);color:var(--skd-fg);font:inherit;font-size:.8125rem;font-weight:500;line-height:1.4;cursor:pointer;white-space:nowrap;transition:background-color .15s var(--skd-ease),border-color .15s var(--skd-ease),color .15s var(--skd-ease)}
.skd-button:disabled{opacity:.48;cursor:default}
.skd-button[data-variant=primary]{border-color:transparent;background:var(--skd-accent-fill);color:var(--skd-on-accent)}
.skd-button[data-variant=outline]{border-color:var(--skd-control-line);background:var(--skd-bg);color:var(--skd-fg)}
.skd-button[data-variant=danger]{border-color:color-mix(in srgb,var(--skd-error) 35%,transparent);background:var(--skd-bg);color:var(--skd-error)}
.skd-button[data-variant=text]{min-height:auto;padding:2px 4px;border-color:transparent;background:none;color:var(--skd-accent)}
.skd-button[data-done]{border-color:var(--skd-line);background:var(--skd-surface);color:var(--skd-muted)}

.skd-iconButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:var(--skd-radius-sm);background:none;color:var(--skd-muted);cursor:pointer;transition:background-color .15s var(--skd-ease),color .15s var(--skd-ease),border-color .15s var(--skd-ease)}
.skd-headerTools .skd-iconButton{border-color:var(--skd-control-line);width:34px;height:34px;background:var(--skd-bg)}
.skd-iconButton[data-open]{background:var(--skd-active);color:var(--skd-fg)}
.skd-iconButton:disabled{opacity:.45;cursor:default}
.skd-iconButton[data-spinning] svg{animation:skd-spin .85s linear infinite}
@keyframes skd-spin{to{transform:rotate(360deg)}}

.skd-fieldLabel{display:block;font-size:.75rem;font-weight:500;color:var(--skd-muted);margin-bottom:4px}
.skd-field{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;color:var(--skd-muted);font-size:.75rem}
.skd-field>span{font-weight:500;overflow-wrap:anywhere}
.skd-searchField{display:flex;flex-direction:column;min-width:0;flex:1}
.skd-searchBox{position:relative;display:flex;align-items:center;min-width:0;width:100%}
.skd-searchBox>svg{position:absolute;inset-inline-start:11px;pointer-events:none;color:var(--skd-subtle)}
.skd-input{flex:1;min-width:0;min-height:36px;padding:6px 11px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius-sm);background:var(--skd-bg);color:var(--skd-fg);font:inherit;font-size:.8125rem;line-height:1.45;transition:border-color .15s var(--skd-ease)}
.skd-searchBox .skd-input{padding-inline-start:34px;width:100%}
.skd-input:focus{border-color:var(--skd-accent);outline:none}
.skd-input::placeholder{color:var(--skd-subtle)}

.skd-select{max-width:100%;min-width:116px;min-height:36px;padding:6px 28px 6px 10px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius-sm);background:var(--skd-bg);color:var(--skd-fg);font:inherit;font-size:.8125rem;line-height:1.45;cursor:pointer;transition:border-color .15s var(--skd-ease),background-color .15s var(--skd-ease)}
@supports (appearance:base-select){
  .skd-select,.skd-select::picker(select){appearance:base-select}
  .skd-select{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 6px 11px;white-space:nowrap;overflow:hidden}
  .skd-select::picker-icon{flex:none;margin-inline-start:4px;color:var(--skd-subtle);font-size:.625rem;transition:transform .16s var(--skd-ease)}
  .skd-select:open::picker-icon{transform:rotate(180deg)}
  .skd-select:open{border-color:var(--skd-accent)}
  .skd-select::picker(select){margin-block-start:4px;padding:4px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius);background:var(--skd-overlay);color:var(--skd-fg);box-shadow:0 10px 30px rgb(0 0 0 / .16);min-inline-size:anchor-size(width);max-inline-size:min(28rem,calc(100vw - 2rem));max-block-size:min(20rem,48dvh);overflow:auto;overscroll-behavior:contain}
  .skd-select option{padding:6px 10px;border-radius:var(--skd-radius-sm);font-size:.8125rem;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .skd-select option:checked{font-weight:600;background:var(--skd-active)}
}

.skd-segmented{display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--skd-control-line);border-radius:8px;background:var(--skd-surface-2);max-width:100%;overflow-x:auto}
.skd-segment{display:inline-flex;align-items:center;gap:7px;flex:none;max-width:190px;min-height:30px;padding:4px 11px;border:1px solid transparent;border-radius:var(--skd-radius-sm);background:none;color:var(--skd-muted);font:inherit;font-size:.8125rem;font-weight:500;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background-color .15s var(--skd-ease),color .15s var(--skd-ease),border-color .15s var(--skd-ease)}
.skd-segmentDot{flex:none;inline-size:6px;block-size:6px;border:1.5px solid currentColor;border-radius:50%;opacity:.45;transition:background-color .15s var(--skd-ease),opacity .15s var(--skd-ease)}
.skd-segment[data-active]{border-color:color-mix(in srgb,var(--skd-accent) 38%,transparent);background:var(--skd-accent-bg);color:var(--skd-accent);font-weight:600;box-shadow:0 1px 2px rgb(0 0 0 / .06)}
.skd-segment[data-active] .skd-segmentDot{background:currentColor;border-color:currentColor;opacity:1}
.skd-segment:not(:disabled):not([data-active]):hover{background:var(--skd-hover);color:var(--skd-fg)}
.skd-segment:disabled{opacity:.45;cursor:default}
.skd-segment:disabled .skd-segmentDot{opacity:.25}

.skd-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.skd-badge{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-height:20px;padding:1px 7px;border-radius:999px;background:var(--skd-surface-2);color:var(--skd-muted);font-size:.6875rem;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skd-badge[data-tone=accent]{background:var(--skd-accent-bg);color:var(--skd-accent)}
.skd-badge[data-tone=muted]{border:1px solid var(--skd-line);background:none;color:var(--skd-subtle)}

.skd-toolbar{display:flex;flex-direction:column;gap:12px;padding:14px;background:var(--skd-surface);border:1px solid var(--skd-line);border-radius:var(--skd-radius)}
.skd-filterBar{display:grid;grid-template-columns:minmax(14rem,1fr) auto auto auto;align-items:end;gap:10px 12px;padding:0 0 14px;border:0;border-bottom:1px solid var(--skd-line);border-radius:0;background:none}
.skd-filterBar>.skd-field>.skd-select{inline-size:100%;min-inline-size:8.5rem;max-inline-size:15rem}

.skd-tableHeading{display:grid;grid-template-columns:minmax(0,1fr) 3.75rem 10.5rem 2.25rem;gap:0 18px;padding:0 16px 4px;margin-bottom:-10px;color:var(--skd-muted);font-size:.6875rem;font-weight:500;letter-spacing:.01em}
.skd-tableHeading span:nth-child(2){text-align:end}
.skd-list{margin:0;padding:0;list-style:none;border:1px solid var(--skd-line);border-radius:var(--skd-radius);overflow:hidden;background:var(--skd-bg)}
.skd-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 3.75rem 10.5rem 2.25rem;gap:4px 18px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--skd-line);transition:background-color .15s var(--skd-ease)}
.skd-list>li:last-child .skd-row{border-bottom:0}
.skd-row[data-closed] .skd-rowMain{opacity:.72}
.skd-row[data-busy]{opacity:.68}
.skd-rowMain{position:relative;display:flex;flex-direction:column;gap:3px;min-width:0;cursor:pointer}
.skd-rowHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.skd-nameButton{display:inline;padding:0;border:0;background:none;color:inherit;font:inherit;font-weight:600;text-align:start;cursor:pointer;text-decoration:none;border-radius:4px}
.skd-rowName{min-width:0;max-width:100%;font-size:.875rem;font-weight:600;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-rowName::after{content:"";position:absolute;inset:0;border-radius:6px}
.skd-row:has(.skd-rowName:focus-visible) .skd-rowMain{outline:2px solid var(--skd-accent);outline-offset:2px;border-radius:6px}
.skd-rowDesc{margin:0;max-width:90ch;color:var(--skd-muted);font-size:.78125rem;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:1;line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.skd-rowRail{display:grid;grid-template-columns:subgrid;grid-column:2 / -1;align-items:center}
.skd-metric{display:flex;flex-direction:column;align-items:flex-end;gap:2px;text-align:end}
.skd-metric .skd-micro{display:none}
.skd-metricValue{font-size:.875rem;line-height:1.4;font-weight:500;color:var(--skd-fg)}

.skd-switchGroup{display:flex;flex-direction:column;gap:4px;border:0;padding:0}
.skd-switchRow{display:flex;align-items:center;min-width:0}
.skd-switchControl{position:relative;display:grid;grid-template-columns:1fr auto;align-items:center;column-gap:10px;min-block-size:1.5rem;width:100%;cursor:pointer}
.skd-switchControl:has(:disabled){cursor:default;opacity:.55}
.skd-switchLabel{color:var(--skd-muted);font-size:.75rem;line-height:1.4;overflow-wrap:anywhere}
.skd-switchInput{position:absolute;clip-path:inset(50%);overflow:hidden;inline-size:1px;block-size:1px;margin:-1px;padding:0;border:0;white-space:nowrap}
.skd-switch{position:relative;flex:none;inline-size:32px;block-size:18px;border:1px solid var(--skd-control-line);border-radius:999px;background:var(--skd-surface-2);transition:background-color .16s var(--skd-ease),border-color .16s var(--skd-ease)}
.skd-switchThumb{position:absolute;inset-block-start:2px;inset-inline-start:2px;inline-size:12px;block-size:12px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgb(0 0 0 / .2);transition:transform .16s var(--skd-ease)}
.skd-switchInput:checked~.skd-switch{border-color:var(--skd-accent);background:var(--skd-accent)}
.skd-switchInput:checked~.skd-switch .skd-switchThumb{transform:translateX(14px)}
.skd-switchControl:has(.skd-switchInput:focus-visible) .skd-switch{outline:2px solid var(--skd-accent);outline-offset:2px}

.skd-menuWrap{position:relative;flex:none;justify-self:end}
.skd-menu{position:fixed;inset:auto;margin:0;z-index:20;min-inline-size:10.5rem;max-inline-size:calc(100vw - 1rem);max-block-size:calc(100dvh - 1rem);overflow:auto;padding:5px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius);background:var(--skd-overlay);color:var(--skd-fg);font:inherit;box-shadow:0 10px 28px rgb(0 0 0 / .16)}
.skd-menu[hidden]{display:none}
.skd-menu[popover]:not(:popover-open){display:none}
.skd-menuGroup{display:flex;flex-direction:column;gap:2px}
.skd-page .skd-menu[data-position-fallback]{position-area:none;left:var(--skd-menu-left);top:var(--skd-menu-top);margin:0}
@supports(position-area:block-end){.skd-menu[popover]{position-area:block-end span-inline-start;position-try-fallbacks:flip-block,flip-inline,flip-block flip-inline;margin-block:6px}}
@supports not (position-area:block-end){.skd-menu[popover]{left:var(--skd-menu-left);top:var(--skd-menu-top)}}
.skd-menuItem{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:var(--skd-radius-sm);background:none;color:var(--skd-fg);font:inherit;font-size:.8125rem;line-height:1.45;text-align:start;white-space:nowrap;cursor:pointer;transition:background-color .12s var(--skd-ease)}
.skd-menuItem:disabled{opacity:.45;cursor:default}
.skd-menuItem[data-danger]{color:var(--skd-error)}
.skd-confirm{grid-column:1 / -1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;padding:10px 12px;border-radius:var(--skd-radius-sm);background:var(--skd-error-bg)}
.skd-confirmText{flex:1;min-width:160px;font-size:.8125rem;line-height:1.5;color:var(--skd-fg)}
.skd-path{grid-column:1 / -1;display:flex;align-items:baseline;gap:10px;min-width:0;margin-top:6px;padding:8px 12px;border-radius:var(--skd-radius-sm);background:var(--skd-surface)}
.skd-pathValue{min-width:0;color:var(--skd-muted);font-family:var(--skd-mono);font-size:.75rem;line-height:1.55;overflow-wrap:anywhere}

.skd-empty,.skd-state{display:flex;flex-direction:column;gap:8px;align-items:center;padding:44px 24px;text-align:center;border:1px dashed var(--skd-control-line);border-radius:var(--skd-radius);background:var(--skd-surface)}
.skd-stateTitle{margin:0;font-size:.9375rem;font-weight:600;line-height:1.45}
.skd-stateBody{margin:0;max-width:52ch;color:var(--skd-muted);font-size:.8125rem;line-height:1.55;overflow-wrap:anywhere}
.skd-stateActions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;justify-content:center}
.skd-stateIcon{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);margin-bottom:4px;color:var(--skd-accent);background:var(--skd-bg)}
.skd-offline{display:flex;flex-direction:column;align-items:center;gap:10px;padding-block:72px;text-align:center}
.skd-offlineTitle{margin:0;font-size:1.125rem;font-weight:600;line-height:1.4}
.skd-offlineBody{margin:0;max-width:48ch;color:var(--skd-muted);font-size:.875rem;line-height:1.55}

@keyframes skd-skeleton-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes skd-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
.skd-skelBlock{display:block;border-radius:var(--skd-radius-sm);background:var(--skd-skeleton);animation:skd-skeleton-pulse 2s cubic-bezier(.36,0,.64,1) infinite}
.skd-skelFilterBar{display:grid;grid-template-columns:minmax(14rem,1fr) 9rem 9rem 9rem;gap:12px;padding:0 0 14px;border-bottom:1px solid var(--skd-line)}
.skd-skelInput{height:36px;border-radius:var(--skd-radius-sm)}
.skd-skelRow{display:grid;grid-template-columns:minmax(0,1fr) 3.75rem 10.5rem 2.25rem;gap:6px 18px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--skd-line)}
.skd-skelRow:last-child{border-bottom:0}
.skd-skelRowMain{display:flex;flex-direction:column;gap:8px;min-width:0}
.skd-skelSwitches{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.skd-previewProgress{position:relative;height:2px;width:100%;overflow:hidden;background:var(--skd-line);flex:none}
.skd-previewProgress::after{content:"";position:absolute;inset:0 auto 0 0;width:35%;background:var(--skd-accent);animation:skd-indeterminate 1.2s var(--skd-ease) infinite}
.skd-previewSkelTree{display:flex;flex-direction:column;gap:10px;padding:8px 14px 16px}
.skd-previewSkelDoc{display:flex;flex-direction:column;gap:12px;max-width:72ch;margin:0 auto;padding:24px 28px;width:100%}

.skd-searchRow{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;padding:14px;background:var(--skd-surface);border:1px solid var(--skd-line);border-radius:var(--skd-radius)}
.skd-sourceField{display:flex;flex-direction:column;flex:none}
.skd-searchRow>.skd-button{min-height:36px}
.skd-rankHead{display:grid;grid-template-columns:2.25rem minmax(0,1fr) 9.5rem 6.5rem;gap:0 16px;padding:0 16px 6px;color:var(--skd-muted);font-size:.6875rem;font-weight:500}
.skd-rankHead span:nth-child(1),.skd-rankHead span:nth-child(3){text-align:end}
.skd-rankList{margin:0;padding:0;list-style:none;border:1px solid var(--skd-line);border-radius:var(--skd-radius);overflow:hidden;background:var(--skd-bg)}
.skd-rankItem{position:relative;display:grid;grid-template-columns:2.25rem minmax(0,1fr) 9.5rem 6.5rem;gap:0 16px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--skd-line);transition:background-color .15s var(--skd-ease)}
.skd-rankList>li:last-child{border-bottom:0}
.skd-rankNo{justify-self:end;align-self:start;padding-block-start:2px;color:var(--skd-muted);font-size:.75rem;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.skd-rankItem[data-top] .skd-rankNo{color:var(--skd-fg);font-weight:600}
.skd-rankMain{display:flex;flex-direction:column;gap:3px;min-width:0}
.skd-rankTitle{display:flex;align-items:baseline;gap:8px;min-width:0}
.skd-rankName{margin:0;font-size:.875rem;line-height:1.45;font-weight:600;overflow-wrap:anywhere}
.skd-rankTitle .skd-nameButton::after{content:"";position:absolute;inset:0;border-radius:inherit}
.skd-rankVersion{flex:none;color:var(--skd-muted);font-size:.6875rem;line-height:1.45}
.skd-rankDesc{margin:0;max-width:90ch;color:var(--skd-muted);font-size:.8125rem;line-height:1.55;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:1;line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.skd-rankMeta{display:flex;align-items:baseline;gap:10px;min-width:0}
.skd-rankMeta .skd-micro{white-space:nowrap}
.skd-rankInstalls{display:flex;align-items:baseline;justify-content:flex-end;gap:4px;text-align:end;white-space:nowrap}
.skd-rankInstalls b{font-size:.8125rem;line-height:1.45;font-weight:500;font-variant-numeric:tabular-nums}
.skd-rankInstalls[data-empty] b,.skd-rankInstalls[data-empty]{color:var(--skd-muted);font-weight:400}
.skd-rankUnit{color:var(--skd-muted);font-size:.6875rem}
.skd-rankAction{position:relative;z-index:1;justify-self:end}
.skd-rankItem .skd-nameButton{overflow-wrap:anywhere}
.skd-slug{min-width:0;max-width:100%;color:var(--skd-muted);font-size:.6875rem;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.skd-periodControls{display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-end;justify-content:flex-start;gap:12px}
.skd-periodField{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-inline-size:0;font-size:.75rem;color:var(--skd-muted)}
.skd-periodField .skd-input,.skd-periodField .skd-select{min-inline-size:0;max-inline-size:100%;color:var(--skd-fg)}
.skd-periodRange{flex:1 1 14rem;margin:0 0 6px;text-align:end}
.skd-periodValidation{flex-basis:100%}
.skd-periodValidation:empty{position:absolute;inline-size:1px;block-size:1px;clip-path:inset(50%)}
.skd-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.skd-statCard{display:flex;flex-direction:column;gap:4px;padding:16px 18px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);background:var(--skd-surface)}
.skd-statValue{font-size:1.625rem;line-height:1.25;font-weight:600;letter-spacing:-.025em;overflow-wrap:anywhere}
.skd-statHint{color:var(--skd-muted);font-size:.75rem;line-height:1.5}
.skd-panelCard{margin:0;min-width:0;padding:18px 20px;border:1px solid var(--skd-line);border-radius:var(--skd-radius);background:var(--skd-bg)}
.skd-usagePanel .skd-panelCard>h3{margin:0 0 10px;color:var(--skd-fg);font-size:.875rem;font-weight:600}
.skd-usagePanel .skd-panelCard>.skd-periodField{margin-block-end:6px}
.skd-cardTitleRow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.skd-cardTitleRow .skd-micro{margin:0;font-size:.875rem;font-weight:600;color:var(--skd-fg)}
.skd-cardTitleRow>.skd-periodField{max-inline-size:min(100%,18rem)}
.skd-periodTrendTitle{scroll-margin-block-start:16px;border-radius:4px;overflow-wrap:anywhere}
.skd-chartSummary{margin-bottom:8px}
.skd-chart{display:flex;align-items:flex-end;gap:clamp(2px,.5vw,8px);height:180px;padding:12px 4px 0;border-bottom:1px solid var(--skd-line);background:repeating-linear-gradient(to top,transparent 0,transparent calc(25% - 1px),var(--skd-line) calc(25% - 1px),var(--skd-line) 25%)}
.skd-chartCol{position:relative;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;flex:1;min-width:0;height:100%}
.skd-bar{width:100%;max-width:44px;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--skd-accent) 78%,var(--skd-bg));transition:background-color .15s var(--skd-ease)}
.skd-bar[data-empty]{background:var(--skd-line)}
.skd-chartCol::after{content:attr(data-count);position:absolute;bottom:100%;font-size:.6875rem;color:var(--skd-muted);opacity:0;pointer-events:none}
.skd-chartAxis{display:flex;justify-content:space-between;margin-top:8px;color:var(--skd-subtle);font-size:.6875rem;line-height:1.5}
.skd-chartDetails{margin-top:12px;color:var(--skd-muted);font-size:.75rem}
.skd-chartDetails summary{cursor:pointer;min-height:30px;padding:4px 0;font-weight:500}
.skd-chartDetails table{width:100%;border-collapse:collapse;text-align:start}
.skd-chartDetails td,.skd-chartDetails th{padding:6px 10px;border-bottom:1px solid var(--skd-line)}
.skd-periodTableScroll{max-inline-size:100%;overflow:auto;overscroll-behavior-inline:contain;border:1px solid var(--skd-line);border-radius:var(--skd-radius-sm);margin-block-start:10px;max-block-size:28rem;scroll-padding-block-start:3.25rem}
.skd-periodTable{--skd-cell-padding:12px;inline-size:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:.8125rem;line-height:1.45;text-align:start}
.skd-periodTable caption{padding:10px 12px;text-align:start;color:var(--skd-muted);font-size:.75rem;overflow-wrap:anywhere}
.skd-periodTable th,.skd-periodTable td{padding:7px var(--skd-cell-padding);border-block-end:1px solid var(--skd-line);text-align:start;font-weight:400;overflow-wrap:anywhere}
.skd-periodTable thead th{position:sticky;inset-block-start:0;z-index:2;background:var(--skd-surface);font-weight:600;padding:0}
.skd-periodTable thead th:first-child{inline-size:52%}
.skd-periodTable th:not(:first-child),.skd-periodTable td{text-align:end}
.skd-periodTable td[colspan]{text-align:start}
.skd-periodSort{display:flex;justify-content:flex-end;align-items:center;gap:6px;inline-size:100%;min-block-size:38px;padding:6px var(--skd-cell-padding);border:0;background:transparent;color:inherit;font:inherit;font-weight:600;text-align:inherit;cursor:pointer}
.skd-periodTable th:first-child .skd-periodSort{justify-content:space-between}
.skd-periodSort>span:first-child{min-inline-size:0;overflow-wrap:anywhere}
.skd-periodSort>span:last-child{flex:none}
.skd-periodSkill{display:inline-block;max-inline-size:100%;border:0;background:transparent;color:var(--skd-accent);font:inherit;font-weight:500;text-align:start;cursor:pointer;padding:3px 2px;min-block-size:28px;overflow-wrap:anywhere}
.skd-periodSkill[aria-pressed=true]{text-decoration:underline;text-underline-offset:3px}
.skd-periodSkill+.skd-badge{margin-inline-start:6px}
.skd-periodTable tbody tr:last-child>*{border-block-end:0}
.skd-activity{display:flex;flex-direction:column}
.skd-activityRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--skd-line)}
.skd-activityRow:last-child{border-bottom:0}
.skd-activityMain{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.skd-activityName{min-width:0;color:var(--skd-fg);font-size:.8125rem;font-weight:500;line-height:1.45;overflow-wrap:anywhere}
.skd-activityTime{flex:none;color:var(--skd-subtle);font-size:.75rem;line-height:1.45}

.skd-diagnosisHeading{scroll-margin-block-start:16px;border-radius:4px}
.skd-diagnosisHorizon{margin:0}
.skd-diagnosisBuckets{display:flex;align-items:center;flex-wrap:wrap}
.skd-diagnosisBuckets .skd-segmented{flex-wrap:wrap;overflow:visible}
.skd-diagnosisBuckets .skd-segment{flex:0 0 auto}
.skd-bucketOption{display:inline-flex;align-items:baseline;gap:6px}
.skd-bucketCount{font-weight:600;color:var(--skd-fg)}
.skd-diagnosisQueue{display:grid;grid-template-columns:auto minmax(0,22rem) auto;align-items:end;gap:10px 14px}
.skd-diagnosisQueue>.skd-button{justify-self:end}
.skd-diagnosisResults{grid-column:1;align-self:center;justify-content:flex-start}
.skd-diagnosisNoAction{color:var(--skd-subtle);font-size:.8125rem}
.skd-diagnosisList{background:var(--skd-bg);border-color:var(--skd-line);overflow-anchor:none}
.skd-diagnosisItem{list-style:none;content-visibility:auto;contain-intrinsic-size:auto 72px}
.skd-diagnosisRow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:4px 14px;padding:10px 16px;border-block-end:1px solid var(--skd-line);transition:background-color .15s var(--skd-ease)}
.skd-diagnosisList>li:last-child .skd-diagnosisRow{border-block-end:0}
.skd-diagnosisCheck{position:relative;display:inline-flex;align-items:center;justify-content:center;inline-size:1.5rem;block-size:1.5rem;cursor:pointer;border-radius:4px}
.skd-diagnosisCheckInput{margin:0;inline-size:1rem;block-size:1rem;accent-color:var(--skd-accent);cursor:inherit}
.skd-diagnosisCheckInput:disabled{cursor:default;opacity:.5}
.skd-diagnosisMain{display:flex;flex-direction:column;gap:3px;min-inline-size:0}
.skd-diagnosisEvidence{margin:0;color:var(--skd-muted);font-size:.75rem;line-height:1.5;overflow-wrap:anywhere}
.skd-diagnosisActions{display:flex;align-items:center;gap:6px;flex:none}
.skd-diagnosisActions .skd-button{min-block-size:28px;padding:3px 10px;font-size:.75rem}
.skd-diagnosisRowNote{margin-block:0 8px;padding-inline-start:40px}
.skd-diagnosisConfirm{grid-column:1 / -1}
.skd-diagnosisRail{position:sticky;inset-block-end:12px;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius);background:var(--skd-overlay);box-shadow:0 8px 24px rgb(0 0 0 / .14)}
.skd-diagnosisTally{margin:0;color:var(--skd-muted);font-size:.75rem;line-height:1.5;overflow-wrap:anywhere}
.skd-diagnosisRailActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.skd-diagnosisPolicyList{margin:0;padding-inline-start:1.25em;font-size:.75rem;line-height:1.7;color:var(--skd-muted)}

.skd-previewOverlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:12px}
.skd-previewBackdrop{position:absolute;inset:0;background:var(--skd-mask)}
.skd-previewDialog{position:relative;z-index:1;inline-size:min(1280px,92vw);block-size:min(860px,88dvh);min-inline-size:min(640px,calc(100vw - 24px));min-block-size:min(400px,calc(100dvh - 24px));max-inline-size:calc(100vw - 24px);max-block-size:calc(100dvh - 24px);padding:0;border:1px solid var(--skd-control-line);border-radius:var(--skd-radius-lg);background:var(--skd-overlay);box-shadow:0 24px 72px rgb(0 0 0 / .24);overflow:hidden;resize:both}
.skd-previewDialog[data-maximized]{inline-size:calc(100vw - 16px);block-size:calc(100dvh - 16px);max-inline-size:calc(100vw - 16px);max-block-size:calc(100dvh - 16px);resize:none;border-radius:var(--skd-radius)}
.skd-previewRoot{height:100%;min-height:0;overflow:hidden;display:flex!important;flex-direction:column;background:var(--skd-overlay)}
.skd-previewHeader{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 20px;border-bottom:1px solid var(--skd-line);flex:none}
.skd-previewIdentity{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.skd-previewEyebrow{font-size:.6875rem;color:var(--skd-subtle)}
.skd-previewTitle{margin:0;font-size:1.0625rem;line-height:1.35;font-weight:600;overflow-wrap:anywhere}
.skd-previewDescription{margin:0;color:var(--skd-muted);font-size:.8125rem;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:clip}
.skd-previewHeader .skd-badges{margin-top:2px}
.skd-windowTools{display:flex;align-items:center;gap:2px;flex:none;padding:3px;border:1px solid var(--skd-line);border-radius:8px;background:var(--skd-surface)}
.skd-windowTools .skd-iconButton{border:0;width:30px;height:30px;border-radius:var(--skd-radius-sm)}
.skd-windowTools .skd-windowToolsClose{margin:0;padding-inline-start:3px;border-inline-start:1px solid var(--skd-line)}
.skd-previewLayout{display:grid;grid-template-columns:minmax(210px,270px) minmax(0,1fr);flex:1;min-height:0;min-width:0}
.skd-previewFilesToggle{display:none}
.skd-previewFiles{display:flex;flex-direction:column;min-height:0;min-width:0;border-inline-end:1px solid var(--skd-line);background:var(--skd-surface)}
.skd-previewFilesHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px 8px;flex:none}
.skd-previewFilesHead h3{margin:0;font-size:.75rem;line-height:1.4;font-weight:600;color:var(--skd-muted)}
.skd-fileCount{display:inline-flex;align-items:center;min-height:20px;padding:0 7px;border:1px solid var(--skd-line);border-radius:999px;background:var(--skd-bg);color:var(--skd-muted);font-size:.6875rem}
.skd-fileList{list-style:none;margin:0;padding:0 8px 12px;overflow:auto;overscroll-behavior:contain;min-height:0}
.skd-fileList .skd-treeChildren{padding:0 0 0 14px;margin:0 0 0 10px;border-inline-start:1px solid var(--skd-line);list-style:none}
.skd-folderLabel{display:flex;align-items:center;gap:6px;min-height:30px;padding:5px 8px;border-radius:var(--skd-radius-sm);color:var(--skd-fg);font-size:.75rem;line-height:1.5;cursor:pointer;list-style:none}
.skd-folderLabel::-webkit-details-marker{display:none}
.skd-folderLabel>span{overflow-wrap:anywhere;min-width:0}
.skd-folderLabel svg{flex:none}
.skd-folderLabel>svg:first-child{transform:rotate(-90deg)}
.skd-folder[open]>.skd-folderLabel>svg:first-child{transform:rotate(0)}
.skd-fileButton{display:flex;align-items:flex-start;gap:7px;width:100%;min-height:30px;padding:6px 8px;border:1px solid transparent;border-radius:var(--skd-radius-sm);background:none;color:var(--skd-muted);font:inherit;font-size:.75rem;line-height:1.5;text-align:start;cursor:pointer}
.skd-fileButton svg{flex:none;margin-top:2px}
.skd-fileButton>span:not(.skd-fileKind){min-width:0;overflow-wrap:anywhere}
.skd-fileButton[aria-pressed=true]{background:var(--skd-bg);color:var(--skd-fg);border-color:var(--skd-line);font-weight:500}
.skd-fileKind{flex:none;margin-inline-start:auto;font-size:.625rem;color:var(--skd-subtle)}
.skd-previewViewer{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--skd-bg)}
.skd-previewViewerHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-height:44px;padding:6px 20px;border-bottom:1px solid var(--skd-line);flex:none}
.skd-previewFilename{display:flex;align-items:center;gap:6px;font-size:.75rem;font-family:var(--skd-mono);color:var(--skd-muted);min-width:0;overflow-wrap:anywhere}
.skd-previewViewerHead .skd-segmented{margin-inline-start:auto}
.skd-previewViewerHead .skd-segment{min-height:24px;padding:2px 9px;font-size:.6875rem}
.skd-previewContent{min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px 28px 32px;flex:1;scrollbar-gutter:stable}
.skd-prose{max-inline-size:min(100%,86ch);margin-inline:auto;font-size:.9rem;line-height:1.75;overflow-wrap:anywhere}
.skd-prose h3,.skd-prose h4,.skd-prose h5,.skd-prose h6{margin:1.3em 0 .55em;line-height:1.4;font-weight:600;color:var(--skd-fg)}
.skd-prose h3{font-size:1.25rem;letter-spacing:-.015em}
.skd-prose h4{font-size:1rem}
.skd-prose>:first-child{margin-top:0}
.skd-prose p{margin:.75em 0}
.skd-prose ul{padding-inline-start:1.5em;margin:.75em 0}
.skd-prose li{margin:.3em 0}
.skd-prose code{font-family:var(--skd-mono);font-size:.85em;background:var(--skd-surface-2);padding:.12em .32em;border-radius:4px;box-decoration-break:clone}
.skd-prose pre{margin:.9em 0;max-width:100%;padding:14px 16px;border:1px solid var(--skd-line);border-radius:var(--skd-radius-sm);background:var(--skd-surface);white-space:pre;overflow:auto;overscroll-behavior:contain}
.skd-prose pre code{padding:0;background:none}
.skd-fileCode{margin:0;max-width:100%;overflow:auto;white-space:pre;font:.75rem/1.75 var(--skd-mono);tab-size:2;overscroll-behavior:contain}
.skd-previewMessage{display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:28px;color:var(--skd-muted);font-size:.8125rem;text-align:center;line-height:1.65;overflow:auto}
.skd-previewNotice{margin:0 0 14px;padding:9px 12px;border:1px solid var(--skd-line);border-radius:var(--skd-radius-sm);background:var(--skd-surface);font-size:.75rem;line-height:1.55;color:var(--skd-muted)}
.skd-previewFiles .skd-previewNotice{margin:8px;font-size:.6875rem;flex:none}
.skd-previewFooter{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;flex:none;padding:8px 20px;border-top:1px solid var(--skd-line);font-size:.6875rem;color:var(--skd-subtle);line-height:1.45}
.skd-previewFooter>span:first-child{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.skd-page :focus-visible,.skd-previewDialog :focus-visible{outline:2px solid var(--skd-accent);outline-offset:2px}
.skd-page .skd-updatePanel:focus-visible{outline:none}
.skd-page .skd-input:focus-visible,.skd-page .skd-select:focus-visible{outline-offset:1px}
.skd-page .skd-menuItem:focus-visible,.skd-periodSkill:focus-visible,.skd-periodSort:focus-visible{outline-offset:-2px;border-radius:4px}

@media (hover:hover){
  .skd-tab:hover,.skd-segment:not(:disabled):hover{color:var(--skd-fg)}
  .skd-button:not(:disabled):hover,.skd-iconButton:not(:disabled):hover,.skd-menuItem:not(:disabled):hover,.skd-periodSort:hover,.skd-fileButton:hover,.skd-folderLabel:hover{background:var(--skd-hover);color:var(--skd-fg)}
  .skd-button[data-variant=primary]:not(:disabled):hover{background:var(--skd-accent-hover);color:var(--skd-on-accent)}
  .skd-button[data-variant=danger]:not(:disabled):hover{background:var(--skd-error-bg);color:var(--skd-error)}
  .skd-button[data-variant=text]:not(:disabled):hover{background:none;text-decoration:underline;text-underline-offset:3px}
  .skd-row:hover,.skd-diagnosisRow:hover{background:var(--skd-hover)}
  .skd-row:hover .skd-rowName,.skd-nameButton:hover,.skd-periodSkill:hover{color:var(--skd-accent);text-decoration:underline;text-underline-offset:3px}
  .skd-rankItem:hover{background:var(--skd-hover)}
  .skd-input:hover,.skd-select:hover{border-color:var(--skd-subtle)}
  .skd-chartCol:hover .skd-bar{background:var(--skd-accent)}
  .skd-chartCol:hover::after{opacity:1}
  .skd-windowTools .skd-iconButton:hover{background:var(--skd-bg)}
}

@container dashboard (max-width:820px){
  .skd-filterBar,.skd-skelFilterBar{grid-template-columns:repeat(3,minmax(0,1fr))}
  .skd-searchField{grid-column:1 / -1}
  .skd-filterBar>.skd-field>.skd-select{max-inline-size:none}
  .skd-diagnosisQueue{grid-template-columns:minmax(0,1fr) auto}
  .skd-diagnosisResults{grid-column:1 / -1}
  .skd-diagnosisRow{grid-template-columns:auto minmax(0,1fr)}
  .skd-diagnosisActions{grid-column:2;justify-content:flex-start;flex-wrap:wrap}
}
@container dashboard (max-width:600px){
  .skd-wrap{padding-inline:16px}
  .skd-header{padding:16px 0 10px;gap:10px}
  .skd-subtitle,.skd-statusPill{display:none}
  .skd-tabbar{gap:14px}
  .skd-tab{min-height:42px;padding-bottom:8px}
  .skd-content{padding-top:14px}
  .skd-overview{grid-template-columns:repeat(2,minmax(0,1fr))}
  .skd-overviewItem:nth-child(2){border-inline-end:0}
  .skd-overviewItem:nth-child(-n+2){border-bottom:1px solid var(--skd-line)}
  .skd-filterBar,.skd-skelFilterBar{grid-template-columns:minmax(0,1fr)}
  .skd-tableHeading{display:none}
  .skd-row,.skd-skelRow{grid-template-columns:minmax(0,1fr);padding:14px 12px;gap:10px}
  .skd-rowRail{display:flex;grid-column:auto;align-items:center;justify-content:space-between;gap:12px}
  .skd-metric{align-items:flex-start;text-align:start}
  .skd-metric .skd-micro{display:block}
  .skd-switchGroup{flex:1;max-width:220px;gap:6px}
  .skd-switchControl{min-block-size:40px}
  .skd-rankHead{display:none}
  .skd-rankItem{grid-template-columns:auto minmax(0,1fr) auto;gap:6px 12px;padding:12px}
  .skd-rankNo{justify-self:start}
  .skd-rankInstalls{grid-column:2;justify-self:start}
  .skd-rankAction{grid-column:3;grid-row:1 / span 3;align-self:center}
  .skd-searchRow{display:grid;grid-template-columns:minmax(0,1fr) auto}
  .skd-searchRow>.skd-sourceField{grid-column:1 / -1}
  .skd-stats{grid-template-columns:minmax(0,1fr)}
  .skd-periodControls>.skd-periodField{flex:1 1 8rem}
  .skd-periodControls>.skd-periodField:first-child,.skd-periodRange{flex-basis:100%;text-align:start;margin:0}
  .skd-diagnosisQueue{grid-template-columns:minmax(0,1fr)}
  .skd-diagnosisActions{grid-column:1 / -1}
  .skd-diagnosisActions .skd-button,.skd-diagnosisRailActions .skd-button{flex:1;min-block-size:40px}
  .skd-diagnosisRailActions{width:100%}
  .skd-diagnosisRowNote{padding-inline-start:0}
}
@media (pointer:coarse){
  .skd-switchControl{min-block-size:44px}
  .skd-updatePickerItem{min-block-size:40px}
}
@media (max-width:700px){
  .skd-updatePanel{position:fixed;left:12px;right:12px;bottom:12px;top:auto;width:auto;max-block-size:70dvh;overflow:auto}
  .skd-previewOverlay{padding:0}
  .skd-previewDialog{inline-size:calc(100vw - 16px);block-size:calc(100dvh - 16px);max-inline-size:calc(100vw - 16px);max-block-size:calc(100dvh - 16px);min-inline-size:0;resize:none;border-radius:var(--skd-radius)}
  .skd-windowTools .skd-sizeStep{display:none}
  .skd-previewHeader{padding:12px 14px;gap:10px}
  .skd-previewLayout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .skd-previewLayout[data-files-expanded]{grid-template-rows:auto auto minmax(0,1fr)}
  .skd-previewLayout:not([data-files-expanded]) .skd-previewFiles{display:none}
  .skd-previewFiles{border-inline-end:0;border-bottom:1px solid var(--skd-line);max-block-size:min(38dvh,18rem);overflow:auto}
  .skd-previewFilesHead{display:none}
  .skd-previewFilesToggle{display:flex;align-items:center;justify-content:flex-start;border-width:0 0 1px;border-color:var(--skd-line);border-radius:0;padding-inline:14px;min-block-size:42px}
  .skd-previewFilesToggle .skd-fileCount{margin-inline-start:auto}
  .skd-previewContent{padding:18px 16px 24px}
  .skd-fileButton,.skd-folderLabel{min-height:42px}
}
@media (prefers-reduced-motion:reduce){
  .skd-skelBlock,.skd-previewProgress::after,.skd-iconButton[data-spinning] svg,.skd-statusDot[data-busy]{animation:none}
  .skd-page *,.skd-previewDialog *{transition:none!important}
}
@media (forced-colors:active){
  .skd-previewDialog,.skd-diagnosisRail,.skd-menu,.skd-updatePanel{border-color:CanvasText;box-shadow:none}
  .skd-button[data-variant=primary]{background:ButtonFace;color:ButtonText;border-color:ButtonText}
  .skd-tab[aria-selected=true]{border-bottom:2px solid Highlight}
  .skd-segment[data-active]{border-color:Highlight;background:Highlight;color:HighlightText}
  .skd-segment[data-active] .skd-segmentDot{background:HighlightText;border-color:HighlightText}
  .skd-fileButton[aria-pressed=true]{outline:1px solid Highlight}
}
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

    /**
     * The short readable form of one recorded origin.
     *
     * A repository reference is already short and is shown verbatim. A well-known
     * source is the whole archive URL, long enough to wrap the row into a
     * paragraph, so it reads as the host plus the archived skill name instead.
     */
    function originLabel(ref) {
      const text = textOf(ref);
      if (!/^https:\/\//i.test(text)) return text;
      try {
        const url = new URL(text);
        const last = url.pathname.split('/').filter((segment) => segment !== '').pop() ?? '';
        const name = last.replace(/\.tar\.gz$/i, '');
        return name === '' ? url.host : url.host + '/' + name;
      } catch {
        return text;
      }
    }

    /** The page's localStorage, or null where the browser refuses it (private mode throws on access). */
    function storageOf() {
      try {
        return typeof window === 'undefined' ? null : window.localStorage ?? null;
      } catch {
        return null;
      }
    }

    /** The stored skill names, in the order the user picked them, without blanks or repeats. */
    function autoUpdateNames(value) {
      const names = [];
      for (const entry of Array.isArray(value) ? value : []) {
        const name = textOf(entry).trim();
        if (name !== '' && names.includes(name) === false) names.push(name);
      }
      return names;
    }

    /** Auto-update settings cross the storage boundary, so they are parsed and narrowed here. */
    function readAutoUpdateSettings(storage) {
      let raw = null;
      try {
        raw = objectOf(storage) === null ? null : storage.getItem(AUTO_UPDATE_KEY);
      } catch {
        raw = null;
      }
      let parsed = null;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const block = objectOf(parsed);
      return {
        enabled: block !== null && block.enabled === true,
        names: block === null ? [] : autoUpdateNames(block.names),
      };
    }

    /** Persist the narrowed settings and return them, so the caller renders what was saved. */
    function writeAutoUpdateSettings(storage, settings) {
      const block = objectOf(settings);
      const next = {
        enabled: block !== null && block.enabled === true,
        names: block === null ? [] : autoUpdateNames(block.names),
      };
      try {
        if (objectOf(storage) !== null) storage.setItem(AUTO_UPDATE_KEY, JSON.stringify(next));
      } catch {
        // A blocked store still leaves the session's choice in memory.
      }
      return next;
    }

    /** Skill names from an array or a Set, dropping blanks; the given order is kept. */
    function nameListOf(value) {
      const listed = Array.isArray(value) ? value
        : objectOf(value) !== null && typeof value.forEach === 'function' ? Array.from(value) : [];
      return listed.map((entry) => textOf(entry)).filter((name) => name !== '');
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

    /** Local date only, for evidence where the time of day carries nothing. */
    function formatDate(millis) {
      if (Number.isFinite(millis) === false || millis <= 0) return '';
      const formatter = formatterOf('date', { month: 'short', day: 'numeric' });
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
    async function requestJson(route, init, timeoutMs = REQUEST_TIMEOUT_MS) {
      // A hung route must not wedge the panel; abort after `timeoutMs`.
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
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
        syncError: false,
        fetchedAt: 0,
        refreshing: false,
        pending: null,
        note: null,
        rowNotes: {},
        updatesChecking: false,
        updatesProgress: { done: 0, total: 0 },
        updatesError: null,
        updatesCheckSeq: 0,
        updatingAll: null,
        discover: { source: null, query: '', status: 'idle', items: [], error: null, note: null, at: 0 },
      });
      const patch = (fields) => store.set((current) => ({ ...current, ...fields }));
      const patchDiscover = (fields) => store.set((current) => ({
        ...current,
        discover: { ...current.discover, ...fields },
      }));

      let revision = 0;
      let inFlightRefresh = null;
      let inFlightRevision = -1;
      let inFlightCheck = null;
      let discoverToken = 0;

      const loadState = async (silent) => {
        const started = revision;
        const before = store.getSnapshot();
        if (silent !== true) patch({ status: before.data === null ? 'loading' : 'ready', refreshing: true });
        const result = await requestJson(ROUTE_STATE, { headers: { accept: 'application/json' } });
        if (started !== revision) {
          if (inFlightRefresh === null || inFlightRevision === started) patch({ refreshing: false });
          return false;
        }
        const current = store.getSnapshot();
        if (result.ok !== true) {
          if (current.data !== null) {
            patch({ status: 'ready', syncError: true, refreshing: false });
          } else {
            patch({ status: 'offline', syncError: true, refreshing: false });
          }
          return false;
        }
        patch({ data: result.value, status: 'ready', syncError: false, refreshing: false, fetchedAt: Date.now() });
        return true;
      };

      const refresh = ({ staleAfterMs = 0, silent = false } = {}) => {
        const snapshot = store.getSnapshot();
        if (staleAfterMs > 0 && snapshot.fetchedAt !== 0 && Date.now() - snapshot.fetchedAt < staleAfterMs) {
          return Promise.resolve(false);
        }
        if (inFlightRefresh !== null && inFlightRevision === revision) return inFlightRefresh;
        const currentRev = revision;
        inFlightRevision = currentRev;
        const run = loadState(silent).catch(() => false).finally(() => {
          if (inFlightRefresh === run) inFlightRefresh = null;
        });
        inFlightRefresh = run;
        return run;
      };

      const dismissNote = () => {
        if (store.getSnapshot().note !== null) patch({ note: null });
      };

      const dispose = () => {
        inFlightRefresh = null;
      };

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
          const hasData = store.getSnapshot().data !== null;
          patch({
            status: result.offline === true && !hasData ? 'offline' : store.getSnapshot().status,
            syncError: result.offline === true ? true : store.getSnapshot().syncError,
            note: {
              tone: 'error',
              failKey: step.failKey,
              code: result.code ?? null,
              message: result.message ?? null,
              offline: result.offline === true,
            },
          });
          return false;
        }
        PREVIEW_MEMORY.clear();
        const value = objectOf(result.value);
        if (value !== null && objectOf(value.state) !== null) {
          patch({
            data: value.state,
            status: 'ready',
            syncError: false,
            fetchedAt: Date.now(),
            note: step.success(result.value),
          });
          return true;
        }
        patch({ note: step.success(result.value) });
        await refresh();
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

      /** `ref` links a row with no stored origin and updates it in the same Host call. */
      const updateSkill = (skill, ref) => {
        const name = textOf(skill?.name);
        const path = textOf(skill?.path);
        const bound = textOf(ref);
        if (name === '') return Promise.resolve(false);
        // The Host resolves source and ref from its provenance store when they are absent.
        return runAction(
          { action: 'update', name, ...(path === '' ? {} : { path }), ...(bound === '' ? {} : { ref: bound }) },
          {
            kind: 'update',
            target: name,
            failKey: bound === '' ? 'skill.menu.update' : 'skill.menu.bind',
            success: (value) => {
              const changed = objectOf(value)?.changed === true;
              const key = changed ? 'status.updatedSkill' : bound !== '' ? 'status.boundSource' : 'status.upToDate';
              return { tone: 'ok', key, params: { name } };
            },
          },
        );
      };

      /** The catalog row for one name, so a bulk update reuses the exact path the Host listed. */
      const skillByName = (data, name) => {
        const listed = objectOf(data) !== null && Array.isArray(data.skills) ? data.skills : [];
        return listed.map((entry) => objectOf(entry)).find((entry) => entry !== null && textOf(entry.name) === name) ?? null;
      };

      /**
       * Walk the Host's tracked skills in bounded chunks. One check at a time: a
       * second gesture while running joins the first instead of racing it.
       */
      const checkUpdates = ({ refresh: force = false } = {}) => {
        if (inFlightCheck !== null) return inFlightCheck;
        patch({ updatesChecking: true, updatesProgress: { done: 0, total: 0 }, updatesError: null });
        const run = (async () => {
          let total = 0;
          let failure = null;
          // A chunk the Host cannot answer must not end the walk silently: every
          // verdict it already wrote is on disk, and a fresh record costs no
          // upstream read, so one restart resumes at the first unchecked skill.
          for (let pass = 0; pass < 2; pass += 1) {
            let cursor = 0;
            let stalls = 0;
            failure = null;
            for (;;) {
              const result = await requestJson(ROUTE_ACTION, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  action: 'check-updates',
                  cursor,
                  limit: UPDATE_CHECK_CHUNK,
                  ...(force ? { refresh: true } : {}),
                }),
              }, UPDATE_CHECK_REQUEST_TIMEOUT_MS);
              if (result.ok !== true) {
                failure = textOf(result.code) !== '' ? result.code : 'unavailable';
                break;
              }
              const value = objectOf(result.value) ?? {};
              const reported = countOf(value.total);
              const next = countOf(value.nextCursor);
              // A tracked count that collapses between chunks is a transient Host
              // read, not the end of the walk: retry that cursor before giving up.
              if ((reported === 0 && cursor > 0) || (total > cursor && next <= cursor)) {
                stalls += 1;
                if (stalls > 2) {
                  failure = 'unavailable';
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
                continue;
              }
              stalls = 0;
              total = reported;
              const done = value.done === true || next >= total || next <= cursor;
              cursor = next;
              patch({ updatesProgress: { done: Math.min(cursor, total), total } });
              if (done) break;
            }
            if (failure === null) break;
            // The one retry gets a fresh envelope and starts over; the chunks the
            // first pass answered are reused from disk, so only the rest is read.
            if (pass === 0) await new Promise((resolve) => setTimeout(resolve, 600));
          }
          const complete = failure === null;
          patch({ updatesChecking: false, ...(complete ? {} : { updatesError: failure }) });
          // The Host persisted every chunk it answered, so the panel re-reads the
          // state even after a failure: partial progress and the note both show.
          await refresh();
          // Only a completed check arms the auto-update path, and only against the state it produced.
          if (complete) patch({ updatesCheckSeq: countOf(store.getSnapshot().updatesCheckSeq) + 1 });
          return complete;
        })().finally(() => {
          if (inFlightCheck === run) inFlightCheck = null;
        });
        inFlightCheck = run;
        return run;
      };

      /** Apply the given updates by name, sequentially; `auto` only changes the receipt. */
      const applyUpdates = async (names, { auto = false } = {}) => {
        const targets = (Array.isArray(names) ? names : [])
          .map((name) => textOf(name))
          .filter((name) => name !== '')
          .slice(0, UPDATE_APPLY_LIMIT);
        if (targets.length === 0 || store.getSnapshot().updatingAll !== null) return false;
        patch({ updatingAll: { done: 0, total: targets.length }, note: null });
        let succeeded = 0;
        let failed = 0;
        for (let index = 0; index < targets.length; index += 1) {
          const skill = skillByName(store.getSnapshot().data, targets[index]);
          if (skill !== null && (await updateSkill(skill))) succeeded += 1;
          else failed += 1;
          patch({ updatingAll: { done: index + 1, total: targets.length } });
        }
        patch({ updatingAll: { done: targets.length, total: targets.length } });
        // The count reaches the total on screen before the receipt replaces it: the trailing
        // state read yields the frame the last row's patch would otherwise be batched away with.
        await refresh();
        patch({
          updatingAll: null,
          note: {
            tone: failed === 0 ? 'ok' : 'idle',
            key: auto === true ? 'updates.appliedAuto' : 'updates.applied',
            params: { ok: succeeded, failed },
          },
        });
        return failed === 0;
      };

      /** A discover card carries its name and source; the GitHub form sends a bare reference. */
      const installSkill = (item, source) => {
        const name = textOf(item?.name);
        const ref = textOf(item?.ref);
        const sourceId = textOf(source);
        if (ref === '' || (sourceId !== '' && name === '')) return Promise.resolve(false);
        return runAction(
          {
            action: 'install',
            ...(sourceId === '' ? {} : { source: sourceId }),
            ref,
            ...(name === '' ? {} : { name }),
          },
          {
            kind: 'install',
            target: name !== '' ? name : ref,
            failKey: 'discover.install',
            success: (value) => {
              // The Host replies with the resolved skill name, which a bare GitHub ref cannot know.
              const installed = textOf(objectOf(value)?.name);
              if (installed !== '') {
                // The installed card must not offer a second install while the catalog reloads.
                store.set((current) => ({
                  ...current,
                  discover: {
                    ...current.discover,
                    items: current.discover.items.map((entry) => (
                      textOf(objectOf(entry)?.name) === installed ? { ...entry, installed: true } : entry
                    )),
                  },
                }));
              }
              const label = installed !== '' ? installed : name !== '' ? name : ref;
              return { tone: 'ok', key: 'status.installed', params: { name: label } };
            },
          },
        );
      };

      /** The `{ name, path }` pairs the cleanup verb accepts, taken from the catalog. */
      const cleanupTargetsOf = (targets) => (Array.isArray(targets) ? targets : [])
        .map((entry) => objectOf(entry))
        .filter((entry) => entry !== null)
        .map((entry) => ({ name: textOf(entry.name), path: textOf(entry.path) }))
        .filter((entry) => entry.name !== '');

      /** One name plus a flag, or the array of entries the bulk rail sends. */
      const keepEntriesOf = (name, keep) => {
        if (Array.isArray(name)) {
          return name.map((entry) => objectOf(entry)).filter((entry) => entry !== null)
            .map((entry) => ({ name: textOf(entry.name), keep: entry.keep === true }))
            .filter((entry) => entry.name !== '');
        }
        const single = textOf(name);
        return single === '' ? [] : [{ name: single, keep: keep === true }];
      };

      /**
       * One batch of writes and one state read. Each refusal stays on its own row; the
       * footer receipt names how many writes worked. The Host's verdicts are never
       * recomputed here — only the verb and the targets travel back.
       */
      const runBatch = async (calls, step) => {
        if (calls.length === 0 || store.getSnapshot().pending !== null) return false;
        revision += 1;
        patch({ pending: { kind: step.kind, target: step.target }, note: null });
        const outcomes = [];
        let requestFailure = null;
        let offline = false;
        for (const call of calls) {
          const result = await requestJson(ROUTE_ACTION, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(call.body),
          });
          if (result.offline === true) offline = true;
          const value = objectOf(result.value);
          if (result.ok !== true) {
            for (const name of call.names) {
              outcomes.push({ name, ok: false, code: result.code ?? null, message: result.message ?? null });
            }
            if (requestFailure === null) requestFailure = { code: result.code ?? null, message: result.message ?? null };
            continue;
          }
          const reported = value !== null && Array.isArray(value.results) ? value.results : null;
          if (reported === null) {
            for (const name of call.names) outcomes.push({ name, ok: true, code: null, message: null });
            continue;
          }
          for (const entry of reported) {
            const row = objectOf(entry);
            const name = textOf(row?.name);
            if (name === '') continue;
            outcomes.push({ name, ok: row.ok === true, code: textOf(row.code) || null, message: textOf(row.message) || null });
          }
        }
        const failed = outcomes.filter((outcome) => outcome.ok !== true);
        const succeeded = outcomes.length - failed.length;
        const notes = {};
        for (const outcome of failed) notes[outcome.name] = { code: outcome.code, message: outcome.message };
        patch({ pending: null, rowNotes: notes });
        if (requestFailure !== null && succeeded === 0) {
          const hasData = store.getSnapshot().data !== null;
          patch({
            status: offline === true && !hasData ? 'offline' : store.getSnapshot().status,
            syncError: offline === true ? true : store.getSnapshot().syncError,
            note: { tone: 'error', failKey: step.failKey, code: requestFailure.code, message: requestFailure.message, offline },
          });
          return false;
        }
        if (succeeded > 0) PREVIEW_MEMORY.clear();
        patch({ note: { tone: failed.length === 0 ? 'ok' : 'idle', key: step.note, params: { ok: succeeded, failed: failed.length } } });
        await refresh();
        return failed.length === 0;
      };

      /** Keep or unkeep one skill; an array of entries keeps the bulk rail to one refresh. */
      const keepSkill = (name, keep) => {
        const entries = keepEntriesOf(name, keep);
        return runBatch(entries.map((entry) => ({
          name: entry.name,
          body: { action: 'keep', name: entry.name, keep: entry.keep },
          names: [entry.name],
        })), {
          kind: 'keep',
          target: entries.map((entry) => entry.name).join(','),
          failKey: 'diagnosis.keep',
          note: 'diagnosis.keepNote',
        });
      };

      /** One cleanup post for a group of disable or remove targets. */
      const cleanupSkills = (mode, targets) => {
        const verb = mode === 'remove' ? 'remove' : 'disable';
        const list = cleanupTargetsOf(targets);
        const names = list.map((entry) => entry.name);
        return runBatch([{
          name: names.join(','),
          body: { action: 'cleanup', mode: verb, targets: list },
          names,
        }], {
          kind: 'cleanup',
          target: names.join(','),
          failKey: verb === 'remove' ? 'diagnosis.remove' : 'diagnosis.disable',
          note: verb === 'remove' ? 'diagnosis.removeNote' : 'diagnosis.disableNote',
        });
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
        checkUpdates,
        applyUpdates,
        installSkill,
        keepSkill,
        cleanupSkills,
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
        pulse: 'M3 12h4l2.5-6 4 12 2.5-6h5',
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
    function filterSkills(skills, { runtime = 'all', query = '', status = 'all', sort = 'usage', updatable = null } = {}) {
      const needle = query.trim().toLocaleLowerCase();
      return skills.filter((skill) =>
        (runtime === 'all' || stringsOf(skill.runtimes).includes(runtime))
        && (needle === '' || [skill.name, skill.description, skill.source].some((value) => textOf(value).toLocaleLowerCase().includes(needle)))
        && (status === 'all' || (status === 'enabled' && skill.modelInvocable === true)
          || (status === 'disabled' && skill.modelInvocable !== true) || (status === 'writable' && skill.writable === true)
          || (status === 'updatable' && updatable !== null && typeof updatable?.has === 'function' && updatable.has(textOf(skill.name))))
      ).sort((left, right) => {
        const alphabetical = textOf(left.name).localeCompare(textOf(right.name));
        if (sort === 'name') return alphabetical;
        const field = sort === 'recent' ? 'lastUsedAt' : 'count';
        return countOf(objectOf(right.usage)?.[field]) - countOf(objectOf(left.usage)?.[field]) || alphabetical;
      });
    }

    /**
     * Whether the panel should run its one automatic update check: at least one
     * tracked skill, and no check result yet or one older than the TTL.
     */
    function shouldAutoCheck(updates, skills, now = Date.now()) {
      const listed = Array.isArray(skills) ? skills : [];
      const tracked = listed.some((skill) => objectOf(skill?.installed) !== null && textOf(skill?.dir) !== '');
      if (!tracked) return false;
      const block = objectOf(updates);
      const checkedAt = countOf(block?.checkedAt);
      return checkedAt === 0 || now - checkedAt >= UPDATES_TTL_MS;
    }

    /** Available names the catalog says were called at least once; an unused library has no 常用 subset. */
    function commonUpdateNames(skills, available) {
      const used = new Set();
      for (const entry of Array.isArray(skills) ? skills : []) {
        const skill = objectOf(entry);
        if (skill !== null && countOf(objectOf(skill.usage)?.count) > 0) used.add(textOf(skill.name));
      }
      return nameListOf(available).filter((name) => used.has(name));
    }

    /** The checked names this check can still apply; a skill the user did not check is never touched. */
    function autoUpdateTargets(settings, available) {
      const block = objectOf(settings);
      if (block === null || block.enabled !== true) return [];
      const checked = new Set(autoUpdateNames(block.names));
      return nameListOf(available).filter((name) => checked.has(name));
    }

    /** The five buckets in the strip's order; their membership is decided by the Host. */
    const DIAGNOSIS_BUCKETS = ['cleanup', 'dormant', 'active', 'kept', 'unknown'];

    /**
     * Pure queue projection: bucket and name only. Verdicts, counts and every `can.*`
     * flag are copied from the wire; a day count is never compared against a threshold.
     */
    function diagnosisRows(diagnosis, { bucket = 'cleanup', query = '', sort = 'host' } = {}) {
      const block = objectOf(diagnosis);
      const listed = block !== null && Array.isArray(block.skills) ? block.skills : [];
      const needle = query.trim().toLocaleLowerCase();
      const rows = listed.map((entry) => {
        const skill = objectOf(entry);
        if (skill === null) return null;
        const name = textOf(skill.name);
        if (name === '') return null;
        const can = objectOf(skill.can) ?? {};
        return {
          name,
          verdict: textOf(skill.verdict),
          bucket: textOf(skill.bucket),
          idleDays: Number.isFinite(skill.idleDays) ? Math.max(0, Math.floor(skill.idleDays)) : null,
          watchedDays: countOf(skill.watchedDays),
          lastUsedAt: Number.isFinite(skill.lastUsedAt) ? skill.lastUsedAt : null,
          useCount: countOf(skill.useCount),
          keptAt: Number.isFinite(skill.keptAt) ? skill.keptAt : null,
          closed: skill.closed === true,
          writable: skill.writable === true,
          can: { disable: can.disable === true, remove: can.remove === true, keep: can.keep === true },
        };
      }).filter((row) => row !== null).filter((row) =>
        (bucket === '' || row.bucket === bucket) && (needle === '' || row.name.toLocaleLowerCase().includes(needle)));
      if (sort === 'name') return rows.sort((left, right) => left.name.localeCompare(right.name));
      if (sort === 'idle') return rows.sort((left, right) => (right.idleDays ?? -1) - (left.idleDays ?? -1) || left.name.localeCompare(right.name));
      if (sort === 'calls') return rows.sort((left, right) => right.useCount - left.useCount || left.name.localeCompare(right.name));
      // 'host' keeps the Host's §8.3 rank order; the Client may re-sort, not re-classify.
      return rows;
    }

    /**
     * Bulk targets from the wire's `can.*` flags alone. `keep` carries the requested state
     * per name: a kept row is an unkeep target, so the rail never re-keeps it.
     */
    function diagnosisTally(rows, selected) {
      const picked = new Set(stringsOf(selected));
      const names = [], disable = [], remove = [], keep = [], readonly = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (objectOf(row) === null) continue;
        const name = textOf(row.name);
        if (name === '' || picked.has(name) === false) continue;
        names.push(name);
        if (row.can?.disable === true) disable.push(name);
        if (row.can?.remove === true) remove.push(name);
        if (row.can?.keep === true) keep.push({ name, keep: row.verdict !== 'kept' });
        if (row.writable !== true) readonly.push(name);
      }
      return { names, disable, remove, keep, readonly };
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
        }, el('span', { className: 'skd-segmentDot', 'aria-hidden': true }), item.label)),
      );
    }

    /** Switch that only reports the requested state; the Host decides whether it sticks. */
    function Switch({ checked, disabled, label, hint, busy, onChange, children }) {
      const id = 'skd-switch-' + useId();
      const hintId = hint ? id + '-hint' : undefined;
      const nativeSwitch = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;
      return el('label', { className: 'skd-switchControl', htmlFor: id, title: hint || undefined },
        el(Input, {
          id, name: id, type: 'checkbox', switch: '', className: 'skd-switchInput',
          role: nativeSwitch ? undefined : 'switch', checked: checked === true,
          'aria-label': label, 'aria-describedby': hintId, 'aria-busy': busy === true || undefined,
          disabled: disabled === true,
          onChange: (event) => { if (!disabled) onChange(event.target.checked); },
        }),
        el('span', { className: 'skd-switchLabel' }, children),
        el('span', { className: 'skd-switch', 'aria-hidden': true },
          el('span', { className: 'skd-switchThumb' })),
        hintId && el('span', { id: hintId, className: 'skd-visuallyHidden' }, hint),
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
          el('span', { className: 'skd-tabIcon', 'aria-hidden': true }, el(Glyph, { name: tab.id === 'installed' ? 'library' : tab.id === 'discover' ? 'compass' : tab.id === 'usage' ? 'chart' : 'pulse', size: 15 })),
          tab.label,
          typeof tab.count === 'number' && tab.count > 0 && el('span', {
            className: 'skd-tabCount',
            'data-tone': tab.countTone,
            'aria-hidden': true,
          }, formatNumber(tab.count)),
        )),
      );
    }

    // Feature detection answers for one browser, so it runs once instead of per row per render.
    const nativePopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
    const nativeInvoker = typeof HTMLButtonElement !== 'undefined' && 'commandForElement' in HTMLButtonElement.prototype;
    const nativeFocusGroup = typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;
    const nativeAnchor = typeof window.CSS?.supports === 'function' && window.CSS.supports('position-area: block-end');

    /** Native top-layer menu with feature-detected focus, invoker and positioning fallbacks. */
    function RowMenu({ skill, t, name, disabled, canUpdate, pathShown, onUpdate, onBind, onAskRemove, onTogglePath, returnFocusRef }) {
      const [open, setOpen] = useState(false);
      const internalTrigger = useRef(null);
      const triggerRef = returnFocusRef ?? internalTrigger;
      const menuRef = useRef(null);
      const groupRef = useRef(null);
      const enterOnOpen = useRef(false);
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
          canUpdate && el(Button, {
            ...itemProps,
            disabled,
            onClick: choose(objectOf(skill?.installed) === null ? onBind : onUpdate),
          }, t(objectOf(skill?.installed) === null ? 'skill.menu.bind' : 'skill.menu.update')),
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

    /** Tab order inside the preview panel: the same set the browser itself would visit. */
    const FOCUSABLE = 'button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';

    /** The focus trap's next stop; a Tab from the last stop (or from outside) wraps around. */
    function trapFocus(items, active, shift) {
      if (items.length === 0) return null;
      const index = items.indexOf(active);
      if (index === -1) return shift ? items[items.length - 1] : items[0];
      if (shift) return items[index === 0 ? items.length - 1 : index - 1];
      return items[index === items.length - 1 ? 0 : index + 1];
    }

    /**
     * The preview is an in-page portal overlay, not a native <dialog>. The Electron renderer
     * fails to paint a top-layer dialog and a blurred backdrop, leaving the page modal and
     * half-painted; a fixed overlay paints inside the page's own layer.
     */
    function SkillPreview({ target, t, runtimes, onClose }) {
      const panelRef = useRef(null);
      const closeButtonRef = useRef(null);
      const returnFocus = useRef(null);
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
      // The remembered window size is applied before paint, and the observer records every later one.
      useLayoutEffect(() => {
        const panel = panelRef.current;
        if (panel === null) return undefined;
        if (previewWindowSize && window.innerWidth > 700) {
          panel.style.width = Math.min(previewWindowSize.width, window.innerWidth - 24) + 'px';
          panel.style.height = Math.min(previewWindowSize.height, window.innerHeight - 24) + 'px';
        }
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(() => {
          if (!panel.hasAttribute('data-maximized') && window.innerWidth > 700) {
            const rect = panel.getBoundingClientRect();
            previewWindowSize = { width: rect.width, height: rect.height };
          }
        });
        observer.observe(panel);
        return () => observer.disconnect();
      }, []);
      // The old native dialog returned focus to its trigger on close, so the overlay does too.
      useEffect(() => {
        returnFocus.current = document.activeElement;
        closeButtonRef.current?.focus({ preventScroll: true });
        return () => { returnFocus.current?.focus?.({ preventScroll: true }); };
      }, []);
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeRef.current();
            return;
          }
          if (event.key !== 'Tab' || panelRef.current === null) return;
          const items = [...panelRef.current.querySelectorAll(FOCUSABLE)]
            .filter((node) => node.disabled !== true && node.getClientRects().length > 0);
          const next = trapFocus(items, document.activeElement, event.shiftKey);
          if (next === null) return;
          event.preventDefault();
          next.focus();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
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
        const panel = panelRef.current;
        if (panel === null) return;
        const rect = panel.getBoundingClientRect();
        panel.removeAttribute('data-maximized'); setMaximized(false);
        panel.style.width = Math.min(window.innerWidth - 24, Math.max(Math.min(680, window.innerWidth - 24), rect.width + step * 120)) + 'px';
        panel.style.height = Math.min(window.innerHeight - 24, Math.max(Math.min(400, window.innerHeight - 24), rect.height + step * 80)) + 'px';
      };
      const toggleMaximized = () => {
        const panel = panelRef.current;
        if (panel === null) return;
        if (maximized) {
          panel.removeAttribute('data-maximized');
          if (normalSize.current) { panel.style.width = normalSize.current.width + 'px'; panel.style.height = normalSize.current.height + 'px'; }
        } else {
          const rect = panel.getBoundingClientRect(); normalSize.current = { width: rect.width, height: rect.height };
          panel.style.width = ''; panel.style.height = ''; panel.setAttribute('data-maximized', '');
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
      const panelContent = el('div', { className: 'skd-previewRoot' },
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
            el('div', { className: 'skd-windowToolsClose' }, el(Button, {
              className: 'skd-iconButton', ref: closeButtonRef,
              'aria-label': t('preview.close'), title: t('preview.close'), onClick: onClose,
            }, el(Glyph, { name: 'close', size: 20 })))),
        ),
        el('div', { className: 'skd-previewLayout', 'data-files-expanded': filesExpanded ? '' : undefined },
          el(Button, {
            className: 'skd-button skd-previewFilesToggle', ref: filesToggleRef,
            'aria-expanded': filesExpanded, 'aria-controls': titleId + '-files',
            onClick: () => setFilesExpanded((value) => !value),
          }, el(Glyph, { name: 'folder', size: 16 }), t('preview.files'), el('span', { className: 'skd-fileCount' }, t('preview.fileCount', { count: formatNumber(files.length) }))),
          el('aside', { className: 'skd-previewFiles', id: titleId + '-files', 'aria-label': t('preview.files') },
            el('div', { className: 'skd-previewFilesHead' }, el('h3', null, t('preview.files')),
              snapshot.status === 'loading' && files.length === 0
                ? el('span', { className: 'skd-skelBlock', style: { width: '54px', height: '18px', borderRadius: '999px' }, 'aria-hidden': true })
                : el('span', {
                  className: 'skd-fileCount',
                  title: data?.truncatedFiles === true ? t('preview.filesLimited') : undefined,
                }, t('preview.fileCount', { count: formatNumber(files.length) }))),
            files.length > 0 && el(PreviewFiles, { files, selected: file || selected?.path, onSelect: selectFile, t }),
            snapshot.status === 'loading' && files.length === 0 && el('div', { className: 'skd-previewSkelTree', 'aria-hidden': true },
              [78, 62, 86, 54, 70].map((width, index) => el('span', {
                key: index, className: 'skd-skelBlock', style: { height: '14px', width: width + '%' },
              }))),
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
            snapshot.status === 'loading' && el('div', { className: 'skd-previewProgress', role: 'progressbar', 'aria-label': t('preview.loading') }),
            snapshot.status === 'loading' ? el('div', { className: 'skd-previewSkelDoc', role: 'status', 'aria-label': t('preview.loading') },
              el('span', { className: 'skd-skelBlock', style: { height: '24px', width: '42%', marginBottom: '6px' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '14px', width: '92%' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '14px', width: '84%' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '14px', width: '68%', marginBottom: '8px' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '76px', width: '100%' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '14px', width: '78%' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '14px', width: '58%' } }))
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
      );
      return createPortal(el('div', { className: 'skd-previewOverlay' },
        el('div', { className: 'skd-previewBackdrop', 'aria-hidden': true, onClick: onClose }),
        el('div', {
          className: 'skd-page skd-previewDialog', role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': titleId, ref: panelRef, tabIndex: -1,
        }, panelContent),
      ), document.body);
    }

    /** One installed skill: identity, description, calls, both switches, and its menu. */
    function SkillRowBase(props) {
      const {
        skill, t, frequent, busy, writesLocked, pathShown, confirming, runtimes, updatable,
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
      const installed = objectOf(skill?.installed);
      const origin = installed === null ? '' : textOf(installed.ref);
      const originShort = originLabel(origin);
      const originVersion = installed === null ? '' : textOf(installed.version);
      // A writable row always offers the action; a row without a stored origin links one first.
      const canUpdate = writable === true;
      const menuTriggerRef = useRef(null);
      const cancelRef = useRef(null);
      const bindInputRef = useRef(null);
      const confirmId = 'skd-confirm-' + useId();
      const bindId = 'skd-bind-' + useId();
      const [binding, setBinding] = useState(false);
      const [bindDraft, setBindDraft] = useState('');
      useEffect(() => { if (confirming) cancelRef.current?.focus({ preventScroll: true }); }, [confirming]);
      useEffect(() => { if (binding) bindInputRef.current?.focus({ preventScroll: true }); }, [binding]);
      const cancel = () => { onCancelRemove(); menuTriggerRef.current?.focus({ preventScroll: true }); };
      const openBind = () => { setBindDraft(''); setBinding(true); };
      const cancelBind = () => { setBinding(false); menuTriggerRef.current?.focus({ preventScroll: true }); };
      const submitBind = () => {
        const draft = bindDraft.trim();
        if (draft === '' || writesLocked) return;
        setBinding(false);
        menuTriggerRef.current?.focus({ preventScroll: true });
        onUpdate(skill, draft);
      };

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
              updatable === true && el(Badge, { className: 'skd-badge' }, t('skill.updatable')),
              badge.kind === 'one' && el(Badge, { className: 'skd-badge' }, t('skill.runtimesOne', { agent: badge.agent })),
              badge.kind === 'some' && el(Badge, { className: 'skd-badge', title: badge.title },
                t('skill.runtimesSome', { count: badge.count, total: badge.total })),
              frequent && el(Badge, { className: 'skd-badge', 'data-tone': 'accent' }, t('skill.frequent')),
              closed && el(Badge, { className: 'skd-badge', 'data-tone': 'muted' }, t('skill.closed')),
              writable === false && el(Badge, { className: 'skd-badge', 'data-tone': 'muted' }, t('skill.readonly')),
            ),
          ),
          description !== '' && el('p', { className: 'skd-rowDesc', title: description }, description),
          origin !== '' && el('p', { className: 'skd-noteLine', title: originShort === origin ? undefined : origin },
            t(originVersion !== '' ? 'skill.originVersion' : 'skill.origin', { ref: originShort, version: originVersion })),
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
          el('div', { className: 'skd-switchGroup', role: 'group', 'aria-label': t('installed.permissions') },
            el('div', { className: 'skd-switchRow' },
              el(Switch, {
                checked: modelInvocable,
                disabled: writable === false || writesLocked,
                busy,
                label: t('skill.modelSwitchAria', { name }),
                hint: t('skill.modelHint'),
                onChange: (next) => onToggle(skill, { modelInvocable: next }),
              }, t('skill.model')),
            ),
            el('div', { className: 'skd-switchRow' },
              el(Switch, {
                checked: userInvocable,
                disabled: writable === false || writesLocked,
                busy,
                label: t('skill.userSwitchAria', { name }),
                hint: t('skill.userHint'),
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
            onBind: openBind,
            onAskRemove: () => onAskRemove(skill),
            onTogglePath: () => onTogglePath(path),
          }),
        ),
        pathShown && el('div', { className: 'skd-path' },
          el('span', { className: 'skd-micro' }, t('skill.path')),
          el('code', { className: 'skd-pathValue' }, path),
        ),
        binding && el('div', {
          className: 'skd-confirm', role: 'group', 'aria-label': t('skill.menu.bind'),
          onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancelBind(); } },
        },
          el('div', { className: 'skd-searchField' },
            el('span', { id: bindId, className: 'skd-noteLine' }, t('skill.bind.hint')),
            el(Input, {
              ref: bindInputRef, className: 'skd-input', type: 'text', name: 'ref',
              value: bindDraft, placeholder: t('skill.bind.placeholder'),
              'aria-label': t('skill.bind.inputAria'), 'aria-describedby': bindId,
              autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false,
              onChange: (event) => setBindDraft(event.target.value),
              onKeyDown: (event) => {
                // Enter during an IME composition confirms the candidate rather than submitting.
                if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return;
                event.preventDefault();
                submitBind();
              },
            })),
          el(Button, {
            type: 'button',
            className: 'skd-button',
            'data-variant': 'primary',
            disabled: writesLocked || bindDraft.trim() === '',
            onClick: submitBind,
          }, t('skill.bind.submit')),
          el(Button, {
            type: 'button',
            className: 'skd-button',
            onClick: cancelBind,
          }, t('action.cancel')),
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

    /**
     * A row's props are stable, so a keystroke or a batch tick reuses the previous render.
     * `localeMarker` is read by memo's comparison only: the translator's identity survives a
     * language switch, and the marker is the prop that changes then.
     */
    const SkillRow = memo(SkillRowBase);

    /** The installed list: a row per skill, muted once the model can no longer call it. */
    function InstalledTab(props) {
      const {
        skills, t, frequentRule, pending, filtered, runtimes, memoKey, onReset, onDiscover,
        expandedPath, confirmingPath, updatableNames,
        onToggle, onUpdate, onAskRemove, onConfirmRemove, onCancelRemove, onTogglePath, onPreview,
      } = props;
      const [limit, setLimit] = useState(ROW_BATCH);
      // The first batch paints in the mount task; every later batch gets its own frame, so no task
      // blocks on the whole list.
      useEffect(() => {
        if (limit >= skills.length) return undefined;
        const frame = requestAnimationFrame(() => setLimit((current) => nextRowLimit(current, skills.length)));
        return () => cancelAnimationFrame(frame);
      }, [limit, skills.length]);

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
      return el('ul', {
        className: 'skd-list', role: 'list', 'aria-busy': limit < skills.length || undefined,
      }, skills.slice(0, limit).map((skill) => {
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
          memoKey,
          frequent: frequentRule.active === true
            && calls >= MIN_FREQUENT_CALLS
            && calls >= frequentRule.threshold,
          busy,
          writesLocked: pending !== null,
          pathShown: path !== '' && expandedPath === path,
          confirming: path !== '' && confirmingPath === path,
          updatable: updatableNames.has(name),
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
     * (`name`, the kebab slug) always appears as the mono sub-label, so a row can never
     * hide what would actually be installed. `memoKey` is read by memo's comparison only:
     * the translator's identity survives a language switch, and the key changes then.
     */
    function DiscoverRowBase({ item, t, rank, installing, writesLocked, onInstall, onPreview }) {
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
      return el('li', { className: 'skd-rankItem', 'data-top': rank <= 3 ? '' : undefined },
        el('span', { className: 'skd-rankNo', 'aria-hidden': true }, String(rank).padStart(2, '0')),
        el('div', { className: 'skd-rankMain' },
          el('div', { className: 'skd-rankTitle' },
            el('h3', { className: 'skd-rankName' }, el(Button, {
              className: 'skd-nameButton', title: t('preview.open', { name: heading }),
              'aria-label': t('preview.open', { name: heading }), onClick: () => onPreview(item),
            }, heading)),
            version !== '' && el('span', { className: 'skd-rankVersion' }, t('discover.version', { version })),
          ),
          description !== '' && el('p', { className: 'skd-rankDesc', title: description }, description),
          blocked && el('p', { className: 'skd-noteLine' }, reason),
          (ref !== '' || slug !== '' || updatedAt !== '') && el('div', { className: 'skd-rankMeta' },
            ref !== '' && el('span', { className: 'skd-slug', title: ref }, ref),
            slug !== '' && slug !== ref && el('span', { className: 'skd-slug', title: slug }, slug),
            updatedAt !== '' && el('span', { className: 'skd-micro' }, t('discover.updated', { date: updatedAt })),
          ),
        ),
        el('div', { className: 'skd-rankInstalls', 'data-empty': installs > 0 ? undefined : '' },
          installs > 0
            ? [
              el('b', { key: 'count' }, formatNumber(installs)),
              el('span', { key: 'unit', className: 'skd-rankUnit' }, ' ' + t('discover.installsUnit')),
            ]
            : '—',
        ),
        el('div', { className: 'skd-rankAction' }, el(Button, {
          type: 'button', className: 'skd-button',
          'data-variant': 'outline',
          'data-done': installed ? '' : undefined,
          'aria-label': buttonLabel, 'aria-busy': installing || undefined,
          title: blocked ? buttonLabel : undefined,
          disabled: installed || blocked || writesLocked,
          onClick: () => onInstall(item),
        }, !installed && !installing && !blocked && el(Glyph, { name: 'plus', size: 14 }),
        installed ? t('discover.installed') : installing ? t('discover.installing') : t('discover.install'))),
      );
    }
    const DiscoverRow = memo(DiscoverRowBase);

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
      const githubId = 'skd-discover-github-' + useId();
      const [githubDraft, setGithubDraft] = useState('');
      const installOne = useCallback((entry) => onInstall(entry, discover.source), [onInstall, discover.source]);
      const previewOne = useCallback((entry) => onPreview({ ...entry, source: discover.source }), [onPreview, discover.source]);
      const popular = submittedQuery === '';
      const submitGithub = () => {
        const ref = githubDraft.trim();
        if (ref === '' || pending !== null) return;
        void Promise.resolve(onInstall({ ref }, '')).then((ok) => { if (ok === true) setGithubDraft(''); });
      };

      let body;
      if (discover.status === 'loading') {
        body = el('ol', { className: 'skd-rankList', role: 'status', 'aria-busy': true, 'aria-label': t('discover.loading') },
          [0, 1, 2, 3, 4, 5, 6, 7].map((index) => el('li', { key: index, className: 'skd-rankItem', 'aria-hidden': true },
            el('span', { className: 'skd-skelBlock', style: { height: '12px', width: '18px', justifySelf: 'end' } }),
            el('div', { className: 'skd-rankMain' },
              el('span', { className: 'skd-skelBlock', style: { height: '15px', width: index % 2 === 0 ? '41%' : '33%' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '13px', width: index % 2 === 0 ? '88%' : '72%' } }),
              el('span', { className: 'skd-skelBlock', style: { height: '12px', width: '26%' } }),
            ),
            el('span', { className: 'skd-skelBlock', style: { height: '14px', width: '68px', justifySelf: 'end' } }),
            el('span', { className: 'skd-skelBlock', style: { height: '30px', width: '76px', justifySelf: 'end' } }),
          )),
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
        body = el('ol', { className: 'skd-rankList', role: 'list' }, items.map((item, index) => {
          const key = textOf(item?.id) !== '' ? textOf(item.id) : textOf(item?.name);
          return el(DiscoverRow, {
            key,
            item,
            t,
            rank: index + 1,
            memoKey: t('tab.discover'),
            installing: installingName !== '' && textOf(item?.name) === installingName,
            writesLocked: pending !== null,
            onInstall: installOne,
            onPreview: previewOne,
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
        // A repository is not searchable, so GitHub installs use one reference field of their own.
        el('form', {
          className: 'skd-searchRow', action: ROUTE_ACTION, method: 'post', 'aria-label': t('discover.githubLabel'),
          onSubmit: (event) => { event.preventDefault(); submitGithub(); },
        },
          el('div', { className: 'skd-searchField' },
            el('label', { className: 'skd-fieldLabel', htmlFor: githubId }, t('discover.githubLabel')),
            el(Input, {
              id: githubId, name: 'ref', className: 'skd-input', type: 'text', value: githubDraft,
              placeholder: t('discover.githubPlaceholder'), autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false,
              onChange: (event) => setGithubDraft(event.target.value),
              onKeyDown: (event) => {
                // Let normal Enter use native form submission; suppress only IME confirmation.
                if (event.key === 'Enter' && (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229)) event.preventDefault();
              },
            })),
          el(Button, {
            type: 'submit', className: 'skd-button', 'data-variant': 'primary',
            disabled: githubDraft.trim() === '' || pending !== null,
          }, t('discover.githubSubmit')),
        ),
        discover.status === 'ready' && el('div', { className: 'skd-resultLine skd-discoverResults', role: 'status' },
          el('span', null, popular ? t('discover.popularScope', { source: sourceLabel }) : resultScope),
          el('span', null, t(popular ? 'discover.popularResults' : 'discover.results', { count: items.length }))),
        // A Host hint about how these results were chosen (an empty query falls back to a listing);
        // the popular header already says that, so keep the note for actual searches only.
        discover.status === 'ready' && note !== '' && popular === false && el('p', { className: 'skd-noteLine', role: 'note' }, note),
        discover.status === 'ready' && items.length > 0 && el('div', { className: 'skd-rankHead', 'aria-hidden': true },
          el('span', null, t('discover.columnRank')),
          el('span', null, t('discover.columnSkill')),
          el('span', null, t('discover.columnInstalls')),
          el('span')),
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

    /** An unknown verdict keeps the Host's own word instead of inventing a Chinese label. */
    function verdictLabel(verdict, t) {
      const key = 'diagnosis.verdict.' + verdict;
      const localized = t(key);
      return localized === key ? verdict : localized;
    }

    /** One diagnosis row: native selection, the Host's verdict, and its three verbs. */
    function DiagnosisRowBase(props) {
      const {
        row, t, checked, busy, writesLocked, confirming, note, previewTarget, observedDays,
        onSelect, onAskRemove, onConfirmRemove, onCancelRemove, onDisable, onKeep, onPreview,
      } = props;
      const name = row.name;
      const kept = row.verdict === 'kept';
      const actionable = row.can.disable === true || row.can.remove === true || row.can.keep === true;
      const removeRef = useRef(null);
      const cancelRef = useRef(null);
      const confirmId = 'skd-diagnosis-confirm-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
      useEffect(() => { if (confirming) cancelRef.current?.focus({ preventScroll: true }); }, [confirming]);
      const cancel = () => { onCancelRemove(); removeRef.current?.focus({ preventScroll: true }); };
      const evidence = (row.idleDays === null
        ? (row.watchedDays === observedDays ? '' : t('diagnosis.evidence.never', { watched: row.watchedDays }))
        : t('diagnosis.evidence.idle', { idle: row.idleDays, count: row.useCount }))
        + (row.keptAt !== null ? ' · ' + t('diagnosis.evidence.kept', { date: formatDate(row.keptAt) })
          : row.lastUsedAt !== null ? ' · ' + t('diagnosis.evidence.lastUsed', { date: formatDate(row.lastUsedAt) }) : '');
      return el('li', { className: 'skd-diagnosisItem', 'aria-label': name },
        el('div', { className: 'skd-diagnosisRow', 'aria-busy': busy === true || undefined },
          el('label', { className: 'skd-diagnosisCheck' },
            el(Input, {
              type: 'checkbox', className: 'skd-diagnosisCheckInput', checked: checked === true,
              disabled: actionable === false || writesLocked === true,
              'aria-label': t('diagnosis.selectRow', { name }),
              onChange: (event) => onSelect(name, event.target.checked),
            })),
          el('div', { className: 'skd-diagnosisMain' },
            el('div', { className: 'skd-rowHead' },
              previewTarget !== null ? el(Button, {
                className: 'skd-rowName skd-nameButton', title: t('preview.open', { name }),
                'aria-label': t('preview.open', { name }), onClick: () => onPreview(previewTarget),
              }, name) : el('span', { className: 'skd-rowName' }, name),
              el('div', { className: 'skd-badges' },
                el(Badge, { className: 'skd-badge', 'data-tone': row.bucket === 'cleanup' ? 'accent' : undefined }, verdictLabel(row.verdict, t)),
                row.closed === true && el(Badge, { className: 'skd-badge', 'data-tone': 'muted' }, t('diagnosis.closed')),
                row.writable === false && el(Badge, { className: 'skd-badge', 'data-tone': 'muted' }, t('skill.readonly')))),
            evidence !== '' && el('p', { className: 'skd-diagnosisEvidence' }, evidence)),
          el('div', { className: 'skd-diagnosisActions' },
            row.can.disable === true && el(Button, {
              className: 'skd-button',
              disabled: writesLocked === true,
              onClick: () => onDisable(name),
            }, t('diagnosis.disable')),
            row.can.remove === true && el(Button, {
              className: 'skd-button', ref: removeRef,
              disabled: writesLocked === true,
              onClick: () => onAskRemove(name),
            }, t('diagnosis.remove')),
            row.can.keep === true && el(Button, {
              className: 'skd-button', disabled: writesLocked === true,
              onClick: () => onKeep(name, kept !== true),
            }, t(kept === true ? 'diagnosis.unkeep' : 'diagnosis.keep')),
            actionable === false && el('span', { className: 'skd-diagnosisNoAction', 'aria-hidden': true }, '—'))),
        confirming === true && el('div', {
          className: 'skd-confirm skd-diagnosisConfirm', role: 'group',
          'aria-label': t('diagnosis.remove'), 'aria-describedby': confirmId,
          onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } },
        },
          el('span', { id: confirmId, className: 'skd-confirmText' }, t('skill.removeConfirm', { name })),
          el(Button, {
            className: 'skd-button', 'data-variant': 'danger', disabled: writesLocked === true,
            onClick: () => onConfirmRemove(name),
          }, t('skill.removeConfirmAction')),
          el(Button, { className: 'skd-button', ref: cancelRef, onClick: cancel }, t('action.cancel'))),
        note !== null && el('p', { className: 'skd-noteLine skd-diagnosisRowNote', role: 'note' },
          describeFailure(textOf(note.code) !== '' ? textOf(note.code) : null, textOf(note.message) !== '' ? textOf(note.message) : null, t)),
      );
    }
    const DiagnosisRow = memo(DiagnosisRowBase);

    /**
     * The diagnosis queue. The Host supplies verdicts, counts and every `can.*` flag; this
     * component only filters names, holds the selection and posts the three verbs.
     */
    function DiagnosisTab(props) {
      const {
        diagnosis, catalog, t, view, setView, pending, rowNotes,
        onPreview, onCleanup, onKeep,
      } = props;
      const block = objectOf(diagnosis);
      const id = 'skd-diagnosis-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
      const headingRef = useRef(null);
      const listRef = useRef(null);
      const bulkCancelRef = useRef(null);
      const bulkRemoveRef = useRef(null);
      const [confirmingBulk, setConfirmingBulk] = useState(false);
      const [confirmingRow, setConfirmingRow] = useState('');
      const [announced, setAnnounced] = useState('');
      const pickedBucket = useRef(false);
      const counts = block === null ? {} : objectOf(block.counts) ?? {};
      const thresholds = block === null ? {} : objectOf(block.thresholds) ?? {};
      const requested = textOf(view.bucket) === '' ? 'cleanup' : textOf(view.bucket);
      // §8.7 starts on 可清理 but lands on 在用 when there is nothing to clean. Once the
      // user chooses a segment, that choice is never overridden by the fallback.
      const bucket = requested === 'cleanup' && countOf(counts.cleanup) === 0 && countOf(counts.active) > 0
        && pickedBucket.current === false ? 'active' : requested;
      const selectBucket = (next) => {
        pickedBucket.current = true;
        setConfirmingRow('');
        setConfirmingBulk(false);
        setView((current) => ({ ...current, bucket: next, selected: [] }));
      };
      const rows = useMemo(() => diagnosisRows(block, {
        bucket, query: view.query, sort: view.sort ?? 'host',
      }), [block, bucket, view.query, view.sort]);
      const selected = stringsOf(view.selected);
      const tally = diagnosisTally(rows, selected);
      const selectedSet = new Set(selected);
      const selectable = rows.filter((row) => row.can.disable === true || row.can.remove === true || row.can.keep === true);
      const allSelected = selectable.length > 0 && selectable.every((row) => selectedSet.has(row.name));
      const writable = pending === null;
      const catalogByName = useMemo(() => {
        const entries = new Map();
        for (const skill of Array.isArray(catalog) ? catalog : []) {
          const item = objectOf(skill);
          const name = textOf(item?.name);
          if (item !== null && name !== '') entries.set(name, item);
        }
        return entries;
      }, [catalog]);
      const targetOf = useCallback((name) => ({ name, path: textOf(catalogByName.get(name)?.path) }), [catalogByName]);
      const announcement = t('diagnosis.selectionStatus', { count: tally.names.length });
      useEffect(() => {
        const timer = setTimeout(() => setAnnounced(announcement), 350);
        return () => clearTimeout(timer);
      }, [announcement]);
      useEffect(() => { if (confirmingBulk) bulkCancelRef.current?.focus({ preventScroll: true }); }, [confirmingBulk]);

      const settleFocus = useCallback(() => {
        const first = listRef.current?.querySelector('.skd-diagnosisCheckInput:not(:disabled), .skd-nameButton');
        (first ?? headingRef.current)?.focus?.({ preventScroll: true });
      }, []);
      const toggleRow = useCallback((name, next) => setView((current) => {
        const names = new Set(stringsOf(current.selected));
        if (next === true) names.add(name); else names.delete(name);
        return { ...current, selected: [...names] };
      }), [setView]);
      const dropSelection = useCallback((name) => setView((current) => ({ ...current, selected: stringsOf(current.selected).filter((entry) => entry !== name) })), [setView]);
      const clearSelection = useCallback(() => setView((current) => ({ ...current, selected: [] })), [setView]);
      const toggleAll = () => setView((current) => ({
        ...current,
        selected: allSelected === true ? [] : selectable.map((row) => row.name),
      }));
      const disableRow = useCallback((name) => { void onCleanup('disable', [targetOf(name)]).then(settleFocus); }, [onCleanup, targetOf, settleFocus]);
      const keepRow = useCallback((name, keep) => { void onKeep([{ name, keep }]).then(settleFocus); }, [onKeep, settleFocus]);
      const removeRow = useCallback((name) => {
        setConfirmingRow('');
        void onCleanup('remove', [targetOf(name)]).then(() => { dropSelection(name); settleFocus(); });
      }, [onCleanup, dropSelection, targetOf, settleFocus]);
      const cancelRemove = useCallback(() => { setConfirmingRow(''); }, []);
      const cancelBulk = () => { setConfirmingBulk(false); bulkRemoveRef.current?.focus({ preventScroll: true }); };
      const bulkCleanup = async (mode) => {
        const names = (mode === 'remove' ? tally.remove : tally.disable).slice(0, CLEANUP_TARGET_LIMIT);
        setConfirmingBulk(false);
        await onCleanup(mode, names.map(targetOf));
        // Names past the Host's batch cap stay selected for a second pass.
        setView((current) => ({
          ...current,
          selected: stringsOf(current.selected).filter((name) => names.includes(name) === false),
        }));
        settleFocus();
      };
      const bulkKeep = async () => {
        await onKeep(tally.keep);
        clearSelection();
        settleFocus();
      };

      if (block === null) {
        return el('div', { className: 'skd-panel skd-diagnosisPanel' },
          el(SectionHeading, { title: t('diagnosis.title'), body: t('diagnosis.basis') }),
          el('div', { className: 'skd-state' },
            el('span', { className: 'skd-stateIcon' }, el(Glyph, { name: 'pulse', size: 24 })),
            el('h3', { className: 'skd-stateTitle' }, t('diagnosis.oldHost.title')),
            el('p', { className: 'skd-stateBody' }, t('diagnosis.oldHost.body')),
            el('div', { className: 'skd-stateActions' }, el(Button, {
              type: 'button', className: 'skd-button', onClick: () => { window.location.reload(); },
            }, t('action.reload')))));
      }

      let empty = null;
      if (rows.length === 0 && textOf(view.query).trim() !== '') {
        empty = el('div', { className: 'skd-state' },
          el('h3', { className: 'skd-stateTitle' }, t('diagnosis.noMatches.title')),
          el('p', { className: 'skd-stateBody' }, t('diagnosis.noMatches.body')),
          el('div', { className: 'skd-stateActions' }, el(Button, {
            className: 'skd-button', onClick: () => setView((current) => ({ ...current, query: '' })),
          }, t('diagnosis.noMatches.action'))));
      } else if (rows.length === 0 && bucket === 'cleanup') {
        empty = el('div', { className: 'skd-state' },
          el('span', { className: 'skd-stateIcon' }, el(Glyph, { name: 'pulse', size: 24 })),
          el('h3', { className: 'skd-stateTitle' }, t('diagnosis.noCleanup.title')),
          el('p', { className: 'skd-stateBody' }, t('diagnosis.noCleanup.body', { days: countOf(thresholds.watchDays) })),
          el('div', { className: 'skd-stateActions' }, el(Button, {
            className: 'skd-button', onClick: () => selectBucket('active'),
          }, t('diagnosis.noCleanup.action'))));
      } else if (rows.length === 0) {
        empty = el('div', { className: 'skd-state' },
          el('h3', { className: 'skd-stateTitle' }, t('diagnosis.bucketEmpty')));
      }

      const rail = tally.names.length === 0 ? null : el('div', {
        className: 'skd-diagnosisRail', role: 'group', 'aria-label': t('diagnosis.rail'),
      },
        el('p', { className: 'skd-diagnosisTally' }, t('diagnosis.tally', {
          selected: tally.names.length, disable: tally.disable.length,
          remove: tally.remove.length, readonly: tally.readonly.length,
        })),
        el('div', { className: 'skd-diagnosisRailActions' },
          el(Button, {
            className: 'skd-button', 'data-variant': 'primary',
            disabled: tally.disable.length === 0 || writable === false,
            onClick: () => { void bulkCleanup('disable'); },
          }, t('diagnosis.disable')),
          el(Button, {
            className: 'skd-button', ref: bulkRemoveRef, 'data-variant': 'danger',
            disabled: tally.remove.length === 0 || writable === false,
            onClick: () => setConfirmingBulk(true),
          }, t('diagnosis.remove')),
          el(Button, {
            className: 'skd-button', disabled: tally.keep.length === 0 || writable === false,
            onClick: () => { void bulkKeep(); },
          }, t(tally.keep.every((entry) => entry.keep === false) ? 'diagnosis.unkeep' : 'diagnosis.keep')),
          el(Button, { className: 'skd-button', onClick: clearSelection }, t('diagnosis.clearSelection'))),
        confirmingBulk === true && el('div', {
          className: 'skd-confirm skd-diagnosisConfirm', role: 'group',
          'aria-label': t('diagnosis.remove'), 'aria-describedby': id + '-bulk-confirm',
          onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancelBulk(); } },
        },
          el('span', { id: id + '-bulk-confirm', className: 'skd-confirmText' }, t('diagnosis.removeConfirmMany', {
            count: tally.remove.length,
            names: tally.remove.slice(0, 3).join('、'),
            more: tally.remove.length > 3 ? t('diagnosis.moreNames', { count: tally.remove.length - 3 }) : '',
          })),
          el(Button, {
            className: 'skd-button', 'data-variant': 'danger', disabled: writable === false,
            onClick: () => { void bulkCleanup('remove'); },
          }, t('skill.removeConfirmAction')),
          el(Button, { className: 'skd-button', ref: bulkCancelRef, onClick: cancelBulk }, t('action.cancel'))));

      const notes = objectOf(rowNotes) ?? {};
      return el('div', { className: 'skd-panel skd-diagnosisPanel', 'aria-busy': pending !== null || undefined },
        el('div', { className: 'skd-diagnosisHeading', ref: headingRef, tabIndex: -1 },
          el(SectionHeading, { title: t('diagnosis.title'), body: t('diagnosis.basis') })),
        el('p', { className: 'skd-noteLine skd-diagnosisHorizon' }, t('diagnosis.horizon', {
          date: formatDate(block.since) || '—',
          days: countOf(block.observedDays),
          total: countOf(counts.total),
          active: countOf(counts.active),
          activeDays: countOf(thresholds.activeDays),
        })),
        el('div', { className: 'skd-diagnosisBuckets' },
          el(Segmented, {
            items: DIAGNOSIS_BUCKETS.map((entry) => ({
              id: entry,
              label: el('span', { className: 'skd-bucketOption' },
                el('span', { className: 'skd-bucketName' }, t('diagnosis.bucket.' + entry)),
                el('span', { className: 'skd-bucketCount' }, formatNumber(countOf(counts[entry])))),
            })),
            value: bucket,
            label: t('diagnosis.buckets'),
            onChange: selectBucket,
          })),
        el('div', { className: 'skd-toolbar skd-diagnosisQueue' },
          el('div', { className: 'skd-resultLine skd-diagnosisResults' },
            el('span', null, t('diagnosis.queueCount', { bucket: t('diagnosis.bucket.' + bucket), count: rows.length }))),
          el('div', { className: 'skd-searchField' },
            el('label', { className: 'skd-fieldLabel', htmlFor: id + '-query' }, t('diagnosis.searchLabel')),
            el('div', { className: 'skd-searchBox' }, el(Glyph, { name: 'search' }), el(Input, {
              id: id + '-query', name: 'diagnosis-query', className: 'skd-input', type: 'search',
              value: view.query, placeholder: t('diagnosis.searchPlaceholder'),
              autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false,
              onChange: (event) => setView((current) => ({ ...current, query: event.target.value })),
            }))),
          el(Button, {
            className: 'skd-button', disabled: selectable.length === 0 || writable === false,
            'aria-pressed': allSelected === true,
            onClick: toggleAll,
          }, t(allSelected === true ? 'diagnosis.clearSelection' : 'diagnosis.selectAll'))),
        empty !== null ? empty : el('ul', {
          className: 'skd-list skd-diagnosisList', ref: listRef,
          'aria-busy': pending !== null || undefined,
        }, rows.map((row) => {
          const entry = objectOf(catalogByName.get(row.name));
          const busy = pending !== null && (pending.kind === 'cleanup' || pending.kind === 'keep')
            && textOf(pending.target).split(',').includes(row.name);
          return el(DiagnosisRow, {
            key: row.name,
            row, t,
            observedDays: countOf(block.observedDays),
            checked: selectedSet.has(row.name),
            busy,
            writesLocked: writable === false,
            confirming: confirmingRow === row.name,
            note: objectOf(notes[row.name]),
            previewTarget: textOf(entry?.path) !== '' ? entry : null,
            onSelect: toggleRow,
            onAskRemove: setConfirmingRow,
            onConfirmRemove: removeRow,
            onCancelRemove: cancelRemove,
            onDisable: disableRow,
            onKeep: keepRow,
            onPreview,
          });
        })),
        rail,
        el('details', { className: 'skd-chartDetails skd-diagnosisPolicy' },
          el('summary', null, t('diagnosis.policy')),
          el('ul', { className: 'skd-diagnosisPolicyList' },
            el('li', null, t('diagnosis.policy.active', { days: countOf(thresholds.activeDays) })),
            el('li', null, t('diagnosis.policy.stale', { days: countOf(thresholds.staleDays) })),
            el('li', null, t('diagnosis.policy.watch', { days: countOf(thresholds.watchDays) })),
            el('li', null, t('diagnosis.policy.keep')))),
        el('span', { className: 'skd-visuallyHidden', role: 'status', 'aria-atomic': true }, announced),
      );
    }

    // ---------------------------------------------------------------- page
    /** The panel: header, tab bar, scrolling body, and the footer status line. */
    function SkillDashboardPage(props) {
      const {
        useDashboard, t, refresh, setInvocation, removeSkill, updateSkill,
        installSkill, keepSkill, cleanupSkills, selectSource, runDiscover, dismissNote,
        checkUpdates, applyUpdates,
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
      const [diagnosisView, setDiagnosisView] = useState({ bucket: 'cleanup', query: '', selected: [] });
      const [updatesDismissed, setUpdatesDismissed] = useState(false);
      const [updatesOpen, setUpdatesOpen] = useState(false);
      const [autoUpdate, setAutoUpdate] = useState(() => readAutoUpdateSettings(storageOf()));
      const [pickerOpen, setPickerOpen] = useState(false);
      const updateWrapRef = useRef(null);
      const updateTriggerRef = useRef(null);
      const updatePanelRef = useRef(null);
      const chooseRef = useRef(null);
      const autoAppliedSeq = useRef(0);
      const autoChecked = useRef(false);
      const scrollRef = useRef(null);
      const libraryInputRef = useRef(null);
      const contentRef = useRef(null);
      const scrollPositions = useRef(new Map());
      const focusNextPage = useRef(false);
      const pageId = 'skd-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
      const libraryInputId = pageId + '-query';
      const updatePanelId = pageId + '-updates';

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

      // A preview belongs to the tab that opened it, so a tab switch drops it.
      useEffect(() => { setPreviewTarget(null); }, [tab]);

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

      // Update availability rides on the same state read; an older Host sends no block.
      const updatesSupported = objectOf(data?.updates) !== null;
      const updates = useMemo(() => objectOf(data?.updates) ?? { checkedAt: 0, available: [] }, [data]);
      const availableUpdates = useMemo(() => (
        Array.isArray(updates.available) ? updates.available.map((entry) => objectOf(entry)).filter((entry) => entry !== null) : []
      ), [updates]);
      const availableNames = useMemo(
        () => new Set(availableUpdates.map((entry) => textOf(entry.name))),
        [availableUpdates],
      );

      // The input stays urgent while the list catches up, so typing never waits on a filter pass.
      const deferredLibraryQuery = deferredValue(libraryQuery);
      const visible = useMemo(() => filterSkills(skills, {
        runtime: agentFilter, query: deferredLibraryQuery, status: invocationFilter, sort, updatable: availableNames,
      }), [skills, agentFilter, deferredLibraryQuery, invocationFilter, sort, availableNames]);
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

      const updatesProgress = objectOf(snapshot.updatesProgress) ?? { done: 0, total: 0 };
      const updatesError = textOf(snapshot.updatesError);
      const updatingAll = objectOf(snapshot.updatingAll);
      const updatesCheckedAt = countOf(updates.checkedAt);
      const updatesCheckSeq = countOf(snapshot.updatesCheckSeq);
      const availableNameList = useMemo(
        () => availableUpdates.map((entry) => textOf(entry.name)),
        [availableUpdates],
      );
      const commonNames = useMemo(() => commonUpdateNames(skills, availableNameList), [skills, availableNameList]);
      const autoTargets = useMemo(
        () => autoUpdateTargets(autoUpdate, availableNameList),
        [autoUpdate, availableNameList],
      );
      const autoBusy = pending !== null || updatingAll !== null || snapshot.updatesChecking === true;
      const saveAutoUpdate = (next) => { setAutoUpdate(writeAutoUpdateSettings(storageOf(), next)); };
      const updatesChecking = snapshot.updatesChecking === true;
      const updatePillTone = availableUpdates.length > 0 && updatesDismissed === false ? 'accent'
        : updatesError !== '' ? 'error' : 'ok';
      // Keep the count visible while a check runs; the dot and the panel carry progress.
      const updatePillLabel = availableUpdates.length > 0
        ? t('updates.pill', { count: availableUpdates.length })
        : updatesChecking ? t('updates.pillCheckingStart')
          : updatesError !== ''
            ? t('updates.pillInterrupted')
            : updatesCheckedAt > 0 ? t('updates.pillLatest') : t('updates.pillNone');
      const closePicker = () => {
        setPickerOpen(false);
        chooseRef.current?.focus({ preventScroll: true });
      };
      const closeUpdates = () => {
        setUpdatesOpen(false);
        setPickerOpen(false);
        updateTriggerRef.current?.focus({ preventScroll: true });
      };
      const updateSummaryBody = el('div', { className: 'skd-updatePanelBody' },
        el('div', { className: 'skd-updatePanelHead' },
          el('span', { className: 'skd-updatePanelTitle' }, t('updates.panelTitle')),
          el('span', { className: 'skd-updatePanelStatus' },
            updatesChecking
              ? t('updates.checking', { done: countOf(updatesProgress.done), total: countOf(updatesProgress.total) })
              : updatesCheckedAt > 0 ? t('updates.lastChecked', { time: formatClock(updatesCheckedAt) }) : t('updates.never'))),
        availableUpdates.length > 0
          ? el('p', { className: 'skd-updateSummary' }, t('updates.panelAvailable', { count: availableUpdates.length }))
          : el('p', { className: 'skd-updateSummary skd-updateSummaryQuiet' },
            updatesCheckedAt > 0 ? t('updates.pillLatest') : t('updates.never')),
        availableUpdates.length > 0 && el('div', { className: 'skd-updateActions' },
          el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'primary', disabled: autoBusy,
            onClick: () => { void applyUpdates(availableNameList); },
          }, updatingAll !== null
            ? t('updates.applying', { done: countOf(updatingAll.done), total: countOf(updatingAll.total) })
            : t('updates.applyAll', { count: availableUpdates.length })),
          commonNames.length > 0 && commonNames.length < availableUpdates.length && el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'outline', disabled: autoBusy,
            onClick: () => { void applyUpdates(commonNames); },
          }, t('updates.applyCommon', { count: commonNames.length })),
          el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'text',
            onClick: () => { setInvocationFilter('updatable'); closeUpdates(); },
          }, t('updates.onlyAvailable'))),
        el('div', { className: 'skd-updateAuto' },
          el(Switch, {
            checked: autoUpdate.enabled === true,
            label: t('updates.autoToggle'),
            hint: t('updates.autoHint'),
            onChange: (checked) => {
              saveAutoUpdate({ enabled: checked, names: autoUpdate.names });
              if (checked && autoUpdate.names.length === 0) setPickerOpen(true);
            },
          }, t('updates.autoToggle')),
          el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'text', ref: chooseRef,
            onClick: () => { setPickerOpen(true); },
          }, t('updates.autoChoose', { count: autoUpdate.names.length }))),
        updatesError !== '' && el('p', { className: 'skd-updateError', title: updatesError },
          t('updates.interrupted', { done: countOf(updatesProgress.done), total: countOf(updatesProgress.total) })),
        el('div', { className: 'skd-updateFoot' },
          el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'text',
            disabled: updatesChecking || updatingAll !== null,
            onClick: () => { void checkUpdates({ refresh: true }); },
          }, t('updates.check')),
          availableUpdates.length > 0 && updatesDismissed === false && el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'text',
            onClick: () => { setUpdatesDismissed(true); closeUpdates(); },
          }, t('updates.dismiss'))));
      const updatePickerBody = el('div', { className: 'skd-updatePanelBody' },
        el('div', { className: 'skd-updatePanelHead' },
          el(Button, { type: 'button', className: 'skd-button', 'data-variant': 'text', onClick: closePicker },
            t('updates.autoBack')),
          el('span', { className: 'skd-updatePanelTitle' }, t('updates.autoPicker')),
          el(Button, { type: 'button', className: 'skd-button', 'data-variant': 'text', onClick: closePicker },
            t('updates.autoDone'))),
        el('p', { className: 'skd-updateHint' }, t('updates.autoHint')),
        el('div', { className: 'skd-updatePickerActions' },
          el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'text',
            onClick: () => saveAutoUpdate({ enabled: autoUpdate.enabled, names: [...autoUpdate.names, ...availableNameList] }),
          }, t('updates.autoAll')),
          el(Button, {
            type: 'button', className: 'skd-button', 'data-variant': 'text',
            onClick: () => saveAutoUpdate({ enabled: autoUpdate.enabled, names: [] }),
          }, t('updates.autoNone'))),
        availableUpdates.length === 0
          ? el('p', { className: 'skd-updateHint' }, t('updates.autoEmpty'))
          : el('ul', { className: 'skd-updatePickerList' }, availableUpdates.map((entry) => {
            const name = textOf(entry.name);
            return el('li', { key: name },
              el('label', { className: 'skd-updatePickerItem' },
                el(Input, {
                  type: 'checkbox', className: 'skd-updateCheckInput',
                  checked: autoUpdate.names.includes(name),
                  onChange: (event) => saveAutoUpdate({
                    enabled: autoUpdate.enabled,
                    names: event.target.checked
                      ? [...autoUpdate.names, name]
                      : autoUpdate.names.filter((selected) => selected !== name),
                  }),
                }),
                el('span', null, name)));
          })));


      // One attempt per finished check. A settings edit is not a check, so ticking a name
      // never writes on its own, and a row that failed is not retried until the next check.
      useEffect(() => {
        if (updatesCheckSeq <= autoAppliedSeq.current) return;
        if (snapshot.updatesChecking === true || updatingAll !== null) return;
        autoAppliedSeq.current = updatesCheckSeq;
        if (autoUpdate.enabled !== true || autoTargets.length === 0) return;
        void applyUpdates(autoTargets, { auto: true });
      }, [updatesCheckSeq, autoUpdate, autoTargets, snapshot.updatesChecking, updatingAll, applyUpdates]);

      // The picker lives inside the header popover; opening it moves focus into the list.
      useEffect(() => {
        if (pickerOpen === true) updatePanelRef.current?.querySelector('.skd-updatePickerItem input')?.focus?.({ preventScroll: true });
      }, [pickerOpen]);
      useEffect(() => {
        if (updatesOpen === false) return undefined;
        const onPointer = (event) => {
          if (updateWrapRef.current?.contains(event.target)) return;
          setUpdatesOpen(false);
          setPickerOpen(false);
        };
        document.addEventListener('pointerdown', onPointer, true);
        return () => document.removeEventListener('pointerdown', onPointer, true);
      }, [updatesOpen]);
      useEffect(() => {
        if (updatesOpen === false) return undefined;
        updatePanelRef.current?.focus({ preventScroll: true });
        return undefined;
      }, [updatesOpen]);
      // Escape belongs to the popover. Capture it before the host view can act on the same key.
      useEffect(() => {
        if (updatesOpen === false) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          setUpdatesOpen(false);
          setPickerOpen(false);
          updateTriggerRef.current?.focus({ preventScroll: true });
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [updatesOpen]);

      // One automatic check after the first successful load, when nothing was
      // checked in the last six hours and the Host tracks at least one skill.
      useEffect(() => {
        if (autoChecked.current || data === null || snapshot.updatesChecking === true) return;
        if (!updatesSupported || !shouldAutoCheck(updates, skills)) return;
        autoChecked.current = true;
        void checkUpdates({ refresh: false });
      }, [data, updates, updatesSupported, skills, snapshot.updatesChecking, checkUpdates]);

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

      // Row memo compares props, so these handlers must keep their identity across renders.
      const toggleInvocation = useCallback((skill, changes) => { void setInvocation(skill, changes); }, [setInvocation]);
      const updateRow = useCallback((skill, ref) => { void updateSkill(skill, ref); }, [updateSkill]);
      // Stable identities: a snapshot tick must not hand every memoized diagnosis row new verbs.
      const cleanupDiagnosis = useCallback((mode, targets) => cleanupSkills(mode, targets), [cleanupSkills]);
      const keepDiagnosis = useCallback((entries) => keepSkill(entries), [keepSkill]);
      const installDiscover = useCallback((item, source) => installSkill(item, source), [installSkill]);
      const retryDiscover = useCallback(() => { void runDiscover(discover.source, textOf(discover.query)); }, [discover.source, discover.query, runDiscover]);
      const askRemove = useCallback((skill) => { setConfirmingPath(textOf(skill?.path)); }, []);
      const cancelRemove = useCallback(() => { setConfirmingPath(''); }, []);
      const confirmRemove = useCallback((skill, next) => {
        (next ?? libraryInputRef.current)?.focus({ preventScroll: true });
        setConfirmingPath('');
        void removeSkill(skill);
      }, [removeSkill]);
      const togglePath = useCallback((path) => { setExpandedPath((current) => (current === path ? '' : path)); }, []);
      const search = (query) => {
        if (typeof query === 'string') setQueryDraft(query);
        void runDiscover(discover.source, (typeof query === 'string' ? query : queryDraft).trim());
      };

      const changeDiscoverSource = (id) => {
        if (id === discover.source) return;
        selectSource(id);
        if (discover.status !== 'idle') void runDiscover(id, textOf(discover.query));
      };

      const cleanupCount = countOf(objectOf(objectOf(data?.diagnosis)?.counts)?.cleanup);
      const tabs = [
        { id: 'installed', label: t('tab.installed'), count: data !== null ? skills.length : undefined },
        { id: 'discover', label: t('tab.discover') },
        { id: 'usage', label: t('tab.usage') },
        { id: 'diagnosis', label: t('tab.diagnosis'), count: cleanupCount > 0 ? cleanupCount : undefined, countTone: cleanupCount > 0 ? 'warn' : undefined },
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

      const syncError = snapshot.syncError === true;
      const errorText = pending === null && note !== null && note.tone === 'error' ? noteTextOf(note, t) : '';
      const statusNote = pending !== null ? t('status.busy')
        : note !== null && note.tone !== 'error' ? noteTextOf(note, t) : '';
      const statusTone = syncError ? 'error'
        : pending !== null ? 'idle'
          : note !== null && note.tone !== 'error' && textOf(note.tone) !== '' ? note.tone : 'idle';
      const fetchedAt = Number.isFinite(snapshot.fetchedAt) ? snapshot.fetchedAt : 0;
      const statusLabel = statusNote !== '' ? statusNote
        : syncError ? t('offline.title')
          : fetchedAt > 0 ? t('status.updatedAt', { time: formatClock(fetchedAt) })
            : t('status.ready');

      if (data === null && status === 'offline') {
        return el('section', { className: 'skd-page', 'aria-label': t('panel.label') },
          el('header', { className: 'skd-top' },
            el('div', { className: 'skd-wrap' },
              el('div', { className: 'skd-header' },
                el('div', { className: 'skd-headText' },
                  el('h1', { className: 'skd-title' }, t('panel.title')),
                  el('p', { className: 'skd-subtitle' }, t('panel.intro')),
                ),
              ),
            ),
          ),
          el('div', { className: 'skd-scroll' },
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
          ),
        );
      }

      if (data === null) {
        return el('section', { className: 'skd-page', 'aria-label': t('panel.label'), 'aria-busy': true },
          el('header', { className: 'skd-top' },
            el('div', { className: 'skd-wrap' },
              el('div', { className: 'skd-header' },
                el('div', { className: 'skd-headText' },
                  el('h1', { className: 'skd-title' }, t('panel.title')),
                  el('p', { className: 'skd-subtitle' }, t('panel.intro')),
                ),
                el('div', { className: 'skd-headerTools' },
                  el('span', { className: 'skd-statusPill', role: 'status' },
                    el('span', { className: 'skd-statusDot', 'data-busy': '', 'aria-hidden': true }),
                    t('skill.loading'),
                  ),
                  el(Button, {
                    type: 'button', className: 'skd-iconButton', 'aria-label': t('action.refresh'),
                    disabled: true, 'data-spinning': '',
                  }, el(RefreshGlyph, { size: 15 })),
                ),
              ),
              el(TabBar, { tabs, value: tab, onChange: changeTab, label: t('tab.list'), idPrefix: pageId }),
            ),
          ),
          el('div', { className: 'skd-scroll', 'aria-hidden': true },
            el('div', { className: 'skd-wrap skd-content' },
              el('div', { className: 'skd-overview' },
                [0, 1, 2, 3].map((index) => el('div', { key: index, className: 'skd-overviewItem' },
                  el('span', { className: 'skd-skelBlock', style: { height: '12px', width: '56px', marginBottom: '6px' } }),
                  el('span', { className: 'skd-skelBlock', style: { height: '24px', width: '44px' } }),
                ))),
              el('div', { className: 'skd-panel' },
                el('div', { className: 'skd-skelFilterBar' },
                  el('span', { className: 'skd-skelBlock skd-skelInput' }),
                  el('span', { className: 'skd-skelBlock skd-skelInput' }),
                  el('span', { className: 'skd-skelBlock skd-skelInput' }),
                  el('span', { className: 'skd-skelBlock skd-skelInput' }),
                ),
                el('div', { className: 'skd-list' },
                  [0, 1, 2, 3, 4, 5].map((index) => el('div', { key: index, className: 'skd-skelRow' },
                    el('div', { className: 'skd-skelRowMain' },
                      el('span', { className: 'skd-skelBlock', style: { height: '15px', width: (28 + (index % 3) * 10) + '%' } }),
                      el('span', { className: 'skd-skelBlock', style: { height: '12px', width: (58 + (index % 2) * 16) + '%' } }),
                    ),
                    el('span', { className: 'skd-skelBlock', style: { height: '16px', width: '28px', justifySelf: 'end' } }),
                    el('div', { className: 'skd-skelSwitches' },
                      el('span', { className: 'skd-skelBlock', style: { height: '16px', width: '96px', borderRadius: '999px' } }),
                      el('span', { className: 'skd-skelBlock', style: { height: '16px', width: '96px', borderRadius: '999px' } }),
                    ),
                    el('span', { className: 'skd-skelBlock', style: { height: '24px', width: '24px', justifySelf: 'end' } }),
                  ))),
              ),
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
                el('h1', { className: 'skd-title' }, t('panel.title')),
                el('p', { className: 'skd-subtitle' }, t('panel.intro')),
              ),
              el('div', { className: 'skd-headerTools' },
                tab === 'installed' && updatesSupported && el('div', { className: 'skd-updateWrap', ref: updateWrapRef },
                  el(Button, {
                    type: 'button', className: 'skd-updatePill', 'data-tone': updatePillTone === 'busy' ? undefined : updatePillTone,
                    'aria-haspopup': 'dialog', 'aria-expanded': updatesOpen, 'aria-controls': updatePanelId,
                    ref: updateTriggerRef,
                    onClick: () => { if (updatesOpen === true) closeUpdates(); else setUpdatesOpen(true); },
                    title: t('updates.panelTitle'),
                  },
                    el('span', {
                      className: 'skd-updateDot',
                      'data-tone': updatePillTone === 'accent' ? 'accent' : updatePillTone === 'error' ? 'error' : 'ok',
                      'data-busy': updatesChecking ? '' : undefined,
                      'aria-hidden': true,
                    }),
                    updatePillLabel),
                  updatesOpen === true && el('div', {
                    className: 'skd-updatePanel', role: 'dialog', 'aria-modal': false,
                    'aria-label': t('updates.panelTitle'), id: updatePanelId, ref: updatePanelRef, tabIndex: -1,
                    onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeUpdates(); } },
                  }, pickerOpen === true ? updatePickerBody : updateSummaryBody)),
                el('span', { className: 'skd-statusPill', 'data-tone': statusTone, role: 'status', title: statusLabel },
                  el('span', {
                    className: 'skd-statusDot',
                    'data-tone': statusTone,
                    'data-busy': refreshing || pending !== null ? '' : undefined,
                    'aria-hidden': true,
                  }),
                  statusLabel,
                ),
                tab === 'installed' && el(Button, {
                  type: 'button', className: 'skd-button', 'data-variant': 'outline',
                  onClick: () => changeTab('discover', true),
                }, el(Glyph, { name: 'plus', size: 14 }), t('action.discover')),
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
        syncError && el('div', { className: 'skd-wrap' },
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
                el('span', { className: 'skd-overviewValue' }, formatNumber(entry.value))))),
            el('div', {
              className: 'skd-panel',
              role: 'tabpanel',
              id: pageId + '-panel-' + tab,
              ref: contentRef,
              'aria-labelledby': pageId + '-tab-' + tab,
              tabIndex: 0,
            },
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
                  options: ['all', 'enabled', 'disabled', 'writable'].concat(updatesSupported ? ['updatable'] : []).map((id) => ({ id, label: t('installed.' + id) })) }),
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
              // A row memo would outlive a language switch, since the translator keeps its identity,
              // so one localized string rides along as part of the row's props.
              tab === 'installed' && el(InstalledTab, {
                skills: visible,
                t,
                runtimes,
                memoKey: t('tab.installed'),
                onPreview: setPreviewTarget,
                frequentRule,
                pending,
                filtered: hasFilters,
                onReset: resetFilters,
                onDiscover: () => changeTab('discover', true),
                expandedPath,
                confirmingPath,
                updatableNames: availableNames,
                onToggle: toggleInvocation,
                onUpdate: updateRow,
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
                onRetry: retryDiscover,
                onSelectSource: changeDiscoverSource,
                onInstall: installDiscover,
                onPreview: setPreviewTarget,
              }),
              tab === 'usage' && el(UsageTab, { data, t, view: usageView, setView: setUsageView }),
              tab === 'diagnosis' && el(DiagnosisTab, {
                diagnosis: objectOf(data.diagnosis),
                catalog: skills,
                t,
                view: diagnosisView,
                setView: setDiagnosisView,
                pending,
                rowNotes: objectOf(snapshot.rowNotes),
                onPreview: setPreviewTarget,
                onCleanup: cleanupDiagnosis,
                onKeep: keepDiagnosis,
              }),
            ),
            tabs.filter((entry) => entry.id !== tab).map((entry) => el('div', {
              key: entry.id, hidden: true, role: 'tabpanel',
              id: pageId + '-panel-' + entry.id, 'aria-labelledby': pageId + '-tab-' + entry.id,
            })),
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
            checkUpdates: runtime.checkUpdates,
            applyUpdates: runtime.applyUpdates,
            installSkill: runtime.installSkill,
            keepSkill: runtime.keepSkill,
            cleanupSkills: runtime.cleanupSkills,
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
