# FastDict · 轻译

按下快捷键，框选文字，立即开始翻译。FastDict 使用本地 OCR 识别截图，通过你配置的大模型 API 返回流式译文。

React + TypeScript 界面，Tauri 2 原生外壳，复用系统 WebView。

各平台构建产物集中在 [FastDict 0.2.0 下载页](https://github.com/hamelnn/FastDict/releases/tag/v0.2.0)。包含 Windows、macOS、Android 和 iOS 模拟器版本，以及安装说明和 SHA-256 校验清单；iPhone 真机安装需要另行配置 Apple 签名。

## 功能

- **截图翻译**：桌面直接框选鼠标所在屏幕，松开即识别并翻译。
- **文字翻译**：读取剪贴板、手动输入，或导入已有截图。
- **多 API 配置**：支持 OpenAI 兼容、Anthropic 和 Gemini 协议，侧栏切换服务。
- **本地 OCR**：内置英文、简体中文、繁体中文、日文、韩文模型，复用识别 Worker。
- **流式结果**：边生成边显示，支持取消、复制与本地历史。
- **手机界面**：底部翻译 / 记录 / 设置导航，系统选图、主动粘贴与译文分享。

## 平台状态

| 平台 | 当前状态 | 使用与构建 |
| --- | --- | --- |
| Windows x64 | 已生成 0.2.0 安装程序和便携 ZIP，安装流程待设备验收 | [Windows 说明](docs/windows.md) |
| macOS | 已生成并校验 Apple Silicon / Intel 通用 DMG 和应用 ZIP，真机流程待验收 | [macOS 说明](docs/macos.md) |
| iOS | 模拟器编译、安装启动与画面检查通过；真机签名及功能待验收 | [移动端说明](docs/mobile.md) |
| Android ARM64 | 已生成并校验 debug APK，设备功能待验收 | [移动端说明](docs/mobile.md) |

仓库提供源码；`release/` 为本地构建输出，不随源码提交。完整截图到真实 API 的桌面流程仍需设备验收，详见 [验证范围](docs/validation.md)。

## 桌面用法

1. 打开应用，在偏好设置中添加 API 地址、模型和密钥。
2. 选择 OCR 语言与翻译目标语言。
3. 按截图快捷键并拖动选区，松开后在侧栏查看译文。

| 操作 | Windows | macOS |
| --- | --- | --- |
| 截图翻译 | `Ctrl+Shift+S` | `⌥⌘S` |
| 翻译已复制的文字 | `Ctrl+Shift+D` | `⌥⌘V` |
| 取消截图或翻译 | `Esc` | `Esc` |
| 完全退出 | 标题栏 X / `Ctrl+Alt+Q` | `⌘Q` / 全局 `⌥⌘Q` |

macOS 首次截图需要屏幕录制权限。Windows 的关闭按钮退出应用；macOS 的关闭按钮隐藏到菜单栏。

## 手机用法

1. 在设置中添加 API 服务，选择目标语言。
2. 使用手机系统截图，然后打开 FastDict，点击「选取截图」。选定图片后自动识别并翻译。
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

截图在本机识别，**识别后的文字会发送到所选 API 服务**。配置和翻译历史保存在设备本地，历史可在应用内清空。

API Key 不写入配置或历史：Windows 使用系统凭据库，macOS/iOS 使用 Keychain，Android 使用 Keystore 加密保存；浏览器预览仅保存在会话内存，刷新后需重新输入。浏览器请求受服务商 CORS 设置限制，原生版使用原生网络请求。

[架构与性能](docs/architecture.md) · [验证范围](docs/validation.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
