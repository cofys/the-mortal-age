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

/** Runs `fn` with every random roll hitting (0 is below every published weight). */
function withLuckyDrops(fn) {
    const original = Math.random;
    Math.random = () => 0;
    try {
        return fn();
    } finally {
        Math.random = original;
    }
}

test('Rag and Bone Man bones only drop while their quest still needs them', async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    const core = PluginManager.getCoreApi();
    const listeners = new Map();
    const api = new Proxy({
        core,
        onCustomEvent(name, handler) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(handler);
        },
        emitCustomEvent(name, event) { for (const handler of listeners.get(name) || []) handler(event); },
    }, { get: (object, name) => object[name] ?? (() => {}) });
    require('../plugins/quests/quests/RagAndBoneManI.Quest')(api);
    require('../plugins/quests/quests/RagAndBoneManII.Quest')(api);
    Drops.register(api);

    const player = () => new Player(null);
    const roll = (p, tableId, npcId) => Drops.__internals.rollTable(
        dump.tables[tableId], p, { getId: () => npcId },
    );
    const itemIds = drops => drops.map(drop => drop.itemId);
    const ratBone = core.ItemIdentifiers.RAT_BONE;
    const giantRatBone = core.ItemIdentifiers.GIANT_RAT_BONE;
    const bones = core.ItemIdentifiers.BONES;

    // Regular rats drop no bones at all; their row is the 1/4 rat bone, and only during II.
    const idle = player();
    assert.ok(!itemIds(withLuckyDrops(() => roll(idle, 'rat', core.NpcIdentifiers.RAT_6))).includes(ratBone),
        'a rat does not drop its bone before Rag and Bone Man II');

    const questingII = player();
    questingII.setAttribute('quest.rag_and_bone_man_ii.stage', 1);
    assert.ok(itemIds(withLuckyDrops(() => roll(questingII, 'rat', core.NpcIdentifiers.RAT_6))).includes(ratBone),
        'the rat bone drops while Rag and Bone Man II is in progress');

    // Stronghold rats keep their 100% bones and stay without the quest bone.
    assert.deepEqual(itemIds(withLuckyDrops(() => roll(player(), 'rat_2', core.NpcIdentifiers.RAT_4))), [bones]);

    const handedIn = player();
    handedIn.setAttribute('quest.rag_and_bone_man_ii.stage', 1);
    handedIn.setAttribute('quest.rag_and_bone_man_ii.bones', 1 << 2); // rat bone is the third species
    assert.ok(!itemIds(withLuckyDrops(() => roll(handedIn, 'rat', core.NpcIdentifiers.RAT_6))).includes(ratBone),
        'a bone already handed in stops dropping');

    const completedII = player();
    completedII.setAttribute('quest.rag_and_bone_man_ii.stage', 2);
    assert.ok(!itemIds(withLuckyDrops(() => roll(completedII, 'rat', core.NpcIdentifiers.RAT_6))).includes(ratBone),
        'a completed quest no longer drops its bones');

    // Giant rats always drop regular bones; the giant rat bone needs Rag and Bone Man I.
    const idleGiantRat = itemIds(withLuckyDrops(() => roll(player(), 'giant_rat_drop_table3', core.NpcIdentifiers.GIANT_RAT_4)));
    assert.ok(idleGiantRat.includes(bones));
    assert.ok(!idleGiantRat.includes(giantRatBone), 'a giant rat does not drop its bone before Rag and Bone Man I');

    const questingI = player();
    questingI.setAttribute('quest.rag_and_bone_man_i.stage', 1);
    assert.ok(itemIds(withLuckyDrops(() => roll(questingI, 'giant_rat_drop_table3', core.NpcIdentifiers.GIANT_RAT_4))).includes(giantRatBone),
        'the giant rat bone drops while Rag and Bone Man I is in progress');
});
