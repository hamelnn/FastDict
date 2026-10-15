# Windows 桌面版

支持 Windows 10/11 x64。0.2.1 修复截图结束后侧栏弹出、其余屏幕仍显示白底的问题；最终便携 ZIP 已解压运行，重复完成截图、取消截图和退出均通过本轮 Windows 实测。NSIS 安装程序已生成，但尚未在用户系统执行安装。产物未签名。

## 0.2.1 截图白屏修复

截图完成或取消时，Windows 先退出全屏，再隐藏截图窗口；这些操作在原生界面线程依次执行。只有确认截图窗口已隐藏，才发送重置事件并清空截图预览，防止窗口仍可见时露出白色背景。重复就绪通知也不会再次显示同一截图会话。

38 项核心测试、19 项构建脚本测试和 42 项前端交互回归全部通过，包括延迟图片解码、重复交互及会话重置后的迟到回调。

本轮从最终 0.2.1 ZIP 解压后启动，连续执行两次 `Ctrl+Shift+S` → `Esc` 取消，以及两次拖选 20×20 纯色空白区域后松手完成。四次结束后截图窗口均不在可见窗口列表，原生可见性检查确认已隐藏，侧栏正常恢复且无白屏；`Ctrl+Alt+Q` 也成功退出。两次完成均在本机 OCR 后提示“未识别到文字”，未调用真实 API，已有配置和历史保持不变。

此结论限定于当前 Windows 显示器与缩放设置，不代表多显示器、其他 DPI 或截图到真实 API 的完整翻译验收。本次发行修复仅针对 Windows，其他平台保持 0.2.0。

## 使用

从 [0.2.1 GitHub Release](https://github.com/hamelnn/FastDict/releases/tag/v0.2.1) 下载 `FastDict_0.2.1_x64-setup.exe` 或 `FastDict-Windows-x64-0.2.1.zip`。便携版需解压后运行，并保持 `FastDict.exe` 与附带 DLL 在同一文件夹。若系统缺少 WebView2 Runtime，请从 [Microsoft 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

首次打开，在偏好设置添加翻译服务、API 地址、模型和密钥，再选择 OCR 与目标语言。

| 操作 | 入口 |
| --- | --- |
| 框选鼠标所在屏幕并翻译 | `Ctrl+Shift+S` |
| 翻译已复制的文字 | `Ctrl+Shift+D` |
| 翻译输入框内容 | `Ctrl+Enter` |
| 取消截图或翻译 | `Esc` |
| 隐藏侧栏，继续后台运行 | 界面内“最小化到托盘” |
| 完全退出 | 标题栏 X、托盘菜单、设置或 `Ctrl+Alt+Q` |

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

启动失败时可使用恢复界面的“重新加载”或“退出应用”。标题栏 X 和原生快捷键 `Ctrl+Alt+Q` 独立于网页界面；升级保留既有配置与密钥。

诊断日志位于 `%LOCALAPPDATA%\app.fastdict.translate\logs\startup.log`，仅记录固定启动与截图窗口状态，不记录截图、文本、服务地址或 API Key。日志达到 256 KiB 后轮转一次。

完整设备验收边界见 [验证范围](validation.md)，通用开发与测试见 [开发指南](development.md)。
