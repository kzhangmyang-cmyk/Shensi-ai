type PerFileSignOptions = {
  entitlements?: string | string[];
  hardenedRuntime?: boolean;
  [key: string]: unknown;
};

type ReleaseSignOptions = {
  app: string;
  optionsForFile?: (filePath: string, ...context: unknown[]) => PerFileSignOptions;
  [key: string]: unknown;
};

export function createReleaseSignOptions(configuration: ReleaseSignOptions): ReleaseSignOptions;
export function sign(configuration: ReleaseSignOptions): Promise<void>;
