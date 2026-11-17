# NOTICE / 版权与第三方声明

本文件说明本仓库中**不属于** MIT 许可范围的内容及其权利归属、来源与使用限制。
This file describes the parts of this repository that are **not** covered by the MIT License, their ownership, origin and usage restrictions.

---

## 1. 宝可梦相关素材 / Pokémon materials

**中文**

- 「宝可梦 / Pokémon」及其角色名称、形象、精灵图（sprites）、动画与相关商标，版权与商标权归 **Nintendo / Creatures Inc. / GAME FREAK inc. / The Pokémon Company** 所有。
- 本项目是**非官方的粉丝作品（unofficial fan project）**，与上述公司没有任何关联，也未获得其授权、赞助或认可。
- 仓库中的宝可梦相关素材（主要位于 `assets/official-sprites/`、`assets/official-sprites-data.js`，以及以宝可梦形象为题材的 `assets/sprites/*.svg`）**不在 MIT 许可范围内**，仅供**个人学习、研究与非商业用途**。请勿将其用于任何商业目的，也不要单独再分发这些素材。
- 如权利人认为本仓库内容侵犯其权益，请通过 Issue 联系，我们会**立即移除**相关素材。

**English**

- Pokémon and all related names, characters, images, sprites, animations and trademarks are © and ™ **Nintendo / Creatures Inc. / GAME FREAK inc. / The Pokémon Company**.
- This is an **unofficial fan project**. It is not affiliated with, endorsed, sponsored or approved by any of the companies above.
- The Pokémon-related materials in this repository (mainly `assets/official-sprites/`, `assets/official-sprites-data.js`, and the Pokémon-themed `assets/sprites/*.svg`) are **NOT licensed under MIT** and are provided for **personal, educational and non-commercial use only**. Do not use them commercially and do not redistribute them on their own.
- If you are a rights holder and want any material removed, please open an issue and it will be **removed promptly**.

### 1.1 素材来源 / Origin of the sprites

据仓库内代码与清单可确认的信息如下（`assets/official-sprites/manifest.json` 本身**未记录**下载来源字段，以下来源依据代码中的引用地址整理）：
Based on what can be verified from the code and manifests in this repository (`assets/official-sprites/manifest.json` itself does **not** record a source URL; the list below is derived from URLs referenced in the code):

| 路径 / Path | 内容 / Content | 来源 / Origin |
|---|---|---|
| `assets/official-sprites/showdown/*.gif` | 7 只宝可梦的 3D 动态精灵 / animated 3D-style sprites of 7 Pokémon | Pokémon Showdown 动图（`assets/pokemon-sprites.js` 以 [PokeAPI/sprites](https://github.com/PokeAPI/sprites) `sprites/pokemon/other/showdown/` 与 `play.pokemonshowdown.com/sprites/ani/` 作为同款远程回退地址） |
| `assets/official-sprites/pixel/*.gif` | 第五世代（黑/白）像素动图 / Gen 5 Black & White animated pixel sprites | PokeAPI/sprites `sprites/pokemon/versions/generation-v/black-white/animated/`（同上，见 `assets/pokemon-sprites.js`） |
| `assets/official-sprites/frames/`、`frames-pixel/` | 由上述 GIF 拆出的透明 PNG 帧（共 811 帧）及每只的 `manifest.json` / transparent PNG frames split from the GIFs above (811 frames total) | 由上述 GIF 本地拆帧生成 / derived locally from the GIFs above |
| `assets/official-sprites/artwork/*.png` | 7 只宝可梦的立绘 / artwork images | 来源未在清单中记录，见 `assets/official-sprites/manifest.json` / origin not recorded, see the manifest |
| `assets/official-sprites-data.js` | 上述 GIF 的 Base64 内嵌数据（旧版离线包）/ Base64-embedded copies of the GIFs (legacy offline bundle) | 同上 / same as above |
| `assets/sprites/*.svg` | 以宝可梦为题材的矢量占位形象 / Pokémon-themed vector placeholders | 由代码绘制，但角色设计权利仍归原权利人 / drawn in code, but character designs remain the property of the rights holders |

`tools/build-allgen-pokemon-pack.mjs` 运行时会从 `play.pokemonshowdown.com`（精灵图与 `pokedex.json`）及 [PokeAPI/pokeapi](https://github.com/PokeAPI/pokeapi)（物种名 CSV）下载数据，生成**仅保存在本机**的私有皮肤包（`~/.gemini/antigravity/pet-packs/pokemon/`），这些下载内容不包含在仓库中。
At runtime, `tools/build-allgen-pokemon-pack.mjs` downloads sprites and `pokedex.json` from `play.pokemonshowdown.com` and species-name CSVs from PokeAPI/pokeapi to build a **local-only** private pack; that downloaded content is not part of this repository.

### 1.2 原创默认皮肤包 / Original default pack

`packs/critters/`（「像素小伙伴 / Pixel Critters」）完全由 `tools/build-critters-pack.mjs` 用代码绘制，不含任何第三方美术素材，以 **CC0 1.0** 贡献到公有领域，详见 `packs/critters/LICENSE`。
`packs/critters/` is drawn procedurally by `tools/build-critters-pack.mjs`, contains no third-party artwork, and is dedicated to the public domain under **CC0 1.0** (see `packs/critters/LICENSE`).

---

## 2. Antigravity

**中文**

- 「Antigravity」「Antigravity IDE」「Antigravity 2.0」是 **Google** 的产品名称与商标。本项目是**第三方工具**，与 Google 没有关联，**未获官方认可或支持**。
- 本项目的全局皮肤功能会**修改本机已安装的 Antigravity 客户端文件**（例如 `workbench*.html`、`product.json` 校验和、`app.asar`、`out/main.js`），可能导致客户端异常、校验警告或在升级后失效。脚本会创建 `.pokemon-backup` 备份并提供 `-RestoreGlobalSkin` 还原，但**使用风险由使用者自行承担**。

**English**

- "Antigravity", "Antigravity IDE" and "Antigravity 2.0" are product names and trademarks of **Google**. This is a **third-party tool**, not affiliated with or endorsed by Google.
- The global-skin feature **modifies files of your locally installed Antigravity client** (e.g. `workbench*.html`, checksums in `product.json`, `app.asar`, `out/main.js`). This may break the client, trigger integrity warnings or be undone by updates. Backups (`.pokemon-backup`) and a restore command (`-RestoreGlobalSkin`) are provided, but **you use it entirely at your own risk**.

---

## 3. 其他 / Other trademarks

Windows、PowerShell、WPF、VS Code、Microsoft Edge / WebView2 为 Microsoft 的商标；Node.js 为 OpenJS Foundation 的商标。提及它们仅用于说明兼容环境。
Windows, PowerShell, WPF, VS Code and Microsoft Edge / WebView2 are trademarks of Microsoft; Node.js is a trademark of the OpenJS Foundation. They are mentioned only to describe compatible environments.
