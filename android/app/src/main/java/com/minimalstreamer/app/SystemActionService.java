package com.minimalstreamer.app;

import android.accessibilityservice.AccessibilityButtonController;
import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
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

    private AccessibilityButtonController.AccessibilityButtonCallback accessibilityButtonCallback;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instanceRef = new WeakReference<>(this);

        // Register accessibility button callback (navigation bar icon) to open the app from anywhere
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                AccessibilityButtonController controller = getAccessibilityButtonController();
                if (controller != null) {
                    accessibilityButtonCallback = new AccessibilityButtonController.AccessibilityButtonCallback() {
                        @Override
                        public void onClicked(AccessibilityButtonController controller) {
                            Log.i(TAG, "[AccessibilityButton] Tapped -> Bringing Minimal Streamer to front");
                            bringAppToFront();
                        }
                    };
                    controller.registerAccessibilityButtonCallback(accessibilityButtonCallback);
                    Log.i(TAG, "Accessibility button callback registered successfully.");
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed registering accessibility button callback", e);
            }
        }

        Log.i(TAG, "SystemActionService connected and ready for OS gestures & shortcuts.");
    }

    /**
     * Bring MainActivity instantly to the foreground from any other app or home screen
     */
    public void bringAppToFront() {
        try {
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to bring MainActivity to front", e);
        }
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && accessibilityButtonCallback != null) {
            try {
                getAccessibilityButtonController().unregisterAccessibilityButtonCallback(accessibilityButtonCallback);
            } catch (Exception ignored) {}
            accessibilityButtonCallback = null;
        }
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
     * Launch an intent action directly (YouTube, Zalo, Phone Call, Web Search, App)
     */
    public void launchIntentAction(String target, String query, String phoneNumber, String url, String packageName, final ActionCallback callback) {
        try {
            Context ctx = getApplicationContext();
            String t = target != null ? target.toLowerCase().trim() : "";
            android.content.Intent intent = null;

            if ("youtube".equals(t)) {
                if (query != null && !query.trim().isEmpty()) {
                    intent = new android.content.Intent(android.content.Intent.ACTION_SEARCH);
                    intent.setPackage("com.google.android.youtube");
                    intent.putExtra("query", query.trim());
                    intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                } else {
                    intent = ctx.getPackageManager().getLaunchIntentForPackage("com.google.android.youtube");
                }
                if (intent == null && query != null && !query.trim().isEmpty()) {
                    // Fallback to web search on youtube
                    intent = new android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse("https://www.youtube.com/results?search_query=" + android.net.Uri.encode(query.trim())));
                    intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                }
            } else if ("zalo".equals(t)) {
                if (phoneNumber != null && !phoneNumber.trim().isEmpty()) {
                    String cleanPhone = phoneNumber.replaceAll("[^0-9+]", "");
                    intent = new android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse("https://zalo.me/" + cleanPhone));
                    intent.setPackage("com.zing.zalo");
                    intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                }
                if (intent == null || ctx.getPackageManager().resolveActivity(intent, 0) == null) {
                    intent = ctx.getPackageManager().getLaunchIntentForPackage("com.zing.zalo");
                }
            } else if ("phone_call".equals(t) || "call".equals(t)) {
                String cleanPhone = (phoneNumber != null ? phoneNumber : (query != null ? query : "")).replaceAll("[^0-9+*#]", "");
                intent = new android.content.Intent(android.content.Intent.ACTION_DIAL,
                        android.net.Uri.parse("tel:" + cleanPhone));
                intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            } else if ("web_search".equals(t) || "search".equals(t)) {
                String q = query != null ? query.trim() : "";
                intent = new android.content.Intent(android.content.Intent.ACTION_WEB_SEARCH);
                intent.putExtra(android.app.SearchManager.QUERY, q);
                intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            } else if ("browser".equals(t) || "url".equals(t)) {
                String targetUrl = url != null ? url.trim() : (query != null ? query.trim() : "https://google.com");
                if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
                    targetUrl = "https://" + targetUrl;
                }
                intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(targetUrl));
                intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            } else if ("app".equals(t)) {
                String pkg = packageName != null && !packageName.trim().isEmpty() ? packageName.trim() : null;
                if (pkg == null && query != null && !query.trim().isEmpty()) {
                    String qLower = query.toLowerCase().trim();
                    if (qLower.contains("zalo")) pkg = "com.zing.zalo";
                    else if (qLower.contains("youtube")) pkg = "com.google.android.youtube";
                    else if (qLower.contains("spotify")) pkg = "com.spotify.music";
                    else if (qLower.contains("chrome")) pkg = "com.android.chrome";
                    else if (qLower.contains("map")) pkg = "com.google.android.apps.maps";
                    else if (qLower.contains("camera")) pkg = "com.android.camera";
                    else if (qLower.contains("facebook")) pkg = "com.facebook.katana";
                    else if (qLower.contains("tiktok")) pkg = "com.zhiliaoapp.musically";
                }
                if (pkg != null) {
                    intent = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
                }
            }

            if (intent != null) {
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
                Log.i(TAG, "Launched intent for target: " + target);
                if (callback != null) callback.onSuccess();
            } else {
                if (callback != null) callback.onError("Could not create intent for target: " + target);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed launching intent for target: " + target, e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }

    public interface ElementActionResultCallback {
        void onSuccess(String resultMessage);
        void onError(String message);
    }

    /**
     * Interact with UI elements semantically (click by text/desc, type into element, read screen)
     */
    public void performElementAction(String action, String targetText, String textToType, boolean pressEnter, final ElementActionResultCallback callback) {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) {
                if (callback != null) callback.onError("Active window not accessible");
                return;
            }

            String act = action != null ? action.toLowerCase().trim() : "click";

            if ("read_screen".equals(act)) {
                StringBuilder sb = new StringBuilder();
                collectAllText(root, sb, 0);
                String result = sb.toString().trim();
                if (callback != null) callback.onSuccess(result.isEmpty() ? "(No readable text on current screen)" : result);
                return;
            }

            if (targetText == null || targetText.trim().isEmpty()) {
                if (callback != null) callback.onError("target_text is required for action: " + act);
                return;
            }

            AccessibilityNodeInfo targetNode = findNodeByTextOrDesc(root, targetText.trim());

            if (targetNode == null) {
                if (callback != null) callback.onError("Could not find element matching text/desc: \"" + targetText + "\"");
                return;
            }

            if ("click".equals(act)) {
                // Find nearest clickable ancestor or self
                AccessibilityNodeInfo clickable = findClickableAncestorOrSelf(targetNode);
                boolean clicked = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                if (!clicked) {
                    // Try click on target node directly
                    clicked = targetNode.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                }
                if (clicked) {
                    if (callback != null) callback.onSuccess("Successfully clicked element: \"" + targetText + "\"");
                } else {
                    if (callback != null) callback.onError("Failed to execute click action on: \"" + targetText + "\"");
                }
            } else if ("type".equals(act)) {
                AccessibilityNodeInfo editable = targetNode.isEditable() ? targetNode : findEditableNode(targetNode);
                if (editable == null) {
                    editable = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                }
                if (editable == null) {
                    editable = findEditableNode(root);
                }

                String text = textToType != null ? textToType : "";
                boolean typed = false;
                if (editable != null) {
                    Bundle args = new Bundle();
                    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                    typed = editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                    if (!typed) {
                        copyToClipboard(text);
                        typed = editable.performAction(AccessibilityNodeInfo.ACTION_PASTE);
                    }
                    if (pressEnter) {
                        editable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    }
                }

                if (!typed) {
                    copyToClipboard(text);
                }

                if (callback != null) callback.onSuccess("Typed text into element: \"" + targetText + "\"");
            } else {
                if (callback != null) callback.onError("Unsupported element action: " + act);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in performElementAction", e);
            if (callback != null) callback.onError(e.getMessage());
        }
    }

    private AccessibilityNodeInfo findNodeByTextOrDesc(AccessibilityNodeInfo root, String query) {
        if (root == null || query == null) return null;
        String q = query.toLowerCase();

        CharSequence text = root.getText();
        if (text != null && text.toString().toLowerCase().contains(q)) {
            return root;
        }

        CharSequence desc = root.getContentDescription();
        if (desc != null && desc.toString().toLowerCase().contains(q)) {
            return root;
        }

        int count = root.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = root.getChild(i);
            if (child != null) {
                AccessibilityNodeInfo match = findNodeByTextOrDesc(child, query);
                if (match != null) return match;
            }
        }
        return null;
    }

    private AccessibilityNodeInfo findClickableAncestorOrSelf(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        while (current != null) {
            if (current.isClickable()) {
                return current;
            }
            current = current.getParent();
        }
        return node;
    }

    private void collectAllText(AccessibilityNodeInfo node, StringBuilder sb, int depth) {
        if (node == null || depth > 30) return;

        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();

        if (text != null && !text.toString().trim().isEmpty()) {
            sb.append(text.toString().trim()).append("\n");
        } else if (desc != null && !desc.toString().trim().isEmpty()) {
            sb.append("[").append(desc.toString().trim()).append("]\n");
        }

        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                collectAllText(child, sb, depth + 1);
            }
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
