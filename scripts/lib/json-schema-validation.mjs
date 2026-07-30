import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export function compileJsonSchema(schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    // Existing catalog schemas are not yet strict-clean.
    strict: false,
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function assertJsonSchema(value, validate, context) {
  if (validate(value)) return value;
  const details = (validate.errors ?? [])
    .map((error) => {
      const location = error.instancePath || "/";
      const parameters =
        error.params && Object.keys(error.params).length !== 0
          ? ` — ${JSON.stringify(error.params)}`
          : "";
      return `${location} ${error.message ?? "schema validation failed"}${parameters}`;
    })
    .join("; ");
  throw new Error(
    `${context} failed JSON Schema validation: ${details || "unknown error"}`,
  );
}
