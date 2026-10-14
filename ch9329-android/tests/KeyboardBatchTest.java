import com.wnddud.hiddesk.KeyboardBatch;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

public final class KeyboardBatchTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static byte[] ack(int address, int status) {
        byte[] frame = {0x57,(byte)0xab,(byte)address,(byte)0x82,1,(byte)status,0};
        int sum = 0; for (int n=0;n<6;n++) sum += frame[n]&255; frame[6]=(byte)sum; return frame;
    }
    private static byte[] reports(int count) {
        byte[] data = new byte[count*9];
        for (int n=0;n<count;n++) { data[n*9]=(byte)(n%2*2); data[n*9+1]=(byte)(4+n); }
        return data;
    }
    private static void failure(KeyboardBatch batch, KeyboardBatch.Writer writer, String expected) throws Exception {
        try { batch.run(writer); throw new AssertionError("failure expected"); }
        catch (IOException error) { check(error.getMessage().contains(expected),error.getMessage()); }
    }
    public static void main(String[] args) throws Exception {
        KeyboardBatch batch = new KeyboardBatch(reports(32),3);
        List<byte[]> writes = new ArrayList<>();
        int completed = batch.run(packet -> {
            writes.add(packet); check(packet.length==14 && packet[2]==3 && packet[3]==2 && packet[6]==0,"keyboard packet");
            int sum=0;for(int n=0;n<13;n++)sum+=packet[n]&255;check((sum&255)==(packet[13]&255),"checksum");
            byte[] wrong=ack(4,0), broken=ack(3,0); broken[6]++;
            batch.receive(new byte[]{9,0x57}); batch.receive(wrong); batch.receive(broken);
            byte[] frame=ack(3,0);batch.receive(Arrays.copyOfRange(frame,0,3));batch.receive(Arrays.copyOfRange(frame,3,7));
        });
        check(completed==32 && writes.size()==32,"every ACK checked");
        KeyboardBatch rejected = new KeyboardBatch(reports(2),0);
        int[] attempts={0};failure(rejected,packet->{attempts[0]++;rejected.receive(ack(0,0xe6));},"거부");
        check(attempts[0]==1,"chip rejection is never retried");
        KeyboardBatch partial = new KeyboardBatch(reports(3),0);
        int[] count={0};failure(partial,packet->partial.receive(ack(0,count[0]++==0?0:0xe6)),"거부");
        check(partial.completedCount()==1,"acknowledged prefix retained after failure");
        KeyboardBatch timeout = new KeyboardBatch(reports(2),0,20);
        attempts[0]=0;failure(timeout,packet->{attempts[0]++;timeout.receive(ack(1,0));},"초과");
        check(attempts[0]==1,"timeout never retries or advances");
        KeyboardBatch cancelled = new KeyboardBatch(reports(2),0);
        check(cancelled.run(packet->{cancelled.cancel();cancelled.receive(ack(0,0));})==1,"cancel finishes current ACK only");
        KeyboardBatch queued = new KeyboardBatch(reports(2),0);queued.cancel();
        check(queued.run(packet->{throw new AssertionError("cancelled before start");})==0,"queued cancellation");
        byte[] delayed=reports(2);delayed[8]=100;
        KeyboardBatch delay = new KeyboardBatch(delayed,0);
        long start=System.nanoTime();
        check(delay.run(packet->delay.receive(ack(0,0)))==2,"delay batch completes");
        check(System.nanoTime()-start>=100000000L,"IME settling wait preserved");
        KeyboardBatch lost = new KeyboardBatch(reports(2),0);
        failure(lost,packet->lost.fail(new IOException("USB 분리")),"분리");
        ExecutorService reader=Executors.newSingleThreadExecutor();
        try {
            KeyboardBatch asynchronous = new KeyboardBatch(reports(10),0);
            check(asynchronous.run(packet->reader.execute(()->asynchronous.receive(ack(0,0))))==10,"separate USB reader wakes writer");
        } finally {reader.shutdownNow();}
        try {new KeyboardBatch(new byte[33*9],0);throw new AssertionError("oversize");}catch(IOException expected){}
        try {new KeyboardBatch(new byte[8],0);throw new AssertionError("partial record");}catch(IOException expected){}
        System.out.println("KeyboardBatch: packets, fragmented ACKs, wrong address/checksum, rejection, timeout, cancellation, IME waits, detach and concurrent reader passed");
    }
}
