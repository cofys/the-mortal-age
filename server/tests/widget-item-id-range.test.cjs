const assert = require('node:assert/strict');
const { test } = require('node:test');
const { decodeClientPacket } = require('../dist/net/protocol/ClientProtocol');

// Native IF_BUTTON opcodes, matching NativeClientPackets and the client sender.
const BUTTONS = [23, 25, 31, 63, 69, 11, 14, 19, 20, 84];
const WIDGET = 149 << 16;
function frame(opcode, itemId, extra = []) {
  const bytes = Buffer.alloc(9 + extra.length);
  bytes[0] = opcode;
  bytes.writeInt32BE(WIDGET, 1);
  bytes.writeUInt16BE(2, 5);
  bytes.writeUInt16BE(itemId, 7);
  Buffer.from(extra).copy(bytes, 9);
  return bytes;
}

test('all ten native widget operations preserve unsigned item IDs and the no-item sentinel', () => {
  for (const [index, opcode] of BUTTONS.entries()) {
    for (const itemId of [0, 32767, 32768, 32926, 65534, 65535]) {
      const actual = decodeClientPacket(frame(opcode, itemId));
      assert.equal(actual.type, 'widget_action');
      assert.equal(actual.widgetId, WIDGET);
      assert.equal(actual.slot, 2);
      assert.equal(actual.buttonNum, index + 1);
      assert.equal(actual.itemId, itemId === 65535 ? undefined : itemId,
        `operation ${index + 1}, item ${itemId}`);
    }
  }
});

test('extended native widget operations retain high item IDs and their operation', () => {
  for (const itemId of [32767, 32768, 32926, 65534, 65535]) {
    const actual = decodeClientPacket(frame(91, itemId, [11]));
    assert.equal(actual.type, 'widget_action');
    assert.equal(actual.buttonNum, 11);
    assert.equal(actual.slot, 2);
    assert.equal(actual.itemId, itemId === 65535 ? undefined : itemId);
  }
});

test('native widget suboperations preserve high item IDs and the existing empty-item value', () => {
  for (const itemId of [32767, 32768, 32926, 65534, 65535]) {
    const actual = decodeClientPacket(frame(89, itemId, [2, 0]));
    assert.equal(actual.type, 'widget_action');
    assert.equal(actual.buttonNum, 2);
    assert.equal(actual.subOpId, 1);
    assert.equal(actual.slot, 2);
    assert.equal(actual.itemId, itemId === 65535 ? -1 : itemId);
  }
});
