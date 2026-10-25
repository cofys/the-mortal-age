const assert=require('node:assert/strict');
const {test,before}=require('node:test');
const H=require('./helpers/duke-sucellus.cjs');
before(H.initialize);
const awards=h=>h.emitted.filter(([name])=>name==='combat-achievements:complete').map(([,e])=>e.task);
function finish(h){h.p.setNeedsPlacement(false);const f=h.fight;f.wake();f.fell();f.won(h.p);}
function attack(h,{type=h.core.CombatType.MELEE,delay=0,accuracy=false}={}){
  const method=new(class extends h.core.CombatMethod{type(){return type;}hits(){return [];}})();
  return new h.core.PendingHit(h.p,h.session.boss,method,{damage:0,delay,rollAccuracy:accuracy,experience:false,handleAfterHitEffects:false});
}
function wake(h){h.p.setNeedsPlacement(false);h.fight.wake();h.fight.nextAttack=Infinity;h.move([3035,6451]);}

test('Cold Feet permits standing with run enabled and a recoil-only victory',t=>{
  const h=H.harness(t);h.enter();h.p.setRunning(true);h.session.area.process(h.p);finish(h);
  assert.ok(awards(h).includes('Cold Feet'));assert.ok(awards(h).includes('Mirror Image'));
});
test('running outside the gate before the entry teleport does not fail Cold Feet',t=>{
  const h=H.harness(t);h.p.setRunningDirection(h.core.Direction.EAST);const s=h.enter();
  assert.equal(h.p.isNeedsPlacement(),true);s.area.process(h.p);
  h.p.setRunningDirection(h.core.Direction.NONE);finish(h);assert.ok(awards(h).includes('Cold Feet'));
});
test('actual preparation running fails Cold Feet and a later walking kill resets eligibility',t=>{
  const h=H.harness(t),s=h.enter();h.move([3038,6435]);h.p.setNeedsPlacement(false);h.p.setRunning(true);
  const movement=h.p.getMovementQueue();movement.reset();movement.walkStep(2,0);movement.process();
  assert.notEqual(h.p.getRunningDirection(),h.core.Direction.NONE,'real movement took a running step');
  s.area.process(h.p);finish(h);assert.ok(!awards(h).includes('Cold Feet'));
  h.p.setRunningDirection(h.core.Direction.NONE);s.reset();s.area.process(h.p);finish(h);
  assert.ok(awards(h).includes('Cold Feet'));
});
test('avoidable preparation damage fails Cold Feet, including with no running',t=>{
  const h=H.harness(t);h.enter();t.mock.method(Math,'random',()=>.99);h.C.hurt(h.fight,1);h.step();
  assert.equal(h.fight.perfect,false);finish(h);assert.ok(!awards(h).includes('Cold Feet'));
});
test('running after the kill but before respawn belongs to the following Cold Feet attempt',t=>{
  const h=H.harness(t),s=h.enter();finish(h);const before=awards(h).filter(x=>x==='Cold Feet').length;
  h.p.setRunningDirection(h.core.Direction.EAST);s.area.process(h.p);h.p.setRunningDirection(h.core.Direction.NONE);
  h.step(24);finish(h);assert.equal(awards(h).filter(x=>x==='Cold Feet').length,before);
});
test('Cold Feet freezes at lethal damage and running during the death animation affects only the next kill',t=>{
  const h=H.harness(t),s=h.enter();wake(h);const first=h.fight;first.fell();
  h.p.setRunningDirection(h.core.Direction.EAST);s.area.process(h.p);h.p.setRunningDirection(h.core.Direction.NONE);
  h.step(4);first.won(h.p);assert.equal(awards(h).filter(x=>x==='Cold Feet').length,1);
  h.step(20);finish(h);assert.equal(awards(h).filter(x=>x==='Cold Feet').length,1);
});
test('Mirror Image compares player attack launch with Duke launch, not a delayed impact',t=>{
  const h=H.harness(t);h.enter();wake(h);h.fight.auto();
  const hit=attack(h,{type:h.core.CombatType.RANGED,delay:3});
  h.session.boss.getCombat().getHitQueue().addPendingHit(hit,h.core.World.getProcessCycle()+3);
  h.step(3);h.session.boss.getCombat().getHitQueue().process(h.core.World.getProcessCycle());
  finish(h);assert.ok(awards(h).includes('Mirror Image'));
});
test('a missed off-cycle attack fails Mirror Image; the next encounter starts clean',t=>{
  const h=H.harness(t),s=h.enter();wake(h);h.fight.auto();h.step();t.mock.method(Math,'random',()=>.999999);
  const hit=attack(h,{accuracy:true});assert.equal(hit.isAccurate(),false);
  finish(h);assert.ok(!awards(h).includes('Mirror Image'));
  s.reset();finish(h);assert.ok(awards(h).includes('Mirror Image'));
});
test('gaze and actual scheduled gas launches are attack starts; impacts are not new attacks',t=>{
  const h=H.harness(t),s=h.enter();wake(h);h.fight.gaze();attack(h);finish(h);
  assert.ok(awards(h).includes('Mirror Image'));
  const before=awards(h).filter(x=>x==='Mirror Image').length;s.reset();wake(h);s.boss.setHitpoints(200);h.fight.gas();attack(h);h.step(3);attack(h);finish(h);
  assert.equal(awards(h).filter(x=>x==='Mirror Image').length,before+1);
});
test('NPC thrall attacks cannot fail the owner Mirror Image restriction',t=>{
  const h=H.harness(t);h.enter();wake(h);h.step();
  h.dispatch('onCombatHitRoll',{attacker:{isNpc:()=>true},target:h.session.boss});
  finish(h);assert.ok(awards(h).includes('Mirror Image'));
});
