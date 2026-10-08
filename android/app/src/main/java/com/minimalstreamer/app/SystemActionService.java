package com.minimalstreamer.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.graphics.Path;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.annotation.NonNull;

import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;

public class SystemActionService extends AccessibilityService {
    private static final String TAG = "SystemActionService";
    private static WeakReference<SystemActionService> instanceRef;

    public interface ActionCallback {
        void onSuccess();
        void onError(String message);
    }

    public interface ScreenshotCallback {
        void onSuccess(String base64, String mimeType);
        void onError(String message);
    }

    public static boolean isServiceRunning() {
        return instanceRef != null && instanceRef.get() != null;
    }

    public static SystemActionService getInstance() {
        return instanceRef != null ? instanceRef.get() : null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instanceRef = new WeakReference<>(this);
        Log.i(TAG, "SystemActionService connected and ready for OS gestures.");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // No-op: service is used for dispatching actions and screenshots
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "SystemActionService interrupted.");
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instanceRef != null && instanceRef.get() == this) {
            instanceRef = null;
        }
        Log.i(TAG, "SystemActionService destroyed.");
    }

    /**
     * Dispatch an OS-level tap/click gesture at the specified screen coordinates
     */
    public void dispatchClick(float x, float y, long durationMs, final ActionCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            if (callback != null) callback.onError("Gestures require Android 7.0 (API 24) or higher");
            return;
        }

        try {
            Path path = new Path();
            path.moveTo(x, y);

            long strokeDuration = Math.max(50, Math.min(300, durationMs > 0 ? durationMs : 100));
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, strokeDuration);

            GestureDescription.Builder builder = new GestureDescription.Builder();
            builder.addStroke(stroke);

            boolean dispatched = dispatchGesture(builder.build(), new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    Log.d(TAG, "Click gesture completed at (" + x + ", " + y + ")");
                    if (callback != null) callback.onSuccess();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    Log.w(TAG, "Click gesture cancelled at (" + x + ", " + y + ")");
                    if (callback != null) callback.onError("Gesture was cancelled by system");
                }
            }, null);

            if (!dispatched && callback != null) {
                callback.onError("Failed to dispatch gesture via AccessibilityService");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error dispatching click gesture", e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }

    /**
     * Dispatch an OS-level scroll/stroll gesture from (startX, startY) to (endX, endY)
     */
    public void dispatchScroll(float startX, float startY, float endX, float endY, long durationMs, final ActionCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            if (callback != null) callback.onError("Gestures require Android 7.0 (API 24) or higher");
            return;
        }

        try {
            Path path = new Path();
            path.moveTo(startX, startY);
            path.lineTo(endX, endY);

            long strokeDuration = Math.max(100, Math.min(1200, durationMs > 0 ? durationMs : 400));
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, strokeDuration);

            GestureDescription.Builder builder = new GestureDescription.Builder();
            builder.addStroke(stroke);

            boolean dispatched = dispatchGesture(builder.build(), new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    Log.d(TAG, "Scroll gesture completed from (" + startX + "," + startY + ") to (" + endX + "," + endY + ")");
                    if (callback != null) callback.onSuccess();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    Log.w(TAG, "Scroll gesture cancelled");
                    if (callback != null) callback.onError("Scroll gesture was cancelled by system");
                }
            }, null);

            if (!dispatched && callback != null) {
                callback.onError("Failed to dispatch scroll gesture via AccessibilityService");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error dispatching scroll gesture", e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }

    /**
     * Type text into whatever input currently has focus on the system
     */
    public void typeText(String text, boolean pressEnter, final ActionCallback callback) {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            AccessibilityNodeInfo target = null;
            if (root != null) {
                target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (target == null) {
                    target = findEditableNode(root);
                }
            }

            boolean setTextSuccess = false;
            if (target != null) {
                Bundle args = new Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                setTextSuccess = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);

                if (!setTextSuccess) {
                    // Try clipboard paste
                    copyToClipboard(text);
                    setTextSuccess = target.performAction(AccessibilityNodeInfo.ACTION_PASTE);
                }

                if (pressEnter) {
                    target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                }
            }

            if (!setTextSuccess) {
                // System-wide clipboard fallback
                copyToClipboard(text);
            }

            if (callback != null) callback.onSuccess();
        } catch (Exception e) {
            Log.e(TAG, "Error typing text", e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }

    /**
     * Performs system-level hardware button actions (Home, Back, Recents)
     */
    public void performSystemNavigation(String action, final ActionCallback callback) {
        try {
            int globalAction = -1;
            if ("home_click".equalsIgnoreCase(action) || "home".equalsIgnoreCase(action)) {
                globalAction = GLOBAL_ACTION_HOME;
            } else if ("previous".equalsIgnoreCase(action) || "back".equalsIgnoreCase(action)) {
                globalAction = GLOBAL_ACTION_BACK;
            } else if ("tab".equalsIgnoreCase(action) || "recents".equalsIgnoreCase(action)) {
                globalAction = GLOBAL_ACTION_RECENTS;
            }

            if (globalAction == -1) {
                if (callback != null) callback.onError("Unknown system navigation action: " + action);
                return;
            }

            boolean success = performGlobalAction(globalAction);
            Log.i(TAG, "performGlobalAction " + action + " result: " + success);
            if (success) {
                if (callback != null) callback.onSuccess();
            } else {
                if (callback != null) callback.onError("System action failed to execute: " + action);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error executing system navigation action", e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }

    private AccessibilityNodeInfo findEditableNode(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() || (node.getClassName() != null && node.getClassName().toString().contains("EditText"))) {
            return node;
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findEditableNode(child);
            if (found != null) return found;
        }
        return null;
    }

    private void copyToClipboard(String text) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null) {
                ClipData clip = ClipData.newPlainText("AI Input", text);
                clipboard.setPrimaryClip(clip);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to copy to clipboard", e);
        }
    }

    /**
     * Capture full-screen system screenshot on Android 11+ (API 30+)
     */
    public void takeSystemScreenshot(final ScreenshotCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            if (callback != null) callback.onError("Accessibility screenshot requires Android 11+ (API 30+)");
            return;
        }

        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getApplicationContext().getMainExecutor(), new TakeScreenshotCallback() {
                @Override
                public void onSuccess(@NonNull ScreenshotResult screenshotResult) {
                    try {
                        HardwareBuffer hardwareBuffer = screenshotResult.getHardwareBuffer();
                        ColorSpace colorSpace = screenshotResult.getColorSpace();
                        Bitmap hwBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, colorSpace);
                        hardwareBuffer.close();

                        if (hwBitmap != null) {
                            // Hardware bitmaps cannot be compressed directly into WebP/JPEG, convert to software ARGB_8888
                            Bitmap softwareBitmap = hwBitmap.copy(Bitmap.Config.ARGB_8888, false);
                            hwBitmap.recycle();

                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            softwareBitmap.compress(Bitmap.CompressFormat.WEBP_LOSSY, 85, baos);
                            byte[] bytes = baos.toByteArray();
                            softwareBitmap.recycle();

                            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                            if (callback != null) callback.onSuccess(base64, "image/webp");
                            return;
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Failed processing hardware screenshot bitmap", e);
                        if (callback != null) callback.onError(e.getMessage());
                        return;
                    }
                    if (callback != null) callback.onError("Failed to convert hardware screenshot buffer");
                }

                @Override
                public void onFailure(int errorCode) {
                    Log.e(TAG, "takeScreenshot failed, code: " + errorCode);
                    if (callback != null) callback.onError("Screenshot failed with error code: " + errorCode);
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error calling takeScreenshot", e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }
}
