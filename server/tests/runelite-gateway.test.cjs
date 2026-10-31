const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { before, test } = require('node:test');
process.env.DISABLE_PLAYER_BOTS = '1';
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { decodePluginMessagePayload, encodePluginMessage } = require('../dist/net/protocol/ClientProtocol');
const { SERVER_PACKET_LENGTHS } = require('../dist/net/protocol/ServerPackets');
let core, nextIndex = 1500;
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PM.getCoreApi();
  new (require('../dist/game/definition/loader/impl/NpcDefinitionLoader').NpcDefinitionLoader)().load();
  core.RegionManager.init(); core.RegionManager.loadMapFiles(3200, 3200);
  const file = path.resolve(__dirname, '../plugins/network/runelite-gateway/RuneliteGateway.plugin.js');
  if (fs.existsSync(file)) require(file).register(PM.createApi('RuneliteGateway'));
});
function fixture(t) {
  const frames = [];
  const transport = { kind: 'test', binaryTransport: true, remoteAddress: '127.0.0.1',
    isOpen: () => true, send: frame => frames.push(Buffer.from(frame)), close() {}, onData() {}, onClose() {}, onError() {} };
  const session = new PlayerSession(transport), player = new Player(session);
  player.setIndex(nextIndex++); player.setUsername('gatewayqa' + nextIndex);
  player.setRegistered(true); player.setAttribute('bot-skip-persistence', true);
  player.setLocation(new core.Location(3200, 3200, 0)); session.setPlayer(player);
  const connection = new ClientConnection(transport); connection.player = player;
  t.after(() => { PM.emitPlayerDisconnect({ player, username: player.getUsername(), source: 'test' }); delete process.env.RUNELITE_GATEWAY_ENABLED; });
  return { player, session, connection, frames };
}
function receive(player, data) {
  const event = { player, channel: 'runelite-gateway', data, handled: false };
  PM.emitCustomEvent('network:plugin-message', event); return event;
}
async function messages(f) {
  await Promise.resolve();
  const values = [];
  for (const frame of f.frames) {
    let offset = 0;
    while (offset < frame.length) {
      const opcode = frame[offset++], expected = SERVER_PACKET_LENGTHS[opcode];
      assert.notEqual(expected, undefined, 'known outbound frame');
      let size = expected;
      if (expected === -1) size = frame[offset++];
      if (expected === -2) { size = frame.readUInt16BE(offset); offset += 2; }
      assert.ok(offset + size <= frame.length, 'complete packet in batch');
      if (opcode === 6) {
        const value = decodePluginMessagePayload(frame.subarray(offset, offset + size));
        if (value.channel === 'runelite-gateway') values.push(value.data);
      }
      offset += size;
    }
  }
  return values;
}
test('gateway subscription is disabled by default and version checked', async t => {
  const f = fixture(t);
  assert.equal(receive(f.player, { type: 'subscribe', version: 1 }).handled, true);
  assert.equal((await messages(f)).at(-1).type, 'disabled');
  process.env.RUNELITE_GATEWAY_ENABLED = '1';
  receive(f.player, { type: 'subscribe', version: 2 });
  assert.equal((await messages(f)).at(-1).type, 'error');
});
test('real session flush supplies authoritative local player and visible NPC views only to subscribers', async t => {
  process.env.RUNELITE_GATEWAY_ENABLED = '1';
  const f = fixture(t), other = fixture(t);
  const { NPC } = require('../dist/game/entity/impl/npc/NPC');
  const npc = NPC.create(1, new core.Location(3201, 3200, 0)); npc.setIndex(3000);
  f.player.getLocalNpcs().push(npc);
  receive(f.player, { type: 'subscribe', version: 1 });
  f.session.flush(1); f.session.flush(2); other.session.flush(1); other.session.flush(2);
  const sync = (await messages(f)).filter(v => v.type === 'sync');
  assert.equal(sync.length, 1);
  assert.equal(sync[0].localIndex, f.player.getIndex()); assert.equal(sync[0].tick, 2);
  assert.deepEqual(sync[0].players.map(v => v.index), [f.player.getIndex()]);
  assert.ok(Buffer.from(sync[0].players[0].appearance, 'base64').length > 40);
  assert.deepEqual(sync[0].npcs.map(v => v.index), [npc.getIndex()]);
  assert.equal((await messages(other)).filter(v => v.type === 'sync').length, 0);
  f.player.getLocalNpcs().length = 0; f.player.setLocation(new core.Location(3201, 3200, 0));
  f.session.flush(3);
  const moved = (await messages(f)).filter(v => v.type === 'sync').at(-1);
  assert.equal(moved.players[0].x, 3201); assert.deepEqual(moved.npcs, []);
  receive(f.player, { type: 'unsubscribe' }); f.session.flush(4);
  assert.equal((await messages(f)).filter(v => v.type === 'sync').at(-1).tick, 3);
});
test('large observer snapshots are complete UTF8-bounded chunks and never mutate source buffers', async t => {
  process.env.RUNELITE_GATEWAY_ENABLED = '1'; const f = fixture(t);
  receive(f.player, { type: 'subscribe', version: 1 });
  const appearance = Buffer.from('appearance');
  const players = [{ index: f.player.getIndex(), x: 3200, y: 3200, level: 0, appearance }];
  const npcs = Array.from({ length: 400 }, (_, i) => ({ index: i + 1, typeId: 1, x: 3200, y: 3200, level: 0, forcedChat: 'héllo 🌍'.repeat(10) }));
  PM.emitCustomEvent('network:sync-views', { player: f.player, tick: 25, baseX: 3152, baseY: 3152, players, npcs });
  const chunks = (await messages(f)).filter(v => v.type === 'sync');
  assert.ok(chunks.length > 1); assert.equal(chunks[0].part, 0);
  assert.ok(chunks.every((v, i) => v.part === i && v.parts === chunks.length && v.tick === 25));
  assert.deepEqual(chunks.flatMap(v => v.npcs).map(v => v.index), npcs.map(v => v.index));
  assert.equal(chunks.flatMap(v => v.players).length, 1);
  assert.equal(players[0].appearance, appearance);
  for (const data of chunks) assert.ok(encodePluginMessage('runelite-gateway', data).length <= 16387);
  PM.emitPlayerDisconnect({ player: f.player, username: f.player.getUsername(), source: 'test' });
  PM.emitCustomEvent('network:sync-views', { player: f.player, tick: 26, baseX: 3152, baseY: 3152, players, npcs });
  assert.equal((await messages(f)).filter(v => v.type === 'sync').length, chunks.length);
});
