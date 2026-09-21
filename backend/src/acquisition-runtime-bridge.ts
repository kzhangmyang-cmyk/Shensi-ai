import type {
  NextFunction,
  Request,
  RequestHandler,
  Response
} from "express";

export interface AcquisitionHttpRuntime {
  handler: RequestHandler;
  close(): Promise<void>;
}

function isAcquisitionPath(path: string) {
  return path === "/api/v1/acquisition"
    || path.startsWith("/api/v1/acquisition/");
}

export class AcquisitionRuntimeBridge {
  #runtime: AcquisitionHttpRuntime | null = null;

  install(runtime: AcquisitionHttpRuntime) {
    if (this.#runtime) {
      throw new Error("Acquisition runtime is already installed");
    }
    if (!runtime || typeof runtime.handler !== "function"
      || typeof runtime.close !== "function") {
      throw new TypeError("Invalid acquisition runtime");
    }
    this.#runtime = runtime;
  }

  middleware(): RequestHandler {
    return (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (!isAcquisitionPath(req.path)) {
        next();
        return;
      }
      const runtime = this.#runtime;
      if (!runtime) {
        res.setHeader("Cache-Control", "no-store");
        res.status(503).json({
          error: {
            code: "acquisition_runtime_unavailable",
            message: "AI 获客服务尚未就绪"
          }
        });
        return;
      }
      try {
        runtime.handler(req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }

  async close() {
    const runtime = this.#runtime;
    if (!runtime) return;
    this.#runtime = null;
    await runtime.close();
  }
}
