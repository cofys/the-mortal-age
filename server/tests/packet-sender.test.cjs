// Run after `yarn build`: node --test tests/packet-sender.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PacketSender } = require('../dist/net/packet/PacketSender');

const sender = (interfaceId, tracked) => ({
  resetInterfaceState: () => interfaceId,
  closeTrackedInterfaces: () => tracked,
  endBankSearch() {},
  emitInterfaceClosed() {},
  sendSubInterface() {},
  player: { getSession: () => ({ sendClientPacket: () => true }) },
});

test('sendInterfaceRemoval keeps its `this` contract when nothing is open', () => {
  // The Slayer assignment chain calls .sendMessage() on this result; an
  // undefined return used to crash the right-click path with no interface open.
  const none = sender(-1, false);
  assert.equal(PacketSender.prototype.sendInterfaceRemoval.call(none), none);
  const tracked = sender(1, true);
  assert.equal(PacketSender.prototype.sendInterfaceRemoval.call(tracked), tracked);
});

test('sendSystemUpdate emits the SYSTEM_UPDATE packet (opcode 220, big-endian seconds)', () => {
  // The legacy implementation wrote opcode 114 (WIDGET_SET_ANIMATION) with a
  // little-endian short, which the web client misparsed and stalled the batch.
  const frames = [];
  const fake = {
    resetInterfaceState: () => -1,
    closeTrackedInterfaces: () => false,
    sendSubInterface() {},
    player: { getSession: () => ({ sendClientPacket: (frame) => { frames.push(frame); return true; } }) },
  };
  const result = PacketSender.prototype.sendSystemUpdate.call(fake, 125);
  assert.equal(result, fake);
  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0]), Buffer.from([220, 0, 0, 0, 125]));
});

test('sendCollectionLogSnapshot emits opcode 190 with the owned collection_log items', () => {
  let frame;
  const fake = {
    player: { getSession: () => ({ sendClientPacket: (bytes) => { frame = bytes; return true; } }) },
  };
  const result = PacketSender.prototype.sendCollectionLogSnapshot.call(fake, [
    { slot: 0, itemId: 13247, quantity: 1 },
    { slot: 1, itemId: 20659, quantity: 1 },
  ]);
  assert.equal(result, fake);
  const buf = Buffer.from(frame);
  assert.equal(buf[0], 190);
  assert.equal(buf.readUInt16BE(1), 18);
  assert.equal(buf.readUInt16BE(3), 2);
  assert.equal(buf.readUInt16BE(5), 0);
  assert.equal(buf.readUInt16BE(7), 13247);
  assert.equal(buf.readInt32BE(9), 1);
  assert.equal(buf.readUInt16BE(13), 1);
  assert.equal(buf.readUInt16BE(15), 20659);
  assert.equal(buf.readInt32BE(17), 1);
});

test("a dialogue box opened again resends its texts: the client turns 'Click here to continue' into 'Please wait...' on its own", () => {
  // Two NPC lines in a row (Gee): the second line's "Click here to continue" was skipped as
  // unchanged, so the client kept the "Please wait..." it shows after a continue click.
  const { FrameUpdater } = require('../dist/util/FrameUpdater');
  const frames = [];
  const updater = new FrameUpdater();
  const fake = {
    chatboxGroupId: -1,
    emitInterfaceClosed() {},
    player: {
      getSession: () => ({ sendClientPacket: (frame) => { frames.push(Buffer.from(frame)); return true; } }),
      getFrameUpdater: () => updater,
    },
  };
  const CONTINUE = (231 << 16) | 5;
  const sent = () => frames.filter((frame) => frame.includes('Click here to continue')).length;
  for (let line = 0; line < 2; line++) {
    PacketSender.prototype.sendChatboxInterface.call(fake, 231);
    PacketSender.prototype.sendString.call(fake, 'Click here to continue', CONTINUE);
  }
  assert.equal(sent(), 2, 'sent with every line');
  // Without reopening, an unchanged text is still skipped.
  PacketSender.prototype.sendString.call(fake, 'Click here to continue', CONTINUE);
  assert.equal(sent(), 2);
});

test('chatbox replacement, explicit close and interface removal notify their previous group', () => {
  const { PluginManager } = require('../dist/plugins/PluginManager');
  const original = PluginManager.emitCustomEvent;
  const closed = [];
  const fake = Object.assign(Object.create(PacketSender.prototype), {
    chatboxGroupId: -1,
    subInterfaceTargets: new Map(),
    player: {
      getSession: () => ({ sendClientPacket: () => true }),
      getFrameUpdater: () => ({ clearGroup() {} }),
      getInterfaceId: () => -1,
    },
  });
  PluginManager.emitCustomEvent = (name, event) => {
    if (name === 'interface:closed') closed.push([event.interfaceId, fake.getChatboxGroupId()]);
  };
  try {
    fake.sendChatboxInterface(233);
    fake.sendChatboxInterface(231);
    fake.sendChatboxInterface(231);
    fake.closeInterface(231);
    fake.sendChatboxInterface(233);
    fake.closeTrackedInterfaces();
    assert.deepEqual(closed, [[233, 231], [231, -1], [233, -1]]);
  } finally { PluginManager.emitCustomEvent = original; }
});


test('interface script packets preserve 64-bit price totals', () => {
  const { encodeWidgetRunScript } = require('../dist/net/protocol/ClientProtocol');
  const frame = encodeWidgetRunScript(785, [12345678901n]);
  assert.equal(frame[8], 2, 'long argument tag');
  assert.equal(frame.readBigInt64BE(9), 12345678901n);
});

test('interface transitions emit close before replacement and changed after assignment', () => {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const { PluginManager } = require('../dist/plugins/PluginManager');
  const original = PluginManager.emitCustomEvent;
  const events = [];
  PluginManager.emitCustomEvent = (name, event) => events.push([name, event.interfaceId, event.player.interfaceId]);
  try {
    const player = { interfaceId: 464 };
    Player.prototype.setInterfaceId.call(player, 465);
    Player.prototype.setInterfaceId.call(player, 465);
    Player.prototype.setInterfaceId.call(player, -1);
    assert.deepEqual(events, [
      ['interface:closed', 464, 464],
      ['interface:changed', 465, 465],
      ['interface:changed', -1, -1],
    ]);
    assert.equal(player.interfaceId, -1);
  } finally { PluginManager.emitCustomEvent = original; }
});


test('NPC spawn payload preserves current-cache16-bit type IDs and a16-bit index/sentinel', () => {
  const { createNpcSyncState, encodeNpcSync } = require('../dist/net/protocol/ClientProtocol');
  const local = { x:3200, y:3200, level:0 };
  const views = [49,16433,16538].map((typeId, offset) => ({
    ...local, index:7+offset, typeId, rotation:0, walkDirection:-1, runDirection:-1,
  }));
  const body = encodeNpcSync(1, local, views, createNpcSyncState()).subarray(3);
  assert.equal(body.readUInt16BE(9),21);
  // count8, three spawns(index16, flags3, offsets5+5, rotation3, type16), sentinel16.
  assert.equal(body.subarray(11).toString('hex'),'0000070000003100080000403100090000409affff');
});
