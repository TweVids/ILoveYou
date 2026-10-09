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
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

public class StreamerForegroundService extends Service {
    private static final String TAG = "StreamerForeground";
    private static final String CHANNEL_ID = "minimal_streamer_foreground_channel";
    private static final int NOTIFICATION_ID = 1001;

    public static final String EXTRA_BASE_URL = "extra_base_url";

    private static volatile boolean isRunning = false;
    private static volatile String activeBaseUrl = "";
    private static volatile boolean sseConnected = false;
    private static volatile long lastUploadOkMs = 0;
    private static volatile long sentCount = 0;
    private static volatile long actionCount = 0;
    private static volatile long serviceStartTime = 0;

    private PowerManager.WakeLock wakeLock;

    private final AtomicBoolean isStopped = new AtomicBoolean(false);
    private final AtomicBoolean isUploadInFlight = new AtomicBoolean(false);

    private Thread captureThread;
    private Thread sseThread;
    private Thread heartbeatThread;

    public static boolean isServiceRunning() {
        return isRunning;
    }

    public static JSONObject getStatusJson() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("running", isRunning);
            obj.put("sseConnected", sseConnected);
            obj.put("lastUploadOkMs", lastUploadOkMs);
            obj.put("sent", sentCount);
            obj.put("actions", actionCount);
            obj.put("uptimeMs", isRunning ? (System.currentTimeMillis() - serviceStartTime) : 0);
            obj.put("baseUrl", activeBaseUrl != null ? activeBaseUrl : "");
        } catch (Exception ignored) {}
        return obj;
    }

    public static void start(Context context, String baseUrl) {
        try {
            Intent intent = new Intent(context, StreamerForegroundService.class);
            if (baseUrl != null) {
                intent.putExtra(EXTRA_BASE_URL, baseUrl.trim());
            }
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
        isStopped.set(false);
        serviceStartTime = System.currentTimeMillis();

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

        if (intent != null && intent.hasExtra(EXTRA_BASE_URL)) {
            String url = intent.getStringExtra(EXTRA_BASE_URL);
            if (url != null && !url.trim().isEmpty()) {
                activeBaseUrl = url.trim().replaceAll("/+$", "");
            }
        }

        startBackgroundLoops();
        return START_STICKY;
    }

    private synchronized void startBackgroundLoops() {
        if (activeBaseUrl == null || activeBaseUrl.isEmpty()) {
            Log.w(TAG, "activeBaseUrl is empty; loops will wait for valid URL");
        }

        if (captureThread == null || !captureThread.isAlive()) {
            captureThread = new Thread(this::runCaptureLoop, "Streamer-CaptureLoop");
            captureThread.start();
        }

        if (sseThread == null || !sseThread.isAlive()) {
            sseThread = new Thread(this::runSseLoop, "Streamer-SseLoop");
            sseThread.start();
        }

        if (heartbeatThread == null || !heartbeatThread.isAlive()) {
            heartbeatThread = new Thread(this::runHeartbeatLoop, "Streamer-HeartbeatLoop");
            heartbeatThread.start();
        }
    }

    /**
     * Loop 1: Native screen capture and upload every ~1.5s
     */
    private void runCaptureLoop() {
        Log.i(TAG, "Capture loop started for baseUrl: " + activeBaseUrl);
        while (!isStopped.get()) {
            long loopStart = System.currentTimeMillis();

            if (activeBaseUrl != null && !activeBaseUrl.isEmpty()) {
                SystemActionService service = SystemActionService.getInstance();
                if (service != null && !isUploadInFlight.get()) {
                    isUploadInFlight.set(true);
                    service.takeSystemScreenshot(new SystemActionService.ScreenshotCallback() {
                        @Override
                        public void onSuccess(String base64, String mimeType) {
                            new Thread(() -> {
                                try {
                                    byte[] imageBytes = Base64.decode(base64, Base64.DEFAULT);
                                    uploadScreenshotBytes(imageBytes, mimeType);
                                } catch (Exception e) {
                                    Log.e(TAG, "Error decoding/uploading screenshot", e);
                                } finally {
                                    isUploadInFlight.set(false);
                                }
                            }).start();
                        }

                        @Override
                        public void onError(String message) {
                            Log.w(TAG, "System screenshot error: " + message);
                            isUploadInFlight.set(false);
                        }
                    });
                }
            }

            long elapsed = System.currentTimeMillis() - loopStart;
            long sleepTime = Math.max(100, 1500 - elapsed);
            try {
                Thread.sleep(sleepTime);
            } catch (InterruptedException e) {
                break;
            }
        }
        Log.i(TAG, "Capture loop exited");
    }

    private void uploadScreenshotBytes(byte[] imageBytes, String mimeType) {
        if (activeBaseUrl == null || activeBaseUrl.isEmpty() || isStopped.get()) {
            return;
        }

        HttpURLConnection conn = null;
        try {
            URL url = new URL(activeBaseUrl + "/v1/screen/sent");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", (mimeType != null && !mimeType.isEmpty()) ? mimeType : "image/webp");
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setFixedLengthStreamingMode(imageBytes.length);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(imageBytes);
                os.flush();
            }

            int responseCode = conn.getResponseCode();
            if (responseCode >= 200 && responseCode < 300) {
                lastUploadOkMs = System.currentTimeMillis();
                sentCount++;
                Log.d(TAG, "[Native Screen Sent] " + responseCode + " OK - " + imageBytes.length + " bytes (total: " + sentCount + ")");
            } else {
                Log.w(TAG, "[Native Screen Sent] HTTP " + responseCode);
            }
        } catch (Exception e) {
            if (!isStopped.get()) {
                Log.w(TAG, "[Native Screen Sent] Upload failed: " + e.getMessage());
            }
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {}
            }
        }
    }

    /**
     * Loop 2: Native SSE action stream receiver & direct dispatcher
     */
    private void runSseLoop() {
        Log.i(TAG, "SSE loop started for baseUrl: " + activeBaseUrl);
        long backoffMs = 1000;

        while (!isStopped.get()) {
            if (activeBaseUrl == null || activeBaseUrl.isEmpty()) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException e) {
                    break;
                }
                continue;
            }

            HttpURLConnection conn = null;
            BufferedReader reader = null;
            try {
                URL url = new URL(activeBaseUrl + "/v2/screen/retrived");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(0); // Infinite read timeout for SSE stream
                conn.setRequestProperty("Accept", "text/event-stream, application/json, */*");
                conn.setRequestProperty("ngrok-skip-browser-warning", "1");

                int responseCode = conn.getResponseCode();
                if (responseCode != 200) {
                    Log.w(TAG, "[Native SSE] Response code: " + responseCode + ", retrying in " + backoffMs + "ms");
                    sseConnected = false;
                    Thread.sleep(backoffMs);
                    backoffMs = Math.min(5000, backoffMs * 2);
                    continue;
                }

                sseConnected = true;
                backoffMs = 1000; // Reset backoff on successful connect
                Log.i(TAG, "[Native SSE] Connected to " + url);

                InputStream is = conn.getInputStream();
                reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                String line;

                while (!isStopped.get() && (line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    if (trimmed.isEmpty()) continue;

                    String payload = trimmed;
                    if (payload.startsWith("data:")) {
                        payload = payload.substring(5).trim();
                    }
                    if (payload.isEmpty() || "[DONE]".equalsIgnoreCase(payload)) {
                        continue;
                    }

                    try {
                        if (payload.startsWith("[")) {
                            JSONArray arr = new JSONArray(payload);
                            for (int i = 0; i < arr.length(); i++) {
                                dispatchActionJson(arr.optJSONObject(i));
                            }
                        } else if (payload.startsWith("{")) {
                            JSONObject obj = new JSONObject(payload);
                            dispatchActionJson(obj);
                        }
                    } catch (Exception parseErr) {
                        Log.d(TAG, "[Native SSE] Ignored partial or non-json line: " + parseErr.getMessage());
                    }
                }
            } catch (Exception e) {
                sseConnected = false;
                if (!isStopped.get()) {
                    Log.w(TAG, "[Native SSE] Disconnected/Error (" + e.getMessage() + "), retrying in " + backoffMs + "ms");
                    try {
                        Thread.sleep(backoffMs);
                    } catch (InterruptedException ignored) {
                        break;
                    }
                    backoffMs = Math.min(5000, backoffMs * 2);
                }
            } finally {
                sseConnected = false;
                if (reader != null) {
                    try { reader.close(); } catch (Exception ignored) {}
                }
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
            }
        }
        Log.i(TAG, "SSE loop exited");
    }

    /**
     * Dispatcher: Parse JSON and execute directly on SystemActionService (0 WebView round trip)
     */
    private void dispatchActionJson(JSONObject raw) {
        if (raw == null) return;

        SystemActionService service = SystemActionService.getInstance();
        if (service == null) {
            Log.w(TAG, "Cannot dispatch action: SystemActionService is not connected");
            return;
        }

        try {
            // Check nested wrappers (functionCall, parameters, tool_calls)
            if (raw.has("functionCall")) {
                JSONObject fc = raw.optJSONObject("functionCall");
                if (fc != null && fc.has("args")) {
                    dispatchActionJson(fc.optJSONObject("args"));
                    return;
                }
            }

            if (raw.has("tool_calls")) {
                JSONArray toolCalls = raw.optJSONArray("tool_calls");
                if (toolCalls != null && toolCalls.length() > 0) {
                    for (int i = 0; i < toolCalls.length(); i++) {
                        JSONObject tc = toolCalls.optJSONObject(i);
                        if (tc != null) {
                            JSONObject fn = tc.optJSONObject("function");
                            if (fn != null && fn.has("arguments")) {
                                String argsStr = fn.optString("arguments");
                                dispatchActionJson(new JSONObject(argsStr));
                            }
                        }
                    }
                    return;
                }
            }

            if (raw.has("parameters")) {
                JSONObject params = raw.optJSONObject("parameters");
                if (params != null) {
                    dispatchActionJson(params);
                    return;
                }
            }

            String name = raw.optString("name", "");

            // 1. launch_intent
            if ("launch_intent".equalsIgnoreCase(name) || raw.has("target")) {
                String target = raw.optString("target", "");
                String query = raw.optString("query", "");
                String phone = raw.optString("phone_number", "");
                String url = raw.optString("url", "");
                String pkg = raw.optString("package_name", "");

                Log.i(TAG, "[Native Dispatch] launch_intent: target=" + target + ", query=" + query);
                service.launchIntentAction(target, query, phone, url, pkg, new SystemActionService.ActionCallback() {
                    @Override
                    public void onSuccess() {
                        actionCount++;
                        Log.d(TAG, "[Native Dispatch] Intent succeeded");
                    }

                    @Override
                    public void onError(String msg) {
                        Log.w(TAG, "[Native Dispatch] Intent failed: " + msg);
                    }
                });
                return;
            }

            // 2. ui_element_action
            if ("ui_element_action".equalsIgnoreCase(name) || (raw.has("target_text") && !raw.has("x1"))) {
                String action = raw.optString("action", "click");
                String targetText = raw.optString("target_text", "");
                String textToType = raw.optString("text_to_type", "");
                boolean pressEnter = raw.optBoolean("press_enter", false);

                Log.i(TAG, "[Native Dispatch] ui_element_action: " + action + " target=" + targetText);
                service.performElementAction(action, targetText, textToType, pressEnter, new SystemActionService.ElementActionResultCallback() {
                    @Override
                    public void onSuccess(String resultMessage) {
                        actionCount++;
                        Log.d(TAG, "[Native Dispatch] Element action succeeded: " + resultMessage);
                    }

                    @Override
                    public void onError(String msg) {
                        Log.w(TAG, "[Native Dispatch] Element action failed: " + msg);
                    }
                });
                return;
            }

            // 3. perform_system_action (hardware navigation buttons)
            if ("perform_system_action".equalsIgnoreCase(name) ||
                    ("home_click".equalsIgnoreCase(raw.optString("action")) ||
                     "previous".equalsIgnoreCase(raw.optString("action")) ||
                     "tab".equalsIgnoreCase(raw.optString("action")))) {
                String action = raw.optString("action", "home_click");
                Log.i(TAG, "[Native Dispatch] perform_system_action: " + action);
                service.performSystemNavigation(action, new SystemActionService.ActionCallback() {
                    @Override
                    public void onSuccess() {
                        actionCount++;
                        Log.d(TAG, "[Native Dispatch] System navigation succeeded: " + action);
                    }

                    @Override
                    public void onError(String msg) {
                        Log.w(TAG, "[Native Dispatch] System navigation failed: " + msg);
                    }
                });
                return;
            }

            // 4. perform_ui_action (coordinate click/drag/stroll/type)
            if (raw.has("x1") && raw.has("y1")) {
                int x1 = raw.optInt("x1", 500);
                int y1 = raw.optInt("y1", 500);
                Integer x2 = raw.has("x2") ? raw.optInt("x2") : null;
                Integer y2 = raw.has("y2") ? raw.optInt("y2") : null;
                String rawAction = raw.optString("action", "click");
                String action = rawAction.toLowerCase().replace("scroll_", "stroll_");
                int scrollSpeed = raw.optInt("scroll_speed", 2);
                int scrollDurationMs = raw.optInt("scroll_duration_ms", 400);
                String text = raw.optString("text", "");
                boolean pressEnter = raw.optBoolean("press_enter", false);

                DisplayMetrics dm = getResources().getDisplayMetrics();
                float realX1 = (x1 / 999.0f) * dm.widthPixels;
                float realY1 = (y1 / 999.0f) * dm.heightPixels;
                float realX2 = (x2 != null) ? (x2 / 999.0f) * dm.widthPixels : realX1;
                float realY2 = (y2 != null) ? (y2 / 999.0f) * dm.heightPixels : realY1;

                Log.i(TAG, "[Native Dispatch] UI action: " + action + " at (" + realX1 + ", " + realY1 + ")");

                if ("click".equals(action)) {
                    service.dispatchClick(realX1, realY1, 100, new SystemActionService.ActionCallback() {
                        @Override
                        public void onSuccess() {
                            actionCount++;
                        }
                        @Override
                        public void onError(String msg) {
                            Log.w(TAG, "[Native Dispatch] Click failed: " + msg);
                        }
                    });
                } else if ("type".equals(action)) {
                    service.typeText(text, pressEnter, new SystemActionService.ActionCallback() {
                        @Override
                        public void onSuccess() {
                            actionCount++;
                        }
                        @Override
                        public void onError(String msg) {
                            Log.w(TAG, "[Native Dispatch] Type failed: " + msg);
                        }
                    });
                } else if (action.startsWith("stroll_")) {
                    float baseDistance = Math.min(dm.widthPixels, dm.heightPixels) * 0.40f;
                    float multiplier = scrollSpeed == 1 ? 0.6f : (scrollSpeed == 3 ? 1.5f : 1.0f);
                    float distance = baseDistance * multiplier;

                    float startX = realX1;
                    float startY = realY1;
                    float endX = realX1;
                    float endY = realY1;

                    if ("stroll_down".equals(action)) {
                        endY = Math.max(0, startY - distance);
                    } else if ("stroll_up".equals(action)) {
                        endY = Math.min(dm.heightPixels, startY + distance);
                    } else if ("stroll_right".equals(action)) {
                        endX = Math.max(0, startX - distance);
                    } else if ("stroll_left".equals(action)) {
                        endX = Math.min(dm.widthPixels, startX + distance);
                    }

                    service.dispatchScroll(startX, startY, endX, endY, scrollDurationMs, new SystemActionService.ActionCallback() {
                        @Override
                        public void onSuccess() {
                            actionCount++;
                        }
                        @Override
                        public void onError(String msg) {
                            Log.w(TAG, "[Native Dispatch] Stroll failed: " + msg);
                        }
                    });
                } else {
                    service.dispatchScroll(realX1, realY1, realX2, realY2, scrollDurationMs, new SystemActionService.ActionCallback() {
                        @Override
                        public void onSuccess() {
                            actionCount++;
                        }
                        @Override
                        public void onError(String msg) {
                            Log.w(TAG, "[Native Dispatch] Drag failed: " + msg);
                        }
                    });
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "[Native Dispatch] Error dispatching action", e);
        }
    }

    /**
     * Loop 3: Native heartbeat to {baseUrl}/v1/debug every 2s
     */
    private void runHeartbeatLoop() {
        Log.i(TAG, "Heartbeat loop started");
        while (!isStopped.get()) {
            if (activeBaseUrl != null && !activeBaseUrl.isEmpty()) {
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(activeBaseUrl + "/v1/debug");
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(4000);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setRequestProperty("ngrok-skip-browser-warning", "1");

                    JSONObject debugJson = new JSONObject();
                    debugJson.put("source", "phone_foreground_service");
                    debugJson.put("lastUploadOkMs", lastUploadOkMs);
                    debugJson.put("sseConnected", sseConnected);
                    debugJson.put("sent", sentCount);
                    debugJson.put("actions", actionCount);
                    debugJson.put("uptimeMs", System.currentTimeMillis() - serviceStartTime);

                    byte[] postData = debugJson.toString().getBytes(StandardCharsets.UTF_8);
                    conn.setFixedLengthStreamingMode(postData.length);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(postData);
                        os.flush();
                    }
                    int code = conn.getResponseCode();
                    Log.d(TAG, "[Heartbeat] sent code " + code);
                } catch (Exception ignored) {
                } finally {
                    if (conn != null) {
                        try { conn.disconnect(); } catch (Exception ignored) {}
                    }
                }
            }

            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                break;
            }
        }
        Log.i(TAG, "Heartbeat loop exited");
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        isStopped.set(true);
        isRunning = false;
        sseConnected = false;

        if (captureThread != null) captureThread.interrupt();
        if (sseThread != null) sseThread.interrupt();
        if (heartbeatThread != null) heartbeatThread.interrupt();

        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {}
            wakeLock = null;
        }
        Log.i(TAG, "StreamerForegroundService destroyed");
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
                .setContentText("Native AI streaming & assistant active across other apps")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
