import { lstatSync, readFileSync } from "node:fs";

function ownerMode(path, kind) {
  let info;
  try { info = lstatSync(path); } catch { throw new Error(`MEDIACRAWLER_${kind}_MISSING`); }
  if (info.isSymbolicLink()) throw new Error(`MEDIACRAWLER_${kind}_MUST_NOT_BE_SYMLINK`);
  return info;
}
export function readMediaCrawlerServiceSecret(secretFile) {
  const info = ownerMode(secretFile, "SECRET_FILE");
  if (!info.isFile()) throw new Error("MEDIACRAWLER_SECRET_FILE_MUST_BE_REGULAR");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("MEDIACRAWLER_SECRET_FILE_PERMISSIONS_MUST_BE_OWNER_ONLY");
  }
  const secret = readFileSync(secretFile, "utf8");
  if (/\s/u.test(secret)) throw new Error("MEDIACRAWLER_SECRET_MUST_BE_WHITESPACE_FREE");
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("MEDIACRAWLER_SECRET_TOO_SHORT");
  return secret;
}

export function assertMediaCrawlerHostPrerequisites({ secretFile, stateDirectory }) {
  readMediaCrawlerServiceSecret(secretFile);
  const state = ownerMode(stateDirectory, "STATE_DIRECTORY");
  if (!state.isDirectory()) throw new Error("MEDIACRAWLER_STATE_MUST_BE_DIRECTORY");
  if (process.platform !== "win32" && (state.mode & 0o777) !== 0o700) {
    throw new Error("MEDIACRAWLER_STATE_PERMISSIONS_MUST_BE_0700");
  }
  return Object.freeze({ secretFile, stateDirectory });
}

function serviceNetworks(service) {
  if (Array.isArray(service?.networks)) return service.networks;
  return Object.keys(service?.networks ?? {});
}

export function validateMediaCrawlerComposeConfig(configuration) {
  const services = configuration?.services ?? {};
  const media = services["media-crawler"];
  if (!media) throw new Error("MEDIACRAWLER_SERVICE_MISSING");
  if ((media.ports?.length ?? 0) > 0 || (media.expose?.length ?? 0) > 0) {
    throw new Error("MEDIACRAWLER_MUST_NOT_PUBLISH_PORTS");
  }
  if (media.read_only !== true) throw new Error("MEDIACRAWLER_ROOT_FILESYSTEM_MUST_BE_READ_ONLY");
  if (!serviceNetworks(media).includes("shensi_mediacrawler")
    || configuration.networks?.shensi_mediacrawler?.internal !== true) {
    throw new Error("MEDIACRAWLER_PRIVATE_NETWORK_REQUIRED");
  }
  if (!serviceNetworks(services.backend).includes("shensi_mediacrawler")) {
    throw new Error("BACKEND_MEDIACRAWLER_NETWORK_REQUIRED");
  }
  if (serviceNetworks(services.gateway).includes("shensi_mediacrawler")) {
    throw new Error("GATEWAY_MUST_NOT_ROUTE_MEDIACRAWLER");
  }
  const secrets = Array.isArray(media.secrets) ? media.secrets : [];
  const hasSecret = secrets.some((value) => {
    if (value === "mediacrawler_service_secret") return true;
    return value?.source === "mediacrawler_service_secret"
      && value?.target === "/run/secrets/mediacrawler_service_secret";
  });
  if (!hasSecret) throw new Error("MEDIACRAWLER_SECRET_MOUNT_REQUIRED");
}
