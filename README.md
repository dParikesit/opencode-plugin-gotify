# opencode-plugin-gotify

An [OpenCode](https://opencode.ai) plugin that sends [Gotify](https://gotify.net) notifications for the moments in an OpenCode session that matter — successful completion, failures, prompts that need your input, and background process lifecycle.

## Features

- **Success and failure alerts** for OpenCode sessions (`session.idle`, `session.error`).
- **Interactive prompt alerts** at high priority so you get paged whenever OpenCode is blocked waiting on you (`question.asked`, `permission.asked`).
- **Runtime failure alerts** for worktree setup, MCP browser launch, and PTY process exit (`worktree.failed`, `mcp.browser.open.failed`, `pty.exited`).
- **Session lifecycle alerts** for deletions (`session.deleted`).
- **Markdown bodies** — messages are sent as `text/markdown` and render fully in Gotify.
- **Robust error handling** — every notification send is wrapped in a try/catch so a Gotify outage never affects your OpenCode process.
- **Three configuration sources** — plugin options, `GOTIFY_URL` / `GOTIFY_TOKEN` environment variables, and a fallback config file at `~/.config/opencode/gotify-config.json`.

---

## Installation

Add this plugin to your `opencode.json` (or `opencode.config.json`):

```json
{
  "plugin": [
    [
      "opencode-plugin-gotify",
      {
        "url": "https://gotify.yourdomain.com",
        "token": "AppTokenHere"
      }
    ]
  ]
}
```

Or run locally by placing it in your project's local plugin directory: `.opencode/plugins/`.

---

## Notified Events

All priorities default to the values below. Every priority is overridable via the matching `priority*` option.

| Event | Default priority | Notification title | Triggered when |
| :--- | :---: | :--- | :--- |
| `session.error` | **8** | `OpenCode Failure: <session>` | A session ends with an error. |
| `worktree.failed` | **8** | `OpenCode Worktree Failed` | A worktree could not be created. |
| `mcp.browser.open.failed` | **8** | `OpenCode Browser Open Failed` | An MCP server failed to open a URL. |
| `pty.exited` | **8** | `OpenCode PTY Exited` | A background PTY process exits (with the exit code in the body). |
| `question.asked` | **8** | `OpenCode Question: <session>` | OpenCode blocks to ask the user a multiple-choice question. |
| `permission.asked` | **8** | `OpenCode Permission: <session>` | OpenCode blocks to request tool permission from the user. |
| `session.deleted` | 5 | `OpenCode Session Deleted: <session>` | A session is deleted. |
| `session.idle` | 5 | `OpenCode Success: <session>` | A session finishes successfully. |

`question.asked` and `permission.asked` default to **8** because both block OpenCode indefinitely until the user responds — these are the events you most want to be alerted on.

---

## Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | `process.env.GOTIFY_URL` | Gotify server base URL (e.g. `https://gotify.example.com`). |
| `token` | `string` | `process.env.GOTIFY_TOKEN` | Gotify Application Token. |
| `prioritySuccess` | `number` | `5` | Priority for `session.idle` notifications. |
| `priorityError` | `number` | `8` | Priority for `session.error` notifications. |
| `priorityQuestion` | `number` | `8` | Priority for `question.asked` notifications. |
| `priorityPermission` | `number` | `8` | Priority for `permission.asked` notifications. |
| `priorityDeleted` | `number` | `5` | Priority for `session.deleted` notifications. |
| `priorityPtyExit` | `number` | `8` | Priority for `pty.exited` notifications. |
| `priorityWorktree` | `number` | `8` | Priority for `worktree.failed` notifications. |
| `priorityBrowser` | `number` | `8` | Priority for `mcp.browser.open.failed` notifications. |
| `disabled` | `boolean` | `false` | Set to `true` to temporarily disable this plugin. |

Example with custom priorities:

```json
{
  "plugin": [
    [
      "opencode-plugin-gotify",
      {
        "url": "https://gotify.yourdomain.com",
        "token": "AppTokenHere",
        "priorityError": 10,
        "priorityQuestion": 9,
        "priorityPermission": 9
      }
    ]
  ]
}
```

### Environment Variables Fallback

If you don't want to expose your Gotify server URL and tokens in the JSON config, you can export them as system environment variables:

```bash
export GOTIFY_URL="https://gotify.example.com"
export GOTIFY_TOKEN="Axxxxxxxxx.xxxx"
```

### Config File Fallback

For options that you want to share across every OpenCode project without committing them, create `~/.config/opencode/gotify-config.json`:

```json
{
  "url": "https://gotify.yourdomain.com",
  "token": "Axxxxxxxxx.xxxx",
  "prioritySuccess": 5,
  "priorityError": 8
}
```

The plugin merges precedence as: plugin options > environment variables > config file > built-in defaults.

---

## Build and Format

This project is written in TypeScript and configured with strict typing and Prettier formatting checks.

```bash
# Format codebase
npm run format

# Compile TypeScript
npm run build
```

---

## License

MIT
