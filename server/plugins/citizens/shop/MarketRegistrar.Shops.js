"use strict";

/**
 * MarketRegistrar — DIEGETIC ::shop replacement (no-commands migration, phase 2).
 *
 * Jon's directive: no ::commands for players. Everything through the world.
 * An "Information clerk" — the crown's market registrar — stands beside the
 * market board in each capital's trade hub. Talk to them and a chatbox
 * dialogue (the proven sendMultiChatboxPrompt pattern) opens the stall
 * business:
 *
 *   THE MARKET REGISTRAR
 *   "I'd like to lease a stall."  — the existing buy flow (PlayerShops.buyStall)
 *   "Manage my stall."            — stock / price / hire / till sub-menus
 *   "How does this work?"         — explainer
 *
 * Nothing here reimplements shop logic. The lease goes to
 * PlayerShops.buyStall (same upfront, same rent, same kingdom), stocking and
 * pricing to stockStall / unstockStall / priceStall, hiring and firing to
 * hireEmployee / fireEmployee, the till to collectTill / claimReturns /
 * showInfo, and closing to closeOwnStall — the same functions the ::shop
 * command calls, driven by free-text and amount prompts instead of command
 * arguments. The Market Board (phase 1) already covers browse; the registrar
 * covers the trader's side of the counter.
 *
 * The ::shop command stays registered until the registrar is verified
 * in-game, then it goes. Migration rule: build the world path, verify it
 * works, remove the command. Never the reverse.
 *
 * Verify: talk to the registrar in a capital market, walk each option
 * (lease, stock a ware, set its price, hire a commoner, take from the
 * till, close the stall), and confirm the outcomes match ::shop.
 */

const { NpcIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const { CAPITALS } = require("../../../world/DiegeticObjects");
const PlayerShops = require("./PlayerShops");
const KingdomStore = require("../../kingdoms/KingdomStore");

// Information clerk (1909) — cache NPC (NpcIds.INFORMATION_CLERK), unused
// anywhere else in the world, so our global hook is the only Talk-to path.
const REGISTRAR_NPC_ID = NpcIds.INFORMATION_CLERK;
// Beside the market board (which sits at +3/+0), one tile east.
const REGISTRAR_OFFSET = { dx: 4, dy: 0 };

let pluginApi = null;
// Spawned registrar positions: [{ x, y, z, capitalId }]
const registrars = [];

function kingdomName(kingdomId) {
  return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
}

/** Which kingdom's market is the player standing in? Mirrors the Market Board. */
function kingdomAt(player) {
  try {
    const pos = player.getLocation?.();
    const x = pos.getX?.() ?? 0;
    const y = pos.getY?.() ?? 0;
    let best = null;
    let bestD = 60; // must be within 60 tiles of a market
    for (const m of CAPITALS) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) {
        bestD = d;
        best = m.id;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function spawnRegistrars() {
  for (const capital of CAPITALS) {
    const x = capital.x + REGISTRAR_OFFSET.dx;
    const y = capital.y + REGISTRAR_OFFSET.dy;
    const z = capital.z;
    try {
      const npc = pluginApi.spawnNpc({
        id: REGISTRAR_NPC_ID,
        x,
        y,
        z,
        wanderRadius: 0, // the registrar stays at their post
      });
      if (npc) {
        registrars.push({ x, y, z, capitalId: capital.id });
      }
    } catch (error) {
      console.warn("[market-registrar] spawn failed", {
        capital: capital.id,
        error: error?.message ?? error,
      });
    }
  }
  console.info("[market-registrar] registrars spawned", { count: registrars.length });
}

/** Is this location one of our spawned registrars? (id + location gate). */
function registrarAt(location) {
  const x = location?.x ?? location?.getX?.() ?? 0;
  const y = location?.y ?? location?.getY?.() ?? 0;
  const z = location?.z ?? location?.getZ?.() ?? 0;
  return registrars.some(
    (r) => Math.abs(r.x - x) <= 2 && Math.abs(r.y - y) <= 2 && r.z === z
  );
}

function showPrompt(player, title, pairs) {
  try {
    return pluginApi.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[market-registrar] prompt failed", error?.message ?? error);
    player.sendMessage("The registrar is momentarily buried in ledgers. Try again.");
    return false;
  }
}

/** Free-text prompt ("enter name") that resumes into onInput. */
function promptText(player, title, onInput) {
  try {
    player.setEnteredSyntaxAction({
      execute: (input) => {
        try {
          player.setEnteredSyntaxAction(null);
        } catch {
          // Clearing is cosmetic.
        }
        onInput(input);
      },
    });
    player.getPacketSender().sendEnterInputPrompt(title);
  } catch {
    onInput(null);
  }
}

/** Numeric prompt that resumes into onInput. */
function promptAmount(player, title, onInput) {
  try {
    player.setEnteredAmountAction({
      execute: (amount) => {
        try {
          player.setEnteredAmountAction(null);
        } catch {
          // Clearing is cosmetic.
        }
        onInput(amount);
      },
    });
    player.getPacketSender().sendEnterAmountPrompt(title);
  } catch {
    onInput(null);
  }
}

// ---------------------------------------------------------------------------
// The flows — every one ends in an existing PlayerShops function.
// ---------------------------------------------------------------------------

function doLease(player) {
  const api = pluginApi;
  if (!api) return;
  const kingdomId = kingdomAt(player);
  if (!kingdomId) {
    player.sendMessage("This registrar serves no market I know. Try a capital's trade hub.");
    showRegistrar(player);
    return;
  }
  PlayerShops.buyStall(api, player, kingdomId);
  showRegistrar(player);
}

function doStock(player) {
  const api = pluginApi;
  if (!api) return;
  const pairs = [
    "Add to the shelves.",
    () =>
      promptText(player, "Which item do you want to stock?", (item) => {
        if (String(item ?? "").trim().length === 0) {
          showManage(player);
          return;
        }
        promptAmount(player, "How many? (blank = all you carry)", (amount) => {
          PlayerShops.stockStall(api, player, String(item).trim(), amount || null);
          showManage(player);
        });
      }),
    "Take wares back.",
    () =>
      promptText(player, "Which ware do you want to take back?", (item) => {
        if (String(item ?? "").trim().length === 0) {
          showManage(player);
          return;
        }
        promptAmount(player, "How many? (blank = the lot)", (amount) => {
          PlayerShops.unstockStall(api, player, String(item).trim(), amount || null);
          showManage(player);
        });
      }),
    "Back.",
    () => showManage(player),
  ];
  showPrompt(player, "The shelves of your stall", pairs);
}

function doPrice(player) {
  const api = pluginApi;
  if (!api) return;
  const stall = PlayerShops.requireStall(player);
  if (!stall) {
    showRegistrar(player);
    return;
  }
  const ids = Object.keys(stall.stock ?? {});
  if (ids.length === 0) {
    player.sendMessage("Your stall holds no wares — stock the shelves first.");
    showManage(player);
    return;
  }
  const pairs = [];
  for (const key of ids.slice(0, 4)) {
    const id = Number(key);
    const label = `${PlayerShops.wareName(api, id)} — ${stall.prices?.[key] ?? "?"} each`;
    pairs.push(label, () =>
      promptAmount(player, `New price for ${PlayerShops.wareName(api, id)}?`, (price) => {
        PlayerShops.priceStall(api, player, String(id), price);
        showManage(player);
      })
    );
  }
  pairs.push("Back.", () => showManage(player));
  showPrompt(player, "Set a price", pairs);
}

function doHire(player) {
  const api = pluginApi;
  if (!api) return;
  const stall = PlayerShops.requireStall(player);
  if (!stall) {
    showRegistrar(player);
    return;
  }
  if (stall.employee) {
    const pairs = [
      `Dismiss ${stall.employee}.`,
      () => {
        PlayerShops.fireEmployee(api, player);
        showManage(player);
      },
      "Keep them on.",
      () => showManage(player),
    ];
    showPrompt(player, `${stall.employee} minds your stall`, pairs);
    return;
  }
  // The hire flow lists who's looking, then asks for the name — the same
  // function ::shop hire calls, driven diegetically instead of by command args.
  PlayerShops.hireEmployee(api, player, null);
  promptText(player, "Type the commoner's name to hire (blank to cancel)", (name) => {
    const text = String(name ?? "").trim();
    if (text.length > 0) {
      PlayerShops.hireEmployee(api, player, text);
    }
    showManage(player);
  });
}

function doClose(player) {
  const api = pluginApi;
  if (!api) return;
  if (!PlayerShops.requireStall(player)) {
    showRegistrar(player);
    return;
  }
  const pairs = [
    "Yes — close it.",
    () => {
      PlayerShops.closeOwnStall(api, player);
      showRegistrar(player);
    },
    "Keep trading.",
    () => showTill(player),
  ];
  showPrompt(player, "Close your stall? Stock and till wait for your claim.", pairs);
}

function showTill(player) {
  const api = pluginApi;
  if (!api) return;
  if (!PlayerShops.requireStall(player)) {
    showRegistrar(player);
    return;
  }
  const pairs = [
    "Take coins from the till.",
    () =>
      promptAmount(player, "How many coins? (blank = the lot)", (amount) => {
        PlayerShops.collectTill(api, player, amount || null);
        showTill(player);
      }),
    "Collect waiting returns.",
    () => {
      PlayerShops.claimReturns(api, player);
      showTill(player);
    },
    "How's business?",
    () => {
      PlayerShops.showInfo(api, player);
      showTill(player);
    },
    "Close my stall for good.",
    () => doClose(player),
    "Back.",
    () => showManage(player),
  ];
  showPrompt(player, "The till and the books", pairs);
}

function showManage(player) {
  const api = pluginApi;
  if (!api) return;
  if (!PlayerShops.requireStall(player)) {
    showRegistrar(player);
    return;
  }
  const pairs = [
    "Stock the shelves.",
    () => doStock(player),
    "Set a price.",
    () => doPrice(player),
    "Hire or dismiss help.",
    () => doHire(player),
    "Till, returns, and closing.",
    () => showTill(player),
    "Back.",
    () => showRegistrar(player),
  ];
  showPrompt(player, "Manage your stall", pairs);
}

function doExplainer(player) {
  player.sendMessage(
    "The registrar keeps the market records for the crown. Lease a stall from me, and I'll keep your books straight."
  );
  player.sendMessage(
    "A stall costs an upfront fee plus weekly rent from the till. Stock it from your pack, set your prices, " +
      "and hire a commoner to mind it while you're away — a stall trades while you sleep, as long as someone minds it."
  );
  player.sendMessage(
    "Every sale pays the crown its 5% market tax. Wages and rent leave the till on their own. " +
      "Close your stall and whatever waits in it sits with me until you claim it."
  );
  showRegistrar(player);
}

/** The registrar's audience: the four doors into the existing shop flows. */
function showRegistrar(player) {
  if (!player) return;
  const kingdomId = kingdomAt(player);
  const title = kingdomId
    ? `The market registrar — ${kingdomName(kingdomId)}`
    : "The market registrar";
  const pairs = [
    "I'd like to lease a stall.",
    () => doLease(player),
    "Manage my stall.",
    () => showManage(player),
    "How does this work?",
    () => doExplainer(player),
    "Take my leave.",
    () => {},
  ];
  showPrompt(player, title, pairs);
}

function talkToRegistrar(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  showRegistrar(player);
}

/** Global handler + id/location gate; the NPC name never enters into it. */
function onRegistrarInteraction(event) {
  const { player, npcId, location } = event ?? {};
  if (!player || player.isPlayerBot?.() === true) return;
  if (npcId !== REGISTRAR_NPC_ID) return;
  if (!registrarAt(location)) return;
  event.handled = true;
  talkToRegistrar(player);
}

function initMarketRegistrar(api) {
  pluginApi = api;
  api.onNpcInteraction(onRegistrarInteraction);
  // Spawn after the world is ready — delay one tick, like DiegeticObjects.
  try {
    const Task = api.core.Task;
    api.core.TaskManager.submit(
      new (class extends Task {
        constructor() {
          super(2, false);
        }
        execute() {
          try {
            spawnRegistrars();
          } catch (error) {
            console.warn("[market-registrar] spawn failed", error?.message ?? error);
          }
          this.stop?.();
        }
      })()
    );
  } catch {
    // Fallback: try immediately.
    spawnRegistrars();
  }
  console.info("[market-registrar] diegetic ::shop replacement ready (phase 2)");
}

module.exports = { initMarketRegistrar };
