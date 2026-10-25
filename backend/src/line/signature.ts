// ตรวจ X-Line-Signature: Base64( HMAC-SHA256(channelSecret, ตัว request body ดิบ) )
// ต้องใช้ body ดิบก่อน parse JSON และเทียบแบบ timing-safe

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLineSignature(rawBody: string, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const signLineBody = (rawBody: string, channelSecret: string) => createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest('base64');
