/**
 * Recharging at the guardian mummy in Jalsavrah (Wiki: Pharaoh's_sceptre, Transcript:Guardian_mummy).
 * His talk is the transcript ("I want to charge my sceptre.", npc-dialogues.json); this answers its
 * conditions and does the recharge as he says "Right, ...":
 * - 6 gold, 12 stone or 24 pottery/ivory artefacts of one material, noted ones too;
 * - always to full for the player's Desert Diary, whatever was left ("I don't give discounts");
 * - not while it is already full. The first recharge is remembered (pharaohs_sceptre_mummy_met).
 * Using the sceptre or an artefact on him asks the same.
 */
const Common = require("./Common.PharaohsSceptre");

const MUMMY = "Guardian mummy";
const CHARGE_OPTION = "I want to charge my sceptre.";
const VARIANT = {
  talk: "standard-dialogue-subsequent-dialogue",
  noSceptre: "using-items-on-him-plundered-artefacts-without-having-a-pharaoh-s-sceptre-equipped-or-in-their-inventory",
};

const isMummy = (definition) => definition?.getName?.() === MUMMY;

/** The material a line or condition is about: gold, stone or pottery (ivory counts with it). */
function materialIn(text) {
  const value = text.toLowerCase();
  if (value.includes("gold")) return "gold";
  if (value.includes("stone")) return "stone";
  if (value.includes("pottery") || value.includes("ivory")) return "pottery";
  for (const [material, count] of Object.entries(Common.data.cost)) {
    if (new RegExp(`\\b${count} artefacts`).test(value)) return material;
  }
  return null;
}

/** Artefacts of a material carried, noted ones too: [[id, amount], ...]. */
function carried(player, material) {
  const inventory = player.getInventory();
  const out = [];
  for (const [id, kind] of Common.ids.artefacts) {
    if (kind !== material) continue;
    const amount = inventory.getAmount(id);
    if (amount > 0) out.push([id, amount]);
  }
  return out;
}

function carriedCount(player, material) {
  return carried(player, material).reduce((sum, [, amount]) => sum + amount, 0);
}

function full(player) {
  const found = Common.findSceptre(player, Common.chargedIds());
  return Boolean(found) && Common.charges(player) >= Common.capacity(player);
}

const met = (player) => player.getAttribute(Common.MUMMY_MET_ATTRIBUTE) === true;

function answerCondition({ player, definition, text }) {
  if (!isMummy(definition)) return null;
  const value = String(text).toLowerCase();
  if (!value.includes("sceptre") && !value.includes("artefact")) return null;
  const has = Boolean(Common.findSceptre(player));
  if (value.includes("doesn't have a pharaoh's sceptre")) return !has;
  if (value.includes("for the first time:")) return has && !met(player);
  if (value.includes("already charged a pharaoh's sceptre")) {
    if (value.includes("not fully charged")) return has && met(player) && !full(player);
    if (value.includes("fully charged")) return has && met(player) && full(player);
  }
  if (value.includes("isn't fully charged") || value.includes("not fully charged")) return !full(player);
  if (value.includes("fully charged") || value.includes("cully charged")) return full(player);
  const material = materialIn(value);
  if (material && (value.includes("does not have") || value.includes("not have enough"))) {
    return carriedCount(player, material) < Common.data.cost[material];
  }
  if (material && value.includes("has at least")) return carriedCount(player, material) >= Common.data.cost[material];
  if (value.includes("partially")) return Common.carriedCharges(player) > 0;
  if (value.includes("was uncharged") || value.includes("has no charges")) return Common.carriedCharges(player) === 0;
  return null;
}

/** Takes `count` artefacts of a material, unnoted first. */
function pay(player, material, count) {
  const inventory = player.getInventory();
  let owed = count;
  const stacks = carried(player, material).sort(([a], [b]) => Number(Common.core.ItemDefinition.forId(a)?.isNoted?.() ?? false) - Number(Common.core.ItemDefinition.forId(b)?.isNoted?.() ?? false));
  for (const [id, amount] of stacks) {
    if (owed <= 0) break;
    const take = Math.min(owed, amount);
    inventory.delete(id, take);
    owed -= take;
  }
  inventory.refreshItems?.();
}

/** The recharge: paid, filled to full, the sceptre charged. Returns { before, after } or null. */
function recharge(player, material) {
  const cost = Common.data.cost[material];
  const found = Common.findSceptre(player);
  if (!found || !cost || carriedCount(player, material) < cost || full(player)) return null;
  const before = Common.carriedCharges(player);
  const after = Common.capacity(player);
  pay(player, material, cost);
  if (found.item.getId() !== Common.ids.objs.charged) Common.swapSceptre(player, found, Common.ids.objs.charged);
  player.setAttribute(Common.MUMMY_MET_ATTRIBUTE, true);
  Common.setCharges(player, after);
  return { before, after };
}

const chargesText = (count) => `${count} charge${count === 1 ? "" : "s"}`;

/**
 * "Right, [you already had [x] charge[s], ...] N artefacts gives you [y] charge[s]." - the recharge
 * happens as he says it, and the line gets its numbers.
 */
function onLine(request) {
  if (!isMummy(request.definition) || typeof request.text !== "string") return;
  if (!/^Right, .*artefacts gives you/.test(request.text)) return;
  const material = materialIn(request.text);
  const result = material ? recharge(request.player, material) : null;
  if (!result) {
    request.skip = true;
    return;
  }
  const placeholder = /\[(?:x|y|amount)\] charge\[s\]|\[(?:x|y|amount)\] charges/;
  let text = request.text;
  if (/already had/.test(text)) text = text.replace(placeholder, chargesText(result.before));
  request.text = text.replace(placeholder, chargesText(result.after));
}

/** The sceptre or an artefact used on him: his question about charging, or Simon's artefacts. */
function itemOnMummy(event) {
  const definition = event.definition ?? event.target?.getDefinition?.();
  if (!isMummy(definition)) return;
  const itemId = event.itemId ?? event.item?.getId?.();
  if (!Common.isSceptre(itemId) && !Common.ids.artefacts.has(itemId)) return;
  event.handled = true;
  const { player } = event;
  const npcId = Common.ids.npcs.mummy;
  if (!Common.findSceptre(player)) {
    Common.api.emitCustomEvent("npc-dialogue:start", { player, npc: event.target, npcId, variant: VARIANT.noSceptre, exact: true, handled: false });
    return;
  }
  Common.api.emitCustomEvent("npc-dialogue:start", {
    player, npc: event.target, npcId, variant: VARIANT.talk, exact: true, handled: false,
    select: (steps) => {
      const menu = steps.find((step) => Array.isArray(step.options));
      return menu?.options.find((option) => option.text === CHARGE_OPTION)?.steps ?? steps;
    },
  });
}

function attach(api) {
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", onLine);
  api.onItemOnNpc(itemOnMummy);
}

module.exports = { attach, answerCondition, onLine, itemOnMummy, recharge, carriedCount, materialIn, full };
