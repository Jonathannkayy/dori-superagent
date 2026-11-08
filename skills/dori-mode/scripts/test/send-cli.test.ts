import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("send telegram refuses a --thread or --edit that is not a message id before it posts anything", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const send = (flag: string, value: string) =>
      run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, "DORI_TELEGRAM_TOKEN=123:not-a-real-token", process.execPath, cli,
        "send", "telegram", "--to", "-1001", "--text", "hello", flag, value], { timeoutMs: 20_000 });
    for (const [flag, value] of [["--thread", "telegram:-1001/42"], ["--thread", "abc"], ["--thread", "4.5"], ["--thread", "-3"], ["--edit", "last"]] as const) {
      const r = await send(flag, value);
      expect({ flag, value, code: r.code, err: r.err, out: r.out }).toEqual({
        flag, value, code: 1, err: `${flag} must be a Telegram ${flag === "--thread" ? "topic" : "message"} id, a whole number above 0`, out: "",
      });
    }
  } finally { state.done(); }
}, 120_000);
