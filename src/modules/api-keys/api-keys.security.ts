import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const API_KEY_PREFIX = "ft_live_";
const API_KEY_HASH_BYTES = 32;
const API_KEY_SALT_BYTES = 16;

export interface ApiKeyHashResult {
  hash: string;
  salt: string;
}

export function generateRawApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
}

function deriveApiKeyHash(raw: string, saltHex: string): string {
  return scryptSync(raw, Buffer.from(saltHex, "hex"), API_KEY_HASH_BYTES).toString("hex");
}

export function hashApiKey(raw: string): ApiKeyHashResult {
  const salt = randomBytes(API_KEY_SALT_BYTES).toString("hex");
  const hash = deriveApiKeyHash(raw, salt);
  return { hash, salt };
}

export function getKeyPrefix(raw: string): string {
  return raw.slice(0, 16);
}

export function getKeyPreview(raw: string): string {
  const start = raw.slice(0, 11);
  const end = raw.slice(-4);
  return `${start}...${end}`;
}

export function isApiKeyFormat(raw: string): boolean {
  return /^ft_live_[a-f0-9]{48}$/i.test(raw);
}

export function safeHashEquals(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length || expectedHex.length % 2 !== 0) return false;

  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length || expected.length === 0) return false;

  return timingSafeEqual(expected, actual);
}

export function verifyApiKey(raw: string, expectedHashHex: string, saltHex: string): boolean {
  const normalizedSalt = saltHex.trim();
  if (!/^[a-f0-9]{32}$/i.test(normalizedSalt)) return false;

  const computedHash = deriveApiKeyHash(raw, normalizedSalt);
  return safeHashEquals(expectedHashHex, computedHash);
}
