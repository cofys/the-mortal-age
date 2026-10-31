package gateway

import io.netty.buffer.Unpooled
import net.rsprot.protocol.api.js5.Js5GroupProvider
import java.io.*
import java.nio.file.Path
import java.util.zip.CRC32
import java.util.zip.GZIPInputStream

/** Read-only sector cache; never opens the source cache for writing. */
class Cache(private val root: Path): Js5GroupProvider {
 private val data = RandomAccessFile(root.resolve("main_file_cache.dat2").toFile(), "r")
 @Synchronized fun group(archive: Int, group: Int): ByteArray? {
  val index = root.resolve("main_file_cache.idx$archive").toFile()
  if (!index.exists()) return null
  RandomAccessFile(index, "r").use { idx ->
   if (group * 6L + 6 > idx.length()) return null
   idx.seek(group * 6L)
   val size = (idx.readUnsignedByte() shl 16) or (idx.readUnsignedByte() shl 8) or idx.readUnsignedByte()
   var sector = (idx.readUnsignedByte() shl 16) or (idx.readUnsignedByte() shl 8) or idx.readUnsignedByte()
   if (size == 0 || sector == 0) return null
   require(size <= 32 * 1024 * 1024)
   val out = ByteArrayOutputStream(size); var chunk = 0
   while (out.size() < size) {
    require(sector > 0 && sector * 520L < data.length()) { "Invalid cache sector" }
    data.seek(sector * 520L)
    val large = group > 65535
    val id = if (large) data.readInt() else data.readUnsignedShort()
    val n = data.readUnsignedShort()
    val next = (data.readUnsignedByte() shl 16) or (data.readUnsignedByte() shl 8) or data.readUnsignedByte()
    val a = data.readUnsignedByte()
    require(id == group && n == chunk && a == archive) { "Cache chain mismatch $archive:$group" }
    val block = ByteArray(minOf(size - out.size(), if(large) 510 else 512)); data.readFully(block); out.write(block)
    sector = next; chunk++
   }
   return out.toByteArray()
  }
 }
 fun unpack(bytes: ByteArray): ByteArray {
  val b=DataInputStream(ByteArrayInputStream(bytes)); val type=b.readUnsignedByte(); val n=b.readInt()
  return when(type) {
   0 -> ByteArray(n).also(b::readFully)
   1 -> { b.readInt(); org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream(SequenceInputStream(ByteArrayInputStream(byteArrayOf(66,90,104,49)),b)).readAllBytes() }
   2 -> { b.readInt(); GZIPInputStream(b).readAllBytes() }
   else -> error("Unsupported compression $type")
  }
 }
 /** JS5 multi-file archive reader, used for authoritative cache definitions. */
 fun fileIds(archive:Int):Map<Int,IntArray> {
  val index=java.nio.ByteBuffer.wrap(unpack(group(255,archive) ?: error("Missing index$archive")))
  val version=index.get().toInt() and 255;require(version in 5..7);if(version>=6)index.int
  val flags=index.get().toInt() and 255
  fun smart():Int {return if(version==7 && index.get(index.position())<0)index.int and Int.MAX_VALUE else index.short.toInt() and 65535}
  val count=smart();var id=0;val groups=IntArray(count){id+=smart();id}
  if(flags and 1 !=0)index.position(index.position()+count*4)
  if(flags and 2 !=0)index.position(index.position()+count*64)
  index.position(index.position()+count*4)
  if(flags and 4 !=0)index.position(index.position()+count*8)
  index.position(index.position()+count*4)
  val counts=IntArray(count){smart()}
  return groups.indices.associate{g->var last=0;groups[g] to IntArray(counts[g]){last+=smart();last}}
 }
 fun files(archive:Int,groupId:Int):Map<Int,ByteArray> {
  val ids=fileIds(archive)[groupId] ?: error("Missing group $archive:$groupId")
  val bytes=unpack(group(archive,groupId) ?: error("Missing group$archive:$groupId"))
  if(ids.size==1)return mapOf(ids[0] to bytes)
  require(ids.isNotEmpty());val chunks=bytes.last().toInt() and 255
  val table=java.nio.ByteBuffer.wrap(bytes);table.position(bytes.size-1-chunks*ids.size*4)
  val outputs=Array(ids.size){ByteArrayOutputStream()};var offset=0
  repeat(chunks){var length=0;for(i in ids.indices){length+=table.int;require(length>=0 && offset+length<=bytes.size);outputs[i].write(bytes,offset,length);offset+=length}}
  return ids.indices.associate{ids[it] to outputs[it].toByteArray()}
 }
 fun varbits():Map<Int,IntArray> = files(2,14).mapValues{(_,bytes)->
  val b=DataInputStream(ByteArrayInputStream(bytes));require(b.readUnsignedByte()==1);intArrayOf(b.readUnsignedShort(),b.readUnsignedByte(),b.readUnsignedByte())
 }
 fun huffman():ByteArray { for(id in 0..255) { val g=group(10,id) ?: continue; val b=unpack(g);if(b.size==256)return b };error("Missing Huffman in binary archive10") }
 private fun master(): ByteArray {
  val out=ByteArrayOutputStream(); val d=DataOutputStream(out)
  val max = root.toFile().listFiles()!!.mapNotNull { it.name.removePrefix("main_file_cache.idx").toIntOrNull() }.filter { it != 255 }.max()
  for (id in 0..max) {
   val g=group(255,id)
   d.writeInt(g?.let { CRC32().apply { update(it,0,java.nio.ByteBuffer.wrap(it,1,4).int + if(it[0].toInt()==0)5 else 9) }.value.toInt() } ?: 0)
   val decoded=g?.let(::unpack)
   d.writeInt(if(decoded != null && decoded[0].toInt() >= 6) DataInputStream(ByteArrayInputStream(decoded,1,decoded.size-1)).readInt() else 0)
  }
  return ByteArrayOutputStream().also { val b=DataOutputStream(it); b.writeByte(0); b.writeInt(out.size()); b.write(out.toByteArray()) }.toByteArray()
 }
 override fun provide(archive: Int, group: Int): io.netty.buffer.ByteBuf? {
  val raw=if(archive==255 && group==255) master() else group(archive,group) ?: return null
  val n=java.nio.ByteBuffer.wrap(raw,1,4).int + if(raw[0].toInt()==0) 5 else 9
  require(n<=raw.size)
  val out=ByteArrayOutputStream(); val d=DataOutputStream(out); d.writeByte(archive);d.writeShort(group)
  var block=3
  for (i in 0 until n) { if(block==512) {d.writeByte(255);block=1};d.writeByte(raw[i].toInt());block++ }
  return Unpooled.unreleasableBuffer(Unpooled.wrappedBuffer(out.toByteArray()))
 }
}
