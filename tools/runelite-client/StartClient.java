import net.runelite.client.RuneLite;
import net.runelite.client.externalplugins.ExternalPluginManager;
import net.runelite.client.plugins.Plugin;

/** Makes the pinned renderer available without mutable Plugin Hub downloads. */
public final class StartClient {
    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        java.util.List<Class<? extends Plugin>> builtins = new java.util.ArrayList<>();
        if (Boolean.getBoolean("tsps.hd")) {
            Class<? extends Plugin> hd = (Class<? extends Plugin>) Class.forName("rs117.hd.HdPlugin");
            builtins.add(hd);
            System.out.println("Pinned 117HD1.6.0 registered; rendering still requires native QA");
        }
        builtins.add(Branding.class);
        builtins.add(WelcomeBackdrop.class);
        if (Boolean.getBoolean("tsps.diagnostics")) builtins.add(ChatDiagnostics.class);
        if (!builtins.isEmpty()) ExternalPluginManager.loadBuiltin(builtins.toArray(new Class[0]));
        RuneLite.main(args);
    }
}
