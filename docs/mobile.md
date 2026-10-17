# iOS 与 Android

0.5.0 新增随系统变化的纯白 / 纯黑主题及可编辑翻译提示词。设置首页保留常用选项，OCR、预热和选图说明在“高级设置”；手机仍使用 API 翻译。本次准备发布 Android ARM64 debug APK 与 iOS ARM64 / Intel 模拟器 ZIP，见 [0.5.0 下载页](https://github.com/hamelnn/FastDict/releases/tag/v0.5.0)，以实际附件与构建记录为准。本节以下的 0.2.0 发布验收记录不代表新版本真机复测。

0.2.0 增加独立手机布局和原生移动接口，复用桌面的本地 OCR、翻译协议、多服务配置与历史记录。

## 使用

底部「翻译 / 记录 / 设置」切换页面。先在设置里配置 API，然后选择目标语言。

- 在其他 App 截图后，回到 FastLingo 点「选取截图」。选择图片后自动识别并翻译；关闭自动翻译时只识别文字。
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

`npm run android` 用于原生开发，由 Tauri 选择设备；`npm run android -- --open` 打开 Android Studio，保持终端进程运行。交互调试支持设备名称及 `--host` 等 Tauri 参数，不再接受会被忽略的 `--target`。构建默认为 ARM64 debug APK，输出 `release/android/`，同时校验包名、版本、架构和签名并生成 SHA-256 清单。为模拟器打包时可用 `npm run android:build -- --target=x86_64`。初始化不会覆盖已有原生工程，脚本不会自行安装 SDK。

`android:build` 保留 Android debug 签名，同时仅在打包子进程中将 Rust dev profile 设为 `debug=0`、`strip=symbols`、`opt-level=s`，减小原生库体积；清单记为 `rustProfile: optimized-dev`。`npm run android` 的交互调试与 iOS / 桌面构建不受此设置影响。

GitHub Actions 的 **Build Android test APK** 在移动相关源码、原生配置、构建脚本或锁文件变更时自动编译；手动运行才上传测试包。下载该次手动运行的产物，解压后安装 `.apk`。构建使用 `--locked`。Debug 签名仅供测试；不同构建环境的签名可能不同，可能无法直接覆盖安装。正式商店分发需要固定发行密钥。

## iOS 构建

运行最低 iOS 15。需要 Mac、完整 Xcode 与相应 iOS SDK、CocoaPods、Node.js 和 Rust。编译模拟器应用时，Apple Silicon 安装 `aarch64-apple-ios-sim` Rust target，Intel 安装 `x86_64-apple-ios`；启动模拟器还需安装 Simulator runtime。初始化工程和编译不再强制要求可启动的模拟器 runtime。

```sh
npm ci
npm run ios:check
npm run ios:init
npm run ios:build
```

默认生成与当前 Mac 架构对应的无签名模拟器应用，输出 `release/ios/*.app.zip` 与校验清单。导出会先核对包名、版本、模拟器平台与架构，再检查候选是否唯一，因此同一工作区可保留 ARM64 和 Intel 两种输出。构建使用 `--locked`。解压后将 `.app` 拖入已启动的 iOS Simulator。

交互调试使用 `npm run ios`，由 Tauri 选择模拟器或连接的 iPhone。首次执行 `npm run ios:init` 后，可用以下方式打开 Xcode；保持终端运行，在 Xcode 选择设备、自己的签名 Team 与自动签名，再运行应用：

```sh
# 真机编译目标；只需安装一次
rustup target add aarch64-apple-ios
npm run ios:check -- --target=aarch64
npm run ios -- --open
```

`npm run ios -- --open` 支持官方设备与网络选项（例如 `--host`），不要求先安装无关的模拟器架构。`ios:build` 仍仅导出模拟器包，不生成已签名的真机 IPA。以上入口已通过脚本测试，新的 Xcode 调试路径尚未在 Mac / iPhone 验收。

**Build iOS simulator app** 在移动相关变更时自动编译，连续构建两种模拟器架构；手动运行还会启动当前主机架构的临时模拟器并上传产物。脚本夹具覆盖双架构残留、同架构重复、旧版本、损坏 plist 和真机包；Windows 上通过这些夹具不代表已在 Xcode 执行构建或完成设备验收。

模拟器包不能安装到 iPhone / iPad。真机安装需在生成的 Xcode 工程里配置自己的 Apple Team 与签名；TestFlight / App Store 另需发行配置。当前工作流不上传商店。

## 验证边界

手机 UI 与流程测试使用模拟原生接口、真实本地 Tesseract OCR 和模拟 API 响应。原生构建通过也不等于已经验证相册、分享、Keychain / Keystore 与真实设备性能。最新执行记录见 [验证范围](validation.md)。

2026-10-15 已生成 0.2.0 的 Android ARM64 debug APK（约 29.4 MB）和 Apple Silicon iOS Simulator `.app.zip`（约 34.8 MB）。安卓包已完成签名、架构、文件校验与调试符号剥离检查。iOS 已在 iPhone 17 Pro / iOS 26.5 模拟器安装启动并检查画面。两端真机功能尚未验收。
