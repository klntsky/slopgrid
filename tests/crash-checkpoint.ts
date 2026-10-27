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
  signal?: AbortSignal,
): Promise<CrashCheckpoint> {
  signal?.throwIfAborted();
  const opened = once(child, "message", { signal });
  child.send({ inspect: true });
  const [url] = await opened;
  signal?.throwIfAborted();
  const socket = new WebSocket(String(url));
  const openedSocket = Promise.withResolvers<void>();
  const cleanupOpening = () => {
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("error", onError);
    signal?.removeEventListener("abort", onAbort);
  };
  const onOpen = () => {
    cleanupOpening();
    openedSocket.resolve();
  };
  const onError = () => {
    cleanupOpening();
    openedSocket.reject(new Error("Inspector connection failed"));
  };
  const onAbort = () => {
    cleanupOpening();
    openedSocket.reject(signal!.reason);
  };
  socket.addEventListener("open", onOpen, { once: true });
  socket.addEventListener("error", onError, { once: true });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    await openedSocket.promise;
  } catch (error) {
    socket.close();
    throw error;
  }
  let sequence = 0;
  let callFrameId: string | undefined;
  const checkpoint = Promise.withResolvers<void>();
  const paused = checkpoint.promise;
  const timeout = signal
    ? undefined
    : setTimeout(
        () =>
          closeWithError(
            new Error(`Engine did not reach checkpoint: ${statement}`),
          ),
        5000,
      );
  // Report setup errors through the caller without an unhandled checkpoint rejection.
  void paused.catch(() => {});
  const requests = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >();
  const scripts: { scriptId: string; url: string }[] = [];
  let closed = false;
  const closeWithError = (error: Error) => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", close);
    socket.removeEventListener("close", close);
    checkpoint.reject(error);
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    socket.close();
  };
  const close = () => closeWithError(new Error("Inspector checkpoint closed"));
  signal?.addEventListener("abort", close, { once: true });
  socket.addEventListener("close", close, { once: true });
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    if (value.id) {
      const request = requests.get(value.id);
      if (!request) return;
      requests.delete(value.id);
      if (value.error) request.reject(new Error(value.error.message));
      else request.resolve(value.result);
    } else if (value.method === "Debugger.scriptParsed")
      scripts.push(value.params);
    else if (value.method === "Debugger.paused") {
      callFrameId = value.params.callFrames[0].callFrameId;
      clearTimeout(timeout);
      checkpoint.resolve();
    }
  });
  const send = (method: string, params?: object) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Inspector checkpoint closed"));
    const request = Promise.withResolvers<any>();
    const id = ++sequence;
    requests.set(id, request);
    socket.send(JSON.stringify({ id, method, params }));
    return request.promise;
  };
  try {
    signal?.throwIfAborted();
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
    const { actualLocation } = await send("Debugger.setBreakpoint", {
      location: {
        scriptId: script.scriptId,
        lineNumber: prefix.length - 1,
        columnNumber: prefix.at(-1)!.length,
      },
      condition,
    });
    const actualIndex =
      scriptSource
        .split("\n")
        .slice(0, actualLocation.lineNumber)
        .reduce((length: number, line: string) => length + line.length + 1, 0) +
      actualLocation.columnNumber;
    if (actualIndex < index || actualIndex >= index + statement.length)
      throw new Error(
        `Inspector moved checkpoint outside statement: ${statement}`,
      );
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
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
