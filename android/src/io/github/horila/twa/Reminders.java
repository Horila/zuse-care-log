package io.github.horila.twa;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.BitmapFactory;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/** Stored reminder plan + the one alarm that walks it. Also handles boot / update / clock changes. */
public class Reminders extends BroadcastReceiver {
    static final String CHANNEL = "reminders";
    static final String PREFS = "zuse";
    static final String KEY = "plan", FIRED = "fired";

    @Override public void onReceive(Context ctx, Intent intent) {
        // Alarm, boot, package replaced, clock change: all do the same thing.
        // Items that came due while the phone was off are posted now rather than lost.
        fireDue(ctx, System.currentTimeMillis() + 60_000);
        arm(ctx);
    }

    /** Replace the whole plan with json {"items":[{id,at,title,body}]}, dropping past items, then arm. */
    static synchronized void setPlan(Context ctx, String json) throws Exception {
        JSONArray in = new JSONObject(json).optJSONArray("items");
        JSONArray keep = new JSONArray();
        long now = System.currentTimeMillis();
        JSONObject fired = fired(ctx); // fireDue posts up to 60s early; don't re-plan what already went off
        if (in != null) for (int i = 0; i < in.length(); i++) {
            JSONObject it = in.getJSONObject(i);
            String id = it.optString("id");
            if (it.optLong("at", 0) > now && !id.isEmpty() && fired.optLong(id, -1) != it.optLong("at")) keep.put(it);
        }
        prefs(ctx).edit().putString(KEY, keep.toString()).commit();
        arm(ctx);
    }

    static synchronized void fireDue(Context ctx, long cutoff) {
        JSONArray plan = load(ctx), left = new JSONArray();
        JSONObject fired = fired(ctx), recent = new JSONObject();
        long old = System.currentTimeMillis() - 86_400_000L;
        try {
            for (java.util.Iterator<String> k = fired.keys(); k.hasNext(); ) {
                String id = k.next();
                if (fired.optLong(id) > old) recent.put(id, fired.optLong(id));
            }
            for (int i = 0; i < plan.length(); i++) {
                JSONObject it = plan.optJSONObject(i);
                if (it == null) continue;
                if (it.optLong("at", 0) <= cutoff) {
                    post(ctx, it.optString("id"), it.optString("title"), it.optString("body"));
                    recent.put(it.optString("id"), it.optLong("at"));
                } else left.put(it);
            }
        } catch (Exception ignored) { }
        prefs(ctx).edit().putString(KEY, left.toString()).putString(FIRED, recent.toString()).commit();
    }

    static synchronized void arm(Context ctx) {
        JSONArray plan = load(ctx);
        long next = Long.MAX_VALUE;
        for (int i = 0; i < plan.length(); i++) {
            JSONObject it = plan.optJSONObject(i);
            if (it != null) next = Math.min(next, it.optLong("at", Long.MAX_VALUE));
        }
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, new Intent(ctx, Reminders.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (next == Long.MAX_VALUE) { am.cancel(pi); return; }
        if (canExact(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi);
    }

    static boolean canExact(Context ctx) {
        if (Build.VERSION.SDK_INT < 31) return true;
        return ((AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE)).canScheduleExactAlarms();
    }

    static void channel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.enableVibration(true); // default sound comes with IMPORTANCE_HIGH
        ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    /** Same id string -> same notification id, so a repeat replaces instead of stacking. */
    @SuppressWarnings("deprecation")
    static void post(Context ctx, String id, String title, String body) {
        channel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL)
                : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        b.setSmallIcon(R.drawable.ic_notif)
                .setLargeIcon(BitmapFactory.decodeResource(ctx.getResources(), R.mipmap.ic_launcher))
                .setContentTitle(title).setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(tap).setAutoCancel(true);
        try { ctx.getSystemService(NotificationManager.class).notify(id.hashCode(), b.build()); }
        catch (SecurityException ignored) { } // POST_NOTIFICATIONS not granted: silently drop
    }

    static SharedPreferences prefs(Context ctx) { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static JSONObject fired(Context ctx) {
        try { return new JSONObject(prefs(ctx).getString(FIRED, "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    static JSONArray load(Context ctx) {
        try { return new JSONArray(prefs(ctx).getString(KEY, "[]")); } catch (Exception e) { return new JSONArray(); }
    }
}
