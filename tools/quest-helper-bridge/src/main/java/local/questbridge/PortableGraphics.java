package local.questbridge;

import com.google.gson.*;
import java.awt.*;
import java.awt.font.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.awt.image.renderable.RenderableImage;
import java.text.AttributedCharacterIterator;
import java.util.Map;

/** Records the actual upstream Graphics2D solver output in browser-portable primitives. */
public final class PortableGraphics extends Graphics2D {
  public final JsonArray commands;
  private final Graphics2D delegate;

  public PortableGraphics(int width, int height) {
    this(
        new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB).createGraphics(),
        new JsonArray());
  }

  private PortableGraphics(Graphics2D delegate, JsonArray commands) {
    this.delegate = delegate;
    this.commands = commands;
  }

  private String color() {
    if (!(getPaint() instanceof Color c))
      throw BridgeFailure.unsupported("Graphics2D paint " + getPaint().getClass().getName());
    return String.format("#%02x%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue(), c.getAlpha());
  }

  private void shape(Shape s, boolean fill) {
    if (commands.size() >= 2048)
      throw new BridgeFailure("LIMIT", "overlays", "Too many overlay primitives");
    Shape transformed = getTransform().createTransformedShape(s);
    if (getClip() != null) {
      Area a = new Area(transformed);
      a.intersect(new Area(getTransform().createTransformedShape(getClip())));
      transformed = a;
    }
    JsonObject c = new JsonObject();
    c.addProperty("kind", "path");
    c.addProperty(fill ? "fill" : "stroke", color());
    if (!fill) {
      if (!(getStroke() instanceof BasicStroke b))
        throw BridgeFailure.unsupported("Graphics2D stroke");
      c.addProperty("lineWidth", b.getLineWidth());
    }
    JsonArray path = new JsonArray();
    double[] coords = new double[6];
    for (PathIterator p = transformed.getPathIterator(null); !p.isDone(); p.next()) {
      int op = p.currentSegment(coords);
      JsonObject segment = new JsonObject();
      segment.addProperty("op", new String[] {"M", "L", "Q", "C", "Z"}[op]);
      JsonArray values = new JsonArray();
      int count = new int[] {2, 2, 4, 6, 0}[op];
      for (int n = 0; n < count; n++) values.add(coords[n]);
      segment.add("values", values);
      path.add(segment);
    }
    c.add("path", path);
    commands.add(c);
  }

  @Override
  public void draw(Shape s) {
    shape(s, false);
  }

  @Override
  public void fill(Shape s) {
    shape(s, true);
  }

  @Override
  public void drawString(String text, int x, int y) {
    drawString(text, (float) x, (float) y);
  }

  @Override
  public void drawString(String text, float x, float y) {
    Point2D p = getTransform().transform(new Point2D.Float(x, y), null);
    JsonObject c = new JsonObject();
    c.addProperty("kind", "text");
    c.addProperty("text", text);
    c.addProperty("x", p.getX());
    c.addProperty("y", p.getY());
    c.addProperty("color", color());
    c.addProperty("font", getFont().getFamily());
    c.addProperty("fontSize", getFont().getSize2D());
    commands.add(c);
  }

  @Override
  public void drawString(AttributedCharacterIterator i, int x, int y) {
    drawString(i, (float) x, (float) y);
  }

  @Override
  public void drawString(AttributedCharacterIterator i, float x, float y) {
    StringBuilder s = new StringBuilder();
    for (char c = i.first(); c != AttributedCharacterIterator.DONE; c = i.next()) s.append(c);
    drawString(s.toString(), x, y);
  }

  @Override
  public void drawGlyphVector(GlyphVector g, float x, float y) {
    fill(g.getOutline(x, y));
  }

  private boolean image(Image image, AffineTransform transform, ImageObserver observer) {
    int w = image.getWidth(observer), h = image.getHeight(observer);
    if (w <= 0 || h <= 0) throw BridgeFailure.unsupported("Graphics2D unloaded image");
    AffineTransform t = new AffineTransform(getTransform());
    t.concatenate(transform);
    Rectangle bounds = t.createTransformedShape(new Rectangle(0, 0, w, h)).getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) return true;
    if (bounds.width > 4096 || bounds.height > 4096)
      throw new BridgeFailure("LIMIT", "overlayImage", "Overlay image dimensions");
    BufferedImage raster =
        new BufferedImage(bounds.width, bounds.height, BufferedImage.TYPE_INT_ARGB);
    Graphics2D g = raster.createGraphics();
    g.translate(-bounds.x, -bounds.y);
    g.transform(t);
    g.drawImage(image, 0, 0, observer);
    g.dispose();
    try {
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      javax.imageio.ImageIO.write(raster, "png", out);
      if (out.size() > 190000)
        throw new BridgeFailure(
            "LIMIT", "overlayImage", "Overlay image exceeds256KiB dataURL limit");
      JsonObject c = new JsonObject();
      c.addProperty("kind", "image");
      c.addProperty(
          "dataUrl",
          "data:image/png;base64,"
              + java.util.Base64.getEncoder().encodeToString(out.toByteArray()));
      c.addProperty("x", bounds.x);
      c.addProperty("y", bounds.y);
      c.addProperty("width", bounds.width);
      c.addProperty("height", bounds.height);
      commands.add(c);
      return true;
    } catch (java.io.IOException e) {
      throw new java.io.UncheckedIOException(e);
    }
  }

  @Override
  public boolean drawImage(Image i, AffineTransform t, ImageObserver o) {
    return image(i, t, o);
  }

  @Override
  public void drawImage(BufferedImage i, BufferedImageOp op, int x, int y) {
    image(op == null ? i : op.filter(i, null), AffineTransform.getTranslateInstance(x, y), null);
  }

  @Override
  public boolean drawImage(Image i, int x, int y, ImageObserver o) {
    return image(i, AffineTransform.getTranslateInstance(x, y), o);
  }

  @Override
  public boolean drawImage(Image i, int x, int y, int w, int h, ImageObserver o) {
    AffineTransform t = AffineTransform.getTranslateInstance(x, y);
    t.scale((double) w / i.getWidth(o), (double) h / i.getHeight(o));
    return image(i, t, o);
  }

  @Override
  public boolean drawImage(Image i, int x, int y, Color b, ImageObserver o) {
    return drawImage(i, x, y, o);
  }

  @Override
  public boolean drawImage(Image i, int x, int y, int w, int h, Color b, ImageObserver o) {
    return drawImage(i, x, y, w, h, o);
  }

  @Override
  public boolean drawImage(
      Image i,
      int dx1,
      int dy1,
      int dx2,
      int dy2,
      int sx1,
      int sy1,
      int sx2,
      int sy2,
      ImageObserver o) {
    BufferedImage b =
        new BufferedImage(Math.abs(sx2 - sx1), Math.abs(sy2 - sy1), BufferedImage.TYPE_INT_ARGB);
    Graphics2D g = b.createGraphics();
    g.drawImage(i, 0, 0, b.getWidth(), b.getHeight(), sx1, sy1, sx2, sy2, o);
    g.dispose();
    return drawImage(b, dx1, dy1, dx2 - dx1, dy2 - dy1, o);
  }

  @Override
  public boolean drawImage(
      Image i,
      int dx1,
      int dy1,
      int dx2,
      int dy2,
      int sx1,
      int sy1,
      int sx2,
      int sy2,
      Color b,
      ImageObserver o) {
    return drawImage(i, dx1, dy1, dx2, dy2, sx1, sy1, sx2, sy2, o);
  }

  @Override
  public void drawRenderedImage(RenderedImage i, AffineTransform t) {
    if (!(i instanceof BufferedImage b))
      throw BridgeFailure.unsupported("Graphics2D RenderedImage");
    image(b, t, null);
  }

  @Override
  public void drawRenderableImage(RenderableImage i, AffineTransform t) {
    drawRenderedImage(i.createDefaultRendering(), t);
  }

  @Override
  public void drawLine(int x1, int y1, int x2, int y2) {
    draw(new Line2D.Double(x1, y1, x2, y2));
  }

  @Override
  public void drawRect(int x, int y, int w, int h) {
    draw(new Rectangle(x, y, w, h));
  }

  @Override
  public void fillRect(int x, int y, int w, int h) {
    fill(new Rectangle(x, y, w, h));
  }

  @Override
  public void clearRect(int x, int y, int w, int h) {
    throw BridgeFailure.unsupported("Graphics2D.clearRect");
  }

  @Override
  public void drawRoundRect(int x, int y, int w, int h, int aw, int ah) {
    draw(new RoundRectangle2D.Double(x, y, w, h, aw, ah));
  }

  @Override
  public void fillRoundRect(int x, int y, int w, int h, int aw, int ah) {
    fill(new RoundRectangle2D.Double(x, y, w, h, aw, ah));
  }

  @Override
  public void drawOval(int x, int y, int w, int h) {
    draw(new Ellipse2D.Double(x, y, w, h));
  }

  @Override
  public void fillOval(int x, int y, int w, int h) {
    fill(new Ellipse2D.Double(x, y, w, h));
  }

  @Override
  public void drawArc(int x, int y, int w, int h, int sa, int aa) {
    draw(new Arc2D.Double(x, y, w, h, sa, aa, Arc2D.OPEN));
  }

  @Override
  public void fillArc(int x, int y, int w, int h, int sa, int aa) {
    fill(new Arc2D.Double(x, y, w, h, sa, aa, Arc2D.PIE));
  }

  @Override
  public void drawPolyline(int[] x, int[] y, int n) {
    Path2D p = new Path2D.Double();
    if (n > 0) p.moveTo(x[0], y[0]);
    for (int i = 1; i < n; i++) p.lineTo(x[i], y[i]);
    draw(p);
  }

  @Override
  public void drawPolygon(int[] x, int[] y, int n) {
    draw(new Polygon(x, y, n));
  }

  @Override
  public void fillPolygon(int[] x, int[] y, int n) {
    fill(new Polygon(x, y, n));
  }

  @Override
  public Graphics create() {
    return new PortableGraphics((Graphics2D) delegate.create(), commands);
  }

  @Override
  public void dispose() {
    delegate.dispose();
  }

  @Override
  public void translate(int x, int y) {
    delegate.translate(x, y);
  }

  @Override
  public void translate(double x, double y) {
    delegate.translate(x, y);
  }

  @Override
  public void rotate(double t) {
    delegate.rotate(t);
  }

  @Override
  public void rotate(double t, double x, double y) {
    delegate.rotate(t, x, y);
  }

  @Override
  public void scale(double x, double y) {
    delegate.scale(x, y);
  }

  @Override
  public void shear(double x, double y) {
    delegate.shear(x, y);
  }

  @Override
  public void transform(AffineTransform t) {
    delegate.transform(t);
  }

  @Override
  public void setTransform(AffineTransform t) {
    delegate.setTransform(t);
  }

  @Override
  public AffineTransform getTransform() {
    return delegate.getTransform();
  }

  @Override
  public Paint getPaint() {
    return delegate.getPaint();
  }

  @Override
  public void setPaint(Paint p) {
    delegate.setPaint(p);
  }

  @Override
  public Composite getComposite() {
    return delegate.getComposite();
  }

  @Override
  public void setComposite(Composite c) {
    if (!(c instanceof AlphaComposite a)
        || a.getRule() != AlphaComposite.SRC_OVER
        || a.getAlpha() != 1f) throw BridgeFailure.unsupported("Graphics2D.setComposite");
    delegate.setComposite(c);
  }

  @Override
  public Color getBackground() {
    return delegate.getBackground();
  }

  @Override
  public void setBackground(Color c) {
    delegate.setBackground(c);
  }

  @Override
  public Stroke getStroke() {
    return delegate.getStroke();
  }

  @Override
  public void setStroke(Stroke s) {
    delegate.setStroke(s);
  }

  @Override
  public void clip(Shape s) {
    delegate.clip(s);
  }

  @Override
  public FontRenderContext getFontRenderContext() {
    return delegate.getFontRenderContext();
  }

  @Override
  public GraphicsConfiguration getDeviceConfiguration() {
    return delegate.getDeviceConfiguration();
  }

  @Override
  public boolean hit(Rectangle r, Shape s, boolean onStroke) {
    return delegate.hit(r, s, onStroke);
  }

  @Override
  public void setRenderingHint(RenderingHints.Key k, Object v) {
    delegate.setRenderingHint(k, v);
  }

  @Override
  public Object getRenderingHint(RenderingHints.Key k) {
    return delegate.getRenderingHint(k);
  }

  @Override
  public void setRenderingHints(Map<?, ?> m) {
    delegate.setRenderingHints(m);
  }

  @Override
  public void addRenderingHints(Map<?, ?> m) {
    delegate.addRenderingHints(m);
  }

  @Override
  public RenderingHints getRenderingHints() {
    return delegate.getRenderingHints();
  }

  @Override
  public Color getColor() {
    return delegate.getColor();
  }

  @Override
  public void setColor(Color c) {
    delegate.setColor(c);
  }

  @Override
  public void setPaintMode() {
    delegate.setPaintMode();
  }

  @Override
  public void setXORMode(Color c) {
    throw BridgeFailure.unsupported("Graphics2D.setXORMode");
  }

  @Override
  public Font getFont() {
    return delegate.getFont();
  }

  @Override
  public void setFont(Font f) {
    delegate.setFont(f);
  }

  @Override
  public FontMetrics getFontMetrics(Font f) {
    return delegate.getFontMetrics(f);
  }

  @Override
  public Rectangle getClipBounds() {
    return delegate.getClipBounds();
  }

  @Override
  public void clipRect(int x, int y, int w, int h) {
    delegate.clipRect(x, y, w, h);
  }

  @Override
  public void setClip(int x, int y, int w, int h) {
    delegate.setClip(x, y, w, h);
  }

  @Override
  public Shape getClip() {
    return delegate.getClip();
  }

  @Override
  public void setClip(Shape s) {
    delegate.setClip(s);
  }

  @Override
  public void copyArea(int x, int y, int w, int h, int dx, int dy) {
    throw BridgeFailure.unsupported("Graphics2D.copyArea");
  }
}
