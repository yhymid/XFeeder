"use strict";

const { CONFIG_SCHEMA_V2 } = require("./config-schema-v2");
const MAX_ERRORS = 50;
const MAX_DEPTH = 48;

const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value);
const append = (path, name) =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? (path ? path + "." + name : name)
    : (path ? path : "") + "[" + JSON.stringify(name) + "]";
const issue = (path, code, message) => ({ path: path || "$", code, message });

function validateV2(config) {
  const errors = [];
  function fail(path, code, message) {
    if (errors.length < MAX_ERRORS) errors.push(issue(path, code, message));
  }
  function dereference(schema) {
    if (!schema.$ref) return schema;
    const name = schema.$ref.slice("#/$defs/".length);
    return CONFIG_SCHEMA_V2.$defs[name];
  }
  function check(data, schema, path = "", depth = 0) {
    if (errors.length >= MAX_ERRORS) return;
    if (depth > MAX_DEPTH) {
      fail(path, "too_deep", "Maximum configuration nesting exceeded");
      return;
    }
    schema = dereference(schema);
    if (!schema) { fail(path, "invalid_schema", "Unknown schema reference"); return; }
    if (schema.oneOf) {
      // Discriminator-based selection gives precise field errors instead of
      // one opaque oneOf error at channels.<name>.sources[<index>].
      const tag = data?.type;
      const selected = schema.oneOf.map(dereference)
        .find(option => option.properties?.type?.const === tag);
      if (!selected) {
        fail(append(path, "type"), tag === undefined ? "required" : "invalid_enum",
          "Expected a supported source or destination type");
      } else check(data, selected, path, depth + 1);
      return;
    }
    if (Object.hasOwn(schema, "const") && data !== schema.const) {
      fail(path, "invalid_enum", "Unexpected field value");
      return;
    }
    if (schema.type) {
      const matches = schema.type === "object" ? plain(data)
        : schema.type === "array" ? Array.isArray(data)
        : schema.type === "integer" ? Number.isSafeInteger(data)
        : schema.type === "number" ? typeof data === "number" && Number.isFinite(data)
        : typeof data === schema.type;
      if (!matches) {
        fail(path, "invalid_type", "Expected " + schema.type);
        return;
      }
    }
    if (schema.type === "string") {
      if (schema.minLength !== undefined && data.length < schema.minLength)
        fail(path, "too_short", "Expected a non-empty string");
      if (schema.pattern && !(new RegExp(schema.pattern).test(data)))
        fail(path, "invalid_name", "Invalid configuration field name");
      if (schema.format === "http-url") {
        // Environment references remain unresolved in schema validation.
        // Secret substitution and runtime URL policy are separate boundaries.
        const reference = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(data);
        let valid = reference;
        if (!valid) {
          try {
            const target = new URL(data);
            valid = ["http:", "https:"].includes(target.protocol) &&
              Boolean(target.hostname) && !target.username && !target.password;
          } catch { valid = false; }
        }
        if (!valid) fail(path, "invalid_url", "Expected an http or https URL");
      }
    }
    if (schema.type === "integer") {
      if (schema.minimum !== undefined && data < schema.minimum)
        fail(path, "out_of_range", "Number is below the allowed minimum");
      if (schema.maximum !== undefined && data > schema.maximum)
        fail(path, "out_of_range", "Number exceeds the allowed maximum");
    }
    if (schema.type === "array") {
      if (schema.minItems && data.length < schema.minItems)
        fail(path, "too_few_items", "Array must not be empty");
      for (let n = 0; n < data.length; n++)
        check(data[n], schema.items, path + "[" + n + "]", depth + 1);
    }
    if (schema.type === "object") {
      if (schema.required) for (const key of schema.required)
        if (!Object.hasOwn(data, key))
          fail(append(path, key), "required", "Required field is missing");
      for (const key of Object.keys(data)) {
        const child = schema.properties?.[key];
        if (child) { check(data[key], child, append(path, key), depth + 1); continue; }
        if (schema.propertyNames && !(new RegExp(schema.propertyNames.pattern).test(key))) {
          fail(append(path, key), "invalid_name", "Invalid channel identifier");
          continue;
        }
        if (schema.additionalProperties === false) {
          fail(append(path, key), "unknown_field", "Unsupported configuration field");
        } else if (plain(schema.additionalProperties)) {
          check(data[key], schema.additionalProperties, append(path, key), depth + 1);
        }
      }
    }
  }
  check(config, CONFIG_SCHEMA_V2);
  return { ok: errors.length === 0, schemaVersion: 2, errors };
}

function validateConfigSchema(config) {
  if (!plain(config)) return {
    ok: false, schemaVersion: null,
    errors: [issue("$", "invalid_type", "Config root must be a JSON object")],
  };
  const version = config.schemaVersion;
  if (version === undefined || version === 1)
    return { ok: true, schemaVersion: 1, legacy: true, errors: [] };
  if (version !== 2)
    return { ok: false, schemaVersion: version, errors: [
      issue("schemaVersion", "unsupported_version", "Unsupported configuration schema version"),
    ] };
  return validateV2(config);
}

class ConfigSchemaError extends Error {
  constructor(errors, code = "INVALID_CONFIG_SCHEMA") {
    super(errors.map(error => error.path + ": " + error.message).join("; "));
    this.name = "ConfigSchemaError";
    this.code = code;
    this.errors = errors;
  }
}

// V2 is validated before converting to a strictly equivalent legacy runtime
// shape; unsupported v2 combinations fail closed instead of disappearing.
function assertRuntimeConfigSchema(config) {
  const result = validateConfigSchema(config);
  if (!result.ok) throw new ConfigSchemaError(result.errors);
  return result.schemaVersion === 2
    ? require("./config-migration").toLegacyRuntime(config) : config;
}

module.exports = {
  CONFIG_SCHEMA_V2, validateConfigSchema, assertRuntimeConfigSchema,
  ConfigSchemaError,
};
