/* Android native USB transport; EUPL-1.2. No network access or browser USB API. */
(function (root) {
  'use strict';
  const pending = new Map();
  let sequence = 0, active = null;
  const available = !!root.HidNative && typeof ReadableStream === 'function' && typeof WritableStream === 'function';
  function invoke(method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      // User dialogs and an idle read have no deadline; USB writes/open do.
      const timer = ['select', 'save', 'read'].includes(method) ? null : setTimeout(() => { pending.delete(id); reject(new Error('앱의 USB 작업 응답이 없습니다. 다시 연결하세요.')); }, 8000);
      pending.set(id, { resolve, reject, timer });
      try { root.HidNative.postMessage(JSON.stringify({ id, method, args })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function base64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  }
  function bytes(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
  class NativePort {
    constructor(device) { this.device = device; this.closed = false; this.session = null; this.readable = null; this.writable = null; }
    getInfo() { return { usbVendorId:this.device.vendorId, usbProductId:this.device.productId }; }
    async open({ baudRate = 9600, dataBits = 8, stopBits = 1, parity = 'none', flowControl = 'none' } = {}) {
      if (this.closed || this.session !== null) throw new Error('USB 장치를 다시 선택하세요.');
      if (dataBits !== 8 || stopBits !== 1 || parity !== 'none' || flowControl !== 'none') throw new Error('USB 연결은 8N1, 흐름 제어 없음만 지원합니다.');
      const reply = await invoke('open', { device:this.device.device, baud:baudRate });
      this.session = reply.session; active = this;
      this.readable = new ReadableStream({
        start: controller => { this.controller = controller; },
        pull: async controller => {
          try {
            const reply = await invoke('read', { session:this.session });
            if (this.closed) return;
            if (reply.done) { controller.close(); return; }
            const data = bytes(reply.data);
            if (data.length) controller.enqueue(data);
          } catch (error) { if (!this.closed) controller.error(error); }
        },
        cancel: () => this.close()
      });
      this.writable = new WritableStream({ write: data => {
        if (this.closed) throw new Error('USB 연결이 종료되었습니다.');
        return invoke('write', { session:this.session, data:base64(data) });
      }});
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      if (active === this) active = null;
      if (this.session !== null) await invoke('close', { session:this.session });
    }
  }
  root.AndroidHid = {
    available,
    receive(reply) {
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id); clearTimeout(request.timer);
      if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.value);
    },
    async saveText(name, value, mime) { return invoke('save', { name, mime, data:base64(new TextEncoder().encode(value)) }); },
    background() { root.dispatchEvent(new Event('hid-background')); },
    disconnected(message) {
      const current = active;
      if (current && !current.closed) {
        try { current.controller.error(new Error(message)); } catch (_) {}
        // Let SerialClient's fault handler run before closing the transport.
        current.close().catch(() => {});
      }
    }
  };
  if (available) root.CH340Usb = { async request() { return new NativePort(await invoke('select')); } };
})(globalThis);
