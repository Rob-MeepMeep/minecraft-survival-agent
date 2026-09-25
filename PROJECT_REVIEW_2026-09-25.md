# Minecraft Survival Agent — Independent Project Review

**Review date:** 25 September 2026  
**Scope:** source, controller architecture, action primitives, persistence, automated tests, live-test harnesses, telemetry, documentation, and dependency state  
**Method:** read-only source inspection plus execution of the repository's existing checks. Authentication files and `.env` contents were not inspected.

## Executive assessment

This is a credible deterministic Minecraft automation system and a strong research prototype. It already has a better safety and verification structure than a simple Mineflayer script: actions are explicit primitives, state changes are checked after execution, goals can be suspended and restored, telemetry is structured, and the survival controller coordinates tools, food, threats, shelter construction, night waiting, and dawn exit.

It is **not yet ready for unattended long-term survival testing**. Stage 2 and most Stage 3 behavior have good unit and focused-test support, but the repository snapshot does not independently establish Stage 4 acceptance. The current authoritative result file says `STAGE_4_FAILED`, records only 231 advancing ticks, and contains no completed milestone. The latest corresponding telemetry records the bot's death about 12 seconds after the autonomous boundary.

The recommended status is:

- **Stage 2 action primitives:** technically strong; retain as accepted subject to the cross-cutting timeout issue below.
- **Stage 3 progression, food, combat, and shelter:** feature-complete at prototype level; targeted safety gaps remain.
- **Stage 4 natural first-night survival:** **provisional / acceptance pending**. Previous reports describe a successful controlled run, but that accepted result is not retained in the supplied project and the current result is failed.
- **Stage 5 or open-ended persistence:** do not begin yet. Close the release blockers, run a fresh-world acceptance matrix, and preserve its immutable evidence first.

## Verification performed

| Check | Result |
|---|---:|
| `npm test` | **219/219 passed**, 24 suites |
| `npm run check` | **Passed** |
| Installed direct packages | Match the lockfile |
| `npm outdated --json` | No direct package update reported |
| `npm audit --omit=dev` | 6 moderate findings in the Mineflayer authentication/protocol dependency chain |
| Git repository | Not present in the supplied directory |
| Production slash-command search | No `bot.chat(...)` or world-changing slash commands in `src/` |
| External AI/model dependencies | None; runtime is deterministic Node.js + Mineflayer |

The unit suite is valuable, but most controller tests use mocked bots and synthetic blocks/entities. Passing them demonstrates policy behavior under modeled conditions; it does not prove full-world reliability.

## Release blockers

### P0 — Production and acceptance harness use different action budgets

The normal application creates `new FailureTracker()` in `src/main.js:71`, which defaults to only 60 dispatched actions in `src/controller/failure_tracker.js:15`. The Stage 4 harness instead explicitly allows 500 actions in `scripts/live-stage4-natural-night.js:207`. Recorded natural-night attempts used 70, 97, 199, 454, and 500 actions, so behavior that is possible in the harness can terminate as `budget_exceeded` through the real entry point.

The same tracker instance is reused and `SurvivalController.start()` does not call `failureTracker.reset()`. Milestones and several per-run counters are also initialized only in the constructor. A stopped and restarted controller can therefore inherit a depleted action budget, prior failure cooldowns, milestone suppression, dawn wait state, sheltered tick count, and flee attempts.

**Required correction:** define one production run policy shared by the app and acceptance harness; reset all run-scoped state in `start()`; retain only state that is explicitly durable. Prefer bounded budgets per goal/action class plus a run watchdog instead of one small lifetime count.

### P0 — Current Stage 4 evidence is failed and the harness contains non-evidentiary gates

`stage4_live_results.json:2` says `STAGE_4_FAILED`, with 231 ticks and no milestones. The corresponding latest telemetry contains a `death` event. No retained result file in the supplied project says `STAGE_4_ACCEPTED`.

The acceptance harness also marks “Natural Resource Acquisition” true unconditionally at `scripts/live-stage4-natural-night.js:605`, and “Progression Resumption” can pass merely because the current goal is `stone_pickaxe` at line 637. In the current failed result, that progression gate passes despite there having been no shelter lifecycle. These gates weaken the report even though all 11 gates must pass for the final verdict.

**Required correction:** derive every gate from timestamped events after `natural_run_started`; require causal ordering of reserve, enclosure, night audit, dawn exit, and resumed action; never hard-code a pass. Store each run under an immutable run ID with the script version, source commit, JSON result, JSONL telemetry, and console transcript.

## High-priority correctness and safety findings

### P1 — Flee selection returns an unvalidated destination when no safe candidate exists

`findSafeFleeDestination()` checks footing, fluids, body clearance, and distance from threats, but if every candidate fails it returns a raw vector at `src/controller/survival_controller.js:134`. The controller then navigates to that point. This fallback can point into water, a cliff, a blocked cell, or a route that moves through danger.

**Correction:** return `null` when no validated endpoint exists. Treat that as a bounded emergency state: retry with a changed search radius, seek an enclosure, or stop in a defensible location. Add a test in which every candidate is hazardous and assert that navigation is not dispatched.

### P1 — A shelter breach is detected but does not change behavior

The real-time block listener clears `shelterSafetyClaim` and schedules another tick at `src/controller/survival_controller.js:271`. The periodic audit does the same at line 1084. The `wait_out_night` branch then continues waiting and logging sheltered ticks. There is no transition to repair, evacuate, defend, or `failed_unsafe`.

**Correction:** make a failed enclosure audit an explicit state transition. Before the deadline, perform a bounded repair after validating the missing coordinate; after the deadline, choose a safe emergency policy and ensure `nightSurvived` cannot be recorded. Extend the breach test to assert the resulting controller state, not only the telemetry event.

### P1 — Dawn exit safety misses ranged hostiles and solid obstructions

`checkExitSafety()` hard-codes six hostile names at `src/actions/shelter.js:593`; it omits pillagers, strays, drowned, husks, bogged, and other hostiles already recognized elsewhere. This is especially relevant because pillagers appeared in the recent recovery work. The same function checks exterior cells for named hazards but never rejects an ordinary solid block in the player's body or head space (`src/actions/shelter.js:572`).

**Correction:** centralize hostile classification and distance policy in one module used by observation, digging, fleeing, and exit checks. Require both exterior body cells to be passable. Add pillager/stray/drowned and stone/tree obstruction tests.

### P1 — Timed-out actions can continue after the manager declares them finished

`ActionManager.run()` races the primitive against timeout and abort promises at `src/actions/manager.js:146`. When timeout or cancellation wins, `currentAction` is cleared immediately in the `finally` block even though `executeFn` may still be running. A Mineflayer operation that does not promptly honor the signal can later change the world or inventory while a new action is active. `waitForIdle()` only polls `currentAction`, so it cannot see this continuation.

**Correction:** retain the execution promise, abort on timeout, and await its settlement through a bounded cleanup phase before releasing the single-flight lock. If an underlying call cannot be cancelled, keep the action quarantined and audit its late effects. Add a test whose execution promise ignores abort and resolves after timeout; a second action must remain blocked until settlement.

### P1 — Blueprint persistence cannot reliably distinguish worlds and hides write failure

Blueprint creation defaults `worldId` to `overworld` at `src/actions/shelter.js:314`. The planner passes server address, dimension, and version but no actual world identity, session, or controller run ID at `src/controller/planner.js:775`. Server identity uses only `remoteAddress`, so different LAN ports/worlds on the same machine can collide. Identity comparison is skipped when Mineflayer provides no current world ID. A fresh world at a similar location could therefore load an old blueprint.

`saveBlueprint()` catches all write and rename errors without returning failure or emitting telemetry at `src/actions/shelter.js:329`. The controller may act as if state is durable when it is not. Corrupt persistence is discarded, but it is not quarantined as claimed in the walkthrough.

**Correction:** persist a harness/user-supplied world fingerprint containing host, port, dimension, version, and a world/run identity; fail closed when it cannot be matched. Return a save result or throw, emit persistence failures, flush the temporary file before rename, and preserve corrupt files under a diagnostic name.

### P1 — Shelter gathering can fall back into its own protected footprint

The shelter planner first searches for dirt outside the protected radius. If that search finds nothing, it still dispatches a generic `gather('dirt')` action at `src/controller/planner.js:791-842`. The generic gatherer does not know the blueprint exclusion zone, so the fallback can mine the shelter footprint, doorway footing, or already placed structure.

**Correction:** pass a mandatory exclusion predicate/region into the gather primitive or return `no_safe_material_source`. Add a test where dirt exists only inside the protected radius and assert that no gather action is dispatched.

## Medium-priority findings

### P2 — Enclosure audit accepts a different approved material than the blueprint records

At `src/actions/shelter.js:463`, a coordinate expected to contain dirt also passes if it contains any other approved shelter material. That contradicts the exact `expectedMaterial` record and can conceal an external change. The existing “ONLY” test checks an all-dirt shelter and a chest replacement, but does not replace dirt with another approved material.

Use exact equality for persisted coordinates, or explicitly update the blueprint after a verified material substitution and record why it changed.

### P2 — Direct-coordinate gathering does not revalidate block identity

After navigation, `src/actions/gather.js:609` verifies only that the block is present. If another player or world update replaces the target, the agent may dig the replacement. Revalidate the intended block name/state immediately before digging. The same pre-dig branch checks exposed adjacent fluids but does not apply the documented two-block fluid buffer used during candidate selection.

### P2 — Dawn exit timeout can be repeatedly restarted

Selecting an alternate exit resets `_dawnWaitStartTime` at `src/controller/survival_controller.js:1137`. That timestamp is also used for the stated overall 60-second timeout, so changing direction extends the overall bound and can cycle among directions. Track separate overall and per-exit start times.

### P2 — Pause/resume does not resume autonomous work

`stop()` clears the goal stack at `src/controller/survival_controller.js:425`. The `pause` command calls `stop('paused')`, and `resume` only makes the terminal available again (`src/main.js:521-544`). This is internally explicit, but it conflicts with project descriptions that say suspended goals are preserved and resumed across pause/cancellation.

Choose one contract. For a persistent agent, store a resumable controller checkpoint and make `resume` restart it after revalidation. Otherwise update all documentation to say that the user must issue `auto` again.

### P2 — Telemetry reports time-of-day as game time

`src/observer.js:66` assigns `gameTime: timeOfDay` instead of the monotonically increasing world age. Snapshot telemetry therefore cannot prove tick continuity across days. Use `bot.time.age` and retain `timeOfDay` separately.

### P2 — Lifecycle cleanup is incomplete and duplicated

`SurvivalController.destroy()` removes death and end listeners but not its block-update listener (`src/controller/survival_controller.js:1329`). Production also registers additional death/end handlers in `src/main.js:88` after the controller has registered its own, so `stop()` can run twice and produce duplicate state changes/events. Make `stop()` idempotent, use one lifecycle owner, and remove every listener in `destroy()`.

### P2 — Telemetry durability is best-effort and silent

`src/telemetry.js:23-67` has no stream error handler, suppresses synchronous write failures, and does not await `stream.end()`. A shutdown or disk failure can lose the exact evidence used for acceptance without making the run fail. Provide an async `close()`, surface stream errors, and make the acceptance harness fail if telemetry cannot be durably written.

### P2 — Documentation and repository hygiene do not match the implementation

`README.md` still describes a Stage 1 observation-only bot and omits the autonomous controller and current acceptance status. `walkthrough.md` reports 199 tests while the suite now has 219. There is no Git repository in the supplied project, so evidence cannot be tied to a commit and changes cannot be reviewed or reverted reliably.

Initialize version control before further development, keep `.env` and `.auth/` ignored as they currently are, add a current architecture/runbook, and generate acceptance reports from machine-readable artifacts rather than editing prose manually.

### P2 — Moderate dependency advisories remain upstream

`npm audit --omit=dev` reports six moderate findings flowing through `minecraft-protocol`, `prismarine-auth`, `@azure/msal-node`, `yggdrasil`, and vulnerable `uuid` versions. `npm outdated` reports no available direct update, and npm's proposed “fix” is an invalid downgrade to an obsolete Mineflayer major.

Do not apply that automatic downgrade. Track the upstream packages, avoid exposing the bot to untrusted public servers, and rerun the audit when Mineflayer's dependency chain updates.

## Architectural strengths worth preserving

- Runtime behavior is deterministic and local. It does not depend on an LLM, local model, or cloud API.
- Action primitives have bounded timeouts, structured outcomes, telemetry, and many postcondition checks.
- The controller uses a goal stack for preemption rather than a single brittle goal flag.
- Crop maturity uses registry properties, food safety separates edible from unsafe items, wheat is converted to bread, and animal combat is a bounded multi-hit primitive.
- Gathering attributes drops with inventory deltas and newly observed item entities.
- Shelter construction records a blueprint and performs enclosure/player-bounds audits.
- Production source contains no slash commands that alter the world.
- Dependencies are pinned and authentication/environment files are ignored.
- The 219-test suite is broad and fast enough to run on every change.

## Recommended remediation sequence

1. **Unify and reset run state.** Use the same budgets/options in production and tests; reset tracker, counters, milestones, timers, and goal stack at each new run.
2. **Close emergency-state gaps.** Remove unsafe flee fallback, transition on shelter breach, centralize hostile policy, and make exit cells physically passable.
3. **Make cancellation truly single-flight.** Hold the action lock through underlying promise settlement and audit late effects.
4. **Harden blueprint durability and identity.** Add a real world fingerprint and observable persistence failures.
5. **Protect construction resources.** Preserve blueprint exclusion constraints all the way into gathering.
6. **Repair the Stage 4 harness.** Make every gate evidence-derived, causal, and immutable; correct game-time telemetry.
7. **Add focused regression tests** for each item above, then rerun all 219 existing tests.
8. **Run a fresh-world acceptance matrix:** at least three natural starts in different safe biomes, one start with an early ranged threat, one scarcity case, one pause/restart recovery, and one forced shelter breach. A run passes only with 24,000 continuous ticks, zero deaths/commands/post-boundary injections, verified enclosure through the night, safe dawn exit, and an actual post-exit progression action.
9. **Tag the accepted state in Git** and retain the code commit, result JSON, JSONL, console transcript, configuration fingerprint, and blueprint lifecycle events together.

## Paste-ready Antigravity implementation brief

> Apply the independent review in `PROJECT_REVIEW_2026-09-25.md` as a release-hardening increment before any Stage 5 work. Start with the two P0 blockers, then implement every P1 correction. Do not weaken existing safety checks or acceptance criteria. Add focused regression tests for each defect, run `npm test`, `npm run check`, and `npm audit --omit=dev`, and report exact results. Rework the Stage 4 harness so every gate is derived from post-boundary telemetry in causal order and every run writes immutable evidence keyed by run ID and source commit. Do not claim Stage 4 accepted until a fresh-world 24,000-tick run passes all corrected gates through the normal production configuration.

## Final recommendation

Keep the present deterministic architecture. It is a good foundation for later learned planning, self-directed construction, or a team of agents because the low-level actions already expose controlled capabilities and measurable outcomes. The next step should be reliability hardening and reproducible acceptance, not broader autonomy. Once this base can repeatedly survive a fresh natural day/night cycle through the normal entry point, higher-level agents can safely choose *what* to build while these primitives continue to control *how* world changes are executed and verified.
