# iOS 与 Android

0.2.0 增加独立手机布局和原生移动接口，复用桌面的本地 OCR、翻译协议、多服务配置与历史记录。

## 使用

底部「翻译 / 记录 / 设置」切换页面。先在设置里配置 API，然后选择目标语言。

- 在其他 App 截图后，回到 FastDict 点「选取截图」。选择图片后自动识别并翻译；关闭自动翻译时只识别文字。
- 已复制的文字可以主动粘贴，避免等待 OCR。不会后台读取剪贴板。
- 译文支持复制和系统分享菜单。分享菜单打开不代表接收方已经收到内容。
- 系统选图期间会保留任务。主动切到后台会停止正在进行的 OCR / 翻译，保留已有文字；返回后可重新翻译。

没有接收其他 App 分享的扩展、跨应用浮窗或全局截图快捷键。当前导入整张图片，不提供手机内裁剪。

## 本地数据

iOS 使用 Keychain 保存密钥。Android 使用 Keystore 的 AES-GCM 密钥加密 API Key，密文置于应用的非备份目录，按服务分别保存。配置和历史保存在本机；截图只在本机识别，识别后的文字发送给所选 API。

系统选图只访问用户明确选择的图片。原生层限制输入文件 20 MiB、解码像素 8000 万，修正图片方向，并将长边限制到 4096 像素。OCR 首次使用按需加载，手机启动不预热模型。

## Android 构建

运行最低 Android 7 / API 24。开发需要 Node.js 22.12+、Rust 1.90+、JDK 17+（CI 使用 21）、SDK Platforms 36 和 37.0、Build-Tools 37 和 NDK（CI 使用 28.2.13676358）。编译 SDK 与手机最低版本不同。

安装相应工具后设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`，准备 `aarch64-linux-android` Rust target：

```sh
npm ci
npm run android:check
npm run android:init
npm run android:build
```

`npm run android` 用于原生开发。构建默认为 ARM64 debug APK，输出 `release/android/`，同时校验包名、版本、架构和签名并生成 SHA-256 清单。模拟器可按其架构传 `-- --target=x86_64`。初始化不会覆盖已有原生工程，脚本不会自行安装 SDK。

GitHub Actions 可手动运行 **Build Android test APK**。下载该次运行的产物，解压后安装 `.apk`。Debug 签名仅供测试；不同构建环境的签名可能不同，可能无法直接覆盖安装。正式商店分发需要固定发行密钥。

## iOS 构建

运行最低 iOS 15。需要 Mac、完整 Xcode 与 iOS Simulator runtime、CocoaPods、Node.js 和 Rust。Apple Silicon 安装 `aarch64-apple-ios-sim` Rust target，Intel 安装 `x86_64-apple-ios`。

```sh
npm ci
npm run ios:check
npm run ios:init
npm run ios:build
```

默认生成与当前 Mac 架构对应的无签名模拟器应用，输出 `release/ios/*.app.zip` 与校验清单。解压后将 `.app` 拖入已启动的 iOS Simulator。也可手动运行 **Build iOS simulator app** 工作流下载产物。

模拟器包不能安装到 iPhone / iPad。真机安装需在生成的 Xcode 工程里配置自己的 Apple Team 与签名；TestFlight / App Store 另需发行配置。当前工作流不上传商店。

## 验证边界

手机 UI 与流程测试使用模拟原生接口、真实本地 Tesseract OCR 和模拟 API 响应。原生构建通过也不等于已经验证相册、分享、Keychain / Keystore 与真实设备性能。最新执行记录见 [验证范围](validation.md)。

2026-10-15 已生成 0.2.0 的 Android ARM64 debug APK 和 Apple Silicon iOS Simulator `.app.zip`。iOS 已在 iPhone 17 Pro / iOS 26.5 模拟器安装启动并检查画面。两端真机功能尚未验收。
