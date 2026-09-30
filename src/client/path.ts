/**
 * Tagged template for API paths: every interpolated value is one encoded path
 * segment, so an id can never add segments, a query or a fragment
 * (`path`/v1/esims/${id}/usage``).
 */
export function path(strings: TemplateStringsArray, ...segments: string[]): string {
  let out = strings[0];
  segments.forEach((seg, i) => {
    out += encodeURIComponent(seg) + strings[i + 1];
  });
  return out;
}
