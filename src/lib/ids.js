function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

// Pure JavaScript SHA-256 fallback for browsers where crypto.subtle is
// unavailable on local HTTP addresses (notably Safari/iPadOS).
function sha256BytesFallback(inputBytes) {
  const constants = [];
  const hash = [];
  const composite = {};
  let primeCounter = 0;

  for (let candidate = 2; primeCounter < 64; candidate += 1) {
    if (composite[candidate]) continue;
    for (let multiple = candidate * candidate; multiple < 312; multiple += candidate) {
      composite[multiple] = true;
    }
    if (primeCounter < 8) {
      hash[primeCounter] = (Math.sqrt(candidate) * 0x100000000) | 0;
    }
    constants[primeCounter] = (Math.cbrt(candidate) * 0x100000000) | 0;
    primeCounter += 1;
  }

  const bitLength = inputBytes.length * 8;
  const paddedLength = (((inputBytes.length + 9 + 63) >> 6) << 6);
  const bytes = new Uint8Array(paddedLength);
  bytes.set(inputBytes);
  bytes[inputBytes.length] = 0x80;

  const view = new DataView(bytes.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  const words = new Int32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getInt32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const sigma0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const sigma1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) | 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + constants[index] + words[index]) | 0;
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((value, index) => outputView.setUint32(index * 4, value >>> 0, false));
  return output;
}

export async function sha256(value) {
  const data = new TextEncoder().encode(value);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return bytesToBase64Url(new Uint8Array(digest));
  }

  return bytesToBase64Url(sha256BytesFallback(data));
}

export async function deriveShareKey(ownerKey) {
  const digest = await sha256(`alex-board-share:${ownerKey}`);
  return digest.slice(0, 36);
}
