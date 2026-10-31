package gateway

import com.fasterxml.jackson.core.JsonParser
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.Path
import javax.imageio.ImageIO

private const val MAX_BRANDING_BYTES=8*1024*1024
data class BrandingAsset(val bytes:ByteArray,val contentType:String)
data class Branding(val welcomeText:String?=null,val welcomeBanner:BrandingAsset?=null,val loginBackground:BrandingAsset?=null) {
 fun metadata():ByteArray=json.writeValueAsBytes(mapOf(
  "welcomeText" to welcomeText,
  "welcomeBanner" to welcomeBanner?.let{"/branding/welcome-banner"},
  "loginBackground" to loginBackground?.let{"/branding/login-background"},
 ))
 fun asset(route:String):BrandingAsset?=when(route){
  "/branding/welcome-banner"->welcomeBanner
  "/branding/login-background"->loginBackground
  else->null
 }
}

/** Only configured files are served; HTTP input never becomes a filesystem path. */
fun loadBranding(config:Path?):Branding {
 if(config==null)return Branding()
 val file=config.toRealPath();require(Files.isRegularFile(file)){"Branding config must be a file"}
 val bytes=Files.newInputStream(file).use{it.readNBytes(64*1024+1)}
 require(bytes.size<=64*1024){"Branding config exceeds64KiB"}
 val node=json.factory.createParser(bytes).use {parser->
  parser.enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
  json.readTree<com.fasterxml.jackson.databind.JsonNode>(parser)
 }
 require(node!=null && node.isObject){"Branding config must be a JSON object"}
 val names=setOf("welcomeText","welcomeBanner","loginBackground")
 require(node.fieldNames().asSequence().all{it in names}){"Unknown branding config field"}
 fun text(name:String):String? {
  val value=node[name]?:return null
  if(value.isNull)return null
  require(value.isTextual){"Branding $name must be text or null"}
  return value.asText()
 }
 val welcome=text("welcomeText")?.replace("\r\n","\n")
 require(welcome==null || (welcome.length<=400 && welcome.none{it.isISOControl() && it!='\n'})){"welcomeText must be at most400 plain characters; newlines are allowed"}
 fun image(name:String):BrandingAsset? {
  val value=text(name)?.takeIf{it.isNotBlank()}?:return null
  val relative=Path.of(value)
  require(!relative.isAbsolute){"$name must be relative to the branding config"}
  val target=file.parent.resolve(relative).normalize().toRealPath()
  require(target.startsWith(file.parent) && Files.isRegularFile(target)){"$name must remain inside the branding config directory"}
  val data=Files.newInputStream(target).use{it.readNBytes(MAX_BRANDING_BYTES+1)}
  require(data.size<=MAX_BRANDING_BYTES){"$name exceeds8MiB"}
  val mime=ImageIO.createImageInputStream(ByteArrayInputStream(data)).use {input->
   requireNotNull(input){"$name is not an image"}
   val readers=ImageIO.getImageReaders(input);require(readers.hasNext()){"$name is not a supported image"}
   val reader=readers.next()
   try {
    reader.input=input
    val format=reader.formatName.lowercase(java.util.Locale.ROOT)
    require(format in listOf("png","jpeg","jpg")){"$name must be PNG or JPEG"}
    require(reader.getWidth(0) in 1..4096 && reader.getHeight(0) in 1..4096){"$name dimensions exceed4096"}
    reader.read(0).flush()
    if(format=="png")"image/png" else "image/jpeg"
   } finally {reader.dispose()}
  }
  return BrandingAsset(data,mime)
 }
 return Branding(welcome,image("welcomeBanner"),image("loginBackground"))
}
