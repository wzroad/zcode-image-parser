#!/usr/bin/env node
/**
 * image-parser-bundle 一键安装器
 *
 * 用法:
 *   MINIMAX_API_KEY=sk-xxx node install.js
 *   或: node install.js sk-xxx
 *   测试: node install.js --dest /tmp/test-home (不写入真实 $HOME)
 *
 * 安装内容:
 *   1. ~/.zcode/mcp/image-parser/ 脚本落点（MCP 服务 + 路由 hook）
 *   2. ~/.zcode/cli/config.json    MCP + hooks 配置（与已有配置合并）
 *   3. ~/.zcode/AGENTS.md          全局图片解析路由规则（带标记区块，可重复安装）
 *   4. ~/.zcode/v2/config.json     把 MiniMax-M3 标记为支持 image 输入（幂等）
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
let dest = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dest") {
    dest = args[i + 1];
    i++;
  }
}
const apiKey =
  process.env.MINIMAX_API_KEY ||
  args.find((a) => /^sk-/.test(a)) ||
  "";

const HOME = dest ? path.resolve(dest) : require("os").homedir();
// 脚本统一安装到 ~/.zcode/mcp/image-parser/（不污染 $HOME 根目录）
const INSTALL_DIR = path.join(HOME, ".zcode", "mcp", "image-parser");
const SRC = __dirname;

const AGENTS_MARK = "# ===== image-parser-bundle =====";
const AGENTS_RULES = `${AGENTS_MARK}
# 全局行为规则（image-parser-bundle 自动安装）

## 图片解析路由

当前主模型可能不具备多模态能力。当任务涉及图片内容解析时（用户贴出图片、给出本地图片路径、图片 URL、data URL，或要求 OCR/看图/识别截图/分析图表），必须调用 image-parser MCP 服务器的 \`parse_image\` 工具获取图片的文字解析结果，再基于结果继续任务。不要声称"我无法查看图片"。

调用示例：\`parse_image({ image: "/path/to/image.png" })\`，可附加 \`prompt\` 指定解析侧重点。

## 禁止直接 Read 图片文件

纯文本模型会话中，任何代理（主代理和子代理）都不得用 Read 工具直接读取图片文件（png/jpg/jpeg/webp/gif/bmp/avif）。直接读取会产生 image 内容块，导致后续所有请求报错（API 400）。

需要看图时：
- 拥有 parse_image 工具的代理（主代理、general-purpose 子代理）→ 直接调用 parse_image 解析
- 没有该工具的子代理（如 Explore）→ 不要 Read 图片，把图片文件路径返回给主代理，由主代理解析后转述结果

## 子代理派发规则

派发子代理前，如果任务涉及图片内容：
1. 主代理先用 parse_image 把图片解析成文字描述
2. 把文字描述写入子代理的任务 prompt，让子代理基于文字工作，不接触图片文件本身

# ===== image-parser-bundle end =====`;

function log(msg) {
  console.log(`[install] ${msg}`);
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

/* ── 1. 复制脚本 ── */
function copyScript(name) {
  const from = path.join(SRC, name);
  const to = path.join(INSTALL_DIR, name);
  if (!fs.existsSync(from)) throw new Error(`缺少 ${name}，bundle 不完整`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
  log(`复制 ${name} → ${to}`);
}

/* ── 2. cli/config.json 合并 ── */
function mergeCliConfig() {
  const p = path.join(HOME, ".zcode/cli/config.json");
  const cfg = readJson(p, {});
  if (!cfg.mcp) cfg.mcp = {};
  if (!cfg.mcp.servers) cfg.mcp.servers = {};
  cfg.mcp.servers["image-parser"] = {
    command: "node",
    args: [path.join(INSTALL_DIR, "image-parser-server.js")],
    env: {
      MINIMAX_API_KEY: apiKey || "在此填入你的 MiniMax API key",
      MINIMAX_MODEL: "MiniMax-M3",
    },
  };
  if (!cfg.hooks) cfg.hooks = {};
  cfg.hooks.enabled = true;
  if (!cfg.hooks.events) cfg.hooks.events = {};
  const guard = {
    type: "process",
    command: "node",
    args: [path.join(INSTALL_DIR, "hook-image-guard.js")],
    timeoutMs: 15000,
  };
  const mergeEvent = (ev) => {
    const groups = cfg.hooks.events[ev] || [];
    const hasGuard = groups.some((g) =>
      (g.hooks || []).some((h) => h.args && h.args[0] === guard.args[0])
    );
    if (!hasGuard) {
      groups.push({ hooks: [guard] });
    }
    cfg.hooks.events[ev] = groups;
  };
  mergeEvent("UserPromptSubmit");
  mergeEvent("PreToolUse");
  writeJson(p, cfg);
  log(`配置 ~/.zcode/cli/config.json（mcp.image-parser + hooks 已合并）`);
}

/* ── 3. AGENTS.md 区块写入 ── */
function mergeAgentsMd() {
  const p = path.join(HOME, ".zcode/AGENTS.md");
  let content = "";
  try {
    content = fs.readFileSync(p, "utf8");
  } catch (e) {}
  if (content.includes(AGENTS_MARK)) {
    // 替换旧区块
    const start = content.indexOf(AGENTS_MARK);
    const endMarker = "# ===== image-parser-bundle end =====";
    const end = content.indexOf(endMarker, start);
    content =
      content.slice(0, start) +
      (end >= 0 ? content.slice(end + endMarker.length) : "");
  }
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n\n" + AGENTS_RULES + "\n";
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  log(`规则写入 ~/.zcode/AGENTS.md`);
}

/* ── 4. v2/config.json 标记 MiniMax-M3 支持 image ── */
function markM3Vision() {
  const p = path.join(HOME, ".zcode/v2/config.json");
  let cfg = readJson(p, null);
  if (!cfg || !cfg.provider) {
    log("未找到 ~/.zcode/v2/config.json（跳过 MiniMax-M3 标记，稍后可在 ZCode 设置里手动勾选图片能力）");
    return;
  }
  let changed = 0;
  for (const pid of Object.keys(cfg.provider)) {
    const prov = cfg.provider[pid];
    const models = prov && prov.models;
    if (!models) continue;
    for (const m of Object.keys(models)) {
      const mm = models[m];
      if (!mm || !mm.modalities) continue;
      const inputs = mm.modalities.input || [];
      if (inputs.includes("image")) continue;
      // 只标记 MiniMax 系模型（名字含 minimax 或 M3）
      const nameHint = (prov.name || "") + " " + m;
      if (!/MiniMax|M3/i.test(nameHint)) continue;
      inputs.push("image");
      mm.modalities.input = inputs;
      changed++;
      log(`标记模型 ${m}（provider: ${prov.name}）支持 image 输入`);
    }
  }
  if (changed) writeJson(p, cfg);
  else log("v2/config.json 无需变更（MiniMax-M3 已是 image 能力或未配置）");
}

/* ── 执行 ── */
copyScript("image-parser-server.js");
copyScript("hook-image-guard.js");
mergeCliConfig();
mergeAgentsMd();
markM3Vision();

console.log("\n✅ 安装完成。");
if (!apiKey) console.log("⚠️  未提供 API key，请编辑 ~/.zcode/cli/config.json 中 MINIMAX_API_KEY");
console.log("下一步：完全重启 ZCode，然后在新会话贴图或给图片路径测试。");
if (dest) console.log(`（测试模式：写入 ${HOME}，未影响真实配置）`);
