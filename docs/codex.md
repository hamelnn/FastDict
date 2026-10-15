# 本机 Codex 与 GPT 订阅

FastLingo 桌面版可通过本机 Codex 使用 ChatGPT 订阅翻译，默认模型为 `gpt-6-luna`。此入口属于 0.3.1 的新增功能，0.3.0 安装包不包含它。

## 配置

1. 安装 Codex CLI，在本机通过 ChatGPT 账号登录。登录操作由你在 Codex 中完成；FastLingo 不代填账号或密码。
2. 在 FastLingo 中点击“添加翻译服务”，选择“本机 Codex（GPT 订阅）”。
3. 保留默认模型 `gpt-6-luna`，点击“检测连接”，然后保存。此入口不需要填写 API 地址或 API Key。
4. 截图或粘贴文本后开始翻译。可以随时取消。

检测会确认本机 Codex 的登录方式，并查询模型目录；目录中存在模型不代表账号一定获准调用，最终权限以实际翻译为准。使用 API Key 登录时会提示改用 ChatGPT 登录，不会自动登出或更改你的 Codex 配置。

## 工作方式

FastLingo 不读取或复制 Codex 的登录令牌。授权、令牌刷新和订阅用量由本机 Codex 管理，翻译会占用你的 Codex 订阅额度。

图片仍在本机进行 OCR，识别后的文字交给 Codex；“本机 Codex”表示通过本机客户端连接云端模型，并非离线模型。

订阅入口使用 Codex 的自动化命令，并忽略个人项目工具配置，在独立的只读工作目录中翻译。Codex 当前的自动化事件不能保证逐 token 输出，因此译文通常在段落完成后出现；直接 API 服务保留原有流式显示。

此入口仅在桌面应用中显示。iOS、Android 和浏览器预览继续使用自行配置的翻译 API。

## 早期测试版的工具调用误报

若使用早期 0.3.1 测试包时看到“本次请求尝试使用翻译以外的工具，已停止”，请更新为修复后的安装包。Codex 会把部分启动配置警告放在非致命的 `item.error` 事件中；早期解析器把它误判成了工具调用，与原文内容无关。

修复版单独处理这些通知，只显示译文；实际工具调用仍会中止翻译。只有模型正常完成、返回非空译文且进程成功退出，才视为成功。无需修改或删除自己的 Codex 配置。

官方说明：[Codex 登录与订阅](https://learn.chatgpt.com/docs/auth)、[自动化调用](https://learn.chatgpt.com/docs/non-interactive-mode)、[GPT-6 模型](https://developers.openai.com/api/docs/guides/latest-model)。
