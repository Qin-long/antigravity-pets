# 更新日志 / Changelog

本项目在开源前一直以内部版本号迭代（状态桥 `/health` 返回的 `version` 当前为 `4.1.0`）。下面按代码中可以找到的版本标记整理主要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

- **双击一键安装 / 卸载**：新增根目录 `install.cmd`、`uninstall.cmd` 与 `installer/install.ps1`、`installer/uninstall.ps1`（中文提示，支持 `-DryRun`）。安装程序会去掉下载标记、检测 Node.js v24+（缺失时经 `winget` 安装 `OpenJS.NodeJS.LTS`）、只为已安装的客户端做对应步骤、下载副本复制到 `%LOCALAPPDATA%\AntigravityPets\` 后安装（带 `.git` 的开发副本原地安装），并在安装后自检状态桥、扩展、插件与皮肤备份；卸载程序还原皮肤、停止后台、移除扩展与插件目录。两者都不修改 `~/.gemini/config/config.json`。Antigravity 2.0 启动时副屏插件会自动弹出桌宠浮窗（上次运行中点 `[×]` 留下的静音标记会被忽略，本次运行中点 `[×]` 后不再自动弹出），可用插件 `workspace-config.json` 的 `autoShowDesktopPet: false` 关闭；文档中「零依赖」改为「需要 Node.js v24+，但不需要 `npm install` 任何包」。
- 首次以 MIT 许可开源：新增 `LICENSE`、`NOTICE.md`、`CONTRIBUTING.md`、`.gitignore`、`.gitattributes`，重写 `README.md`，并对文档与配置中的本机路径做了脱敏。
- **全链路性能优化**：状态桥引入 `subagentDirCache` / `oldConvSubagentScanned` 目录缓存、`transcriptCache` LRU 有界缓存、`SCAN_MIN_INTERVAL_MS` 扫描节流、紧凑 JSON 响应及 `GET /api/agents` `ETag / 304`；WPF 桌宠支持 `If-None-Match` 缓存短路、精灵包 `24` 槽位 LRU 淘汰与空闲自适应帧率；注入脚本精简 `MutationObserver` 与 SSE 在线兜底轮询。
- **底部模型旁上下文圆环与推理遥测 Hover 面板**：状态桥 `extractPerfTelemetry` 从 `transcript.jsonl` 实时计算 `tps`、`avgTps`、`ttfpMs`、`lastTurnDurationMs`、`totalOutputTokens` 与 `remainingTokens`；客户端在模型选择器（兼容 `Orchestrator (Carbon/Argon)`、`Claude`、`Gemini` 等）同行右侧挂载 SVG 上下文圆环，悬停弹出展示已用上下文、TPS、TTFP、KV 缓存命中率及 Token 明细（空白新会话自动归零防串台）。
- **通透无束缚悬浮窗与 `Subagents` 卡片等宽对齐**：WPF 桌宠去除实心圆盘与多层厚边框，移除已不再适用的 3D/像素切换入口；注入脚本按所有独立 `subagent-node` 列表容器分组强制等宽对齐，修复展开左下角托盘时右侧栏卡片收缩及指标裁切问题。
- **全世代精灵支持与场上去重**：支持紧凑 GIF 多帧原生解码（含 `tools/build-allgen-pokemon-pack.mjs` 全世代打包工具），并在抽卡与队列分配中保证场上同时存在的伙伴物种不重复。

## [4.1.0]

- **每智能体双环进度条**：状态桥从各会话 `transcript.jsonl` 提取 token 用量，为每个 `leadAgent` / `subagent` 输出 `context` 对象（`usedPct` 已用上下文、`cacheHitPct` 缓存命中率），WPF 浮窗、网页舞台、副屏与 `Subagents` 面板显示红色外环 + 绿色内环。
- **零控制台静默拉起**：后台进程统一经 `wscript.exe //B //Nologo desktop-pet/silent-launch.vbs` 启动，不再弹出 `cmd.exe` / Windows Terminal 窗口；浮窗显示后追加 Win32 `ShowWindow(SW_SHOW)`。
- **显式召唤浮窗**：新增 `POST /api/summon-overlay`（SSE `event: summon-overlay`），点过 `[×]` 静音后不再自动重弹，需要时一键召回。
- **皮肤包**：伙伴形象改由 `pack.json`（schema 1）驱动，新增原创 CC0 默认包 `packs/critters/`（`tools/build-critters-pack.mjs` 生成）、`GET /api/packs`、`GET /api/pack` 与按包独立的抽卡 / 图鉴记录；提供 `tools/export-pokemon-pack.mjs` 把本机宝可梦素材导出为私有包。

## [4.0.0]

- **全局唯一共享浮窗**：所有 Antigravity / Antigravity IDE 窗口共用一个 WPF 置顶透明浮窗（单实例互斥锁 `Local\AntigravityPokemonOverlay_Default`），按项目分组堆叠全部会话队列。
- **双击领队跳转会话**：双击 `👑 leadAgent` 调用 `POST /api/focus-session`，由状态桥广播 SSE `event: focus-session`，客户端还原并置顶对应窗口后按三段式导航切到目标会话；单击仍显示会话名与项目名。
- **全端主题同步**：新增 `GET/POST /api/theme` 与 SSE `event: theme-change`，在任意端切换 6 款配色即全端同步；`/api/ui-sync` 带防乒乓逻辑。

## [3.0.0]

- **多项目会话列队**：`/api/agents` 返回 `projects[].queues`，确立 6 条列队不变量：1 会话 = 1 水平队列；按项目归组；Slot 0 固定为 `👑 leadAgent`；`sleeping` 超过 60 秒的子智能体自动退场（`subagentIdleTtlMs = 60000`）；存在活跃子智能体时领队常驻；单击领队显示会话与项目名。
- 四套视图（WPF 桌宠、全局悬浮队列栏、副屏 `pet-arena`、网页舞台 `overlay.html`）统一遵守上述契约。

[Unreleased]: https://github.com/Qin-long/antigravity-pets/compare/v4.1.0...HEAD
[4.1.0]: https://github.com/Qin-long/antigravity-pets/releases/tag/v4.1.0
[4.0.0]: https://github.com/Qin-long/antigravity-pets/releases/tag/v4.0.0
[3.0.0]: https://github.com/Qin-long/antigravity-pets/releases/tag/v3.0.0
