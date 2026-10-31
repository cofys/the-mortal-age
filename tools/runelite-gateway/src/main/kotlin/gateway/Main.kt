@file:OptIn(kotlin.ExperimentalStdlibApi::class, kotlin.ExperimentalUnsignedTypes::class)
package gateway
import io.netty.buffer.Unpooled
import net.rsprot.compression.HuffmanCodec
import net.rsprot.compression.provider.DefaultHuffmanCodecProvider
import net.rsprot.crypto.rsa.RsaKeyPair
import net.rsprot.crypto.xtea.XteaKey
import net.rsprot.protocol.api.*
import net.rsprot.protocol.api.login.GameLoginResponseHandler
import net.rsprot.protocol.common.client.OldSchoolClientType
import net.rsprot.protocol.loginprot.incoming.util.*
import net.rsprot.protocol.loginprot.outgoing.LoginResponse
import net.rsprot.protocol.loginprot.outgoing.util.AuthenticatorResponse
import net.rsprot.protocol.message.codec.incoming.*
import net.rsprot.protocol.message.codec.incoming.provider.*
import net.rsprot.protocol.game.outgoing.info.*
import net.rsprot.protocol.game.outgoing.info.util.*
import net.rsprot.protocol.game.outgoing.info.npcinfo.NpcAvatar
import net.rsprot.protocol.game.outgoing.map.RebuildLoginV2
import net.rsprot.protocol.game.outgoing.map.RebuildNormalV2
import net.rsprot.protocol.game.incoming.misc.user.MoveGameClick
import java.nio.file.*
import java.net.*
import java.security.*
import java.security.interfaces.*
import java.util.Properties
import java.util.concurrent.*
import com.fasterxml.jackson.databind.JsonNode

lateinit var service: NetworkService<Bridge>
val loop=Executors.newSingleThreadScheduledExecutor()
val sessions=mutableSetOf<Bridge>()
class Bridge(val response:GameLoginResponseHandler<Bridge>,val block:LoginBlock<AuthenticationType>,val uri:URI) {
 lateinit var upstream:Upstream
 var session:Session<Bridge>?=null
 var infos:Infos?=null
 val players=mutableMapOf<Int,Infos>()
 val npcs=mutableMapOf<Int,NpcAvatar>()
 val assembler=SnapshotAssembler()
 var lastSnapshot:JsonNode?=null
 var closed=false
 var baseX=-1
 var baseY=-1
 val appearances=mutableMapOf<Int,String>()
 var pendingEquipment:net.rsprot.protocol.game.outgoing.inv.UpdateInvFull?=null
 val initialPackets=mutableListOf<Pair<Int,ByteArray>>()
 val publicChats=PublicChatUpdates()
 var loginDeadline:ScheduledFuture<*>?=null
 fun connect() {
  val auth=block.authentication as? AuthenticationType.PasswordAuthentication ?: run {close(LoginResponse.InvalidUsernameOrPassword);return}
  loginDeadline=loop.schedule({if(session==null){System.err.println("Timed out waiting for authoritative TSPS snapshot");close()}},30,TimeUnit.SECONDS)
  upstream=Upstream(uri,block.username,auth.password.asString(),{op,p->loop.execute {try {receive(op,p)}catch(t:Throwable){t.printStackTrace();close()}}},{t->loop.execute {if(!closed){System.err.println(t.message);close()}}})
  upstream.connect()
 }
 fun close(pendingFailure:LoginResponse=LoginResponse.LoginServerOffline) { if(closed)return;closed=true;loginDeadline?.cancel(false);sessions.remove(this);session?.requestClose();if(session==null)response.writeFailedResponse(pendingFailure);if(::upstream.isInitialized)upstream.close(); players.values.forEach(service.infoProtocols::dealloc);players.clear();npcs.values.forEach(service.npcAvatarFactory::release);npcs.clear() }
 fun receive(op:Int,p:ByteArray) {
  if(closed)return
  if(op==6) {
   val envelope=json.readTree(p);if(envelope.path("channel").asText()!="runelite-gateway")return
   val node=envelope["data"];val kind=node.path("type").asText()
   if(kind in listOf("error","disabled")){System.err.println("TSPS gateway snapshot subscription unavailable");close();return}
   if(kind!="sync")return
   val full=assembler.add(node) ?: return
   sync(full)
  } else if(session!=null) translate(op,p) else if(op !in listOf(0,1,2,3,20,21)) initialPackets.add(op to p)
 }
 fun sync(s:JsonNode) {
  val index=s["localIndex"].asInt();val local=s["players"].first {it["index"].asInt()==index}
  val visible=s["players"].map {it["index"].asInt()}.toSet()
  publicChats.retainSenders(visible)
  players.keys.toList().filter {it !in visible}.forEach {service.infoProtocols.dealloc(players.remove(it)!!);appearances.remove(it)}
  for(p in s["players"]) {
   val id=p["index"].asInt();val inf=players.getOrPut(id){service.infoProtocols.alloc(id,OldSchoolClientType.DESKTOP)}
   inf.updateRootCoord(p["level"].asInt(),p["x"].asInt(),p["y"].asInt());inf.updateRootBuildArea(s["baseX"].asInt() shr 3,s["baseY"].asInt() shr 3)
      val ext=inf.playerInfo.avatar.extendedInfo
   val appearanceBytes=p["appearance"].asText()
   if(appearances[id]!=appearanceBytes){appearance(ext,java.util.Base64.getDecoder().decode(appearanceBytes));appearances[id]=appearanceBytes;if(id==index)pendingEquipment=equipmentFromAppearance(java.util.Base64.getDecoder().decode(appearanceBytes))}
   if(p.has("movementType"))ext.setMoveSpeed(p["movementType"].asInt())
   if(p.has("animation"))ext.setSequence(p["animation"]["id"].asInt(),p["animation"]["delay"].asInt())
   val forced=p["forcedChat"]?.asText()
   val forcedIsPublic=forced!=null && publicChats.matches(id,forced)
   val publicChat=publicChats.take(id)
   if(publicChat!=null){ext.setChat(0,0,publicChat.modicon,publicChat.autotyper,publicChat.text.take(80),null);GatewayDebug.log{"[gateway] Native public chat sender=$id text=${publicChat.text}"}}
   if(forced!=null && !forcedIsPublic)ext.setSay(forced.take(80))
   p["health"]?.let{h->val bar=h.path("bar").path("id").asInt(0);val width=h.path("bar").path("width").asInt(30);val fill=(h["current"].asDouble()/h["max"].asDouble().coerceAtLeast(1.0)*width).toInt().coerceIn(0,width);ext.addHeadBar(-1,bar,bar,fill)}
   if(p.has("interactionIndex"))ext.setFacePathingEntity(p["interactionIndex"].asInt())
   p["graphics"]?.forEach{ext.setSpotAnim(it.path("slot").asInt(),it["id"].asInt(),it.path("delay").asInt(),it.path("height").asInt())}
   p["hits"]?.forEach{val type=it["type"].asInt();ext.addHitMark(-1,type,type,type,it["damage"].asInt(),it.path("delay").asInt())}
  }
  val visibleNpcs=s["npcs"].map {it["index"].asInt()}.toSet()
  npcs.keys.toList().filter {it !in visibleNpcs}.forEach{service.npcAvatarFactory.release(npcs.remove(it)!!)}
  for(n in s["npcs"]) {
   val id=n["index"].asInt();val avatar=npcs.getOrPut(id){service.npcAvatarFactory.alloc(id,n["typeId"].asInt(),n["level"].asInt(),n["x"].asInt(),n["y"].asInt())}
      val dx=n["x"].asInt()-avatar.x();val dy=n["y"].asInt()-avatar.z()
   if(n["level"].asInt()!=avatar.level() || kotlin.math.abs(dx)>2 || kotlin.math.abs(dy)>2)avatar.teleport(n["level"].asInt(),n["x"].asInt(),n["y"].asInt(),true)
   else if(dx!=0 || dy!=0){avatar.walk(dx.coerceIn(-1,1),dy.coerceIn(-1,1));val rx=dx-dx.coerceIn(-1,1);val ry=dy-dy.coerceIn(-1,1);if(rx!=0 || ry!=0)avatar.walk(rx,ry)}
   val ext=avatar.extendedInfo
   if(n.has("animation"))ext.setSequence(n["animation"]["id"].asInt(),n["animation"]["delay"].asInt())
   if(n.has("forcedChat"))ext.setSay(n["forcedChat"].asText().take(256))
   n["health"]?.let{h->val bar=h.path("bar").path("id").asInt(0);val width=h.path("bar").path("width").asInt(30);val fill=(h["current"].asDouble()/h["max"].asDouble().coerceAtLeast(1.0)*width).toInt().coerceIn(0,width);ext.addHeadBar(-1,bar,bar,fill)}
   if(n.has("interactionIndex"))ext.setFacePathingEntity(n["interactionIndex"].asInt())
   n["graphics"]?.forEach{ext.setSpotAnim(it.path("slot").asInt(),it["id"].asInt(),it.path("delay").asInt(),it.path("height").asInt())}
   n["hits"]?.forEach{val type=it["type"].asInt();ext.addHitMark(-1,type,type,it["damage"].asInt(),it.path("delay").asInt())}
  }
  infos=players[index]
  if(session==null) {
   val identity=java.nio.ByteBuffer.wrap(MessageDigest.getInstance("SHA-256").digest(("tsps-local:"+block.username.lowercase(java.util.Locale.ROOT)).toByteArray())).long.let{if(it==0L)1L else it}
   session=response.writeSuccessfulResponse(LoginResponse.Ok(AuthenticatorResponse.NoAuthenticator,0,false,index,true,identity,identity,identity),block)
   loginDeadline?.cancel(false)
   session!!.setDisconnectionHook {loop.execute{close()}}
   session!!.queue(RebuildLoginV2(local["x"].asInt() shr 3,local["y"].asInt() shr 3,0,infos!!.playerInfo))
   initialPackets.forEach{translate(it.first,it.second)};initialPackets.clear()
   // Match the TSPS browser's successful-handshake display-name transmitter.
   translate(42,payload{writeShort(8119);writeInt(1)})
   println("Native login accepted by TSPS, index=$index")
  }
  pendingEquipment?.let{session!!.queue(it)};pendingEquipment=null
  if(baseX!=s["baseX"].asInt() || baseY!=s["baseY"].asInt()) {
   if(lastSnapshot!=null)session!!.queue(RebuildNormalV2(local["x"].asInt() shr 3,local["y"].asInt() shr 3,0))
   baseX=s["baseX"].asInt();baseY=s["baseY"].asInt()
  }
  service.infoProtocols.update()
  val packets=infos!!.getPackets().rootWorldInfoPackets
  val sess=session!!;sess.queue(packets.activeWorld);sess.queue(packets.npcUpdateOrigin)
  packets.worldEntityInfo.onSuccess(sess::queue).onFailure{throw it}
  packets.playerInfo.onSuccess(sess::queue).onFailure{throw it}
  if(packets.npcInfo.isEmpty())packets.npcInfo.safeReleaseOrThrow()
  else packets.npcInfo.onSuccess(sess::queue).onFailure{throw it}
  sess.queue(net.rsprot.protocol.game.outgoing.misc.client.ServerTickEnd)
  sess.flush();lastSnapshot=s
 }
 fun translate(op:Int,p:ByteArray) {
  if(op==120){val chat=decodePublicChat(p);if(chat!=null){publicChats.offer(chat);GatewayDebug.log{"[gateway] Queued native public chat sender=${chat.sender} text=${chat.text}"};return}}
  outgoing(op,p)
 }
}
fun main(args:Array<String>) {
 val opts=args.toList().chunked(2).associate{require(it.size==2);it[0].removePrefix("--") to it[1]}
 GatewayDebug.enabled=opts["trace-input"]=="true"
 val branding=loadBranding(opts["branding"]?.let{Paths.get(it)})
 val port=opts["port"]?.toInt()?:43820;require(port !in listOf(43594,3000,49700))
 ServerSocket().use {it.bind(InetSocketAddress("127.0.0.1",port))}
 val uri=URI(opts["upstream"]?:"ws://127.0.0.1:43720");require(uri.scheme=="ws" && InetAddress.getByName(uri.host).isLoopbackAddress && uri.port !in listOf(43594,3000,49700) && uri.port in 1024..65535) {"Upstream must be an isolated loopback WebSocket port"}
 val cachePath=Paths.get(opts["cache"]?:"../../server/caches/osrs-241_2026-10-20").toRealPath()
 require(cachePath.startsWith(Paths.get("../..").toRealPath())) {"Use only this worktree copied cache"}
 val cache=Cache(cachePath)
 configureVarbits(cache.varbits())
 configureVarpCapacity(cache.files(2,16).keys.max()+1)
 val widgets=cache.fileIds(3).mapValues{it.value.toSet()}
 configureWidgetComponents{uid->widgets[uid ushr 16]?.contains(uid and 65535)==true}
 val keys=Paths.get(opts["keys"]?:".runtime/rsa.properties");Files.createDirectories(keys.parent)
 val props=Properties()
 if(Files.exists(keys))Files.newInputStream(keys).use(props::load) else {
  val kp=KeyPairGenerator.getInstance("RSA").apply{initialize(1024)}.generateKeyPair();val pub=kp.public as RSAPublicKey;val priv=kp.private as RSAPrivateKey
  props["modulus"]=pub.modulus.toString(16);props["publicExponent"]=pub.publicExponent.toString(16);props["privateExponent"]=priv.privateExponent.toString(16)
  Files.newOutputStream(keys).use{props.store(it,"Local disposable gateway key")}
 }
 Files.writeString(keys.parent.resolve("rsa-modulus.txt"),props.getProperty("modulus"))
 service=object:AbstractNetworkServiceFactory<Bridge>() {
  override val host="127.0.0.1"
  override val ports=listOf(port)
  override val supportedClientTypes=listOf(OldSchoolClientType.DESKTOP)
  override fun getRsaKeyPair()=RsaKeyPair(props.getProperty("privateExponent").toBigInteger(16),props.getProperty("modulus").toBigInteger(16))
  override fun getHuffmanCodecProvider()=DefaultHuffmanCodecProvider(HuffmanCodec.create(Unpooled.wrappedBuffer(cache.huffman())))
  override fun getJs5GroupProvider()=cache
  override fun getGameMessageConsumerRepositoryProvider()=GameMessageConsumerRepositoryProvider<Bridge> {
   val repository=consumers()
   val trace=MessageConsumer<Bridge,net.rsprot.protocol.message.IncomingGameMessage>{_,message->
    if(message is net.rsprot.protocol.game.incoming.npcs.OpNpcV2)GatewayDebug.log{"[gateway] Native OpNpcV2 index=${message.index} op=${message.op} -> TSPS opcode=${nativeAction(message)?.opcode}"}
    if(message is net.rsprot.protocol.game.incoming.messaging.MessagePublic)GatewayDebug.log{"[gateway] Native MessagePublic type=${message.type} -> TSPS opcode=${nativeAction(message)?.opcode} text=${message.message}"}
   }
   GameMessageConsumerRepository(repository.consumers,repository.globalConsumers+trace)
  }
  override fun getGameConnectionHandler()=object:GameConnectionHandler<Bridge> {
   override fun onLogin(responseHandler:GameLoginResponseHandler<Bridge>,block:LoginBlock<AuthenticationType>) {loop.execute{
    if(sessions.isNotEmpty())responseHandler.writeFailedResponse(LoginResponse.ServerFull) else {val b=Bridge(responseHandler,block,uri);sessions.add(b);b.connect()}
   }}
   override fun onReconnect(responseHandler:GameLoginResponseHandler<Bridge>,block:LoginBlock<XteaKey>) {responseHandler.writeFailedResponse(LoginResponse.LoginServerNoReply)}
  }
 }.build()
 http(opts["http-port"]?.toInt()?:43920,Paths.get(opts["jav-config"]?:"../runelite-client/jav_config.lock.ws"),branding)
 service.start();loop.scheduleAtFixedRate({sessions.toList().forEach{if(!it.response.ctx.channel().isActive)it.close() else it.session?.let{s->s.processIncomingPackets(it);s.flush()}}},100,100,TimeUnit.MILLISECONDS)
 Runtime.getRuntime().addShutdownHook(Thread {service.shutdownNow();loop.shutdownNow()})
 println("Gateway241 listening 127.0.0.1:$port upstream=$uri RSA=$keys")
}
