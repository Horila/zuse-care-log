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
import android.os.SystemClock;

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
    static final String CHANNEL = "walk", WALK = "walk", QUEUE = "queue", TRACK = "track";
    /** Route points worse than this are dropped: network fixes would zigzag the line. */
    static final float TRACK_ACC = 35;
    static final String END = "io.github.horila.twa.END_WALK";
    static final int ONGOING = 4201, DONE = 4202;

    long start, grace, every, lastPt;
    double lat, lon, radius, maxAcc;
    boolean home, ending;
    String what = "walk", who = "Zuse's walk"; // kind and "Reggie's van trip" for the notifications

    /** json {start, lat, lon, radius, grace, acc, every, pet, kind}; lat is null when no home pin is set,
     *  every is seconds between route points (0 or missing = no route), pet is '' (Zuse) or 'reggie',
     *  kind is 'walk' or 'van'. */
    static void begin(Context ctx, String json) {
        Reminders.prefs(ctx).edit().putString(WALK, json).commit();
        Intent i = new Intent(ctx, WalkService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    static synchronized void cancel(Context ctx) { // same lock as addPoint, or a fix landing mid-cancel writes the old route back
        Reminders.prefs(ctx).edit().remove(WALK).remove(TRACK).commit();
        ctx.stopService(new Intent(ctx, WalkService.class));
    }

    /** Zuse's entries (the old page and the old bridge call this). */
    static String take(Context ctx) { return takeFor(ctx, ""); }

    /** Hand the page one dog's queued entries ("" = Zuse, entries with no pet too) and remove exactly those, in one step. */
    static synchronized String takeFor(Context ctx, String pet) {
        if (pet == null) pet = "";
        JSONArray all, mine = new JSONArray(), rest = new JSONArray();
        try { all = new JSONArray(Reminders.prefs(ctx).getString(QUEUE, "[]")); } catch (Exception e) { return "[]"; } // enqueue overwrites a corrupt queue
        for (int i = 0; i < all.length(); i++) {
            JSONObject e = all.optJSONObject(i);
            // an entry that isn't an object can't name a dog: it goes to Zuse's page, never silently dropped
            ((e != null ? e.optString("pet", "") : "").equals(pet) ? mine : rest).put(e != null ? e : all.opt(i));
        }
        if (mine.length() > 0) {
            if (rest.length() == 0) Reminders.prefs(ctx).edit().remove(QUEUE).commit();
            else Reminders.prefs(ctx).edit().putString(QUEUE, rest.toString()).commit();
        }
        return mine.toString();
    }

    static synchronized void enqueue(Context ctx, JSONObject entry) {
        JSONArray q;
        try { q = new JSONArray(Reminders.prefs(ctx).getString(QUEUE, "[]")); } catch (Exception e) { q = new JSONArray(); }
        q.put(entry);
        Reminders.prefs(ctx).edit().putString(QUEUE, q.toString()).commit();
    }

    /** The current walk's route as [[lat,lon,ms],...], or [] when there is none. */
    static synchronized String track(Context ctx) {
        try {
            long walk = new JSONObject(Reminders.prefs(ctx).getString(WALK, "")).optLong("start", -1);
            JSONObject t = new JSONObject(Reminders.prefs(ctx).getString(TRACK, "{}"));
            JSONArray p = t.optJSONArray("pts");
            return p != null && t.optLong("start", -2) == walk ? p.toString() : "[]";
        } catch (Exception e) { return "[]"; }
    }

    static synchronized void addPoint(Context ctx, long start, double lat, double lon, long t) {
        try {
            JSONObject tr = new JSONObject(Reminders.prefs(ctx).getString(TRACK, "{}"));
            if (tr.optLong("start", -1) != start) return;
            JSONArray pts = tr.optJSONArray("pts");
            if (pts == null) { pts = new JSONArray(); tr.put("pts", pts); }
            // ponytail: cap at ~14h of points at 10s; each point rewrites the whole prefs file. Move to an append-only file if longer walks matter.
            if (pts.length() >= 5000) return;
            pts.put(new JSONArray().put(Math.round(lat * 1e6) / 1e6).put(Math.round(lon * 1e6) / 1e6).put(t));
            Reminders.prefs(ctx).edit().putString(TRACK, tr.toString()).apply();
        } catch (Exception ignored) { }
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
        every = Math.max(0, w.optLong("every", 0)) * 1000;
        lastPt = 0;
        what = "van".equals(w.optString("kind")) ? "van trip" : "walk";
        who = ("reggie".equals(w.optString("pet")) ? "Reggie" : "Zuse") + "'s " + what;
        // Every app open re-arms the walk; only a new walk (a different start) begins a fresh route.
        try {
            if (new JSONObject(Reminders.prefs(this).getString(TRACK, "{}")).optLong("start", -1) != start)
                Reminders.prefs(this).edit().putString(TRACK, new JSONObject().put("start", start).put("pts", new JSONArray()).toString()).commit();
        } catch (Exception ignored) { }
        // Approximate-only location never gets inside 20m, so auto-end needs the precise grant.
        boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        home = fine && !Double.isNaN(lat) && !Double.isNaN(lon);
        ending = false;
        try {
            Notification n = ongoing(home ? "Ends by itself when you're back home" : "Tap End " + what + " when you're back");
            if (Build.VERSION.SDK_INT >= 29) startForeground(ONGOING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(ONGOING, n);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; } // no location grant, or started from the background
        LocationManager lm = getSystemService(LocationManager.class);
        lm.removeUpdates(this);
        boolean rec = fine && every > 0;
        // Auto-end wants a fix every 5s or sooner; with a route too, use a divisor of every so points land on time.
        long ms = home ? (rec ? every / (long) Math.ceil(every / 5000.0) : 5000) : every;
        if (home || rec) for (String p : lm.getProviders(true)) {
            if (LocationManager.PASSIVE_PROVIDER.equals(p)) continue;
            try { lm.requestLocationUpdates(p, ms, 0, this, Looper.getMainLooper()); } catch (Exception ignored) { }
        }
        // Not sticky: a restart from the background gets no location. The next app open re-arms it.
        return START_NOT_STICKY;
    }

    @Override public void onLocationChanged(Location l) {
        if (ending || !l.hasAccuracy()) return;
        long now = System.currentTimeMillis(), mono = SystemClock.elapsedRealtime(); // mono: a clock change mid-walk can't stall the route
        // 500ms slack so fixes arriving a hair early at the same interval aren't skipped every other time.
        if (every > 0 && l.getAccuracy() <= TRACK_ACC && (lastPt == 0 || mono - lastPt >= every - 500)) {
            lastPt = mono;
            addPoint(this, start, l.getLatitude(), l.getLongitude(), now);
        }
        if (!home) return;
        float[] d = new float[1];
        Location.distanceBetween(l.getLatitude(), l.getLongitude(), lat, lon, d);
        float acc = l.getAccuracy();
        if (now - start >= grace && acc <= maxAcc && d[0] - acc <= radius) finish(System.currentTimeMillis());
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
        JSONObject wj = new JSONObject();
        try { wj = new JSONObject(w); start = wj.optLong("start", start); } catch (Exception ignored) { } // End tapped on a fresh instance
        // End tapped on a fresh instance: name and kind come from the stored walk, not the fields
        what = "van".equals(wj.optString("kind")) ? "van trip" : "walk";
        who = ("reggie".equals(wj.optString("pet")) ? "Reggie" : "Zuse") + "'s " + what;
        try {
            JSONObject e = new JSONObject().put("t", "walk").put("start", start).put("end", end).put("track", new JSONArray(track(this)));
            if (wj.has("pet")) e.put("pet", wj.optString("pet"));
            if (wj.has("kind")) e.put("kind", wj.optString("kind"));
            enqueue(this, e);
        } catch (Exception ignored) { }
        Reminders.prefs(this).edit().remove(WALK).remove(TRACK).commit();
        stopForeground(true);
        long mins = Math.max(1, Math.round((end - start) / 60000.0));
        try {
            getSystemService(NotificationManager.class).notify(DONE, builder(this)
                    .setContentTitle("🦮 " + who + " logged: " + mins + " min")
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
        Notification.Action a = new Notification.Action.Builder(0, "End " + what, end).build();
        return builder(this).setContentTitle("🦮 " + who).setContentText(text)
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
