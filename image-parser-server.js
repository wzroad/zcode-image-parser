#!/usr/bin/env node
/**
 * image-parser MCP server
 * 调用 MiniMax M3 (Anthropic 兼容端点) 解析图片，供非多模态模型调用。
 *
 * 工具:
 *   parse_image  — 本地图片路径或 http(s) 图片 URL -> 文字描述/OCR
 */

const API_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/anthropic/v1/messages";
const API_KEY = process.env.MINIMAX_API_KEY || "";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M3";
const DEFAULT_PROMPT =
  "请完整解析这张图片：1) 提取所有可见文字（原文，逐行）2) 描述图片内容、布局、颜色 3) 如含表格/图表/代码/报错信息，结构化还原。用中文回答。";

const TOOLS = [
  {
    name: "parse_image",
    description:
      "解析图片并返回文字内容。接受本地文件路径、data URL 或 http(s) 图片链接。可用于 OCR、图表解读、截图报错分析、UI 描述等。",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "本地图片绝对路径，或 http(s):// 图片链接",
        },
        prompt: {
          type: "string",
          description: "可选，自定义解析要求。缺省时完整提取文字并描述内容",
        },
        max_tokens: { type: "integer", description: "可选，默认 1024" },
      },
      required: ["image"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function imageToBase64(image) {
  // data URL：透传 base64，并解析真实 media type
  const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (m) return { data: m[2], media: m[1] };
  // http(s) 链接：下载后转 base64（MiniMax 不接受远程 URL 直传）
  if (/^https?:\/\//i.test(image)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(image, { signal: ctrl.signal, headers: { "User-Agent": "image-parser-mcp/1.0" } });
      if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const media = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
      return { data: buf.toString("base64"), media };
    } finally {
      clearTimeout(timer);
    }
  }
  // 本地文件
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const abs = path.resolve(image);
  const buf = await fs.readFile(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };
  const media = mimeMap[ext] || "image/png";
  return { data: buf.toString("base64"), media };
}

async function callMiniMax(image, prompt, maxTokens) {
  const parts = await imageToBase64(image);

  const imageBlock = { type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } };

  const body = {
    model: MODEL,
    max_tokens: maxTokens || 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt || DEFAULT_PROMPT },
          imageBlock,
        ],
      },
    ],
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`MiniMax API HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  const json = await res.json();
  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`MiniMax API 错误: ${json.base_resp.status_msg}`);
  }
  const text = (json.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return text || "(空响应)";
}

async function handle(method, params, id) {
  try {
    if (method === "initialize") {
      return {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "image-parser", version: "1.0.0" },
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") {
      return { tools: TOOLS };
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params;
      if (name !== "parse_image") throw new Error(`未知工具: ${name}`);
      if (!args || !args.image) throw new Error("缺少 image 参数");
      const text = await callMiniMax(args.image, args.prompt, args.max_tokens);
      return { content: [{ type: "text", text }], isError: false };
    }
    throw new Error(`未知方法: ${method}`);
  } catch (e) {
    return {
      content: [{ type: "text", text: `错误: ${e.message}` }],
      isError: true,
    };
  }
}

let buffer = "";
let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) {
    // 给 stdout 一点排空时间
    setTimeout(() => process.exit(0), 50);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 跳过坏行
    }
    if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") continue;
    if (!msg.id && msg.method && msg.method.startsWith("notifications/")) continue;
    pending++;
    handle(msg.method, msg.params || {}, msg.id)
      .then((result) => {
        send({ jsonrpc: "2.0", id: msg.id, result });
      })
      .catch((e) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true },
        });
      })
      .finally(() => {
        pending--;
        maybeExit();
      });
  }
});
process.stdin.on("end", () => {
  stdinClosed = true;
  maybeExit();
});
process.stderr.write("[image-parser] MCP server started\n");
