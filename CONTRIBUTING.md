# 贡献指南

感谢你愿意为本项目出力！提交 Issue / PR 前请先阅读以下约定。

## 开发环境

- Windows 10 / 11（桌面浮窗基于 WPF 与 Win32 P/Invoke）
- Node.js **v24+**（使用原生 ESM、`node:http`、`node:sqlite`、`fetch`、`AbortSignal.timeout` 等内置 API）
- Windows PowerShell 5.1（系统自带）
- 可选：Antigravity IDE 和/或 Antigravity 2.0，用于实机验证皮肤与副屏插件

## 编码约定

1. **零第三方运行时依赖**：状态桥、Sidecar、工具脚本只使用 Node.js 内置模块，不要引入 npm 依赖，也不要提交 `node_modules/` 或 `package-lock.json`。
2. **注入脚本遵守 CSP / Trusted Types**：Antigravity IDE 启用了 `require-trusted-types-for 'script'`。注入到客户端的脚本（如 `vscode-pokemon-theme/full-app-skin/antigravity-global-skin.js`）**禁止使用 `innerHTML`、`outerHTML`、`insertAdjacentHTML`**，请用 `createElement` / `textContent` / `setAttribute` / `appendChild` 构建 DOM；不要替换或移动客户端 React 原生节点。
3. **PowerShell 写 JSON 必须用无 BOM 的 UTF-8**：使用 `New-Object System.Text.UTF8Encoding($false)` 配合 `[System.IO.File]::WriteAllText(...)`，否则 `JSON.parse` 会失败。
4. **WPF 脚本必须以 `-STA` 运行**：`desktop-pet/pokemon-desktop-overlay.ps1`（包括 `-SelfTest`）需要单线程单元。
5. **不要直接修改 `~/.gemini/config/config.json`**：插件启停交给用户在 Antigravity 的 Customizations 界面中操作。
6. **修改客户端文件必须可逆**：任何改动安装目录的逻辑都要维护 `.pokemon-backup` 备份，并保证 `-RestoreGlobalSkin` 能完整还原；改动 `workbench*.html` 后需同步更新 `product.json` 的校验和。
7. **不要提交个人信息**：不要把本机绝对路径、用户名、会话 ID、令牌等写进代码、文档或配置。
8. **宝可梦素材**：新增素材请优先使用原创或 CC0 资源（参考 `packs/critters/`）；不要向仓库新增受版权保护的素材。

## 提交前自检

在仓库根目录执行（均不会改动已安装的 Antigravity 客户端）：

```powershell
# 1. 桌面列队引擎无头自检（必须带 -STA）
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\desktop-pet\pokemon-desktop-overlay.ps1 -SelfTest

# 2. 副屏插件同步预检（只打印计划，不写入）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\plugin-bundle\sync-plugin.ps1 -DryRun

# 3. 所有改动过的 JS / MJS 语法检查
Get-ChildItem -Recurse -Include *.js,*.mjs -Exclude *.min.js | Where-Object { $_.FullName -notmatch '\\node_modules\\' } | ForEach-Object { node --check $_.FullName }
```

## Pull Request

- 一个 PR 只做一件事，描述里写清动机、改动点和你跑过的自检命令。
- 涉及界面的改动请附截图或 GIF。
- 如果改动了 `/api/agents` 返回结构或多会话列队规则，请同步更新 `docs/architecture.md`。
