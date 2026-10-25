const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const Drops = require('../plugins/npcs/NpcDrops.plugin');
const dump = require('../data/definitions/npc-drops.json');

test('The Feud keeps one champion reward when the canonical conditional rows are imported', async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    const core = PluginManager.getCoreApi();
    const listeners = new Map();
    let questDeath;
    const api = new Proxy({
        core, onNpcDeath(handler) { questDeath ??= handler; },
        onCustomEvent(name, handler) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(handler);
        },
        emitCustomEvent(name, event) { for (const handler of listeners.get(name) || []) handler(event); },
    }, { get: (object, name) => object[name] ?? (() => {}) });
    require('../plugins/quests/quests/TheFeud.Quest')(api);
    Drops.register(api);
    const blackjack = core.ItemIdentifiers.WILLOW_BLACKJACK;
    const scimitar = core.ItemIdentifiers.ADAMANT_SCIMITAR;
    for (const questFirst of [false, true]) for (const hasBlackjack of [false, true]) {
        const player = new Player(null);
        player.getPacketSender = () => new Proxy({}, { get: () => () => {} });
        if (hasBlackjack) player.getInventory().adds(blackjack, 1);
        const npcId = core.NpcIdentifiers.BANDIT_CHAMPION;
        const npc = { getId: () => npcId };
        let drops;
        const roll = () => Drops.__internals.rollTable(dump.tables.bandit_champion, player, npc);
        if (!questFirst) drops = roll();
        questDeath({ killer: player, npcId, npc });
        if (questFirst) drops = roll();
        assert.deepEqual(drops.map(drop => drop.itemId), [core.ItemIdentifiers.BONES],
            'the general table does not duplicate the quest-owned conditional rewards');
        assert.equal(player.getInventory().getAmount(blackjack), 1);
        assert.equal(player.getInventory().getAmount(scimitar), hasBlackjack ? 1 : 0);
    }
    const context = { handledItemIds: new Set() };
    api.emitCustomEvent('npc-drops:context', { npcId: core.NpcIdentifiers.MAN, context });
    assert.equal(context.handledItemIds.size, 0, 'unrelated NPC loot remains untouched');
});
