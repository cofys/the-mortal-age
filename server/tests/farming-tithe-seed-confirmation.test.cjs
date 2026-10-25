const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Tithe;
const TIERS = [['Golovanova', 34], ['Bologano', 54], ['Logavano', 74]];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Tithe = require('../plugins/skills/farming/Tithe.Farming');
    Data.initializeFarmingData();
});
function prepare(t, tier = 0, { boosted = false } = {}) {
    const player = new Player(null), [name, level] = TIERS[tier];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    player.moveTo(new core.Location(1802, 3501, 0));
    player.getSkillManager().setMaxLevels(core.Skill.FARMING, boosted ? level - 1 : level, false)
        .setCurrentLevel(core.Skill.FARMING, level, false);
    let entries;
    t.mock.method(Patches, 'choose', (_player, options) => { entries = options; });
    Tithe.titheObject({ player, object: { getId: () => core.ObjectIdentifiers.SEED_TABLE,
        getLocation: () => new core.Location(1802, 3501, 0) } });
    entries[tier][1]();
    assert.deepEqual(entries.map(([label]) => label), ['Take 100', 'Take 1000', 'Take 10000']);
    const take = entries.map(([, callback]) => callback), id = Data.itemId(name + ' seed');
    return { player, level, id, take: quantity => take[quantity ?? 0](),
        inventory: player.getInventory(), seeds: () => player.getInventory().getAmount(id) };
}
test('a decayed boost cannot take seeds after the quantity menu opens', t => {
    for (let tier = 0; tier < TIERS.length; tier++) {
        const f = prepare(t, tier, { boosted: true });
        f.player.getSkillManager().setCurrentLevel(core.Skill.FARMING, f.level - 1, false);
        f.take();
        assert.equal(f.seeds(), 0, TIERS[tier][0]);
    }
});
test('a maintained boost meets each tier requirement at confirmation', t => {
    for (let tier = 0; tier < TIERS.length; tier++) {
        const f = prepare(t, tier, { boosted: true });
        f.take();
        assert.equal(f.seeds(), 100, TIERS[tier][0]);
    }
});
test('newly acquired different-tier seeds or fruit block the pending confirmation', t => {
    for (const suffix of [' seed', ' fruit']) {
        const f = prepare(t), foreign = Data.itemId('Bologano' + suffix);
        f.inventory.add(new core.Item(foreign, 1), false);
        f.take();
        assert.equal(f.seeds(), 0, suffix);
        assert.equal(f.inventory.getAmount(foreign), 1);
    }
});
test('top-ups and repeated confirmations respect the10000 seed cap', t => {
    const f = prepare(t);
    f.inventory.add(new core.Item(f.id, 9950), false);
    f.take(); f.take(2);
    assert.equal(f.seeds(), 10000);
});
test('exact tier levels can take the selected quantity', t => {
    for (let tier = 0; tier < TIERS.length; tier++) {
        const f = prepare(t, tier);
        f.take(1);
        assert.equal(f.seeds(), 1000, TIERS[tier][0]);
    }
});
test('walking away and a full inventory cannot produce seeds', t => {
    const away = prepare(t);
    away.player.moveTo(new core.Location(3200, 3200, 0));
    away.take();
    assert.equal(away.seeds(), 0);
    const full = prepare(t);
    full.inventory.add(new core.Item(Data.itemId('Spade'), 28), false);
    full.take();
    assert.equal(full.seeds(), 0);
    assert.equal(full.inventory.getAmount(Data.itemId('Spade')), 28);
});
