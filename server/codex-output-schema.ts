import { isRecord } from "./codex-items";

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SUBSCHEMAS = ["items", "prefixItems", "additionalItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"];

function isObject(schema: Record<string, unknown>): boolean {
  return isRecord(schema.properties) || schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
}

function normalize(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((entry, index) => normalize(entry, `${path}[${index}]`));
  if (!isRecord(value)) return value;
  const schema = { ...value };
  for (const key of SCHEMA_MAPS) {
    if (isRecord(value[key])) schema[key] = Object.fromEntries(Object.entries(value[key]).map(([name, child]) => [name, normalize(child, `${path}.${key}.${name}`)]));
  }
  for (const key of SUBSCHEMAS) if (key in value) schema[key] = normalize(value[key], `${path}.${key}`);
  if (isObject(schema)) {
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error(`Codex structured outputs require ${path}.additionalProperties to be false`);
    schema.additionalProperties = false;
    if (isRecord(schema.properties)) schema.required = [...new Set([
      ...(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []), ...Object.keys(schema.properties),
    ])];
  }
  return schema;
}

export function normalizeCodexOutputSchema(value: unknown): Record<string, unknown> {
  const schema = normalize(value, "$");
  if (!isRecord(schema) || !isObject(schema)) throw new Error("Codex structured outputs require a root object schema");
  return schema;
}
