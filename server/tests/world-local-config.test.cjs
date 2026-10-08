// Run after `yarn build`: node --test tests/world-local-config.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const modulePath = require.resolve('../dist/game/definition/WorldDefinition');
const shipped = {
  spawn: { x: 3222, y: 3219, z: 0 },
  zones: [{ tags: [] }],
  disabledPlugins: ['VoiceChat', 'TutorialIsland'],
  experienceMultiplier: 1,
  pluginConfig: { a: 1, b: 2 },
};

/** Loads WorldDefinition from a directory holding world.json (and world.local.json, if given). */
function loadWorld(local) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tsps-world-local-'));
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(directory, 'data/definitions'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'data/definitions/world.json'), JSON.stringify(shipped));
    if (local) {
      fs.writeFileSync(path.join(directory, 'data/definitions/world.local.json'), JSON.stringify(local));
    }
    process.chdir(directory);
    delete require.cache[modulePath];
    const world = require(modulePath);
    return { config: world.readWorldConfig(), definition: world.getWorldDefinition() };
  } finally {
    process.chdir(cwd);
    delete require.cache[modulePath];
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('without world.local.json the shipped world.json applies', () => {
  const { definition } = loadWorld();
  assert.equal(definition.experienceMultiplier, 1);
  assert.deepEqual(definition.disabledPlugins, ['VoiceChat', 'TutorialIsland']);
});

test('world.local.json replaces top-level keys and merges pluginConfig', () => {
  const { config, definition } = loadWorld({
    experienceMultiplier: 10,
    disabledPlugins: ['VoiceChat'],
    pluginConfig: { b: 3 },
  });
  assert.equal(definition.experienceMultiplier, 10);
  assert.deepEqual(definition.disabledPlugins, ['VoiceChat']);
  assert.deepEqual(config.pluginConfig, { a: 1, b: 3 });
  assert.deepEqual(definition.spawn, shipped.spawn, 'keys it does not set stay as shipped');
});
