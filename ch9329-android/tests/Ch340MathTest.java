import com.wnddud.hiddesk.Ch340Math;
public class Ch340MathTest {
    private static void check(boolean value, String name) { if (!value) throw new AssertionError(name); }
    public static void main(String[] args) {
        int[][] golden = {{9600,0xb202},{19200,0xd902},{38400,0x6403},{57600,0x9803},{115200,0xcc03}};
        for (int[] row : golden) check(Ch340Math.baudDivisor(row[0]) == row[1], "baud " + row[0]);
        for (int address : new int[]{0, 3, 254}) {
            for (boolean mouse : new boolean[]{false,true}) {
                byte[] packet = Ch340Math.releasePacket(address, mouse);
                check((packet[0] & 255) == 0x57 && (packet[1] & 255) == 0xab, "header");
                check((packet[2] & 255) == address, "address");
                check(packet[3] == (mouse ? 5 : 2), "command");
                check(packet[5] == (mouse ? 1 : 0), "report");
                int sum = 0; for (int i = 0; i < packet.length - 1; i++) sum += packet[i] & 255;
                check((sum & 255) == (packet[packet.length-1] & 255), "checksum");
            }
        }
        System.out.println("Native baud registers and emergency key/mouse releases passed");
    }
}
