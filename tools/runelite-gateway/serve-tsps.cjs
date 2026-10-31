"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { parseEnv } = require("node:util");

function configuration(root) {
  root = fs.realpathSync(root);
  if (!fs.statSync(path.join(root, ".git")).isFile()) throw new Error("Use an isolated git worktree, never the installed main checkout");
  const env = parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8"));
  const slot = Number(env.WT_SLOT);
  if (!Number.isInteger(slot) || slot < 1 || slot > 99 || Number(env.WEBSOCKET_PORT) !== 43700 + slot) {
    throw new Error("Missing or inconsistent scripts/wt slot; refusing default/live ports");
  }
  const server = path.join(root, "server");
  const owned = directory => {
    const resolved = fs.realpathSync(directory);
    if (!resolved.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error("Save data must stay inside this isolated worktree");
  };
  owned(path.join(server, "data"));
  // Resolve the actual persistence paths, including existing DB/sidecar files and
  // nested character directories. Never inherit a main-world save override.
  const saves = path.join(server, "data", "saves");
  const inspect = entry => {
    if (!fs.existsSync(entry)) return;
    owned(entry);
    if (fs.statSync(entry).isDirectory()) {
      for (const child of fs.readdirSync(entry)) inspect(path.join(entry, child));
    }
  };
  inspect(saves);
  Object.assign(env, {
    PLAYER_SAVE_DATABASE_PATH: path.join(saves, "players.sqlite"),
    LEGACY_PLAYER_SAVE_DIRECTORY: path.join(saves, "characters"),
    PLAYER_SAVE_IMPORT_LEGACY_JSON: "0",
  });
  const modes = path.join(server, "data", "gamemodes");
  if (fs.existsSync(modes)) {
    owned(modes);
    for (const entry of fs.readdirSync(modes, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) owned(path.join(modes, entry.name));
    }
  }
  return { root, server, env, slot, gamePort: 43700 + slot, mcpPort: 49800 + slot };
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", () => reject(new Error(`Port ${port} is already in use; no process was stopped`)));
    listener.listen(port, "127.0.0.1", () => listener.close(resolve));
  });
}

async function main() {
  const config = configuration(path.resolve(__dirname, "../.."));
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({ root: config.root, gamePort: config.gamePort, data: path.join(config.server, "data") }));
    return;
  }
  if (!fs.existsSync(path.join(config.server, "dist", "Server.js"))) throw new Error("Build this worktree's server first: node server/node_modules/typescript/bin/tsc --build server");
  await requireFreePort(config.gamePort);
  Object.assign(process.env, config.env, {
    WEBSOCKET_PORT: String(config.gamePort), AGENT_MCP_PORT: String(config.mcpPort),
    RUNELITE_GATEWAY_ENABLED: "1", WEBRTC_WORLD_TOKEN: "",
  });
  process.chdir(config.server);
  await require(path.join(config.server, "dist", "Server")).Server.main(["1"]);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { configuration, requireFreePort };
