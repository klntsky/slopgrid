import { spawn } from "node:child_process";

// Wait for all suites, including their fixture teardown, before reporting failure.
export async function runCommands(
  commands: string[][],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const codes = await Promise.all(
    commands.map(
      ([program, ...args]) =>
        new Promise<number>((resolve) => {
          const child = spawn(program, args, {
            stdio: "inherit",
            env,
          });
          child.once("error", (error) => {
            console.error(error.message);
            resolve(1);
          });
          child.once("close", (code) => resolve(code ?? 1));
        }),
    ),
  );
  return codes.find((code) => code !== 0) ?? 0;
}
