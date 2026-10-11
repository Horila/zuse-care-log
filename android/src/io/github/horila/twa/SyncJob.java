package io.github.horila.twa;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Syncs with the sheet every half hour or so with the app closed, by loading the page in a
 * hidden WebView and letting its own autoSync run: one sync implementation, not two.
 * Afterwards the page's fresh notification plan is handed to Reminders, so a shot logged
 * on another phone cancels this phone's "insulin not logged" alert.
 * Doze defers it to the phone's maintenance windows; that is the ceiling.
 */
public class SyncJob extends JobService {
    static final int ID = 1, SOON = 2;
    static final String PLAN = "JSON.stringify({items:cfg.notifOn?notifPlan(new Date()):[]})";

    WebView web;
    boolean own; // false: web is the open app's page, which isn't ours to destroy
    final Handler h = new Handler(Looper.getMainLooper());

    /** Every Setup -> "Background sync" minutes (prefs syncMin, default 30, 0 = off; Android's floor is 15). */
    static void schedule(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        int min = Reminders.prefs(ctx).getInt("syncMin", 30);
        if (min <= 0) { js.cancel(ID); return; }
        long every = Math.max(15, min) * 60_000L;
        JobInfo had = js.getPendingJob(ID);
        if (had != null && had.getIntervalMillis() == every) return;
        js.schedule(new JobInfo.Builder(ID, new ComponentName(ctx, SyncJob.class))
                .setPeriodic(every)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    /** One sync as soon as there's a network: a widget tap. */
    static void soon(Context ctx) {
        ctx.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(SOON, new ComponentName(ctx, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());
    }

    @Override public boolean onStartJob(JobParameters p) {
        MainActivity a = MainActivity.live;
        if (a != null) { // the app is in memory: its page syncs and its bridge sends the plan; the job just keeps it awake
            web = a.web; own = false;
            web.evaluateJavascript("window.autoSync&&autoSync()", null);
            h.postDelayed(() -> poll(p, System.currentTimeMillis() + 180_000), 1000);
            h.postDelayed(() -> done(p), 240_000);
            return true;
        }
        web = new WebView(this); own = true;
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setDatabaseEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            boolean started;
            @Override public void onPageFinished(WebView v, String url) {
                if (started) return;
                started = true;
                h.postDelayed(() -> ready(p, System.currentTimeMillis() + 30_000), 1000);
            }
        });
        web.loadUrl(MainActivity.START);
        h.postDelayed(() -> done(p), 240_000); // never hold the job longer than this
        return true;
    }

    /**
     * Wait for the page to have loaded its log (zuseReady), then hand it the native queue:
     * widget taps and finished walks. Taking the queue before that would log into an
     * empty list and save it over the real one.
     */
    void ready(JobParameters p, long deadline) {
        if (web == null) return;
        web.evaluateJavascript("window.zuseReady===1&&typeof takeNative==='function'", ok -> {
            if (web == null) return;
            if (!"true".equals(ok)) {
                if (System.currentTimeMillis() < deadline) h.postDelayed(() -> ready(p, deadline), 1000);
                else done(p); // offline error page, or an old page: leave the queue for next time
                return;
            }
            String q = WalkService.take(this);
            web.evaluateJavascript("takeNative(" + org.json.JSONObject.quote(q) + ")", null);
            h.postDelayed(() -> poll(p, System.currentTimeMillis() + 180_000), 1000);
        });
    }

    /** Wait for the page's sync to finish, then take its plan. */
    void poll(JobParameters p, long deadline) {
        if (web == null) return;
        web.evaluateJavascript("typeof syncBusy!=='undefined'&&syncBusy", busy -> {
            if ("true".equals(busy) && System.currentTimeMillis() < deadline) { h.postDelayed(() -> poll(p, deadline), 2000); return; }
            if (web == null) return;
            if (!own) { done(p); return; }
            web.evaluateJavascript(PLAN, json -> {
                try { // evaluateJavascript hands back the string JSON-quoted
                    if (json != null && json.startsWith("\"")) Reminders.setPlan(this, new org.json.JSONArray("[" + json + "]").getString(0));
                } catch (Exception ignored) { }
                done(p);
            });
        });
    }

    void done(JobParameters p) {
        if (web == null) return;
        if (own) web.destroy();
        web = null;
        h.removeCallbacksAndMessages(null);
        jobFinished(p, false);
    }

    @Override public boolean onStopJob(JobParameters p) {
        if (web != null && own) web.destroy();
        web = null;
        h.removeCallbacksAndMessages(null);
        return true;
    }
}
