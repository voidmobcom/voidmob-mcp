import { z } from "zod";

/**
 * Output schemas are the response-parsing schemas made loose at every level:
 * the JSON Schema a client sees never sets additionalProperties:false, so a
 * field added to a result later cannot break a client that validates it.
 * structuredContent is built from values parsed with the strict originals, so
 * it matches by construction. Defaults are unwrapped because parsed output
 * always carries the value.
 */
export function loose(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema.shape)) shape[key] = loose(value as z.ZodType);
    return z.looseObject(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(loose(schema.element as z.ZodType));
  if (schema instanceof z.ZodOptional) return loose(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodNullable) return loose(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodDefault) return loose(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodRecord) return z.record(z.string(), loose(schema.valueType as z.ZodType));
  return schema;
}

/** A loose top-level output object; each value is made loose too. */
export function outputObject(shape: Record<string, z.ZodType>): z.ZodType {
  return loose(z.object(shape));
}
