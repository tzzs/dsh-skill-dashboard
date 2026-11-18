# DSH Skill Dashboard

DeepSeek Harness 技能看板插件，源码位于 [skill-dashboard](skill-dashboard/)。

- 统一管理各 Agent 的技能与调用权限。
- 从 skills.sh / 腾讯 SkillHub 查找和安装技能。
- 通过可折叠文件树预览技能说明和文件，支持按需加载、缓存和窗口缩放。
- 按今天、近 7/14/30/60 天或自定义日期查看逐技能调用次数、占比和趋势。
- 跟随 DSH 的语言、配色与字体。

## 开发与验证

要求 Node.js 20 或更高版本；运行时没有第三方 npm 依赖。

```sh
cd skill-dashboard
npm ci --ignore-scripts
npm run ci
```

默认测试仅使用临时目录和模拟远程响应，不依赖本机 DSH 配置，也不访问在线技能源。
`npm run test:live` 是手动集成检查，需要真实 DSH 技能目录及网络，常规 CI 不运行它。
本机截图、浏览器验证产物和提取的宿主参考资料位于未跟踪的 `_verify/`，不属于发布内容。

## 文档

- [使用说明](skill-dashboard/README.zh.md) / [English](skill-dashboard/README.md)
- [接口约定](docs/CONTRACT.md)
- [界面与宿主集成](docs/UI-INTEGRATION.md)

修改 Host 代码后需要重新加载插件或重启 DSH；客户端页面重新加载后生效。
