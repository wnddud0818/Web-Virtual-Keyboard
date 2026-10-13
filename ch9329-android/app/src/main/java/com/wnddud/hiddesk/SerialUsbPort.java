package com.wnddud.hiddesk;

import android.hardware.usb.*;
import com.hoho.android.usbserial.driver.*;
import java.io.IOException;
import java.util.Arrays;

/** Keeps the CH340 adapter and adds verified USB-serial drivers for other cables. */
public final class SerialUsbPort {
    private final UsbManager manager;
    private final UsbDevice device;
    private final Ch340Port ch340;
    private UsbSerialPort serial;
    private volatile boolean closed = true;
    private int address;
    private boolean keyboardUsed, mouseUsed;
    public SerialUsbPort(UsbManager manager, UsbDevice device) {
        this.manager = manager; this.device = device;
        ch340 = Ch340Port.supports(device) ? new Ch340Port(manager, device) : null;
    }
    public static UsbSerialDriver driver(UsbDevice device) {
        return UsbSerialProber.getDefaultProber().probeDevice(device);
    }
    public static boolean supports(UsbDevice device) {
        if (Ch340Port.supports(device)) return true;
        UsbSerialDriver match = driver(device);
        return match != null && !match.getPorts().isEmpty();
    }
    public static String driverName(UsbDevice device) {
        if (Ch340Port.supports(device)) return "CH340 / CH341";
        UsbSerialDriver driver = driver(device);
        return driver == null ? "시리얼 연결 미지원" : driver.getClass().getSimpleName().replace("SerialDriver", "");
    }
    public static boolean isHid(UsbDevice device) {
        if (device.getDeviceClass() == UsbConstants.USB_CLASS_HID) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) if (device.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_HID) return true;
        return false;
    }
    public String deviceName() { return device.getDeviceName(); }
    public boolean isClosed() { return ch340 != null ? ch340.isClosed() : closed; }
    public void open(int baud) throws IOException {
        if (ch340 != null) { ch340.open(baud); return; }
        if (!manager.hasPermission(device)) throw new IOException("USB 사용 권한이 없습니다. 상단 USB 확인 / 권한을 누르세요.");
        UsbSerialDriver driver = driver(device);
        if (driver == null || driver.getPorts().isEmpty()) throw new IOException("지원하는 USB 시리얼 포트가 아닙니다.");
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) throw new IOException("USB 장치를 열지 못했습니다. 권한과 다른 앱의 장치 사용 여부를 확인하세요.");
        serial = driver.getPorts().get(0);
        try {
            serial.open(connection);
            serial.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
            try { serial.setDTR(true); } catch (UnsupportedOperationException ignored) {}
            try { serial.setRTS(true); } catch (UnsupportedOperationException ignored) {}
            closed = false;
        } catch (IOException | RuntimeException error) {
            try { serial.close(); } catch (Exception ignored) {}
            try { connection.close(); } catch (Exception ignored) {}
            throw error;
        }
    }
    public byte[] read() throws IOException {
        if (ch340 != null) return ch340.read();
        byte[] bytes = new byte[4096];
        while (!closed) {
            try {
                int count = serial.read(bytes, 250);
                if (count > 0) return Arrays.copyOf(bytes, count);
            } catch (IOException error) { if (!closed) throw error; }
            if (!closed && !manager.getDeviceList().containsKey(deviceName())) throw new IOException("USB 케이블이 분리되었습니다.");
        }
        return null;
    }
    public synchronized void write(byte[] bytes) throws IOException {
        if (ch340 != null) { ch340.write(bytes); return; }
        if (closed) throw new IOException("USB 연결이 종료되었습니다. 다시 연결하세요.");
        serial.write(bytes, 1000);
        if (bytes.length >= 6 && bytes[0] == 0x57 && bytes[1] == (byte) 0xab) {
            address = bytes[2] & 255;
            if (bytes[3] == 2) keyboardUsed = true;
            if (bytes[3] == 4 || bytes[3] == 5) mouseUsed = true;
        }
    }
    public synchronized void close(boolean releaseInputs) {
        if (ch340 != null) { ch340.close(releaseInputs); return; }
        if (closed) return;
        if (releaseInputs) {
            try { if (keyboardUsed) write(Ch340Math.releasePacket(address, false)); } catch (Exception ignored) {}
            try { if (mouseUsed) write(Ch340Math.releasePacket(address, true)); } catch (Exception ignored) {}
        }
        closed = true;
        try { serial.close(); } catch (Exception ignored) {}
    }
}
