package com.minimalstreamer.app;

import android.content.Intent;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceControl")
public class DeviceControlPlugin extends Plugin {
    private static final String TAG = "DeviceControlPlugin";

    @PluginMethod
    public void checkStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean isRunning = SystemActionService.isServiceRunning();
        ret.put("accessibilityEnabled", isRunning);
        ret.put("canTakeSystemScreenshot", android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R);

        try {
            DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            ret.put("screenWidth", dm.widthPixels);
            ret.put("screenHeight", dm.heightPixels);
            ret.put("density", dm.density);
        } catch (Exception e) {
            Log.w(TAG, "Failed getting display metrics", e);
        }

        ret.put("foregroundServiceRunning", StreamerForegroundService.isServiceRunning());
        call.resolve(ret);
    }

    @PluginMethod
    public void startForegroundService(PluginCall call) {
        try {
            StreamerForegroundService.start(getContext());
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed starting foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            StreamerForegroundService.stop(getContext());
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed stopping foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed opening accessibility settings", e);
            call.reject("Could not open accessibility settings: " + e.getMessage());
        }
    }

    @PluginMethod
    public void performAction(PluginCall call) {
        SystemActionService service = SystemActionService.getInstance();
        if (service == null) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", "Accessibility service is not enabled in Android Settings");
            call.resolve(ret);
            return;
        }

        String rawAction = call.getString("action", "click");
        final String action = rawAction != null ? rawAction.toLowerCase().replace("scroll_", "stroll_") : "click";

        int x1 = call.getInt("x1", 500);
        int y1 = call.getInt("y1", 500);
        Integer x2 = call.getInt("x2");
        Integer y2 = call.getInt("y2");
        int scrollSpeed = call.getInt("scroll_speed", 2);
        int scrollDurationMs = call.getInt("scroll_duration_ms", 400);
        String text = call.getString("text", "");
        boolean pressEnter = Boolean.TRUE.equals(call.getBoolean("press_enter", false));

        DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
        float realX1 = (x1 / 999.0f) * dm.widthPixels;
        float realY1 = (y1 / 999.0f) * dm.heightPixels;

        float realX2 = (x2 != null) ? (x2 / 999.0f) * dm.widthPixels : realX1;
        float realY2 = (y2 != null) ? (y2 / 999.0f) * dm.heightPixels : realY1;

        Log.i(TAG, "Executing OS action: " + action + " at (" + realX1 + ", " + realY1 + ")");

        if ("click".equals(action)) {
            service.dispatchClick(realX1, realY1, 100, new SystemActionService.ActionCallback() {
                @Override
                public void onSuccess() {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("action", "click");
                    call.resolve(ret);
                }

                @Override
                public void onError(String message) {
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("error", message);
                    call.resolve(ret);
                }
            });
        } else if ("type".equals(action)) {
            service.typeText(text, pressEnter, new SystemActionService.ActionCallback() {
                @Override
                public void onSuccess() {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("action", "type");
                    call.resolve(ret);
                }

                @Override
                public void onError(String message) {
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("error", message);
                    call.resolve(ret);
                }
            });
        } else if (action.startsWith("stroll_")) {
            // Calculate stroll distance based on speed
            float baseDistance = Math.min(dm.widthPixels, dm.heightPixels) * 0.40f;
            float multiplier = scrollSpeed == 1 ? 0.6f : (scrollSpeed == 3 ? 1.5f : 1.0f);
            float distance = baseDistance * multiplier;

            float startX = realX1;
            float startY = realY1;
            float endX = realX1;
            float endY = realY1;

            if ("stroll_down".equals(action)) {
                // Drag upwards to scroll content down
                endY = Math.max(0, startY - distance);
            } else if ("stroll_up".equals(action)) {
                // Drag downwards to scroll content up
                endY = Math.min(dm.heightPixels, startY + distance);
            } else if ("stroll_right".equals(action)) {
                // Drag left to scroll content right
                endX = Math.max(0, startX - distance);
            } else if ("stroll_left".equals(action)) {
                // Drag right to scroll content left
                endX = Math.min(dm.widthPixels, startX + distance);
            }

            service.dispatchScroll(startX, startY, endX, endY, scrollDurationMs, new SystemActionService.ActionCallback() {
                @Override
                public void onSuccess() {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("action", action);
                    call.resolve(ret);
                }

                @Override
                public void onError(String message) {
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("error", message);
                    call.resolve(ret);
                }
            });
        } else {
            // Drag gesture between (x1, y1) and (x2, y2)
            service.dispatchScroll(realX1, realY1, realX2, realY2, scrollDurationMs, new SystemActionService.ActionCallback() {
                @Override
                public void onSuccess() {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("action", action);
                    call.resolve(ret);
                }

                @Override
                public void onError(String message) {
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("error", message);
                    call.resolve(ret);
                }
            });
        }
    }

    @PluginMethod
    public void captureSystemScreen(PluginCall call) {
        SystemActionService service = SystemActionService.getInstance();
        if (service == null) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", "Accessibility service not running");
            call.resolve(ret);
            return;
        }

        service.takeSystemScreenshot(new SystemActionService.ScreenshotCallback() {
            @Override
            public void onSuccess(String base64, String mimeType) {
                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("base64", base64);
                ret.put("mimeType", mimeType);
                call.resolve(ret);
            }

            @Override
            public void onError(String message) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("error", message);
                call.resolve(ret);
            }
        });
    }
}
