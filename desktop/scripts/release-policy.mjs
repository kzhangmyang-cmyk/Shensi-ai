const PACKAGE_MODES = new Set(["development", "release"]);
const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "api.example.com",
  "localhost",
]);

export function normalizePackageMode(value) {
  const mode = value ?? "development";
  if (!PACKAGE_MODES.has(mode)) throw new Error("SHENSI_PACKAGE_MODE must be development or release");
  return mode;
}

export function validateRemoteOrigin(value, release) {
  if (!value) throw new Error("SHENSI_REMOTE_ORIGIN is required for macOS packaging");
  let origin;
  try { origin = new URL(value); }
  catch { throw new Error("SHENSI_REMOTE_ORIGIN must be a valid origin"); }
  if (origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash
    || origin.origin !== value.replace(/\/$/u, "")) {
    throw new Error("SHENSI_REMOTE_ORIGIN must be an exact credential-free origin");
  }
  const isHttps = origin.protocol === "https:";
  const isDevelopmentLoopback = !release && origin.protocol === "http:"
    && origin.hostname === "127.0.0.1" && origin.port !== "";
  if (!isHttps && !isDevelopmentLoopback) {
    throw new Error(release
      ? "release SHENSI_REMOTE_ORIGIN must be an exact HTTPS origin"
      : "SHENSI_REMOTE_ORIGIN must use HTTPS or exact IPv4 loopback HTTP with a port");
  }
  if (PLACEHOLDER_HOSTS.has(origin.hostname)
    || origin.hostname.endsWith(".example") || origin.hostname.endsWith(".invalid")
    || origin.hostname.endsWith(".test") || origin.hostname.endsWith(".localhost")) {
    throw new Error("SHENSI_REMOTE_ORIGIN must not be a placeholder origin");
  }
  return origin.origin;
}

export function validateReleaseEnvironment(environment) {
  const remoteOrigin = validateRemoteOrigin(environment.SHENSI_REMOTE_ORIGIN, true);
  if (!environment.CSC_NAME && !environment.CSC_LINK) {
    throw new Error("release packaging requires a Developer ID signing identity via CSC_NAME or CSC_LINK");
  }
  const notaryProfile = environment.SHENSI_NOTARYTOOL_KEYCHAIN_PROFILE;
  if (!notaryProfile || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u.test(notaryProfile)) {
    throw new Error("release packaging requires a valid notarytool keychain profile name");
  }
  return { remoteOrigin, notaryProfile };
}
