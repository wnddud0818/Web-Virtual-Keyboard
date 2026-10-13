// Regenerate offline decoder assets. Runtime needs no Node or build step.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const directory = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(directory, '../Web-Virtual-Keyboard-platformio/web/decoder.html'));
if (source.some(byte => byte > 127)) throw new Error('Original decoder must remain ASCII.');
const payload = zlib.gzipSync(source, { level:9 }).toString('base64');
const hash = crypto.createHash('sha256').update(source).digest('hex');
const installer = `<!doctype html><meta charset="utf-8"><title>WVK Decoder</title><body><p id="s">Opening offline decoder...</p><script>(async()=>{try{let a=Uint8Array.from(atob("${payload}"),c=>c.charCodeAt(0)),b=await new Response(new Blob([a]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),h=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",b)),x=>x.toString(16).padStart(2,"0")).join("");if(h!=="${hash}")throw Error("Incomplete or corrupted input. Type again.");document.open();document.write(new TextDecoder().decode(b));document.close()}catch(e){document.getElementById("s").textContent="Open in a current Chrome/Edge browser. "+e.message}})()</script>`;
fs.writeFileSync(path.join(directory, 'decoder.html'), source);
fs.writeFileSync(path.join(directory, 'decoder-installer.html'), installer);
fs.writeFileSync(path.join(directory, 'decoder-source.js'),
  '// Embedded offline decoder and compressed installer; EUPL-1.2. Regenerate with scripts/build-decoder.cjs.\n' +
  'window.WVK_DECODER_BASE64 = ' + JSON.stringify(source.toString('base64')) + ';\n' +
  'window.WVK_INSTALLER_BASE64 = ' + JSON.stringify(Buffer.from(installer).toString('base64')) + ';\n');
console.log(JSON.stringify({ full:source.length, installer:installer.length, reduction:Math.round(100 * (1 - installer.length / source.length)) + '%' }));
