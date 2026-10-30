// Writes plugins/quests/data/quest-start-text.json: for every quest in the cache's quest table
// (dbtable 0), how its journal overview says it starts, from the OSRS Wiki's journal transcript
// (Transcript:<quest>/Journal, "Before starting the quest").
//
//   yarn sync:quest-start-text             # fetch the Wiki and update the file
//   yarn sync:quest-start-text --dry-run   # print what would change
//
// The overview script (questjournal_overview_setup) writes "I can start this quest by " itself,
// so the file holds the rest of the sentence, in the colours live OSRS sends it:
// "talking to <col=800000>Morgan<col=000080> at his home in <col=800000>Draynor Village<col=000080>."
// The Wiki has journal transcripts for only some quests. Entries already in the file that the
// Wiki has no start text for are kept: they come from live OSRS captures of the overview
// (rsprox captures, https://rsprox.net/database). Quests with neither are listed, never guessed.
//
// Needs the cache in server/caches - run `yarn ensure-cache` first.
import * as fs from "fs";
import path = require("path");

import { CachePipeline } from "../src/main/typescript/elvarg/game/cache/CachePipeline";
import { CacheDefinitions } from "../src/main/typescript/elvarg/game/cache/CacheDefinitions";

const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "tsps-quest-start-text (https://github.com/RSPSApp/tsps)";
const QUEST_TABLE = 0;
const TITLES_PER_QUERY = 50;
const OUTPUT = path.resolve(__dirname, "../plugins/quests/data/quest-start-text.json");
const NAVY = "000080";
const START = /^I can start this (?:mini)?quest by (.+)$/i;

/** Page wikitext by title, following redirects; missing pages are left out. */
async function wikitext(titles: string[]): Promise<Map<string, string>> {
    const pages = new Map<string, string>();
    for (let i = 0; i < titles.length; i += TITLES_PER_QUERY) {
        const batch = titles.slice(i, i + TITLES_PER_QUERY);
        // Redirected and normalised titles resolve back to the title asked for.
        const asked = new Map<string, string>(batch.map((title) => [title, title]));
        // A batch's content can be larger than one response holds; the Wiki says where to go on.
        let resume: Record<string, string> | undefined = {};
        while (resume) {
            const params = new URLSearchParams({
                action: "query", format: "json", formatversion: "2", redirects: "1", prop: "revisions",
                rvprop: "content", rvslots: "main", titles: batch.join("|"), ...resume,
            });
            const response = await fetch(`${WIKI_API}?${params}`, { headers: { "User-Agent": USER_AGENT } });
            if (!response.ok) throw new Error(`Wiki query failed: ${response.status}`);
            const json: any = await response.json();
            for (const { from, to } of [...(json.query.normalized ?? []), ...(json.query.redirects ?? [])]) {
                asked.set(to, asked.get(from) ?? from);
            }
            for (const page of json.query.pages ?? []) {
                const content = page.revisions?.[0]?.slots?.main?.content;
                if (content) pages.set(asked.get(page.title) ?? page.title, content);
            }
            resume = json.continue;
        }
    }
    return pages;
}

/** {{Colour|#hex|text}} (innermost first) as client colour tags inside a navy line. */
function clientText(wiki: string): string {
    let text = wiki
        .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
        .replace(/'''?/g, "");
    const colour = /\{\{Colou?r\|#?([0-9a-fA-F]{6})\|([^{}]*)\}\}/;
    for (let match = colour.exec(text); match; match = colour.exec(text)) {
        const hex = match[1].toLowerCase();
        const inner = hex === NAVY ? match[2] : `<col=${hex}>${match[2]}<col=${NAVY}>`;
        text = text.slice(0, match.index) + inner + text.slice(match.index + match[0].length);
    }
    return text.trim();
}

/**
 * The start sentence after "I can start this quest by", or null. Transcripts put it in a bullet
 * under a "before starting" heading, or, for older quests, in a <poem> wrapped over several lines.
 */
function startText(transcript: string): string | null {
    const lines = transcript.replace(/<!--[\s\S]*?-->|<\/?poem>/g, "").split("\n").map((line) => line.trim());
    for (let i = 0; i < lines.length; i++) {
        let text = clientText(lines[i].replace(/^\*+\s*/, ""));
        if (!START.test(text)) continue;
        // A wrapped sentence goes on until a line that ends it.
        while (!/[.!?](<col=[0-9a-f]{6}>)?$/.test(text) && lines[i + 1] && !/^[*=]/.test(lines[i + 1])) {
            text += " " + clientText(lines[++i]);
        }
        return START.exec(text)![1].replace(/\s+/g, " ").replace(/ (<col=[0-9a-f]{6}>)? /g, " $1");
    }
    return null;
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    await CachePipeline.initialize(path.resolve(__dirname, ".."));
    const nameColumn = CacheDefinitions.getDbColumn(QUEST_TABLE, "displayname");
    if (nameColumn === null) throw new Error("quest table has no displayname column");
    const names = [...new Set(CacheDefinitions.getDbTableRows(QUEST_TABLE)
        .map((row) => row.column(nameColumn)?.[0])
        .filter((name): name is string => typeof name === "string" && /[a-z]/i.test(name)))]
        .sort();
    // A quest sharing its name with something else has its transcript under "<name> (miniquest)".
    const titles = (name: string) => [name, `${name} (quest)`, `${name} (miniquest)`].map((page) => `Transcript:${page}/Journal`);
    const pages = await wikitext(names.flatMap(titles));
    const previous: Record<string, string> = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, "utf8")) : {};
    const result: Record<string, string> = {};
    const missing: string[] = [];
    let fromWiki = 0;
    for (const name of names) {
        const page = titles(name).map((title) => pages.get(title)).find(Boolean);
        const wiki = page ? startText(page) : null;
        if (wiki) fromWiki++;
        const text = wiki ?? previous[name];
        if (text) result[name] = text;
        else missing.push(name);
    }
    const changed = Object.keys({ ...previous, ...result }).filter((name) => previous[name] !== result[name]);
    for (const name of changed) console.log(`${name}: ${previous[name] ?? "(none)"} -> ${result[name] ?? "(none)"}`);
    console.log(`${Object.keys(result).length} of ${names.length} quests have a start text (${fromWiki} from the Wiki), ${changed.length} changed.`);
    if (missing.length) console.log(`No start text: ${missing.join(", ")}`);
    if (!dryRun) fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
