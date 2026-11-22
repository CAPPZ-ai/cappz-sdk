/**
 * 16.0.4 — synchronous SHA-256 and HMAC-SHA256 of text, as lowercase hex, on @noble/hashes.
 * Replaces crypto-js (no longer maintained). Byte-identical to CryptoJS.SHA256(text).toString() and
 * CryptoJS.HmacSHA256(text, key).toString(): text and key are UTF-8, as crypto-js read them.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const sha256HexOfText = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

export const hmacSha256HexOfText = (text: string, key: string): string => bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(text)));
