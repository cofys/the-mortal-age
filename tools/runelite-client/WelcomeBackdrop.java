import java.awt.*;
import java.awt.image.BufferedImage;
import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.MainBufferProvider;
import net.runelite.api.events.BeforeRender;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.*;

/** Clear the retained scene before the native welcome interface paints its controls. */
@PluginDescriptor(name="TSPS Welcome Backdrop", hidden=true, enabledByDefault=true)
public final class WelcomeBackdrop extends Plugin {
    @Inject private Client client;
    private Image paintedImage;
    private int paintedWidth, paintedHeight;
    @Subscribe public void onBeforeRender(BeforeRender event) {
        if(client.getGameState()!=GameState.LOGGED_IN || client.getTopLevelInterfaceId()!=378) {
            paintedImage=null; return;
        }
        if(!(client.getBufferProvider() instanceof MainBufferProvider provider))return;
        Image image=provider.getImage();
        int width=client.getCanvasWidth(),height=client.getCanvasHeight();
        if(image==null || width<=0 || height<=0)return;
        // Steady welcome frames retain their widgets. Clearing on every frame
        // could erase controls which the native renderer has cached.
        if(image==paintedImage && width==paintedWidth && height==paintedHeight)return;
        Graphics2D g=(Graphics2D)image.getGraphics();
        try {
            g.setClip(0,0,width,height);g.setComposite(AlphaComposite.SrcOver);
            g.setColor(Color.BLACK);g.fillRect(0,0,width,height);
        } finally {g.dispose();}
        paintedImage=image;paintedWidth=width;paintedHeight=height;
    }
    @Override protected void shutDown() { paintedImage=null; }
}
