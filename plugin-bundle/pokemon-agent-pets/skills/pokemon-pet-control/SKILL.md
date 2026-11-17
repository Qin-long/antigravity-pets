---
name: pokemon-pet-control
description: 召唤、控制与配置 100% 官方原版宝可梦智能体悬浮桌宠（支持与反重力 IDE 同启同停、Showdown 3D原版与黑白像素原版双风格切换，含超梦/皮卡丘/耿鬼/喷火龙/月亮伊布/伊布/洛托姆 7 种宝可梦）与六套宝可梦主题皮肤。
---

# 宝可梦原版智能体悬浮桌宠与 IDE 联动控制指南 (`pokemon-pet-control`)

本插件为 Antigravity 2.0 与 Antigravity IDE 提供 **100% 官方原版宝可梦动态形象** 与 **IDE 生命周期同启同停联动**：
1. **右侧副屏桌宠乐园 (`pet-arena` Sidecar)**：内嵌于 Antigravity 2.0 右侧副屏（Auxiliary Pane），默认渲染官方原版动态宝可梦（支持一键切换 `✨ 3D原版` / `👾 BW像素`）、6 套宝可梦主题配色切换，并在宿主启动时自动唤醒桥接与桌面悬浮宠。
2. **Windows 原生透明置顶原版桌宠 (`pokemon-desktop-overlay.ps1`)**：基于官方拆帧透明 PNG 序列帧逐帧驱动 `pikachu`、`gengar`、`charizard`、`umbreon`、`eevee`、`rotom`、`mewtwo` 7 种原版宝可梦，支持 `-BindToIde` 与 `Antigravity.exe` 同启同停（关闭 IDE >6.5 秒自动退出，兼容 `Reload Window`），实时展现 **`💭 思考中`**、**`⚡ 工作中`**、**`💤 休眠中`** 与 **`✨ 庆祝互动`** 状态！

## 常用操作指引

### 1. 在聊天中引导用户打开右侧桌宠副屏
当 `pokemon-agent-pets` 插件已启用时，可在回复中附上副屏快捷胶囊链接：

```markdown
[⚡ 宝可梦桌宠](sidecar://pokemon-agent-pets/pet-arena/)
```

### 2. 启动与反重力 IDE 绑定的原版宝可梦悬浮桌宠
在项目根目录（`<your-workspace>`，即本套件仓库克隆后的根目录）执行：

```powershell
# 方式 A：双击或运行同启脚本（同时启动 Antigravity.exe + 绑定生命周期的原版悬浮桌宠）
.\start-antigravity-with-pets.cmd

# 方式 B：一键启动桥接 + 召唤超梦主题原版悬浮桌宠（支持 -SpriteStyle showdown|pixel）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\start-pokemon-ide.ps1" -Theme mewtwo -BindToIde

# 仅关闭桌面悬浮宝可梦窗口
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\desktop-pet\launch-desktop-pet.ps1" -StopPets
```

### 3. 通过本地桥接 API 测试或切换智能体宝可梦形态
实时监控桥接服务运行在 `http://127.0.0.1:17580`：
- 查询在线智能体列表：`GET http://127.0.0.1:17580/api/agents`
- 切换指定智能体的宝可梦种类（`pikachu` / `gengar` / `charizard` / `umbreon` / `eevee` / `rotom` / `mewtwo`）或状态（`thinking` / `working` / `sleeping` / `celebrating` / `error`）：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:17580/api/simulate" -Method Post -ContentType "application/json; charset=utf-8" -Body '{"id":"main","name":"main-agent","pokemonSpecies":"mewtwo","state":"thinking","statusText":"🔮 超梦精神击破深度推理中！","ttlMs":60000}'
```
