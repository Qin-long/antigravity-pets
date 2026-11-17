# ⚡ 宝可梦原版智能体悬浮桌宠与主题中心 (`pokemon-agent-pets`)

专为 **Antigravity 2.0** 与 **Antigravity IDE** 打造的 **100% 官方原版形象** 智能体悬浮桌宠与主题皮肤插件包：
- **100% 原版宝可梦动态形象**：全面采用官方 Showdown 3D 高清动图原版与第五世代（黑白 BW）经典像素动图原版，覆盖皮卡丘 (`#025`)、耿鬼 (`#094`)、喷火龙 (`#006`)、月亮伊布 (`#197`)、伊布 (`#133`)、洛托姆 (`#479`)、超梦 (`#150`) 共 7 大原版宝可梦，零抽象几何图形！
- **与反重力 IDE 绑定同启同停 (`-BindToIde`)**：Sidecar 启动或打开 `Antigravity.exe` 时自动在真实桌面（`WinSta0\Default`）唤醒原版悬浮桌宠与实时监控桥接；当 `Antigravity.exe` 关闭持续 >6.5 秒后自动优雅退出（完美兼容 `Developer: Reload Window` 重载不掉线）。
- **右侧副屏桌宠乐园 (`sidecars/pet-arena`)**：支持拖拽互动、一键切换 `✨ 3D原版` / `👾 BW像素`、切换 6 套宝可梦皮肤（含 `🔮 超梦·精神击破`），以及一键召唤/收回 Windows 桌面透明置顶悬浮宠物。
- **零阻塞状态监听**：由后台 `bridge/agent-monitor.mjs` 直接追踪会话轨迹与集群状态，`hooks.json` 保持零阻塞空配置 `{}`，绝不干扰任何工具执行。

> 安装同步方式：在套件根目录运行 `.\plugin-bundle\sync-plugin.ps1` 或 `.\start-pokemon-ide.ps1 -InstallPlugin`，然后在 Antigravity 的 Customizations 页面开启 `pokemon-agent-pets` 即可实时生效（无需修改 `config.json`）。
