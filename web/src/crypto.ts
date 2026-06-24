// End-to-end encryption for the Go relay path (SPEC §4.3).
//
// Uses WebCrypto: ECDH P-256 for key agreement and AES-GCM-256 for symmetric
// encryption. The shared secret is derived without HKDF since ECDH on P-256
// already yields 256 bits of key material.
//
// Wire format per encrypted frame: [12-byte random IV][AES-GCM ciphertext+16-byte tag]

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export async function deriveSharedKey(myPriv: CryptoKey, theirPub: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPub },
    myPriv,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptFrame(key: CryptoKey, plain: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out.buffer;
}

export async function decryptFrame(key: CryptoKey, encrypted: ArrayBuffer): Promise<ArrayBuffer> {
  const buf = new Uint8Array(encrypted);
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}
