package android.hardware.usb;
/** Metadata-only USB device model for driver-selection regression checks. */
public final class UsbDevice {
    private final int vendor, product, deviceClass;
    private final UsbInterface[] interfaces;
    public UsbDevice(int vendor, int product, int deviceClass, UsbInterface... interfaces) {
        this.vendor=vendor; this.product=product; this.deviceClass=deviceClass; this.interfaces=interfaces;
    }
    public int getVendorId() { return vendor; }
    public int getProductId() { return product; }
    public int getDeviceClass() { return deviceClass; }
    public int getInterfaceCount() { return interfaces.length; }
    public UsbInterface getInterface(int index) { return interfaces[index]; }
    public String getDeviceName() { return "/dev/bus/usb/001/003"; }
    public int getDeviceId() { return 3; }
}
