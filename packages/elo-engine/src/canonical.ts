import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { MAX_SAFE_INTEGER } from "./constants.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCanonicalProfile(value: unknown, path = "$"): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Object.is(value, -0)) throw new CanonicalJsonError(`negative-zero integer at ${path}`);
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new CanonicalJsonError(`integer outside safe range at ${path}`);
    }
    return;
  }
  if (typeof value === "string") {
    for (const point of value) {
      const code = point.codePointAt(0);
      if (code === undefined || code > 127) throw new CanonicalJsonError(`non-ASCII string at ${path}`);
      if (code < 32 || code === 127) throw new CanonicalJsonError(`control character at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new CanonicalJsonError(`sparse array at ${path}[${index}]`);
      validateCanonicalProfile(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateCanonicalProfile(key, `${path} key`);
      validateCanonicalProfile(item, `${path}.${key}`);
    }
    return;
  }
  throw new CanonicalJsonError(`unsupported JSON type at ${path}`);
}

export function canonicalJson(value: unknown): string {
  validateCanonicalProfile(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

class Parser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    const value = this.value();
    this.whitespace();
    if (this.offset !== this.source.length) throw new CanonicalJsonError("invalid trailing JSON data");
    return value;
  }

  private value(): JsonValue {
    this.whitespace();
    const character = this.source[this.offset];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (character === "t") return this.literal("true", true);
    if (character === "f") return this.literal("false", false);
    if (character === "n") return this.literal("null", null);
    if (character === "-" || (character !== undefined && /[0-9]/.test(character))) return this.integer();
    throw new CanonicalJsonError("invalid JSON value");
  }

  private object(): JsonObject {
    this.offset += 1;
    const result: JsonObject = {};
    const keys = new Set<string>();
    this.whitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.source[this.offset] !== '"') throw new CanonicalJsonError("object key must be a string");
      const key = this.string();
      if (keys.has(key)) throw new CanonicalJsonError(`duplicate JSON key: ${key}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.offset] !== ":") throw new CanonicalJsonError("object key must be followed by a colon");
      this.offset += 1;
      Object.defineProperty(result, key, {
        value: this.value(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.whitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return result;
      }
      if (delimiter !== ",") throw new CanonicalJsonError("object members must be comma separated");
      this.offset += 1;
    }
  }

  private array(): JsonValue[] {
    this.offset += 1;
    const result: JsonValue[] = [];
    this.whitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.whitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return result;
      }
      if (delimiter !== ",") throw new CanonicalJsonError("array values must be comma separated");
      this.offset += 1;
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (escaped) {
        escaped = false;
        this.offset += 1;
      } else if (character === "\\") {
        escaped = true;
        this.offset += 1;
      } else if (character === '"') {
        this.offset += 1;
        let result: unknown;
        try {
          result = JSON.parse(this.source.slice(start, this.offset));
        } catch {
          throw new CanonicalJsonError("invalid JSON string");
        }
        validateCanonicalProfile(result);
        if (typeof result !== "string") throw new CanonicalJsonError("invalid JSON string");
        return result;
      } else {
        this.offset += 1;
      }
    }
    throw new CanonicalJsonError("unterminated JSON string");
  }

  private integer(): number {
    const remainder = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(remainder);
    if (match === null) throw new CanonicalJsonError("invalid JSON integer");
    const token = match[0];
    const next = remainder[token.length];
    if (next !== undefined && !/[ \t\r\n,}\]]/.test(next)) throw new CanonicalJsonError("floating JSON numbers are forbidden");
    if (token === "-0") throw new CanonicalJsonError("negative-zero JSON integers are forbidden");
    const result = Number(token);
    if (!Number.isSafeInteger(result)) throw new CanonicalJsonError("JSON integer is outside the safe range");
    this.offset += token.length;
    return result;
  }

  private literal<T extends JsonPrimitive>(source: string, result: T): T {
    if (!this.source.startsWith(source, this.offset)) throw new CanonicalJsonError("invalid JSON literal");
    this.offset += source.length;
    return result;
  }

  private whitespace(): void {
    while (/[ \t\r\n]/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }
}

export function parseJsonText(source: string): JsonValue {
  return new Parser(source).parse();
}

export function loadJson(path: string): JsonValue {
  return parseJsonText(readFileSync(path, "utf8"));
}

export function fingerprintPayload(value: object): string {
  const payload = { ...value } as Record<string, unknown>;
  delete payload.fingerprint;
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "ascii").digest("hex")}`;
}

export function attachFingerprint<T extends object>(value: T): T & { fingerprint: string } {
  const result = { ...value, fingerprint: "" };
  result.fingerprint = fingerprintPayload(result);
  return result;
}

export function verifyFingerprint(value: Record<string, unknown>): boolean {
  return typeof value.fingerprint === "string" && value.fingerprint === fingerprintPayload(value);
}

export function writePrettyJson(path: string, value: unknown): void {
  validateCanonicalProfile(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
