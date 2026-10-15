# 平台能力

“已实现”表示代码入口存在，设备验证状态单独列出。

| 能力 | Windows | macOS | Android | iOS |
| --- | --- | --- | --- | --- |
| 输入、粘贴、图片导入、多 API、流式翻译 | 已实现 | 已实现 | 共享实现 | 共享实现 |
| 本地 Tesseract OCR | 已实现 | 共享实现 | 共享实现 | 共享实现 |
| 全局快捷键、当前屏幕框选 | 已实现 | 已实现，需权限 | 未实现 | 未实现 |
| 后台入口与浮动面板 | 系统托盘 | 菜单栏 / Dock | 应用内面板 | 应用内面板 |
| API Key 保存 | 系统凭据库 | Keychain | 仅进程内存 | Keychain |
| 原生构建 | 已有本地 Release 基线 | 待验证 | 待验证 | 待验证 |
| 设备验证 | 已有启动、截图显示/取消、退出基线 | 待验证 | 待验证 | 待验证 |

Windows 与 macOS 的使用、构建说明分别见 [Windows](windows.md) 和 [macOS](macos.md)。Linux 尚未列为验收平台。

## 移动端开发

移动端当前使用应用内粘贴、手动输入和系统文件选择器导入截图。没有跨应用全局截图快捷键、悬浮窗、系统分享扩展或快捷指令集成。Android 密钥仅保存在进程内存，重启后需重新输入。

Android 需要 JDK、Android SDK/NDK 和对应 Rust target；设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` 后运行：

```sh
npm run tauri -- android init
npm run android
npm run tauri -- android build
```

iOS 需要 macOS、完整 Xcode、CocoaPods、对应 Rust target，以及设备安装所需的签名配置：

```sh
npm run tauri -- ios init
npm run ios
npm run tauri -- ios build
```

详细环境要求参见 [Tauri 移动开发前置条件](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets)。后续优先验证图片选择、剪贴板、OCR Worker、应用生命周期及密钥存储，再接入原生分享入口。
