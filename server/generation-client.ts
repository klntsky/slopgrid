import { request } from "node:http";
import { StringDecoder } from "node:string_decoder";
import {
  generationProtocol,
  generationError,
  generationFailure,
  type GenerationAPI,
} from "./generation-api.js";

export function generationClient(socketPath: string): GenerationAPI {
  function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method,
          path,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("error", () =>
            reject(
              generationFailure(
                "UNAVAILABLE",
                "Generation service is unavailable.",
              ),
            ),
          );
          res.on("end", () => {
            try {
              if (
                res.headers["x-generation-protocol"] !==
                String(generationProtocol)
              )
                throw new Error("Incompatible generation protocol");
              const value = JSON.parse(text);
              if (res.statusCode !== 200) {
                const failure = generationError.parse(value);
                reject(generationFailure(failure.code, failure.error));
              } else resolve(value as T);
            } catch {
              reject(
                generationFailure(
                  "UNAVAILABLE",
                  "Generation service is unavailable.",
                ),
              );
            }
          });
        },
      );
      req.setTimeout(10000, () => req.destroy());
      req.on("error", () =>
        reject(
          generationFailure(
            "UNAVAILABLE",
            "Generation service is unavailable.",
          ),
        ),
      );
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return {
    startGrid: (body) => call("POST", "/v1/grids/start", body),
    pauseGrid: (body) => call("POST", "/v1/grids/pause", body),
    getGrid: (id) => call("GET", `/v1/grids/${encodeURIComponent(id)}`),
    previewPath: async (body) =>
      (await call<{ path: string | null }>("POST", "/v1/previews/path", body))
        .path ?? undefined,
    status: () => call("GET", "/v1/status"),
    drain: () => call("POST", "/v1/drain"),
    accept: () => call("POST", "/v1/accept"),
    subscribeGrid(id, snapshot, disconnected) {
      let closed = false;
      const ended = () => {
        if (!closed) {
          closed = true;
          disconnected();
        }
      };
      const req = request(
        { socketPath, path: `/v1/grids/${encodeURIComponent(id)}/events` },
        (res) => {
          if (
            res.statusCode !== 200 ||
            res.headers["x-generation-protocol"] !== String(generationProtocol)
          ) {
            res.destroy();
            ended();
            return;
          }
          const decoder = new StringDecoder("utf8");
          let pending = "";
          res.on("data", (chunk: Buffer) => {
            pending += decoder.write(chunk);
            let newline: number;
            while (!closed && (newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (line) {
                try {
                  snapshot(JSON.parse(line));
                } catch {
                  req.destroy();
                  ended();
                }
              }
            }
          });
          res.on("end", ended);
          res.on("error", ended);
        },
      );
      req.on("error", ended);
      req.end();
      return () => {
        closed = true;
        req.destroy();
      };
    },
  };
}
