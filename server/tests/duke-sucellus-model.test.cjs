const assert = require('node:assert/strict');
const { test } = require('node:test');
const Model = require('../plugins/bosses/dukesucellus/Model.DukeSucellus');

test('mushroom powder follows the published clamped Herblore formula', () => {
  for (const [level, quantity] of [[1,1],[39,1],[40,2],[62,4],[69,4],[70,5],[79,5],[80,6],[99,6],[120,6]]) {
    assert.equal(Model.powderYield(level), quantity);
  }
  for (const [level, quantity] of [[1,3],[69,3],[70,4],[74,4],[75,5],[79,5],[80,6],[99,6]]) {
    assert.equal(Model.saltYield(level), quantity);
  }
});

test('poison feeding is capped at the sleeping meter and never spends an extra dose', () => {
  assert.deepEqual(Model.feed(0,100,200), { consumed: true, meter:100, awake:false });
  assert.deepEqual(Model.feed(100,100,200), { consumed: true, meter:200, awake:true });
  assert.deepEqual(Model.feed(200,100,200), { consumed:false, meter:200, awake:true });
  assert.deepEqual(Model.feed(195,5,200), { consumed:true, meter:200, awake:true });
});

test('five normal attacks precede the first gaze; the first gas follows three further attacks', () => {
  const clock = new Model.AttackClock();
  assert.deepEqual(Array.from({length:6},()=>clock.next(485)), ['auto','auto','auto','auto','auto','gaze']);
  assert.deepEqual(Array.from({length:4},()=>clock.next(485)), ['auto','auto','auto','gas']);
});

test('gas count and attack speed change at the source HP thresholds', () => {
  assert.equal(Model.gasCount(243),1);
  assert.equal(Model.gasCount(242),2);
  assert.equal(Model.attackTicks(122),5);
  assert.equal(Model.attackTicks(121),4);
});

test('gas cadence latches after the previous gas and is never immediately after a gaze', () => {
  const clock = new Model.AttackClock();
  for(let i=0;i<10;i++) clock.next(485);
  assert.equal(clock.gasInterval,5);
  const attacks = Array.from({length:30},()=>clock.next(100));
  assert.ok(attacks.includes('gas'));
  for(let i=1;i<attacks.length;i++) assert.ok(!(attacks[i-1]==='gaze'&&attacks[i]==='gas'));
  assert.equal(clock.gasInterval,3);
});

test('the real front pillars hide their south tiles but not Duke’s open centre', () => {
  assert.equal(Model.hidden([3035,6451]),true);
  assert.equal(Model.hidden([3043,6451]),true);
  assert.equal(Model.hidden([3039,6451]),false);
  assert.equal(Model.hidden([3039,6445]),false);
});
