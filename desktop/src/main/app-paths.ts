import { isAbsolute, join, resolve } from "node:path";

export interface AppPaths {
  userData: string;
  logs: string;
  profiles: string;
  cache: string;
  temp: string;
  installation: string;
  deviceCredentials: string;
  outreachJournal: string;
}

export interface AppPathsInput {
  baseUserData: string;
  environment: "development" | "production" | "test";
  testId?: string;
}

export function createAppPaths(input: AppPathsInput): AppPaths {
  if (!isAbsolute(input.baseUserData)) throw new TypeError("baseUserData must be absolute");
  if (input.environment !== "test" && input.testId !== undefined)
    throw new TypeError("testId is accepted only in test mode");
  const suffix = input.environment === "production" ? ["Shensi"]
    : input.environment === "development" ? ["Shensi Development"]
      : ["Shensi Test", input.testId ?? "default"];
  if (suffix.some((item) => !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/u.test(item)))
    throw new TypeError("unsafe app path segment");
  const userData = resolve(input.baseUserData, ...suffix);
  return { userData, logs: join(userData, "logs"), profiles: join(userData, "profiles"),
    cache: join(userData, "cache"), temp: join(userData, "temp"),
    installation: join(userData, "device-installation"),
    deviceCredentials: join(userData, "device-credentials"),
    outreachJournal: join(userData, "outreach-journal") };
}
