import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import javax.imageio.*;
import javax.imageio.stream.ImageInputStream;
import com.google.gson.*;

/** Bounded local branding transport and image/text transformations, independent of RuneLite. */
final class BrandingAssets {
    static final int MAX_IMAGE = 8 * 1024 * 1024;
    record Metadata(String text, URI banner, URI background) {}
    record Loaded(String text, BufferedImage banner, BufferedImage background) {}
    static URI endpoint(String value) {
        URI uri = URI.create(value);
        if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1
            || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
            || !"/branding.json".equals(uri.getRawPath())) throw new IllegalArgumentException("Expected loopback branding endpoint");
        return uri;
    }
    static Metadata parse(URI base, String json) {
        JsonElement root = new JsonParser().parse(json);
        if (!root.isJsonObject()) throw new IllegalArgumentException("Expected branding object");
        JsonObject object = root.getAsJsonObject();
        String text = string(object.get("welcomeText"));
        if (text != null && text.codePointCount(0, text.length()) > 400) text = null;
        return new Metadata(text == null ? null : escape(text), asset(base, object.get("welcomeBanner"), "/branding/welcome-banner"),
            asset(base, object.get("loginBackground"), "/branding/login-background"));
    }
    private static String string(JsonElement e) { return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString() : null; }
    private static URI asset(URI base, JsonElement e, String path) { return path.equals(string(e)) ? base.resolve(path) : null; }
    static String escape(String value) {
        StringBuilder result = new StringBuilder();
        value = value.replace("\r\n", "\n").replace('\r', '\n');
        for (char c : value.toCharArray()) {
            if (c == '<') result.append("<lt>"); else if (c == '>') result.append("<gt>");
            else if (c == '\n') result.append("<br>"); else if (c >= 32 || c == '\t') result.append(c);
        }
        return result.toString();
    }
    static byte[] fetch(URI uri, int limit) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(2000); connection.setReadTimeout(2000);
        long deadline = System.nanoTime() + 5_000_000_000L;
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Branding HTTP status " + connection.getResponseCode());
            if (connection.getContentLengthLong() > limit) throw new IOException("Branding response too large");
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                while (true) {
                    long remaining = (deadline - System.nanoTime()) / 1_000_000L;
                    if (remaining <= 0) throw new IOException("Branding deadline exceeded");
                    connection.setReadTimeout((int) Math.min(2000, remaining));
                    int n = in.read(buffer);
                    if (n < 0) return out.toByteArray();
                    if (out.size() + n > limit) throw new IOException("Branding response too large");
                    out.write(buffer, 0, n);
                }
            }
        } finally { connection.disconnect(); }
    }
    static BufferedImage decode(byte[] bytes) throws IOException {
        if (bytes.length > MAX_IMAGE) throw new IOException("Image too large");
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new IOException("Invalid image");
            ImageReader reader = readers.next();
            try {
                String format = reader.getFormatName();
                if (!format.equalsIgnoreCase("png") && !format.equalsIgnoreCase("jpeg")) throw new IOException("PNG/JPEG required");
                reader.setInput(input, true, true);
                int w = reader.getWidth(0), h = reader.getHeight(0);
                if (w < 1 || h < 1 || w > 4096 || h > 4096 || (long)w * h > 16777216) throw new IOException("Image dimensions exceed limit");
                BufferedImage image = reader.read(0);
                if (image == null) throw new IOException("Invalid image");
                return image;
            } finally { reader.dispose(); }
        }
    }
    static Loaded load(URI endpoint) throws IOException {
        Metadata metadata = parse(endpoint, new String(fetch(endpoint, 16384), StandardCharsets.UTF_8));
        return new Loaded(metadata.text(), loadImage(metadata.banner()), loadImage(metadata.background()));
    }
    private static BufferedImage loadImage(URI uri) {
        if (uri == null) return null;
        try { return decode(fetch(uri, MAX_IMAGE)); } catch (IOException | RuntimeException ex) { return null; }
    }
    static Rectangle fit(int width, int height, Rectangle bounds, boolean cover) {
        double scale = cover ? Math.max((double)bounds.width/width, (double)bounds.height/height) : Math.min((double)bounds.width/width, (double)bounds.height/height);
        int w = Math.max(1, (int)Math.round(width * scale)), h = Math.max(1, (int)Math.round(height * scale));
        return new Rectangle(bounds.x + (bounds.width-w)/2, bounds.y + (bounds.height-h)/2, w, h);
    }
    static BufferedImage loginImage(BufferedImage input) {
        BufferedImage output = new BufferedImage(765, 503, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = output.createGraphics();
        try { g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC); Rectangle r = fit(input.getWidth(), input.getHeight(), new Rectangle(765,503), true); g.drawImage(input, r.x,r.y,r.width,r.height,null); }
        finally { g.dispose(); }
        return output;
    }
}
