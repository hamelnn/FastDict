# FastLingo · Windows 桌面版

## 0.4.0 预发布：官方 ChatGPT 登录

0.4.0 预发布版改用官方 [Sign in with ChatGPT](chatgpt.md)。添加“ChatGPT 订阅”服务后，点击 **Continue with ChatGPT**，在系统浏览器为 FastLingo 登录授权，再从账号模型目录选择模型并保存。默认 `gpt-6-luna`，以当前账号实际可用目录为准。

不再要求安装 Codex，也不读取 Codex 登录凭据。旧版 Codex 服务配置保留，但须为 FastLingo 重新授权。翻译通过公开 Responses API 流式显示；支持取消、选择已保存账号、断开连接和管理用量。API 服务继续使用自己的地址、模型和密钥。

已通过 178 项自动化测试：54 项核心、19 项构建脚本、60 项前端交互和 45 项原生测试；TypeScript、Vite 与 Windows 原生正式构建通过。用户已完成真实官方授权，账号目录提供 GPT-6 Luna。从最终便携 ZIP 解压的应用已完成真实翻译，在 20,440 字符的合成原文请求进行中按 Esc 取消，随后再次翻译成功；取消没有新增历史或迟到结果。安装 / 覆盖升级、真实账号切换与远程撤销仍未验收。最终文件哈希和完整边界见 [验证范围](validation.md)。

## 已发布的 0.3.1

0.3.1 使用[本机 Codex（GPT 订阅）](codex.md)：本机 Codex 通过 ChatGPT 登录后，在添加服务时选择该入口，检测连接并保存，默认模型为 `gpt-6-luna`。该版本修复了将 Codex 非致命配置警告误判为工具调用的问题；当时的真实订阅中英翻译和取消已通过原生测试。

0.3.1 共 150 项自动化测试通过。最终便携包已在界面中完成真实 GPT-6 Luna 翻译、Esc 取消和关闭窗口退出，实际进程路径与 ZIP 中可执行文件哈希均已核对；未重新实测托盘、截图与系统自启。

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

从 [0.4.0 预发布下载页](https://github.com/hamelnn/FastDict/releases/tag/v0.4.0) 下载 [FastLingo_0.4.0_x64-setup.exe](https://github.com/hamelnn/FastDict/releases/download/v0.4.0/FastLingo_0.4.0_x64-setup.exe) 或 [FastLingo-Windows-x64-0.4.0.zip](https://github.com/hamelnn/FastDict/releases/download/v0.4.0/FastLingo-Windows-x64-0.4.0.zip)。便携版需解压后运行，并保持 `FastLingo.exe` 与附带 DLL 在同一文件夹。若系统缺少 WebView2 Runtime，请从 [Microsoft 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

首次打开没有预设服务。在偏好设置添加 API 地址、模型和密钥，或选择“ChatGPT 订阅”并在浏览器为 FastLingo 单独授权，再选择 OCR 与目标语言。配置见 [ChatGPT 登录说明](chatgpt.md)。

| 操作 | 入口 |
| --- | --- |
| 框选鼠标所在屏幕并翻译 | `Ctrl+Shift+S` |
| 翻译已复制的文字 | `Ctrl+Shift+D` |
| 翻译输入框内容 | `Ctrl+Enter` |
| 取消截图或翻译 | `Esc` |
| 隐藏侧栏，继续后台运行 | 界面内“最小化到托盘” |
| 完全退出 | 标题栏 X（退出模式）、托盘菜单、设置或 `Ctrl+Alt+Q` |

拖动选区后松开鼠标即开始本地 OCR，并在侧栏显示结果。截图始终自动翻译；“粘贴与导入后自动翻译”仅控制另外两种入口。OCR 资源随应用打包，API Key 保存到 Windows 凭据库。0.4.0 的 ChatGPT 译文支持流式显示，OAuth 凭据由原生端独立加密保存，系统凭据库存放加密密钥；界面提供用量管理和断开连接。

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
