const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const FarmingCore = require('../plugins/skills/farming/Core.Farming');
let core, Data, Patches, Tithe;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    FarmingCore.init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Tithe = require('../plugins/skills/farming/Tithe.Farming');
    Data.initializeFarmingData();
});
function prepare(t, names = ['Zamorak cape'], { prayer = 50, coins = 75000 } = {}) {
    const p = new Player(null), messages = [], saves = [];
    p.setUsername('bologa-fixture');
    p.getLocation().setX(1805); p.getLocation().setY(3554); p.getLocation().setZ(1);
    p.getSkillManager().setCurrentLevel(core.Skill.PRAYER, prayer);
    const sender = new Proxy({}, { get: () => () => sender });
    p.getPacketSender = () => sender;
    p.sendMessage = text => messages.push(text);
    p.getInventory().add(new core.Item(core.ItemIdentifiers.COINS, coins), false);
    for (const name of names) {
        const id = Data.itemId(name), slot = core.CacheDefinitions.getItem(id).wearPos;
        assert.ok(slot >= 0, `fixture must be wearable: ${name}`);
        p.getEquipment().setItem(slot, new core.Item(id));
    }
    let options;
    t.mock.method(Patches, 'choose', (_player, entries) => { options = entries; });
    t.mock.method(FarmingCore.PluginManager, 'emitCustomEvent', (name, event) => {
        if (name === 'persistence:save') saves.push(event);
    });
    const npc = { getLocation: () => new core.Location(1805, 3554, 1) };
    const talk = () => Tithe.titheNpc({ player: p, npc, definition: { getName: () => 'Bologa' }, handled: false });
    talk();
    return { p, messages, saves, talk, pay: () => options[0][1](),
        unlocked: () => Patches.farmFor(p).tithe.bologa === true,
        coins: () => p.getInventory().getAmount(core.ItemIdentifiers.COINS) };
}
test('Bologa accepts cache-tagged Zamorak equipment without Zamorak or unholy in its name', t => {
    for (const name of ["Dagon'hai hat", 'Dragon hunter lance', 'Staff of the Dead', "Inquisitor's hauberk", 'Oathplate helm']) {
        const f = prepare(t, [name]);
        f.pay();
        assert.equal(f.unlocked(), true, name);
        assert.equal(f.coins(), 0, name);
    }
});
test('conflicting Saradomin or Guthix equipment prevents the unlock without taking coins', t => {
    for (const name of ['Holy symbol', 'Guthix cape', 'Peaceful blessing', 'Monk\'s robe top']) {
        const f = prepare(t, ['Unholy blessing', name]);
        f.pay();
        assert.equal(f.unlocked(), false, name);
        assert.equal(f.coins(), 75000, name);
    }
});
test('Bandos, Armadyl and Zaros equipment also conflicts, including books and cosmetic variants', t => {
    for (const name of ['War blessing', 'Honourable blessing', 'Ancient blessing', 'Book of war', 'Book of law', 'Book of darkness',
        'Bandos chestplate', 'Armadyl helmet', 'Torva full helm', 'Virtus robe top', 'Ancient staff', 'Bandos godsword (or)']) {
        const f = prepare(t, ['Unholy symbol', name]);
        f.pay();
        assert.equal(f.unlocked(), false, name);
        assert.equal(f.coins(), 75000, name);
    }
});
test('a dual-affiliation weapon is not exclusively Zamorakian', t => {
    for (const name of ['Staff of Light', 'Staff of Balance']) {
        const f = prepare(t, ['Zamorak cape', name]);
        f.pay();
        assert.equal(f.unlocked(), false, name);
        assert.equal(f.coins(), 75000);
    }
});
test('Zarosian cosmetic armour and upgraded/locked ancient sceptres remain conflicting equipment', t => {
    for (const name of ['Sanguine torva full helm', 'Sanguine torva platebody', 'Sanguine torva platelegs',
        'Blood ancient sceptre', 'Ice ancient sceptre', 'Smoke ancient sceptre', 'Shadow ancient sceptre', 'Blood ancient sceptre (l)']) {
        const f = prepare(t, ['Unholy symbol', name]);
        f.pay();
        assert.equal(f.unlocked(), false, name);
        assert.equal(f.coins(), 75000);
    }
});
test('neutral gear and carried foreign god items do not block a valid worn outfit', t => {
    const f = prepare(t, ['Unholy blessing', 'Rune platebody', 'Amulet of fury']);
    f.p.getInventory().add(new core.Item(Data.itemId('Holy symbol')), false);
    f.pay();
    assert.equal(f.unlocked(), true);
});
test('empty slots and inventory-only Zamorak items cannot qualify', t => {
    const f = prepare(t, []);
    f.p.getInventory().add(new core.Item(Data.itemId('Unholy symbol')), false);
    f.pay();
    assert.equal(f.unlocked(), false);
    assert.equal(f.coins(), 75000);
});
test('wrong-slot, noted, placeholder and quest display items cannot qualify', t => {
    const id = Data.itemId('Unholy symbol'), cached = core.CacheDefinitions.getItem(id);
    const ids = [cached.note, cached.placeholder, core.ItemIdentifiers.UNHOLY_SYMBOL_2].filter(id => Number.isInteger(id) && id > 0);
    for (const invalidId of [id, ...ids]) {
        const f = prepare(t, []);
        const slot = invalidId === id ? core.Equipment.HEAD_SLOT : core.Equipment.AMULET_SLOT;
        f.p.getEquipment().setItem(slot, new core.Item(invalidId));
        f.pay();
        assert.equal(f.unlocked(), false, `invalid equipment id ${invalidId}`);
        assert.equal(f.coins(), 75000);
    }
});
test('equipment is checked again after the menu opens and before payment', t => {
    const f = prepare(t);
    f.p.getEquipment().setItem(core.Equipment.AMULET_SLOT, new core.Item(Data.itemId('Holy symbol')));
    f.pay();
    assert.equal(f.unlocked(), false);
    assert.equal(f.coins(), 75000);
});
test('payment is once only and requests persistence of the unlock', t => {
    const f = prepare(t, ['Unholy symbol'], { coins: 150000 });
    f.pay(); f.pay();
    assert.equal(f.unlocked(), true);
    assert.equal(f.coins(), 75000);
    assert.equal(f.saves.length, 1);
});
test('an obsolete menu cannot charge against replacement Farming state', t => {
    const f = prepare(t);
    f.p.setAttribute(Patches.FARM_ATTRIBUTE, { patches: {}, tools: {}, tithe: { points: 0, score: 0 } });
    f.pay();
    assert.equal(f.unlocked(), false);
    assert.equal(f.coins(), 75000);
});
test('insufficient Prayer, coins or NPC distance refuses the transaction', t => {
    for (const setup of [{ prayer: 49 }, { coins: 74999 }, { distant: true }]) {
        const f = prepare(t, ['Unholy symbol'], setup);
        if (setup.distant) f.p.getLocation().setX(3000);
        const coins = f.coins();
        f.pay();
        assert.equal(f.unlocked(), false);
        assert.equal(f.coins(), coins);
        assert.equal(f.saves.length, 0);
    }
});
test('unlock enables the existing twenty-blessings-per-point reward without repeat fees or equipment checks', t => {
    const f = prepare(t), score = Patches.farmFor(f.p).tithe;
    let options;
    t.mock.method(Patches, 'choose', (_p, entries) => { options = entries; });
    const rewards = () => {
        Tithe.titheNpc({ player: f.p, npc: { getLocation: () => f.p.getLocation().clone() },
            definition: { getName: () => 'Farmer Gricoller' } });
        options.find(([label]) => label.startsWith("Bologa's blessing"))[1]();
    };
    score.points = 2;
    rewards();
    assert.equal(score.points, 2, 'locked rewards take no points');
    assert.equal(f.p.getInventory().getAmount(Data.itemId("Bologa's blessing")), 0);
    f.pay();
    f.p.getEquipment().resetItems();
    rewards();
    assert.equal(score.points, 1);
    assert.equal(f.p.getInventory().getAmount(Data.itemId("Bologa's blessing")), 20);
    assert.equal(f.coins(), 0);
});
