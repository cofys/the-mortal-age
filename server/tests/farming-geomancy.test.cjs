const assert = require('node:assert/strict');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Spells, spell;
const COST = [['Astral rune', 3], ['Nature rune', 3], ['Earth rune', 8]];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Spells = require('../plugins/skills/farming/Spells.Farming');
    Data.initializeFarmingData();
    spell = core.CacheDefinitions.getSpellByName('Geomancy');
    assert.ok(spell);
});
function prepare(t, { attacking = false, attacked = false, level = 99, runes = true } = {}) {
    const player = new Player(null), opponent = new Player(null), messages = [], xp = [], animations = [], menus = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender;
    player.sendMessage = text => messages.push(text);
    player.performAnimation = animation => animations.push(animation);
    player.setSpellbook(core.MagicSpellbook.LUNAR);
    player.getSkillManager().setMaxLevels(core.Skill.MAGIC, 99, false).setCurrentLevels(core.Skill.MAGIC, level, false);
    t.mock.method(player.getSkillManager(), 'addExperiences', (skill, amount) => xp.push([skill, amount]));
    t.mock.method(Patches, 'choose', (_, entries) => menus.push(entries));
    let active = attacking, incoming = attacked;
    t.mock.method(player.getCombat(), 'getTarget', () => active ? opponent : null);
    t.mock.method(player.getCombat(), 'getAttacker', () => incoming ? opponent : null);
    const farm = { offset: 0, patches: {}, tools: {} };
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    if (runes) for (const [name, count] of COST) player.getInventory().add(new core.Item(Data.itemId(name), count), false);
    const event = { player, buttonId: spell.widgetId };
    return { player, messages, xp, animations, menus, farm, event,
        cast: () => Spells.farmingButton(event),
        runes: () => COST.map(([name]) => player.getInventory().getAmount(Data.itemId(name))),
        stopCombat: () => { active = false; incoming = false; } };
}
for (const state of [{ attacking: true }, { attacked: true }, { attacking: true, attacked: true }]) {
    test(`Geomancy refuses combat before consuming runes or granting XP: ${JSON.stringify(state)}`, t => {
        const f = prepare(t, state), original = structuredClone(f.farm);
        assert.equal(core.CombatFactory.inCombat(f.player), true);
        f.cast();
        assert.equal(f.event.handled, true);
        assert.deepEqual(f.messages, ["You can't commune with the land while fighting."]);
        assert.deepEqual(f.runes(), [3, 3, 8]);
        assert.deepEqual(f.xp, []);
        assert.deepEqual(f.animations, []);
        assert.deepEqual(f.menus, []);
        assert.deepEqual(f.farm, original);
        assert.equal(core.CombatFactory.inCombat(f.player), true, 'refusal must not reset existing combat');
    });
}
test('Geomancy can be cast normally after combat ends, using its runes and awarding 60 Magic XP', t => {
    const f = prepare(t, { attacked: true });
    f.cast();
    f.stopCombat();
    f.cast();
    assert.deepEqual(f.runes(), [0, 0, 0]);
    assert.deepEqual(f.xp, [[core.Skill.MAGIC, 60]]);
    assert.equal(f.animations.length, 1);
    assert.equal(f.messages.at(-1), 'You have no crops growing.');
});
test('ordinary Geomancy still checks Magic level and rune availability', t => {
    for (const options of [{ level: 64 }, { runes: false }]) {
        const f = prepare(t, options), originalRunes = f.runes();
        f.cast();
        assert.deepEqual(f.runes(), originalRunes);
        assert.deepEqual(f.xp, []);
        assert.deepEqual(f.animations, []);
        assert.deepEqual(f.menus, []);
    }
});
