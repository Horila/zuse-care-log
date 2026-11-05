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
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/** Stored reminder plan + the one alarm that walks it. Also handles boot / update / clock changes. */
public class Reminders extends BroadcastReceiver {
    // A channel's sound is fixed once created, so the loud one needed a new id; "reminders" was the old, quiet one.
    static final String CHANNEL = "alarms";
    static final String PREFS = "zuse";
    static final String KEY = "plan", FIRED = "fired";

    @Override public void onReceive(Context ctx, Intent intent) {
        // Alarm, boot, package replaced, clock change: all do the same thing.
        // Items that came due while the phone was off are posted now rather than lost.
        fireDue(ctx, System.currentTimeMillis() + 60_000);
        arm(ctx);
    }

    /** Zuse's plan. */
    static void setPlan(Context ctx, String json) throws Exception { setPlanFor(ctx, "", json); }

    /**
     * Replace one dog's part of the plan with json {"items":[{id,at,title,body}]}, dropping past items, then arm.
     * The stored plan is one list for both dogs: Zuse's items are untagged and keep their ids (as before), another
     * dog's carry "pet" and an id prefixed with it, so ids can't collide and replacing one dog's items never touches
     * the other's. The one alarm walks the union.
     */
    static synchronized void setPlanFor(Context ctx, String pet, String json) throws Exception {
        if (pet == null) pet = "";
        String pre = pet.isEmpty() ? "" : pet + ":";
        JSONArray in = new JSONObject(json).optJSONArray("items");
        JSONArray keep = new JSONArray(), old = load(ctx);
        for (int i = 0; i < old.length(); i++) { // the other dogs' items stay exactly as they are
            JSONObject it = old.optJSONObject(i);
            if (it != null && !it.optString("pet", "").equals(pet)) keep.put(it);
        }
        long now = System.currentTimeMillis();
        JSONObject fired = fired(ctx); // fireDue posts up to 60s early; don't re-plan what already went off
        if (in != null) for (int i = 0; i < in.length(); i++) {
            JSONObject it = in.getJSONObject(i);
            String id = pre + it.optString("id");
            if (it.optLong("at", 0) > now && !it.optString("id").isEmpty() && fired.optLong(id, -1) != it.optLong("at")) {
                it.put("id", id);
                if (pet.isEmpty()) it.remove("pet"); // Zuse's items stay untagged
                else it.put("pet", pet);
                keep.put(it);
            }
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
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.deleteNotificationChannel("reminders");
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        // The alarm stream plays through silent and vibrate mode, at the alarm volume.
        ch.setSound(sound(), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        ch.enableVibration(true);
        ch.setBypassDnd(true); // only honoured once the user allows it for this channel
        nm.createNotificationChannel(ch);
    }

    static Uri sound() {
        Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return u != null ? u : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
    }

    /** Same id string -> same notification id, so a repeat replaces instead of stacking. */
    @SuppressWarnings("deprecation")
    static void post(Context ctx, String id, String title, String body) {
        channel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL)
                : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH)
                        .setDefaults(Notification.DEFAULT_VIBRATE | Notification.DEFAULT_LIGHTS).setSound(sound(), AudioManager.STREAM_ALARM);
        b.setSmallIcon(R.drawable.ic_notif)
                .setLargeIcon(BitmapFactory.decodeResource(ctx.getResources(), R.mipmap.ic_launcher))
                .setContentTitle(title).setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_ALARM)
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
