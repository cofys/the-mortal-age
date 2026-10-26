import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Requirements, type PlayerSnapshot, type RoutingSettings } from "../game/plugins/shortestpath/requirement/Requirements";
import { loadTransports } from "../game/plugins/shortestpath/resources";
import {
    addTransportsFromContents,
    parseItems,
    parseItemVariations,
    parseSkills,
    parseTsv,
    parseVarRequirements,
    QUEST_POINTS_INDEX,
    SKILL_LEVELS_LENGTH,
    TOTAL_LEVEL_INDEX,
    type Transport,
} from "../game/plugins/shortestpath/transport/Transport";
import { TransportType } from "../game/plugins/shortestpath/transport/TransportType";
import { packWorldPoint as p, UNDEFINED } from "../game/plugins/shortestpath/WorldPointUtil";

const variations = parseItemVariations(readFileSync("public/shortestpath/item-variations.tsv", "utf8"));

// --- TsvParser: commented or bare header, CRLF, comment rows, empty cells ------------------------
{
    const records = parseTsv("# Origin\tDestination\tDuration\r\n# a comment\r\n3200 3200 0\t3201 3201 1\t4\r\n\r\n\t3300 3300 0\t\r\n");
    assert.equal(records.length, 2);
    assert.equal(records[0].get("Origin"), "3200 3200 0");
    assert.equal(records[0].get("Duration"), "4");
    assert.equal(records[1].get("Origin"), "", "an empty cell is kept");
    assert.equal(parseTsv("Destination\tItems\n3221 3218 0\t\n")[0].get("Destination"), "3221 3218 0", "a bare header");
}

// --- Field parsers --------------------------------------------------------------------------------
{
    const skills = parseSkills("70 Agility;50 Strength;Max Total;32 Quest");
    assert.equal(skills.length, SKILL_LEVELS_LENGTH);
    assert.equal(skills[16], 70);
    assert.equal(skills[2], 50);
    assert.equal(skills[TOTAL_LEVEL_INDEX], 2147483647, "Max is the most the index allows");
    assert.equal(skills[QUEST_POINTS_INDEX], 32);
    assert.deepEqual(parseVarRequirements("4070=0;10032>0;4560&2;892@30", "VARBIT").map((r) => [r.id, r.checkType, r.value]),
        [[4070, "=", 0], [10032, ">", 0], [4560, "&", 2], [892, "@", 30]]);

    const runes = parseItems("AIR_RUNE=3&&FIRE_RUNE=1&&LAW_RUNE=1", variations)!;
    assert.equal(runes.requirements.length, 3, "three AND groups");
    assert.ok(runes.requirements[0].branches[0].itemIds!.includes(556), "AIR_RUNE names the air rune");
    assert.ok(runes.requirements[0].branches[0].staffIds!.includes(1381), "and the staffs that stand in for it");
    const glory = parseItems("1712=1||1710=1", variations)!;
    assert.deepEqual(glory.requirements[0].branches.map((b) => b.itemIds), [[1712], [1710]], "an OR group of raw ids");
    assert.equal(parseItems("AXE=1|UNLOCK_CANOE_AXE=1", variations)!.requirements[0].branches[1].unlock, "CANOE_AXE");
    assert.throws(() => parseItems("UNLOCK_NOT_A_THING=1", variations), /Unknown unlock/);
}

// --- ResourceLoader: two-way rows, teleports and permutations -------------------------------------
{
    const transports = new Map<number, Transport[]>();
    addTransportsFromContents(transports, [
        "# Origin\tDestination\tmenuOption menuTarget objectID\tSkills\tQuests\tDuration\tDisplay info",
        "2412 4434 0\t\tConfigure Fairy ring 29560\t\t\t5\t",
        "2996 3114 0\t\tConfigure Fairy ring 29495\t\t\t5\t",
        "\t2571 2956 0\t\t\t\t5\tA K S",
        "\t2996 3118 0\t\t\t\t5\tA I Q",
    ].join("\n"), TransportType.FAIRY_RING, variations);
    const fromZanaris = transports.get(p(2412, 4434, 0))!;
    assert.deepEqual(fromZanaris.map((t) => t.displayInfo), ["A K S", "A I Q"], "each origin pairs with each destination");
    const fromAiq = transports.get(p(2996, 3114, 0))!;
    assert.deepEqual(fromAiq.map((t) => t.displayInfo), ["A K S"], "but not with its own ring, within the radius threshold");
    assert.equal(fromAiq[0].objectInfo, "Configure Fairy ring 29495");

    const teleports = new Map<number, Transport[]>();
    addTransportsFromContents(teleports, "# Destination\tItems\tSkills\tDuration\tDisplay info\n3213 3424 0\tLAW_RUNE=1&AIR_RUNE=3&FIRE_RUNE=1\t25 Magic\t\tVarrock Teleport\n",
        TransportType.TELEPORTATION_SPELL, variations);
    const varrock = teleports.get(UNDEFINED)![0];
    assert.equal(varrock.destination, p(3213, 3424, 0), "a teleport has no origin");
    assert.equal(varrock.duration, 1, "a teleport always costs at least a tick");
    assert.equal(varrock.skillLevels[6], 25);

    const shortcuts = new Map<number, Transport[]>();
    addTransportsFromContents(shortcuts, "# Origin\tDestination\tSkills\n3000 3000 0\t3001 3001 0\t11 Agility;37 Ranged;19 Strength\n", TransportType.AGILITY_SHORTCUT, variations);
    assert.equal(shortcuts.get(p(3000, 3000, 0))![0].type, TransportType.GRAPPLE_SHORTCUT, "a crossbow shortcut is a grapple");
}

// --- Requirements: the gate chain over the bundled transports -------------------------------------
async function main(): Promise<void> {
    const all = await loadTransports(async (path) => readFileSync(`public/${path}`, "utf8"));
    assert.ok(all.length > 10000, "every bundled TSV loads");
    const find = (display: string, type = TransportType.TELEPORTATION_SPELL) => {
        const found = all.find((t) => t.type === type && t.displayInfo === display);
        assert.ok(found, display);
        return found!;
    };
    const levels = new Array<number>(SKILL_LEVELS_LENGTH).fill(1);
    const player: { -readonly [K in keyof PlayerSnapshot]: PlayerSnapshot[K] } = {
        levels, questState: () => "NOT_STARTED", varbit: () => 0, varp: () => 0, carried: new Map(), bank: null, currentTimeMinutes: 29_000_000,
    };
    const settings: { -readonly [K in keyof RoutingSettings]: RoutingSettings[K] } = {
        enabled: () => true, cost: (key) => (key === "costTeleportationSpells" ? 7 : 0), teleportationItem: "INVENTORY_NON_CONSUMABLE",
        currencyThreshold: 100000, respawnPrifddinas: false, declaredUnlocks: new Set(),
    };
    const check = (t: Transport) => new Requirements(player, settings).check(t);

    const varrock = find("Varrock Teleport");
    assert.equal(check(varrock), "SKILL_LEVEL");
    levels[6] = 25;
    assert.equal(check(varrock), "ITEM_REQUIREMENT", "no runes");
    player.carried = new Map([[563, 1], [556, 3], [554, 1]]);
    assert.equal(check(varrock), null, "runes in the inventory");
    player.carried = new Map([[563, 1], [554, 1], [1381, 1]]);
    assert.equal(check(varrock), null, "a staff of air stands in for the air runes");
    player.varbit = (id) => (id === 4070 ? 1 : 0);
    assert.equal(check(varrock), "VARBIT", "not on the standard spellbook");
    player.varbit = () => 0;
    assert.equal(new Requirements(player, settings).additionalCost(varrock), 7, "the type's threshold prices it");
    settings.enabled = (key) => key !== "useTeleportationSpells";
    assert.equal(check(varrock), "TYPE_DISABLED");
    settings.enabled = () => true;

    // A quest gate: a non-consumable teleport item that needs a quest.
    const ectophial = all.find((t) => t.type === TransportType.TELEPORTATION_ITEM && t.quests.length > 0 && !t.isConsumable
        && t.varRequirements.length === 0 && t.skillLevels.every((l) => l === 0) && t.itemRequirements?.requirements.length === 1
        && t.itemRequirements.requirements[0].branches[0].itemIds?.length === 1);
    assert.ok(ectophial, "a quest-gated teleport item");
    const itemId = ectophial!.itemRequirements!.requirements[0].branches[0].itemIds![0];
    player.carried = new Map([[itemId, 1]]);
    assert.equal(check(ectophial!), "QUEST");
    player.questState = () => "FINISHED";
    assert.equal(check(ectophial!), null);

    // Teleportation item modes: "None" drops them; "(perm)" drops consumables.
    const consumable = all.find((t) => t.type === TransportType.TELEPORTATION_ITEM && t.isConsumable && t.quests.length === 0
        && t.varRequirements.length === 0 && t.skillLevels.every((l) => l === 0))!;
    assert.equal(check(consumable), "TELEPORT_MODE");
    settings.teleportationItem = "ALL";
    assert.equal(check(consumable), null, "All doesn't check items");
    settings.teleportationItem = "NONE";
    assert.equal(check(ectophial!), "TYPE_DISABLED");
    settings.teleportationItem = "INVENTORY_AND_BANK";
    player.carried = new Map();
    player.bank = new Map([[itemId, 1]]);
    assert.equal(check(ectophial!), null, "the bank counts with Inventory and Bank");
    settings.teleportationItem = "INVENTORY";
    assert.equal(check(ectophial!), "ITEM_REQUIREMENT", "but not with Inventory");

    // Whole networks wait for their quest; fairy rings also for a Dramen staff.
    const glider = all.find((t) => t.type === TransportType.GNOME_GLIDER)!;
    player.questState = () => "NOT_STARTED";
    assert.equal(check(glider), "TYPE_DISABLED", "gnome gliders before The Grand Tree");
    const ring = all.find((t) => t.type === TransportType.FAIRY_RING && t.quests.length === 0 && t.varRequirements.length === 0 && t.skillLevels.every((l) => l === 0))!;
    player.varbit = (id) => (id === 2326 ? 40 : 0);
    assert.equal(check(ring), "ITEM_REQUIREMENT", "a fairy ring needs a Dramen staff");
    player.carried = new Map([[772, 1]]);
    assert.equal(check(ring), null);

    // A spirit tree grown in a farming patch counts as not planted (no SpiritTreeService).
    player.questState = () => "FINISHED";
    const toPortSarim = all.find((t) => t.type === TransportType.SPIRIT_TREE && t.displayInfo === "7: Port Sarim")!;
    assert.equal(check(toPortSarim), "PLANTED_SPIRIT_TREE");
    const toVillage = all.find((t) => t.type === TransportType.SPIRIT_TREE && t.displayInfo?.endsWith("Tree Gnome Village")
        && t.skillLevels.every((l) => l === 0) && t.varRequirements.length === 0)!;
    assert.equal(check(toVillage), null, "the gnome trees still work");

    console.log("shortest-path-transports: ok");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
