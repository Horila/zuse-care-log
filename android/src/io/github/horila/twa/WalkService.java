package io.github.horila.twa;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;

/**
 * Keeps a walk going with the app closed: an ongoing notification with an End walk button,
 * and GPS that ends the walk once back home (same rule as the page's shouldAutoEnd).
 * Finished walks go into a queue the page drains with takeEntries(), so the log itself
 * stays in the WebView. Started only from the visible page, which is what lets a
 * location foreground service keep its while-in-use location in the background.
 */
public class WalkService extends Service implements LocationListener {
    static final String CHANNEL = "walk", WALK = "walk", QUEUE = "queue";
    static final String END = "io.github.horila.twa.END_WALK";
    static final int ONGOING = 4201, DONE = 4202;

    long start, grace;
    double lat, lon, radius, maxAcc;
    boolean home, ending;

    /** json {start, lat, lon, radius, grace, acc}; lat is null when no home pin is set. */
    static void begin(Context ctx, String json) {
        Reminders.prefs(ctx).edit().putString(WALK, json).commit();
        Intent i = new Intent(ctx, WalkService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    static void cancel(Context ctx) {
        Reminders.prefs(ctx).edit().remove(WALK).commit();
        ctx.stopService(new Intent(ctx, WalkService.class));
    }

    /** Hand the queue to the page and empty it, in one step. */
    static synchronized String take(Context ctx) {
        String q = Reminders.prefs(ctx).getString(QUEUE, "[]");
        Reminders.prefs(ctx).edit().remove(QUEUE).commit();
        return q;
    }

    static synchronized void enqueue(Context ctx, JSONObject entry) {
        JSONArray q;
        try { q = new JSONArray(Reminders.prefs(ctx).getString(QUEUE, "[]")); } catch (Exception e) { q = new JSONArray(); }
        q.put(entry);
        Reminders.prefs(ctx).edit().putString(QUEUE, q.toString()).commit();
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && END.equals(intent.getAction())) { finish(System.currentTimeMillis()); return START_NOT_STICKY; }
        JSONObject w;
        try { w = new JSONObject(Reminders.prefs(this).getString(WALK, "")); }
        catch (Exception e) { // cancelled before it got here; still owes Android a startForeground
            try { startForeground(ONGOING, builder(this).setContentTitle("🦮 Walk ended").build()); } catch (Exception ignored) { }
            stopSelf(); return START_NOT_STICKY;
        }
        start = w.optLong("start", System.currentTimeMillis());
        grace = w.optLong("grace", 300_000);
        radius = w.optDouble("radius", 2);
        maxAcc = w.optDouble("acc", 20);
        lat = w.optDouble("lat", Double.NaN);
        lon = w.optDouble("lon", Double.NaN);
        // Approximate-only location never gets inside 20m, so auto-end needs the precise grant.
        boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        home = fine && !Double.isNaN(lat) && !Double.isNaN(lon);
        ending = false;
        try {
            Notification n = ongoing(home ? "Ends by itself when you're back home" : "Tap End walk when you're back");
            if (Build.VERSION.SDK_INT >= 29) startForeground(ONGOING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(ONGOING, n);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; } // no location grant, or started from the background
        LocationManager lm = getSystemService(LocationManager.class);
        lm.removeUpdates(this);
        if (home) for (String p : lm.getProviders(true)) {
            if (LocationManager.PASSIVE_PROVIDER.equals(p)) continue;
            try { lm.requestLocationUpdates(p, 5000, 0, this, Looper.getMainLooper()); } catch (Exception ignored) { }
        }
        // Not sticky: a restart from the background gets no location. The next app open re-arms it.
        return START_NOT_STICKY;
    }

    @Override public void onLocationChanged(Location l) {
        if (ending || !l.hasAccuracy()) return;
        float[] d = new float[1];
        Location.distanceBetween(l.getLatitude(), l.getLongitude(), lat, lon, d);
        float acc = l.getAccuracy();
        if (System.currentTimeMillis() - start >= grace && acc <= maxAcc && d[0] - acc <= radius) finish(System.currentTimeMillis());
    }
    // API 24-29 declare these abstract; without them the call is an AbstractMethodError there.
    @Override public void onStatusChanged(String p, int s, Bundle b) { }
    @Override public void onProviderEnabled(String p) { }
    @Override public void onProviderDisabled(String p) { }

    @SuppressWarnings("deprecation")
    void finish(long end) {
        if (ending) return;
        ending = true;
        getSystemService(LocationManager.class).removeUpdates(this);
        String w = Reminders.prefs(this).getString(WALK, null);
        if (w == null) { stopSelf(); return; } // already ended in the app
        try { start = new JSONObject(w).optLong("start", start); } catch (Exception ignored) { } // End tapped on a fresh instance
        try { enqueue(this, new JSONObject().put("t", "walk").put("start", start).put("end", end)); } catch (Exception ignored) { }
        Reminders.prefs(this).edit().remove(WALK).commit();
        stopForeground(true);
        long mins = Math.max(1, Math.round((end - start) / 60000.0));
        try {
            getSystemService(NotificationManager.class).notify(DONE, builder(this)
                    .setContentTitle("🦮 Walk logged: " + mins + " min")
                    .setContentText("Back home at " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(end)))
                    .setAutoCancel(true).build());
        } catch (SecurityException ignored) { }
        MainActivity.poke();
        // Stay alive a little so the page, if it is still in memory, can log and sync before the process is frozen.
        new Handler(Looper.getMainLooper()).postDelayed(this::stopSelf, 15_000);
    }

    @Override public void onDestroy() {
        getSystemService(LocationManager.class).removeUpdates(this);
        super.onDestroy();
    }

    Notification ongoing(String text) {
        PendingIntent end = PendingIntent.getService(this, 1, new Intent(this, WalkService.class).setAction(END),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        @SuppressWarnings("deprecation")
        Notification.Action a = new Notification.Action.Builder(0, "End walk", end).build();
        return builder(this).setContentTitle("🦮 Walking").setContentText(text)
                .setWhen(start).setUsesChronometer(true).setShowWhen(true)
                .setOngoing(true).addAction(a).build();
    }

    /** The quiet channel: walk in progress, walk logged, sync finishing. */
    @SuppressWarnings("deprecation")
    static Notification.Builder builder(Context ctx) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Walk in progress", NotificationManager.IMPORTANCE_LOW);
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        PendingIntent tap = PendingIntent.getActivity(ctx, 0,
                new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        return b.setSmallIcon(R.drawable.ic_notif).setContentIntent(tap);
    }
}
