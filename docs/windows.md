# FastLingo · Windows 桌面版

0.3.0 新增：首次启动无翻译服务，点击“添加翻译服务”自行配置；已有配置继续保留。偏好设置可选择关闭主窗口时直接退出或留在托盘，默认直接退出；开机启动默认关闭，仅在用户主动开启后设置。应用已更名 FastLingo，沿用原有应用标识、本地数据目录、存储键和凭据服务。

支持 Windows 10/11 x64。0.3.0 便携包已实际运行并验证关闭行为；NSIS 安装程序已构建，尚未执行安装或覆盖升级实测。产物未签名。

## 0.3.0 验证状态

121 项自动化测试通过：41 项核心、19 项构建脚本、52 项端到端交互、9 项 Rust 测试；TypeScript、Vite 生产构建及 Windows 原生检查通过。

最终便携包实测：默认退出模式下点击标题栏 X，窗口和进程均消失；改为托盘模式后 X 隐藏窗口，同一进程继续运行，再打开恢复同一实例。重启后托盘偏好保留，`Ctrl+Alt+Q` 能完全退出。测试结束恢复直接退出、自启关闭，再次点击标题栏 X，确认 FastLingo 进程数为 0、可见窗口列表为空。

系统自启保持关闭，本轮没有修改 OS 启动项；其实际启用与登录启动仍待验收。0.3.0 未重新手动实测截图完成与取消，也未调用真实 API。详细边界见 [验证范围](validation.md)。

## 0.2.1 截图白屏修复

截图完成或取消时，Windows 先退出全屏，再隐藏截图窗口；这些操作在原生界面线程依次执行。只有确认截图窗口已隐藏，才发送重置事件并清空截图预览，防止窗口仍可见时露出白色背景。重复就绪通知也不会再次显示同一截图会话。

0.2.1 发布时曾从最终 ZIP 实测取消截图两次、完成纯色空白截图两次，均确认原生窗口已隐藏、侧栏恢复且无白屏。该记录只覆盖当时的显示器与缩放设置；0.3.0 保留此修复与自动化回归，但未重新执行这些手动截图操作。其他平台现有二进制仍为 0.2.0。

## 使用

从 [0.3.0 GitHub Release](https://github.com/hamelnn/FastDict/releases/tag/v0.3.0) 下载 `FastLingo_0.3.0_x64-setup.exe` 或 `FastLingo-Windows-x64-0.3.0.zip`。便携版需解压后运行，并保持 `FastLingo.exe` 与附带 DLL 在同一文件夹。若系统缺少 WebView2 Runtime，请从 [Microsoft 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

首次打开，在偏好设置添加翻译服务、API 地址、模型和密钥，再选择 OCR 与目标语言。

| 操作 | 入口 |
| --- | --- |
| 框选鼠标所在屏幕并翻译 | `Ctrl+Shift+S` |
| 翻译已复制的文字 | `Ctrl+Shift+D` |
| 翻译输入框内容 | `Ctrl+Enter` |
| 取消截图或翻译 | `Esc` |
| 隐藏侧栏，继续后台运行 | 界面内“最小化到托盘” |
| 完全退出 | 标题栏 X（退出模式）、托盘菜单、设置或 `Ctrl+Alt+Q` |

拖动选区后松开鼠标即开始本地 OCR，并在侧栏显示流式译文。截图始终自动翻译；“粘贴与导入后自动翻译”仅控制另外两种入口。OCR 资源随应用打包，API Key 保存到 Windows 凭据库。

## 从源码构建

准备 Node.js 22.12+、Rust 1.90+ 和 Visual Studio C++ Build Tools 的桌面开发组件，或 Rust GNU target 与 MinGW64。详见 [Tauri 前置要求](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run windows:build
# 同时生成当前用户安装程序
npm run windows:installer
```

脚本默认使用 MSVC；存在项目内 `.build-tools` 工具链时使用 GNU。也可指定已安装的目标：

```sh
npm run windows:build -- --target=x86_64-pc-windows-msvc
npm run windows:build -- --target=x86_64-pc-windows-gnu
```

输出位于 `release/`：可执行文件、运行库、ZIP、可选安装程序和包含 SHA-256 的 `manifest.json`。NSIS 工具缓存在项目的 `src-tauri/target/.tauri` 内。也可手动运行 **Build Windows installer and portable app** 工作流，在 Windows runner 上使用 MSVC 打包。二进制通过 GitHub Release 分发，不提交到源码目录。

## 启动异常

启动失败时可使用恢复界面的“重新加载”或“退出应用”。标题栏 X 遵循关闭偏好；原生快捷键 `Ctrl+Alt+Q` 独立于网页界面，可完全退出。更名沿用既有数据目录和凭据标识，安装器覆盖升级尚未实测。

诊断日志位于 `%LOCALAPPDATA%\app.fastdict.translate\logs\startup.log`，仅记录固定启动与截图窗口状态，不记录截图、文本、服务地址或 API Key。日志达到 256 KiB 后轮转一次。

完整设备验收边界见 [验证范围](validation.md)，通用开发与测试见 [开发指南](development.md)。
