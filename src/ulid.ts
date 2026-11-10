// A small ULID generator: sortable, 26 characters, Crockford base 32.
// Spec: https://github.com/ulid/spec. Monotonic order within one millisecond
// is not needed here: the store keeps its own order.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(now: number): string {
  let out = "";
  let n = now;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RAND_LEN; i++) out += ENCODING[bytes[i]! % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
