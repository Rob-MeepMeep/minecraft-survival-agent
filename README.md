# Minecraft Survival Agent — Stage 1

A Minecraft Java Edition bot that connects to a local world, observes the environment, and provides terminal controls. Built with [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder). No AI API key required.

## Current behavior (Stage 1)

The agent **connects and observes only**. It does not move, dig, craft, build, or modify the world in any way. It:

- Joins the local Minecraft world as a player.
- Prints structured snapshots of position, health, hunger, time, inventory, and nearby entities.
- Writes JSONL telemetry to `logs/`.
- Accepts terminal commands: `status`, `pause`, `resume`, `quit`.

## Requirements

- **Node.js 22 or newer** (tested on v24.18.0).
- **Minecraft Java Edition** with a local world open to LAN.
- A second Microsoft/Minecraft account for the bot if using `MC_AUTH=microsoft`.

## Setup

1. Install dependencies:

   ```powershell
   npm ci
   ```

2. Copy the environment template and configure it:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env`:

   | Variable | Description |
   |---|---|
   | `MC_HOST` | Server host. Use `localhost` for a local world. |
   | `MC_PORT` | The LAN port shown when you open your world to LAN. **Changes each time.** |
   | `MC_USERNAME` | The Microsoft account email or gamertag for the bot. With `offline` auth, this is the display name. |
   | `MC_AUTH` | `microsoft` (default) or `offline`. Use `offline` only if the server permits unauthenticated players. |
   | `MC_VERSION` | Leave empty to auto-detect. Set to a specific version (e.g. `1.21.5`) if auto-detect fails. |

4. Start the agent:

   ```powershell
   npm start
   ```

   With `MC_AUTH=microsoft`, a device login prompt will appear in the terminal on first run. Follow it in your browser to authenticate the bot account. Tokens are cached in `.auth/` (git-ignored).

## Terminal commands

| Command | Effect |
|---|---|
| `status` | Prints a JSON snapshot of position, health, hunger, time, inventory, and nearby entities. |
| `pause` | Sets paused state. Stops any active pathfinder goal and clears control states. Observation snapshots continue. |
| `resume` | Clears paused state. |
| `quit` | Cleanly disconnects and exits the process. |

`Ctrl+C` also triggers a clean shutdown.

## Telemetry

Structured JSONL events are written to `logs/<run-id>.jsonl`. Events include:

- `startup` — Node, mineflayer, and OS versions.
- `config` — Sanitized connection settings (no credentials).
- `spawn` — Position, health, hunger, dimension, time.
- `snapshot` — Periodic observation (every 10 seconds).
- `death`, `end`, `kicked`, `error` — Lifecycle transitions.
- `pause`, `resume`, `command`, `shutdown` — Terminal interactions.

## Project structure

```
src/
  main.js          Entry point; terminal REPL; shutdown handling.
  config.js        Reads and validates MC_* environment variables.
  connection.js    Creates the mineflayer bot; lifecycle events.
  observer.js      Produces compact world-state snapshots.
  telemetry.js     JSONL writer with console summaries.
reference/         Archived prototype from planning phase.
logs/              Telemetry output (git-ignored).
.env.example       Environment variable template.
```

## Checks

```powershell
npm run check    # Syntax-check all source files
npm test         # Run policy unit tests (reference)
```

These verify syntax and basic logic only. **A live Minecraft connection is required to validate real behavior.**

## Disconnect and reconnect

On disconnect or kick, the agent logs the reason and exits with code 1. To reconnect, restart the process (`npm start`). Each run creates a fresh bot instance — no duplicate event handlers or stale state.

## Upstream

- https://github.com/PrismarineJS/mineflayer
- https://github.com/PrismarineJS/mineflayer-pathfinder
