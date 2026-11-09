package app.horizons.editor;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.kesurage.horizons.bridge.BridgeServerPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The Agent Bridge server plugin must be registered before the
        // bridge is created so the WebView can reach it.
        registerPlugin(BridgeServerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
