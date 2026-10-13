package com.wnddud.hiddesk;

import android.hardware.usb.*;
import java.io.IOException;
import java.util.Arrays;

/** User-space CH340/CH341 driver using Android USB Host, without WebUSB. */
public final class Ch340Port {
    private final UsbManager manager;
    private final UsbDevice device;
    private UsbDeviceConnection connection;
    private UsbInterface intf;
    private UsbEndpoint in, out;
    private volatile boolean closed = true;
    private int address;
    private boolean keyboardUsed, mouseUsed;
    public Ch340Port(UsbManager manager, UsbDevice device) { this.manager = manager; this.device = device; }
    public static boolean supports(UsbDevice d) {
        int v = d.getVendorId(), p = d.getProductId();
        return (v == 0x1a86 && (p == 0x7523 || p == 0x7522 || p == 0x5523))
            || (v == 0x2184 && p == 0x0057) || (v == 0x4348 && p == 0x5523) || (v == 0x9986 && p == 0x7523);
    }
    public String deviceName() { return device.getDeviceName(); }
    public boolean isClosed() { return closed; }
    public void open(int baud) throws IOException {
        if (!closed) throw new IOException("이미 연결되어 있습니다.");
        int divisor = Ch340Math.baudDivisor(baud);
        if (!manager.hasPermission(device)) throw new IOException("USB 사용 권한이 없습니다. 다시 연결해 주세요.");
        for (int i = 0; i < device.getInterfaceCount() && intf == null; i++) {
            UsbInterface candidate = device.getInterface(i);
            UsbEndpoint input = null, output = null;
            for (int j = 0; j < candidate.getEndpointCount(); j++) {
                UsbEndpoint endpoint = candidate.getEndpoint(j);
                if (endpoint.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
                if (endpoint.getDirection() == UsbConstants.USB_DIR_IN) input = endpoint; else output = endpoint;
            }
            if (input != null && output != null) { intf = candidate; in = input; out = output; }
        }
        if (intf == null) throw new IOException("CH340의 데이터 전송 통로를 찾지 못했습니다.");
        connection = manager.openDevice(device);
        if (connection == null) throw new IOException("USB 장치를 열지 못했습니다. 케이블과 USB 권한을 확인하세요.");
        closed = false;
        try {
            if (!connection.claimInterface(intf, true)) throw new IOException("다른 앱이 USB 장치를 사용 중입니다.");
            byte[] version = new byte[2];
            if (connection.controlTransfer(0xc0, 0x5f, 0, 0, version, 2, 1000) < 1) throw new IOException("CH340 버전을 읽지 못했습니다.");
            control(0xa1, 0, 0);
            int chipVersion = version[0] & 255;
            control(0x9a, 0x1312, divisor | (chipVersion > 0x27 ? 0x80 : 0));
            if (chipVersion >= 0x30) control(0x9a, 0x2518, 0xc3);
            control(0xa4, ~0x60 & 0xffff, 0);
        } catch (IOException | RuntimeException e) { close(false); throw e; }
    }
    private void control(int request, int value, int index) throws IOException {
        if (connection.controlTransfer(0x40, request, value, index, null, 0, 1000) < 0)
            throw new IOException("CH340 설정 명령이 실패했습니다 (0x" + Integer.toHexString(request) + ").");
    }
    public byte[] read() throws IOException {
        UsbDeviceConnection c = connection;
        byte[] bytes = new byte[Math.max(64, in.getMaxPacketSize())];
        while (!closed) {
            int count = c.bulkTransfer(in, bytes, bytes.length, 100);
            if (count > 0) return Arrays.copyOf(bytes, count);
            if (!closed && !manager.getDeviceList().containsKey(device.getDeviceName())) throw new IOException("USB 케이블이 분리되었습니다.");
        }
        return null;
    }
    public synchronized void write(byte[] bytes) throws IOException {
        if (closed) throw new IOException("USB 연결이 닫혔습니다. 다시 연결해 주세요.");
        int count = connection.bulkTransfer(out, bytes, bytes.length, 1000);
        if (count != bytes.length) throw new IOException("USB 전송이 완료되지 않았습니다. 같은 입력은 자동 재전송하지 않습니다.");
        if (bytes.length >= 6 && bytes[0] == 0x57 && bytes[1] == (byte) 0xab) {
            address = bytes[2] & 255;
            if (bytes[3] == 2) keyboardUsed = true;
            if (bytes[3] == 4 || bytes[3] == 5) mouseUsed = true;
        }
    }
    public synchronized void close(boolean releaseInputs) {
        if (closed) return;
        if (releaseInputs) {
            // A release is safe to attempt; input presses and IME toggles are never retried.
            try { if (keyboardUsed) write(Ch340Math.releasePacket(address, false)); } catch (Exception ignored) {}
            try { if (mouseUsed) write(Ch340Math.releasePacket(address, true)); } catch (Exception ignored) {}
        }
        closed = true;
        if (connection != null) {
            try { connection.releaseInterface(intf); } catch (Exception ignored) {}
            try { connection.close(); } catch (Exception ignored) {}
        }
    }
}
