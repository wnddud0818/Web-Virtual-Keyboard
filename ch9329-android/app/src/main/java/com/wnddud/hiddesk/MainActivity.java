package com.wnddud.hiddesk;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.hardware.usb.*;
import android.net.Uri;
import android.os.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.lang.ref.WeakReference;

/** Offline WebView UI with an asynchronous, session-scoped native USB bridge. */
public final class MainActivity extends Activity {
    private static WeakReference<MainActivity> live = new WeakReference<>(null);
    private static final String HOST = "appassets.androidplatform.net";
    private static final String PAGE = "https://" + HOST + "/assets/web/index.html";
    private static final String PERMISSION = "com.wnddud.hiddesk.USB_PERMISSION";
    private static final int PICK_FILE = 10, SAVE_FILE = 11;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService reads = Executors.newSingleThreadExecutor();
    private WebView web;
    private UsbManager usb;
    private volatile SerialUsbPort port;
    private volatile int session;
    private static final class BatchRequest {
        final String token;
        final int session;
        final KeyboardBatch engine;
        BatchRequest(String token, int session, KeyboardBatch engine) { this.token = token; this.session = session; this.engine = engine; }
    }
    private volatile BatchRequest keyboardBatch;
    private int nextSession;
    private ValueCallback<Uri[]> fileCallback;
    private String permissionId, permissionDevice;
    private AlertDialog chooser;
    private String saveId;
    private byte[] saveBytes;
    private volatile boolean destroyed;
    private volatile boolean visible;
    private boolean receiverRegistered;
    private TextView usbStatus;
    private long permissionStarted;
    private String lastWebError = "";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        live = new WeakReference<>(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 35) {
            // Target 35 edge-to-edge: inset the entire web surface around system bars.
            getWindow().getDecorView().setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }
        usb = (UsbManager) getSystemService(USB_SERVICE);
        web = new WebView(this);
        LinearLayout screen = new LinearLayout(this);
        screen.setOrientation(LinearLayout.VERTICAL);
        screen.setBackgroundColor(0xfff7f8fa);
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(4), dp(12), dp(4));
        usbStatus = new TextView(this);
        usbStatus.setTextSize(12);
        usbStatus.setTextColor(0xff354052);
        toolbar.addView(usbStatus, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button inspect = new Button(this);
        inspect.setText("USB 확인 / 권한");
        inspect.setTextSize(12);
        inspect.setAllCaps(false);
        inspect.setOnClickListener(v -> showUsbStatus());
        toolbar.addView(inspect, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        screen.addView(toolbar);
        screen.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(screen);
        refreshUsbStatus();
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setBlockNetworkLoads(true);
        web.addJavascriptInterface(new Bridge(), "HidNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String path = url.getPath();
                if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost()) || path == null || !path.startsWith("/assets/web/") || path.contains(".."))
                    return response(403, "Forbidden", "text/plain", "차단된 요청입니다.");
                try {
                    String asset = path.substring("/assets/".length());
                    String mime = asset.endsWith(".html") ? "text/html" : asset.endsWith(".js") ? "application/javascript" : asset.endsWith(".css") ? "text/css" : "text/plain";
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-store");
                    headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'");
                    return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, getAssets().open(asset));
                } catch (IOException e) { return response(404, "Not Found", "text/plain", "앱 파일을 찾지 못했습니다."); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Native bridge stays available only to our packaged controller.
                return !PAGE.equals(request.getUrl().toString());
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                SerialUsbPort current = port;
                io.execute(() -> { if (current != null) current.close(true); if (port == current) port = null; });
                toast("앱 화면이 종료되었습니다. 앱을 다시 실행하세요.");
                finish();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    lastWebError = message.message() + " (" + message.lineNumber() + ")";
                }
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                String[] accepts = params.getAcceptTypes();
                intent.setType(accepts.length == 1 && accepts[0].contains("/") && !accepts[0].contains(",") ? accepts[0] : "*/*");
                try { startActivityForResult(intent, PICK_FILE); }
                catch (ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; toast("파일 선택 앱이 없습니다."); }
                return true;
            }
        });
        web.setDownloadListener((url, ua, content, mime, size) -> toast("앱의 저장 버튼을 사용하세요."));
        IntentFilter filter = new IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(receiver, filter);
        receiverRegistered = true;
        web.loadUrl(PAGE);
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_USB_HOST)) toast("이 기기는 USB OTG를 지원하지 않습니다.");
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private List<UsbDevice> allUsbDevices() {
        List<UsbDevice> devices = new ArrayList<>(usb.getDeviceList().values());
        devices.sort(Comparator.comparing(UsbDevice::getDeviceName));
        return devices;
    }
    private List<UsbDevice> serialDevices() {
        List<UsbDevice> supported = new ArrayList<>();
        for (UsbDevice device : allUsbDevices()) if (SerialUsbPort.supports(device)) supported.add(device);
        return supported;
    }
    private void refreshUsbStatus() {
        if (destroyed || usbStatus == null) return;
        List<UsbDevice> all = allUsbDevices(), eligible = new ArrayList<>();
        for (UsbDevice device : all) if (SerialUsbPort.supports(device)) eligible.add(device);
        String text = all.isEmpty() ? "USB 감지 0개" : "USB " + all.size() + "개 · 연결 지원 " + eligible.size() + "개";
        if (permissionId != null) text += "\nUSB 권한 요청 중";
        else if (eligible.stream().anyMatch(usb::hasPermission)) text += "\nUSB 권한 허용됨";
        if (!text.contentEquals(usbStatus.getText())) usbStatus.setText(text);
    }
    private String usbReport() {
        List<UsbDevice> all = allUsbDevices();
        StringBuilder text = new StringBuilder("HID Desk 1.0.3\nAndroid " + Build.VERSION.RELEASE + "\n");
        android.content.pm.PackageInfo webview = WebView.getCurrentWebViewPackage();
        if (webview != null) text.append("WebView ").append(webview.versionName).append("\n");
        text.append("USB 호스트 지원: ").append(getPackageManager().hasSystemFeature(PackageManager.FEATURE_USB_HOST) ? "예" : "아니오");
        text.append("\nUSB 감지: ").append(all.size()).append("개\n\n");
        if (all.isEmpty()) {
            text.append("안드로이드가 USB 장치를 감지하지 못했습니다. 이 상태에서는 USB 권한창을 띄울 장치가 없습니다.\n\nCH340(제어) 쪽 USB가 휴대폰의 OTG 젠더에 연결됐는지 확인하고, 케이블·젠더를 다시 연결하세요. USB 허브나 충전 전용 케이블을 쓰고 있다면 데이터 연결을 확인하세요.");
        }
        for (UsbDevice device : all) {
            String name = device.getProductName();
            text.append(name == null || name.isEmpty() ? "USB 장치" : name).append("\n");
            text.append(String.format(Locale.US, "VID:PID %04X:%04X", device.getVendorId(), device.getProductId()));
            text.append("\n").append(device.getDeviceName()).append("\n");
            boolean supported = SerialUsbPort.supports(device);
            text.append("연결 방식: ").append(SerialUsbPort.driverName(device));
            text.append("\nUSB 권한: ").append(usb.hasPermission(device) ? "허용됨" : "요청 전 / 미허용");
            if (!supported && SerialUsbPort.isHid(device)) text.append("\n키보드/마우스(HID) 쪽이 감지되었습니다. CH9329 쪽을 휴대폰에 연결했을 수 있습니다. 반대쪽 CH340 USB를 휴대폰에 연결하세요.");
            else if (!supported) text.append("\n이 USB 장치에 사용할 시리얼 드라이버를 찾지 못했습니다. 위 VID:PID 정보로 칩 종류를 확인할 수 있습니다.");
            text.append("\n\n");
        }
        if (!lastWebError.isEmpty()) text.append("화면 오류: ").append(lastWebError).append("\n");
        text.append("장치 설정 변경은 USB 연결과 CH9329 응답 확인 후 가능합니다. USB 권한은 안드로이드 앱 설정의 일반 권한 목록에 나타나지 않을 수 있습니다.");
        return text.toString();
    }
    private void showUsbStatus() {
        refreshUsbStatus();
        String report = usbReport();
        TextView text = new TextView(this);
        text.setText(report); text.setTextIsSelectable(true); text.setTextSize(14);
        text.setPadding(dp(20), dp(12), dp(20), dp(12));
        ScrollView scroll = new ScrollView(this); scroll.addView(text);
        AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle("USB 확인 / 권한").setView(scroll)
            .setNegativeButton("닫기", null).setNeutralButton("정보 복사", (d, which) -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("HID Desk USB 상태", report)); toast("USB 상태를 복사했습니다.");
            });
        if (!serialDevices().isEmpty()) dialog.setPositiveButton("USB 권한 요청", (d, which) -> {
            if (permissionId != null && SystemClock.elapsedRealtime() - permissionStarted > 30000) {
                String old = permissionId; permissionId = null; permissionDevice = null;
                result(old, null, "이전 USB 권한 요청을 정리했습니다. 다시 요청합니다.");
            }
            selectDevice("native:permission");
        });
        dialog.show();
    }
    private WebResourceResponse response(int status, String reason, String mime, String text) {
        return new WebResourceResponse(mime, "UTF-8", status, reason, Collections.emptyMap(), new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }
    private void toast(String text) { main.post(() -> { if (!destroyed) Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }); }
    private JSONObject object(String key, Object value) throws JSONException { return new JSONObject().put(key, value); }
    private void result(String id, Object value, String error) {
        if (destroyed) return;
        if (id.startsWith("native:")) { toast(error == null ? "USB 권한이 허용됐습니다. 화면의 케이블 연결을 누르세요." : error); return; }
        try {
            JSONObject reply = new JSONObject().put("id", id).put("value", value == null ? JSONObject.NULL : value);
            if (error != null) reply.put("error", error);
            String script = "window.AndroidHid&&window.AndroidHid.receive(" + reply + ");";
            main.post(() -> { if (!destroyed) web.evaluateJavascript(script, null); });
        } catch (JSONException ignored) {}
    }
    private SerialUsbPort forSession(JSONObject args) throws IOException {
        SerialUsbPort current = port;
        if (current == null || current.isClosed() || args.optInt("session", -1) != session) throw new IOException("USB 연결이 종료되었습니다. 다시 연결해 주세요.");
        return current;
    }
    private void cancelKeyboardBatch() {
        BatchRequest request = keyboardBatch;
        if (request != null) request.engine.cancel();
    }
    private void startKeyboardBatch(String id, JSONObject args) {
        final BatchRequest request;
        final SerialUsbPort current;
        try {
            synchronized (this) {
                current = forSession(args);
                if (!visible || keyboardBatch != null) throw new IOException("키 입력 작업을 시작할 수 없습니다.");
                request = new BatchRequest(args.getString("token"), session,
                    new KeyboardBatch(Base64.decode(args.getString("data"), Base64.DEFAULT), args.getInt("address")));
                // Register before queueing so Stop also cancels a job that has not started.
                keyboardBatch = request;
            }
        } catch (Exception error) { result(id, null, error.getMessage()); return; }
        io.execute(() -> {
            Object value = null; String error = null;
            try {
                int completed = request.engine.run(current::write);
                value = object("completed", completed).put("cancelled", request.engine.isCancelled());
            } catch (Exception failure) {
                error = failure.getMessage() == null ? "키 입력 통신 오류입니다." : failure.getMessage();
                try { value = object("completed", request.engine.completedCount()); } catch (JSONException ignored) {}
                current.close(true); if (port == current) port = null;
                main.post(this::refreshUsbStatus);
            } finally {
                if (keyboardBatch == request) keyboardBatch = null;
            }
            result(id, value, error);
        });
    }
    public final class Bridge {
        @JavascriptInterface public void postMessage(String message) {
            if (destroyed || message == null || message.length() > 2000000) return;
            final String id, method;
            final JSONObject args;
            try {
                JSONObject request = new JSONObject(message);
                id = request.getString("id"); method = request.getString("method");
                args = request.optJSONObject("args") == null ? new JSONObject() : request.getJSONObject("args");
                if (id.length() > 80) return;
            } catch (JSONException e) { return; }
            if ("select".equals(method)) { main.post(() -> selectDevice(id)); return; }
            if ("save".equals(method)) { main.post(() -> saveFile(id, args)); return; }
            if ("keyboardBatch".equals(method)) { startKeyboardBatch(id, args); return; }
            if ("cancelBatch".equals(method)) {
                BatchRequest request = keyboardBatch;
                if (request != null && args.optInt("session", -1) == request.session && request.token.equals(args.optString("token"))) request.engine.cancel();
                result(id, true, null); return;
            }
            ExecutorService executor = "read".equals(method) ? reads : io;
            executor.execute(() -> {
                try {
                    Object value;
                    switch (method) {
                        case "open": {
                            if (!visible) throw new IOException("앱 화면을 연 뒤 다시 연결하세요.");
                            UsbDevice device = usb.getDeviceList().get(args.getString("device"));
                            if (device == null || !SerialUsbPort.supports(device)) throw new IOException("USB 시리얼 장치를 찾지 못했습니다. 상단 USB 확인 / 권한을 누르세요.");
                            if (port != null && !port.isClosed()) throw new IOException("기존 USB 연결을 먼저 닫아 주세요.");
                            SerialUsbPort fresh = new SerialUsbPort(usb, device);
                            fresh.open(args.getInt("baud"));
                            if (!visible || destroyed) { fresh.close(false); throw new IOException("앱이 백그라운드로 이동했습니다. 다시 연결하세요."); }
                            session = ++nextSession; port = fresh;
                            main.post(MainActivity.this::refreshUsbStatus);
                            value = object("session", session); break;
                        }
                        case "read": {
                            if (args.optInt("session", -1) != session || port == null || port.isClosed()) value = object("done", true);
                            else {
                                for (;;) {
                                    byte[] bytes = forSession(args).read();
                                    BatchRequest request = keyboardBatch;
                                    if (bytes != null && request != null && request.session == args.optInt("session", -1)) {
                                        request.engine.receive(bytes); continue;
                                    }
                                    value = bytes == null ? object("done", true) : object("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                                    break;
                                }
                            }
                            break;
                        }
                        case "write": {
                            if (keyboardBatch != null) throw new IOException("키 입력 묶음이 진행 중입니다.");
                            byte[] bytes = Base64.decode(args.getString("data"), Base64.DEFAULT);
                            if (bytes.length == 0 || bytes.length > 4096) throw new IOException("USB 패킷 크기를 확인하세요.");
                            forSession(args).write(bytes); value = true; break;
                        }
                        case "close": {
                            if (args.optInt("session", -1) == session && port != null) { port.close(false); port = null; }
                            main.post(MainActivity.this::refreshUsbStatus);
                            value = true; break;
                        }
                        default: throw new IOException("지원하지 않는 앱 명령입니다.");
                    }
                    result(id, value, null);
                } catch (Exception error) {
                    BatchRequest request = keyboardBatch;
                    if (request != null && request.session == args.optInt("session", -1)) request.engine.fail(new IOException("USB 읽기가 중단되었습니다.", error));
                    // A serial timeout/error never repeats a keystroke.
                    if (("write".equals(method) || "read".equals(method)) && args.optInt("session", -1) == session && port != null) { port.close(true); port = null; }
                    main.post(MainActivity.this::refreshUsbStatus);
                    result(id, null, error.getMessage() == null ? "USB 통신 오류입니다." : error.getMessage());
                }
            });
        }
    }
    private void selectDevice(String id) {
        if (destroyed) return;
        if (permissionId != null || chooser != null) { result(id, null, "장치 선택이 이미 진행 중입니다."); return; }
        List<UsbDevice> devices = serialDevices();
        if (devices.isEmpty()) {
            List<UsbDevice> all = allUsbDevices();
            boolean hid = all.stream().anyMatch(SerialUsbPort::isHid);
            String message = all.isEmpty() ? "USB 감지 0개: 안드로이드가 USB 장치를 인식하지 못했습니다. CH340 쪽과 OTG 연결을 확인하세요."
                : hid ? "키보드/마우스(HID) 쪽이 감지됐습니다. CH9329 쪽이 아닌 반대쪽 CH340 USB를 갤럭시에 연결하세요."
                : "USB는 감지됐지만 지원하는 시리얼 칩을 찾지 못했습니다.";
            result(id, null, message + " 상단 USB 확인 / 권한에서 전체 장치와 VID:PID를 확인할 수 있습니다."); return;
        }
        if (devices.size() == 1) { requestPermission(id, devices.get(0)); return; }
        String[] labels = new String[devices.size()];
        for (int i = 0; i < labels.length; i++) labels[i] = SerialUsbPort.driverName(devices.get(i)) + " · " + devices.get(i).getDeviceName();
        chooser = new AlertDialog.Builder(this).setTitle("연결할 USB 시리얼 선택").setItems(labels, (dialog, which) -> {
            chooser = null; requestPermission(id, devices.get(which));
        }).setNegativeButton("취소", (dialog, which) -> { chooser = null; result(id, null, "장치 선택을 취소했습니다."); })
            .setOnCancelListener(dialog -> { chooser = null; result(id, null, "장치 선택을 취소했습니다."); }).create();
        chooser.show();
    }
    private void requestPermission(String id, UsbDevice device) {
        if (usb.hasPermission(device)) { selected(id, device); return; }
        permissionId = id; permissionDevice = device.getDeviceName();
        permissionStarted = SystemClock.elapsedRealtime(); refreshUsbStatus();
        Intent callback = new Intent(this, UsbPermissionReceiver.class).setAction(PERMISSION).putExtra("requestId", id);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent intent = PendingIntent.getBroadcast(this, device.getDeviceId(), callback, flags);
        try { usb.requestPermission(device, intent); }
        catch (Exception e) { permissionId = null; permissionDevice = null; refreshUsbStatus(); result(id, null, "USB 권한 요청에 실패했습니다."); }
    }
    private void selected(String id, UsbDevice device) {
        main.post(this::refreshUsbStatus);
        try { result(id, new JSONObject().put("device", device.getDeviceName()).put("vendorId", device.getVendorId()).put("productId", device.getProductId()).put("driver", SerialUsbPort.driverName(device)), null); }
        catch (JSONException e) { result(id, null, "장치 정보를 읽지 못했습니다."); }
    }
    public static final class UsbPermissionReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            MainActivity activity = live.get();
            if (activity != null && !activity.destroyed) activity.permissionResult(intent);
        }
    }
    private void permissionResult(Intent intent) {
            if (PERMISSION.equals(intent.getAction()) && permissionId != null && permissionId.equals(intent.getStringExtra("requestId"))) {
                String id = permissionId, name = permissionDevice;
                permissionId = null; permissionDevice = null;
                refreshUsbStatus();
                UsbDevice device = usb.getDeviceList().get(name);
                if (device != null && usb.hasPermission(device)) selected(id, device);
                else result(id, null, "USB 사용 권한이 거부되었거나 케이블이 분리되었습니다.");
            }
    }
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            refreshUsbStatus();
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                UsbDevice detached = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                SerialUsbPort current = port;
                if (current != null && detached != null && current.deviceName().equals(detached.getDeviceName())) {
                    BatchRequest request = keyboardBatch;
                    if (request != null) request.engine.fail(new IOException("USB 케이블이 분리되었습니다."));
                    io.execute(() -> { current.close(false); if (port == current) port = null; });
                    web.evaluateJavascript("window.AndroidHid&&window.AndroidHid.disconnected('USB 케이블이 분리되었습니다. 다시 연결하세요.');", null);
                }
            }
        }
    };
    private void saveFile(String id, JSONObject args) {
        if (saveId != null) { result(id, null, "다른 파일을 저장 중입니다."); return; }
        try {
            byte[] bytes = Base64.decode(args.getString("data"), Base64.DEFAULT);
            if (bytes.length > 1000000) throw new IOException("저장할 파일이 너무 큽니다.");
            String name = args.getString("name").replaceAll("[\\\\/\\x00-\\x1f]", "_");
            if (name.length() > 120) name = name.substring(0, 120);
            String mime = args.optString("mime", "application/octet-stream").split(";", 2)[0];
            saveId = id; saveBytes = bytes;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(intent, SAVE_FILE);
        } catch (Exception e) { saveId = null; saveBytes = null; result(id, null, "파일 저장 창을 열지 못했습니다."); }
    }
    @Override protected void onActivityResult(int request, int code, Intent data) {
        super.onActivityResult(request, code, data);
        if (request == PICK_FILE && fileCallback != null) {
            ValueCallback<Uri[]> callback = fileCallback; fileCallback = null;
            callback.onReceiveValue(code == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
        } else if (request == SAVE_FILE && saveId != null) {
            String id = saveId; byte[] bytes = saveBytes; saveId = null; saveBytes = null;
            if (code != RESULT_OK || data == null || data.getData() == null) { result(id, null, "파일 저장을 취소했습니다."); return; }
            Uri uri = data.getData();
            io.execute(() -> {
                try (OutputStream stream = getContentResolver().openOutputStream(uri, "wt")) {
                    if (stream == null) throw new IOException("저장할 파일을 열지 못했습니다.");
                    stream.write(bytes); result(id, true, null);
                } catch (Exception e) { result(id, null, "파일을 저장하지 못했습니다."); }
            });
        }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); refreshUsbStatus(); }
    @Override protected void onResume() {
        super.onResume(); visible = true;
        // Some system permission dialogs restore the activity before delivering their broadcast.
        if (permissionId != null) {
            UsbDevice device = usb.getDeviceList().get(permissionDevice);
            if (device != null && usb.hasPermission(device)) {
                String id = permissionId; permissionId = null; permissionDevice = null; selected(id, device);
            }
        }
        refreshUsbStatus();
    }
    @Override protected void onPause() {
        super.onPause();
        cancelKeyboardBatch();
        web.evaluateJavascript("window.AndroidHid&&window.AndroidHid.background();", null);
    }
    @Override protected void onStop() {
        super.onStop(); visible = false;
        // SAF pick/save and permission dialogs intentionally keep an idle USB session.
        if (fileCallback != null || saveId != null || permissionId != null) return;
        SerialUsbPort current = port;
        if (current != null) main.postDelayed(() -> {
            if (!visible && port == current) {
                io.execute(() -> { current.close(true); if (port == current) port = null; });
                if (!destroyed) web.evaluateJavascript("window.AndroidHid&&window.AndroidHid.disconnected('앱을 나가 USB 연결을 종료했습니다. 다시 연결하세요.');", null);
            }
        }, 400);
    }
    @Override public void onBackPressed() {
        new AlertDialog.Builder(this).setTitle("HID Desk 종료").setMessage("진행 중인 전송을 중단하고 USB 연결을 종료합니다.")
            .setPositiveButton("종료", (dialog, which) -> finish()).setNegativeButton("계속 사용", null).show();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        cancelKeyboardBatch();
        if (live.get() == this) live.clear();
        if (receiverRegistered) unregisterReceiver(receiver);
        if (chooser != null) chooser.dismiss();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        SerialUsbPort current = port;
        io.execute(() -> { if (current != null) current.close(true); port = null; });
        io.shutdown(); reads.shutdown();
        web.removeJavascriptInterface("HidNative"); web.destroy();
        super.onDestroy();
    }
}
