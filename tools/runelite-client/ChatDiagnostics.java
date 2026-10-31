import javax.inject.Inject;
import net.runelite.api.*;
import net.runelite.api.events.*;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.api.widgets.Widget;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Opt-in read-only diagnostics for the disposable gateway client. */
@PluginDescriptor(name = "TSPS Chat Diagnostics", description = "Read-only local gateway chat diagnostics", enabledByDefault = true)
public final class ChatDiagnostics extends Plugin {
    private static final Logger LOG = LoggerFactory.getLogger(ChatDiagnostics.class);
    @Inject private Client client;
    private boolean pending = true;
    private int cycles;

    @Override protected void startUp() {
        LOG.info("TSPS_CHAT_DIAGNOSTICS enabled; public/game chat text only; no login credential APIs accessed");
    }
    @Subscribe(priority = -10000) public void onChatMessage(ChatMessage event) {
        if (visibleText(event.getType())) LOG.info("TSPS_CHAT event type={} name={} text={}", event.getType(), clean(event.getName()), clean(event.getMessage()));
        pending = true;
    }
    @Subscribe(priority = -10000) public void onOverheadTextChanged(OverheadTextChanged event) {
        if (event.getActor() == client.getLocalPlayer()) {
            LOG.info("TSPS_CHAT local-overhead={}", clean(event.getOverheadText()));
            pending = true;
        }
    }
    @Subscribe public void onGameStateChanged(GameStateChanged event) { pending = true; }
    @Subscribe(priority = -10000) public void onClientTick(ClientTick event) {
        if (!pending && ++cycles < 500) return;
        pending = false; cycles = 0;
        Player player = client.getLocalPlayer();
        var map = client.getChatLineMap();
        StringBuilder lines = new StringBuilder();
        int buffers = 0;
        if (map != null) for (var entry : map.entrySet()) {
            if (++buffers > 12) break;
            ChatLineBuffer buffer = entry.getValue();
            if (buffer == null) continue;
            lines.append(" channel=").append(entry.getKey()).append(" count=").append(buffer.getLength());
            MessageNode[] nodes = buffer.getLines();
            for (int i = 0; nodes != null && i < Math.min(nodes.length, 3); i++) {
                MessageNode node = nodes[i];
                if (node == null) continue;
                lines.append(" [id=").append(node.getId()).append(" type=").append(node.getType());
                lines.append(" nativeCycle=").append(nativeInt(node, "by", "az", 728409595)).append(" runeLiteTimestamp=").append(node.getTimestamp());
                if (visibleText(node.getType())) lines.append(" name=").append(clean(node.getName())).append(" text=").append(clean(node.getValue()));
                lines.append(']');
            }
        }
        LOG.info("TSPS_CHAT state={} root={} tick={} cycle={} localName={} hidden={} overhead={} overheadCycle={} publicMode={} messageFilter={} varcs199,383,41,1112,65={},{},{},{},{} chatBuffers={}{}",
            client.getGameState(), client.getTopLevelInterfaceId(), client.getTickCount(), client.getGameCycle(), player == null ? "<none>" : clean(player.getName()),
            nativeHidden(player), player == null ? "<none>" : clean(player.getOverheadText()),
            player == null ? -1 : player.getOverheadCycle(), nativeInt(null, "client", "ko", 1774104361), nativeMessageFilter(),
            client.getVarcIntValue(199), client.getVarcIntValue(383), client.getVarcIntValue(41), client.getVarcIntValue(1112), client.getVarcIntValue(65), map == null ? -1 : map.size(), lines);
        // Pinned local241 component.sym/interface/chatbox.if3: scrollarea162:59.
        Widget scroll = client.getWidget(162, 59);
        if (scroll == null) { LOG.info("TSPS_CHAT_WIDGET scrollarea162:59=<null>"); return; }
        StringBuilder children = new StringBuilder();
        Widget[] dynamic = scroll.getDynamicChildren();
        for (int i = 0; dynamic != null && i < Math.min(16, dynamic.length); i++) {
            Widget child = dynamic[i];
            children.append(" child").append(i).append('=');
            if (child == null) { children.append("null"); continue; }
            children.append("{hidden=").append(child.isHidden()).append(" size=").append(child.getWidth()).append('x').append(child.getHeight()).append(" text=").append(clean(child.getText())).append('}');
        }
        LOG.info("TSPS_CHAT_WIDGET scrollarea162:59 hidden={} size={}x{} scrollY={} scrollHeight={} dynamicCount={}{}", scroll.isHidden(), scroll.getWidth(), scroll.getHeight(), scroll.getScrollY(), scroll.getScrollHeight(), dynamic == null ? -1 : dynamic.length, children);
    }
    private static boolean visibleText(ChatMessageType type) {
        return type == ChatMessageType.PUBLICCHAT || type == ChatMessageType.MODCHAT || type == ChatMessageType.GAMEMESSAGE;
    }
    // These are the only reflected fields. Their exact revision241 bytecode was
    // traced to CS2 CHAT_GETFILTER_PUBLIC / CHAT_GETMESSAGEFILTER, appearance
    // hidden decoding, and CHAT_GETHISTORY message cycle. No discovery/scanning.
    private static Object nativeInt(Object target, String owner, String name, int multiplier) {
        if (!(owner.equals("client") && name.equals("ko") || owner.equals("by") && name.equals("az"))) return "not-whitelisted";
        try { var field = Class.forName(owner).getDeclaredField(name); field.setAccessible(true); return field.getInt(target) * multiplier; }
        catch (ReflectiveOperationException ex) { return "unavailable:" + ex.getClass().getSimpleName(); }
    }
    private static Object nativeHidden(Player player) {
        if (player == null) return "<none>";
        try { var field = Class.forName("bd").getDeclaredField("ah"); field.setAccessible(true); return field.getBoolean(player); }
        catch (ReflectiveOperationException ex) { return "unavailable:" + ex.getClass().getSimpleName(); }
    }
    private static String nativeMessageFilter() {
        try { var field = Class.forName("client").getDeclaredField("kl"); field.setAccessible(true); return clean((String) field.get(null)); }
        catch (ReflectiveOperationException ex) { return "unavailable:" + ex.getClass().getSimpleName(); }
    }
    private static String clean(String text) {
        if (text == null) return "<null>";
        text = text.replace('\n', ' ').replace('\r', ' ');
        return text.length() > 256 ? text.substring(0, 256) : text;
    }
}
