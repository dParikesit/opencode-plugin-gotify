# opencode-plugin-gotify

An [OpenCode V2](https://opencode.ai/v2/docs/) plugin that sends [Gotify](https://gotify.net) notifications for the moments in an OpenCode session that matter — successful completion, failures, prompts that need your input, and PTY process exits.

Version 2 of this plugin uses `@opencode/plugin` and the V2 plugin API. OpenCode V1 users should stay on the plugin's 1.x releases.

## Features

- **Success and failure alerts** for OpenCode sessions (`session.execution.succeeded`, `session.execution.failed`), with success alerts limited to top-level sessions to avoid subagent noise.
- **Interactive prompt alerts** at high priority for questions/forms and tool permissions (`form.created`, `permission.asked`).
- **PTY exit alerts** with exit codes (`pty.exited`).
- **Session lifecycle alerts** for deletions (`session.deleted`).
- **Markdown bodies** — messages are sent as `text/markdown` and render fully in Gotify.
- **Background delivery** — notification failures are logged, requests time out after 10 seconds, and plugin cleanup cancels pending work.
- **Location-scoped alerts** — each plugin instance handles its own directory and workspace, filtering the server-wide event stream.
- **Three configuration sources** — plugin options, `GOTIFY_URL` / `GOTIFY_TOKEN` environment variables, and a fallback config file at `~/.config/opencode/gotify-config.json`.

---

## Installation

Add this plugin to your `opencode.json` or `opencode.jsonc` (globally at `~/.config/opencode/` or in your project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "git+https://github.com/dParikesit/opencode-plugin-gotify.git",
      "options": {
        "url": "https://gotify.example.com",
        "token": "{env:GOTIFY_TOKEN}"
      }
    }
  ]
}
```

Or pin to a specific commit / branch / tag:

```json
"git+https://github.com/dParikesit/opencode-plugin-gotify.git#main"
```

Git installations use the repository's `prepare` script to compile TypeScript to the ESM entrypoint `dist/index.js`.

For a local checkout, run `npm install` in this repository, then configure the absolute path to the built `dist/` directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-plugin-gotify/dist"]
}
```

Set `GOTIFY_URL` and `GOTIFY_TOKEN` in the OpenCode server's environment, or use the config-file fallback below.

---

## Notified Events

All priorities default to the values below. Every priority is overridable via the matching `priority*` option.

| Event | Default priority | Notification title | Triggered when |
| :--- | :---: | :--- | :--- |
| `session.execution.failed` | **8** | `OpenCode Failure: <session>` | An execution fails, including the structured error message. |
| `pty.exited` | **8** | `OpenCode PTY Exited` | A background PTY process exits (with the exit code in the body). |
| `form.created` | **8** | `OpenCode Question: <session>` | OpenCode requests input through a form, including questions, choices, and external links. |
| `permission.asked` | **8** | `OpenCode Permission: <session>` | OpenCode blocks to request tool permission from the user. |
| `session.deleted` | 5 | `OpenCode Session Deleted: <session>` | A session is deleted. |
| `session.execution.succeeded` | 5 | `OpenCode Success: <session>` | A top-level session execution finishes successfully. Subagent sessions (those with a `parentID`) are skipped. |

`form.created` and `permission.asked` default to **8** because they request user attention. Permission alerts include V2's action, resources, and any explanation.

### V1 migration notes

- Replace the V1 `plugin` array and package/options tuples with the V2 `plugins` object form shown above.
- Existing Gotify credentials, configuration precedence, and supported notification priorities are preserved.
- Success alerts use the execution outcome rather than `session.idle`, which can also follow an error or interruption. Interrupted executions do not send success alerts.
- V2 deletion events contain only the session ID. The plugin uses titles observed during its lifetime, falling back to the ID if no title is cached.
- V2's released public event stream has no equivalent for `worktree.failed` or `mcp.browser.open.failed`. Those alerts are unavailable; `priorityWorktree` and `priorityBrowser` are retained as deprecated, inactive options.
- Subscriptions reconnect after a one-second delay if the stream ends. Events missed while disconnected are not replayed. Failed Gotify deliveries are logged and are not retried.

---

## Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | `process.env.GOTIFY_URL` | Gotify server base URL (e.g. `https://gotify.example.com`). |
| `token` | `string` | `process.env.GOTIFY_TOKEN` | Gotify Application Token. |
| `prioritySuccess` | `number` | `5` | Priority for `session.execution.succeeded` notifications. |
| `priorityError` | `number` | `8` | Priority for `session.execution.failed` notifications. |
| `priorityQuestion` | `number` | `8` | Priority for `form.created` notifications. |
| `priorityPermission` | `number` | `8` | Priority for `permission.asked` notifications. |
| `priorityDeleted` | `number` | `5` | Priority for `session.deleted` notifications. |
| `priorityPtyExit` | `number` | `8` | Priority for `pty.exited` notifications. |
| `disabled` | `boolean` | `false` | Set to `true` to temporarily disable this plugin. |

Example with custom priorities:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "git+https://github.com/dParikesit/opencode-plugin-gotify.git",
      "options": {
        "url": "https://gotify.example.com",
        "token": "{env:GOTIFY_TOKEN}",
        "priorityError": 10,
        "priorityQuestion": 9,
        "priorityPermission": 9
      }
    }
  ]
}
```

### Environment Variables Fallback

You can configure credentials through environment variables available to the OpenCode server:

```bash
export GOTIFY_URL="https://gotify.example.com"
export GOTIFY_TOKEN="Axxxxxxxxx.xxxx"
```

The plugin runs in OpenCode's background service. If that service was already running, restart it from the configured environment with `opencode service restart` so it receives the new values.

### Config File Fallback

For options that you want to share across every OpenCode project without committing them, create `~/.config/opencode/gotify-config.json`:

```json
{
  "url": "https://gotify.example.com",
  "token": "Axxxxxxxxx.xxxx",
  "prioritySuccess": 5,
  "priorityError": 8
}
```

The plugin merges precedence as: plugin options > environment variables > config file > built-in defaults.

---

## Development

This project is written in TypeScript and configured with strict typing and Prettier formatting checks.

```bash
# Install dependencies and compile the plugin
npm install

# Format codebase
npm run format

# Check formatting
npm run format:check

# Compile TypeScript and run notification/lifecycle regression tests
npm test
```

The package is compiled against `@opencode/plugin` 2.0.3. Tests use Node's built-in test runner and mock Gotify and the V2 event stream; they do not require Gotify credentials or a model provider. Build output under `dist/` is generated and should not be committed.

---

## License

MIT
