const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const FarmingCore = require('../plugins/skills/farming/Core.Farming');
let core, Data, Model, Patches, Spells, spell;
const RUNE_COSTS = [['Earth rune', 25], ['Blood rune', 8], ['Nature rune', 12], ['Soul rune', 8]];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi(); FarmingCore.init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Spells = require('../plugins/skills/farming/Spells.Farming');
    Data.initializeFarmingData();
    spell = core.CacheDefinitions.getSpellByName('Resurrect Crops');
    assert.ok(spell, 'spell identifiers must resolve from the actual cache');
});
function fixture(t, { crop = 'RANARR', level = 78, roll = 0, status = 'dead', resurrected = false, withRunes = true } = {}) {
    const p = new Player(null), messages = [], animations = [], bits = new Map();
    p.setUsername('resurrect-crops-fixture');
    const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
        : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
    p.getPacketSender = () => sender; p.sendMessage = text => messages.push(text);
    p.performAnimation = animation => animations.push(animation);
    const skills = p.getSkillManager();
    skills.setMaxLevels(core.Skill.MAGIC, 99, false).setExperiences(core.Skill.MAGIC, 13034431, false)
        .setCurrentLevels(core.Skill.MAGIC, level, false);
    p.setSpellbook(core.MagicSpellbook.ARCEUUS);
    const patch = Data.CACHE.patches.find(p => p.type === Data.CROPS.get(crop).type);
    p.getLocation().setX(patch.x); p.getLocation().setY(patch.y); p.getLocation().setZ(patch.z);
    if (withRunes) for (const [name, count] of RUNE_COSTS) p.getInventory().add(new core.Item(Data.itemId(name), count), false);
    const farm = { offset: 0, patches: {}, tools: {} };
    const state = { ...Model.emptyPatch(Date.now(), farm), crop, stage: 2, status, resurrected, checked: false };
    farm.patches[Data.patchKey(patch)] = state; p.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    t.mock.method(FarmingCore.MapObjects, 'get', () => null);
    t.mock.method(Math, 'random', () => roll);
    const cast = () => Spells.farmingSpell({ player: p, spellWidget: spell.widgetId, spellItemId: spell.itemId,
        spellId: spell.widgetId, handled: false }, patch);
    return { p, patch, farm, state, cast, messages, animations,
        current: () => farm.patches[Data.patchKey(patch)],
        runes: () => RUNE_COSTS.map(([name]) => p.getInventory().getAmount(Data.itemId(name))),
        xp: () => skills.getExperience(core.Skill.MAGIC) };
}
test('Resurrect Crops uses the published discrete success boundary at levels 78, 90 and 99', t => {
    for (const [level, successes] of [[78, 129], [90, 166], [99, 193]]) {
        const passing = fixture(t, { level, roll: (successes - 0.5) / 256 });
        passing.cast();
        assert.equal(passing.current().status, 'growing', `last passing roll at ${level}`);
        assert.equal(passing.current().resurrected, true);
        assert.deepEqual(passing.runes(), [0, 0, 0, 0]);
        const failing = fixture(t, { level, roll: (successes + 0.5) / 256 });
        failing.cast();
        assert.equal(failing.current().crop, undefined, `first failing roll at ${level}`);
    }
});
test('visible Magic boosts count, but success is capped at level 99', t => {
    const boosted = fixture(t, { level: 105, roll: 192.5 / 256 });
    boosted.cast();
    assert.equal(boosted.current().status, 'growing');
    assert.equal(boosted.current().resurrected, true);
    const capped = fixture(t, { level: 105, roll: 193.5 / 256 });
    capped.cast();
    assert.equal(capped.current().crop, undefined);
});
test('redwoods, Hespori and anima reject resurrection before runes, XP, animation or crop mutation', t => {
    for (const crop of ['REDWOOD', 'HESPORI', 'ATTAS']) {
        const f = fixture(t, { crop }), original = JSON.parse(JSON.stringify(f.state)), xp = f.xp(), runes = f.runes();
        f.cast();
        assert.deepEqual(f.runes(), runes, crop);
        assert.equal(f.xp(), xp, crop);
        assert.deepEqual(f.current(), original, crop);
        assert.equal(f.animations.length, 0, crop);
    }
});
test('successful resurrection keeps the crop stage, consumes one cast and cannot be repeated', t => {
    const f = fixture(t), xp = f.xp();
    f.cast();
    assert.equal(f.current().stage, 2);
    assert.equal(f.current().status, 'growing');
    assert.equal(f.current().resurrected, true);
    assert.ok(f.current().nextAt > Date.now());
    assert.ok(f.xp() > xp);
    f.current().status = 'dead';
    const afterXp = f.xp();
    f.cast();
    assert.equal(f.current().status, 'dead');
    assert.equal(f.xp(), afterXp);
    assert.equal(f.animations.length, 1);
});
test('failed resurrection consumes one cast and clears the dead crop', t => {
    const f = fixture(t, { roll: 0.99 });
    f.cast();
    assert.deepEqual(f.runes(), [0, 0, 0, 0]);
    assert.equal(f.current().crop, undefined);
    assert.equal(f.animations.length, 1);
});
test('live or previously resurrected crops leave runes and XP unchanged', t => {
    for (const options of [{ status: 'growing' }, { resurrected: true }]) {
        const f = fixture(t, options), xp = f.xp(), runes = f.runes();
        f.cast();
        assert.deepEqual(f.runes(), runes);
        assert.equal(f.xp(), xp);
        assert.equal(f.current(), f.state);
    }
});
test('ordinary spell validation still refuses low Magic and missing runes', t => {
    for (const options of [{ level: 77 }, { withRunes: false }]) {
        const f = fixture(t, options), xp = f.xp(), runes = f.runes();
        f.cast();
        assert.deepEqual(f.runes(), runes);
        assert.equal(f.xp(), xp);
        assert.equal(f.current(), f.state);
        assert.equal(f.animations.length, 0);
    }
});
test('resurrection exclusions do not block Cure Plant or Fertile Soil', t => {
    for (const [name, options, costs] of [
        ['Cure Plant', { crop: 'REDWOOD', status: 'diseased' }, [['Astral rune', 1], ['Earth rune', 8]]],
        ['Fertile Soil', { status: 'growing' }, [['Astral rune', 3], ['Nature rune', 2], ['Earth rune', 15]]],
    ]) {
        const f = fixture(t, { ...options, level: 99, withRunes: false });
        f.p.setSpellbook(core.MagicSpellbook.LUNAR);
        for (const [rune, amount] of costs) f.p.getInventory().add(new core.Item(Data.itemId(rune), amount), false);
        const selected = core.CacheDefinitions.getSpellByName(name);
        Spells.farmingSpell({ player: f.p, spellWidget: selected.widgetId, spellItemId: selected.itemId,
            spellId: selected.widgetId }, f.patch);
        assert.equal(f.current().status, 'growing', name);
        if (name === 'Fertile Soil') assert.equal(f.current().compost, 2);
        for (const [rune] of costs) assert.equal(f.p.getInventory().getAmount(Data.itemId(rune)), 0, name);
        assert.ok(f.animations.length > 0, name);
    }
});
