package com.minimalstreamer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class StreamerForegroundService extends Service {
    private static final String TAG = "StreamerForeground";
    private static final String CHANNEL_ID = "minimal_streamer_foreground_channel";
    private static final int NOTIFICATION_ID = 1001;

    private static boolean isRunning = false;
    private PowerManager.WakeLock wakeLock;

    public static boolean isServiceRunning() {
        return isRunning;
    }

    public static void start(Context context) {
        try {
            Intent intent = new Intent(context, StreamerForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed starting StreamerForegroundService", e);
        }
    }

    public static void stop(Context context) {
        try {
            Intent intent = new Intent(context, StreamerForegroundService.class);
            context.stopService(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed stopping StreamerForegroundService", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        isRunning = true;

        try {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MinimalStreamer:WakeLock");
                wakeLock.acquire(12 * 60 * 60 * 1000L); // max 12 hours
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed acquiring WakeLock", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        try {
            startForeground(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            Log.e(TAG, "Failed startForeground", e);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        isRunning = false;
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {}
            wakeLock = null;
        }
        Log.i(TAG, "StreamerForegroundService stopped");
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Minimal Streamer Active Call",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Keeps streaming and assistant tools active while using other apps");
            channel.setShowBadge(false);
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        notificationIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                notificationIntent,
                pendingFlags
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Minimal Streamer is Active")
                .setContentText("AI Assistant is running and ready across other apps")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
