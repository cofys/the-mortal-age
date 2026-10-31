import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.lang.reflect.*;
import java.util.*;
import net.runelite.api.Client;
import net.runelite.api.events.*;
import net.runelite.api.widgets.Widget;

/** Tests real plugin callbacks against pinned API adapters; rendering remains native QA. */
public final class BrandingLifecycleTest {
    static final Map<Integer, Widget> widgets = new HashMap<>();
    static class State implements InvocationHandler {
        final int id; String text; boolean hidden;
        State(int id,String text) { this.id=(378<<16)|id; this.text=text; }
        public Object invoke(Object proxy,Method method,Object[] args) {
            return switch(method.getName()) {
                case "getId" -> id;
                case "getText" -> text;
                case "setText" -> { text=(String)args[0]; yield proxy; }
                case "setHidden" -> { hidden=(boolean)args[0]; yield proxy; }
                case "isSelfHidden","isHidden" -> hidden;
                case "getBounds" -> new Rectangle(29,64,707,199);
                case "equals" -> proxy==args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> throw new AssertionError("Unexpected widget API: "+method.getName());
            };
        }
        Widget widget() { Widget w=(Widget)Proxy.newProxyInstance(Widget.class.getClassLoader(),new Class[]{Widget.class},this); widgets.put(id,w); return w; }
    }
    static void set(Branding plugin,String name,Object value) throws Exception { Field f=Branding.class.getDeclaredField(name); f.setAccessible(true); f.set(plugin,value); }
    static void check(boolean value,String message) { if(!value) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        Branding plugin = new Branding();
        Client client = (Client)Proxy.newProxyInstance(Client.class.getClassLoader(),new Class[]{Client.class},(p,m,a) -> {
            if(m.getName().equals("getWidget")) return widgets.get(a.length==1 ? (int)a[0] : ((int)a[0]<<16)|(int)a[1]);
            throw new AssertionError("Unexpected client mutation: "+m.getName());
        });
        State footer=new State(6,"Initial stock"), art=new State(79,""); footer.widget(); art.widget();
        State play=new State(72,"Play"); play.widget();
        set(plugin,"client",client); set(plugin,"active",true);
        set(plugin,"assets",new BrandingAssets.Loaded("Owner footer",new BufferedImage(30,20,BufferedImage.TYPE_INT_RGB),null));
        plugin.onClientTick(new ClientTick());
        check(footer.text.equals("Owner footer") && art.hidden,"Apply callback");
        footer.text="New stock from native script"; art.hidden=false;
        plugin.onScriptPostFired(new ScriptPostFired(312));
        check(footer.text.equals("Owner footer") && art.hidden,"Script reapplication");
        // Restoring must use the most recent stock text, not its pre-onload empty/old value.
        Method restore=Branding.class.getDeclaredMethod("restoreClient"); restore.setAccessible(true); restore.invoke(plugin);
        check(footer.text.equals("New stock from native script") && !art.hidden,"Restore latest native state");
        check(play.text.equals("Play") && !play.hidden,"Play preserved");
        State replacement=new State(6,"Reopened stock"); replacement.widget();
        set(plugin,"assets",new BrandingAssets.Loaded("Owner footer",null,null));
        plugin.onScriptPostFired(new ScriptPostFired(312));
        check(replacement.text.equals("Owner footer"),"Reopened widget applies");
        restore.invoke(plugin);
        check(replacement.text.equals("Reopened stock"),"Reopened widget restores");
        set(plugin,"active",false); plugin.onClientTick(new ClientTick());
        check(replacement.text.equals("Reopened stock"),"Inactive callback preserves stock");
        System.out.println("BrandingLifecycleTest: 7 checks passed (pinned API adapters; no native rendering)");
    }
}
