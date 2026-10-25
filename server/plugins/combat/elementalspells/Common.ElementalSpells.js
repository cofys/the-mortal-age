const ELEMENTS = ['WIND', 'WATER', 'EARTH', 'FIRE'];
const FAMILIES = new Set(['STRIKE', 'BOLT', 'BLAST', 'WAVE', 'SURGE']);
const spells = new Map();
const families = new Map();
const amulets = new Map();
let core;

function init(api) {
  core = api.core;
  spells.clear(); families.clear(); amulets.clear();
  for (const [name, spell] of Object.entries(core.CombatSpells)) {
    const [element, family] = name.split('_');
    if (!ELEMENTS.includes(element) || !FAMILIES.has(family) || name !== element+'_'+family || typeof spell?.spellId !== 'function') continue;
    const entry = { element: ELEMENTS.indexOf(element)+1, family, spell };
    spells.set(spell.spellId(), entry);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(entry);
  }
  for (const [index, name] of ['AIR','WATER','EARTH','FIRE'].entries()) {
    const id = core.ItemIdentifiers['AMULET_OF_'+name];
    if (Number.isInteger(id)) amulets.set(index+1, id);
  }
}
function metadata(spell) { return spells.get(spell?.spellId?.()) ?? null; }
function familyMaximum(entry, level) {
  const members = families.get(entry.family);
  const learned = members.filter(m => m.spell.levelRequired() <= level);
  return learned.length ? Math.max(...learned.map(m => m.spell.maximumHit()))
    : members.reduce((lowest, m) => m.spell.levelRequired() < lowest.spell.levelRequired() ? m : lowest).spell.maximumHit();
}
function weakness(target, spell) {
  const entry = metadata(spell);
  if (!entry || !target?.isNpc?.()) return 0;
  const value = target.getAsNpc().getCurrentDefinition().getElementalWeakness();
  return value?.type === entry.element ? value.percent : 0;
}
function matchingAmulet(player, element) {
  const id = player.getEquipment().get(core.Equipment.AMULET_SLOT)?.getId?.();
  return id === core.ItemIdentifiers.ELEMENTAL_AMULET || id === amulets.get(element);
}
module.exports = { init, metadata, familyMaximum, weakness, matchingAmulet, get core() { return core; } };
