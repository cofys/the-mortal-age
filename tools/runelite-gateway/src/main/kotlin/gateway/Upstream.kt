package gateway
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.io.*
import java.net.URI
import java.net.http.*
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture

val json = jacksonObjectMapper()
fun payload(block: DataOutputStream.()->Unit):ByteArray = ByteArrayOutputStream().also { DataOutputStream(it).use(block) }.toByteArray()
fun DataOutputStream.text(s:String) { write(s.toByteArray(Charsets.ISO_8859_1));writeByte(0) }
fun clientPacket(op:Int, data:ByteArray=byteArrayOf(), length:Int=0):ByteArray = payload {writeByte(op);if(length==1)writeByte(data.size);if(length==2)writeShort(data.size);write(data)}
/** JDK WebSocket permits one outstanding binary write; preserve action order explicitly. */
class SerialWrites(private val failure:(Throwable)->Unit) {
 private var tail=CompletableFuture.completedFuture(Unit)
 private val failed=java.util.concurrent.atomic.AtomicBoolean()
 fun hasFailed():Boolean=failed.get()
 @Synchronized fun submit(write:()->CompletableFuture<*>) {
  if(failed.get())return
  tail=tail.thenCompose{write().thenApply{Unit}}
  tail.whenComplete{_,error->if(error!=null && failed.compareAndSet(false,true))failure(error)}
 }
}
/** One upstream login per native client. TSPS decides account validity and all world state. */
class Upstream(val uri: URI,val username:String,val password:String,val packet:(Int,ByteArray)->Unit,val failure:(Throwable)->Unit):WebSocket.Listener {
 lateinit var socket:WebSocket
 private val pending=ByteArrayOutputStream()
 private val writes=SerialWrites(failure)
 fun connect() { HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(uri,this).exceptionally {failure(it);null} }
 override fun onOpen(ws:WebSocket) {socket=ws;ws.request(1);send(200,payload {text("runelite-gateway");text("241")},1);send(204,payload{text(username);text(password);writeInt(241);writeByte(0)},2)}
 fun send(op:Int,data:ByteArray=byteArrayOf(),length:Int=0) {val bytes=clientPacket(op,data,length);writes.submit{socket.sendBinary(ByteBuffer.wrap(bytes),true)}}
 override fun onBinary(ws:WebSocket,data:ByteBuffer,last:Boolean):CompletableFuture<*>? {
  val bytes=ByteArray(data.remaining());data.get(bytes);pending.write(bytes)
  if(last) { try {parse(pending.toByteArray())}catch(t:Throwable){failure(t)};pending.reset() };ws.request(1);return null
 }
 private fun parse(bytes:ByteArray) {
  val d=DataInputStream(ByteArrayInputStream(bytes))
  while(d.available()>0) {
   val op=d.readUnsignedByte(); val size=serverLengths[op] ?: error("Unsupported TSPS opcode $op")
   val n=when(size){-1->d.readUnsignedByte();-2->d.readUnsignedShort();else->size}
   require(n<=d.available()) {"Truncated TSPS packet $op"};val p=ByteArray(n);d.readFully(p)
   if(op==3) {
    require(p[0].toInt()==1) {"TSPS login rejected"}
    send(202,payload{text(username);writeByte(0);writeByte(0)},1)
    send(205,json.writeValueAsBytes(mapOf("channel" to "runelite-gateway","data" to mapOf("type" to "subscribe","version" to 1))),2)
   }
   packet(op,p)
  }
 }
 override fun onError(ws:WebSocket,error:Throwable) {failure(error)}
 override fun onClose(ws:WebSocket,status:Int,reason:String):CompletableFuture<*>? {failure(IOException("Upstream closed $status"));return null}
 fun close() {if(::socket.isInitialized){if(writes.hasFailed())socket.abort() else writes.submit{socket.sendClose(1000,"native session ended")}}}
}
class SnapshotAssembler {
 private var tick=-1L
 private var completedTick=-1L
 private var parts=arrayOfNulls<JsonNode>(0)
 fun add(node:JsonNode):JsonNode? {
  require(node.path("version").asInt()==1)
  val t=node.path("tick").asLong();val n=node.path("parts").asInt();val i=node.path("part").asInt()
  require(n in 1..512 && i in 0 until n)
  if(t<tick || t<=completedTick)return null
  if(t>tick){tick=t;parts=arrayOfNulls(n)}
  require(parts.size==n);parts[i]=node
  if(parts.any{it==null})return null
  val out=(node.deepCopy<JsonNode>() as com.fasterxml.jackson.databind.node.ObjectNode)
  for(key in listOf("players","npcs")) { val a=json.createArrayNode();parts.forEach{a.addAll(it!![key] as com.fasterxml.jackson.databind.node.ArrayNode)};out.set<JsonNode>(key,a) }
  completedTick=t;parts=arrayOfNulls(0);return out
 }
}
