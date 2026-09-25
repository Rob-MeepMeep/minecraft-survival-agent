'use strict';

const readline = require('node:readline');
const { loadConfig, startupMeta } = require('./config');
const { createTelemetry } = require('./telemetry');
const { createAgent } = require('./connection');
const { snapshot } = require('./observer');
const { ActionManager } = require('./actions/manager');
const { createNavigator, parseNavigationArgs } = require('./actions/navigate');
const { createGatherer } = require('./actions/gather');
const { createCrafter } = require('./actions/craft');
const { createEquipper } = require('./actions/equip');
const { createEater } = require('./actions/eat');
const { createPlacer } = require('./actions/place');
const { createAttacker } = require('./actions/attack');
const { FailureTracker } = require('./controller/failure_tracker');
const { SurvivalController } = require('./controller/survival_controller');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Telemetry
// ---------------------------------------------------------------------------

const runId = `run-${Date.now()}`;
const telemetry = createTelemetry(runId);

// Log startup metadata.
const meta = startupMeta(config);
telemetry.emit({ event: 'startup', ...meta });
telemetry.emit({ event: 'config', config: meta.config });

// ---------------------------------------------------------------------------
// 3. Agent & Action Management
// ---------------------------------------------------------------------------

const agent = createAgent(config, telemetry);
const { bot } = agent;

let paused = false;

// Action manager manages single-flight actions, timeouts, and cancellations.
const actionManager = new ActionManager({
  bot,
  getState: () => ({
    active: agent.active,
    ready: agent.ready,
    sessionId: agent.sessionId,
  }),
  telemetry,
});

const navigator = createNavigator(bot, actionManager);
const gatherer = createGatherer(bot, actionManager);
const crafter = createCrafter(bot, actionManager);
const equipper = createEquipper(bot, actionManager);
const eater = createEater(bot, actionManager);
const placer = createPlacer(bot, actionManager);
const attacker = createAttacker(bot, actionManager);

const failureTracker = new FailureTracker();
const survivalController = new SurvivalController({
  bot,
  actionManager,
  primitives: {
    navigator,
    gatherer,
    crafter,
    equipper,
    eater,
    placer,
    attacker,
  },
  telemetry,
  failureTracker,
});

// Cancel active actions and stop autonomous controller on death or disconnect to invalidate stale continuations.
bot.on('death', () => {
  survivalController.stop('died');
  actionManager.cancel('died');
});

bot.on('end', () => {
  survivalController.stop('disconnected');
  actionManager.cancel('disconnected');
});


// Track run statistics for the final summary.
const runStats = {
  startTime: Date.now(),
  spawns: 0,
  deaths: 0,
  commands: 0,
  snapshots: 0,
  actionsCompleted: 0,
  actionsFailed: 0,
  lowestHealth: null,
  lowestFood: null,
};

// Count events via telemetry wrapper.
const origEmit = telemetry.emit.bind(telemetry);
telemetry.emit = function(event) {
  if (event.event === 'spawn') runStats.spawns++;
  if (event.event === 'death') runStats.deaths++;
  if (event.event === 'snapshot') {
    runStats.snapshots++;
    const hp = event.state?.health;
    const food = event.state?.food;
    if (hp !== null && hp !== undefined) {
      if (runStats.lowestHealth === null || hp < runStats.lowestHealth) runStats.lowestHealth = hp;
    }
    if (food !== null && food !== undefined) {
      if (runStats.lowestFood === null || food < runStats.lowestFood) runStats.lowestFood = food;
    }
  }
  if (event.event === 'command') runStats.commands++;
  if (event.event === 'action_end') {
    if (event.outcome === 'success') {
      runStats.actionsCompleted++;
    } else {
      runStats.actionsFailed++;
    }
  }
  origEmit(event);
};

// ---------------------------------------------------------------------------
// 4. Terminal REPL
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Print available commands on spawn.
bot.once('spawn', () => {
  console.log('\nTerminal commands:');
  console.log('  goto <x> <y> <z> [range] [timeoutSec]  (supports ~dx ~dy ~dz)');
  console.log('  gather <block_name> [maxDistance]      (find, approach, dig, pick up)');
  console.log('  mine <x> <y> <z> [timeoutSec]          (mine specific coordinate)');
  console.log('  craft <item_name> [count]              (craft items using 2x2 or 3x3 grid)');
  console.log('  equip <item_name> [destination]        (equip item to hand, off-hand, head, torso, legs, feet)');
  console.log('  unequip [destination]                  (unequip item from slot)');
  console.log('  eat [food_name] [allow_unsafe]         (consume food to restore hunger/saturation)');
  console.log('  place <x> <y> <z> [block_name]         (place block at target coordinate)');
  console.log('  attack <entity_type> [timeoutSec]      (navigate to and kill food animal)');
  console.log('  auto [goal]                            (start autonomous survival loop, default: wooden_pickaxe)');
  console.log('  dryrun [goal] [step|simulate]          (evaluate plan without execution)');
  console.log('  autostop                               (stop autonomous survival loop)');
  console.log('  stop                                   (cancel active action)');
  console.log('  status                                 (show state & current action)');
  console.log('  pause                                  (cancel action & pause agent)');
  console.log('  resume                                 (unpause agent)');
  console.log('  quit                                   (clean shutdown)\n');
});


rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'goto': {
      if (paused) {
        console.log('⚠️  Agent is paused. Type "resume" before issuing movement commands.');
        return;
      }

      const currentPos = bot.entity?.position;
      const parsed = parseNavigationArgs(parts.slice(1), currentPos);

      if (!parsed.ok) {
        console.log(`❌ ${parsed.error}`);
        return;
      }

      console.log(`🧭 Navigating to (${parsed.target.x}, ${parsed.target.y}, ${parsed.target.z}) [range=${parsed.target.range}, timeout=${parsed.timeoutMs / 1000}s]...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await navigator.goto(parsed.target, parsed.timeoutMs);
        const icon = result.outcome === 'success' ? '✅' : '❌';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason} duration=${result.durationMs}ms finalPos=(${result.finalPos?.x}, ${result.finalPos?.y}, ${result.finalPos?.z}) dist=${result.distanceToTarget ?? 'n/a'}`);
      } catch (err) {
        console.log(`❌ Navigation error: ${err.message}`);
      }
      break;
    }

    case 'gather': {
      if (paused) {
        console.log('⚠️  Agent is paused. Type "resume" before issuing commands.');
        return;
      }
      const blockName = parts[1];
      if (!blockName) {
        console.log('❌ Usage: gather <block_name> [maxDistance=16] [timeoutSec=30]');
        return;
      }
      const maxDistance = parts[2] ? Number(parts[2]) : 16;
      const timeoutSec = parts[3] ? Number(parts[3]) : 30;

      console.log(`⛏️  Gathering "${blockName}" within ${maxDistance} blocks (timeout=${timeoutSec}s)...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await gatherer.gather(blockName, {
          maxDistance,
          timeoutMs: timeoutSec * 1000,
        });
        const icon = result.outcome === 'success' ? '✅' : '❌';
        const items = result.acquiredItems ? result.acquiredItems.map(i => `${i.name}:+${i.delta}`).join(', ') : 'none';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason} duration=${result.durationMs}ms acquired=[${items}]`);
      } catch (err) {
        console.log(`❌ Gather error: ${err.message}`);
      }
      break;
    }

    case 'mine': {
      if (paused) {
        console.log('⚠️  Agent is paused. Type "resume" before issuing commands.');
        return;
      }
      const currentPos = bot.entity?.position;
      const parsed = parseNavigationArgs(parts.slice(1), currentPos);
      if (!parsed.ok) {
        console.log(`❌ ${parsed.error}`);
        return;
      }

      console.log(`⛏️  Mining block at (${parsed.target.x}, ${parsed.target.y}, ${parsed.target.z})...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await gatherer.gather(parsed.target, {
          timeoutMs: parsed.timeoutMs,
        });
        const icon = result.outcome === 'success' ? '✅' : '❌';
        const items = result.acquiredItems ? result.acquiredItems.map(i => `${i.name}:+${i.delta}`).join(', ') : 'none';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason} duration=${result.durationMs}ms acquired=[${items}]`);
      } catch (err) {
        console.log(`❌ Mine error: ${err.message}`);
      }
      break;
    }

    case 'craft': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      if (parts.length < 2) {
        console.log('❌ Usage: craft <item_name> [count]');
        return;
      }
      const itemName = parts[1].toLowerCase();
      const count = parts[2] ? parseInt(parts[2], 10) : 1;
      if (isNaN(count) || count < 1) {
        console.log('❌ Count must be a positive integer');
        return;
      }

      console.log(`🔨 Crafting ${count}x "${itemName}"...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await crafter.craft(itemName, count);
        const icon = result.outcome === 'success' ? '✅' : '❌';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason} duration=${result.durationMs}ms`);
      } catch (err) {
        console.log(`❌ Craft error: ${err.message}`);
      }
      break;
    }

    case 'equip': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      if (parts.length < 2) {
        console.log('❌ Usage: equip <item_name> [destination=hand]');
        return;
      }
      const itemName = parts[1].toLowerCase();
      const destination = parts[2] ? parts[2].toLowerCase() : 'hand';

      console.log(`🛡️  Equipping "${itemName}" to ${destination}...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await equipper.equip(itemName, destination);
        const icon = result.outcome === 'success' ? '✅' : '❌';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason}`);
      } catch (err) {
        console.log(`❌ Equip error: ${err.message}`);
      }
      break;
    }

    case 'unequip': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      const destination = parts[1] ? parts[1].toLowerCase() : 'hand';

      console.log(`🛡️  Unequipping ${destination}...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await equipper.unequip(destination);
        const icon = result.outcome === 'success' ? '✅' : '❌';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason}`);
      } catch (err) {
        console.log(`❌ Unequip error: ${err.message}`);
      }
      break;
    }

    case 'eat': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      const foodName = parts[1] && parts[1] !== 'true' && parts[1] !== 'false' ? parts[1].toLowerCase() : null;
      const allowUnsafe = parts.includes('true') || parts.includes('allow_unsafe');

      console.log(`🍖 Eating ${foodName || 'best available food'}${allowUnsafe ? ' [allow_unsafe]' : ''}...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await eater.eat(foodName, { allowUnsafe });
        const icon = result.outcome === 'success' ? '✅' : '❌';
        const foodInfo = result.foodDelta !== undefined
          ? ` hunger=${result.foodBefore}->${result.foodAfter} (+${result.foodDelta}) sat=${result.satBefore}->${result.satAfter} (+${result.satDelta})`
          : '';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason}${foodInfo}`);
      } catch (err) {
        console.log(`❌ Eat error: ${err.message}`);
      }
      break;
    }

    case 'attack': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      const entityType = parts[1];
      if (!entityType) {
        console.log('❌ Usage: attack <entity_type> [timeoutSec=15]');
        return;
      }
      const attackTimeout = parts[2] ? Number(parts[2]) * 1000 : 15_000;

      console.log(`⚔️  Attacking nearest "${entityType}" (timeout=${attackTimeout / 1000}s)...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await attacker.attack(entityType, { timeoutMs: attackTimeout });
        const icon = result.outcome === 'success' ? '✅' : '❌';
        const loot = result.matchedLoot ? result.matchedLoot.map(l => `${l.name}:+${l.delta}`).join(', ') : 'none';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason} loot=[${loot}]`);
      } catch (err) {
        console.log(`❌ Attack error: ${err.message}`);
      }
      break;
    }

    case 'place': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      if (parts.length < 4) {
        console.log('❌ Usage: place <x> <y> <z> [block_name] or place <block_name> <x> <y> <z>');
        return;
      }

      let x, y, z, blockName;
      if (!isNaN(Number(parts[1]))) {
        x = Number(parts[1]);
        y = Number(parts[2]);
        z = Number(parts[3]);
        blockName = parts[4] ? parts[4].toLowerCase() : null;
      } else {
        blockName = parts[1].toLowerCase();
        x = Number(parts[2]);
        y = Number(parts[3]);
        z = Number(parts[4]);
      }

      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        console.log('❌ Coordinates x, y, z must be valid numbers.');
        return;
      }

      console.log(`🧱 Placing ${blockName || 'block'} at (${x}, ${y}, ${z})...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const result = await placer.place(x, y, z, blockName);
        const icon = result.outcome === 'success' ? '✅' : '❌';
        console.log(`${icon} [${result.actionId}] outcome=${result.outcome} reason=${result.reason} block=${result.details?.block || blockName || 'unknown'}`);
      } catch (err) {
        console.log(`❌ Place error: ${err.message}`);
      }
      break;
    }

    case 'auto': {
      if (paused) {
        console.log('❌ Agent is paused. Use "resume" to unpause.');
        return;
      }
      const goal = parts[1] || 'wooden_pickaxe';
      console.log(`🤖 Starting autonomous survival loop for goal: "${goal}"...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const res = await survivalController.start(goal);
        console.log(`▶️  Controller started [${res.controllerRunId}] status=${res.status}`);
      } catch (err) {
        console.log(`❌ Controller start error: ${err.message}`);
      }
      break;
    }

    case 'dryrun': {
      const goal = parts[1] || 'wooden_pickaxe';
      const mode = parts[2] === 'step' ? 'step' : 'simulate';
      console.log(`📋 Running dry-run plan for goal: "${goal}" (mode: ${mode})...`);
      telemetry.emit({ event: 'command', command: trimmed });

      try {
        const res = await survivalController.start(goal, { dryRun: mode });
        if (res.mode === 'step') {
          console.log(`🔎 Dry-Run Step: action=${res.plan.action} reason=${res.plan.reason} args=${JSON.stringify(res.plan.args)}`);
        } else {
          console.log(`📜 Dry-Run Simulated Trace (${res.trace.length} steps):`);
          for (const step of res.trace) {
            if (step.action) {
              console.log(`   Step ${step.step} [SIMULATED]: ${step.action} (${step.reason}) -> args: ${JSON.stringify(step.args)}`);
            } else {
              console.log(`   Step ${step.step} [SIMULATED]: ${step.status} -> ${step.message || step.reason}`);
            }
          }
        }
      } catch (err) {
        console.log(`❌ Dry-run error: ${err.message}`);
      }
      break;
    }

    case 'autostop': {
      await survivalController.stop('user_stopped');
      console.log('🛑 Autonomous survival controller stopped.');
      telemetry.emit({ event: 'command', command: 'autostop' });
      break;
    }

    case 'stop':
    case 'cancel': {
      await survivalController.stop('user_cancel');
      const cancelled = actionManager.cancel('user_cancel');
      if (cancelled) {
        console.log('🛑 Active action cancelled.');
        telemetry.emit({ event: 'command', command: cmd, cancelled: true });
      } else {
        console.log('ℹ️  No active action to cancel.');
      }
      break;
    }

    case 'status': {
      try {
        const snap = snapshot(bot);
        const output = {
          active: agent.active,
          ready: agent.ready,
          paused,
          sessionId: agent.sessionId,
          currentAction: actionManager.getStatus(),
          controller: {
            active: survivalController.active,
            status: survivalController.status,
            currentRunId: survivalController.currentRunId,
            dispatchedActions: failureTracker.getDispatchedActions(),
          },
          ...snap,
        };
        console.log(JSON.stringify(output, null, 2));
        telemetry.emit({ event: 'command', command: 'status', result: output });
      } catch (err) {
        console.log(`status error: ${err.message}`);
        telemetry.emit({ event: 'command', command: 'status', error: err.message });
      }
      break;
    }

    case 'pause': {
      const wasPaused = paused;
      paused = true;
      // Stop controller and cancel active action on pause.
      await survivalController.stop('paused');
      const actionCancelled = actionManager.cancel('paused');
      telemetry.emit({
        event: 'pause',
        wasPaused,
        paused: true,
        actionCancelled,
      });
      console.log(`⏸️  Agent paused.${actionCancelled ? ' Active action was cancelled.' : ''}`);
      break;
    }


    case 'resume': {
      const wasPaused = paused;
      paused = false;
      // Resume does not resurrect cancelled actions; bot is idle and ready for new instructions.
      telemetry.emit({ event: 'resume', wasPaused, paused: false });
      console.log('▶️  Agent resumed (idle, ready for commands).');
      break;
    }

    case 'quit': {
      actionManager.cancel('quit');
      shutdown('user_quit');
      break;
    }

    default: {
      console.log(`Unknown command: "${cmd}". Available: goto, stop, status, pause, resume, quit`);
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(reason = 'unknown') {
  if (shuttingDown) return;
  shuttingDown = true;

  actionManager.cancel(reason);

  // Give in-flight cancellation a brief tick to settle and log action_end
  await new Promise((resolve) => setTimeout(resolve, 50));

  const durationMs = Date.now() - runStats.startTime;
  telemetry.emit({
    event: 'shutdown',
    reason,
    summary: {
      durationMs,
      durationFormatted: formatDuration(durationMs),
      spawns: runStats.spawns,
      deaths: runStats.deaths,
      commands: runStats.commands,
      snapshots: runStats.snapshots,
      actionsCompleted: runStats.actionsCompleted,
      actionsFailed: runStats.actionsFailed,
      lowestHealth: runStats.lowestHealth,
      lowestFood: runStats.lowestFood,
    },
  });

  agent.shutdown();
  telemetry.close();
  rl.close();
  // Allow pending I/O to flush before exiting.
  setTimeout(() => process.exit(0), 500);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle the bot disconnect so the process exits instead of hanging.
bot.on('end', () => {
  if (!shuttingDown) {
    shutdown('disconnect');
    process.exitCode = 1;
  }
});
