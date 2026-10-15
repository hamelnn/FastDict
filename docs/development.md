# 开发指南

## 环境与启动

前端需要 Node.js 22.12+；原生开发还需 Rust 1.90+ 和对应平台 SDK，见 [Tauri 前置要求](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run dev       # 浏览器预览
npm run desktop   # 原生桌面开发
```

首次启动或构建会准备本地 OCR 资源，需要网络。缓存位于 `public/ocr/`，不提交到仓库。浏览器预览的截图入口使用系统分享选择器；原生桌面版直接框选屏幕。

## 构建与检查

```sh
npm run check
npm run test:e2e
```

`check` 汇总核心测试、平台构建脚本与 OCR 资源准备测试，以及前端生产构建。端到端测试在 Windows 默认使用 Edge；其他平台先执行 `npx playwright install chromium`。可通过 `PLAYWRIGHT_CHANNEL` 指定浏览器通道。

也可单独运行 `npm run test`、`npm run test:scripts` 或 `npm run build`；`build` 只生成 `dist/` 前端资源。

原生检查和截图编码测试：

```sh
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

桌面打包分别使用 `npm run windows:build` 和 `npm run macos:build`；构建前置要求、输出与签名说明见 [Windows](windows.md) / [macOS](macos.md)。移动端入口见 [平台说明](platforms.md)。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `src/` | React 界面与共享状态 |
| `src/lib/` | 翻译协议、OCR、存储及平台接口 |
| `src/components/` | 截图框选与独立界面组件 |
| `src-tauri/src/` | 原生截图、快捷键、窗口、诊断与密钥存储 |
| `scripts/` | OCR 资源准备与平台构建 |
| `tests/` | 浏览器、启动恢复和原生接口模拟测试 |
| `.github/workflows/` | 自动检查与手动 macOS 打包 |

提交源码、锁文件与相关测试；依赖、OCR 下载缓存、工具链、构建产物和本机诊断均由 `.gitignore` 排除。应用使用者的 API Key 通过应用配置，不应放入源码或测试夹具。

测试边界见 [验证范围](validation.md)，处理链路与测量方法见 [架构与性能](architecture.md)。
