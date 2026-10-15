# 验证范围

以下按版本记录 2026-10-15 已完成的验证基线。Windows 0.2.1 包含本轮实际窗口操作验收，0.1.1 的历史记录另行保留；源码重构、原生接口模拟与设备实测分别说明。最新自动化结果应以实际运行输出为准。

## 0.2.1 Windows 截图白屏修复

- 针对截图完成后侧栏出现、其余屏幕仍被白色截图窗口遮挡的反馈，已调整 Windows 原生收尾顺序：先退出全屏，再隐藏窗口，确认隐藏成功后才发送 `capture-reset` 清空预览。重复 `capture_ready` 不再重新显示已就绪的同一会话。
- 自动化验证：38 项核心测试、19 项构建脚本测试和 42 项完整前端交互回归通过。`npm run test:e2e` 耗时约 1.1 分钟；其中截图前端的 8 项定向测试也通过。
- Windows GNU `cargo test`：1 项截图 PNG 单元测试通过。本机测试可执行文件需在忽略的 `target` 目录中补临时 Common Controls v6 manifest 后运行；正式 Release 可执行文件已有 manifest，未因此修改。
- 新增 3 项时序回归：reset 后迟到的图片解码不发送旧 ready；重复开始、拖选和提交只发送一次 ready；reset 后迟到的完成或取消回调不恢复旧截图界面。
- **Windows 便携包实测通过**：从最终 `FastDict-Windows-x64-0.2.1.zip` 解压运行，进程路径为 `release/smoke-0.2.1/fastdict.exe`，实际 ProductVersion 为 `0.2.1`；可执行文件 SHA-256 为 `7e0a1cc88558276137e65a770e9369ef97023b9f72b2f36c18f2905df396ecd2`。
- 实际操作：`Ctrl+Shift+S` → `Esc` 取消两次；拖选 20×20 纯色空白选区后松手完成两次。四次均确认截图窗口不在可见窗口列表，原生 `is_visible=false` 并记录 `capture-overlay-hidden`；侧栏正常恢复，无残留白屏。最后 `Ctrl+Alt+Q` 成功退出。
- 两次完成均实际执行本地 OCR 并显示“未识别到文字”，原文为 0 字符，没有调用真实 API；原有 3 条历史记录及设置保持不变。
- 本轮设备验收仅覆盖当前 Windows 显示器与缩放设置，不代表多屏、其他 DPI 或截图到真实服务商的完整翻译。NSIS 安装程序未执行安装。
- 本轮 Windows 修复版本为 0.2.1；macOS、iOS 和 Android 的已发布构建及验证结论仍为 0.2.0。

## 0.2.0 移动端验证

- `npm run check`：38 项核心测试、19 项构建脚本测试、TypeScript 与生产构建通过。
- `npm run test:e2e`：39 项完整交互测试通过，新增两端选图、取消选图、真实 OCR、粘贴、流式结果、分享、后台停止与恢复界面检查。
- Windows GNU `cargo check --release` 通过；0.2.0 的 [完整 CI](https://github.com/hamelnn/FastDict/actions/runs/38691193513) 已成功完成前端检查，以及 Windows / macOS 原生检查、测试与编译。
- [Android ARM64 优化构建](https://github.com/hamelnn/FastDict/actions/runs/38691196346) 已通过，生成 `FastDict-Android-0.2.0-arm64-v8a-debug.apk`，包名、版本、架构、debug 标识及 APK v2 签名验证通过。APK 为 29,371,560 字节，SHA-256 为 `fc7b863d178401935f96d03767747409a612bab08acbe93e4a81e4c774b8f143`。尚未设备安装验收。
- 安卓包从 194,063,104 字节缩小约 85%。已直接检查最终 ELF：原生库为 22,055,936 字节，`.debug_*` 与 `.symtab` 已移除，动态符号表仍存在。构建清单记录 `optimized-dev` 及优化选项。
- Windows 0.2.0 已生成 NSIS 安装程序与便携 ZIP，实际版本资源、依赖及输出哈希已核对；安装程序尚未在用户系统执行安装。
- [macOS 通用包构建](https://github.com/hamelnn/FastDict/actions/runs/38749467816) 已生成 `.app.zip` 与 `.dmg`，通过 arm64 / x86_64 双架构、ad-hoc 签名及 DMG 完整性检查，尚未执行真机操作验收。
- [iOS 模拟器构建与启动](https://github.com/hamelnn/FastDict/actions/runs/38689728876) 已通过：Swift / Rust 编译、平台与架构检查、应用包导出，以及 iPhone 17 Pro / iOS 26.5 模拟器安装启动。已人工检查 1206 × 2622 原始截图，主界面和底部导航正常显示；顶部有系统首次启动通知。该包不能安装到 iPhone。
- Android 手机预览使用模拟原生接口，已检查布局；iOS / Android 均没有真机测试结论。
- 0.1.2 的 [GitHub CI](https://github.com/hamelnn/FastDict/actions/runs/38687373078) 已完成 macOS 原生检查、测试与编译；不包含通用安装包打包或设备操作。

## 0.1.2 优化验证

- `npm run check`：38 项核心测试、9 项构建脚本测试、TypeScript 与生产构建通过。
- `npm run test:e2e`：29 项完整交互测试通过，包含真实本地 OCR、流式翻译、Mac 接口模拟和白屏恢复。
- `npm run windows:build`：Windows x64 Release 与便携 ZIP 构建成功；本轮未重新执行真实桌面截图到 API 的完整验收。
- OCR 资源准备在断网条件下复用 11 个已有资源，内容未变化时不改写文件。

首轮开发环境测试曾因模块响应超过 15 秒触发启动保护；停止并行原生编译后完整复测通过。生产资源启动和恢复测试通过。Mac 故障注入测试已兼容开发服务器的热更新查询参数。

## 已有基线

| 范围 | 已覆盖内容 |
| --- | --- |
| 前端构建 | 严格 TypeScript 检查、Vite 生产构建 |
| 核心逻辑 | 三种 API 协议、UTF-8 / SSE 分片、取消、异常脱敏、存储保护、OCR Worker 复用与调度、平台识别 |
| 浏览器端到端 | 流式首字、历史与配置、真实本地 WASM OCR、图片裁剪、手机布局 |
| 生产资源启动 | 存储拒绝 / 配额不足、坏配置保留、模块失败、React 异常、重试与退出、生产 CSP 下 OCR |
| 原生接口模拟 | 截图会话握手、单次提交、125% 缩放边界、取消竞争；Mac 权限引导、菜单导航、剪贴板与退出 |
| Windows 原生（0.1.1） | Release 构建、实际启动、主界面与截图窗口就绪、快捷键显示框选层、Esc 取消、标题栏 X 与原生快捷键退出 |
| Windows 原生（0.2.1） | 最终便携 ZIP 解压启动，完成与取消截图各两次，原生窗口隐藏及侧栏恢复，空白区域本地 OCR，配置与历史保留，原生快捷键退出 |
| Mac 构建脚本 | 拒绝不完整通用架构、缺失工具链和 Windows 构建；配置、权限 plist 校验 |

测试命令见 [开发指南](development.md)。

## 模拟与设备测试的边界

OCR 测试运行实际打包的 Worker、WASM 和语言模型。翻译测试使用本机 HTTP/SSE 服务，没有调用真实付费 API；测试速度不能代表云端服务延迟或翻译质量。

原生接口测试模拟 Tauri 命令与事件，不能替代操作系统截图、窗口可见性、权限、全局快捷键或菜单行为。截图 DOM 被清空不代表原生截图窗口已隐藏，需另行验证窗口完成或取消后的可见性。Mac 界面预览也使用模拟接口。

Windows 曾收到白屏且无法退出的反馈，重启后未复现当时故障，因此尚不能确定原始根因。0.1.1 已加入独立启动恢复界面、存储保护、原生退出、就绪超时和 WebView2 故障监测，并验证实际退出；没有通过清空用户数据规避问题。

## 待验收

- **Windows 0.2.1**：NSIS 安装程序执行安装，真实快捷键 → 框选 → OCR → API → 侧栏的完整翻译流程，以及多显示器和不同缩放比例。
- **macOS**：真机安装启动、首次授权、多屏、Retina、Spaces、Dock、Keychain 及真实翻译。
- **Android**：设备安装、选图、剪贴板、分享、Keystore、OCR 与生命周期。
- **iOS**：模拟器与设备上的选图、剪贴板、分享、Keychain、OCR 与生命周期；现有模拟器验收只覆盖安装启动与画面。
- **所有平台**：真实服务商联调、冷启动与热态性能基准、正式签名和发行流程。

构建产物不随源码提交；原生 CI 编译、安装包校验与设备功能验收分别记录。
