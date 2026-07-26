/**
 * Compatibility facade for Microsoft NuGet tooling.
 *
 * Keep command scripts and tests importing this stable module while the
 * implementation stays separated into network, package, lock, and projection
 * domains.
 */
export * from "./microsoft-nuget-lock.mjs";
export * from "./microsoft-nuget-package.mjs";
export * from "./microsoft-nuget-projection.mjs";
export * from "./microsoft-nuget-registration.mjs";
