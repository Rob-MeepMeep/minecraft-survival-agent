# Minecraft Survival Agent

An autonomous, deterministic Minecraft Java Edition survival agent built with [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder).

The agent survives the first natural day and night cycle (24,000 ticks) autonomously: it gathers wood and stone, crafts wooden and stone pickaxes, procures food, evades hostile mobs, constructs a verified 25-block shelter before dusk, audits enclosure integrity through the night, emerges safely at dawn, and resumes progression—**with zero slash commands, zero harness injections, and zero external AI/LLM API requirements**.

### ✅ Stage 4 Acceptance Status: **SIGNED OFF** (15/15 Gates Passed)
- **Signed Off:** 2026-09-28T20:54:13+01:00 — Final commit [`e3fcfce`](https://github.com/Rob-MeepMeep/minecraft-survival-agent/commit/e3fcfce)
- **Live Run ID:** [`stage4-1790615796794`](file:///c:/Users/rob_k/Desktop/Minecraft%20Agent/artifacts/stage4-runs/stage4-1790615796794/result.json)
- **Full Verification Report:** [`STAGE_4_VERIFICATION_REPORT.md`](file:///c:/Users/rob_k/Desktop/Minecraft%20Agent/STAGE_4_VERIFICATION_REPORT.md)
- **Vitals:** 20/20 HP (0 damage taken), 20/20 Food across 24,000 continuous ticks (~20 mins wall time).
- **Enclosure Integrity:** 1,242 night audits passed, 0 breaches, zero operator slash commands, zero post-boundary injections.
- **Manifest Integrity:** `result.json` SHA-256 verified — write-once immutability enforced, post-packaging self-check added.

---

## Architecture & Design Principles

### 1. Deterministic Local Architecture (No LLM Required)
Unlike LLM-dependent agents that suffer from network latency, token costs, hallucinated actions, and non-deterministic failures, this agent operates **100% locally and deterministically**:
- **Hierarchical Goal Planner** (`src/controller/planner.js`): Deconstructs high-level survival objectives (`wooden_pickaxe`, `stone_pickaxe`, `acquire_food`, `maintain_building_reserve`, `build_shelter`, `wait_out_night`, `dawn_exit`) into validated action primitives.
- **Single-Flight Action Lock** (`src/actions/manager.js`): Prevents overlapping or race-conditioned world interactions. All primitives (`navigate`, `gather`, `craft`, `equip`, `eat`, `place`, `attack`, `shelter`) execute with bounded timeouts, abort signals, and strict postcondition verification.
- **Failure Tracking with Exponential Backoff** (`src/controller/failure_tracker.js`): Blacklists repeatedly failing block coordinates and targets to prevent infinite loops.
- **Durable Blueprint State** (`src/actions/shelter.js`): Atomic JSON persistence (`.shelter_blueprint.json`) tracks exact coordinates, orientations, and materials, surviving agent restarts and reconnects.

```
                           +------------------------+
                           |  Terminal REPL / App   |
                           |     (src/main.js)      |
                           +-----------+------------+
                                       |
                                       v
                        +------------------------------+
                        |     Survival Controller      |
                        | (controller/survival_ctrl.js)|
                        +--------------+---------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v                                       v
     +--------------------------+            +--------------------------+
     |   Goal Planner Engine    |            | Health & Threat Monitor  |
     |  (controller/planner.js) |            |  (HEALTH_THRESHOLDS,     |
     +-------------+------------+            |   _activeAggressors)     |
                   |                         +-------------+------------+
                   v                                       |
     +--------------------------+                          |
     |   Single-Flight Manager  | <------------------------+ (Preemption &
     |   (src/actions/manager)  |                             Evasion)
     +-------------+------------+
                   |
     +-------------+---------------------------------------+
     |             |             |            |            |
     v             v             v            v            v
  navigate      gather         craft        place       shelter
```

---

## Health-Aware Emergency Policy & Safety Thresholds

The agent continuously enforces a deterministic health policy designed to maintain high survival margins:

### Health Threshold Constants

| Constant | Value | Description |
|---|---|---|
| `OPTIMAL` | `20.0` (10 hearts) | Full health. Standard progression active. |
| `REGEN_FOOD_THRESHOLD` | `18.0` (9 hunger) | Minecraft engine threshold for passive natural regeneration. When health $< 20$ and food $< 18$, the agent prioritizes eating safe food to restore regeneration. The agent **never assumes eating directly heals**. |
| `SAFE_MINIMUM` | `14.0` (7 hearts) | Warning threshold. Ordinary progression is preempted. If building materials $\ge 25$ exist, emergency shelter construction is triggered early. Threat re-engagement is strictly prohibited. |
| `DANGER` | `10.0` (5 hearts) | High threat threshold. Ordinary tasks are preempted; immediate evasion to validated safe destinations is triggered. |
| `MIN_ACCEPTANCE_HEALTH` | `8.0` (4 hearts) | Acceptance gate. Minimum health throughout the 24,000-tick run must never fall below this threshold. |
| `MIN_FINAL_HEALTH` | `12.0` (6 hearts) | Acceptance gate. Run must finish with at least 12.0 health, ensuring a robust safety margin. |
| `TERMINAL_CRITICAL` | `6.0` (3 hearts) | Unrecoverable boundary. If health drops below 6.0 without food or safe shelter, enters an explicit, bounded `critical_health_no_recovery` state. |

### Threat Detection and Evasion
- **Multi-Class Threat Radii**:
  - Ranged hostiles (skeletons, pillagers, strays, bogged): **16.0 meters**.
  - Creepers: **10.0 meters**.
  - Melee hostiles (zombies, spiders, husks, drowned, endermen): **8.0 meters**.
- **Active Aggressor Tracking**: Spiders and neutral mobs provoked into attacking are recorded in `_activeAggressors` with a 60-second TTL, preventing them from being falsely classified as daylight neutrals.
- **Immediate Evasion Reset**: Receiving damage immediately zeroes the flee cooldown (`_fleeCooldownUntil = 0`) and preempts any active gathering or progression action.
- **Validated Retreat Destinations**: Retreat candidates must pass strict footing checks (solid ground, non-fluid, no drop hazards $> 3$ blocks) and must strictly increase distance from threats.

---

## Current Capabilities by Stage

- **Stage 1 (Observation & CLI)**: Connection management, periodic world state snapshots, clean signal handling, terminal REPL.
- **Stage 2 (Action Primitives)**: 8 single-flight atomic primitives with timeout protection, postcondition verification, and failure tracking.
- **Stage 3 (Hierarchical Progression & Shelter)**:
  - Gathering wood, crafting table, wooden pickaxe.
  - Exposed stone mining, crafting stone pickaxe.
  - Food acquisition: harvesting mature wheat/carrots/potatoes, seed bread crafting, passive animal hunting.
  - 30-block building reserve maintenance before dusk (`timeOfDay = 9500`).
  - Deterministic 25-block shelter construction completed before dusk (`timeOfDay = 12000`).
  - Night enclosure audit: continuous block update monitoring; detects breaches and transitions out of safety claims.
  - Safe dawn exit: directional clearance check (threat radius, exterior passable clearance) at dawn (`timeOfDay = 0` / age advancing).
- **Stage 4 (Natural Night Acceptance & Evidence Preservation)**:
  - 24,000-tick natural day/night survival verification across 15 causal gates.
  - Health-aware emergency policy and damage tracking.
  - Platform-independent evidence packaging (`result.json`, `manifest.json`, `damage_timeline.json`, `milestones.json`, `actions_summary.json`, `.gz` telemetry and transcripts).
  - **Formally signed off 2026-09-28.**
- **Stage 5 (Multi-Seed Repeatability Matrix):** 🔓 **UNLOCKED** — evaluating $\ge 80\%$ survival across diverse terrain seeds.

---

## Setup & Running

### Requirements
- **Node.js**: 22.0.0 or newer (tested on Node v24.18.0).
- **Minecraft Java Edition**: 1.20.x–1.21.x world open to LAN.
- **Authentication**: Microsoft account (`MC_AUTH=microsoft`) or offline LAN (`MC_AUTH=offline`).

### Installation
```powershell
npm ci
Copy-Item .env.example .env
```

### Environment Configuration (`.env`)
```ini
MC_HOST=localhost
MC_PORT=61375       # LAN port from Minecraft "Open to LAN"
MC_USERNAME=BotName # Microsoft email/gamertag or offline player name
MC_AUTH=offline     # "offline" for local LAN, "microsoft" for authenticated servers
MC_VERSION=         # Leave blank for auto-detection
```

### Starting the Agent
```powershell
npm start
```

---

## Terminal Commands

When running `npm start`, the interactive REPL supports:

| Command | Description |
|---|---|
| `auto` | Starts the autonomous survival controller. |
| `status` | Prints a comprehensive JSON snapshot of the bot's health, food, position, inventory, and current goal. |
| `pause` | Safely suspends the current goal and halts pathfinder navigation. |
| `resume` | Unpauses and resumes autonomous progression from the saved controller state. |
| `stop` | Cleanly stops the autonomous controller without disconnecting. |
| `quit` | Disconnects the bot and terminates the process cleanly. |

`Ctrl+C` also triggers an immediate, graceful shutdown.

---

## Running Acceptance Tests

### 1. Full Automated Test Suite
Runs all 250 deterministic unit, integration, and policy tests across 24 test suites:
```powershell
npm test
```

### 2. Syntax & Static Verification
Validates syntax across all 17 JavaScript source files:
```powershell
npm run check
```

### 3. Dependency Vulnerability Audit
```powershell
npm audit --omit=dev
```

---

## Stage 4 Acceptance Harness

The Stage 4 harness (`scripts/live-stage4-natural-night.js`) executes a full 24,000-tick natural survival run in a live Minecraft world.

### Acceptance Gates (15 Causal Gates)
All 15 gates are derived strictly from timestamped post-boundary telemetry in causal order:
1. **Survival**: Zero deaths (`deathCount === 0`).
2. **Min Health**: Health never drops below `MIN_ACCEPTANCE_HEALTH` (`8.0` / 4 hearts).
3. **Final Health**: Final health $\ge$ `MIN_FINAL_HEALTH` (`12.0` / 6 hearts).
4. **Natural Duration**: At least 24,000 naturally advancing world ticks (`elapsedTicks >= 24000`).
5. **No Slash Commands**: Zero production world-altering commands executed (`slashCommandCount === 0`).
6. **No Harness Injections**: Zero artificial items, blocks, or state injected after boundary.
7. **Natural Tool Progression**: Wood gathered $\to$ wooden pickaxe crafted $\to$ stone mined $\to$ stone pickaxe crafted.
8. **Building Reserve**: At least 30 expendable building blocks gathered before dusk (`timeOfDay <= 10500`).
9. **Enclosure Before Deadline**: Complete 25-block shelter built and enclosed before dusk (`timeOfDay <= 12000`).
10. **Night Enclosure Integrity**: Enclosure maintained without unresolved breaches throughout the night.
11. **Safe Dawn Exit**: Doorway cleared and exited only after dawn with safety clearance.
12. **Progression Resumed**: At least one valid progression action dispatched and completed after dawn.
13. **Starvation Avoidance**: Hunger never drops below 6, preventing starvation damage.
14. **Clean Execution Lifecycle**: No `budget_exceeded`, `failed_unsafe`, `critical_health_no_recovery`, or unhandled errors.
15. **Continuous Telemetry**: Telemetry and console transcript written and verified.

### Running the Live Harness
1. Create a fresh Minecraft survival world (cheats enabled only for initial setup if needed; no post-boundary commands).
2. Open to LAN and record the port.
3. Update `MC_PORT` in `.env`.
4. Run the harness:
   ```powershell
   node scripts/live-stage4-natural-night.js
   ```

### Preserved Evidence Layout
Every completed acceptance run packages compact, verifiable evidence under `artifacts/stage4-runs/<runId>/`:
- `result.json`: Gate verification status, elapsed ticks, health extrema, and milestones.
- `manifest.json`: Cryptographic manifest containing SHA-256 hashes of all retained run files.
- `config_fingerprint.json`: Sanitized runtime configuration, Node/Mineflayer versions, and world ID.
- `milestones.json`: Milestone timestamps and ordering.
- `damage_timeline.json`: Complete damage log with attacker, damage amount, position, time, and active goal.
- `actions_summary.json`: Dispatched action primitives, durations, and outcomes.
- `telemetry.jsonl.gz`: Gzip-compressed raw telemetry log.
- `transcript.txt.gz`: Gzip-compressed console output.

---

## Known Limitations

1. **Ranged Hostile Sightlines**: Skeletons and pillagers with open line-of-sight in flat plains can inflict chip damage before the agent reaches the 16m evasion perimeter.
2. **Extreme Biomes**: Spawning in deep oceans or sheer mountain peaks where trees are $> 64\text{m}$ distant requires extended travel time.
3. **Upstream Protocol Advisories**: `npm audit --omit=dev` reports 6 moderate advisories in upstream `mineflayer`/`prismarine-auth` dependencies (vulnerable `uuid` buffer check). These require upstream releases. Do not use `--force` downgrade.
