package gateway
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.file.*
fun http(port:Int,config:Path,branding:Branding=Branding()):HttpServer {
 require(port !in listOf(43594,3000,49700));val h=HttpServer.create(InetSocketAddress("127.0.0.1",port),0)
 val boundPort=h.address.port
 val raw=Files.readString(config,Charsets.ISO_8859_1).lines().map { line ->
  when {
   line.startsWith("codebase=")->"codebase=http://127.0.0.1:$boundPort/"
   line.startsWith("param=12=")->"param=12=301"
   line.startsWith("param=25=")->"param=25=241"
   line.startsWith("param=17=")->"param=17=http://127.0.0.1:$boundPort/slr.ws"
   line.startsWith("param=13=")->"param=13=127.0.0.1"
   line.startsWith("param=") && line.contains("https://")->line.substringBeforeLast('=')+"=http://127.0.0.1:$boundPort/"
   else->line
  }
 }.joinToString("\n").toByteArray()
 val worlds="""{"worlds":[{"id":301,"types":["MEMBERS"],"address":"127.0.0.1","activity":"TSPS local","location":0,"players":1}]}""".toByteArray()
 val worldList=payload{writeInt(0);writeShort(1);writeShort(301);writeInt(1);text("127.0.0.1");text("TSPS local");writeByte(0);writeShort(1)}
 h.createContext("/"){x->
  try {
   if(x.requestMethod !in listOf("GET","HEAD")) {
    x.responseHeaders.set("Allow","GET, HEAD");x.sendResponseHeaders(405,-1)
   } else {
    val asset=when(x.requestURI.path){
     "/jav_config.ws"->BrandingAsset(raw,"text/plain")
     "/worlds.js"->BrandingAsset(worlds,"application/json")
     "/slr.ws"->BrandingAsset(worldList,"application/octet-stream")
     "/branding.json"->BrandingAsset(branding.metadata(),"application/json")
     else->branding.asset(x.requestURI.path)
    }
    if(asset==null)x.sendResponseHeaders(404,-1) else {
     x.responseHeaders.set("Content-Type",asset.contentType)
     x.responseHeaders.set("Cache-Control","no-store")
     if(x.requestMethod=="HEAD") {
      x.responseHeaders.set("Content-Length",asset.bytes.size.toString());x.sendResponseHeaders(200,-1)
     } else {x.sendResponseHeaders(200,asset.bytes.size.toLong());x.responseBody.use{it.write(asset.bytes)}}
    }
   }
  } finally {x.close()}
 }
 h.start();Runtime.getRuntime().addShutdownHook(Thread{h.stop(0)})
 println("Gateway HTTP 127.0.0.1:$boundPort")
 return h
}
