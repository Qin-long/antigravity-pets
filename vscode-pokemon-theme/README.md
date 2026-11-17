# ⚡ 宝可梦主题皮肤与智能体原版悬浮桌宠扩展 (`vscode-pokemon-theme`)

专为 **Antigravity IDE** 与 **VS Code** 打造的完整宝可梦主题配色与 **100% 官方原版宝可梦动图智能体桌宠** 扩展。

## ✨ 核心亮点

- **100% 原版宝可梦动图形象（拒绝抽象几何拼图）**：内置并默认启用官方原版精细动图，支持在 **✨ Showdown 3D 高清原版动图** 与 **👾 黑白 BW 经典像素原版动图** 之间一键无缝切换。
- **随 Antigravity IDE 自动启停绑定**：扩展激活事件覆盖 `["*", "onStartupFinished"]`，打开 `Antigravity.exe` 即自动后台守护 `127.0.0.1:17580` 实时监控桥并召唤桌面置顶透明原版宝可梦（`-BindToIde`），关闭 IDE 后自动优雅退出。

## 🎨 内置 6 套完整编辑器与工作台配色主题

1. **⚡ 皮卡丘·十万伏特暗色主题** (`themes/pikachu-volt-dark.json`) — 雷霆深蓝黑底色 + 电光金 `#FFD43B` + 伏特青类型高亮
2. **🟣 耿鬼·暗影球深紫主题** (`themes/gengar-shadow-dark.json`) — 幽灵深靛紫 `#120E1E` + 暗影紫 `#A855F7` + 猩红瞳光 `#F43F5E`
3. **🔥 喷火龙·闪焰冲锋主题** (`themes/charizard-flame-dark.json`) — 黑曜火山岩 `#181210` + 闪焰橙 `#FF6B2B` + 龙翼青 `#2DD4BF`
4. **🌙 月亮伊布·月光夜色主题** (`themes/umbreon-moonlight-dark.json`) — 深渊夜色 `#0B0F19` + 月环金 `#FACC15` + 月光蓝 `#60A5FA`
5. **🔮 超梦·精神击破暗色主题** (`themes/mewtwo-psystrike-dark.json`) — 华蓝洞窟银紫底色 `#110E1B` + 精神击破超能紫粉 `#D946EF` + 念力靛青 `#818CF8`
6. **🔴 洛托姆图鉴·清爽亮色主题** (`themes/pikachu-pokedex-light.json`) — 图鉴绯红 `#EF4444` + 等离子蓝 `#0EA5E9` 清爽白昼护眼风

## 🐾 IDE 内置智能体桌宠能力 (`extension.js`)

- **底部状态栏实时联动**：实时显示 `⚡ 宝可梦桌宠: N 个智能体运行中 (💭 Thinking · ⚡ Working · 💤 Sleeping)`。
- **左侧活动栏图鉴面板 (`pokemonPetSidebar`)** 与 **大屏悬浮宠物乐园 (`pokemonTheme.openPetArena`)**：
  - 支持全部 **7 大原版宝可梦**（皮卡丘 #25、耿鬼 #94、喷火龙 #6、月亮伊布 #197、伊布 #133、洛托姆 #479、超梦 #150），支持拖拽悬浮、摸头互动、Showdown 3D / BW 像素切换与 6 大代码主题实时切换。

## 🚀 一键安装到 Antigravity IDE

```powershell
powershell -ExecutionPolicy Bypass -File .\install-theme.ps1 -ApplyTheme mewtwo
```

## 🔮 全局 Antigravity 界面皮肤与右侧 Subagents 宝可梦同行编队 (`full-app-skin/`)

除了编辑器配色主题外，`full-app-skin/` 还为 **Antigravity 2.0** 与 **Antigravity IDE** 提供全窗口宝可梦换肤、右侧 `Subagents` 同行宝可梦编队卡片（带离线原版 GIF 动图、种族色光晕、底部 HP 能量条与 1列/2列并排切换）以及窗口内**水平并排同行桌宠栏**：

```powershell
# 一键注入全局皮肤（默认超梦 mewtwo，可选 pikachu/gengar/charizard/umbreon/pokedex-light）
powershell -ExecutionPolicy Bypass -File .\full-app-skin\apply-global-skin.ps1 -Theme mewtwo

# 一键无损还原原生界面与校验和备份
powershell -ExecutionPolicy Bypass -File .\full-app-skin\restore-global-skin.ps1
```
