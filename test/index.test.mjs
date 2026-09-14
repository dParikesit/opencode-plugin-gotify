import assert from "node:assert/strict";
import { EventEmitter, on } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import plugin from "../dist/index.js";

const location = { directory: "/projects/example" };
let eventID = 0;
const event = (type, data, at = location) => ({
  id: `evt_${++eventID}`,
  created: Date.now(),
  type,
  location: at,
  data,
});

async function until(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for plugin activity");
    await delay(5);
  }
}

function environment(t, fileConfig, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "gotify-test-"));
  const saved = {
    HOME: process.env.HOME,
    GOTIFY_URL: process.env.GOTIFY_URL,
    GOTIFY_TOKEN: process.env.GOTIFY_TOKEN,
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, { HOME: home, ...env });
  if (fileConfig !== undefined) {
    const directory = join(home, ".config", "opencode");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "gotify-config.json"),
      typeof fileConfig === "string" ? fileConfig : JSON.stringify(fileConfig)
    );
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
}

async function harness(t, { options = {}, fileConfig, env, getSession, fetch: send } = {}) {
  environment(t, fileConfig, env);
  const emitter = new EventEmitter();
  const requests = [];
  const errors = [];
  const lookups = [];
  let subscriptions = 0;
  let signal;
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", (...args) => errors.push(args));
  t.mock.method(console, "error", (...args) => errors.push(args));
  t.mock.method(globalThis, "fetch", async (url, input) => {
    const request = { url: new URL(url), input, body: JSON.parse(input.body) };
    requests.push(request);
    return send ? send(request) : new Response("{}");
  });
  const cleanup = await plugin.setup({
    options: { url: "https://gotify.example.com/", token: "token", ...options },
    location: {
      ...location,
      project: { id: "project", directory: location.directory, canonical: location.directory },
    },
    session: {
      async get(input, requestOptions) {
        lookups.push(input);
        return getSession
          ? getSession(input, requestOptions)
          : { id: input.sessionID, title: "Example session", location };
      },
    },
    event: {
      subscribe(input) {
        signal = input.signal;
        subscriptions++;
        const stream = on(emitter, "event", { signal });
        return (async function* () {
          for await (const [value] of stream) yield value;
        })();
      },
    },
  });
  t.after(async () => cleanup?.());
  return {
    emit: (value) => emitter.emit("event", value),
    fail: () => emitter.emit("error", new Error("Disconnected")),
    cleanup,
    requests,
    errors,
    lookups,
    get signal() {
      return signal;
    },
    get subscriptions() {
      return subscriptions;
    },
    get notifications() {
      return requests.filter(({ body }) => !body.message.includes("pty_barrier"));
    },
    async drain() {
      const count = requests.length;
      emitter.emit("event", event("pty.exited", { id: "pty_barrier", exitCode: 0 }));
      await until(
        () => requests.length > count && requests.at(-1).body.message.includes("pty_barrier")
      );
    },
  };
}

test("V2 definition reports terminal outcomes without idle/interruption duplicates", async (t) => {
  assert.equal(plugin.id, "opencode-plugin-gotify");
  const h = await harness(t);
  h.emit(
    event("session.execution.failed", {
      sessionID: "ses_failed",
      error: { type: "provider.error", message: "Provider unavailable" },
    })
  );
  h.emit(event("session.idle", { sessionID: "ses_failed" }));
  h.emit(event("session.execution.interrupted", { sessionID: "ses_cancelled", reason: "user" }));
  h.emit(event("session.idle", { sessionID: "ses_cancelled" }));
  h.emit(event("session.execution.succeeded", { sessionID: "ses_success" }));
  await h.drain();
  assert.equal(h.notifications.length, 2);
  const [failure, success] = h.notifications;
  assert.equal(failure.body.title, "OpenCode Failure: Example session");
  assert.match(failure.body.message, /Provider unavailable/);
  assert.equal(failure.body.priority, 8);
  assert.equal(success.body.title, "OpenCode Success: Example session");
  assert.equal(success.body.priority, 5);
  assert.deepEqual(h.lookups, [{ sessionID: "ses_failed" }, { sessionID: "ses_success" }]);
  assert.equal(success.input.method, "POST");
  assert.equal(success.body.extras["client::display"].contentType, "text/markdown");
});

test("success alerts skip subagents and nested subagents while main successes and child failures notify", async (t) => {
  const parents = { ses_child: "ses_main", ses_nested: "ses_child" };
  const h = await harness(t, {
    getSession: ({ sessionID }) => ({
      title: sessionID,
      location,
      parentID: parents[sessionID],
    }),
  });
  for (const sessionID of ["ses_child", "ses_nested", "ses_main"]) {
    h.emit(event("session.execution.succeeded", { sessionID }));
  }
  h.emit(
    event("session.execution.failed", {
      sessionID: "ses_child",
      error: { type: "provider.error", message: "Subagent failed" },
    })
  );
  await h.drain();
  assert.deepEqual(
    h.notifications.map(({ body }) => [body.title, body.priority]),
    [
      ["OpenCode Success: ses_main", 5],
      ["OpenCode Failure: ses_child", 8],
    ]
  );
});

test("cached parent IDs suppress subagent successes after renames and failed lookups", async (t) => {
  for (const source of ["session.created", "session.get"]) {
    await t.test(source, async (t) => {
      let lookups = 0;
      const child = { title: "Child", location, parentID: "ses_main" };
      const h = await harness(t, {
        getSession: () => {
          if (++lookups === 1 && source === "session.get") return child;
          throw new Error("Session unavailable");
        },
      });
      if (source === "session.created") {
        h.emit(event("session.created", { sessionID: "ses_child", ...child }));
      } else {
        h.emit(event("session.execution.succeeded", { sessionID: "ses_child" }));
      }
      h.emit(event("session.renamed", { sessionID: "ses_child", title: "Renamed child" }));
      h.emit(event("session.execution.succeeded", { sessionID: "ses_child" }));
      await h.drain();
      assert.equal(h.notifications.length, 0);
      assert.equal(h.errors.length, 1);
      assert.match(h.errors[0][0], /Error fetching session details/);
    });
  }
});

test("V2 forms render choices, free-form fields, and external links", async (t) => {
  const h = await harness(t, { options: { priorityQuestion: 9 } });
  h.emit(
    event("form.created", {
      form: {
        id: "frm_question",
        sessionID: "ses_example",
        title: "Deploy application?",
        fields: [
          {
            key: "target",
            type: "string",
            title: "Target",
            description: "Choose environment",
            options: [{ value: "staging", label: "Staging", description: "Preview deployment" }],
          },
          { key: "notes", type: "string", title: "Notes" },
          { key: "features", type: "multiselect", options: [{ value: "logs", label: "Logs" }] },
          { key: "confirm", type: "boolean", title: "Confirm" },
          { key: "count", type: "integer", title: "Replicas" },
          { key: "weight", type: "number", title: "Weight" },
          { key: "login", type: "external", url: "https://example.com/login" },
        ],
      },
    })
  );
  await h.drain();
  const { body } = h.notifications[0];
  assert.equal(body.title, "OpenCode Question: Example session");
  assert.equal(body.priority, 9);
  for (const text of [
    "Deploy application?",
    "Choose environment",
    "**Staging** — Preview deployment",
    "Notes",
    "Logs",
    "Confirm",
    "Replicas",
    "Weight",
    "https://example.com/login",
  ])
    assert.ok(body.message.includes(text));
});

test("V2 permission requests use action, resources, and explanation", async (t) => {
  const h = await harness(t, { options: { priorityPermission: 10 } });
  h.emit(
    event("permission.asked", {
      id: "per_request",
      sessionID: "ses_example",
      action: "shell",
      resources: ["git push origin main"],
      message: "Publish changes",
    })
  );
  await h.drain();
  const { body } = h.notifications[0];
  assert.equal(body.priority, 10);
  assert.match(body.message, /\*\*shell\*\*/);
  assert.match(body.message, /git push origin main/);
  assert.match(body.message, /Publish changes/);
  assert.doesNotMatch(body.message, /undefined/);
});

test("PTY exits preserve exit codes and priorities", async (t) => {
  const h = await harness(t, { options: { priorityPtyExit: 7 } });
  h.emit(event("pty.exited", { id: "pty_clean", exitCode: 0 }));
  h.emit(event("pty.exited", { id: "pty_failed", exitCode: 2 }));
  await h.drain();
  assert.match(h.notifications[0].body.message, /exited cleanly/);
  assert.match(h.notifications[1].body.message, /exit code \*\*2\*\*/);
  assert.equal(h.notifications[1].body.priority, 7);
});

test("deletions use cached titles and fall back to IDs without fetching deleted sessions", async (t) => {
  const h = await harness(t);
  h.emit(event("session.created", { sessionID: "ses_known", title: "Original", location }));
  h.emit(event("session.renamed", { sessionID: "ses_known", title: "Renamed" }));
  h.emit(event("session.deleted", { sessionID: "ses_known" }));
  h.emit(event("session.deleted", { sessionID: "ses_old" }));
  await h.drain();
  assert.equal(h.notifications[0].body.title, "OpenCode Session Deleted: Renamed");
  assert.equal(h.notifications[1].body.title, "OpenCode Session Deleted: ses_old");
  assert.equal(h.notifications[0].body.priority, 5);
  assert.equal(h.lookups.length, 0);
});

test("server-wide events are scoped by directory and workspace, with session fallback", async (t) => {
  const other = { directory: "/projects/other" };
  const h = await harness(t, {
    getSession: ({ sessionID }) => ({
      title: sessionID,
      location: sessionID === "ses_other" ? other : location,
    }),
  });
  h.emit(event("pty.exited", { id: "pty_other", exitCode: 1 }, other));
  h.emit(
    event(
      "pty.exited",
      { id: "pty_remote", exitCode: 1 },
      { ...location, workspaceID: "ws_remote" }
    )
  );
  h.emit(event("session.execution.succeeded", { sessionID: "ses_other" }, null));
  h.emit(event("session.execution.succeeded", { sessionID: "ses_local" }, null));
  await h.drain();
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body.message, /projects\/example/);
});

test("moving a session out removes cached location and title", async (t) => {
  const h = await harness(t);
  h.emit(event("session.created", { sessionID: "ses_moved", title: "Old title", location }));
  h.emit(
    event("session.moved", { sessionID: "ses_moved", location: { directory: "/projects/other" } })
  );
  h.emit(event("session.deleted", { sessionID: "ses_moved" }, null));
  await h.drain();
  assert.equal(h.notifications.length, 0);
});

test("options override environment and file values, including zero priority", async (t) => {
  const h = await harness(t, {
    fileConfig: { url: "https://file.example", token: "file", prioritySuccess: 3, disabled: true },
    env: { GOTIFY_URL: "https://env.example", GOTIFY_TOKEN: "environment" },
    options: {
      url: "https://options.example/gotify/",
      token: "a+b&c?",
      prioritySuccess: 0,
      disabled: false,
    },
  });
  h.emit(event("session.execution.succeeded", { sessionID: "ses_example" }));
  await h.drain();
  const request = h.notifications[0];
  assert.equal(request.url.origin, "https://options.example");
  assert.equal(request.url.pathname, "/gotify/message");
  assert.equal(request.url.searchParams.get("token"), "a+b&c?");
  assert.equal(request.body.priority, 0);
});

test("environment credentials override file credentials while file priorities apply", async (t) => {
  const h = await harness(t, {
    options: { url: undefined, token: undefined },
    env: { GOTIFY_URL: "https://env.example", GOTIFY_TOKEN: "environment" },
    fileConfig: { url: "https://file.example", token: "file", priorityError: 10 },
  });
  h.emit(
    event("session.execution.failed", {
      sessionID: "ses_example",
      error: { type: "error", message: "Failed" },
    })
  );
  await h.drain();
  assert.equal(h.notifications[0].url.origin, "https://env.example");
  assert.equal(h.notifications[0].url.searchParams.get("token"), "environment");
  assert.equal(h.notifications[0].body.priority, 10);
});

test("file credentials work without options or environment variables", async (t) => {
  const h = await harness(t, {
    options: { url: undefined, token: undefined },
    fileConfig: { url: "https://file.example", token: "file" },
  });
  h.emit(event("pty.exited", { id: "pty_file", exitCode: 0 }));
  await h.drain();
  assert.equal(h.notifications[0].url.origin, "https://file.example");
  assert.equal(h.notifications[0].url.searchParams.get("token"), "file");
});

test("disabled or unconfigured plugins do not subscribe", async (t) => {
  for (const options of [{ disabled: true }, { url: undefined, token: undefined }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const h = await harness(t, { options });
      assert.equal(h.subscriptions, 0);
      assert.equal(h.cleanup, undefined);
    });
  }
});

test("invalid config and failed title lookup still allow configured notifications", async (t) => {
  const h = await harness(t, {
    fileConfig: "{ invalid",
    getSession: () => {
      throw new Error("Session unavailable");
    },
  });
  h.emit(event("session.execution.succeeded", { sessionID: "ses_fallback" }));
  await h.drain();
  assert.equal(h.notifications[0].body.title, "OpenCode Success: ses_fallback");
  assert.ok(h.errors.some((args) => args[0].includes("config file")));
});

test("Gotify HTTP and network failures do not stop later notifications", async (t) => {
  let sends = 0;
  const h = await harness(t, {
    fetch: () => {
      sends++;
      if (sends === 1) return new Response("Unavailable", { status: 503 });
      if (sends === 2) throw new Error("Network failure");
      return new Response("{}");
    },
  });
  for (let i = 0; i < 3; i++) h.emit(event("pty.exited", { id: `pty_${i}`, exitCode: 0 }));
  await h.drain();
  assert.equal(h.notifications.length, 3);
  assert.equal(h.errors.length, 2);
});

test("subscription reconnects after a source failure", async (t) => {
  const h = await harness(t);
  h.fail();
  await until(() => h.subscriptions === 2);
  h.emit(event("pty.exited", { id: "pty_reconnected", exitCode: 0 }));
  await h.drain();
  assert.equal(h.notifications.length, 1);
});

test("cleanup aborts in-flight delivery and discards queued notifications", async (t) => {
  let requestSignal;
  const h = await harness(t, {
    fetch: ({ input }) => {
      requestSignal = input.signal;
      return new Promise((_, reject) =>
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })
      );
    },
  });
  h.emit(event("pty.exited", { id: "pty_slow", exitCode: 0 }));
  h.emit(event("pty.exited", { id: "pty_queued", exitCode: 0 }));
  await until(() => requestSignal !== undefined);
  await h.cleanup();
  assert.equal(h.signal.aborted, true);
  assert.equal(requestSignal.aborted, true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.errors.length, 0);
});
