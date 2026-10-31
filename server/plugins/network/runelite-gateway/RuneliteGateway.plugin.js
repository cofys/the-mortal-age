"use strict";

const { snapshotChunks } = require("./Snapshots.RuneliteGateway");
const CHANNEL = "runelite-gateway";
const subscribers = new WeakSet();

function send(core, player, data) {
  return player.getSession().sendClientPacket(core.encodePluginMessage(CHANNEL, data));
}

function receiveMessage(core, event) {
  if (event.channel !== CHANNEL) return;
  event.handled = true;
  if (event.data.type === "unsubscribe") {
    subscribers.delete(event.player);
    return;
  }
  if (event.data.type !== "subscribe") return;
  subscribers.delete(event.player);
  if (process.env.RUNELITE_GATEWAY_ENABLED !== "1") {
    send(core, event.player, { type: "disabled" });
  } else if (event.data.version !== 1) {
    send(core, event.player, { type: "error", reason: "unsupported-version" });
  } else {
    subscribers.add(event.player);
    send(core, event.player, { type: "subscribed", version: 1 });
  }
}

function syncViews(core, event) {
  if (!subscribers.has(event.player)) return;
  if (process.env.RUNELITE_GATEWAY_ENABLED !== "1") {
    subscribers.delete(event.player);
    return;
  }
  try {
    for (const chunk of snapshotChunks(event)) {
      if (!send(core, event.player, chunk)) break;
    }
  } catch (error) {
    subscribers.delete(event.player);
    send(core, event.player, { type: "error", reason: "snapshot-too-large" });
    console.warn("[runelite-gateway] Snapshot rejected", error.message);
  }
}

function clearPlayer({ player }) {
  subscribers.delete(player);
}

module.exports = {
  name: "RuneliteGateway",
  register(api) {
    api.onCustomEvent("network:plugin-message", receiveMessage.bind(null, api.core));
    api.onCustomEvent("network:sync-views", syncViews.bind(null, api.core));
    api.onPlayerLogout(clearPlayer);
    api.onPlayerDisconnect(clearPlayer);
  },
};
