package gateway
import kotlin.test.*

class PublicChatUpdatesTest {
 // Actual encodeChatMessage('public','hdcheck','<img=1>runeliteqa','',1) payload.
 private fun fixture()="6864636865636b00023c696d673d313e72756e656c697465716100000001".chunked(2).map{it.toInt(16).toByte()}.toByteArray()
 @Test fun actualCrownedTspsPublicChatMapsToNativePlayerInfoMetadata(){
  val chat=assertNotNull(decodePublicChat(fixture()))
  assertEquals(NativePublicChat(1,"hdcheck",2,false),chat)
  assertTrue(matchesPublicChat(chat,"<img=1>hdcheck"));assertTrue(matchesPublicChat(chat,"<img=1><img=12>hdcheck"));assertFalse(matchesPublicChat(chat,"quest speech"))
 }
 @Test fun autochatUsesNativeAutotyperAndGameMessagesRemainSeparate(){
  val bytes=fixture();bytes[8]=91;assertTrue(decodePublicChat(bytes)!!.autotyper)
  bytes[8]=0;assertNull(decodePublicChat(bytes));bytes[8]=2;bytes[bytes.lastIndex]=0;assertNull(decodePublicChat(bytes))
 }
 @Test fun authoritativeRepeatedMessagesAreConsumedOncePerSnapshotInOrder(){
  val pending=PublicChatUpdates();val first=decodePublicChat(fixture())!!;pending.offer(first);pending.offer(first.copy(text="again"))
  assertTrue(pending.matches(1,"<img=1>again"));assertFalse(pending.matches(2,"again"));assertFalse(pending.matches(1,"quest speech"))
  assertNull(pending.take(2));assertEquals(first,pending.take(1));assertEquals("again",pending.take(1)!!.text);assertNull(pending.take(1))
  assertFalse(pending.matches(1,"again"))
 }
 @Test fun absentActorMessagesCannotReplayWhenTheIndexIsReused(){
  val pending=PublicChatUpdates();val old=decodePublicChat(fixture())!!;pending.offer(old);pending.retainSenders(setOf(2));assertNull(pending.take(1))
  pending.offer(old.copy(text="new actor"));pending.retainSenders(setOf(1));assertEquals("new actor",pending.take(1)!!.text);assertNull(pending.take(1))
 }
 @Test fun onlyNativeModeratorTypesAreMappedFromCrowns(){
  fun payload(name:String)=payload{text("hello");writeByte(2);text(name);text("");writeShort(1)}
  assertEquals(1,decodePublicChat(payload("<img=0>mod"))!!.modicon)
  assertEquals(0,decodePublicChat(payload("<img=99>custom"))!!.modicon)
  assertEquals(0,decodePublicChat(payload("normal"))!!.modicon)
 }
}
