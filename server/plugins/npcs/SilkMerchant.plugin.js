/**
 * Selling silk to the Silk merchant (Wiki: Silk merchant). Talk-to picks the
 * transcript variant from the player's inventory, and the agreed price from the
 * Wiki dialogue - 20 coins, or 40/50 out of "80 coins.", 50/60 out of "120
 * coins." - buys every un-noted silk in the inventory when the branch reaches
 * its final line. Selling a silk for 60 coins each is an easy Ardougne Diary
 * task. Noted silk is never bought (the transcript refuses it outright), and
 * the "recently stolen" hold is not tracked yet.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Silk_merchant
 * Transcript: https://oldschool.runescape.wiki/w/Transcript:Silk_merchant
 */
const { ItemIdentifiers } = require("../../src/main/typescript/elvarg/util/ItemIdentifiers");

const AGREED_PRICE_ATTRIBUTE = "silk-merchant:agreed-price";

const WIKI_PAGE_DIARY_TASK_KEY = "sell-silk-to-silk-trader-in-ardougne-for-60-coin";

let api;

/**
 * Silk merchant (East Ardougne, Great Kourend).
 */
const SILK_MERCHANT_IDS = new Set([3211, 4583, 8728]);

/** The East Ardougne market, where the Diary task counts. */
const ARDOUGNE_MARKET_BOX = { minX: 2600, maxX: 2700, minY: 3280, maxY: 3330 };

/** The choice texts that agree a sale, and the price they settle on each. */
const AGREED_ON = new Map([
  ["20 coins.", 20],
  ["Ok, 40 sounds good.", 40],
  ["50, and that's my final price.", 50],
  ["Ok, I guess 50 will do.", 50],
  ["I'll give it to you for 60.", 60],
]);

/** The branch-final lines that hand the silks over; `after` performs the sale. */
const SALE_LINES = new Map([
  ["Ok suits me.", 20],
  ["Ok, 40 sounds good.", 40],
  ["Done.", 50],
  ["Ok, I guess 50 will do.", 50],
  ["You drive a hard bargain, but I guess that will have to do.", 60],
]);

/** The choice texts that walk away from a sale, in case one price was already set. */
const PRICES_REJECTED = new Set(["No, that is not enough."]);

/** The transcript variant to play: selling talk with real silk, the refusal with only notes. */
function variantFor(player) {
  const inventory = player.getInventory();
  if (inventory.contains(ItemIdentifiers.SILK)) return "standard-dialogue-with-silk";
  if (inventory.contains(ItemIdentifiers.SILK_2)) return "standard-dialogue-with-only-noted-silk";
  return null;
}

function onDialogueVariant(context) {
  return SILK_MERCHANT_IDS.has(context.npcId) ? variantFor(context.player) : null;
}

function onDialogueChoice(request) {
  if (!SILK_MERCHANT_IDS.has(request.npcId)) return;
  const agreed = AGREED_ON.get(request.option);
  if (agreed) request.player.setAttribute(AGREED_PRICE_ATTRIBUTE, agreed);
  else if (PRICES_REJECTED.has(request.option)) request.player.setAttribute(AGREED_PRICE_ATTRIBUTE, null);
}

/** True when the merchant being talked to stands in the East Ardougne market. */
function inArdougneMarket(npc) {
  const location = npc?.getLocation?.();
  return !!location && location.x >= ARDOUGNE_MARKET_BOX.minX && location.x <= ARDOUGNE_MARKET_BOX.maxX
    && location.y >= ARDOUGNE_MARKET_BOX.minY && location.y <= ARDOUGNE_MARKET_BOX.maxY;
}

/** The whole business: every un-noted silk in the inventory for the agreed price each. */
function sellSilk(player, price) {
  const inventory = player.getInventory();
  const silk = inventory.getAmount(ItemIdentifiers.SILK);
  if (silk <= 0) return;
  inventory.delete(ItemIdentifiers.SILK, silk);
  inventory.adds(ItemIdentifiers.COINS, silk * price);
  player.setAttribute(AGREED_PRICE_ATTRIBUTE, null);
}

function onDialogueLine(request) {
  if (!SILK_MERCHANT_IDS.has(request.npcId)) return;
  const agreed = SALE_LINES.get(request.text);
  if (agreed == null || request.player.getAttribute(AGREED_PRICE_ATTRIBUTE) !== agreed) return;
  const { player, npc, npcId } = request;
  request.after = () => {
    sellSilk(player, agreed);
    if (agreed === 60 && inArdougneMarket(npc)) {
      api.emitCustomEvent("diary:task", { player, npcId, diary: "ardougne", task: WIKI_PAGE_DIARY_TASK_KEY });
    }
  };
}

module.exports = {
  name: "SilkMerchant",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    api.onNpcDialogueVariant(onDialogueVariant);
    api.onCustomEvent("npc-dialogue:choice", onDialogueChoice);
    api.onCustomEvent("npc-dialogue:line", onDialogueLine);
  },
  _test: {
    AGREED_PRICE_ATTRIBUTE,
    variantFor,
    onDialogueVariant,
    onDialogueChoice,
    sellSilk,
    onDialogueLine,
    inArdougneMarket,
  },
};
