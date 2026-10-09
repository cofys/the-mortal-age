// Gives every weapon in the cache its weapon type (`weaponInterface` in
// data/definitions/item-gameplay.json), from the OSRS Wiki's combat style for it.
//
//   yarn sync:weapon-types                       # fetch the Wiki and update the file
//   yarn sync:weapon-types --dry-run             # print what would change
//   yarn sync:weapon-types --wiki wiki.json      # use (or, with --save, write) a saved Wiki copy
//
// For each weapon in the cache (worn in the weapon slot, not a note or placeholder):
// - the Wiki's combat style ("Slash Sword", "Crossbow", ...) gives the cache weapon category
//   (dbtable 78, by row name: combat_interface_hacksword, ...);
// - a weapon type whose category already matches is kept;
// - otherwise the type comes from a weapon with the same name, or the same name without a
//   variant suffix ("(or)", "(p++)", "(nz)", ...), in that category; otherwise from the
//   category's types by name (CHOOSE_BY_NAME), or its only type;
// - a weapon still on the human stance animations gets its source's (or its type's usual) ones;
// - weapons the Wiki has no style for keep their type, or take a same-name weapon's.
// A weapon without a type is already unarmed, so "Unarmed" is only written over another type or
// for a weapon with an attack speed in the cache.
// Unresolved weapons with an attack speed in the cache are listed, never guessed; the rest
// (things held in the weapon slot that aren't weapons) are only counted.
//
// Needs the cache in server/caches - run `yarn ensure-cache` first.
import * as fs from "fs";
import path = require("path");

import { CachePipeline } from "../src/main/typescript/elvarg/game/cache/CachePipeline";
import { CacheDefinitions } from "../src/main/typescript/elvarg/game/cache/CacheDefinitions";
import { CacheIndexDat2 } from "../src/main/typescript/elvarg/game/cache/codec/rs/cache/CacheIndex";
import { IndexType } from "../src/main/typescript/elvarg/game/cache/codec/rs/cache/IndexType";
import type { CombatStyleDefinitions } from "../src/main/typescript/elvarg/game/content/combat/CombatStyleDefinitions";
import { readCategoryNumbers } from "./combat-style-table";

const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "tsps-weapon-types (https://github.com/RSPSApp/tsps)";
const WEAPON_SLOT = 3;
const PAGE = 5000;

/** The Wiki's combat styles -> the cache's weapon category rows (combat_interface_<name>). */
const WIKI_STYLE_CATEGORY: Record<string, string> = {
    "unarmed": "unarmed", "axe": "axe", "blunt": "blunt", "bludgeon": "blunt_bludgeon", "bow": "bow",
    "claw": "claw", "crossbow": "crossbow", "salamander": "flamer", "chinchompas": "grenade",
    "gun": "gun", "blaster": "gun", "slash sword": "hacksword", "slash": "hacksword",
    "2h sword": "heavysword", "pickaxe": "pickaxe", "polearm": "polearm", "polestaff": "polestaff",
    "scythe": "scythe", "spear": "spear", "banner": "banner", "spiked": "spiked",
    "stab sword": "stabsword", "staff": "staff", "bladed staff": "staff_bladed", "thrown": "thrown",
    "whip": "whip", "powered staff": "staff_selfpowering", "powered wand": "wand_selfpowering",
    "bulwark": "bulwark", "partisan": "partisan", "multi-style": "tribrid", "multi-melee": "multi_melee",
    "flail": "slashflail",
};

/** Within a category with several weapon types, the first matching name wins; else the last entry. */
const CHOOSE_BY_NAME: Record<string, Array<[RegExp | null, string]>> = {
    axe: [[/greataxe/i, "GREATAXE"], [null, "BATTLEAXE"]],
    blunt: [[/granite (maul|hammer)/i, "GRANITE_MAUL"], [/elder maul/i, "ELDER_MAUL"], [null, "WARHAMMER"]],
    bow: [[/dark bow/i, "DARK_BOW"], [/long ?bow/i, "LONGBOW"], [null, "SHORTBOW"]],
    crossbow: [[/karil/i, "KARILS_CROSSBOW"], [/ballista/i, "BALLISTA"], [null, "CROSSBOW"]],
    hacksword: [[/longsword/i, "LONGSWORD"], [null, "SCIMITAR"]],
    heavysword: [[/godsword/i, "GODSWORD"], [/saradomin('s blessed)? sword/i, "SARADOMIN_SWORD"], [null, "TWO_HANDED_SWORD"]],
    spiked: [[/flail/i, "VERACS_FLAIL"], [null, "MACE"]],
    stabsword: [
        [/abyssal dagger/i, "ABYSSAL_DAGGER"], [/dragon dagger/i, "DRAGON_DAGGER"], [/rapier/i, "GHRAZI_RAPIER"],
        [/fang/i, "FANG"], [/dagger|keris|knife/i, "DAGGER"], [null, "SWORD"],
    ],
    staff: [[/ancient staff/i, "ANCIENT_STAFF"], [null, "STAFF"]],
    thrown: [
        [/blowpipe/i, "BLOWPIPE"], [/knife/i, "KNIFE"], [/toktz-xil-ul/i, "OBBY_RINGS"], [/thrownaxe/i, "THROWNAXE"],
        [/javelin/i, "JAVELIN"], [null, "DART"],
    ],
    blunt_bludgeon: [[/bludgeon/i, "ABYSSAL_BLUDGEON"], [null, "MAUL"]],
};

/** Variant suffixes a weapon shares its type with its base for. */
const VARIANT_SUFFIX = /\s*\((or|i|p\+\+|p\+|p|kp|nz|u|uncharged|empty|full|deadman|bh|l|e|cr|t|g)\)\s*$/i;

const STANCE_FIELDS = ["blockAnim", "standAnim", "walkAnim", "runAnim", "standTurnAnim", "turn180Anim", "turn90CWAnim", "turn90CCWAnim"] as const;
const HUMAN_STANCE: Record<string, number> = {
    blockAnim: 424, standAnim: 808, walkAnim: 819, runAnim: 824, standTurnAnim: 823,
    turn180Anim: 820, turn90CWAnim: 821, turn90CCWAnim: 822,
};

type ItemRow = Record<string, any> & { id: number; name: string };
type Wiki = { bonuses: any[]; items: any[] };

function argValue(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function bucket(query: string): Promise<any[]> {
    const url = `${WIKI_API}?${new URLSearchParams({ action: "bucket", format: "json", query })}`;
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Wiki ${response.status} for ${query}`);
    return (await response.json()).bucket ?? [];
}

async function allRows(select: string): Promise<any[]> {
    const rows: any[] = [];
    for (let offset = 0; ; offset += PAGE) {
        const page = await bucket(`${select}.limit(${PAGE}).offset(${offset}).run()`);
        rows.push(...page);
        if (page.length < PAGE) return rows;
    }
}

async function loadWiki(): Promise<Wiki> {
    const file = argValue("--wiki");
    if (file && fs.existsSync(file) && !process.argv.includes("--save")) return JSON.parse(fs.readFileSync(file, "utf8"));
    const wiki = {
        bonuses: await allRows("bucket('infobox_bonuses').select('page_name','page_name_sub','combat_style')"),
        items: await allRows("bucket('infobox_item').select('page_name','page_name_sub','item_id')"),
    };
    if (file) fs.writeFileSync(file, JSON.stringify(wiki));
    return wiki;
}

/** Item id -> the Wiki's combat style (lower case), joined on the page version, else the page. */
function wikiStyles(wiki: Wiki): Map<number, string> {
    const bySub = new Map<string, string>();
    const byPage = new Map<string, Set<string>>();
    for (const row of wiki.bonuses) {
        const style = String(row.combat_style ?? "").trim().toLowerCase();
        if (!style) continue;
        bySub.set(row.page_name_sub ?? row.page_name, style);
        if (!byPage.has(row.page_name)) byPage.set(row.page_name, new Set());
        byPage.get(row.page_name)!.add(style);
    }
    const styles = new Map<number, string>();
    for (const row of wiki.items) {
        const pageStyles = byPage.get(row.page_name);
        const style = bySub.get(row.page_name_sub ?? row.page_name) ?? (pageStyles?.size === 1 ? [...pageStyles][0] : undefined);
        if (!style) continue;
        for (const id of row.item_id ?? []) {
            const itemId = Number(id);
            if (Number.isInteger(itemId)) styles.set(itemId, style);
        }
    }
    return styles;
}

const ATTACK_SPEED_PARAM = 14;

function cacheWeapons(): Map<number, string> {
    const weapons = new Map<number, string>();
    for (let id = 0; id < CacheDefinitions.getCounts().items; id++) {
        const item = CacheDefinitions.getItem(id);
        if (!item?.name || item.name.toLowerCase() === "null" || item.wearPos !== WEAPON_SLOT) continue;
        if (item.noteTemplate !== -1 || item.placeholderTemplate !== -1) continue;
        weapons.set(id, item.name);
    }
    return weapons;
}

/** Older exports wrote 821 (walk left) for both side turns. */
const HUMAN_TURN_90_CCW_OLD = 821;

function hasHumanStance(row: ItemRow | undefined): boolean {
    return !row || STANCE_FIELDS.every((field) => row[field] === undefined || row[field] === HUMAN_STANCE[field]
        || (field === "turn90CCWAnim" && row[field] === HUMAN_TURN_90_CCW_OLD));
}

/** The type most weapons of a name have in a category, when it's a clear majority (not `id`'s own row). */
function commonType(namesakes: ItemRow[], id: number, category: number | undefined): string | undefined {
    const counts = new Map<string, number>();
    for (const row of namesakes) {
        if (row.id === id || !row.weaponInterface) continue;
        counts.set(row.weaponInterface, (counts.get(row.weaponInterface) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return undefined;
    return ranked[0][0];
}

function stanceOf(row: ItemRow): Record<string, number> {
    return Object.fromEntries(STANCE_FIELDS.map((field) => [field, row[field] ?? HUMAN_STANCE[field]]));
}

/** Writes `weaponInterface` right after `equipmentType`, as the file has it. */
function withInterface(row: ItemRow, weaponInterface: string): ItemRow {
    const out: ItemRow = {} as ItemRow;
    let placed = false;
    for (const [key, value] of Object.entries(row)) {
        if (key === "weaponInterface") continue;
        out[key] = value;
        if (key === "equipmentType") {
            out.weaponInterface = weaponInterface;
            placed = true;
        }
    }
    if (!placed) out.weaponInterface = weaponInterface;
    return out;
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    await CachePipeline.initialize(path.resolve(__dirname, ".."));
    const definitions = path.resolve(__dirname, "..", "data", "definitions");
    const itemsPath = path.join(definitions, "item-gameplay.json");
    const styles = JSON.parse(fs.readFileSync(path.join(definitions, "item-combat-styles.json"), "utf8")) as CombatStyleDefinitions;
    const configs = CacheIndexDat2.fromStore(IndexType.DAT2.configs, CachePipeline.getStore());
    const categoryNumber = readCategoryNumbers(configs);
    const wikiStyle = wikiStyles(await loadWiki());

    const rows: ItemRow[] = JSON.parse(fs.readFileSync(itemsPath, "utf8"));
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const interfaceCategory = (name: string | undefined) => (name ? styles.weaponInterfaces[name]?.category : undefined);
    const typesByCategory = new Map<number, string[]>();
    for (const [name, weapon] of Object.entries(styles.weaponInterfaces)) {
        if (!typesByCategory.has(weapon.category)) typesByCategory.set(weapon.category, []);
        typesByCategory.get(weapon.category)!.push(name);
    }

    const weapons = cacheWeapons();
    /** Typed weapons by name, for copying a type (and stance) to a variant. */
    const typedByName = new Map<string, ItemRow[]>();
    for (const row of rows) {
        if (!row.weaponInterface || !weapons.has(row.id)) continue;
        const key = row.name.toLowerCase();
        if (!typedByName.has(key)) typedByName.set(key, []);
        typedByName.get(key)!.push(row);
    }
    /** The usual stance for a type: the most common non-human one among its weapons. */
    const usualStance = new Map<string, Record<string, number>>();
    for (const type of Object.keys(styles.weaponInterfaces)) {
        const counts = new Map<string, { stance: Record<string, number>; n: number }>();
        for (const row of rows) {
            if (row.weaponInterface !== type || hasHumanStance(row)) continue;
            const stance = stanceOf(row);
            const key = JSON.stringify(stance);
            counts.set(key, { stance, n: (counts.get(key)?.n ?? 0) + 1 });
        }
        const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
        if (best) usualStance.set(type, best.stance);
    }

    const sourceFor = (name: string, category: number | undefined) => {
        for (const candidate of [name.toLowerCase(), name.replace(VARIANT_SUFFIX, "").toLowerCase()]) {
            const match = (typedByName.get(candidate) ?? [])
                .find((row) => category === undefined || interfaceCategory(row.weaponInterface) === category);
            if (match) return match;
        }
        return undefined;
    };

    const changes: string[] = [];
    const unresolved: string[] = [];
    const renamed: string[] = [];
    let holdables = 0;
    const added: ItemRow[] = [];
    // Weapons the Wiki has a style for first, so the rest can take a type given in this run.
    const order = [...weapons].sort(([a], [b]) => Number(!wikiStyle.has(a)) - Number(!wikiStyle.has(b)));
    for (const [id, name] of order) {
        // The loader skips a row whose name differs from the cache item's. A renamed item's row
        // ("Mith crossbow", "Iron dart(p)") gets the cache's name back, keeping its data; a "Null"
        // row (exported before the item existed, with no data) is replaced.
        let existing = rowById.get(id);
        if (existing && existing.name !== name && existing.name.toLowerCase() !== "null") {
            renamed.push(`${existing.name} (${id}) -> ${name}`);
            existing = { ...existing, name };
            rows[rows.indexOf(rowById.get(id)!)] = existing;
            rowById.set(id, existing);
        }
        const stale = existing !== undefined && existing.name !== name;
        const row = stale ? undefined : existing;
        const style = wikiStyle.get(id);
        const categoryName = style ? WIKI_STYLE_CATEGORY[style] : undefined;
        if (style && !categoryName) {
            unresolved.push(`${name} (${id}): Wiki style "${style}" has no category`);
            continue;
        }
        const category = categoryName ? categoryNumber.get(categoryName) : undefined;
        const current = row?.weaponInterface as string | undefined;
        if (current && (category === undefined || interfaceCategory(current) === category)) {
            // A right category, but a copy still on the human stance (an ornament "Granite maul" left
            // a warhammer) where a weapon of the same name has its real data: that one's type and stance.
            const namesakeType = hasHumanStance(row) ? commonType(typedByName.get(name.toLowerCase()) ?? [], id, interfaceCategory(current)) : undefined;
            const model = namesakeType
                ? (typedByName.get(name.toLowerCase()) ?? []).find((typed) => typed.weaponInterface === namesakeType && !hasHumanStance(typed))
                : undefined;
            if (row && model && namesakeType !== current) {
                const next = { ...withInterface(row, namesakeType!), ...stanceOf(model) };
                rows[rows.indexOf(row)] = next;
                changes.push(`${name} (${id}): ${current} -> ${namesakeType} and stance, from ${model.name} ${model.id}`);
                const key = name.toLowerCase();
                typedByName.set(key, [...(typedByName.get(key) ?? []).filter((typed) => typed.id !== id), next]);
                continue;
            }
            // Right type already: a variant still on the human stance takes its namesake's stance.
            const namesake = hasHumanStance(row) ? sourceFor(name, interfaceCategory(current)) : undefined;
            if (row && namesake && namesake.id !== id && !hasHumanStance(namesake)) {
                const next = { ...row, ...stanceOf(namesake) };
                rows[rows.indexOf(row)] = next;
                changes.push(`${name} (${id}): stance from ${namesake.name} ${namesake.id}`);
                const key = name.toLowerCase();
                typedByName.set(key, [...(typedByName.get(key) ?? []).filter((typed) => typed.id !== id), next]);
            }
            continue;
        }

        const source = sourceFor(name, category);
        let type = source?.weaponInterface as string | undefined;
        if (!type && category !== undefined) {
            const types = typesByCategory.get(category) ?? [];
            const rules = CHOOSE_BY_NAME[categoryName!];
            type = rules ? rules.find(([pattern]) => !pattern || pattern.test(name))?.[1] : types.length === 1 ? types[0] : undefined;
            if (type && !types.includes(type)) type = undefined;
        }
        if (!type) {
            const fights = CacheDefinitions.getItem(id).params?.get(ATTACK_SPEED_PARAM) !== undefined;
            if (fights) unresolved.push(`${name} (${id}): ${style ? `no weapon type for category ${categoryName}` : "no Wiki style and no same-name weapon"}`);
            else holdables++;
            continue;
        }
        // Untyped is already unarmed: only weapons (with an attack speed) get it written.
        if (type === "UNARMED" && !current && CacheDefinitions.getItem(id).params?.get(ATTACK_SPEED_PARAM) === undefined) continue;

        // An unarmed "weapon" has no usual stance (they are mostly one-off novelty items).
        const usual = type === "UNARMED" ? undefined : usualStance.get(type);
        const stance = hasHumanStance(row) ? (source && !hasHumanStance(source) ? stanceOf(source) : usual) : undefined;
        const base: ItemRow = row ?? { id, name, equipmentType: "WEAPON" };
        let next = withInterface(base, type);
        if (stance) next = { ...next, ...stance };
        changes.push(`${name} (${id}): ${current ?? "none"} -> ${type}${source ? ` (from ${source.name} ${source.id})` : ""}${stance ? ", stance" : ""}${stale ? ", replaces a stale entry" : row ? "" : ", new entry"}`);
        if (existing) rows[rows.indexOf(existing)] = next;
        else added.push(next);
        const key = name.toLowerCase();
        typedByName.set(key, [...(typedByName.get(key) ?? []).filter((typed) => typed.id !== id), next]);
    }

    for (const line of renamed) console.log(`renamed ${line}`);
    for (const line of changes) console.log(line);
    for (const line of unresolved) console.warn(`UNRESOLVED ${line}`);
    console.log(
        `${changes.length} weapon(s) changed (${added.length} new entries), ${renamed.length} renamed, ${unresolved.length} unresolved, ` +
            `${holdables} held item(s) without an attack speed left as they are`,
    );
    if (dryRun) return;
    const all = [...rows, ...added].sort((a, b) => a.id - b.id);
    fs.writeFileSync(itemsPath, "[\n" + all.map((row) => `  ${JSON.stringify(row)}`).join(",\n") + "\n]\n");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
