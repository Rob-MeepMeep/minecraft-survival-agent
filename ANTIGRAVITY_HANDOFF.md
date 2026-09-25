# Minecraft Survival Agent — Antigravity Handoff

## Instructions for the receiving agent

Read this document as the project brief. The user will implement and run the project in Antigravity on their desktop PC. Their laptop was used for planning and an initial prototype only. Another assistant will help interpret exported logs and debug issues when the user shares them. No direct connection between assistants is required or assumed.

Implement **Stage 1 first**, then report the result and live-test instructions. Do not silently implement the whole roadmap. Work autonomously on routine implementation details; ask only for missing environment details that affect the connection. Do not claim Minecraft behavior works merely because unit tests pass.

The reference prototype embedded below is incomplete and unvalidated in-game. Preserve it under `reference/` if useful, but do not use its automatic survival loop as the Stage 1 entry point. The first deliverable must connect and observe without modifying the world.

## Objective and agreed scope

Build an agent that joins a local Minecraft **Java Edition** world as another player and eventually survives autonomously. Minecraft and the agent will run on the user's **desktop PC**, not the laptop. The desktop OS, Minecraft version, mods, and bot account setup are not yet known. Do not assume Windows, although provide PowerShell instructions if it is Windows.

First major gameplay milestone: survive one full day/night cycle without intervention, with food and basic tools. Longer-term goal: repeatable survival across varied seeds, then higher-level natural-language goals.

Use a disposable survival world initially. Do not change world difficulty, enable cheats, grant items, or weaken server authentication to manufacture a successful test. Controlled action tests can use a separately documented fixture world; survival evaluation must start with an empty inventory.

## Proposed technical foundation

- Node.js; the prototype declares Node >=22 and was checked on Node 24.14.1.
- Mineflayer for Java protocol/world/action access.
- mineflayer-pathfinder for navigation.
- Rule-based survival controller first; optional LLM planning later.
- No paid API, AI API key, or model integration needed for the first five stages.
- Consult upstream docs for the exact installed versions. Do not assume every Minecraft release or modded server is supported.

Prototype dependency versions: mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, vec3 0.2.0. These are a recorded baseline, not a requirement to keep obsolete or incompatible versions. Resolve dependencies on the desktop and commit a lockfile. If transferring the full original project, use its lockfile with `npm ci`.

Sources:

- https://github.com/PrismarineJS/mineflayer
- https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- https://github.com/PrismarineJS/mineflayer-pathfinder

## Connection setup

Confirm the desktop OS, installed Node version, exact Minecraft Java version, vanilla/modded status, and intended authentication setup. Inspect the repository before making changes.

For a local world, the user opens the world to LAN and supplies the displayed port. The agent on that same desktop connects to `localhost` and that port. The port may change each time the world is opened. The world must remain running.

Use Microsoft authentication when required by the host. A bot playing alongside the user on an authenticated host needs its own Java-entitled account. The `MC_USERNAME` setting identifies the authentication account; it does not freely choose an authenticated player's name. Follow device authentication prompts locally. Never ask the user to paste a password or authentication token into chat or logs.

Offline client authentication is only appropriate when the user's chosen local server already permits it; setting `MC_AUTH=offline` does not bypass server authentication. Verify integrated LAN-world behavior with the actual game version. If this setup does not accept the bot, explain the observed error and options rather than silently changing authentication policy.

Ignore `.env`, authentication caches, and logs in Git. Include `.env.example`. Verify shell instructions for the desktop OS.

## Architecture

Keep these responsibilities separate:

1. **Connection and lifecycle:** configuration validation, connect, spawn, death, respawn, disconnect, shutdown. There must be exactly one active controller per session.
2. **Observer:** compact snapshots of position, dimension, health, hunger, time, inventory, nearby threats, and relevant resources. Represent unknown/unloaded data explicitly.
3. **Actions:** bounded, cancellable operations such as navigate, gather, collect, craft, equip, eat, place, and shelter. Verify postconditions rather than trusting that an API call resolved.
4. **Controller:** selects one action at a time from observed state. Urgent danger and hunger can preempt work. Distinguish temporary failure, missing prerequisites, and impossible goals.
5. **Telemetry:** structured JSONL events and run summaries that can be shared for debugging.

Suggested layout (adapt if useful):

```text
src/
  main.js
  config.js
  connection.js
  observer.js
  controller.js
  actions/
  telemetry.js
test/
reference/
.env.example
README.md
package.json
```

Do not allow overlapping movement, digging, crafting, and building routines. Use an action queue and cancellation token/session identifier. A timeout must cancel the operation, not merely stop awaiting its promise. On disconnect/death, cancel work and invalidate stale continuations before starting a new loop. Pause must remain responsive during actions.

## Staged delivery and acceptance criteria

### Stage 1 — Connect, observe, and stop

Implement a clean connection entry point without automatic resource gathering. Print and write structured snapshots, plus connection/errors and lifecycle events. Provide terminal `status`, `pause`, `resume`, and `quit` commands; pause prevents controller work, while observation may continue. Log startup versions and sanitized configuration.

Acceptance:

- Invalid configuration produces an actionable message.
- Successful spawn yields correct health, hunger, position, inventory, and time.
- Ten minutes connected in the actual local world without an uncaught exception.
- Quit cleanly closes the connection and process.
- Disconnect and reconnect/restart behavior is documented; no duplicate loop or event handlers.
- No autonomous world-changing actions occur in this stage.

Stop after delivering this stage and the instructions needed for the user to test it. If connection testing requires user interaction, report what is ready and exactly what input or error output is needed.

### Stage 2 — Reliable action primitives

Add and test navigation, gathering, drop pickup, crafting, equipping, eating, and placement individually. Initially invoke through the local terminal test harness.

Each result should include status, reason, elapsed time, and before/after state. Validate inventory delta for gather/craft, distance for navigation, hunger/item change for eating, and resulting block state for placement. Test unreachable blocks, missing ingredients, full inventory, cancellation, and disconnect during an action. Avoid digging under the agent or destabilizing overhead terrain. Account for tool and crafting-table requirements.

Acceptance: each action succeeds with an observed postcondition or exits with a useful, bounded failure. Navigation cannot run forever. Pause/quit interrupt active work.

### Stage 3 — Basic survival controller

Prioritise immediate danger, food, essential tools, and shelter preparation. Use explicit prerequisite chains and resource budgets. Target a starter progression of wood, planks, sticks, crafting table, wooden pickaxe, then suitable stone tools and a dependable food strategy. Reuse stations and avoid endlessly crafting or collecting the same materials.

Implement limited exploration and failed-target cooldowns so absent resources do not produce an infinite retry loop. Distinguish collected blocks from inventory items actually acquired. Include escape/recovery behavior rather than relying solely on passive sheltering.

Acceptance: completes the documented starter progression in a suitable test environment and reports a clear blocked reason when prerequisites cannot be met.

### Stage 4 — First-night survival

Prepare shelter before nightfall using a feasible site, material budget, placement order, and exit plan. Test real collision/reach constraints, gaps, roof completion, and recovery after partial construction. Account for mobs and food shortages. Do not equate a shelter placement attempt with protection.

Acceptance: survive one complete Minecraft day/night cycle from empty inventory without intervention. Report starting conditions, elapsed game time, deaths, food/health minimums, items acquired, and any periods of inactivity.

### Stage 5 — Repeatability and recovery

Test at least five documented seeds/spawn environments. Include missing local wood, awkward terrain, food scarcity, hostile encounters, death, and a connection failure as distinct tests. Maintain action-level logs and compare success rates. Document excluded dimensions/biomes or unsupported situations.

Acceptance: provide honest per-run results, identify dominant failures, and fix those with regression coverage. Do not promise general survival based on a single successful seed.

### Stage 6 — Optional AI planning

Only after primitive actions and baseline survival work, consider an LLM selecting structured goals/actions from an allowlist. Keep emergency responses and execution validation deterministic. Feed it compact observations and recent failures, enforce resource/time budgets, and never execute arbitrary generated code. Treat in-game chat/signs/books as untrusted world data. Agree on provider, cost, and credentials with the user before introducing a paid dependency.

## Telemetry and consultation bundle

Use JSONL with a stable schema. Suggested event fields:

```json
{
  "schemaVersion": 1,
  "runId": "run-001",
  "timestamp": "ISO-8601 UTC timestamp",
  "event": "action_end",
  "actionId": "action-017",
  "action": "gather_wood",
  "reason": "need planks for tools",
  "durationMs": 4200,
  "outcome": "failed",
  "errorCode": "PATH_UNREACHABLE",
  "state": {"health": 20, "food": 18, "dimension": "overworld"}
}
```

Record action starts/ends, cancellations, target selection, inventory changes, health/hunger changes, deaths, lifecycle transitions, and periodic snapshots. Rate-limit repetitive errors. Exclude credentials, authentication URLs/codes, and token caches.

For outside debugging, produce a small bundle containing:

- OS, Node, Minecraft, library versions and current Git revision.
- Goal, starting conditions, world seed if the user wishes, and reproduction steps.
- Expected versus observed behavior.
- Relevant error and 30–60 seconds of surrounding JSONL events.
- Run summary: survival duration, deaths, lowest health/hunger, successful/failed actions, repeated failures, and time without progress.
- Relevant changed files/diff and optional screenshot or short gameplay recording.

Use deterministic policy/action tests where useful, then live integration tests. Keep simulated results clearly separated from real gameplay evidence.

## Prototype status and known issues

The source snapshot below was generated on the laptop. `npm run check` passed, all four policy tests passed, and the installed dependencies imported successfully. **No Minecraft server connection, authentication, movement, crafting, building, or survival was tested.** The source is reference material, not a validated implementation.

Known limitations and risks to address before reuse:

- One large script mixes actions, lifecycle, and planning; replace with staged architecture.
- It starts autonomous actions immediately on spawn, contrary to Stage 1 requirements.
- Only movement has a basic timeout. Other awaited operations and cancellation need stronger guarantees.
- Death/respawn can leave old asynchronous work racing a new session; a boolean flag is insufficient isolation.
- Resource gathering can choose the block under the agent; safe target selection is missing.
- Shelter design assumes clear, flat terrain, centered positioning, reachability, and a workable placement order. None has been validated.
- Failed shelter creation can cycle through construction/cleanup without selecting a better site.
- Food collection is opportunistic: dropped items and possible apples from leaves. This is not sustainable food production.
- Crafting across mixed wood types may lack enough matching ingredients even when aggregate plank counts appear sufficient.
- No combat, dependable threat avoidance, cooking, farming, stone progression, persistent memory, or robust exploration.
- Four tests cover simple policy priority decisions only; they do not validate action execution or lifecycle behavior.
- The recorded dependency audit reported six moderate findings in the dependency chain associated with an older `uuid` advisory (GHSA-w5hq-g745-h8pq). The proposed automated fix was a major downgrade to Mineflayer 1.4.0. Do not apply it blindly; re-audit current dependencies and assess a compatible upstream resolution.

## Initial instruction to act on

Start with Stage 1. Inspect the desktop project, confirm the environment details that cannot be discovered locally, and implement connection, observation, logging, and terminal controls. Use the appendix only as reference. Run appropriate local tests and prepare a precise live-test checklist. Report files changed, checks performed, what remains unverified, and the next information needed from the user. Do not start the later survival stages until Stage 1 has been reviewed and tested.

## Appendix — Original prototype files

These fenced blocks preserve the original source and configuration. Paths are relative to the original project root. Extract to a separate `reference/` directory if needed; do not overwrite an existing implementation without inspecting it.

### `package.json`

```json
{
  "name": "minecraft-survival-agent",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node --env-file=.env src/agent.js",
    "check": "node --check src/agent.js",
    "test": "node --test"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "mineflayer": "4.39.0",
    "mineflayer-pathfinder": "2.4.5",
    "vec3": "0.2.0"
  }
}
```

### `.env.example`

```dotenv
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=SurvivalAgent
MC_AUTH=microsoft
# Leave empty to detect the server version.
MC_VERSION=
```

### `.gitignore`

```gitignore
node_modules/
.env
.auth/
*.log
```

### `src/policy.js`

```javascript
const edible = new Set(['apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'baked_potato', 'carrot', 'melon_slice', 'sweet_berries'])
function choose({food, night, sheltered, logs, planks, sticks, pickaxe, dirt, hasFood}) {
  if (food < 18 && hasFood) return 'eat'
  if (sheltered) return night ? 'wait' : 'leave'
  if (night && dirt >= 25) return 'shelter'
  if (logs < 4 && planks < 16) return 'wood'
  if (planks < 16) return 'planks'
  if (sticks < 2 && !pickaxe) return 'sticks'
  if (!pickaxe) return 'pickaxe'
  if (dirt < 25) return 'dirt'
  return 'forage'
}
module.exports = {choose, edible}
```

### `src/agent.js`

```javascript
const mineflayer = require('mineflayer')
const {pathfinder, Movements, goals} = require('mineflayer-pathfinder')
const {Vec3} = require('vec3')
const readline = require('node:readline')
const {choose, edible} = require('./policy')
const auth = process.env.MC_AUTH || 'microsoft'
if (!['microsoft', 'offline'].includes(auth)) throw new Error('MC_AUTH must be microsoft or offline')
const port = Number(process.env.MC_PORT || 25565)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MC_PORT')
const bot = mineflayer.createBot({host: process.env.MC_HOST || 'localhost', port,
  username: process.env.MC_USERNAME || 'SurvivalAgent', auth,
  version: process.env.MC_VERSION || false, profilesFolder: '.auth'})
bot.loadPlugin(pathfinder)
let active = false, paused = false, running = false, shelter = null, lastAction = ''
const failures = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const items = () => bot.inventory.items()
const count = test => items().filter(i => typeof test === 'string' ? i.name === test : test(i.name)).reduce((s,i) => s+i.count,0)
const log = message => console.log(new Date().toISOString(), message)
function check() { if (!active || paused) throw new Error('Paused or disconnected') }
async function go(pos, range = 2) {
  check()
  const timer = setTimeout(() => bot.pathfinder.setGoal(null), 15000)
  try { await bot.pathfinder.goto(new goals.GoalNear(pos.x,pos.y,pos.z,range)); check() }
  finally { clearTimeout(timer) }
}
async function gather(predicate) {
  check()
  const block = bot.findBlock({matching:b => predicate(b.name) && (failures.get(b.position.toString()) || 0) < Date.now(), maxDistance:32})
  if (!block) throw new Error('No reachable resource nearby')
  try {
    await go(block.position)
    check()
    if (!bot.canDigBlock(block)) throw new Error('Cannot safely reach block')
    await bot.dig(block)
    await go(block.position, 1)
    await sleep(500)
  } catch (e) { failures.set(block.position.toString(),Date.now()+60000); throw e }
}
async function craft(name, times = 1, table = null) {
  check()
  const id = bot.registry.itemsByName[name]?.id
  if (id === undefined) throw new Error('Unknown recipe: '+name)
  const recipe = bot.recipesFor(id,null,1,table)[0]
  if (!recipe) throw new Error('Missing ingredients for '+name)
  await bot.craft(recipe,times,table)
}
async function placeAt(pos, name) {
  check()
  if (bot.blockAt(pos)?.name !== 'air') throw new Error('Build location is obstructed')
  const item = items().find(i => i.name === name)
  if (!item) throw new Error('Missing '+name)
  for (const face of [new Vec3(0,1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1),new Vec3(0,-1,0)]) {
    const ref = bot.blockAt(pos.minus(face))
    if (ref?.boundingBox === 'block') {
      await bot.equip(item,'hand'); check(); await bot.placeBlock(ref,face); return
    }
  }
  throw new Error('No supporting block')
}
async function pickaxe() {
  let table = bot.findBlock({matching:bot.registry.blocksByName.crafting_table.id,maxDistance:16})
  if (!table) {
    if (!count('crafting_table')) await craft('crafting_table')
    const base = bot.entity.position.floored()
    for (const delta of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
      const pos = base.plus(delta)
      if (bot.blockAt(pos)?.name === 'air' && bot.blockAt(pos.offset(0,-1,0))?.boundingBox === 'block') {
        await placeAt(pos,'crafting_table'); table = bot.blockAt(pos); break
      }
    }
  }
  if (!table) throw new Error('No space for crafting table')
  await go(table.position); await craft('wooden_pickaxe',1,table)
}
async function buildShelter() {
  const base = bot.entity.position.floored()
  // A 3x3 shell: eight blocks per wall layer, plus nine roof blocks.
  const targets = []
  for (let y=0;y<2;y++) for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) if(x || z) targets.push(base.offset(x,y,z))
  for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) targets.push(base.offset(x,2,z))
  if (targets.some(p => bot.blockAt(p)?.name !== 'air') ||
      targets.slice(0,8).some(p => bot.blockAt(p.offset(0,-1,0))?.boundingBox !== 'block')) throw new Error('Shelter needs clear, flat 3x3 ground')
  await go(base,0)
  shelter = {base, placed:[], complete:false}
  for(const pos of targets) { await placeAt(pos,'dirt'); shelter.placed.push(pos) }
  shelter.complete = true
}
async function leaveShelter() {
  for (const pos of [...shelter.placed].reverse()) {
    check()
    const block = bot.blockAt(pos)
    if (block?.name === 'dirt' && bot.canDigBlock(block)) await bot.dig(block)
  }
  shelter = null
}
async function step() {
  const night = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500
  const action = choose({food:bot.food,night,sheltered:!!shelter,hasFood:items().some(i=>edible.has(i.name)),
    logs:count(n=>n.endsWith('_log')),planks:count(n=>n.endsWith('_planks')),sticks:count('stick'),pickaxe:count(n=>n.endsWith('_pickaxe')),dirt:count('dirt')})
  if (action !== lastAction) { log('Action: '+action); lastAction = action }
  if (shelter && !shelter.complete) return leaveShelter()
  switch(action) {
    case 'eat': await bot.equip(items().find(i=>edible.has(i.name)),'hand'); check(); await bot.consume(); break
    case 'wood': await gather(n=>n.endsWith('_log')); break
    case 'planks': {
      const logItem = items().find(i=>i.name.endsWith('_log'))
      if (!logItem) throw new Error('Need more logs')
      await craft(logItem.name.replace(/_log$/,'_planks')); break
    }
    case 'sticks': await craft('stick'); break
    case 'pickaxe': await pickaxe(); break
    case 'dirt': await gather(n=>n==='dirt'); break
    case 'shelter': await buildShelter(); break
    case 'leave': await leaveShelter(); break
    case 'forage': {
      const drop = bot.nearestEntity(e=>e.name==='item' && e.position.distanceTo(bot.entity.position)<24)
      if (drop) await go(drop.position,0)
      else await gather(n=>n.endsWith('_leaves')) // Oak leaves may drop apples.
      break
    }
    case 'wait': await sleep(1000); break
  }
}
async function loop() {
  if (running) return
  running = true
  try { while(active) {
    if (!paused) try { await step() } catch(e) { log(e.message); await sleep(2000) }
    await sleep(500)
  }} finally { running = false }
}
bot.on('spawn',()=>{
  const movement = new Movements(bot)
  movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.maxDropDown = 1
  bot.pathfinder.setMovements(movement)
  active = true; shelter = null
  log('Spawned. Terminal commands: pause, resume, status, quit.'); void loop()
})
bot.on('death',()=>{active=false; bot.pathfinder.setGoal(null); log('Died; waiting for respawn')})
bot.on('end',()=>{active=false; log('Disconnected. Restart to reconnect.'); process.exitCode=1; input.close()})
bot.on('kicked',reason=>log('Kicked: '+JSON.stringify(reason)))
bot.on('error',error=>log('Connection error: '+error.message))
const input = readline.createInterface({input:process.stdin,output:process.stdout})
input.on('line',line=>{
  const cmd = line.trim().toLowerCase()
  if(cmd==='pause') { paused=true; bot.pathfinder.setGoal(null); bot.stopDigging(); bot.clearControlStates(); log('Paused') }
  if(cmd==='resume') { paused=false; log('Resumed') }
  if(cmd==='status') log(JSON.stringify({active,paused,health:bot.health,food:bot.food,action:lastAction,inventory:bot.inventory ? items().map(i=>`${i.name}: ${i.count}`):[]}))
  if(cmd==='quit') shutdown()
})
function shutdown() { active=false; paused=true; bot.pathfinder.setGoal(null); bot.quit(); input.close() }
process.on('SIGINT',shutdown)
```

### `src/policy.test.js`

```javascript
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {choose} = require('./policy')
const ready = {food:20,night:false,sheltered:false,logs:4,planks:16,sticks:2,pickaxe:1,dirt:25,hasFood:false}
test('food takes priority over construction',()=>assert.equal(choose({...ready,food:10,hasFood:true,night:true}),'eat'))
test('takes shelter at night when supplied',()=>assert.equal(choose({...ready,night:true}),'shelter'))
test('stays enclosed at night and leaves in daylight',()=>{
 assert.equal(choose({...ready,night:true,sheltered:true}),'wait')
 assert.equal(choose({...ready,sheltered:true}),'leave')
})
test('fresh spawn gathers wood',()=>assert.equal(choose({...ready,logs:0,planks:0,pickaxe:0,dirt:0}),'wood'))
```

### `README.md`

```markdown
# Minecraft survival agent prototype

A rule-based Java Edition bot built with Mineflayer and mineflayer-pathfinder. No AI API key required.

## Run

Requires Node.js 22 or newer.

1. Run `npm install`.
2. Copy `.env.example` to `.env` and set the host and port of your own test world/server.
3. With `MC_AUTH=microsoft`, set `MC_USERNAME` to the bot account identifier and follow the Microsoft device login prompt. An authenticated server needs a Minecraft Java account for the bot; use a separate account if playing alongside it. Tokens are stored in ignored `.auth/`.
4. Use `MC_AUTH=offline` only for a server you own that is already configured for offline clients. This setting does not change the server authentication policy.
5. Run `npm start`. Version detection is automatic, or set `MC_VERSION` to a version supported by the installed Mineflayer release.

For a local world, Open to LAN and use the displayed port. Keep that world open. Authentication depends on the host configuration.

Terminal commands: `pause`, `resume`, `status`, `quit`. The agent does not accept commands from other players in chat.

## Current behavior and limits

Gathers nearby logs, crafts planks/sticks/a wooden pickaxe, collects dirt, eats safe food already in its inventory, collects nearby dropped items and breaks leaves for possible apples. At night it attempts a 3x3 dirt enclosure on flat clear ground; it removes its placed shell in daylight. Navigation times out and failed resource targets get a cooldown.

This is an initial survival prototype, not a reliable autonomous survival player. It has no combat, farming, cooking, stone progression, long-range exploration, or persistent memory. Food collection is opportunistic; terrain, mobs, and missing resources can defeat or stall it. The shelter requires 25 dirt and flat clear ground. It modifies the world, so start in a disposable test world. Pausing cancels movement/digging; an already submitted crafting or placement action may finish. Respawn and world interactions need live validation.

## Checks

`npm run check` checks syntax. `npm test` tests survival priorities. These do not verify a Minecraft connection or actual survival. A live server test is required.

Upstream: https://github.com/PrismarineJS/mineflayer and https://github.com/PrismarineJS/mineflayer-pathfinder
```

