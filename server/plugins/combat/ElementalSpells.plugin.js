module.exports = {
  name: 'Elemental Spells',
  register(api) {
    require('./elementalspells/Common.ElementalSpells').init(api);
    require('./elementalspells/Base.ElementalSpells').attach(api);
    require('./elementalspells/Weakness.ElementalSpells').attach(api);
  },
};
