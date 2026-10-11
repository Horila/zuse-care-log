package io.github.horila.twa;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** Home-screen widget: one-tap Wee Wee / Poop. The taps go to QuickLog, which isn't exported. */
public class QuickWidget extends AppWidgetProvider {
    @Override public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        v.setOnClickPendingIntent(R.id.wee, tap(ctx, "weewee", 1));
        v.setOnClickPendingIntent(R.id.poop, tap(ctx, "poop", 2));
        m.updateAppWidget(ids, v);
    }

    static PendingIntent tap(Context ctx, String type, int code) {
        Intent i = new Intent(ctx, QuickLog.class).putExtra("t", type);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
