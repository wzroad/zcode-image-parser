#!/usr/bin/env node
/**
 * image-parser-bundle 卸载器
 * 用法: node uninstall.js [--dest <home>]
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
const HOME = dest ? path.resolve(dest) : require("os").homedir();
const AGENTS_MARK = "# ===== image-parser-bundle =====";
const AGENTS_END = "# ===== image-parser-bundle end =====";

function log(m) { console.log(`[uninstall] ${m}`); }

// 1. 脚本（兼容新旧两代安装路径）
const scriptPaths = [
  path.join(HOME, ".zcode", "mcp", "image-parser", "image-parser-server.js"),
  path.join(HOME, ".zcode", "mcp", "image-parser", "hook-image-guard.js"),
  path.join(HOME, "image-parser-server.js"), // 旧版安装位置
  path.join(HOME, "hook-image-guard.js"), // 旧版安装位置
];
for (const p of scriptPaths) {
  if (fs.existsSync(p)) { fs.unlinkSync(p); log(`删除 ${p}`); }
}

// 2. cli/config.json
const cliCfg = path.join(HOME, ".zcode/cli/config.json");
try {
  const cfg = JSON.parse(fs.readFileSync(cliCfg, "utf8"));
  let changed = false;
  if (cfg.mcp && cfg.mcp.servers && cfg.mcp.servers["image-parser"]) {
    delete cfg.mcp.servers["image-parser"];
    changed = true;
    log("移除 mcp.servers.image-parser");
  }
  if (cfg.hooks && cfg.hooks.events) {
    for (const ev of Object.keys(cfg.hooks.events)) {
      const groups = cfg.hooks.events[ev].filter((g) =>
        !(g.hooks || []).some((h) => h.args && /hook-image-guard\.js$/.test(h.args[0]))
      );
      if (groups.length !== cfg.hooks.events[ev].length) {
        cfg.hooks.events[ev] = groups;
        changed = true;
        log(`清理 ${ev} 中的 image-guard hook`);
      }
      if (!groups.length) delete cfg.hooks.events[ev];
    }
  }
  if (changed) fs.writeFileSync(cliCfg, JSON.stringify(cfg, null, 2) + "\n");
} catch (e) { log(`跳过 cli/config.json（${e.message}）`); }

// 3. AGENTS.md 区块
const agentsMd = path.join(HOME, ".zcode/AGENTS.md");
try {
  let content = fs.readFileSync(agentsMd, "utf8");
  if (content.includes(AGENTS_MARK)) {
    const start = content.indexOf(AGENTS_MARK);
    const end = content.indexOf(AGENTS_END, start);
    if (end >= 0) {
      content = content.slice(0, start) + content.slice(end + AGENTS_END.length);
      content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      fs.writeFileSync(agentsMd, content);
      log("移除 AGENTS.md 中的 image-parser-bundle 区块");
    }
  }
} catch (e) {}

// 4. v2 模型标记不回滚（无害，保留）

console.log("\n✅ 卸载完成。重启 ZCode 生效。");
