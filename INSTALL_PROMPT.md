# 安装任务：image-parser-bundle 重装

> 把本文件全文发给目标机器的 ZCode 执行。这是安装任务（会修改配置），按步骤完成后输出验收表。

请在本机完成 image-parser-bundle 的完整安装与验收。项目仓库：`git@github.com:wzroad/zcode-image-parser.git`（公开仓库，SSH 失败就用 `https://github.com/wzroad/zcode-image-parser.git`）。

## 第 0 步：API key

用户提供的 MiniMax API key：`在此填入 sk-开头的 key`

如果上面仍是占位符，先向用户索要 key，不要用假 key 继续。

## 第 1 步：环境检查与修复

```bash
uname -s
uname -m
node --version
node -e "console.log('fetch:', typeof fetch)"
which sqlite3 || echo "NO_SQLITE"
```

- node < 18 或 fetch 非 function → 提示用户升级 node（macOS: `brew install node@20`）后重试本步
- NO_SQLITE 且是 Linux → `sudo apt install -y sqlite3`；macOS 不可能缺
- 环境就绪再继续

## 第 2 步：清理残留（旧版安装）

```bash
rm -f ~/image-parser-server.js ~/hook-image-guard.js
```

（用户已卸载过，这只是兜底；没有文件就是最好的结果）

## 第 3 步：拉取仓库

```bash
rm -rf ~/.zcode/mcp/image-parser
mkdir -p ~/.zcode/mcp
git clone git@github.com:wzroad/zcode-image-parser.git ~/.zcode/mcp/image-parser || git clone https://github.com/wzroad/zcode-image-parser.git ~/.zcode/mcp/image-parser
ls ~/.zcode/mcp/image-parser/
```

预期看到 install.js、image-parser-server.js、hook-image-guard.js、README.md 等 7 个文件。

## 第 4 步：运行安装器

```bash
cd ~/.zcode/mcp/image-parser
MINIMAX_API_KEY="<第0步的key>" node install.js
```

预期输出：复制 2 个脚本、合并 config、写入 AGENTS.md、标记 M3 image 能力。

## 第 5 步：MCP 验收（关键）

```bash
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > /tmp/mcp_test.png
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.zcode/cli/config.json'))['mcp']['servers']['image-parser']['env'].get('MINIMAX_API_KEY',''))")
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"parse_image","arguments":{"image":"/tmp/mcp_test.png","prompt":"这张图是什么颜色？一句话回答。","max_tokens":80}}}' \
| MINIMAX_API_KEY="$KEY" node ~/.zcode/mcp/image-parser/image-parser-server.js
```

**验收标准**：tools/list 返回 `parse_image`；tools/call 返回的解析文字中提到"红色"。不满足就贴出 stderr 停下，不要继续。

## 第 6 步：hook 验收

```bash
echo '{"hookEventName":"UserPromptSubmit","attachmentsSummary":"","sessionId":"sess_fake"}' | node ~/.zcode/mcp/image-parser/hook-image-guard.js; echo "exit=$?"
echo '{"hookEventName":"PreToolUse","sessionId":"sess_fake","toolName":"Read","toolInput":{"file_path":"/tmp/mcp_test.png"}}' | node ~/.zcode/mcp/image-parser/hook-image-guard.js; echo "exit=$?"
cat /tmp/zcode_hook_fire.log 2>/dev/null | tail -3
```

验收标准：两条 exit=0；fire log 有记录。

## 第 7 步：配置核对

```bash
cat ~/.zcode/cli/config.json
grep -c "image-parser-bundle" ~/.zcode/AGENTS.md
grep -A6 "MiniMax-M3" ~/.zcode/v2/config.json 2>/dev/null || echo "(v2 配置暂不存在，跳过)"
```

核对：config 中 MCP args 与两处 hook args 都指向 `~/.zcode/mcp/image-parser/`；AGENTS.md 计数 ≥ 2；若 v2 配置存在则 M3 的 `modalities.input` 含 `"image"`。

## 第 8 步：输出验收表

```
| 步骤 | 结果 | 备注 |
|------|------|------|
| 环境 | ✅/❌ | node 版本 |
| 拉取 | ✅/❌ | |
| 安装 | ✅/❌ | |
| MCP  | ✅/❌ | 解析结果是否提到红色 |
| hook | ✅/❌ | |
| 配置 | ✅/❌ | |

结论：<一句话>
```

最后提醒用户：**完全退出并重启 ZCode**（不是新开会话），重启后按三个场景验收：
1. MiniMax-M3 会话贴图 → 原生直通
2. deepseek-v4-flash 会话贴图 → 自动 parse_image 解析
3. deepseek-v4-pro 会话贴图 → 被拦截并收到缓存路径提示

> 注意：本任务全程不要用 Read 工具读任何图片文件，图片测试一律用上面的命令行方式。
