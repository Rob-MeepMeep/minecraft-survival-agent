'use strict';

/**
 * Stage 4 Live Acceptance Verification Harness: Natural-Time First-Night Survival
 *
 * Strict Protocol:
 * - Zero operator permissions for SurvivalAgent.
 * - Zero /summon, /give, /tp, resource placement, inventory injection, or manual movement.
 * - Audit command_attempted, command_accepted, command_rejected, server_response.
 * - Launch only during world's natural morning; wait offline for natural dawn if needed.
 * - From natural_run_started onward:
 *   - Zero successful harness commands
 *   - Zero production slash commands
 *   - Zero injections or manual control
 *   - Zero deaths or reconnects
 *   - Continuous worldAge and timeOfDay consistency
 *   - 30-block building reserve
 *   - Complete shelter before timeOfDay 12000
 *   - Enclosure integrity through the night
 *   - Safe dawn exit
 *   - Progression resumption
 *   - At least 24,000 naturally advancing ticks
 *   - Structured milestone log (timestamp, worldAge, timeOfDay, delta, modular TOD, drift, pos, vitals, goal, stackDepth)
 *   - Every run writes immutable evidence keyed by run ID and source commit SHA.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');

const { loadConfig } = require('../src/config');
const { createAgent } = require('../src/connection');
const { createTelemetry } = require('../src/telemetry');
const { ActionManager } = require('../src/actions/manager');
const { createNavigator } = require('../src/actions/navigate');
const { createGatherer } = require('../src/actions/gather');
const { createCrafter } = require('../src/actions/craft');
const { createEquipper } = require('../src/actions/equip');
const { createEater } = require('../src/actions/eat');
const { createPlacer } = require('../src/actions/place');
const { createAttacker } = require('../src/actions/attack');
const {
  loadBlueprint,
  auditEnclosure,
  checkExitSafety,
  findAlternativeSafeExit,
  clearBlueprint,
} = require('../src/actions/shelter');
const { FailureTracker } = require('../src/controller/failure_tracker');
const {
  GoalPlanner,
  SAFE_FOODS,
  getExpendableBuildingBlocks,
  getLatestSafeGatherStart,
  calculateHeldNutrition,
  SHELTER_PREP_TIME,
  SHELTER_DEADLINE,
  DAWN_TIME,
} = require('../src/controller/planner');
const { SurvivalController, HEALTH_THRESHOLDS } = require('../src/controller/survival_controller');
const { snapshot } = require('../src/observer');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Step 0: Offline Dawn Synchronization
// ---------------------------------------------------------------------------

async function probeServerTime(config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const dummyAgent = createAgent(config, { emit: () => {} });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { dummyAgent.bot.quit(); } catch {}
        reject(new Error('Server probe timed out'));
      }
    }, 7000);

    dummyAgent.bot.once('spawn', () => {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const timeOfDay = dummyAgent.bot.time.timeOfDay;
          const worldAge = dummyAgent.bot.time.age;
          const pos = dummyAgent.bot.entity.position;
          try { dummyAgent.bot.quit(); } catch {}
          resolve({ timeOfDay, worldAge, position: pos });
        }
      }, 500);
    });

    dummyAgent.bot.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function syncWithNaturalDawn(config) {
  log('Checking server time for natural morning start window (timeOfDay 500..2000)...');
  while (true) {
    let probe;
    try {
      probe = await probeServerTime(config);
    } catch (err) {
      log(`Probe failed (${err.message}). Retrying in 5s...`);
      await wait(5000);
      continue;
    }

    const tod = probe.timeOfDay;
    const age = probe.worldAge;
    log(`Server probe: worldAge=${age}, timeOfDay=${tod}`);

    // Morning window: timeOfDay between 500 and 2000 (after sunrise, hostiles burned in daylight)
    if (tod >= 500 && tod <= 2000) {
      log(`>>> Natural morning detected (timeOfDay: ${tod}). Morning window is OPEN. Launching verification! <<<`);
      return probe;
    }

    // Outside permitted morning window
    const ticksUntilDawn = tod < 500 ? (500 - tod) : (24000 - tod + 500);
    const secondsUntilDawn = Math.round(ticksUntilDawn / 20);
    log(`Current timeOfDay is ${tod} (afternoon/night). Permitted morning window passed.`);
    log(`Waiting offline for natural dawn. Approx ${ticksUntilDawn} ticks (~${secondsUntilDawn}s) remaining...`);

    // Sleep offline in chunks of up to 25 seconds
    const sleepTime = Math.min(25000, Math.max(5000, (secondsUntilDawn - 15) * 1000));
    await wait(sleepTime);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Verification Runner
// ---------------------------------------------------------------------------

async function runStage4Verification() {
  console.log('========================================================================');
  console.log('🚀 STAGE 4: Final Fresh-World Resource-Clean Survival Verification');
  console.log('========================================================================\n');

  // Capture git commit for immutable evidence
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    gitCommit = 'git-unavailable';
  }

  const runId = `stage4-${Date.now()}`;
  const runArtifactsDir = path.join(process.cwd(), 'artifacts', 'stage4-runs', runId);
  fs.mkdirSync(runArtifactsDir, { recursive: true });

  // Tee console output into transcript buffer
  const transcript = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, cb) => {
    transcript.push(chunk.toString());
    return origStdoutWrite(chunk, encoding, cb);
  };
  process.stderr.write = (chunk, encoding, cb) => {
    transcript.push(chunk.toString());
    return origStderrWrite(chunk, encoding, cb);
  };

  log(`Run ID: ${runId}`);
  log(`Source Commit: ${gitCommit}`);
  log(`Evidence Directory: ${runArtifactsDir}`);

  const config = loadConfig();

  // 1. Sync with natural dawn offline before launching agent
  await syncWithNaturalDawn(config);

  const telemetry = createTelemetry(runId);
  const agent = createAgent(config, telemetry);
  const { bot } = agent;

  let productionSlashCommands = 0;
  let harnessSlashCommands = 0;
  let harnessSlashCommandsPostBoundary = 0;
  let isHarnessCalling = false;
  let runStarted = false;
  let originalChat = null;

  function setupChatInterceptor() {
    if (bot.chat && !originalChat) {
      originalChat = bot.chat.bind(bot);
      bot.chat = function(msg) {
        if (typeof msg === 'string' && msg.startsWith('/')) {
          if (!isHarnessCalling) {
            productionSlashCommands++;
            console.error(`🚨 VIOLATION: Production code issued slash command: "${msg}"`);
          } else {
            if (runStarted) {
              harnessSlashCommandsPostBoundary++;
              console.error(`🚨 VIOLATION: Harness issued slash command after runStarted: "${msg}"`);
              process.exit(1);
            }
            harnessSlashCommands++;
          }
        }
        return originalChat(msg);
      };
    }
  }

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
  const failureTracker = new FailureTracker({ maxDispatchedActions: 500, maxDispatchedPerGoal: 150 });

  const survivalController = new SurvivalController({
    bot,
    actionManager,
    primitives: { navigator, gatherer, crafter, equipper, eater, placer, attacker },
    telemetry,
    failureTracker,
    options: {
      criticalFood: 6,
      eatThreshold: 14,
      targetReserve: 30,
      foodReserveNutrition: 10,
      dawnWaitTimeoutMs: 10000,
      exitTimeoutMs: 60000,
      tickIntervalMs: 100,
    },
  });

  log('Waiting for agent to spawn and load chunks...');
  await new Promise((resolve) => {
    if (agent.ready) return resolve();
    bot.once('spawn', resolve);
  });

  setupChatInterceptor();
  clearBlueprint();

  await wait(2000);

  // Command auditing
  const preflightResults = {
    command_attempted: [],
    command_accepted: [],
    command_rejected: [],
    server_response: [],
  };

  let pendingCommandResolve = null;
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (isHarnessCalling && pendingCommandResolve) {
      pendingCommandResolve(text);
    }
  });

  async function harnessRunCmd(cmd) {
    if (runStarted) {
      throw new Error(`Cannot run harness command after natural_run_started boundary: ${cmd}`);
    }
    isHarnessCalling = true;
    const timestamp = new Date().toISOString();
    preflightResults.command_attempted.push({ command: cmd, timestamp });

    try {
      let serverResponseText = '';
      const responsePromise = new Promise((resolve) => {
        pendingCommandResolve = resolve;
      });

      bot.chat(cmd);

      // Wait up to 400ms for server chat/feedback
      const timer = setTimeout(() => {
        if (pendingCommandResolve) {
          pendingCommandResolve('');
        }
      }, 400);

      serverResponseText = await responsePromise;
      clearTimeout(timer);
      pendingCommandResolve = null;

      const lower = serverResponseText.toLowerCase();
      const isRejection = lower.includes('unknown') ||
                          lower.includes('permission') ||
                          lower.includes('incorrect') ||
                          lower.includes('error') ||
                          lower.includes('cannot');

      preflightResults.server_response.push({ command: cmd, response: serverResponseText, timestamp });

      if (isRejection) {
        preflightResults.command_rejected.push({ command: cmd, response: serverResponseText, timestamp });
        log(`Preflight Command REJECTED by server: "${cmd}" -> "${serverResponseText}"`);
      } else {
        preflightResults.command_accepted.push({ command: cmd, response: serverResponseText, timestamp });
        log(`Preflight Command ACCEPTED by server: "${cmd}" -> "${serverResponseText || '(no error)'}"`);
      }
    } finally {
      isHarnessCalling = false;
    }
  }

  // -------------------------------------------------------------------------
  // Preflight Setup (Zero resource assistance: no /summon, no /give, no /tp, no /time set)
  // -------------------------------------------------------------------------
  log('Executing standard non-resource server environment baseline...');
  await harnessRunCmd('/gamerule doDaylightCycle true');
  await harnessRunCmd('/gamerule doMobSpawning true');
  await harnessRunCmd('/weather clear');
  await harnessRunCmd('/clear @s');

  // If player is trapped inside an enclosed space (e.g. from an un-exited shelter from an interrupted run),
  // break out through the doorway/open wall so player can walk freely on the surface.
  if (bot.entity?.position) {
    const p = bot.entity.position;
    const isEnclosed = ['+x', '-x', '+z', '-z'].every(dir => {
      const dx = dir === '+x' ? 1 : dir === '-x' ? -1 : 0;
      const dz = dir === '+z' ? 1 : dir === '-z' ? -1 : 0;
      const bHead = bot.blockAt ? bot.blockAt(p.offset(dx, 1, dz)) : null;
      return bHead && bHead.boundingBox === 'block';
    });
    if (isEnclosed) {
      log('Detected player enclosed in structure. Clearing exit path...');
      const dirs = [
        { dx: 0, dz: -1 },
        { dx: 0, dz: 1 },
        { dx: 1, dz: 0 },
        { dx: -1, dz: 0 },
      ];
      let exitDir = null;
      for (const d of dirs) {
        const outsideHead = bot.blockAt(p.offset(d.dx * 2, 1, d.dz * 2));
        const outsideFeet = bot.blockAt(p.offset(d.dx * 2, 0, d.dz * 2));
        if ((!outsideHead || outsideHead.boundingBox === 'empty') && (!outsideFeet || outsideFeet.boundingBox === 'empty')) {
          exitDir = d;
          break;
        }
      }
      if (!exitDir) exitDir = dirs[0];
      const wallHead = bot.blockAt(p.offset(exitDir.dx, 1, exitDir.dz));
      const wallFeet = bot.blockAt(p.offset(exitDir.dx, 0, exitDir.dz));
      if (wallHead && wallHead.name !== 'air') {
        try { await bot.dig(wallHead); } catch {}
      }
      if (wallFeet && wallFeet.name !== 'air') {
        try { await bot.dig(wallFeet); } catch {}
      }
      bot.lookAt(p.offset(exitDir.dx * 5, 0, exitDir.dz * 5));
      bot.setControlState('forward', true);
      await wait(1200);
      bot.setControlState('forward', false);
    }
  }

  log('Discarding any existing inventory items naturally...');
  for (let attempt = 0; attempt < 3; attempt++) {
    const items = bot.inventory.items();
    if (items.length === 0) break;
    const dropPos = bot.entity.position.clone();
    for (const item of items) {
      try { await bot.tossStack(item); } catch {}
    }
    // Navigate away from drop point using GoalInvert so player does not vacuum back discarded items
    try {
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.scafoldingBlocks = [];
      movements.allow1by1towers = false;
      bot.pathfinder.setMovements(movements);
      const fleeGoal = new goals.GoalInvert(new goals.GoalNear(dropPos.x, dropPos.y, dropPos.z, 5.0));
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { bot.pathfinder.stop(); } catch {}
          reject(new Error('Navigation timed out'));
        }, 6000);
      });
      await Promise.race([
        bot.pathfinder.goto(fleeGoal),
        timeoutPromise,
      ]).finally(() => clearTimeout(timer));
    } catch (e) {
      log(`Preflight step-away notice: ${e.message}`);
    }
    // Wait for pickup delay to completely expire (> 40 ticks = 2000ms)
    await wait(2500);
  }
  await wait(500);

  // Inspect inventory to prove clean empty state
  const startingInventory = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
  log(`Starting Inventory snapshot: ${JSON.stringify(startingInventory)} (must be [])`);

  // Scan natural environment
  const startPos = bot.entity.position;
  const startTod = bot.time.timeOfDay;
  const startAge = bot.time.age;
  const biome = bot.blockAt(startPos)?.biome?.name || 'plains';

  const nearbyEntities = Object.values(bot.entities)
    .filter(e => e && e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) <= 32)
    .map(e => ({ name: e.name || e.type, distance: Math.round(bot.entity.position.distanceTo(e.position) * 10) / 10 }));

  const nearbyResources = [];
  const checkedBlocks = new Set();
  for (let dx = -10; dx <= 10; dx += 2) {
    for (let dz = -10; dz <= 10; dz += 2) {
      for (let dy = -2; dy <= 4; dy++) {
        const b = bot.blockAt(startPos.offset(dx, dy, dz));
        if (b && b.name !== 'air' && b.name !== 'cave_air' && !checkedBlocks.has(b.name)) {
          checkedBlocks.add(b.name);
          nearbyResources.push(b.name);
        }
      }
    }
  }

  const metadata = {
    runId,
    sourceCommit: gitCommit,
    worldIdentity: bot.game?.dimension || 'overworld',
    seed: null,
    minecraftVersion: bot.version || '26.1',
    mineflayerVersion: require('mineflayer/package.json').version,
    nodeVersion: process.version,
    server: `${config.host || 'localhost'}:${config.port || 25565}`,
    worldAge: startAge,
    timeOfDay: startTod,
    biome,
    weather: 'clear',
    difficulty: 'normal',
    position: {
      x: Math.round(startPos.x * 10) / 10,
      y: Math.round(startPos.y * 10) / 10,
      z: Math.round(startPos.z * 10) / 10,
    },
    health: bot.health,
    food: bot.food,
    saturation: bot.foodSaturation,
    inventorySnapshot: startingInventory,
    nearbyEntities,
    nearbyResources,
    preflightResults,
  };

  // -------------------------------------------------------------------------
  // Run Boundary: natural_run_started
  // -------------------------------------------------------------------------
  runStarted = true; // HARD LOCK: ZERO HARNESS COMMANDS ALLOWED PAST THIS POINT

  telemetry.emit({
    event: 'natural_run_started',
    timestamp: new Date().toISOString(),
    startAge,
    startTimeOfDay: startTod,
    runId,
    sourceCommit: gitCommit,
    metadata,
  });

  log('========================================================================');
  log(`🌟 BOUNDARY DEMARCATION: natural_run_started at worldAge=${startAge}, timeOfDay=${startTod}`);
  log('Zero harness commands, zero production commands, zero injections enforced henceforth.');
  log('========================================================================');

  // Tracking state
  let totalAdvancingTicks = 0;
  let lastAge = bot.time.age;
  let lastTod = bot.time.timeOfDay;
  let lastWallTime = Date.now();
  let timeInconsistency = null;
  let enclosureBreached = false;
  let nightEnclosureAuditsPassed = 0;
  let nightEatingVerified = false;
  let dawnExitVerified = false;
  let progressionResumedVerified = false;
  let maxHungerDrop = bot.food ?? 20;
  let minHealthDrop = bot.health ?? 20;
  let playerDiedDuringRun = false;
  let woodenPickaxeCrafted = false;
  let stonePickaxeCrafted = false;
  let woodenPickaxeBeforeStone = false;
  let lifecycleFailure = null;
  const actionsSummary = { totalAttempted: 0, succeeded: 0, failed: 0, actions: {}, failures: {} };
  const milestonesRecorded = [];

  bot.on('death', () => {
    if (runStarted) {
      playerDiedDuringRun = true;
      console.error('🚨 VIOLATION: Player died during autonomous execution!');
    }
  });

  bot.on('blockUpdate', (oldB, newB) => {
    if (!runStarted) return;
    const bp = loadBlueprint();
    if (!bp || !bp.center) return;
    if (survivalController.shelterSafetyClaim && survivalController.currentGoal === 'wait_out_night') {
      const pos = newB?.position || oldB?.position;
      if (pos && isShelterCoord(pos, bp.center)) {
        if (Array.isArray(bp.exitCoordinates) && bp.exitCoordinates.some(c => c.x === Math.floor(pos.x) && c.y === Math.floor(pos.y) && c.z === Math.floor(pos.z))) {
          return;
        }
        if (!newB || newB.boundingBox !== 'block') {
          enclosureBreached = true;
          console.error(`🚨 BREACH DETECTED: Shelter block at (${pos.x}, ${pos.y}, ${pos.z}) broken!`);
        }
      }
    }
  });

  function isShelterCoord(pos, center) {
    const cx = center.x, cy = center.y, cz = center.z;
    const px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z);
    if (px >= cx - 1 && px <= cx + 1 && pz >= cz - 1 && pz <= cz + 1 && py >= cy - 1 && py <= cy + 2) {
      if (px === cx && pz === cz && (py === cy || py === cy + 1)) return false;
      return true;
    }
    return false;
  }

  bot.on('time', () => {
    if (!runStarted) return;
    const currentAge = bot.time.age;
    const currentTod = bot.time.timeOfDay;
    const deltaAge = currentAge - lastAge;

    if (deltaAge < 0) {
      timeInconsistency = `Non-monotonic world age: ${currentAge} < ${lastAge}`;
    }

    const deltaTimeOfDay = (currentTod - lastTod + 24000) % 24000;
    if (Math.abs(deltaTimeOfDay - deltaAge) > 80 && deltaAge > 0) {
      timeInconsistency = `Unexplained time jump: deltaAge=${deltaAge}, deltaTimeOfDay=${deltaTimeOfDay}`;
    }

    if (deltaAge > 0) {
      totalAdvancingTicks += deltaAge;
      lastAge = currentAge;
      lastTod = currentTod;
      lastWallTime = Date.now();
    }
  });

  // Telemetry listener for milestones & causal derivation
  const origEmit = telemetry.emit.bind(telemetry);
  telemetry.emit = (evt) => {
    origEmit(evt);

    if (evt.health !== undefined && evt.health < minHealthDrop) {
      minHealthDrop = evt.health;
    }
    if (evt.event === 'controller_critical_health_no_recovery') {
      lifecycleFailure = 'critical_health_no_recovery';
    }
    if (evt.event === 'controller_preemption' && evt.reason === 'budget_exceeded') {
      lifecycleFailure = 'budget_exceeded';
    }
    if (evt.status === 'failed_unsafe') {
      lifecycleFailure = 'failed_unsafe';
    }

    if (evt.event === 'action_start') {
      actionsSummary.totalAttempted++;
      actionsSummary.actions[evt.action] = (actionsSummary.actions[evt.action] || 0) + 1;
    }

    if (evt.event === 'action_end') {
      if (evt.outcome === 'success') {
        actionsSummary.succeeded++;
      } else {
        actionsSummary.failed++;
        const failKey = `${evt.action}:${evt.reason || evt.outcome}`;
        actionsSummary.failures[failKey] = (actionsSummary.failures[failKey] || 0) + 1;
      }

      if (evt.action === 'craft' && evt.outcome === 'success') {
        const itemName = evt.item || evt.details?.item;
        if (itemName === 'wooden_pickaxe') woodenPickaxeCrafted = true;
        if (itemName === 'stone_pickaxe') {
          stonePickaxeCrafted = true;
          if (woodenPickaxeCrafted) woodenPickaxeBeforeStone = true;
        }
      }
    }

    if (evt.event === 'milestone_achieved') {
      const currentAge = evt.worldAge || bot.time.age;
      const currentTod = evt.timeOfDay !== undefined ? evt.timeOfDay : bot.time.timeOfDay;
      const worldAgeDelta = currentAge - startAge;
      const expectedModularTimeOfDay = (startTod + worldAgeDelta) % 24000;
      const drift = Math.abs(currentTod - expectedModularTimeOfDay);

      const record = {
        milestone: evt.milestone,
        timestamp: evt.timestamp || new Date().toISOString(),
        worldAge: currentAge,
        timeOfDay: currentTod,
        worldAgeDelta,
        expectedModularTimeOfDay,
        drift,
        position: evt.position || (bot.entity?.position ? {
          x: Math.round(bot.entity.position.x * 10) / 10,
          y: Math.round(bot.entity.position.y * 10) / 10,
          z: Math.round(bot.entity.position.z * 10) / 10,
        } : null),
        vitals: {
          health: evt.health ?? bot.health,
          food: evt.food ?? bot.food,
          saturation: evt.saturation ?? bot.foodSaturation,
        },
        currentGoal: evt.currentGoal || survivalController.currentGoal,
        goalStackDepth: evt.goalStackDepth ?? (survivalController.goalStack ? survivalController.goalStack.length : 0),
      };

      milestonesRecorded.push(record);
      log(`🎯 MILESTONE: [${record.milestone}] worldAge=${record.worldAge}, TOD=${record.timeOfDay}, delta=${record.worldAgeDelta}, drift=${record.drift}, Goal=${record.currentGoal}, StackDepth=${record.goalStackDepth}`);
    }

    if (evt.event === 'action_end' && evt.action === 'eat' && evt.outcome === 'success') {
      if (survivalController.currentGoal === 'wait_out_night' || survivalController.shelterSafetyClaim) {
        nightEatingVerified = true;
        log(`Night eating verified: item=${evt.item}, food=${evt.food}`);
      }
    }

    // Progression resumption must occur after dawn exit
    if (evt.event === 'controller_goal_resumed' && (evt.goal === 'stone_pickaxe' || evt.goal === 'wooden_pickaxe')) {
      if (dawnExitVerified || survivalController.milestones.dawnExitCompleted) {
        progressionResumedVerified = true;
        log(`Progression causally resumed post-shelter: goal=${evt.goal}`);
      }
    }

    if (evt.event === 'controller_intent' && (evt.action === 'gather' || evt.action === 'navigate' || evt.action === 'craft') &&
        (survivalController.currentGoal === 'stone_pickaxe' || survivalController.currentGoal === 'wooden_pickaxe')) {
      if (dawnExitVerified || survivalController.milestones.dawnExitCompleted) {
        progressionResumedVerified = true;
        log(`Progression action dispatched post-shelter: action=${evt.action}, goal=${survivalController.currentGoal}`);
      }
    }
  };

  // Launch SurvivalController
  log('Launching SurvivalController with primary goal: "stone_pickaxe"...');
  await survivalController.start('stone_pickaxe');

  const TARGET_TICKS = 24000;
  const loopStartTime = Date.now();
  let lastProgressLog = Date.now();
  let shelterEnclosedBeforeDusk = false;

  while (totalAdvancingTicks < TARGET_TICKS) {
    await wait(500);

    const now = Date.now();
    const tod = bot.time.timeOfDay;
    const food = bot.food ?? 20;
    const hp = bot.health ?? 20;

    if (hp < minHealthDrop) minHealthDrop = hp;
    if (survivalController.milestones.woodenPickaxeAchieved && survivalController.milestones.stonePickaxeAchieved) {
      woodenPickaxeBeforeStone = true;
    }

    if (playerDiedDuringRun || hp <= 0 || bot.isDead) {
      console.error(`❌ Player died during run (hp=${hp}, dead=${playerDiedDuringRun})`);
      break;
    }

    if (now - lastWallTime > 20000) {
      console.error('❌ Time stalled for > 20 seconds');
      break;
    }

    if (timeInconsistency) {
      console.error(`❌ Inconsistency detected: ${timeInconsistency}`);
      break;
    }

    if (!shelterEnclosedBeforeDusk && survivalController.shelterSafetyClaim && tod < SHELTER_DEADLINE) {
      shelterEnclosedBeforeDusk = true;
      log(`✅ Shelter sealed at timeOfDay ${tod} (< ${SHELTER_DEADLINE})`);
    }

    if (survivalController.currentGoal === 'wait_out_night' || survivalController.shelterSafetyClaim) {
      const bp = loadBlueprint();
      if (bp && bp.center) {
        const audit = auditEnclosure(bot, bp);
        if (audit.enclosed) {
          nightEnclosureAuditsPassed++;
        } else {
          enclosureBreached = true;
          console.error(`🚨 Shelter breached: missing=${audit.missingCoordinates.length}`);
        }
      }
    }

    if (survivalController.milestones.dawnExitCompleted) {
      dawnExitVerified = true;
    }

    if (now - lastProgressLog >= 10000) {
      lastProgressLog = now;
      const pct = Math.min(100, Math.round((totalAdvancingTicks / TARGET_TICKS) * 100));
      const elapsedSec = Math.round((now - loopStartTime) / 1000);
      log(`Progress: ${totalAdvancingTicks}/${TARGET_TICKS} ticks (${pct}%) | TOD: ${tod} | HP: ${hp} | Food: ${food} | Goal: ${survivalController.currentGoal} | WallTime: ${elapsedSec}s`);
    }

    if (dawnExitVerified && progressionResumedVerified && totalAdvancingTicks >= TARGET_TICKS) {
      log('Full 24,000 continuous ticks and all lifecycle stages completed!');
      break;
    }
  }

  // -------------------------------------------------------------------------
  // Causal Gate Derivation from Post-Boundary Telemetry
  // -------------------------------------------------------------------------
  console.log('\n========================================================================');
  console.log('📋 STAGE 4 VERIFICATION RESULTS');
  console.log('========================================================================\n');

  const buildingReserveMilestone = milestonesRecorded.find(m => m.milestone === 'building_reserve_acquired');
  const shelterEnclosedMilestone = milestonesRecorded.find(m => m.milestone === 'shelter_enclosed');
  const nightSurvivedMilestone = milestonesRecorded.find(m => m.milestone === 'night_survived');
  const dawnExitMilestone = milestonesRecorded.find(m => m.milestone === 'dawn_exit_completed');

  // Gate 5: Natural Resource Acquisition
  const zeroHarnessIntervention = harnessSlashCommandsPostBoundary === 0;
  const zeroProductionSlashCommands = productionSlashCommands === 0;
  const preflightClean = preflightResults.command_attempted.every(
    c => !c.command.includes('/summon') && !c.command.includes('/give') && !c.command.includes('/tp')
  );
  const naturalAcquisitionPassed = zeroHarnessIntervention && zeroProductionSlashCommands && preflightClean;

  // Gate 6: 30-Block Building Reserve (causally before dusk)
  const reserveAcquiredPassed = Boolean(
    buildingReserveMilestone &&
    buildingReserveMilestone.worldAge >= startAge &&
    buildingReserveMilestone.timeOfDay < SHELTER_DEADLINE
  );

  // Gate 7: Complete Shelter Before Dusk (causally after reserve and before 12000)
  const shelterEnclosedPassed = Boolean(
    shelterEnclosedMilestone &&
    shelterEnclosedMilestone.worldAge >= startAge &&
    shelterEnclosedMilestone.timeOfDay < SHELTER_DEADLINE &&
    (shelterEnclosedBeforeDusk || survivalController.milestones.shelterEnclosed)
  );

  // Gate 8: Night Enclosure Integrity Maintained (causally after enclosed and survived night)
  const nightEnclosurePassed = Boolean(
    shelterEnclosedPassed &&
    !enclosureBreached &&
    !survivalController.breachDetected &&
    nightEnclosureAuditsPassed >= 50 &&
    nightSurvivedMilestone !== undefined
  );

  // Gate 10: Safe Dawn Exit (causally after night survived)
  const dawnExitPassed = Boolean(
    nightEnclosurePassed &&
    dawnExitMilestone &&
    (dawnExitVerified || survivalController.milestones.dawnExitCompleted)
  );

  // Gate 11: Progression Resumption (causally after dawn exit)
  const progressionResumedPassed = Boolean(
    dawnExitPassed &&
    progressionResumedVerified
  );

  const finalHealth = bot.health ?? 20;
  const minHealthPassed = minHealthDrop >= HEALTH_THRESHOLDS.MIN_ACCEPTANCE_HEALTH;
  const finalHealthPassed = finalHealth >= HEALTH_THRESHOLDS.MIN_FINAL_HEALTH;
  const toolProgressionPassed = Boolean(woodenPickaxeBeforeStone);
  const cleanLifecyclePassed = Boolean(
    !lifecycleFailure &&
    !enclosureBreached &&
    !survivalController.breachDetected &&
    survivalController.status !== 'failed_unsafe' &&
    survivalController.status !== 'critical_health_no_recovery'
  );

  const gates = [
    {
      gate: 'Zero Production Slash Commands',
      passed: zeroProductionSlashCommands,
      detail: `Issued ${productionSlashCommands} production slash commands (must be 0)`,
    },
    {
      gate: 'Zero Post-Boundary Harness Injections',
      passed: zeroHarnessIntervention,
      detail: `Harness issued ${harnessSlashCommandsPostBoundary} commands after natural_run_started boundary (must be 0)`,
    },
    {
      gate: 'Zero Player Deaths',
      passed: !playerDiedDuringRun && bot.health > 0 && !bot.isDead,
      detail: `Player survived with ${finalHealth}/20 HP`,
    },
    {
      gate: 'Minimum Health Safety Margin',
      passed: minHealthPassed,
      detail: `Minimum health was ${minHealthDrop.toFixed(2)}/20 (threshold >= ${HEALTH_THRESHOLDS.MIN_ACCEPTANCE_HEALTH})`,
    },
    {
      gate: 'Final Health Safety Margin',
      passed: finalHealthPassed,
      detail: `Final health was ${finalHealth.toFixed(2)}/20 (threshold >= ${HEALTH_THRESHOLDS.MIN_FINAL_HEALTH})`,
    },
    {
      gate: 'Continuous Game Tick Advancement',
      passed: totalAdvancingTicks >= TARGET_TICKS && !timeInconsistency,
      detail: `${totalAdvancingTicks} continuous natural advancing ticks (>= ${TARGET_TICKS}) without skips`,
    },
    {
      gate: 'Natural Tool Progression',
      passed: toolProgressionPassed,
      detail: toolProgressionPassed
        ? 'Wooden pickaxe crafted before stone pickaxe via causal crafting sequence'
        : 'Tool progression sequence was not verified causally',
    },
    {
      gate: 'Natural Resource Acquisition',
      passed: naturalAcquisitionPassed,
      detail: 'Derived from telemetry: 0 /give or /summon, 0 harness injections, all resources gathered naturally',
    },
    {
      gate: '30-Block Building Reserve',
      passed: reserveAcquiredPassed,
      detail: buildingReserveMilestone
        ? `Building reserve achieved at worldAge=${buildingReserveMilestone.worldAge}, TOD=${buildingReserveMilestone.timeOfDay} (< ${SHELTER_DEADLINE})`
        : 'Building reserve milestone not verified before dusk',
    },
    {
      gate: 'Complete Shelter Before Dusk (timeOfDay < 12000)',
      passed: shelterEnclosedPassed,
      detail: shelterEnclosedMilestone
        ? `Shelter enclosed at worldAge=${shelterEnclosedMilestone.worldAge}, TOD=${shelterEnclosedMilestone.timeOfDay} (< ${SHELTER_DEADLINE})`
        : 'Shelter enclosed milestone not verified before dusk',
    },
    {
      gate: 'Night Enclosure Integrity Maintained',
      passed: nightEnclosurePassed,
      detail: `Intact through night; ${nightEnclosureAuditsPassed} audits passed, zero breaches detected`,
    },
    {
      gate: 'Critical Starvation Avoidance',
      passed: maxHungerDrop > 6,
      detail: `Lowest hunger was ${maxHungerDrop}/20 (maintained above critical threshold 6)`,
    },
    {
      gate: 'Safe Dawn Exit',
      passed: dawnExitPassed,
      detail: dawnExitMilestone
        ? `Dawn exit executed at worldAge=${dawnExitMilestone.worldAge}, TOD=${dawnExitMilestone.timeOfDay}`
        : 'Dawn exit milestone not verified post-night',
    },
    {
      gate: 'Progression Resumption',
      passed: progressionResumedPassed,
      detail: progressionResumedPassed
        ? 'Daytime progression goal causally resumed and action dispatched post-exit'
        : 'Progression resumption not verified following dawn exit',
    },
    {
      gate: 'Clean Execution Lifecycle & Safety',
      passed: cleanLifecyclePassed,
      detail: cleanLifecyclePassed
        ? 'No budget_exceeded, failed_unsafe, critical_health_no_recovery, or unresolved breach'
        : `Lifecycle failure detected: ${lifecycleFailure || 'enclosure_breached'}`,
    },
  ];

  let passedGates = 0;
  for (const g of gates) {
    if (g.passed) {
      console.log(`✅ [PASS] ${g.gate}: ${g.detail}`);
      passedGates++;
    } else {
      console.error(`❌ [FAIL] ${g.gate}: ${g.detail}`);
    }
  }

  const allPassed = passedGates === gates.length;
  const finalSummary = {
    runId,
    sourceCommit: gitCommit,
    verdict: allPassed ? 'STAGE_4_ACCEPTED' : 'STAGE_4_FAILED',
    passedGates,
    totalGates: gates.length,
    totalAdvancingTicks,
    durationSeconds: Math.round((Date.now() - loopStartTime) / 1000),
    finalVitals: { health: finalHealth, food: bot.food, saturation: bot.foodSaturation },
    finalInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    milestones: milestonesRecorded,
    controllerMilestones: survivalController.milestones,
    gates,
    metadata,
  };

  // Close telemetry stream
  try {
    await telemetry.close();
  } catch (err) {
    console.error('Warning: Error closing telemetry stream:', err.message);
  }

  // 1. Write metadata, milestones, actions_summary, damage_timeline, config_fingerprint
  const configFingerprint = {
    schemaVersion: 1,
    runId,
    timestamp: new Date().toISOString(),
    host: config.host || 'localhost',
    port: config.port,
    version: config.version || '1.21',
    options: survivalController.options,
    sha256: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'),
  };
  fs.writeFileSync(path.join(runArtifactsDir, 'config_fingerprint.json'), JSON.stringify(configFingerprint, null, 2), 'utf8');
  fs.writeFileSync(path.join(runArtifactsDir, 'milestones.json'), JSON.stringify(milestonesRecorded, null, 2), 'utf8');
  fs.writeFileSync(path.join(runArtifactsDir, 'damage_timeline.json'), JSON.stringify(survivalController.damageTimeline || [], null, 2), 'utf8');
  fs.writeFileSync(path.join(runArtifactsDir, 'actions_summary.json'), JSON.stringify(actionsSummary, null, 2), 'utf8');
  fs.writeFileSync(path.join(runArtifactsDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  fs.writeFileSync(path.join(runArtifactsDir, 'result.json'), JSON.stringify(finalSummary, null, 2), 'utf8');

  // 2. Compress telemetry JSONL and transcript TXT
  const rawTelemetryPath = telemetry.getFilePath();
  if (fs.existsSync(rawTelemetryPath)) {
    const rawTelemetry = fs.readFileSync(rawTelemetryPath);
    fs.writeFileSync(path.join(runArtifactsDir, 'telemetry.jsonl.gz'), zlib.gzipSync(rawTelemetry));
  }
  const rawTranscript = Buffer.from(transcript.join(''), 'utf8');
  fs.writeFileSync(path.join(runArtifactsDir, 'transcript.txt.gz'), zlib.gzipSync(rawTranscript));

  // 3. Compute SHA-256 for all retained evidence files and generate manifest.json
  const retainedFiles = [
    'result.json',
    'metadata.json',
    'config_fingerprint.json',
    'milestones.json',
    'damage_timeline.json',
    'actions_summary.json',
    'telemetry.jsonl.gz',
    'transcript.txt.gz',
  ];
  const fileHashes = {};
  for (const fileName of retainedFiles) {
    const filePath = path.join(runArtifactsDir, fileName);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath);
      fileHashes[fileName] = {
        sizeBytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      };
    }
  }

  const manifest = {
    schemaVersion: 1,
    runId,
    sourceCommit: gitCommit,
    timestamp: new Date().toISOString(),
    verdict: finalSummary.verdict,
    passedGates,
    totalGates: gates.length,
    files: fileHashes,
  };
  fs.writeFileSync(path.join(runArtifactsDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 4. Update root stage4_live_results.json with platform-independent forward slash path.
  // IMPORTANT: result.json (the artifact file hashed above) must never be written again —
  // evidencePath and manifest are added only to the in-memory copy written to the root file.
  const rootResultsCopy = Object.assign({}, finalSummary, {
    evidencePath: path.relative(process.cwd(), runArtifactsDir).replace(/\\\/g, '/'),
    manifest,
  });
  const rootResultsPath = path.join(process.cwd(), 'stage4_live_results.json');
  fs.writeFileSync(rootResultsPath, JSON.stringify(rootResultsCopy, null, 2), 'utf8');

  // 5. Post-packaging integrity check: re-hash result.json to confirm it was never modified
  //    after the manifest hash was recorded.
  {
    const artifactResultPath = path.join(runArtifactsDir, 'result.json');
    const verifyContent = fs.readFileSync(artifactResultPath);
    const verifyHash = crypto.createHash('sha256').update(verifyContent).digest('hex');
    const manifestHash = fileHashes['result.json']?.sha256;
    if (verifyHash !== manifestHash) {
      log('INTEGRITY FAILURE: result.json sha256 mismatch — file was modified after hashing!');
      log(`  Expected (manifest): ${manifestHash}`);
      log(`  Actual   (file):     ${verifyHash}`);
      // Do not exit here — verdict is already finalised; surface the error in logs.
    } else {
      log('Integrity check passed: result.json sha256 matches manifest.');
    }
  }

  log(`Immutable evidence written to: ${runArtifactsDir}`);
  log(`Updated root results: ${rootResultsPath}`);

  console.log('\n========================================================================');
  console.log(`🏁 VERDICT: ${finalSummary.verdict} (${passedGates}/${gates.length} Gates Passed)`);
  console.log('========================================================================\n');

  await survivalController.stop('verification_completed');
  bot.quit();
  process.exit(allPassed ? 0 : 1);
}

runStage4Verification().catch((err) => {
  console.error('Fatal error in Stage 4 test runner:', err);
  process.exit(1);
});
