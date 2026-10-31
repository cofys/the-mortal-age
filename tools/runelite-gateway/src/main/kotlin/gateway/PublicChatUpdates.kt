package gateway

data class NativePublicChat(val sender:Int,val text:String,val modicon:Int,val autotyper:Boolean)

/** Public chat belongs in the native player-info chat block, not MessageGame(type2). */
fun decodePublicChat(bytes:ByteArray):NativePublicChat? {
 val d=java.io.DataInputStream(java.io.ByteArrayInputStream(bytes))
 val text=d.text();val type=d.readUnsignedByte();val from=d.text();d.text();val sender=d.readUnsignedShort()
 if(type !in listOf(2,90,91) || sender !in 1..2047)return null
 // Native PlayerType ordinal1 is moderator(icon0), ordinal2 administrator(icon1).
 val icon=Regex("^<img=(\\d+)>").find(from)?.groupValues?.get(1)?.toIntOrNull()
 val modicon=when(icon){0->1;1->2;else->0}
 return NativePublicChat(sender,text,modicon,type==90 || type==91)
}

class PublicChatUpdates {
 private val pending=mutableMapOf<Int,java.util.ArrayDeque<NativePublicChat>>()
 fun offer(chat:NativePublicChat){pending.getOrPut(chat.sender){java.util.ArrayDeque()}.addLast(chat)}
 fun matches(sender:Int,forced:String):Boolean=pending[sender]?.any{matchesPublicChat(it,forced)}==true
 fun retainSenders(visible:Set<Int>){pending.keys.retainAll(visible)}
 fun take(sender:Int):NativePublicChat? {
  val queue=pending[sender] ?: return null
  val chat=queue.pollFirst();if(queue.isEmpty())pending.remove(sender);return chat
 }
}

fun matchesPublicChat(chat:NativePublicChat,forced:String):Boolean =
 forced.replace(Regex("^(?:<img=\\d+>)+"),"")==chat.text

object GatewayDebug {
 var enabled=false
 fun log(message:()->String){if(enabled)println(message())}
}
