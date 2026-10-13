package com.wnddud.hiddesk;

/** CH340 baud registers, matching the upstream JS/Linux ch341 driver. */
public final class Ch340Math {
    private Ch340Math() {}
    private static int clockDiv(int ps, int fact) { return 1 << (12 - 3 * ps - fact); }
    public static int baudDivisor(int baud) {
        if (baud < 46 || baud > 3000000) throw new IllegalArgumentException("지원하지 않는 통신 속도입니다.");
        final int clock = 48000000;
        int ps = 3;
        while (ps > 0 && baud <= clock / (clockDiv(ps, 1) * 512)) ps--;
        int fact = 1, cd = clockDiv(ps, 1), div = clock / (cd * baud);
        if (div < 9 || div > 255) { div /= 2; cd *= 2; fact = 0; }
        if (div < 2) throw new IllegalArgumentException("지원하지 않는 통신 속도입니다.");
        if (16L * clock / ((long) cd * div) - 16L * baud >= 16L * baud - 16L * clock / ((long) cd * (div + 1))) div++;
        if (fact == 1 && div % 2 == 0) { div /= 2; fact = 0; }
        return ((0x100 - div) << 8) | (fact << 2) | ps;
    }
    public static byte[] releasePacket(int address, boolean mouse) {
        int length = mouse ? 5 : 8;
        byte[] packet = new byte[length + 6];
        packet[0] = 0x57; packet[1] = (byte) 0xab; packet[2] = (byte) address;
        packet[3] = (byte) (mouse ? 5 : 2); packet[4] = (byte) length;
        if (mouse) packet[5] = 1;
        int sum = 0;
        for (int i = 0; i < packet.length - 1; i++) sum += packet[i] & 255;
        packet[packet.length - 1] = (byte) sum;
        return packet;
    }
}
