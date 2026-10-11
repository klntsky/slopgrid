import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function encrypt(value: string, secret: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function decrypt(value: string, secret: Buffer) {
  const data = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", secret, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    cipher.update(data.subarray(12, -16)),
    cipher.final(),
  ]).toString();
}
