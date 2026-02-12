// ISO 3166-1 alpha-2 country codes (subset of most common)
const VALID_COUNTRIES = new Set([
  "US", "GB", "CA", "AU", "DE", "FR", "NL", "IT", "ES", "PT",
  "BR", "MX", "AR", "CO", "CL", "PE", "JP", "KR", "CN", "IN",
  "ID", "TH", "VN", "PH", "MY", "SG", "HK", "TW", "RU", "UA",
  "PL", "CZ", "RO", "SE", "NO", "DK", "FI", "AT", "CH", "BE",
  "IE", "NZ", "ZA", "EG", "NG", "KE", "IL", "TR", "SA", "AE",
]);

export function validateCountry(country: string): string {
  const upper = country.toUpperCase();
  if (!VALID_COUNTRIES.has(upper)) {
    throw new ToolError(
      `Invalid country code: ${country}. Use ISO 3166-1 alpha-2 (e.g., US, GB, JP).`
    );
  }
  return upper;
}

export function requireField(value: unknown, fieldName: string): void {
  if (value === undefined || value === null || value === "") {
    throw new ToolError(`Missing required field: ${fieldName}`);
  }
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

let counter = 0;
export function generateId(prefix: string): string {
  counter++;
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${rand}${counter}`;
}
