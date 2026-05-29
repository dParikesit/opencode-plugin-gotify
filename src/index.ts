import type { Plugin, Hooks } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface GotifyPluginOptions {
  url?: string;
  token?: string;
  prioritySuccess?: number;
  priorityError?: number;
  disabled?: boolean;
}

export const server: Plugin = async (input, options?: GotifyPluginOptions): Promise<Hooks> => {
  // Load from local config file fallback
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
  }

  const sendNotification = async (title: string, message: string, priority: number) => {
    if (!gotifyUrl || !gotifyToken) {
      return;
    }

    try {
      const baseUrl = gotifyUrl.endsWith("/") ? gotifyUrl.slice(0, -1) : gotifyUrl;
      const url = `${baseUrl}/message?token=${gotifyToken}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          message,
          priority,
          extras: {
            "client::display": {
              contentType: "text/markdown",
            },
          },
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

  return {
    event: async ({ event }) => {
      // Handle successful completion when session becomes idle
      if (event.type === "session.idle") {
        const { sessionID } = event.properties;
        const projectPath = input.project?.worktree || input.directory || "unknown directory";

        await sendNotification(
          "OpenCode Execution Success",
          `Session **${sessionID}** completed successfully in **${projectPath}** and is now idle.`,
          prioritySuccess
        );
      }

      // Handle session errors
      if (event.type === "session.error") {
        const { sessionID, error } = event.properties;
        const projectPath = input.project?.worktree || input.directory || "unknown directory";

        let errorMessage = "Unknown error";
        if (error) {
          if (typeof error === "string") {
            errorMessage = error;
          } else if (typeof error === "object") {
            errorMessage = (error as any).message || JSON.stringify(error);
          }
        }

        await sendNotification(
          "OpenCode Execution Failure",
          `Session **${sessionID || "unknown"}** failed in **${projectPath}**.\n\n**Error:** ${errorMessage}`,
          priorityError
        );
      }
    },
  };
};

export default server;
