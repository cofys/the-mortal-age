package gateway
import kotlin.test.*
import java.nio.file.Paths
import java.util.zip.CRC32
class CacheTest {
 @Test fun realCopiedCacheProvidesHuffmanAndValidMasterCrc() {
  val cache=Cache(Paths.get("../../server/caches/osrs-241_2026-10-20"))
  assertEquals(256,cache.huffman().size)
  assertEquals(5996,cache.files(2,16).keys.max()+1)
  assertContentEquals(intArrayOf(1737,31,31),cache.varbits()[8119])
  val widgets=cache.fileIds(3)
  assertTrue(widgets[0]!!.contains(0))
  assertFalse(widgets[0]!!.contains(5857))
  assertTrue(widgets[548]!!.contains(0))
  val master=cache.provide(255,255)!!
  try {
   assertEquals(255,master.readUnsignedByte().toInt());assertEquals(255,master.readUnsignedShort());assertEquals(0,master.readUnsignedByte().toInt())
   val size=master.readInt();assertTrue(size>=8)
   val crc=master.readInt()
   val raw=cache.group(255,0)!!;val n=java.nio.ByteBuffer.wrap(raw,1,4).int+if(raw[0].toInt()==0)5 else 9
   assertEquals(CRC32().apply{update(raw,0,n)}.value.toInt(),crc)
   assertTrue(master.readInt()>=0)
  } finally {master.release()}
 }
 @Test fun cacheConfig14VarbitsHaveValidBitRanges() { val defs=Cache(Paths.get("../../server/caches/osrs-241_2026-10-20")).varbits();assertTrue(defs.size>1000);defs.values.forEach{assertTrue(it[0]>=0);assertTrue(it[1] in 0..31);assertTrue(it[2] in it[1]..31)} }
 @Test fun realGroupJs5HasCorrectHeadersAnd512ByteContinuation() {
  val cache=Cache(Paths.get("../../server/caches/osrs-241_2026-10-20"));val raw=cache.group(10,0)!!
  val encoded=cache.provide(10,0)!!
  try {
   assertEquals(10,encoded.getUnsignedByte(0).toInt());assertEquals(0,encoded.getUnsignedShort(1))
   assertEquals(raw[0],encoded.getByte(3))
   if(encoded.readableBytes()>512)assertEquals(255,encoded.getUnsignedByte(512).toInt())
   assertNull(cache.provide(254,65535))
  } finally {encoded.release()}
 }
}
