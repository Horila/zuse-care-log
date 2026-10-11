package io.github.horila.twa;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    static final String APP = "https://horila.github.io/zuse-care-log/";
    static final String START = APP + "zuse-care-log.html";
    static final int REQ_FILE = 1, REQ_LOC = 2, REQ_NOTIF = 3, REQ_STORAGE = 4, REQ_WALK = 5;
    static volatile MainActivity live; // the page WalkService pokes when a walk ends

    WebView web;
    volatile String pageUrl = ""; // read from the JS bridge thread; getUrl() is UI-thread only
    ValueCallback<Uri[]> fileCb;
    GeolocationPermissions.Callback geoCb;
    String geoOrigin;
    String walkJson;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        catchCrashes();
        try { Reminders.channel(this); SyncJob.schedule(this); } catch (Exception ignored) { }
        web = new WebView(this);
        web.setBackgroundColor(0xFF0E1419);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the whole log lives in localStorage
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setGeolocationEnabled(true);
        web.addJavascriptInterface(new Bridge(), "ZuseNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(START);
        live = this;
    }

    /** Keep the last crash's stack trace and show it on the next open, since a phone has no other way to report it. */
    void catchCrashes() {
        String last = Reminders.prefs(this).getString("crash", null);
        if (last != null) {
            Reminders.prefs(this).edit().remove("crash").commit();
            android.widget.TextView t = new android.widget.TextView(this);
            t.setText(last); t.setTextIsSelectable(true); t.setTextSize(11); t.setPadding(40, 20, 40, 20);
            android.widget.ScrollView sv = new android.widget.ScrollView(this);
            sv.addView(t);
            new AlertDialog.Builder(this).setTitle("Zuse crashed last time").setView(sv)
                    .setPositiveButton(android.R.string.ok, null).show();
        }
        Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((th, e) -> {
            java.io.StringWriter sw = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(sw));
            String s = sw.toString();
            Reminders.prefs(this).edit().putString("crash", s.length() > 6000 ? s.substring(0, 6000) : s).commit();
            if (prev != null) prev.uncaughtException(th, e);
        });
    }

    @Override protected void onDestroy() { if (live == this) live = null; super.onDestroy(); }

    /** Ask the page, if it is still in memory, to drain WalkService's queue now. */
    static void poke() {
        MainActivity a = live;
        if (a != null) a.runOnUiThread(() -> a.web.evaluateJavascript("window.takeNative&&takeNative()", null));
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onPause() { web.onPause(); super.onPause(); }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        // Off the app (offline error page): going back would just fail again, so leave.
        if (inApp(pageUrl) && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    static boolean inApp(String url) { return url != null && url.startsWith(APP); }

    void openOutside(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    class Client extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            String url = r.getUrl().toString();
            if (inApp(url)) return false;
            openOutside(url);
            return true;
        }
        @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { pageUrl = url == null ? "" : url; }
        @Override public void doUpdateVisitedHistory(WebView v, String url, boolean reload) { pageUrl = url == null ? "" : url; }
        @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (!r.isForMainFrame()) return;
            String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                    + "<body style='background:#0E1419;color:#e6edf3;font:16px sans-serif;display:flex;flex-direction:column;"
                    + "align-items:center;justify-content:center;height:90vh;text-align:center;padding:0 24px'>"
                    + "<p>Can't reach the app &mdash; check your connection.</p>"
                    + "<button style='font-size:16px;padding:10px 24px' onclick=\"location.href='" + START + "'\">Retry</button>";
            v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        }
    }

    class Chrome extends WebChromeClient {
        @Override public boolean onJsAlert(WebView v, String url, String msg, JsResult res) {
            new AlertDialog.Builder(MainActivity.this).setMessage(msg)
                    .setPositiveButton(android.R.string.ok, (d, w) -> res.confirm())
                    .setOnCancelListener(d -> res.confirm()).show();
            return true;
        }
        @Override public boolean onJsConfirm(WebView v, String url, String msg, JsResult res) {
            new AlertDialog.Builder(MainActivity.this).setMessage(msg)
                    .setPositiveButton(android.R.string.ok, (d, w) -> res.confirm())
                    .setNegativeButton(android.R.string.cancel, (d, w) -> res.cancel())
                    .setOnCancelListener(d -> res.cancel()).show();
            return true;
        }
        @Override public boolean onJsPrompt(WebView v, String url, String msg, String def, JsPromptResult res) {
            EditText in = new EditText(MainActivity.this);
            if (def != null) in.setText(def);
            new AlertDialog.Builder(MainActivity.this).setMessage(msg).setView(in)
                    .setPositiveButton(android.R.string.ok, (d, w) -> res.confirm(in.getText().toString()))
                    .setNegativeButton(android.R.string.cancel, (d, w) -> res.cancel())
                    .setOnCancelListener(d -> res.cancel()).show();
            return true;
        }
        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileCb != null) fileCb.onReceiveValue(null);
            fileCb = cb;
            Intent i = p.createIntent();
            if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            // accept=".json" becomes type ".json", which greys out every file in the picker.
            if (i.getType() == null || !i.getType().contains("/")) i.setType("*/*");
            try { startActivityForResult(i, REQ_FILE); }
            catch (Exception e) { fileCb = null; cb.onReceiveValue(null); return false; }
            return true;
        }
        @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                cb.invoke(origin, true, false);
                return;
            }
            geoCb = cb; geoOrigin = origin;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
        }
    }

    @Override protected void onActivityResult(int req, int code, Intent data) {
        if (req != REQ_FILE || fileCb == null) { super.onActivityResult(req, code, data); return; }
        Uri[] out = null;
        if (code == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                out = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < out.length; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) out = new Uri[]{data.getData()};
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_LOC && geoCb != null) {
            boolean ok = false;
            for (int r : res) ok |= r == PackageManager.PERMISSION_GRANTED;
            geoCb.invoke(geoOrigin, ok, false);
            geoCb = null;
        }
        if (req == REQ_WALK && walkJson != null) {
            for (int r : res) if (r == PackageManager.PERMISSION_GRANTED) {
                try { WalkService.begin(this, walkJson); } catch (Exception ignored) { }
                break;
            }
            walkJson = null;
        }
        // the page has no callback for the permission prompt; refresh its status line
        if (req == REQ_NOTIF) web.evaluateJavascript("window.renderNotif&&renderNotif()", null);
    }

    /** window.ZuseNative. Runs on the JavaBridge thread; every call refuses unless the page is the app. */
    class Bridge {
        boolean ok() { return inApp(pageUrl); }

        @JavascriptInterface public String version() { return "3.2"; }

        /** Hand the walk to WalkService so it survives the app being closed. */
        @JavascriptInterface public void startWalk(String json) {
            if (!ok()) return;
            runOnUiThread(() -> {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                        || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    try { WalkService.begin(MainActivity.this, json); } catch (Exception ignored) { }
                    return;
                }
                walkJson = json;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_WALK);
            });
        }

        /** Setup -> Background sync, in minutes; 0 turns it off. */
        @JavascriptInterface public void setSyncEvery(int min) {
            if (!ok()) return;
            Reminders.prefs(MainActivity.this).edit().putInt("syncMin", min).commit();
            try { SyncJob.schedule(MainActivity.this); } catch (Exception ignored) { }
        }

        /** Around each sync the page runs, so closing the app mid-sync doesn't cut it off. */
        @JavascriptInterface public void syncing(boolean on) { if (ok()) SyncKeep.set(MainActivity.this, on); }

        @JavascriptInterface public void stopWalk() {
            if (ok()) try { WalkService.cancel(MainActivity.this); } catch (Exception ignored) { }
        }

        /** Entries finished natively while the page wasn't looking, as a JSON array; empties the queue. */
        @JavascriptInterface public String takeEntries() { return ok() ? WalkService.take(MainActivity.this) : "[]"; }

        @JavascriptInterface public void setPlan(String json) {
            if (!ok()) return;
            try { Reminders.setPlan(MainActivity.this, json); } catch (Exception ignored) { }
        }

        @JavascriptInterface public void notify(String id, String title, String body) {
            if (ok()) Reminders.post(MainActivity.this, id, title, body);
        }

        @JavascriptInterface public String notifPermission() {
            if (!ok()) return "denied";
            if (Build.VERSION.SDK_INT < 33)
                return getSystemService(android.app.NotificationManager.class).areNotificationsEnabled() ? "granted" : "denied";
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return "granted";
            return Reminders.prefs(MainActivity.this).getBoolean("askedNotif", false) ? "denied" : "default";
        }

        @JavascriptInterface public void requestNotifPermission() {
            if (!ok() || Build.VERSION.SDK_INT < 33) return;
            Reminders.prefs(MainActivity.this).edit().putBoolean("askedNotif", true).apply();
            runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF));
        }

        @JavascriptInterface public boolean exactAlarms() { return ok() && Reminders.canExact(MainActivity.this); }

        @JavascriptInterface public void openExactAlarmSettings() {
            if (!ok() || Build.VERSION.SDK_INT < 31) return;
            runOnUiThread(() -> {
                try { startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName()))); }
                catch (Exception ignored) { }
            });
        }

        @JavascriptInterface public String saveFile(String name, String mime, String text) {
            if (!ok()) return "Not allowed from this page";
            byte[] bytes = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return "Couldn't create the file in Downloads";
                    try (OutputStream o = getContentResolver().openOutputStream(uri)) { o.write(bytes); }
                    return "";
                }
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE));
                    return "Storage permission needed - allow it, then save again";
                }
                @SuppressWarnings("deprecation")
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                dir.mkdirs();
                try (FileOutputStream o = new FileOutputStream(new File(dir, new File(name).getName()))) { o.write(bytes); }
                return "";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }

        @JavascriptInterface public void share(String text) {
            if (!ok()) return;
            Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
            runOnUiThread(() -> startActivity(Intent.createChooser(i, null)));
        }

        @JavascriptInterface public void openExternal(String url) {
            if (ok() && url != null) runOnUiThread(() -> openOutside(url));
        }
    }
}
