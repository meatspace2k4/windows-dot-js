// ADVAPI32's RSA signature check, as the base provider does it: a PUBLICKEYBLOB imported (CryptImportKey), a hash's
// PKCS #1 v1.5 signature verified (CryptVerifySignatureA), little-endian as CryptoAPI gives both. WinVerifyTrust's
// Authenticode check of a signed CAB (Java Package Manager's xmldso4.cab, Windows 98's first start) needs it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createSign } from 'node:crypto';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 20) }; p.handles = new Map(); p.nextHandle = 0x100; p.lastError = 0;
const A = API.ADVAPI32, call = (nm, ...a) => A[nm][1].call(p, ...a);
const at = { blob: 0x1000, data: 0x2000, sig: 0x3000, out: 0x4000, prov: 0x4010, hash: 0x4020, key: 0x4030 };

for (const [alg, calg, bits] of [['sha1', 0x8004, 1024], ['md5', 0x8003, 2048]]) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' }), n = Buffer.from(jwk.n, 'base64url'), e = Buffer.from(jwk.e, 'base64url');
  // PUBLICKEYBLOB: PUBLICKEYSTRUC (6, 2, 0, CALG_RSA_SIGN), RSAPUBKEY ('RSA1', bits, exponent), the modulus little-endian
  const k = bits >> 3, blob = new Uint8Array(20 + k), dv = new DataView(blob.buffer);
  blob[0] = 6; blob[1] = 2; dv.setUint32(4, 0x2400, true); dv.setUint32(8, 0x31415352, true); dv.setUint32(12, bits, true);
  dv.setUint32(16, Number(BigInt('0x' + e.toString('hex'))), true); blob.set(Buffer.from(n).reverse(), 20);
  p.u8.set(blob, at.blob);
  const data = Buffer.from('a signed cabinet\'s contents'); p.u8.set(data, at.data);
  const sig = createSign(alg).update(data).sign(privateKey); p.u8.set(Buffer.from(sig).reverse(), at.sig);   // (little-endian, as CryptSignHash gives it)

  assert.equal(call('CryptAcquireContextA', at.out, 0, 0, 1, 0xf0000000), 1); const prov = p.r32(at.out);
  assert.equal(call('CryptImportKey', prov, at.blob, blob.length, 0, 0, at.key), 1, `${bits}-bit public key imported`); const key = p.r32(at.key);
  const verify = () => { call('CryptCreateHash', prov, calg, 0, 0, at.hash); const h = p.r32(at.hash); call('CryptHashData', h, at.data, data.length, 0); const r = call('CryptVerifySignatureA', h, at.sig, k, key, 0, 0); call('CryptDestroyHash', h); return r; };
  assert.equal(verify(), 1, `the ${alg} signature verifies`);
  p.u8[at.data] ^= 1;
  assert.equal(verify(), 0, `the ${alg} signature of other data does not`);
  assert.equal(p.lastError >>> 0, 0x80090006, 'NTE_BAD_SIGNATURE');
  p.u8[at.data] ^= 1;
  assert.equal(call('CryptDestroyKey', key), 1);
}
console.log('cryptverify: ok');
