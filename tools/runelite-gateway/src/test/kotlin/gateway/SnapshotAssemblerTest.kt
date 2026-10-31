package gateway
import kotlin.test.*
class SnapshotAssemblerTest {
 private fun part(tick:Int,part:Int,parts:Int,player:Int)=json.readTree("""{"version":1,"tick":$tick,"part":$part,"parts":$parts,"players":[{"index":$player}],"npcs":[]}""")
 @Test fun waitsForCompleteTickAndOrdersOutOfOrderParts() {
  val a=SnapshotAssembler();assertNull(a.add(part(10,1,2,2)));val s=a.add(part(10,0,2,1))!!
  assertEquals(listOf(1,2),s["players"].map{it["index"].asInt()})
 }
 @Test fun ignoresDuplicateCompletedTick() {val a=SnapshotAssembler();assertNotNull(a.add(part(10,0,1,1)));assertNull(a.add(part(10,0,1,1)))}
 @Test fun newerTickDiscardsIncompletePreviousTick() {
  val a=SnapshotAssembler();assertNull(a.add(part(10,0,2,1)));assertNotNull(a.add(part(11,0,1,3)));assertNull(a.add(part(10,1,2,2)))
 }
 @Test fun rejectsBadPartCountsAndInconsistentParts() {
  val a=SnapshotAssembler();assertFailsWith<IllegalArgumentException>{a.add(part(10,0,0,1))};a.add(part(10,0,2,1));assertFailsWith<IllegalArgumentException>{a.add(part(10,0,3,1))}
 }
}
