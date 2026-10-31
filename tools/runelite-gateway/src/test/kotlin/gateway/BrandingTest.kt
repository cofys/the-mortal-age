package gateway

import java.awt.image.BufferedImage
import java.nio.file.Files
import javax.imageio.ImageIO
import kotlin.test.*

class BrandingTest {
 private fun fixture(body:String,check:(java.nio.file.Path)->Unit) {
  val root=Files.createTempDirectory("gateway-branding-")
  try {
   val config=root.resolve("branding.json");Files.writeString(config,body)
   check(config)
  } finally {root.toFile().deleteRecursively()}
 }
 @Test fun absentConfigKeepsAllStockValues() {
  val metadata=json.readTree(loadBranding(null).metadata())
  for(key in listOf("welcomeText","welcomeBanner","loginBackground"))assertTrue(metadata[key].isNull)
 }
 @Test fun textAndRealImagesAreIndependentAndRoutesNeverExposeFilenames() {
  fixture("""{"welcomeText":"Welcome\nHave fun","welcomeBanner":"banner.png"}"""){config->
   ImageIO.write(BufferedImage(700,190,BufferedImage.TYPE_INT_RGB),"png",config.parent.resolve("banner.png").toFile())
   val branding=loadBranding(config);val metadata=json.readTree(branding.metadata())
   assertEquals("Welcome\nHave fun",metadata["welcomeText"].asText())
   assertEquals("/branding/welcome-banner",metadata["welcomeBanner"].asText())
   assertTrue(metadata["loginBackground"].isNull)
   val asset=assertNotNull(branding.asset("/branding/welcome-banner"))
   assertEquals("image/png",asset.contentType);assertTrue(asset.bytes.isNotEmpty())
   assertNull(branding.asset("/branding/banner.png"));assertNull(branding.asset("/branding/../branding.json"))
  }
 }
 @Test fun rejectsWrongFieldsTypesMissingFilesAndUnsafeText() {
  for(body in listOf("[]","""{"welcomText":"typo"}""","""{"welcomeText":1}""","""{"welcomeBanner":"absent.png"}""","""{"welcomeText":"a\u0000b"}"""))
   fixture(body){assertFails{loadBranding(it)}}
  fixture("""{"welcomeText":"${"a".repeat(401)}"}"""){assertFails{loadBranding(it)}}
  assertFails{loadBranding(java.nio.file.Path.of("missing-branding-config.json"))}
 }
 @Test fun rejectsParentTraversalCorruptAndOversizedImages() {
  fixture("""{"loginBackground":"../outside.png"}"""){assertFails{loadBranding(it)}}
  fixture("""{"loginBackground":"bad.png"}"""){config->
   val image=config.parent.resolve("bad.png");Files.writeString(image,"not an image")
   assertFails{loadBranding(config)}
   Files.newOutputStream(image).use{it.write(ByteArray(8*1024*1024+1))}
   assertFails{loadBranding(config)}
  }
  fixture("""{"welcomeBanner":"wide.png"}"""){config->
   ImageIO.write(BufferedImage(4097,1,BufferedImage.TYPE_INT_RGB),"png",config.parent.resolve("wide.png").toFile())
   assertFails{loadBranding(config)}
  }
 }
 @Test fun jpegBackgroundDoesNotRequireBannerOrText() {
  fixture("""{"loginBackground":"background.jpg"}"""){config->
   ImageIO.write(BufferedImage(765,503,BufferedImage.TYPE_INT_RGB),"jpeg",config.parent.resolve("background.jpg").toFile())
   val branding=loadBranding(config)
   assertEquals("image/jpeg",branding.asset("/branding/login-background")!!.contentType)
   assertNull(branding.welcomeBanner);assertNull(branding.welcomeText)
  }
 }
 @Test fun realHttpServesOnlyFixedRoutesAndPreservesNativeConfig() {
  val config=Files.createTempFile("gateway-http-",".ws")
  Files.writeString(config,"codebase=https://old/\nparam=12=1\nparam=25=1\n")
  val asset=BrandingAsset(byteArrayOf(1,2,3),"image/png")
  val server=http(0,config,Branding("hello",asset))
  try {
   java.net.http.HttpClient.newHttpClient().use {client->
    fun request(path:String,method:String="GET")=client.send(
     java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:${server.address.port}$path"))
      .method(method,java.net.http.HttpRequest.BodyPublishers.noBody()).build(),
     java.net.http.HttpResponse.BodyHandlers.ofByteArray())
    val metadata=request("/branding.json");assertEquals(200,metadata.statusCode())
    assertEquals("hello",json.readTree(metadata.body())["welcomeText"].asText())
    assertContentEquals(asset.bytes,request("/branding/welcome-banner").body())
    assertEquals(0,request("/branding/welcome-banner","HEAD").body().size)
    assertEquals(404,request("/branding.json/extra").statusCode())
    assertEquals(404,request("/branding/unknown").statusCode())
    assertEquals(405,request("/branding.json","POST").statusCode())
    assertTrue(String(request("/jav_config.ws").body()).contains("http://127.0.0.1:${server.address.port}/"))
    assertEquals(200,request("/worlds.js").statusCode());assertEquals(200,request("/slr.ws").statusCode())
   }
  } finally {server.stop(0);Files.deleteIfExists(config)}
 }
}
