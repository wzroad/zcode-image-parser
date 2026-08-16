# ZCode Image Parser

> 给纯文本模型会话加图片能力：一个 MCP 服务 + 一组 hook，让 deepseek、GLM 等文本模型在 ZCode 里"看见"图片。

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/License-MIT-blue)

## 为什么需要它

ZCode 中只有多模态模型（如 MiniMax-M3）能直接处理图片。纯文本模型的会话里：

- 用户**贴图** → 客户端把图片以 `image_url` 块塞进请求 → API 400，整轮对话死亡
- 模型用 **Read 读图片文件** → image 内容块进入会话历史 → 后续所有请求 400，会话永久污染
- **子智能体**读图 → 子代理的请求带 image 块 → 子代理崩溃

本套件通过「MCP 工具 + hook 路由 + 全局规则」三层防护，让文本模型会话获得完整的图片解析能力。

## 特性

- **MCP 图片解析服务**：`parse_image` 工具调用 MiniMax M3 解析图片（OCR / 图表 / 截图 / UI 描述），支持本地路径、http(s) URL、data URL 三种输入
- **贴图自动路由**：用户贴图时，hook 检测图片缓存并注入路径，模型自动调用 `parse_image`（deepseek-v4-flash 等已实测）
- **危险模型拦截**：对 API 拒绝图片的模型（deepseek-v4-pro）当场拦截贴图并给出缓存路径，杜绝 400
- **Read 守卫**：纯文本模型会话中禁止 Read 图片文件，从源头阻止 image 块污染历史
- **子代理规则**：全局指令约束子智能体走 `parse_image`，不直接接触图片文件
- **零依赖**：两个 Node 脚本，无 npm 包；一键安装、幂等、可干净卸载

## 工作原理

```
用户贴图
   │
   ▼
ZCode 缓存图片到 ~/.zcode/cli/image-cache/<sessionId>/image-<hash>.png
   │
   ▼
UserPromptSubmit hook（hook-image-guard.js）
   ├─ 查 sqlite 获取会话模型
   ├─ MiniMax-M3 等视觉模型 ──────→ 放行，客户端原生多模态处理
   ├─ deepseek-v4-pro（API 拒图片）→ exit 2 拦截 + 提示缓存路径（给路径重发即可）
   └─ 其他文本模型 ────────────────→ 注入缓存路径到上下文
                                        │
                                        ▼
                              模型调用 parse_image（MCP）
                                        │
                                        ▼
                              MiniMax M3 解析 → 文字描述回流
```

```
模型试图 Read 图片文件
   │
   ▼
PreToolUse hook（同一脚本）
   └─ 纯文本模型会话 + file_path 是图片 → deny，拒绝理由引导改用 parse_image
```

## 快速开始

```bash
# 1. 安装（key 二选一传入）
MINIMAX_API_KEY=sk-你的key node install.js
# 或
node install.js sk-你的key

# 2. 完全重启 ZCode（退出重开，不是新开会话）

# 3. 验证
#    - MiniMax-M3 会话贴图        → 原生直通
#    - deepseek-v4-flash 会话贴图 → 自动调 parse_image 解析
#    - deepseek-v4-pro 会话贴图   → 被拦截并收到缓存路径提示
```

## 依赖

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | ZCode 自带运行时 |
| sqlite3 CLI | hook 查询会话模型用；macOS 自带，Linux：`apt install sqlite3` |
| MiniMax API key | M3 模型图片解析，计费走你的 MiniMax 账户 |

## 组件

| 文件 | 作用 |
|---|---|
| `image-parser-server.js` | MCP 服务：`parse_image(image, prompt?, max_tokens?)`，Anthropic 兼容端点调 MiniMax-M3 |
| `hook-image-guard.js` | 双事件 hook：`UserPromptSubmit`（贴图路由）+ `PreToolUse`（Read 守卫） |
| `install.js` | 一键安装：脚本装到 `~/.zcode/mcp/image-parser/`、合并 `~/.zcode/cli/config.json`、追加 AGENTS.md 规则区块、标记 M3 图片能力（全部幂等） |
| `uninstall.js` | 干净卸载，不破坏用户原有配置 |

## 行为矩阵

| 会话模型 | 贴图 | Read 图片文件 | 说明 |
|---|---|---|---|
| MiniMax-M3 | ✅ 原生直通 | ✅ 允许 | 多模态，无需中转 |
| deepseek-v4-flash | ✅ hook 注入 → parse_image | 🚫 拒绝并引导 | 已实测通过 |
| deepseek-v4-pro | 🚫 拦截 + 缓存路径 | 🚫 拒绝并引导 | **API 硬限制**，贴图必 400 |
| 其他文本模型 | ✅ 注入缓存路径 | 🚫 拒绝并引导 | 与 flash 同路径 |

## 配置详解

安装器写入 `~/.zcode/cli/config.json`（与已有配置合并）：

```json
{
  "mcp": {
    "servers": {
      "image-parser": {
        "command": "node",
        "args": ["/Users/你/.zcode/mcp/image-parser/image-parser-server.js"],
        "env": { "MINIMAX_API_KEY": "sk-...", "MINIMAX_MODEL": "MiniMax-M3" }
      }
    }
  },
  "hooks": {
    "enabled": true,
    "events": {
      "UserPromptSubmit": [{ "hooks": [{ "type": "process", "command": "node", "args": ["/Users/你/.zcode/mcp/image-parser/hook-image-guard.js"] }] }],
      "PreToolUse": [{ "hooks": [{ "type": "process", "command": "node", "args": ["/Users/你/.zcode/mcp/image-parser/hook-image-guard.js"] }] }]
    }
  }
}
```

同时向 `~/.zcode/AGENTS.md` 追加规则区块：禁止任何代理 Read 图片文件、子代理派发前由主代理预解析等。

## 排查

| 症状 | 检查 |
|---|---|
| hook 行为异常 | `/tmp/zcode_hook_fire.log`——每次执行都有决策记录（allow/inject/block/deny + 原因） |
| parse_image 工具不出现 | Settings → MCP 查看 `image-parser` 连接状态 |
| Linux 上 hook 不生效 | `which sqlite3`，未安装则 `apt install sqlite3` |
| 会话持续 400 | 历史已被 image 块污染，compact 或开新会话（hook 只能防增量，救不了存量） |
| 模型反复尝试读图 | 正常——deny 理由会引导它改调 parse_image，多看两轮确认 |

## 卸载

```bash
node uninstall.js
```

删除两个脚本、`mcp.servers.image-parser`、hooks 中指向本套件的条目、AGENTS.md 中的标记区块。用户原有配置不受影响。

## 目录结构

```
image-parser-bundle/
├── README.md               # 本文档
├── DIAGNOSE.md             # 新机故障诊断流程
├── LICENSE                 # MIT
├── install.js              # 一键安装器（幂等）
├── uninstall.js            # 卸载器
├── image-parser-server.js  # MCP 服务
└── hook-image-guard.js     # 路由 hook（双事件）
```

## 已知限制

- **deepseek-v4-pro 贴图无解**：其 API 在反序列化层就拒绝 `image_url`，只能拦截+转路径，无法绕过
- **hook 不覆盖子智能体**：子代理工具调用绕过 config hooks，子代理防读图依赖 AGENTS.md 指令层（软约束）
- **图片字节只在客户端内存**：hook 拿不到贴图原始数据，只能拿客户端落盘的缓存路径
- **历史污染不可逆**：已进入会话历史的 image 块只能靠 compact / 新会话清除

## FAQ

**Q：为什么不用 tesseract 本地 OCR？**
A：M3 的解析质量（图表、UI、布局、语义）远超 OCR，且省去本地依赖；有 OCR 需求可在 `parse_image` 的 `prompt` 参数中指定。

**Q：换 MiniMax 之外的多模态模型可以吗？**
A：改 `~/.zcode/cli/config.json` 中的 `MINIMAX_BASE_URL`（支持 env 覆盖）指向其他 Anthropic 兼容端点即可，服务层格式通用。

**Q：API key 放哪安全？**
A：key 存在 `~/.zcode/cli/config.json`（本机用户目录），勿提交仓库；团队共享建议各自安装。

## License

[MIT](LICENSE)
