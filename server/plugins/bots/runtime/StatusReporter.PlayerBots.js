const fs = require("fs");
const path = require("path");
const {
  createBotDiagnosticsSnapshot,
  renderBotDiagnosticsLines,
} = require("./DiagnosticsSnapshot.PlayerBots");

class BotStatusReporter {
  constructor(options = {}) {
    this.api = options.api ?? null;
    this.botStatesByName = options.botStatesByName ?? new Map();
    this.recentBotLogsByUsername = options.recentBotLogsByUsername ?? new Map();
    this.peekMovementRequest = options.peekMovementRequest ?? (() => null);
    this.runtimeEventLoggingEnabled = options.runtimeEventLoggingEnabled === true;
    this.recentLogLines = Number.isFinite(options.recentLogLines)
      ? Math.max(1, Math.floor(options.recentLogLines))
      : 8;
    this.diagnoseLogPath =
      typeof options.diagnoseLogPath === "string" && options.diagnoseLogPath.length > 0
        ? options.diagnoseLogPath
        : null;

    if (this.diagnoseLogPath) {
      try {
        fs.mkdirSync(path.dirname(this.diagnoseLogPath), { recursive: true });
      } catch (_) {
        // Keep diagnostics optional and non-fatal.
      }
    }
  }

  buildStatusPayload(bot) {
    if (!bot) {
      return null;
    }

    const username = bot.getUsername?.();
    const state = username ? this.botStatesByName.get(username) : null;
    const snapshot = createBotDiagnosticsSnapshot({
      bot,
      state,
      nowMs: Date.now(),
      peekMovementRequest: this.peekMovementRequest,
      recentBotLogsByUsername: this.recentBotLogsByUsername,
    });
    const lines = renderBotDiagnosticsLines({
      bot,
      snapshot,
      runtimeEventLoggingEnabled: this.runtimeEventLoggingEnabled,
      recentLogLines: this.recentLogLines,
    });
    return {
      username: username ?? null,
      state,
      snapshot,
      lines,
    };
  }

  sendStatus(viewer, bot) {
    if (!viewer || !bot) {
      return;
    }

    const viewerSender = viewer.getPacketSender?.();
    if (!viewerSender?.sendMessage) {
      return;
    }

    const payload = this.buildStatusPayload(bot);
    if (!payload) {
      return;
    }

    for (const line of payload.lines) {
      viewerSender.sendMessage(line);
    }

    this.api?.log?.("bot_status_requested", {
      requester: viewer.getUsername?.(),
      target: payload.username,
      mode: payload.state?.mode ?? null,
    });
  }

  dumpToDiagnoseLog(requester, bot, reason = "follow_click") {
    if (!this.diagnoseLogPath) {
      return;
    }

    const payload = this.buildStatusPayload(bot);
    if (!payload) {
      return;
    }

    try {
      const requesterName = requester?.getUsername?.() ?? "unknown";
      const targetName = payload.username ?? "unknown";
      const mode = payload.state?.mode ?? "n/a";
      const timestamp = new Date().toISOString();
      const lines = [
        `[${timestamp}] reason=${reason} requester=${requesterName} target=${targetName} mode=${mode}`,
      ];
      for (const line of payload.lines) {
        lines.push(`  ${line}`);
      }

      const recentHistory = Array.isArray(payload.snapshot?.recentHistory)
        ? payload.snapshot.recentHistory
        : [];
      if (recentHistory.length > 0) {
        lines.push("  [Recent Bot Runtime Logs]");
        for (const line of recentHistory.slice(-this.recentLogLines)) {
          lines.push(`  ${line}`);
        }
      }

      const equipmentLines = this.buildContainerLines("Equipment", bot?.getEquipment?.()?.getCopiedItems?.() ?? []);
      for (const line of equipmentLines) {
        lines.push(`  ${line}`);
      }

      const inventoryLines = this.buildContainerLines("Inventory", bot?.getInventory?.()?.getCopiedItems?.() ?? []);
      for (const line of inventoryLines) {
        lines.push(`  ${line}`);
      }

      lines.push("");
      fs.appendFileSync(this.diagnoseLogPath, `${lines.join("\n")}\n`, "utf8");
    } catch (_) {
      // Never disrupt player interaction due to diagnostics logging failure.
    }
  }

  buildContainerLines(label, items) {
    const validItems = Array.isArray(items)
      ? items.filter((item) => item && typeof item.getId === "function" && item.getId() > 0)
      : [];
    const lines = [`[${label}]`];
    if (validItems.length === 0) {
      lines.push("empty");
      return lines;
    }
    for (const item of validItems) {
      const id = item.getId?.() ?? -1;
      const amount = item.getAmount?.() ?? 0;
      const name = item.getDefinition?.()?.getName?.() ?? `item:${id}`;
      lines.push(`${name} x${amount} (id=${id})`);
    }
    return lines;
  }
}

module.exports = {
  BotStatusReporter,
};
