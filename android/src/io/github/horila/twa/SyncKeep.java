package io.github.horila.twa;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Held for the length of a sync the page started, so closing the app mid-sync doesn't freeze
 * the page before it finishes. Android 12+ holds back the notification for 10s, so a normal
 * sync never shows one. Only startable while the app is in front (or already has a foreground
 * service); otherwise the page's sync runs unprotected, as before.
 */
public class SyncKeep extends Service {
    static final int ID = 4203;
    // A stop that lands before onStartCommand has called startForeground crashes the app,
    // so a quick sync's stop waits for the start instead (stopWanted).
    static boolean up, starting, stopWanted;
    final Handler h = new Handler(Looper.getMainLooper());

    static synchronized void set(Context ctx, boolean on) {
        Intent i = new Intent(ctx, SyncKeep.class);
        try {
            if (!on) {
                if (starting) stopWanted = true;
                else if (up) ctx.stopService(i);
                return;
            }
            stopWanted = false;
            if (up || starting) return;
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
            starting = true;
        } catch (Exception ignored) { } // not allowed from the background
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        try {
            android.app.Notification n = WalkService.builder(this).setContentTitle("Syncing with the sheet…").build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(ID, n);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; }
        synchronized (SyncKeep.class) {
            up = true; starting = false;
            if (stopWanted) { stopWanted = false; stopSelf(); return START_NOT_STICKY; }
        }
        // A full pull gets 6 minutes; past that the page is gone or stuck.
        h.removeCallbacksAndMessages(null);
        h.postDelayed(this::stopSelf, 7 * 60_000);
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        synchronized (SyncKeep.class) { up = false; starting = false; }
        h.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
