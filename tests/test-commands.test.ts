import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommands } from "./test-commands.js";

test(
  "test commands run concurrently and wait for every command to settle",
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-test-commands-"));
    try {
      // Each command needs its peer to start before it can finish.
      const script = `const fs=require('node:fs'); const [own,peer]=process.argv.slice(1);
      fs.writeFileSync(own,'ready'); const limit=setTimeout(()=>process.exit(1),3000);
      const poll=setInterval(()=>{if(fs.existsSync(peer)){clearTimeout(limit);clearInterval(poll)}},5);`;
      const a = join(directory, "a"),
        b = join(directory, "b");
      assert.equal(
        await runCommands([
          [process.execPath, "-e", script, a, b],
          [process.execPath, "-e", script, b, a],
        ]),
        0,
      );
      const finished = join(directory, "finished");
      assert.equal(
        await runCommands([
          [process.execPath, "-e", "process.exit(7)"],
          [
            process.execPath,
            "-e",
            "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'done'),30)",
            finished,
          ],
        ]),
        7,
      );
      assert.equal(existsSync(finished), true);
      assert.notEqual(
        await runCommands([[join(directory, "missing-command")]]),
        0,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
