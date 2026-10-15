# ChatGPT 订阅翻译

FastLingo 0.4.0 源码使用官方 Sign in with ChatGPT，让符合条件的账号授权 FastLingo 使用 ChatGPT 套餐或积分进行翻译。此版本尚未发布，真实浏览器授权与最终安装包验收仍待完成；已发布的 0.3.1 使用方式见 [历史说明](codex.md)。

此入口支持 Windows 和 macOS 桌面版。无需安装 Codex，也无需提供 API Key。官方目前说明符合条件的 Plus / Pro 账号可使用此能力；具体模型、套餐、工作区和地区权限，以授权及实际请求结果为准。[官方接入概览](https://developers.openai.com/siwc/token-sharing-open-source)、[官方快速入门](https://developers.openai.com/siwc/quickstart)。

## 配置

1. 在侧栏点击“添加翻译服务”，选择“ChatGPT 订阅”。首次安装仍没有预设翻译服务。
2. 点击 **Continue with ChatGPT**。在系统浏览器中选择账号和工作区，为 FastLingo 登录并授权使用 ChatGPT 套餐。
3. 返回应用，确认已连接、已授权套餐使用，并从该账号的模型目录选择模型。默认保留 `gpt-6-luna`；目录没有该模型时，请自行选择可用模型，应用不会自动换用其他模型或 API 计费方式。
4. 首次成功启用套餐时，应用会说明用量来源，点击“知道了”后继续。保存服务后即可截图或粘贴翻译，译文会逐步显示，按 Esc 可取消。

“刷新连接”只检查连接、授权和模型目录，不发送翻译文本。已登录、模型可见都不能替代实际翻译成功的确认。仅完成身份登录而未授权套餐使用时，应用会提示“重新授权”，不会提交翻译。[官方登录协议](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型和推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

## 从 0.3.1 升级

已有服务名称、模型、翻译历史和 API Key 保留。原来的“本机 Codex”服务在新版本中使用官方 ChatGPT 连接，需要在 FastLingo 中重新登录授权。Codex 自己的登录和配置不用于这个授权过程；新版本不读取它的令牌，也不启动它的翻译进程。

旧服务内部的 `codex` 类型标记仅用于兼容已有配置，不表示新版本仍通过 Codex 调用模型。API 服务继续使用各自原有的配置和密钥。

## 账号与用量

可在服务设置中选择已保存的 ChatGPT 账号，或添加另一个账号 / 工作区连接。相同邮箱可能对应不同注册连接，应用保留各自的身份、授权和模型目录。

翻译界面会显示“使用 ChatGPT 套餐”，旁边的“管理用量”打开 [ChatGPT 用量设置](https://chatgpt.com/settings/usage)。额度限制可能来自套餐或本应用的限制；达到限制后应先管理用量，应用不会自动改用付费 API Key。[官方用量界面要求](https://developers.openai.com/siwc/ui-ux-guidelines)。

“断开连接”会停止该连接的翻译，尝试撤销可续期会话，然后清除本机令牌，并保留注册信息供以后重新登录。如果网络原因导致无法确认远程撤销，应用会明确提示；可到 ChatGPT 设置中断开 FastLingo。临时网络错误不会直接删除连接。[账号、刷新和退出](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[错误处理](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。

## 数据处理

截图由本机 OCR 识别，识别出的文字通过原生网络请求发送到 OpenAI 的公开 `https://api.openai.com/v1/responses`。每次请求设置 `store: false` 和 `stream: true`，并等待完整的成功事件；中断、未完成或额度错误不算翻译成功。模型目录来自所选账号的公开 `/v1/models` 接口。[官方推理格式](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

OAuth 注册、身份验签、令牌刷新及撤销在原生端完成。凭据以加密文件保存在应用本机目录，加密密钥由 Windows 凭据库 / macOS Keychain 保存；令牌不会传给网页界面、存入翻译历史或写进日志。此授权不提供读取 ChatGPT 对话的能力。图片识别在本地完成，语言模型翻译需要联网。

iOS、Android 和浏览器预览继续使用自行配置的 API 服务，当前不提供 ChatGPT 登录入口。

## 验收状态

0.4.0 的实现与自动化检查进度见 [验证范围](validation.md)。真实 ChatGPT 授权需要用户在系统浏览器完成；在完成最终包的授权、翻译、取消及断开连接验收前，不把源码检查写作已发布或已验证的设备功能。
