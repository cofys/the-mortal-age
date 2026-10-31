const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { test } = require('node:test');
const { configuration, requireFreePort } = require('./serve-tsps.cjs');
function fixture(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'runelite-launcher-'));
  fs.mkdirSync(path.join(root, 'server/data/gamemodes/vanilla'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: isolated-worktree');
  fs.writeFileSync(path.join(root, '.env'), 'WT_SLOT=20\nWEBSOCKET_PORT=43720\n');
  t.after(() => { assert.ok(fs.realpathSync(root).startsWith(base + path.sep)); fs.rmSync(root, { recursive: true }); });
  return root;
}
test('launcher accepts its slot and refuses main checkout/default game ports', t => {
  const root = fixture(t); assert.equal(configuration(root).gamePort, 43720);
  fs.writeFileSync(path.join(root, '.env'), 'WT_SLOT=20\nWEBSOCKET_PORT=43594\n');
  assert.throws(() => configuration(root), /refusing default\/live/);
  fs.unlinkSync(path.join(root, '.git')); fs.mkdirSync(path.join(root, '.git'));
  assert.throws(() => configuration(root), /isolated git worktree/);
});
test('launcher refuses save directories linked outside the worktree', t => {
  const root = fixture(t), other = fixture(t);
  fs.rmSync(path.join(root, 'server/data/gamemodes/vanilla'), { recursive: true });
  fs.symlinkSync(path.join(other, 'server/data/gamemodes/vanilla'), path.join(root, 'server/data/gamemodes/vanilla'), 'junction');
  assert.throws(() => configuration(root), /Save data must stay inside/);
});
test('launcher refuses an occupied port without stopping its owner', async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(requireFreePort(server.address().port), /already in use/); assert.equal(server.listening, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('launcher overrides external persistence settings and rejects linked actual saves', t => {
  const root = fixture(t), other = fixture(t);
  fs.appendFileSync(path.join(root, '.env'), 'PLAYER_SAVE_DATABASE_PATH=C:/live/players.sqlite\nLEGACY_PLAYER_SAVE_DIRECTORY=C:/live/characters\n');
  const config = configuration(root);
  assert.equal(config.env.PLAYER_SAVE_DATABASE_PATH, path.join(root, 'server/data/saves/players.sqlite'));
  assert.equal(config.env.LEGACY_PLAYER_SAVE_DIRECTORY, path.join(root, 'server/data/saves/characters'));
  assert.equal(config.env.PLAYER_SAVE_IMPORT_LEGACY_JSON, '0');
  fs.symlinkSync(path.join(other, 'server/data'), path.join(root, 'server/data/saves'), 'junction');
  assert.throws(() => configuration(root), /Save data must stay inside/);
});
