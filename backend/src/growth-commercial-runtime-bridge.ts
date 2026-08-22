import type {
  NextFunction,
  Request,
  RequestHandler,
  Response
} from "express";
import type {
  GrowthCommercialRuntime
} from "./growth-commercial-application.js";

const acquisitionGrowthPrefixes = [
  "/api/v1/acquisition/cost-entries",
  "/api/v1/acquisition/cost-estimates",
  "/api/v1/acquisition/attribution-allocation-sets",
  "/api/v1/acquisition/cohorts",
  "/api/v1/acquisition/roi-closures",
  "/api/v1/acquisition/growth-performance",
  "/api/v1/acquisition/advisor"
] as const;

function hasPathPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isGrowthPath(path: string) {
  return [
    "/api/v1/growth",
    "/api/v1/catalog",
    "/api/v1/quotes",
    "/api/v1/finance"
  ].some((prefix) => hasPathPrefix(path, prefix))
    || acquisitionGrowthPrefixes.some((prefix) =>
      hasPathPrefix(path, prefix));
}

export class GrowthCommercialRuntimeBridge {
  #runtime: GrowthCommercialRuntime<object> | null = null;
  #installed = false;
  #closePromise: Promise<void> | null = null;

  install(runtime: GrowthCommercialRuntime<object>): void {
    if (this.#closePromise) {
      throw new Error("Growth commercial runtime bridge is closed");
    }
    if (this.#installed) {
      throw new Error("Growth commercial runtime is already installed");
    }
    if (
      !runtime
      || typeof runtime.handler !== "function"
      || typeof runtime.close !== "function"
      || !runtime.toolPorts
      || !runtime.integrations
    ) {
      throw new TypeError("Invalid Growth commercial runtime");
    }
    this.#installed = true;
    this.#runtime = runtime;
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!isGrowthPath(req.path)) {
        next();
        return;
      }
      const runtime = this.#runtime;
      if (!runtime) {
        res.setHeader("Cache-Control", "no-store");
        res.status(503).json({ code: "GROWTH_RUNTIME_NOT_READY" });
        return;
      }
      try {
        runtime.handler(req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#closePromise = runtime ? runtime.close() : Promise.resolve();
    return this.#closePromise;
  }
}
