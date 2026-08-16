#!/usr/bin/env node
/**
 * 图片路由 hook（多事件版）
 *
 * 事件 1: UserPromptSubmit
 *   - 用户贴图 + 纯文本模型 → 注入 image-cache 缓存路径，让模型调 parse_image
 * 事件 2: PreToolUse
 *   - 纯文本模型会话中，工具（Read 等）尝试读取图片文件 → 拒绝（deny）
 *     阻止 image 内容块进入会话历史（否则后续请求带 image_url 直接 400 且永久污染）
 *
 * 诊断：/tmp/zcode_hook_fire.log
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FIRE_LOG = "/tmp/zcode_hook_fire.log";
const HOME = process.env.HOME || "";
const DB = HOME + "/.zcode/v2/tasks-index.sqlite";
const CACHE_ROOT = HOME + "/.zcode/cli/image-cache";
const SQLITE = fs.existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
const VISION_RE = /MiniMax|M3|vision|gpt-4o|gpt-5|claude|gemini|qwen-vl|glm-4v|step-1v|doubao/i;
// 实测：deepseek-v4-pro 的 API 拒绝 image_url 内容块（400），v4-flash 正常
const BLOCK_RE = /deepseek-v4-pro/i;
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

function fireLog(obj) {
  try {
    fs.appendFileSync(FIRE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch (e) {}
}

function sessionModel(sid) {
  if (!sid) return "";
  try {
    const q = `SELECT model FROM tasks WHERE task_id='${sid.replace(/'/g, "''")}' LIMIT 1;`;
    const out = execFileSync(SQLITE, [DB, q], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    return out.split("\n")[0] || "";
  } catch (e) {
    return "";
  }
}

function newestImageFile(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
    if (!files.length) return null;
    let best = null;
    let bestTime = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > bestTime) {
        bestTime = st.mtimeMs;
        best = f;
      }
    }
    return best ? path.join(dir, best) : null;
  } catch (e) {
    return null;
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let stdin = {};
  try {
    stdin = JSON.parse(raw);
  } catch (e) {
    fireLog({ event: "?", decision: "allow", reason: "stdin_parse_fail" });
    process.exit(0);
  }

  const event = String(stdin.hookEventName || stdin.hook_event_name || "");
  const sid = String(stdin.sessionId || stdin.session_id || "");

  /* ══════════ UserPromptSubmit ══════════ */
  if (event === "UserPromptSubmit") {
    const summary = String(stdin.attachmentsSummary || "");
    if (!/image/i.test(summary)) {
      fireLog({ event, decision: "allow", reason: "no_image" });
      process.exit(0);
    }
    const model = sessionModel(sid);
    if (VISION_RE.test(model)) {
      fireLog({ event, decision: "allow", reason: "vision_model", sid, model });
      process.exit(0);
    }
    const imgPath = newestImageFile(path.join(CACHE_ROOT, sid));
    // 新会话首条消息：tasks 表还没落库（实测提交晚于 hook 约 150ms），查不到模型。
    // 无法判断模型能力 → 拦截以防 v4-pro 400；重发时模型已落库，走正常分支。
    if (!model) {
      fireLog({ event, decision: "block", reason: "unknown_session", sid, imgPath });
      const msg =
        `[图片路由] 新会话首次贴图已拦截（会话模型信息尚未入库，无法判断能否处理图片，拦截以防报错）。\n` +
        (imgPath ? `图片已缓存到：${imgPath}\n` : "") +
        `请直接重新发送同样的消息：再次提交时会话信息已就绪，模型支持则自动解析，不支持会给出明确指引。`;
      process.stderr.write(msg + "\n");
      process.exit(2);
    }
    if (!imgPath) {
      fireLog({ event, decision: "allow", reason: "no_cache_found", sid, model });
      process.exit(0);
    }
    // v4-pro 的 API 拒绝 image_url：注入无用，必须拦截提交，否则整轮 400
    if (BLOCK_RE.test(model)) {
      const shortModel = model.split("/").pop().split("$")[0] || "当前";
      fireLog({ event, decision: "block", sid, model, imgPath });
      const msg =
        `[图片路由] 会话模型 ${shortModel} 不支持图片输入，贴图会导致本轮请求报错，已拦截。\n` +
        `图片已缓存到：${imgPath}\n` +
        `请二选一：1) 删除附件后重新发送，并在消息中附上该缓存路径（我会用 parse_image 解析）；` +
        `2) 切换到 deepseek-v4-flash 或 MiniMax-M3 会话再贴图。`;
      process.stderr.write(msg + "\n");
      process.exit(2);
    }
    const ctx =
      `用户本条消息附带了图片，图片已由客户端缓存至本地文件：${imgPath}\n` +
      `请先用 image-parser MCP 的 parse_image 工具解析该文件（例如 parse_image({ image: "${imgPath}" })），` +
      `再结合解析结果和用户原文回复。不要声称无法查看图片。`;
    fireLog({ event, decision: "inject", sid, model, imgPath });
    process.stdout.write(JSON.stringify({ additionalContext: ctx }) + "\n");
    process.exit(0);
  }

  /* ══════════ PreToolUse ══════════ */
  if (event === "PreToolUse") {
    const toolName = String(stdin.toolName || stdin.tool_name || stdin.tool?.name || "");
    const model = sessionModel(sid);
    if (VISION_RE.test(model) || !model) {
      process.exit(0); // 视觉模型或未知会话不拦
    }
    // 只有 Read 会把图片内容块注入会话历史（Bash/Write/Edit 只产生文本），仅拦截 Read
    if (!/^Read$/i.test(toolName)) {
      process.exit(0);
    }
    // 只检查 Read 的 file_path 参数本身是否是图片文件
    const ti = stdin.toolInput || stdin.tool_input || stdin.input || {};
    const fp = String((ti && (ti.file_path || ti.path)) || "");
    if (!fp || !IMG_EXT_RE.test(fp)) process.exit(0);

    fireLog({ event, decision: "deny", reason: "read_image_file", sid, model, toolName, imgPath: fp });
    const denyReason =
      `当前会话模型为纯文本模型，直接读取图片会产生不兼容的内容块并导致后续请求全部报错。` +
      `请改用 image-parser MCP 的 parse_image 工具解析该图片（parse_image({ image: "${fp}" })），不要用 Read 直接读图片文件。`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denyReason,
        },
      }) + "\n"
    );
    process.exit(0);
  }

  process.exit(0);
});
