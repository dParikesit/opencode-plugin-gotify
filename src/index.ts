import { Plugin } from "@opencode/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export interface GotifyPluginOptions {
  url?: string;
  token?: string;
  prioritySuccess?: number;
  priorityError?: number;
  priorityQuestion?: number;
  priorityPermission?: number;
  priorityDeleted?: number;
  priorityPtyExit?: number;
  /** @deprecated V2 does not publish worktree creation failure events. */
  priorityWorktree?: number;
  /** @deprecated V2 does not publish MCP browser launch failure events. */
  priorityBrowser?: number;
  disabled?: boolean;
}

type OpenCodeEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never;
type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
type SessionDetails = Pick<Session, "title" | "location">;

const eventTypes = [
  "session.created",
  "session.renamed",
  "session.moved",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.deleted",
  "form.created",
  "permission.asked",
  "pty.exited",
] as const;
type GotifyEvent = Extract<OpenCodeEvent, { type: (typeof eventTypes)[number] }>;
const isGotifyEvent = (event: OpenCodeEvent): event is GotifyEvent =>
  eventTypes.some((type) => type === event.type);

export default Plugin.define({
  id: "opencode-plugin-gotify",
  setup(ctx) {
    const options: GotifyPluginOptions = ctx.options;
    let fileConfig: GotifyPluginOptions = {};
    try {
      const configPath = path.join(os.homedir(), ".config", "opencode", "gotify-config.json");
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) ?? {};
      }
    } catch (err) {
      console.error("[Gotify Plugin] Error reading local config file:", err);
    }

    const gotifyUrl = options.url || process.env.GOTIFY_URL || fileConfig.url;
    const gotifyToken = options.token || process.env.GOTIFY_TOKEN || fileConfig.token;
    const disabled = options.disabled ?? fileConfig.disabled ?? false;
    const prioritySuccess = options.prioritySuccess ?? fileConfig.prioritySuccess ?? 5;
    const priorityError = options.priorityError ?? fileConfig.priorityError ?? 8;
    const priorityQuestion = options.priorityQuestion ?? fileConfig.priorityQuestion ?? 8;
    const priorityPermission = options.priorityPermission ?? fileConfig.priorityPermission ?? 8;
    const priorityDeleted = options.priorityDeleted ?? fileConfig.priorityDeleted ?? 5;
    const priorityPtyExit = options.priorityPtyExit ?? fileConfig.priorityPtyExit ?? 8;

    if (disabled) {
      console.log("[Gotify Plugin] Disabled by configuration.");
      return;
    }
    if (!gotifyUrl || !gotifyToken) {
      console.warn(
        "[Gotify Plugin] Gotify URL or Token is not configured. " +
          "Provide plugin options (url, token), environment variables (GOTIFY_URL, GOTIFY_TOKEN), " +
          "or ~/.config/opencode/gotify-config.json."
      );
      return;
    }

    console.log("[Gotify Plugin] Loaded for OpenCode V2.");
    const controller = new AbortController();
    const sessions = new Map<string, SessionDetails>();
    const isLocal = (location: Session["location"]) =>
      location.directory === ctx.location.directory &&
      location.workspaceID === ctx.location.workspaceID;

    const getSession = async (sessionID: string): Promise<SessionDetails | undefined> => {
      try {
        const session = await ctx.session.get(
          { sessionID },
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }
        );
        if (isLocal(session.location)) sessions.set(sessionID, session);
        return session;
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[Gotify Plugin] Error fetching session details:", error);
        }
        return sessions.get(sessionID);
      }
    };

    const sendNotification = async (title: string, message: string, priority: number) => {
      try {
        const baseUrl = gotifyUrl.replace(/\/+$/, "");
        const url = `${baseUrl}/message?token=${encodeURIComponent(gotifyToken)}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          body: JSON.stringify({
            title,
            message,
            priority,
            extras: { "client::display": { contentType: "text/markdown" } },
          }),
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          console.error(
            `[Gotify Plugin] Failed to send notification. Gotify returned status ${response.status}: ${errorText}`
          );
        } else {
          await response.body?.cancel();
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[Gotify Plugin] Error sending notification to Gotify:", error);
        }
      }
    };

    const handleEvent = async (event: GotifyEvent) => {
      if (controller.signal.aborted) return;

      // The public stream covers all locations, including other plugin instances.
      if (event.type === "session.moved") {
        const cached = sessions.get(event.data.sessionID);
        if (!isLocal(event.data.location)) sessions.delete(event.data.sessionID);
        else if (cached) cached.location = event.data.location;
        return;
      }
      if (event.location && !isLocal(event.location)) return;
      if (event.type === "session.created") {
        if (isLocal(event.data.location)) {
          sessions.set(event.data.sessionID, {
            title: event.data.title,
            location: event.data.location,
          });
        }
        return;
      }
      if (event.type === "session.renamed") {
        const session =
          sessions.get(event.data.sessionID) ?? (await getSession(event.data.sessionID));
        if (session && isLocal(session.location)) {
          sessions.set(event.data.sessionID, { ...session, title: event.data.title });
        }
        return;
      }

      const sessionID =
        event.type === "form.created"
          ? event.data.form.sessionID
          : "sessionID" in event.data
            ? event.data.sessionID
            : undefined;
      // Deleted sessions can no longer be fetched; retain titles observed while loaded.
      const session = sessionID?.startsWith("ses")
        ? event.type === "session.deleted"
          ? sessions.get(sessionID)
          : await getSession(sessionID)
        : undefined;
      const location = event.location ?? session?.location;
      if (event.type === "session.deleted") sessions.delete(event.data.sessionID);
      if (!location || !isLocal(location) || controller.signal.aborted) return;
      const title = session?.title || sessionID || "unknown session";
      const directory = location.directory;

      switch (event.type) {
        case "session.execution.failed":
          await sendNotification(
            `OpenCode Failure: ${title}`,
            `Session **${title}** failed in **${directory}**.\n\n**Error:** ${event.data.error.message}`,
            priorityError
          );
          break;
        case "session.execution.succeeded":
          await sendNotification(
            `OpenCode Success: ${title}`,
            `Session **${title}** completed successfully in **${directory}**.`,
            prioritySuccess
          );
          break;
        case "pty.exited": {
          const { id, exitCode } = event.data;
          const status = exitCode === 0 ? "cleanly" : `with non-zero exit code **${exitCode}**`;
          await sendNotification(
            "OpenCode PTY Exited",
            `PTY \`${id}\` exited ${status} in **${directory}**.`,
            priorityPtyExit
          );
          break;
        }
        case "form.created": {
          const { form } = event.data;
          const lines = form.fields.map((field, i) => {
            const choices = "options" in field ? field.options : undefined;
            const opts = (choices ?? [])
              .map(
                (option) =>
                  `  - **${option.label}**${option.description ? ` — ${option.description}` : ""}`
              )
              .join("\n");
            return (
              `**${i + 1}. ${field.title || field.key}**` +
              (field.description ? `\n${field.description}` : "") +
              (field.type === "external" ? `\n${field.url}` : "") +
              (opts ? `\n${opts}` : "")
            );
          });
          await sendNotification(
            `OpenCode Question: ${title}`,
            `Session **${title}** is asking for input in **${directory}**.\n\n**${form.title}**\n\n${lines.join("\n\n")}`,
            priorityQuestion
          );
          break;
        }
        case "permission.asked": {
          const { action, resources, message } = event.data;
          const details = resources.length
            ? `\n\n**Resources:**\n${resources.map((resource) => `  - \`${resource}\``).join("\n")}`
            : "";
          await sendNotification(
            `OpenCode Permission: ${title}`,
            `Session **${title}** needs permission for **${action}** in **${directory}**.${details}${message ? `\n\n${message}` : ""}`,
            priorityPermission
          );
          break;
        }
        case "session.deleted":
          await sendNotification(
            `OpenCode Session Deleted: ${title}`,
            `Session **${title}** was deleted in **${directory}**.`,
            priorityDeleted
          );
          break;
      }
    };

    // Buffer relevant events so Gotify's network latency cannot stall the shared stream.
    let pending = Promise.resolve();
    const subscription = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (controller.signal.aborted) break;
            if (!isGotifyEvent(event)) continue;
            pending = pending
              .then(() => handleEvent(event))
              .catch((error) => {
                if (!controller.signal.aborted) {
                  console.error("[Gotify Plugin] Error handling event:", error);
                }
              });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error("[Gotify Plugin] Event subscription failed:", error);
          }
        }
        // V2 subscriptions are live-only and do not reconnect automatically.
        if (!controller.signal.aborted) {
          await delay(1_000, undefined, { signal: controller.signal }).catch(() => {});
        }
      }
    })();

    return async () => {
      controller.abort();
      await subscription;
      await pending;
      sessions.clear();
    };
  },
});
