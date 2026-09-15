# Canonical JSON and Fingerprints

Profile: `cej-ascii-integer.v1`.

The public schema deliberately uses a deterministic JSON subset:

- UTF-8 input and ASCII-only keys/string values;
- objects, arrays, strings, booleans, null, and integers only;
- no floating JSON numbers, NaN, infinity, negative zero, duplicate keys, or integers outside JavaScript's exact safe range;
- fixed schema fields only; arbitrary metadata is forbidden.

Canonical bytes are produced by recursively sorting object keys lexicographically, emitting no insignificant whitespace, using JSON lowercase literals, and using standard JSON string escaping with ASCII output. The TypeScript engine implements the profile as:

```typescript
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
```

## Receipt fingerprint

1. Remove the top-level `fingerprint` field.
2. Canonicalize the remaining receipt with `cej-ascii-integer.v1`.
3. Compute SHA-256 over those exact bytes.
4. Serialize lowercase as `sha256:` followed by 64 hexadecimal characters.

Key reordering and pretty-printing do not change a fingerprint. Any semantic field change does. Fingerprints are integrity identifiers, not cryptographic signatures or identity attestations.
