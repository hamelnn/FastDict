# Windows 桌面版

支持 Windows 10/11 x64。已有本地原生构建与启动验证基线；产物未签名，安装程序尚未验证。源码仓库不包含构建产物。

## 使用

构建后解压 `release/FastDict-Windows-x64.zip`，保持 `FastDict.exe` 与 `WebView2Loader.dll` 在同一文件夹，双击应用。若系统缺少 WebView2 Runtime，请从 [Microsoft 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

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
```

脚本默认使用 MSVC；存在项目内 `.build-tools` 工具链时使用 GNU。也可指定已安装的目标：

```sh
npm run windows:build -- --target=x86_64-pc-windows-msvc
npm run windows:build -- --target=x86_64-pc-windows-gnu
```

输出位于 `release/`：可执行文件、运行库、ZIP 和包含 SHA-256 的 `manifest.json`。该目录不提交到源码仓库。

## 启动异常

启动失败时可使用恢复界面的“重新加载”或“退出应用”。标题栏 X 和原生快捷键 `Ctrl+Alt+Q` 独立于网页界面；升级保留既有配置与密钥。

诊断日志位于 `%LOCALAPPDATA%\app.fastdict.translate\logs\startup.log`，仅记录固定启动阶段，不记录截图、文本、服务地址或 API Key。日志达到 256 KiB 后轮转一次。

完整设备验收边界见 [验证范围](validation.md)，通用开发与测试见 [开发指南](development.md)。
