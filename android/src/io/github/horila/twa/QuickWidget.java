package io.github.horila.twa;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** Home-screen widget: one-tap Wee Wee / Poop for Zuse and for Reggie. The taps go to QuickLog, which isn't exported. */
public class QuickWidget extends AppWidgetProvider {
    @Override public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        v.setOnClickPendingIntent(R.id.wee, tap(ctx, "weewee", "", 1));
        v.setOnClickPendingIntent(R.id.poop, tap(ctx, "poop", "", 2));
        v.setOnClickPendingIntent(R.id.rwee, tap(ctx, "weewee", "reggie", 3));
        v.setOnClickPendingIntent(R.id.rpoop, tap(ctx, "poop", "reggie", 4));
        m.updateAppWidget(ids, v);
    }

    /** The request code must differ per button: PendingIntents ignore extras when matching. */
    static PendingIntent tap(Context ctx, String type, String pet, int code) {
        Intent i = new Intent(ctx, QuickLog.class).putExtra("t", type).putExtra("pet", pet);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
