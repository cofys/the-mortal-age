const core = require("./Core.Farming");

// Cache revision 241: the original three gods' equipment-affiliation flags.
const SARADOMIN_ITEM_PARAM = 40;
const ZAMORAK_ITEM_PARAM = 41;
const GUTHIX_ITEM_PARAM = 42;

// Bandos, Armadyl and Zaros equipment has no corresponding cache parameter.
// Explicit families from the OSRS Wiki God Wars Dungeon god-related protection table:
// https://oldschool.runescape.wiki/w/God_Wars_Dungeon#God-related_protection
// Exact names, rather than deity-name fragments, keep neutral items neutral.
const OTHER_GOD_FAMILIES = new Set([
    "Ancient mace", "Bandos godsword", "Bandos crozier", "Book of war", "Bandos kiteshield",
    "Bandos d'hide shield", "Bandos full helm", "Bandos coif", "Bandos mitre", "Bandos halo",
    "Bandos cloak", "Bandos chestplate", "Bandos platebody", "Bandos d'hide body", "Bandos robe top",
    "Bandos tassets", "Bandos platelegs", "Bandos chaps", "Bandos plateskirt", "Bandos robe legs",
    "Bandos bracers", "Bandos d'hide boots", "Bandos boots", "Guardian boots", "Echo boots",
    "War blessing", "Bandos stole",
    "Armadyl godsword", "Armadyl crossbow", "Armadyl crozier", "Craw's bow", "Webweaver bow",
    "Book of law", "Armadyl kiteshield", "Armadyl d'hide shield", "Armadyl helmet", "Armadyl coif",
    "Armadyl full helm", "Armadyl mitre", "Armadyl halo", "Armadyl cloak", "Armadyl chestplate",
    "Armadyl platebody", "Armadyl d'hide body", "Armadyl robe top", "Armadyl chainskirt",
    "Armadyl platelegs", "Armadyl chaps", "Armadyl plateskirt", "Armadyl robe legs", "Armadyl bracers",
    "Armadyl d'hide boots", "Honourable blessing", "Armadyl pendant", "Armadyl stole",
    "Ancient godsword", "Ancient staff", "Ancient sceptre", "Ancient crozier", "Venator bow",
    "Zaryte crossbow", "Book of darkness", "Ancient kiteshield", "Ancient d'hide shield", "Ancient coif",
    "Ancient full helm", "Ancient mitre", "Ancient halo", "Ancient ceremonial mask", "Torva full helm",
    "Virtus mask", "Hood of darkness", "Ancient cloak", "Imbued ancient cape", "Imbued ancient max cape",
    "Imbued ancient max hood", "Ancient platebody", "Ancient d'hide body", "Ancient robe top",
    "Torva platebody", "Virtus robe top", "Ancient ceremonial top", "Robe top of darkness",
    "Ancient platelegs", "Ancient chaps", "Ancient plateskirt", "Ancient robe legs", "Torva platelegs",
    "Virtus robe bottom", "Ancient ceremonial legs", "Robe bottom of darkness", "Ancient bracers",
    "Zaryte vambraces", "Ancient ceremonial gloves", "Gloves of darkness", "Ancient d'hide boots",
    "Ancient ceremonial boots", "Boots of darkness", "Ancient blessing", "Ancient stole",
    // The Torva and Ancient sceptre pages document these same-faction upgrades.
    "Sanguine torva full helm", "Sanguine torva platebody", "Sanguine torva platelegs",
    "Blood ancient sceptre", "Ice ancient sceptre", "Smoke ancient sceptre", "Shadow ancient sceptre",
].map(name => name.toLowerCase()));

// Published cosmetic, locked, charge and Deadman forms of those same families.
const FAMILY_SUFFIX = / \((?:or|l|c|i|u|uncharged|inactive|deadman)\)$/;
function isOtherGodFamily(name) {
    let family = name.toLowerCase();
    while (FAMILY_SUFFIX.test(family)) family = family.replace(FAMILY_SUFFIX, "");
    return OTHER_GOD_FAMILIES.has(family);
}

function outfitProblem(player) {
    let zamorak = false;
    for (const [slot, item] of player.getEquipment().getItems().entries()) {
        if (!item || item.getId() <= 0 || item.getAmount() <= 0) continue;
        const cached = core.CacheDefinitions.getItem(item.getId());
        if (cached.wearPos !== slot || cached.noteTemplate >= 0 || cached.placeholderTemplate >= 0) continue;
        if (cached.params?.get(SARADOMIN_ITEM_PARAM) === 1 || cached.params?.get(GUTHIX_ITEM_PARAM) === 1
            || isOtherGodFamily(cached.name)) return "Remove equipment dedicated to other gods first.";
        if (cached.params?.get(ZAMORAK_ITEM_PARAM) === 1) zamorak = true;
    }
    return zamorak ? null : "Wear an item dedicated to Zamorak first.";
}

Object.assign(module.exports, { outfitProblem });
