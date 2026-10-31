import java.awt.*;
import java.awt.image.BufferedImage;
import java.util.*;
import java.util.concurrent.*;
import javax.inject.Inject;
import net.runelite.api.*;
import net.runelite.api.events.*;
import net.runelite.api.widgets.Widget;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.*;
import net.runelite.client.ui.overlay.*;
import org.slf4j.LoggerFactory;

/** Optional server-owner presentation; no game/cache mutations or dependency on 117HD. */
@PluginDescriptor(name = "TSPS Branding", description = "Server-owner welcome and login presentation", enabledByDefault = true)
public final class Branding extends Plugin {
    @Inject private Client client;
    @Inject private ClientThread clientThread;
    @Inject private OverlayManager overlayManager;
    private ExecutorService executor;
    private volatile boolean active;
    private int generation;
    private BrandingAssets.Loaded assets;
    private boolean customLogin;
    private final Map<Widget, Boolean> hidden = new IdentityHashMap<>();
    private final Map<Widget, String> texts = new IdentityHashMap<>();
    private final Overlay overlay = new Overlay(this) {
        { setPosition(OverlayPosition.DYNAMIC); setLayer(OverlayLayer.MANUAL); drawAfterInterface(378); }
        @Override public Dimension render(Graphics2D graphics) {
            if (!active || assets == null || assets.banner() == null) return null;
            Widget banner = client.getWidget(378, 76), border = client.getWidget(378,78);
            if (banner == null || border == null || banner.isHidden() || border.isHidden()) return null;
            Rectangle bounds = new Rectangle(border.getBounds()); bounds.grow(-4,-4);
            if (bounds.width <= 0 || bounds.height <= 0) return null;
            BufferedImage image = assets.banner();
            Rectangle r = BrandingAssets.fit(image.getWidth(), image.getHeight(), bounds, false);
            Graphics2D g = (Graphics2D) graphics.create();
            try { g.clip(bounds); g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR); g.drawImage(image,r.x,r.y,r.width,r.height,null); }
            finally { g.dispose(); }
            return null;
        }
    };
    @Override protected void startUp() {
        active = true;
        final int request = ++generation;
        String endpoint = System.getProperty("tsps.branding.url");
        if (endpoint == null || endpoint.isBlank()) return;
        executor = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r,"tsps-branding"); t.setDaemon(true); return t; });
        overlayManager.add(overlay);
        executor.execute(() -> {
            try {
                BrandingAssets.Loaded loaded = BrandingAssets.load(BrandingAssets.endpoint(endpoint));
                // Resize on the loader thread, never block the client/render thread.
                BufferedImage login = loaded.background() == null ? null : BrandingAssets.loginImage(loaded.background());
                clientThread.invokeLater(() -> {
                    if (!active || request != generation) return;
                    assets = new BrandingAssets.Loaded(loaded.text(),loaded.banner(),login);
                    apply();
                });
            } catch (Exception ex) { LoggerFactory.getLogger(Branding.class).debug("Optional TSPS branding unavailable", ex); }
        });
    }
    @Subscribe public void onClientTick(ClientTick event) { apply(); }
    @Subscribe public void onScriptPostFired(ScriptPostFired event) { apply(); }
    private void apply() {
        if (!active || assets == null) return;
        if (assets.background() != null && !customLogin) {
            BufferedImage image = assets.background();
            client.setLoginScreen(client.createSpritePixels(image.getRGB(0,0,765,503,null,0,765),765,503));
            client.setShouldRenderLoginScreenFire(false); customLogin = true;
        }
        Widget footer = client.getWidget(378,6);
        if (footer != null && assets.text() != null) {
            if (!assets.text().equals(footer.getText())) texts.put(footer,footer.getText());
            footer.setText(assets.text());
        }
        if (assets.banner() != null) for (int id : new int[]{79,80,82,84}) {
            Widget widget = client.getWidget(378,id);
            if (widget != null) { hidden.putIfAbsent(widget, widget.isSelfHidden()); widget.setHidden(true); }
        }
        // Drop detached interfaces to avoid retaining every login's widgets.
        hidden.keySet().removeIf(w -> client.getWidget(w.getId()) != w);
        texts.keySet().removeIf(w -> client.getWidget(w.getId()) != w);
    }
    @Override protected void shutDown() {
        active = false; ++generation;
        if (executor != null) { executor.shutdownNow(); executor = null; }
        overlayManager.remove(overlay);
        clientThread.invokeLater(this::restoreClient);
    }
    private void restoreClient() {
        hidden.forEach((w,value) -> { if (client.getWidget(w.getId()) == w) w.setHidden(value); });
        texts.forEach((w,value) -> { if (client.getWidget(w.getId()) == w) w.setText(value); });
        hidden.clear(); texts.clear(); assets = null;
        if (customLogin) { client.setLoginScreen(null); client.setShouldRenderLoginScreenFire(true); customLogin = false; }
    }
}
