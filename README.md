# opencode-plugin-gotify

An elegant [OpenCode](https://opencode.ai) plugin to automatically send notifications using [Gotify](https://gotify.net) upon execution completion (both on successful completions and failures).

## Features

- **Execution Success Alerts**: Automatically triggers when OpenCode enters `idle` status after executing a task series (`session.idle`).
- **Execution Error Alerts**: Triggers when OpenCode encounters errors during task execution (`session.error`).
- **Markdown Support**: Messages are sent in rich Markdown format, fully supported by Gotify.
- **Robust Security**: Safe execution wrapped in try-catch blocks to prevent any Gotify network issues from affecting your main OpenCode processes.
- **Flexible Configuration**: Supports both programmatic plugin options and fallback environment variables.

---

## Installation

Add this plugin to your `opencode.json` (or `opencode.config.json`) configuration file:

```json
{
  "plugin": [
    [
      "opencode-plugin-gotify",
      {
        "url": "https://gotify.yourdomain.com",
        "token": "AppTokenHere",
        "prioritySuccess": 5,
        "priorityError": 8
      }
    ]
  ]
}
```

Or run locally by placing it in your project's local plugin directory: `.opencode/plugins/`.

---

## Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | `process.env.GOTIFY_URL` | Your Gotify server's base URL (e.g. `https://gotify.example.com`). |
| `token` | `string` | `process.env.GOTIFY_TOKEN` | Gotify Application Token. |
| `prioritySuccess` | `number` | `5` | Priority of the notification when an execution completes successfully (0 - 10). |
| `priorityError` | `number` | `8` | Priority of the notification when an execution fails (0 - 10). |
| `disabled` | `boolean` | `false` | Set to `true` to temporarily disable this plugin. |

### Environment Variables Fallback

If you don't want to expose your Gotify server URL and tokens in the JSON config, you can export them as system environment variables:

```bash
export GOTIFY_URL="https://gotify.example.com"
export GOTIFY_TOKEN="Axxxxxxxxx.xxxx"
```

---

## Build and Format

This project is written in TypeScript and configured with strict typing and Prettier formatting checks.

To format and build:

```bash
# Format codebase
npm run format

# Compile TypeScript
npm run build
```

## License

MIT
