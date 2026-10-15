# FastLingo

按下快捷键，框选文字，立即开始翻译。FastLingo 使用本地 OCR 识别截图，通过你配置的大模型 API 或桌面端 ChatGPT 订阅返回流式译文。

React + TypeScript 界面，Tauri 2 原生外壳，复用系统 WebView。

当前已发布的 Windows 版本为 [FastLingo 0.3.1](https://github.com/hamelnn/FastDict/releases/tag/v0.3.1)。本仓库 **0.4.0 源码正在验证，尚未发布**，已改用官方 [Sign in with ChatGPT](docs/chatgpt.md)，不再依赖本机 Codex。0.3.1 安装包仍使用旧的 Codex 接入方式。macOS、Android 和 iOS 模拟器现有二进制仍为 [FastDict 0.2.0](https://github.com/hamelnn/FastDict/releases/tag/v0.2.0)；iPhone 真机安装需要另行配置 Apple 签名。

0.3.0 将应用更名为 **FastLingo**，首次启动不预置翻译服务，由用户自行添加。桌面偏好可选择关闭后直接退出或留在托盘，并支持开机启动；默认直接退出、开机不自启。更名沿用原有应用标识、数据目录和存储键，兼容已有服务、历史和密钥。

0.4.0 在 Windows / macOS 中提供“ChatGPT 订阅”入口：在系统浏览器为 FastLingo 单独登录授权，无需安装 Codex 或提供 API Key。默认模型仍为 `gpt-6-luna`，以所选账号的实时模型目录为准。已有 Codex 服务配置保留，但需要重新授权；不会自动复用 Codex 的登录。旧版使用方式见 [0.3.1 历史说明](docs/codex.md)。

## 功能

- **截图翻译**：桌面直接框选鼠标所在屏幕，松开即识别并翻译。
- **文字翻译**：读取剪贴板、手动输入，或导入已有截图。
- **自行配置 API**：首次启动从空服务列表开始，点击“添加翻译服务”配置。
- **桌面行为**：关闭后退出或留在托盘可选，开机启动默认关闭。
- **多 API 配置**：支持 OpenAI 兼容、Anthropic 和 Gemini 协议，侧栏切换服务。
- **桌面订阅翻译（0.4.0 源码）**：通过官方 ChatGPT 登录授权，选择已有账号或添加账号，支持流式译文、取消、断开连接和管理用量。
- **本地 OCR**：内置英文、简体中文、繁体中文、日文、韩文模型，复用识别 Worker。
- **流式结果**：边生成边显示，支持取消、复制与本地历史。
- **手机界面**：底部翻译 / 记录 / 设置导航，系统选图、主动粘贴与译文分享。

## 平台状态

| 平台 | 当前状态 | 使用与构建 |
| --- | --- | --- |
| Windows x64 | 已发布 0.3.1 便携包订阅翻译、取消与关闭退出实测通过；0.4.0 官方登录正在验证 | [Windows 说明](docs/windows.md) |
| macOS | 已发布 0.2.0 通用 DMG 和应用 ZIP 已校验；0.4.0 源码含官方登录，真机流程待验收 | [macOS 说明](docs/macos.md) |
| iOS | 0.2.0 模拟器编译、安装启动与画面检查通过；真机签名及功能待验收 | [移动端说明](docs/mobile.md) |
| Android ARM64 | 0.2.0 debug APK 已生成并校验，设备功能待验收 | [移动端说明](docs/mobile.md) |

仓库提供源码；`release/` 为本地构建输出，不随源码提交。完整截图到真实 API 的桌面流程仍需设备验收，详见 [验证范围](docs/validation.md)。

0.4.0 当前已通过 166 项自动化测试：54 项核心、19 项构建脚本、60 项前端交互和 33 项原生测试。Windows 安装包和便携包已生成，真实 OAuth 授权及订阅翻译仍待验收。0.3.1 的真实 Codex 翻译是历史记录，不能替代新接入的验证。各版本结果见 [验证范围](docs/validation.md)。

## 桌面用法

1. 打开应用，添加 API 地址、模型和密钥；使用 0.4.0 源码构建时，也可选择“ChatGPT 订阅”，点击“Continue with ChatGPT”在浏览器登录授权。
2. 选择 OCR 语言与翻译目标语言。
3. 按截图快捷键并拖动选区，松开后在侧栏查看译文。

| 操作 | Windows | macOS |
| --- | --- | --- |
| 截图翻译 | `Ctrl+Shift+S` | `⌥⌘S` |
| 翻译已复制的文字 | `Ctrl+Shift+D` | `⌥⌘V` |
| 取消截图或翻译 | `Esc` | `Esc` |
| 完全退出 | 标题栏 X（退出模式）/ `Ctrl+Alt+Q` | `⌘Q` / 全局 `⌥⌘Q` |

macOS 首次截图需要屏幕录制权限。Windows 0.3.0 关闭按钮默认直接退出，可在偏好设置改为留在托盘；macOS 现有 0.2.0 二进制仍按原行为隐藏到菜单栏。

## 手机用法

1. 在设置中添加 API 服务，选择目标语言。
2. 使用手机系统截图，然后打开 FastLingo，点击「选取截图」。选定图片后自动识别并翻译。
3. 也可点击「粘贴文本」跳过 OCR；译文可复制或通过系统菜单分享。

移动端使用手机自身截图操作，没有跨应用全局截图快捷键。最低 Android 7 / iOS 15；构建与安装见 [移动端说明](docs/mobile.md)。

## 本地开发

需要 Node.js 22.12+。原生开发另需 Rust 1.90+ 和对应平台工具链。

```sh
npm ci
npm run dev
```

`dev` 启动浏览器预览；`npm run desktop` 启动原生桌面应用。首次准备 OCR 资源需要联网，打包后识别无需联网。构建、测试和项目结构见 [开发指南](docs/development.md)。

## 数据与密钥

截图在本机识别，**识别后的文字会发送到所选翻译服务**。配置和翻译历史保存在设备本地，历史可在应用内清空。

API Key 不写入配置或历史：Windows 使用系统凭据库，macOS/iOS 使用 Keychain，Android 使用 Keystore 加密保存；浏览器预览仅保存在会话内存，刷新后需重新输入。浏览器请求受服务商 CORS 设置限制，原生版使用原生网络请求。

0.4.0 的 ChatGPT 连接由原生端独立管理：OAuth 凭据加密保存在本机，加密密钥保存在系统凭据库；令牌不交给网页界面、不写入翻译历史，也不读取 Codex 凭据。翻译调用公开 Responses API，使用 `store: false`、`stream: true`；这不表示离线处理。符合条件的请求使用你的 ChatGPT 套餐或积分，可在应用中“管理用量”或“断开连接”。详见 [ChatGPT 登录说明](docs/chatgpt.md)。

[架构与性能](docs/architecture.md) · [验证范围](docs/validation.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
