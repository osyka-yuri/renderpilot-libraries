export function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, context) {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain object`);
  }

  return value;
}

export function requiredNonEmptyString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }

  return value.trim();
}

export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function deepFreeze(obj) {
  const propNames = Reflect.ownKeys(obj);
  for (const name of propNames) {
    const value = obj[name];
    if ((value && typeof value === "object") || typeof value === "function") {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}
