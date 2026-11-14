/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-common
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The one shape every protocol adapter reduces a request to, so the guard has
 * one decision path whatever the wire: a read (forward), writes to envelope
 * points (check each), a privileged operation that is not a point write
 * (restart, file transfer, object creation, communication control — refused
 * unless the operator allows it by name), or a frame the adapter cannot read
 * completely (refused: what cannot be read cannot be checked).
 */

import type { PointValue } from '../authority.ts';

export interface PointWrite { point: string; value: PointValue }

export type WriteDecode =
  | { kind: 'read' }
  | { kind: 'write'; writes: PointWrite[]; /** Targets the map does not cover, in protocol terms. */ unmapped: string[] }
  | { kind: 'privileged'; what: string }
  | { kind: 'malformed'; because: string };

/** Byte helpers shared by the binary adapters. */
export const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
export const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
export const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
export const view = (b: Uint8Array, i: number, n: number) => { if (i + n > b.length) throw new Error('truncated'); return new DataView(b.buffer, b.byteOffset + i, n); };

/** A plain decimal number as text (sign, digits, optional fraction and exponent); unambiguous, so linear on any input. */
export const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Trim a character from both ends without a regex. */
export function trimChar(s: string, ch: string): string { let a = 0; let b = s.length; while (a < b && s[a] === ch) a++; while (b > a && s[b - 1] === ch) b--; return s.slice(a, b); }
