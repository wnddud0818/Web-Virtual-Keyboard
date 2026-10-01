/* CH340/CH341 USB serial over WebUSB, for browsers without wired Web Serial
   (Android Chrome). Exposes the SerialPort subset SerialClient uses. EUPL-1.2; added 2026-09-30. */
(function (root) {
  'use strict';
  // Device IDs, requests and registers follow Linux drivers/usb/serial/ch341.c.
  const filters = [
    { vendorId:0x1a86, productId:0x7523 }, { vendorId:0x1a86, productId:0x7522 }, { vendorId:0x1a86, productId:0x5523 },
    { vendorId:0x2184, productId:0x0057 }, { vendorId:0x4348, productId:0x5523 }, { vendorId:0x9986, productId:0x7523 }
  ];
  const READ_VERSION = 0x5f, WRITE_REG = 0x9a, SERIAL_INIT = 0xa1, MODEM_CTRL = 0xa4;
  const REG_PRESCALER_DIVISOR = 0x1312, REG_LCR = 0x2518;
  const LCR_8N1 = 0x80 | 0x40 | 0x03, DTR_RTS = 0x20 | 0x40;
  // Returns divisor << 8 | fact << 2 | prescaler for the 48 MHz base clock.
  function baudDivisor(baudRate) {
    const clock = 48000000, clockDiv = (ps, fact) => 1 << (12 - 3 * ps - fact);
    if (!Number.isInteger(baudRate) || baudRate < 46 || baudRate > 3000000) throw new Error('지원하지 않는 통신 속도입니다.');
    let ps = 3;
    while (ps > 0 && baudRate <= clock / (clockDiv(ps, 1) * 512)) ps--;
    let fact = 1, div = Math.floor(clock / (clockDiv(ps, 1) * baudRate)), cd = clockDiv(ps, 1);
    if (div < 9 || div > 255) { div = Math.floor(div / 2); cd *= 2; fact = 0; }
    if (div < 2) throw new Error('지원하지 않는 통신 속도입니다.');
    // Round to the nearer divisor; scaled to keep low rates exact.
    if (Math.floor(16 * clock / (cd * div)) - 16 * baudRate >= 16 * baudRate - Math.floor(16 * clock / (cd * (div + 1)))) div++;
    if (fact === 1 && div % 2 === 0) { div /= 2; fact = 0; }
    return (0x100 - div) << 8 | fact << 2 | ps;
  }
  function bulkInterface(configuration) {
    for (const item of configuration?.interfaces || []) {
      const endpoints = (item.alternate || item.alternates[0])?.endpoints || [];
      const input = endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
      const output = endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
      if (input && output) return { number:item.interfaceNumber, input, output };
    }
    return null;
  }
  function lost(error) {
    return new Error('USB 케이블 연결이 끊겼거나 통신 오류가 발생했습니다. 다시 연결해 주세요.' + (error?.message ? ' (' + error.message + ')' : ''));
  }
  class Ch340UsbPort {
    constructor(device, usb = root.navigator?.usb) {
      this.device = device; this.usb = usb;
      this.readable = null; this.writable = null; this.closed = false;
      this.onDisconnect = event => { if (event.device === this.device && !this.closed) this.input?.error(lost()); };
    }
    getInfo() { return { usbVendorId:this.device.vendorId, usbProductId:this.device.productId }; }
    async control(request, value, index, length) {
      const setup = { requestType:'vendor', recipient:'device', request, value, index };
      const result = length ? await this.device.controlTransferIn(setup, length) : await this.device.controlTransferOut(setup);
      if (result.status !== 'ok') throw new Error(`CH340 설정 명령이 거부되었습니다 (0x${request.toString(16)}).`);
      return result.data;
    }
    async open({ baudRate = 9600, dataBits = 8, stopBits = 1, parity = 'none', flowControl = 'none' } = {}) {
      if (this.readable || this.closed) throw new Error('USB 장치를 다시 선택해 주세요.');
      if (dataBits !== 8 || stopBits !== 1 || parity !== 'none' || flowControl !== 'none') throw new Error('USB 직접 연결은 8N1, 흐름 제어 없음만 지원합니다.');
      const divisor = baudDivisor(baudRate), device = this.device;
      let found;
      await device.open();
      try {
        if (!device.configuration) await device.selectConfiguration(1);
        found = bulkInterface(device.configuration);
        if (!found) throw new Error('CH340의 데이터 전송 통로를 찾지 못했습니다.');
        await device.claimInterface(found.number);
        this.interfaceNumber = found.number;
        const version = (await this.control(READ_VERSION, 0, 0, 2))?.getUint8(0);
        if (version === undefined) throw new Error('CH340 버전을 읽지 못했습니다.');
        await this.control(SERIAL_INIT, 0, 0);
        // Bit 7 sends each received byte without waiting for a full packet;
        // Linux notes chips up to version 0x27 have it inverted.
        await this.control(WRITE_REG, REG_PRESCALER_DIVISOR, divisor | (version > 0x27 ? 0x80 : 0));
        // Chips before 0x30 keep line control in other registers, fixed at 8N1.
        if (version >= 0x30) await this.control(WRITE_REG, REG_LCR, LCR_8N1);
        await this.control(MODEM_CTRL, ~DTR_RTS & 0xffff, 0);
        this.version = version;
      } catch (error) {
        try { await device.close(); } catch {}
        throw error;
      }
      const { input: bulkIn, output: bulkOut } = found;
      const size = Math.max(64, bulkIn.packetSize || 0);
      this.readable = new ReadableStream({
        start: controller => { this.input = controller; },
        pull: async controller => {
          // Resolve only with data: an empty pull would leave read() pending.
          for (;;) {
            let result;
            try { result = await device.transferIn(bulkIn.endpointNumber, size); }
            catch (error) { if (this.closed) { try { controller.close(); } catch {} return; } throw lost(error); }
            if (result.status === 'stall') { await device.clearHalt('in', bulkIn.endpointNumber); continue; }
            if (result.status !== 'ok') throw lost(new Error(result.status));
            const data = result.data;
            if (data?.byteLength) { controller.enqueue(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))); return; }
          }
        }
      });
      this.writable = new WritableStream({
        write: async chunk => {
          let result;
          try { result = await device.transferOut(bulkOut.endpointNumber, chunk); } catch (error) { throw lost(error); }
          if (result.status !== 'ok' || result.bytesWritten !== chunk.byteLength) throw lost(new Error(result.status));
        }
      });
      this.usb?.addEventListener?.('disconnect', this.onDisconnect);
    }
    async close() {
      this.closed = true;
      this.usb?.removeEventListener?.('disconnect', this.onDisconnect);
      // Releasing the interface aborts the pending bulk read.
      if (this.device.opened) {
        if (this.interfaceNumber !== undefined) { try { await this.device.releaseInterface(this.interfaceNumber); } catch {} }
        try { await this.device.close(); } catch {}
      }
      this.readable = null; this.writable = null; this.input = null;
    }
  }
  async function request(usb = root.navigator?.usb) {
    return new Ch340UsbPort(await usb.requestDevice({ filters }), usb);
  }
  const api = { filters, baudDivisor, Ch340UsbPort, request };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CH340Usb = api;
})(globalThis);
