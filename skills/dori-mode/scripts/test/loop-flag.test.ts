import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("watch commands refuse a --loop that is not a number of minutes instead of polling back to back", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const invoke = (...args: string[]) =>
      run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args], { timeoutMs: 10_000 });
    for (const [command, value] of [["guard", "5m"], ["dead-panes", "abc"], ["freshness", "-1"], ["guard", "Infinity"]] as const) {
      const r = await invoke(command, "--loop", value);
      expect({ command, value, code: r.code, err: r.err, out: r.out }).toEqual({
        command, value, code: 1, err: "--loop must be a number of minutes, 0 or more", out: "",
      });
    }
    for (const args of [["guard", "--loop", "0"], ["guard"]]) {
      const r = await invoke(...args);
      expect(r.code).toBe(0);
      expect(r.out).toStartWith("HOST_GUARD_READY");
    }
  } finally { state.done(); }
}, 60_000);
