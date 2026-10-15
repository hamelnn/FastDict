# macOS 版

已实现菜单栏、Mac 快捷键、权限引导、Keychain 和 Apple Silicon / Intel 通用包构建流程。0.1.2 已通过 GitHub macOS 原生检查、测试与编译；尚未生成通用 `.app` / `.dmg` 或完成真机操作验收。

## 使用

首次打开，在偏好设置添加翻译服务、API 地址、模型和密钥。

| 操作 | 入口 |
| --- | --- |
| 截图翻译 | `⌥⌘S`，拖动选区后松开 |
| 翻译已复制的文字 | `⌥⌘V` |
| 翻译输入框内容 | `⌘Enter` |
| 取消截图或翻译 | `Esc` |
| 隐藏主窗口，继续运行 | 红色关闭按钮、“隐藏到菜单栏” |
| 重新打开 | 菜单栏图标、Dock 图标 |
| 偏好设置 | 应用菜单或 `⌘,` |
| 完全退出 | `⌘Q`、菜单栏“退出”或全局 `⌥⌘Q` |

首次截图需要屏幕录制权限。应用显示引导，由用户主动请求授权；授权后可能需要完全退出再打开。截图与 OCR 在本机完成，识别文字发送到所选 API，密钥保存到 Keychain。

## 在 Mac 上构建

要求 macOS 12+、Node.js 22.12+、Rust 1.90+ 和 Xcode Command Line Tools 或 Xcode macOS SDK。详见 [Tauri 前置要求](https://v2.tauri.app/start/prerequisites/#macos)。

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm run macos:build
```

也可在工具链就绪后运行 `scripts/FastDict-macOS-build.command`。默认输出至 `release/macos/`：

- `.app.zip`：保留执行权限的应用包。
- `.dmg`：拖入“应用程序”安装。
- `manifest-<target>.json`：实际架构、签名类型、文件大小与 SHA-256。
- 使用说明及第三方声明。

脚本在构建前检查 SDK 与 Rust target，导出前检查实际架构、签名和 DMG 完整性。Windows 主机不能构建 Mac 应用。仅构建一种架构时可运行：

```sh
npm run macos:build -- --target=aarch64-apple-darwin
# Intel Mac
npm run macos:build -- --target=x86_64-apple-darwin
```

## GitHub Actions 与签名

可在仓库 Actions 中手动运行 **Build macOS universal app**，下载该次运行的构建产物。工作流不会发布 Release，当前尚未远程执行。

默认使用 ad-hoc 签名，不代表 Apple 认证发行或已公证。已有 Developer ID 时，可通过 `APPLE_SIGNING_IDENTITY` 指定签名身份；正式发行还需完成公证。参见 [Tauri 签名说明](https://v2.tauri.app/distribute/sign/macos/)。

## 待真机验收

系统截图工具以非交互整屏模式捕获，再由应用框选；私有临时截图读取后清理。多屏映射、子进程屏幕录制授权、Retina、Spaces、Dock、Keychain、快捷键冲突和真实 API 翻译均需在 Mac 上验收。模拟界面与构建脚本测试的边界见 [验证范围](validation.md)。
