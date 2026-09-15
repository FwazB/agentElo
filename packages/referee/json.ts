/** JSON with Unicode support, bounded nesting, and no ambiguous duplicate keys. */
export function parseRefereeJson(source: string): unknown {
  let offset = 0;
  const fail = (): never => { throw new Error("Input is not unambiguous valid JSON."); };
  const whitespace = (): void => { while (/[ \t\r\n]/.test(source[offset] ?? "")) offset++; };

  function string(): string {
    if (source[offset] !== '"') fail();
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        try { return JSON.parse(source.slice(start, offset)) as string; } catch { fail(); }
      }
    }
    return fail();
  }

  function value(depth: number): unknown {
    if (depth > 64) throw new Error("Input JSON exceeds the nesting limit.");
    whitespace();
    const char = source[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      whitespace();
      if (source[offset] === "}") { offset++; return result; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("Input JSON contains a duplicate object key.");
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") fail();
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = source[offset++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail();
      }
    }
    if (char === "[") {
      offset++;
      const result: unknown[] = [];
      whitespace();
      if (source[offset] === "]") { offset++; return result; }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = source[offset++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") fail();
      }
    }
    for (const [token, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(token, offset)) { offset += token.length; return literal; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
    if (!number) return fail();
    offset += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isFinite(parsed)) fail();
    return parsed;
  }

  const result = value(0);
  whitespace();
  if (offset !== source.length) fail();
  return result;
}
