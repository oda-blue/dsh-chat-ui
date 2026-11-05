# Quick start (5 minutes)

This plugin turns the DSH (DeepSeek Harness) web UI into a ChatGPT-style chat.
**No configuration file to write**, and no API key is bundled — you use your own.

## You need

| Item | Notes |
|---|---|
| A PC (Windows / macOS / Linux) | Phones connect over the same Wi-Fi |
| **Node.js 20+** | Check with `node --version` |
| **DSH itself** | Step 1 |
| **A model API key** | OpenAI-compatible, DeepSeek official, etc. Step 4 |

## 1. Install DSH

```bash
npm install -g @deepseek-ai/dsh
dsh --version
```

A version number means you are ready (this plugin is tested with `0.2.1-rc.5`).

- If it fails: check the Node version and npm permissions (some setups need admin).
- Upstream: <https://github.com/deepseek-ai/deepseek-harness>

## 2. Install this plugin

```bash
dsh plugin --profile web add github:oda-blue/dsh-chat-ui
```

- No `dsh` on PATH? `npx @deepseek-ai/dsh plugin --profile web add github:oda-blue/dsh-chat-ui`
- No network? Download `dsh-chat-ui-0.1.0.tgz` from the releases and run
  `dsh plugin --profile web add ./dsh-chat-ui-0.1.0.tgz`

## 3. Start it and open the URL

```bash
dsh web
```

Open the printed URL. The first launch shows DSH's "preview" notice — click **Continue** once.

**How to tell it worked**

- The sidebar header reads **Chats** with a flat history (no workspace boxes)
- The home headline is **"How can I help?"**
- No panel button in the top-right of a conversation
- The composer shows only `+`, a shield icon and **Model** (no developer labels)
- An opened chat has a one-line header: its title and `⋯` (no tabs), and no counters under the composer

## 4. Add your model key

**Settings → Models**: pick a provider and save your API key.
The plugin never handles keys, and nothing secret ships with it.

## 5. Use it from your phone

Connect the phone to the **same Wi-Fi** and start the entrance on the PC:

```bash
# the path depends on where DSH is installed (inside the web profile)
node <DSH_HOME>/profiles/web/node_modules/dsh-chat-ui/bin/web-entry.mjs --host lan
```

Open the printed `http://<computer-name>.local:8123/` on the phone. When "Pair this device" appears, enter the
**8-digit passcode** the entrance printed (the `passcode:` line). Each device pairs once. Then **add it to the home screen**:
on iPhone it opens as the **DSH Chat** app (enter the passcode once more inside the app).

- The URL never changes, so one bookmark is enough
- Old `:8124` URLs redirect to `:8123` automatically
- Devices without the passcode, and pages from other websites, cannot use it (see "How it stays safe" in the README)
- **Nothing is exposed to the internet**; home LAN only
- Stop the `dsh web` from step 3 first, or its port collides with the entrance

## Troubleshooting

| Symptom | Check |
|---|---|
| `dsh: command not found` | Use `npx @deepseek-ai/dsh ...`, or fix PATH |
| Look did not change | Hard reload (Ctrl+F5) |
| `authentication required` | Use the entrance's `:8123` URL (`:8124` only redirects to it; DSH itself is on `127.0.0.1:8125`) |
| "Pair this device" appears | Enter the entrance's `passcode:`; it is also in `$DSH_HOME/dsh-chat-ui/entry-pairing.json` |
| New chats land elsewhere | Restart `dsh web` (the working folder is set up on start); in DSH's stock UI it is the workspace titled `chat (dsh-chat-ui)` |
| Phone cannot connect | Same Wi-Fi, VPN off, Node allowed in the firewall |
| Replies never start | A model key is saved under Settings → Models |

## Reverting

```bash
dsh plugin --profile web remove dsh-chat-ui
```

The stock DSH UI returns (no DSH file was modified). The chat-list grouping is a per-browser
preference: **View options → Group by → Workspace** restores it.

## More

- What changes, configuration, design: [README.md](../README.md)
- How the phone entrance works: README, "Daily use"
