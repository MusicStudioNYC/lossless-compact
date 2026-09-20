/**
 * Small, dependency-free, synchronous hashing that runs anywhere the library
 * runs (Node, the Claude Code hook engine, a browser): FNV-1a in 64 bits, kept
 * as two 32-bit halves so no BigInt is needed. It is a fingerprint for stable
 * ids and change detection, not a security primitive.
 */
export function fnv1a64(text: string): string {
  // FNV-1a 64-bit: offset basis 0xcbf29ce484222325, prime 2^40 + 0x1b3.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const mix = (byte: number): void => {
    const x = (lo ^ byte) >>> 0;
    // (hi·2^32 + x) · (2^40 + 0x1b3) mod 2^64:
    //   x·0x1b3 → low word plus a carry; x·2^40 → x·2^8 into the high word;
    //   hi·0x1b3·2^32 → hi·0x1b3 into the high word; hi·2^72 vanishes.
    const low = x * 0x1b3; // < 2^41, exact in a double
    const carry = Math.floor(low / 0x100000000);
    lo = low >>> 0;
    hi = (hi * 0x1b3 + carry + x * 0x100) >>> 0;
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Hash each UTF-16 code unit as two bytes so all of the string counts.
    mix(code & 0xff);
    mix(code >>> 8);
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** A 16-hex-character fingerprint of some text. */
export function hashText(text: string): string {
  return fnv1a64(text);
}

/** Fingerprint of a value by its JSON form; unserialisable values hash as a tag. */
export function hashJson(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'undefined';
  } catch {
    json = '[unserializable]';
  }
  return hashText(json);
}
