package io.github.horila.twa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * A widget tap: queue the entry with its tap time (the page logs it from the same queue
 * as finished walks), then get it to the sheet: straight away if the app is in memory,
 * otherwise through a one-off SyncJob as soon as there is a network.
 */
public class QuickLog extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        String t = intent.getStringExtra("t");
        if (!"weewee".equals(t) && !"poop".equals(t)) return;
        try { WalkService.enqueue(ctx, new JSONObject().put("t", t).put("at", System.currentTimeMillis())); }
        catch (Exception e) { return; }
        Toast.makeText(ctx, ("poop".equals(t) ? "💩 Poop" : "💧 Wee Wee") + " logged", Toast.LENGTH_SHORT).show();
        MainActivity.poke();
        try { SyncJob.soon(ctx); } catch (Exception ignored) { }
    }
}
