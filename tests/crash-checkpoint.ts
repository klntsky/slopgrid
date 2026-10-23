import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface CrashCheckpoint {
  paused: Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  resume(): Promise<void>;
  close(): void;
}

/** Stop the actual engine at a persistence boundary without replacing its code. */
export async function crashCheckpoint(
  child: ChildProcess,
  file: string,
  statement: string,
  condition?: string,
): Promise<CrashCheckpoint> {
  const opened = once(child, "message");
  child.send({ inspect: true });
  const [url] = await opened;
  const socket = new WebSocket(String(url));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Inspector connection failed")),
      { once: true },
    );
  });
  let sequence = 0,
    stopped!: () => void,
    callFrameId: string | undefined;
  let timeout: ReturnType<typeof setTimeout>;
  const paused = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Engine did not reach checkpoint: ${statement}`)),
      5000,
    );
    stopped = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  // Report setup errors through the caller without an unhandled checkpoint rejection.
  void paused.catch(() => {});
  const requests = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >();
  const scripts: { scriptId: string; url: string }[] = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    if (value.id) {
      const request = requests.get(value.id)!;
      requests.delete(value.id);
      if (value.error) request.reject(new Error(value.error.message));
      else request.resolve(value.result);
    } else if (value.method === "Debugger.scriptParsed")
      scripts.push(value.params);
    else if (value.method === "Debugger.paused") {
      callFrameId = value.params.callFrames[0].callFrameId;
      stopped();
    }
  });
  const send = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await send("Debugger.enable");
    const script = scripts.find((script) =>
      script.url.endsWith(`/server/${file}`),
    );
    if (!script) throw new Error(`Engine has not loaded ${file}`);
    // tsx transforms source before execution; locate the statement in the actual
    // script rather than assuming source-map line numbers match V8 locations.
    const { scriptSource } = await send("Debugger.getScriptSource", {
      scriptId: script.scriptId,
    });
    const index = scriptSource.indexOf(statement);
    if (index < 0 || scriptSource.indexOf(statement, index + 1) >= 0)
      throw new Error(`Checkpoint must identify one statement: ${statement}`);
    const prefix = scriptSource.slice(0, index).split("\n");
    await send("Debugger.setBreakpoint", {
      location: {
        scriptId: script.scriptId,
        lineNumber: prefix.length - 1,
        columnNumber: prefix.at(-1)!.length,
      },
      condition,
    });
    return {
      paused,
      evaluate: async (expression: string) => {
        if (!callFrameId) throw new Error("Engine is not paused at checkpoint");
        const result = await send("Debugger.evaluateOnCallFrame", {
          callFrameId,
          expression,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text,
          );
        return result.result.value;
      },
      resume: async () => {
        callFrameId = undefined;
        await send("Debugger.resume");
      },
      close: () => {
        clearTimeout(timeout);
        socket.close();
      },
    };
  } catch (error) {
    clearTimeout(timeout!);
    socket.close();
    throw error;
  }
}
