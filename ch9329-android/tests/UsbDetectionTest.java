import android.hardware.usb.*;
import com.wnddud.hiddesk.SerialUsbPort;
public class UsbDetectionTest {
    private static void check(boolean value,String name) { if (!value) throw new AssertionError(name); }
    public static void main(String[] args) {
        UsbInterface vendor=new UsbInterface(255,0), hid=new UsbInterface(3,1);
        UsbDevice ch340=new UsbDevice(0x1a86,0x7523,0,vendor);
        check(SerialUsbPort.supports(ch340),"existing CH340 supported");
        check(SerialUsbPort.supports(new UsbDevice(0x1a86,0x7522,0,vendor)),"CH340 alternate PID kept");
        for(int product:new int[]{0x55d3,0x55d4}) {
            UsbDevice cdc=new UsbDevice(0x1a86,product,0,new UsbInterface(2,2),new UsbInterface(10,0));
            check(SerialUsbPort.supports(cdc),"CH343/CH9102 CDC detected");
            check(SerialUsbPort.driverName(cdc).equals("CdcAcm"),"CDC driver selected");
        }
        check(SerialUsbPort.supports(new UsbDevice(0x10c4,0xea60,0,vendor)),"CP210x supported");
        check(SerialUsbPort.supports(new UsbDevice(0x0403,0x6001,0,vendor)),"FTDI supported");
        UsbDevice keyboard=new UsbDevice(0x1a86,0xe026,0,hid);
        check(!SerialUsbPort.supports(keyboard),"HID end not selected as serial");
        check(SerialUsbPort.isHid(keyboard),"HID end can be identified for cable-direction guidance");
        UsbDevice unknown=new UsbDevice(0x9999,0x0001,0,vendor);
        check(!SerialUsbPort.supports(unknown)&&!SerialUsbPort.isHid(unknown),"unknown devices remain unsupported");
        System.out.println("USB detection: CH340 aliases, CH343/CH9102 CDC, CP210x, FTDI, HID and unknown passed");
    }
}
