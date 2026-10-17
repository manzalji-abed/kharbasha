// Cryptographically random helpers built on Web Crypto, which both Workers and Node provide.

export function randomInt(max) {
  const limit = Math.floor(0x1_0000_0000 / max) * max; // reject the tail so every value is equally likely
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

export function randomString(length, alphabet) {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export const randomId = () => randomString(12, '0123456789abcdef');
