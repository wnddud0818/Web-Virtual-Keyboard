package com.wnddud.hiddesk;

import java.io.IOException;

/** Sequential CH9329 keyboard commands, with every ACK checked off the UI thread. */
public final class KeyboardBatch {
    public interface Writer { void write(byte[] packet) throws IOException; }
    public static final int RECORD_SIZE = 9, MAX_REPORTS = 32;
    private final byte[] reports;
    private final int address;
    private final long timeoutNanos;
    private final byte[] input = new byte[256];
    private int inputLength;
    private boolean pending, cancelled;
    private IOException failure;
    private volatile int completed;

    public KeyboardBatch(byte[] reports, int address) throws IOException {
        this(reports, address, 1200);
    }
    public KeyboardBatch(byte[] reports, int address, int timeoutMs) throws IOException {
        if (reports.length == 0 || reports.length % RECORD_SIZE != 0 || reports.length > MAX_REPORTS * RECORD_SIZE
                || address < 0 || address > 254 || timeoutMs <= 0)
            throw new IOException("키 입력 묶음 크기와 주소를 확인하세요.");
        for (int n = 0; n < reports.length; n += RECORD_SIZE) {
            int delay = ((reports[n + 7] & 255) << 8) | (reports[n + 8] & 255);
            if (delay > 1000) throw new IOException("키 입력 대기 시간이 너무 깁니다.");
        }
        this.reports = reports.clone(); this.address = address;
        timeoutNanos = timeoutMs * 1000000L;
    }
    public synchronized void cancel() { cancelled = true; notifyAll(); }
    public synchronized boolean isCancelled() { return cancelled; }
    public int completedCount() { return completed; }
    public synchronized void fail(IOException error) { if (failure == null) failure = error; notifyAll(); }

    /** The existing single USB reader feeds both fragmented and coalesced frames here. */
    public synchronized void receive(byte[] bytes) {
        for (byte value : bytes) {
            if (inputLength == input.length) discard(1);
            input[inputLength++] = value;
            parse();
        }
    }
    private void discard(int count) {
        System.arraycopy(input, count, input, 0, inputLength - count); inputLength -= count;
    }
    private void parse() {
        while (inputLength >= 2) {
            if ((input[0] & 255) != 0x57 || (input[1] & 255) != 0xab) { discard(1); continue; }
            if (inputLength < 5) return;
            int length = input[4] & 255;
            if (length > 64) { discard(1); continue; }
            int size = length + 6;
            if (inputLength < size) return;
            int sum = 0; for (int n = 0; n < size - 1; n++) sum += input[n] & 255;
            if ((sum & 255) != (input[size - 1] & 255)) { discard(1); continue; }
            int command = input[3] & 255;
            if (pending && (input[2] & 255) == address && (command == 0x82 || command == 0xc2)) {
                if (command != 0x82 || length != 1 || input[5] != 0)
                    failure = new IOException("장치가 키 입력을 거부했습니다. 일부 입력은 전달됐을 수 있습니다.");
                pending = false; notifyAll();
            }
            discard(size);
        }
    }
    private void awaitAck() throws IOException, InterruptedException {
        long deadline = System.nanoTime() + timeoutNanos;
        synchronized (this) {
            // Finish an in-flight ACK even after cancellation; never retry a key press.
            while (pending && failure == null) {
                long left = deadline - System.nanoTime();
                if (left <= 0) throw new IOException("장치 응답 시간이 초과되었습니다. 일부 입력은 전달됐을 수 있습니다. 다시 연결하세요.");
                wait(Math.max(1, left / 1000000L));
            }
            if (failure != null) throw failure;
        }
    }
    private synchronized void pause(int millis) throws IOException, InterruptedException {
        long deadline = System.nanoTime() + millis * 1000000L;
        while (!cancelled && failure == null) {
            long left = deadline - System.nanoTime();
            if (left <= 0) break;
            wait(Math.max(1, left / 1000000L));
        }
        if (failure != null) throw failure;
    }
    public int run(Writer writer) throws IOException {
        try {
            for (int offset = 0; offset < reports.length; offset += RECORD_SIZE) {
                synchronized (this) {
                    if (failure != null) throw failure;
                    if (cancelled) break;
                    pending = true;
                }
                byte[] packet = new byte[14];
                packet[0] = 0x57; packet[1] = (byte) 0xab; packet[2] = (byte) address;
                packet[3] = 2; packet[4] = 8; packet[5] = reports[offset];
                System.arraycopy(reports, offset + 1, packet, 7, 6);
                int sum = 0; for (int n = 0; n < 13; n++) sum += packet[n] & 255;
                packet[13] = (byte) sum;
                writer.write(packet); awaitAck(); completed++;
                pause(((reports[offset + 7] & 255) << 8) | (reports[offset + 8] & 255));
            }
            return completed;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); throw new IOException("키 입력 작업이 중단되었습니다.", e);
        }
    }
}
