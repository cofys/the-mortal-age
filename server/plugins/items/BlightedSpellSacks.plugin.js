// https://oldschool.runescape.wiki/w/Blighted_vengeance_sack: one sack replaces the entire
// rune cost; the spell still checks its book, levels, target and cooldown before payment.
const MAGE_ARENA_BANK_REGION = 10057; // The cave reached by magearena_lever_to_cellar (2539, 4712).
const BLIGHTED_MINIGAMES = new Set(["Castle Wars", "Clan Wars", "Soul Wars"]);

function supplyVengeance(core, event) {
  const { player, spell } = event;
  if (spell.getSpellbook() !== core.MagicSpellbook.LUNAR || !event.items.length ||
      ![core.EffectSpells.VENGEANCE.spellId(), core.EffectSpells.VENGEANCE_OTHER.spellId()].includes(spell.spellId())) return;
  const location = player.getLocation();
  const allowed = core.WorldDefinition.hasGlobalWorldTag("pvp") ||
    core.Wilderness.levelAt(location.getX(), location.getY()) > 0 ||
    (((location.getX() >> 6) << 8) | (location.getY() >> 6)) === MAGE_ARENA_BANK_REGION ||
    BLIGHTED_MINIGAMES.has(player.getArea()?.getName());
  const sackId = core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK;
  if (allowed && player.getInventory().getAmount(sackId) > 0) event.items = [new core.Item(sackId, 1)];
}

module.exports = {
  name: "BlightedSpellSacks",
  members: true,
  register(api) {
    api.onCustomEvent("magic:spell-cost", supplyVengeance.bind(null, api.core));
  },
};
