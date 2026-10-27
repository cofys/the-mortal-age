const Common = require('./Common.ElementalSpells');
// The Fractured Archive's elemental fragments (Wiki: Fragment of whispering wind, deep water,
// living earth, burning fire): Break one to permanently raise the base max hit of that element's
// spells by 2. The Wiki doesn't say whether more fragments stack, so each element counts once
// (estimate). One bit an element (1 wind, 2 water, 4 earth, 8 fire).
const FRAGMENTS_ATTRIBUTE = 'elemental-spells:fragments';
const BONUS = 2;
const FRAGMENTS = [['Fragment of whispering wind', 1], ['Fragment of deep water', 2],
  ['Fragment of living earth', 3], ['Fragment of burning fire', 4]];
function bit(element) { return 1 << (element - 1); }
function bonus(player, element) {
  return ((Number(player.getAttribute(FRAGMENTS_ATTRIBUTE)) || 0) & bit(element)) ? BONUS : 0;
}
function breakFragment(player, item, element) {
  if (bonus(player, element)) { player.sendMessage('You have already absorbed that element.'); return true; }
  player.getInventory().deleteNumber(item.getId(), 1);
  player.setAttribute(FRAGMENTS_ATTRIBUTE, (Number(player.getAttribute(FRAGMENTS_ATTRIBUTE)) || 0) | bit(element));
  player.sendMessage(`The fragment crumbles. Your ${['wind', 'water', 'earth', 'fire'][element - 1]} spells are permanently stronger.`);
  return true;
}
function attach(api) {
  api.persistAttribute(FRAGMENTS_ATTRIBUTE, 0);
  for (const [name, element] of FRAGMENTS) {
    api.onItemAction(name, { Break: ({ player, item }) => breakFragment(player, item, element) });
  }
}
module.exports = { attach, bonus, FRAGMENTS_ATTRIBUTE };
