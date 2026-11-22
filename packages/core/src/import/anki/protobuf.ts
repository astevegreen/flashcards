/**
 * Minimal read-only protobuf decoder for the few Anki messages the importer needs
 * (`PackageMetadata`, `MediaEntries`, notetype / template configs). Untrusted input: every
 * length is bounds-checked and malformed data throws {@link ProtobufError}.
 */

import { decodeUtf8 } from '../../ids.ts';

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufError';
  }
}

/** One decoded field: varints as numbers, length-delimited values as raw bytes. */
export type ProtoValue = { wire: 0; value: number } | { wire: 2; bytes: Uint8Array };

/** Decoded message: field number -> values in wire order (repeated fields keep every value). */
export type ProtoMessage = Map<number, ProtoValue[]>;

interface Cursor {
  readonly bytes: Uint8Array;
  pos: number;
}

function readVarint(c: Cursor): number {
  let result = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (c.pos >= c.bytes.length) throw new ProtobufError('Truncated varint');
    const byte = c.bytes[c.pos++] ?? 0;
    // Values above 2^53 lose precision; Anki ids and sizes used here stay far below it.
    result += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return result;
    scale *= 128;
  }
  throw new ProtobufError('Varint too long');
}

function skip(c: Cursor, length: number): void {
  if (length < 0 || c.pos + length > c.bytes.length) {
    throw new ProtobufError('Field runs past end of message');
  }
  c.pos += length;
}

/** Decodes one message level. Fixed32/fixed64 fields are skipped; groups are rejected. */
export function decodeProtobuf(bytes: Uint8Array): ProtoMessage {
  const msg: ProtoMessage = new Map();
  const c: Cursor = { bytes, pos: 0 };
  while (c.pos < bytes.length) {
    const key = readVarint(c);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) throw new ProtobufError('Invalid field number 0');
    let value: ProtoValue | undefined;
    if (wire === 0) {
      value = { wire: 0, value: readVarint(c) };
    } else if (wire === 2) {
      const length = readVarint(c);
      const start = c.pos;
      skip(c, length);
      value = { wire: 2, bytes: bytes.subarray(start, start + length) };
    } else if (wire === 1) {
      skip(c, 8);
    } else if (wire === 5) {
      skip(c, 4);
    } else {
      throw new ProtobufError(`Unsupported wire type ${wire}`);
    }
    if (value) {
      const list = msg.get(field);
      if (list) list.push(value);
      else msg.set(field, [value]);
    }
  }
  return msg;
}

/** Last varint value of `field` (proto3 "last one wins"), or `fallback`. */
export function protoNumber(msg: ProtoMessage, field: number, fallback = 0): number {
  const list = msg.get(field);
  const last = list?.at(-1);
  return last?.wire === 0 ? last.value : fallback;
}

/** Last length-delimited value of `field` decoded as UTF-8, or `fallback`. */
export function protoString(msg: ProtoMessage, field: number, fallback = ''): string {
  const list = msg.get(field);
  const last = list?.at(-1);
  return last?.wire === 2 ? decodeUtf8(last.bytes) : fallback;
}

/** Every length-delimited value of `field` (repeated sub-messages). */
export function protoBytesList(msg: ProtoMessage, field: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const v of msg.get(field) ?? []) {
    if (v.wire === 2) out.push(v.bytes);
  }
  return out;
}
