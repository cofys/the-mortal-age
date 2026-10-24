import { strict as assert } from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatChanged } from "@runelite/api/events";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { IndexType } from "../rs/cache/IndexType";
import { OVERALL_ICON_SPRITE, skillIconSprite } from "../rs/skill/skillIcons";
import { SKILL_IDS, SkillId } from "../rs/skill/skills";
import { SpriteLoader } from "../rs/sprite/SpriteLoader";
import { XpPanel } from "../game/plugins/xptracker/XpPanel";
import { XpTrackerPlugin } from "../game/plugins/xptracker/XpTrackerPlugin";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// Every skill icon (and the total's) is a 25x25 sprite in the cache.
const info = loadCacheList(loadCacheInfos()).latest;
const cache = CacheSystem.fromFiles(info, loadCache(info).files);
const sprites = cache.getIndex(IndexType.DAT2.sprites);
for (const id of [...SKILL_IDS.map(skillIconSprite), OVERALL_ICON_SPRITE]) {
    const sprite = SpriteLoader.loadIntoIndexedSprite(sprites, id);
    assert.ok(sprite && sprite.width === 25 && sprite.height === 25, `skill icon sprite ${id}`);
}
assert.equal(new Set(SKILL_IDS.map(skillIconSprite)).size, SKILL_IDS.length, "one icon per skill");

async function main(): Promise<void> {
    const client: any = { gameState: 30, localPlayerName: "Panel", varManager: { getVarp: () => 0 } };
    const plugin = new XpTrackerPlugin(client);
    await plugin.start();
    const render = () => renderToStaticMarkup(React.createElement(XpPanel, { plugin }));
    assert.match(render(), /You have not gained experience yet\./);

    for (const skill of SKILL_IDS) plugin.onStatChanged(new StatChanged(skill, 1000, 9, 9));
    plugin.onGameTick();
    plugin.onGameTick();
    plugin.onStatChanged(new StatChanged(SkillId.Attack, 1040, 9, 9));
    plugin.onStatChanged(new StatChanged(SkillId.Cooking, 1040, 9, 9));
    const html = render();
    assert.match(html, /Gained: <span[^>]*>80<\/span>/);
    assert.match(html, /Per hour: /);
    assert.match(html, /XP Gained: <span[^>]*>40<\/span>/);
    assert.match(html, /XP Left: /);
    assert.match(html, /Lvl\. 9/);
    assert.match(html, /Lvl\. 10/);
    // Attack is a combat skill: no action labels, and a one-line tooltip.
    const attack = html.slice(html.indexOf('data-skill="Attack"'), html.indexOf('data-skill="Cooking"'));
    assert.doesNotMatch(attack, /Actions: /);
    const cooking = html.slice(html.indexOf('data-skill="Cooking"'));
    assert.match(cooking, /Actions: /);
    assert.match(cooking, /title="1 Actions done/);
    await plugin.stop();
}

main()
    .then(() => console.log("xp tracker panel tests passed"))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
