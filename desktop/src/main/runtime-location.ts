import path from "node:path";

export type RendererLocation = { kind: "static-gateway"; distDir: string };

export function rendererLocation(input: {
  production: boolean;
  resourcesPath: string;
  repositoryRoot?: string;
}): RendererLocation {
  if (input.production) {
    return { kind: "static-gateway", distDir: path.join(input.resourcesPath, "frontend") };
  }

  if (!input.repositoryRoot || !path.isAbsolute(input.repositoryRoot)
    || path.resolve(input.repositoryRoot) !== input.repositoryRoot) {
    throw new Error("desktop_repository_root_invalid");
  }
  return { kind: "static-gateway", distDir: path.join(input.repositoryRoot, "frontend", "dist-desktop") };
}

export function desktopExecutionPaths(input: {
  production: boolean;
  mainModuleDirectory: string;
  appPath: string;
}): { preloadPath: string; repositoryRoot: string | undefined } {
  if (input.production) {
    return {
      preloadPath: path.join(input.appPath, "dist", "preload", "preload.cjs"),
      repositoryRoot: undefined,
    };
  }
  const desktopRoot = path.resolve(input.mainModuleDirectory, "..", "..");
  return {
    preloadPath: path.join(desktopRoot, "dist", "preload", "preload.cjs"),
    repositoryRoot: path.resolve(desktopRoot, ".."),
  };
}
