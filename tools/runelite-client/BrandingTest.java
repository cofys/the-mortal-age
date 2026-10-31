import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.imageio.ImageIO;
import com.sun.net.httpserver.HttpServer;

/** Focused executable tests; uses real HTTP sockets and encoded PNG/JPEG bytes. */
public final class BrandingTest {
    private static int checks;
    private static void check(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message); }
    interface Throwing { void run() throws Exception; }
    private static void rejects(Throwing action, String message) throws Exception {
        try { action.run(); } catch (IOException | IllegalArgumentException expected) { checks++; return; }
        throw new AssertionError(message);
    }
    private static byte[] image(String format, int w, int h) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(w,h,BufferedImage.TYPE_INT_RGB),format,out); return out.toByteArray();
    }
    public static void main(String[] args) throws Exception {
        URI base = BrandingAssets.endpoint("http://127.0.0.1:12345/branding.json");
        for (String invalid : new String[]{"https://127.0.0.1:123/branding.json","http://example.com:123/branding.json","http://127.0.0.1:123/branding.json?x=1","http://user@127.0.0.1:123/branding.json","http://127.0.0.1:123/branding.json#f"})
            rejects(() -> BrandingAssets.endpoint(invalid),"Unsafe endpoint accepted");
        var metadata = BrandingAssets.parse(base,"{\"welcomeText\":\"<col=ff0000>Hello>\\nworld\",\"welcomeBanner\":\"//example.com/branding/welcome-banner\",\"loginBackground\":\"/branding/login-background\"}");
        check(metadata.text().equals("<lt>col=ff0000<gt>Hello<gt><br>world"),"Native text injection");
        check(metadata.banner() == null && metadata.background().equals(base.resolve("/branding/login-background")),"Independent exact routes");
        metadata = BrandingAssets.parse(base,"{\"welcomeText\":123,\"welcomeBanner\":\"/branding/welcome-banner\",\"loginBackground\":{}}");
        check(metadata.text() == null && metadata.banner() != null && metadata.background() == null,"Independent field types");
        check(BrandingAssets.parse(base,"{\"welcomeText\":\""+"a".repeat(401)+"\"}").text() == null,"Text limit");
        check(BrandingAssets.parse(base,"{}").text() == null,"Unset stays stock");
        rejects(() -> BrandingAssets.parse(base,"[]"),"Array metadata accepted");
        check(BrandingAssets.decode(image("png",707,199)).getWidth() == 707,"Real PNG");
        check(BrandingAssets.decode(image("jpeg",765,503)).getHeight() == 503,"Real JPEG");
        rejects(() -> BrandingAssets.decode(image("gif",2,2)),"GIF accepted");
        rejects(() -> BrandingAssets.decode(new byte[]{1,2,3}),"Corrupt image accepted");
        rejects(() -> BrandingAssets.decode(image("png",4097,1)),"Oversized dimensions accepted");
        rejects(() -> BrandingAssets.decode(new byte[BrandingAssets.MAX_IMAGE+1]),"Oversized bytes accepted");
        Rectangle bounds = new Rectangle(33,78,699,191);
        Rectangle fit = BrandingAssets.fit(1000,100,bounds,false);
        check(bounds.contains(fit) && fit.width == 699 && fit.y > bounds.y,"Banner contain fit");
        Rectangle cover = BrandingAssets.fit(100,100,new Rectangle(765,503),true);
        check(cover.contains(new Rectangle(765,503)),"Login cover fit");
        check(BrandingAssets.loginImage(new BufferedImage(10,20,BufferedImage.TYPE_INT_RGB)).getWidth() == 765,"Login target size");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        byte[] png = image("png",30,20);
        server.createContext("/branding.json", exchange -> {
            byte[] data = "{\"welcomeText\":\"Keep text\",\"welcomeBanner\":\"/branding/welcome-banner\",\"loginBackground\":\"/branding/login-background\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200,data.length); exchange.getResponseBody().write(data); exchange.close();
        });
        server.createContext("/branding/welcome-banner", exchange -> { exchange.sendResponseHeaders(200,3); exchange.getResponseBody().write(new byte[]{1,2,3}); exchange.close(); });
        server.createContext("/branding/login-background", exchange -> { exchange.sendResponseHeaders(200,png.length); exchange.getResponseBody().write(png); exchange.close(); });
        server.createContext("/redirect", exchange -> { exchange.getResponseHeaders().add("Location","http://example.com/"); exchange.sendResponseHeaders(302,-1); exchange.close(); });
        server.createContext("/oversized", exchange -> { exchange.sendResponseHeaders(200,10000); exchange.close(); });
        server.createContext("/chunked", exchange -> { exchange.sendResponseHeaders(200,0); exchange.getResponseBody().write(new byte[64]); exchange.close(); });
        server.start();
        try {
            URI local = URI.create("http://127.0.0.1:"+server.getAddress().getPort());
            var loaded = BrandingAssets.load(local.resolve("/branding.json"));
            check(loaded.text().equals("Keep text") && loaded.banner() == null && loaded.background().getWidth() == 30,"Real corrupt banner preserves other fields");
            rejects(() -> BrandingAssets.fetch(local.resolve("/redirect"),100),"Redirect followed");
            rejects(() -> BrandingAssets.fetch(local.resolve("/oversized"),100),"Content-length bound ignored");
            rejects(() -> BrandingAssets.fetch(local.resolve("/chunked"),16),"Chunked bound ignored");
        } finally { server.stop(0); }
        System.out.println("BrandingTest: "+checks+" checks passed");
    }
}
