# 诊断任务：image-parser MCP 失效排查

> 用法：把本文件全文发给新机器的 ZCode，让它执行。只诊断、不修改配置，最后会输出一张结论表。

我是用户，本机刚装了 image-parser-bundle（给纯文本模型加图片解析能力的套件），但功能没生效。请你**只做诊断，不修改任何配置**，按顺序执行以下步骤，每步输出 ✅/❌ + 证据。最后输出诊断结论表和最可能的故障点。

## 第 1 步：环境前提

```bash
uname -a
uname -m
node --version
node -e "console.log('fetch:', typeof fetch)"
which node && which sqlite3 && sqlite3 --version
```

预期：Node ≥ 18（且 `fetch: function`——Intel Mac 上常见旧 node，缺 fetch 会让 MCP 服务运行时崩溃）；sqlite3 存在（Linux 若 `which` 无输出就是缺它，hook 会静默失败）。

> Intel Mac 特别注意：bundle 是纯 JS，与 CPU 架构无关；真正的风险是**系统 node 版本过旧**（Intel 机器通常装得早、一直没升）和 **node 不在 ZCode 拉起的进程 PATH 里**。上面两条命令能一步验证。

## 第 2 步：核心文件

```bash
ls -la ~/image-parser-server.js ~/hook-image-guard.js
```

预期：两个文件都存在且有内容（不是 0 字节）。

## 第 3 步：ZCode 配置

```bash
cat ~/.zcode/cli/config.json
```

逐项核对：

- `mcp.servers.image-parser` 存在，`args` 里的路径与第 2 步文件实际位置一致
- `env.MINIMAX_API_KEY` 已填真实 key（不是占位符）
- `hooks.enabled: true`
- `hooks.events` 下同时注册了 `UserPromptSubmit` 和 `PreToolUse`

## 第 4 步：规则与模型标记

```bash
grep -c "image-parser-bundle" ~/.zcode/AGENTS.md
grep -A6 "MiniMax-M3" ~/.zcode/v2/config.json
```

预期：AGENTS.md 计数 ≥ 2；v2 配置里 MiniMax-M3 的 `modalities.input` 含 `"image"`。

## 第 5 步：MCP 手摇测试（最关键）

先造一张 1x1 测试图，再模拟 MCP 握手：

```bash
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > /tmp/mcp_test.png
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.zcode/cli/config.json'))['mcp']['servers']['image-parser']['env'].get('MINIMAX_API_KEY',''))")
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"parse_image","arguments":{"image":"/tmp/mcp_test.png","prompt":"这张图是什么颜色？一句话回答。","max_tokens":80}}}' \
| MINIMAX_API_KEY="$KEY" node ~/image-parser-server.js
```

预期：`tools/list` 返回 `parse_image` 工具；`tools/call` 返回文字解析（应提到"红色"）。若这里失败，把 stderr 完整贴出。

## 第 6 步：hook 单测

```bash
echo '{"hookEventName":"UserPromptSubmit","attachmentsSummary":"","sessionId":"sess_fake"}' | node ~/hook-image-guard.js; echo "exit=$?"
echo '{"hookEventName":"PreToolUse","sessionId":"sess_fake","toolName":"Read","toolInput":{"file_path":"/tmp/mcp_test.png"}}' | node ~/hook-image-guard.js; echo "exit=$?"
cat /tmp/zcode_hook_fire.log 2>/dev/null | tail -5
```

预期：两条 exit=0；fire log 有记录。若 hook 报 `sqlite3` 相关错误，回到第 1 步。

## 第 7 步：会话模型库

```bash
sqlite3 ~/.zcode/v2/tasks-index.sqlite "SELECT task_id, model FROM tasks ORDER BY updated_at DESC LIMIT 3;"
```

预期：能看到当前会话的模型记录（hook 靠它判断模型能力，读不到就会静默放行）。

## 第 8 步：ZCode 运行时日志

```bash
ls -t ~/.zcode/cli/log/*.jsonl | head -1 | xargs grep -i "image-parser" | tail -10
```

找 MCP 连接失败、超时、命令不存在等报错。

## 最终输出

按此格式给结论：

```
| 步骤 | 结果 | 关键证据 |
|------|------|----------|
| 1 环境 | ✅/❌ | ... |
| 2 文件 | ✅/❌ | ... |
| 3 配置 | ✅/❌ | ... |
| 4 规则 | ✅/❌ | ... |
| 5 MCP  | ✅/❌ | ... |
| 6 hook | ✅/❌ | ... |
| 7 sqlite | ✅/❌ | ... |
| 8 日志 | ✅/❌ | ... |

最可能的故障点：<一句话>
```

把这张表和你认为的故障点发给我（用户会转给原作者）。

> 注意：诊断过程中不要用 Read 工具读任何图片文件（会产生 image 内容块污染会话），图片一律用上面的命令行方式处理。

---

## 新机器高频故障点速查（给用户看）

| 症状 | 原因 | 修复 |
|---|---|---|
| tools/call 报 `fetch is not defined` | 系统 node < 18（Intel 老 Mac 常见） | `brew install node@20` 并确保 PATH 指向新 node，重启 ZCode |
| hook 不生效、fire log 无记录 | Linux 缺 sqlite3 | `apt install sqlite3`，重启 ZCode |
| parse_image 解析返回鉴权错误 | install.js 没带 key，config 里是占位符 | 编辑 `~/.zcode/cli/config.json` 填真实 key |
| 工具列表里没有 parse_image | ZCode 没完全重启 | 完全退出 ZCode 再开 |
| MCP 连接失败 / 命令不存在 | bundle 解压路径与 config 中 args 不一致 | 重跑 `node install.js`（会按新路径重写 config） |
| v2 配置里 M3 没标 image | ZCode 尚未生成 provider 配置 | 在 ZCode 里配置好 MiniMax-M3 后重跑 `node install.js` |
