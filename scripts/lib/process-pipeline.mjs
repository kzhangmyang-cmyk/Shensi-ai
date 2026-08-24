import { spawn } from "node:child_process";

function stageError(stage, suffix) {
  return new Error(`PIPELINE_${stage.toUpperCase()}_${suffix}`);
}

function spawnStage(stage, stdout) {
  return spawn(stage.command, stage.args ?? [], {
    cwd: stage.cwd,
    env: stage.env,
    stdio: ["pipe", stdout, "ignore"]
  });
}

export async function runPipeline({
  source,
  destination,
  output = "ignore",
  signalEmitter = process,
  signals = ["SIGINT", "SIGTERM"]
}) {
  const left = spawnStage(source, "pipe");
  const right = spawnStage(destination, output);
  const children = [left, right];
  let failure;

  const terminate = (except) => {
    for (const child of children) {
      if (child !== except && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
  };
  const fail = (error, child) => {
    if (!failure) failure = error;
    terminate(child);
  };
  const signalHandlers = new Map(signals.map((signal) => [signal, () => {
    fail(stageError("signal", signal), undefined);
  }]));
  for (const [signal, handler] of signalHandlers) signalEmitter.on(signal, handler);
  const observe = (child, stage) => new Promise((resolve) => {
    child.once("error", () => {
      fail(stageError(stage, "SPAWN"), child);
    });
    child.once("close", (code, signal) => {
      if (code !== 0 && !failure) {
        fail(stageError(stage, signal ? `SIGNAL:${signal}` : `EXIT:${code}`), child);
      }
      resolve();
    });
  });

  if (!left.stdout || !right.stdin) {
    fail(stageError("STREAM", "UNAVAILABLE"), undefined);
  } else {
    right.stdin.on("error", () => {});
    left.stdout.pipe(right.stdin);
  }

  try {
    await Promise.all([
      observe(left, "source"),
      observe(right, "destination")
    ]);
  } finally {
    for (const [signal, handler] of signalHandlers) signalEmitter.off(signal, handler);
  }
  if (failure) throw failure;
}
