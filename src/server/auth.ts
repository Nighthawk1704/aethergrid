import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT_OPTS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<{ salt: Buffer; hash: Buffer }> {
  const salt = randomBytes(16);
  return { salt, hash: await derive(password, salt) };
}

export async function verifyPassword(password: string, salt: Buffer, hash: Buffer): Promise<boolean> {
  const key = await derive(password, salt);
  return key.length === hash.length && timingSafeEqual(key, hash);
}

/** Burn comparable time for unknown usernames so login timing does not reveal which names exist. */
const DUMMY_SALT = randomBytes(16);
export async function dummyVerify(password: string): Promise<void> {
  await derive(password, DUMMY_SALT);
}
