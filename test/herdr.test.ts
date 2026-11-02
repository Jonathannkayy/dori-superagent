import { describe, expect, test } from "bun:test";
import { Herdr, HerdrError, shq, type Exec, type ExecResult } from "../src/herdr.ts";

// A recorder in place of the herdr binary: every argv is kept, and each reply is chosen per call.
function recorder(reply: (argv: readonly string[]) => ExecResult = () => ok({})) {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv) => {
    expect(cmd).toBe("herdr");
    calls.push(argv);
    return reply(argv);
  };
  return { calls, exec };
}
const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const fail = (stderr: string, stdout = ""): ExecResult => ({ code: 1, stdout, stderr });
const pane = { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" };

describe("herdr argv", () => {
  test("a named session goes in front of every call, pane read included; no session adds nothing", async () => {
    const named = recorder(() => ok({}));
    const h = new Herdr(named.exec, "iso");
    await h.run("w1:p1", "omo");
    await h.read("w1:p1", 40);
    await h.close("w1:p1");
    expect(named.calls).toEqual([
      ["--session", "iso", "pane", "run", "w1:p1", "omo"],
      ["--session", "iso", "pane", "read", "w1:p1", "--lines", "40", "--source", "recent"],
      ["--session", "iso", "pane", "close", "w1:p1"],
    ]);
    const plain = recorder();
    await new Herdr(plain.exec, "").read("w1:p1");
    expect(plain.calls).toEqual([["pane", "read", "w1:p1", "--lines", "80", "--source", "recent"]]);
  });

  test("workspace, tab and split never take focus, and pass workspace and env as flags", async () => {
    const r = recorder((argv) => ok(argv[1] === "split" ? { pane } : { root_pane: pane }));
    const h = new Herdr(r.exec, "");
    expect(await h.createWorkspace("dori", "/w")).toEqual({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" });
    await h.createTab("fix-login", "/w", "w3", { DORI_LANE: "fix-login", NOTE: "a b" });
    await h.createTab("other", "/w");
    await h.split("w1:p1", "/w", { DORI_ROLE: "duty" });
    expect(r.calls).toEqual([
      ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
      ["tab", "create", "--label", "fix-login", "--cwd", "/w", "--no-focus", "--workspace", "w3", "--env", "DORI_LANE=fix-login", "--env", "NOTE=a b"],
      ["tab", "create", "--label", "other", "--cwd", "/w", "--no-focus"],
      ["pane", "split", "w1:p1", "--direction", "down", "--ratio", "0.3", "--cwd", "/w", "--no-focus", "--env", "DORI_ROLE=duty"],
    ]);
  });

  test("a message is one argv element, delivered verbatim: quotes, $(...) and newlines are never expanded", async () => {
    const r = recorder();
    const h = new Herdr(r.exec, "");
    const text = `it's "done" $(rm -rf ~) \`id\`\nline two`;
    await h.deliver("w1:p1", text, "idle");
    await h.deliver("w1:p9", text, "shell");
    expect(r.calls).toEqual([
      ["agent", "prompt", "w1:p1", text],
      ["pane", "send-text", "w1:p9", text],
      ["pane", "send-keys", "w1:p9", "enter"],
    ]);
  });
});

describe("herdr replies", () => {
  test("a create that returns no pane id throws instead of handing back an empty pane", async () => {
    const h = new Herdr(recorder(() => ok({ root_pane: { tab_id: "w1:t2" } })).exec, "");
    await expect(h.createTab("x", "/w")).rejects.toThrow("herdr did not return a pane id");
  });

  test("a failed call throws HerdrError with herdr's own reason, from stderr or else stdout", async () => {
    const onStdout = new Herdr(recorder(() => fail("", '{"error":{"code":"pane_not_found"}}\n')).exec, "iso");
    const e = await onStdout.close("w1:p7").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HerdrError);
    expect((e as HerdrError).message).toBe('herdr --session iso pane close w1:p7 failed (1): {"error":{"code":"pane_not_found"}}');
    const onStderr = new Herdr(recorder(() => fail("socket closed", "partial")).exec, "");
    await expect(onStderr.read("w1:p7")).rejects.toThrow("failed (1): socket closed");
  });

  test("a successful call whose output is not JSON reads as an empty result", async () => {
    const h = new Herdr(recorder(() => ({ code: 0, stdout: "ok\n", stderr: "" })).exec, "");
    await expect(h.run("w1:p1", "omo")).resolves.toBeUndefined();
  });

  test("status: pane_not_found is gone, but a herdr server that is down is an error, never a lost pane", async () => {
    const status = (reply: ExecResult) => new Herdr(recorder(() => reply).exec, "").status("w1:p1");
    expect(await status(fail('{"error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}'))).toBe("gone");
    expect(await status(ok({}))).toBe("gone");
    await expect(status(fail('{"error":{"code":"server_not_running","message":"no herdr server is running"}}'))).rejects.toThrow(
      "server_not_running",
    );
  });

  test("status: no agent is a shell; herdr's four states pass through and anything else is unknown", async () => {
    const status = (p: Record<string, unknown>) => new Herdr(recorder(() => ok({ pane: p })).exec, "").status("w1:p1");
    expect(await status({ agent: null, agent_status: "idle" })).toBe("shell");
    for (const s of ["idle", "working", "blocked", "done"] as const) expect(await status({ agent: "omo", agent_status: s })).toBe(s);
    expect(await status({ agent: "omo", agent_status: "compacting" })).toBe("unknown");
    expect(await status({ agent: "omo" })).toBe("unknown");
  });
});

describe("shq", () => {
  test("a quoted word reaches a real shell unchanged, single quotes and $ included", async () => {
    for (const s of ["plain", "two words", "it's", "''", "$HOME `id` $(echo x)", "back\\slash", "new\nline", ""]) {
      const proc = Bun.spawn(["sh", "-c", `printf %s ${shq(s)}`], { stdout: "pipe" });
      expect(await new Response(proc.stdout).text()).toBe(s);
    }
  });
});
