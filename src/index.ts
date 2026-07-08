import type { Plugin, Hooks } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface GotifyPluginOptions {
  url?: string;
  token?: string;
  prioritySuccess?: number;
  priorityError?: number;
  priorityQuestion?: number;
  priorityPermission?: number;
  priorityDeleted?: number;
  priorityPtyExit?: number;
  priorityWorktree?: number;
  priorityBrowser?: number;
  disabled?: boolean;
}

export const server: Plugin = async (input, options?: GotifyPluginOptions): Promise<Hooks> => {
  let fileConfig: Partial<GotifyPluginOptions> = {};
  try {
    const configPath = path.join(os.homedir(), ".config", "opencode", "gotify-config.json");
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(fileContent);
    }
  } catch (err) {
    console.error("[Gotify Plugin] Error reading local config file:", err);
  }

  const gotifyUrl = options?.url || process.env.GOTIFY_URL || fileConfig.url;
  const gotifyToken = options?.token || process.env.GOTIFY_TOKEN || fileConfig.token;
  const disabled = options?.disabled ?? fileConfig.disabled ?? false;

  const prioritySuccess = options?.prioritySuccess ?? fileConfig.prioritySuccess ?? 5;
  const priorityError = options?.priorityError ?? fileConfig.priorityError ?? 8;
  const priorityQuestion = options?.priorityQuestion ?? fileConfig.priorityQuestion ?? 8;
  const priorityPermission = options?.priorityPermission ?? fileConfig.priorityPermission ?? 8;
  const priorityDeleted = options?.priorityDeleted ?? fileConfig.priorityDeleted ?? 5;
  const priorityPtyExit = options?.priorityPtyExit ?? fileConfig.priorityPtyExit ?? 8;
  const priorityWorktree = options?.priorityWorktree ?? fileConfig.priorityWorktree ?? 8;
  const priorityBrowser = options?.priorityBrowser ?? fileConfig.priorityBrowser ?? 8;

  if (disabled) {
    console.log("[Gotify Plugin] Disabled by configuration.");
    return {};
  }

  if (!gotifyUrl || !gotifyToken) {
    console.warn(
      "[Gotify Plugin] Warning: Gotify URL or Token is not configured. " +
        "Please provide them via plugin options (url, token), environment variables (GOTIFY_URL, GOTIFY_TOKEN), " +
        "or in the configuration file ~/.config/opencode/gotify-config.json."
    );
  } else {
    console.log(
      `[Gotify Plugin] Loaded v2. url=${gotifyUrl.replace(/\/\/[^/]+/, "//<redacted>")} ` +
      `priorities: success=${prioritySuccess} error=${priorityError} question=${priorityQuestion} ` +
      `permission=${priorityPermission} deleted=${priorityDeleted} pty=${priorityPtyExit} ` +
      `worktree=${priorityWorktree} browser=${priorityBrowser}`
    );
  }

  const getSessionTitle = async (sessionID?: string): Promise<string> => {
    if (!sessionID) return "unknown session";
    try {
      const res = await input.client.session.get({
        path: { id: sessionID },
      });
      if (res && res.data && (res.data as any).title) {
        return (res.data as any).title;
      }
    } catch (error) {
      console.error("[Gotify Plugin] Error fetching session details:", error);
    }
    return sessionID;
  };

  const projectPath = () => input.project?.worktree || input.directory || "unknown directory";

  const sendNotification = async (title: string, message: string, priority: number) => {
    if (!gotifyUrl || !gotifyToken) {
      return;
    }
    try {
      const baseUrl = gotifyUrl.endsWith("/") ? gotifyUrl.slice(0, -1) : gotifyUrl;
      const url = `${baseUrl}/message?token=${gotifyToken}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      }
    } catch (error) {
      console.error("[Gotify Plugin] Error sending notification to Gotify:", error);
    }
  };

  const extractError = (error: unknown): string => {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (typeof error === "object") {
      return (error as any).message || JSON.stringify(error);
    }
    return String(error);
  };

  return {
    event: async ({ event }) => {
      const ev = event as { type: string; properties: any };
      // ---- High priority (8) ----

      if (ev.type === "session.error") {
        const { sessionID, error } = ev.properties as { sessionID?: string; error?: unknown };
        const title = await getSessionTitle(sessionID);
        const errorMessage = extractError(error);
        await sendNotification(
          `OpenCode Failure: ${title}`,
          `Session **${title}** failed in **${projectPath()}**.\n\n**Error:** ${errorMessage}`,
          priorityError
        );
        return;
      }

      if (ev.type === "worktree.failed") {
        const { message } = ev.properties as { message: string };
        await sendNotification(
          "OpenCode Worktree Failed",
          `Worktree creation failed in **${projectPath()}**.\n\n**Error:** ${message}`,
          priorityWorktree
        );
        return;
      }

      if (ev.type === "mcp.browser.open.failed") {
        const { mcpName, url } = ev.properties as { mcpName: string; url: string };
        await sendNotification(
          "OpenCode Browser Open Failed",
          `MCP server **${mcpName}** failed to open URL: \`${url}\``,
          priorityBrowser
        );
        return;
      }

      if (ev.type === "pty.exited") {
        const { id, exitCode } = ev.properties as { id: string; exitCode: number };
        const status = exitCode === 0 ? "cleanly" : `with non-zero exit code **${exitCode}**`;
        await sendNotification(
          "OpenCode PTY Exited",
          `PTY \`${id}\` exited ${status} in **${projectPath()}**.`,
          priorityPtyExit
        );
        return;
      }

      // ---- Medium priority (5) ----

      if (ev.type === "session.idle") {
        const { sessionID } = ev.properties as { sessionID: string };
        const title = await getSessionTitle(sessionID);
        await sendNotification(
          `OpenCode Success: ${title}`,
          `Session **${title}** completed successfully in **${projectPath()}**.`,
          prioritySuccess
        );
        return;
      }

      if (ev.type === "question.asked") {
        const { sessionID, questions } = ev.properties as {
          sessionID: string;
          questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }>;
        };
        const title = await getSessionTitle(sessionID);
        const lines = (questions || []).map((q, i) => {
          const opts = (q.options || [])
            .map((o) => `  - **${o.label}**${o.description ? ` — ${o.description}` : ""}`)
            .join("\n");
          return `**${i + 1}. ${q.header || q.question}**\n${q.question}${opts ? "\n" + opts : ""}`;
        });
        await sendNotification(
          `OpenCode Question: ${title}`,
          `Session **${title}** is asking for input in **${projectPath()}**.\n\n${lines.join("\n\n")}`,
          priorityQuestion
        );
        return;
      }

      if (ev.type === "permission.asked") {
        const { sessionID, permission, patterns } = ev.properties as {
          sessionID: string;
          permission: string;
          patterns: Array<string>;
        };
        const title = await getSessionTitle(sessionID);
        const pats = (patterns && patterns.length > 0) ? `\n\n**Patterns:**\n${patterns.map((p) => `  - \`${p}\``).join("\n")}` : "";
        await sendNotification(
          `OpenCode Permission: ${title}`,
          `Session **${title}** needs permission for **${permission}** in **${projectPath()}**.${pats}`,
          priorityPermission
        );
        return;
      }

      if (ev.type === "session.deleted") {
        const { info } = ev.properties as { info: { id: string; title?: string } };
        const title = info?.title || info?.id || "unknown session";
        await sendNotification(
          `OpenCode Session Deleted: ${title}`,
          `Session **${title}** was deleted in **${projectPath()}**.`,
          priorityDeleted
        );
        return;
      }
    },
  };
};

export default server;
