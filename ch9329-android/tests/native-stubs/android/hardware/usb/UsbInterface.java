package android.hardware.usb;
public final class UsbInterface {
    private final int deviceClass, subclass;
    public UsbInterface(int deviceClass, int subclass) { this.deviceClass=deviceClass; this.subclass=subclass; }
    public int getInterfaceClass() { return deviceClass; }
    public int getInterfaceSubclass() { return subclass; }
    public int getInterfaceProtocol() { return 0; }
    public int getEndpointCount() { return 0; }
    public UsbEndpoint getEndpoint(int index) { throw new UnsupportedOperationException("metadata only"); }
}
