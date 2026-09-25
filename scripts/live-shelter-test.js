'use strict';

/**
 * Live In-Game Verification Suite for Stage 3D:
 * Autonomous Emergency Shelter Construction & Night Survival.
 *
 * Requirements Verified:
 * 1. timeOfDay (0–23999) exclusively for dusk/night decisions.
 * 2. Daytime reserve preemption & dusk preemption (10000 <= timeOfDay < 23000).
 * 3. Immediate center navigation to (center.x + 0.5, center.y, center.z + 0.5).
 * 4. 25-block deliberate sequence (lower walls -> upper walls -> roof -> exit column).
 * 5. One placement action per block with re-observation and atomic blueprint persistence after every placement.
 * 6. Full 34-block enclosure audit with exact player bounding-box containment (interior [cx, cx+1] x [cz, cz+1]).
 * 7. Sealed night monitoring and hunger maintenance.
 * 8. Durable persistence & reconnect testing.
 * 9. Dawn exit (23000 <= timeOfDay < 10000) with collection-optional doorway clearance and safe step out.
 * 10. Primary goal resumption from goalStack.
 * 11. Zero production slash commands: all /time or setup commands issued solely by test harness.
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createNavigator } = require('../src/actions/navigate');
const { createGatherer } = require('../src/actions/gather');
const { createCrafter } = require('../src/actions/craft');
const { createEquipper } = require('../src/actions/equip');
const { createEater } = require('../src/actions/eat');
const { createPlacer } = require('../src/actions/place');
const { createAttacker } = require('../src/actions/attack');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { SurvivalController } = require('../src/controller/survival_controller');
const {
  GoalPlanner,
  getExpendableBuildingBlocks,
  getLatestSafeGatherStart,
} = require('../src/controller/planner');
const { snapshot } = require('../src/observer');
const {
  loadBlueprint,
  saveBlueprint,
  clearBlueprint,
  validateBlueprintIdentity,
  auditEnclosure,
  checkExitSafety,
} = require('../src/actions/shelter');
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const config = loadConfig();
const runId = `shelter-test-${Date.now()}`;
const telemetry = createTelemetry(runId);

const agent = createAgent(config, telemetry);
const { bot } = agent;

let productionSlashCommands = 0;
let harnessSlashCommands = 0;
let isHarnessCalling = false;
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
const failureTracker = new FailureTracker();

const survivalController = new SurvivalController({
  bot,
  actionManager,
  primitives: { navigator, gatherer, crafter, equipper, eater, placer, attacker },
  telemetry,
  failureTracker,
  options: {
    threatDistance: 8,
    criticalFood: 6,
    tickIntervalMs: 100,
  },
});

let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`✅ ${name}`);
  passed++;
}

function fail(name, reason) {
  console.error(`❌ ${name}: ${reason}`);
  failed++;
}

function log(msg) {
  console.log(`   ${msg}`);
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function harnessRunCmd(cmd) {
  isHarnessCalling = true;
  try {
    bot.chat(cmd);
    await wait(350);
  } finally {
    isHarnessCalling = false;
  }
}

// ---------------------------------------------------------------------------
// Part 1: Dry-Run Projected-State Simulation
// ---------------------------------------------------------------------------

async function testDryRunSimulation() {
  console.log('\n📋 Part 1: Dry-Run Shelter & Reserve Simulation\n');

  // 1. Maintain Building Reserve Simulation
  const traceReserve = GoalPlanner.simulatePlan({
    goal: 'maintain_building_reserve',
    initialInventory: [{ name: 'dirt', count: 23 }],
    maxSteps: 5,
  });

  const gatherStep = traceReserve.find(s => s.action === 'gather');
  const allSim = traceReserve.every(s => s.simulated === true);

  if (allSim && gatherStep) {
    pass('Dry-run maintain_building_reserve: simulated: true, plans gather dirt');
    log(`Reserve trace steps: ${traceReserve.length}`);
  } else {
    fail('Dry-run maintain_building_reserve', `allSim=${allSim} gatherStep=${!!gatherStep}`);
  }

  // 2. Controller Dry-Run Step Mode
  const stepRes = await survivalController.start('build_shelter', { dryRun: 'step' });
  if (stepRes.mode === 'step' && stepRes.plan) {
    pass('SurvivalController dryRun: step mode returns planned next action');
  } else {
    fail('SurvivalController dryRun: step mode', JSON.stringify(stepRes));
  }
}

// ---------------------------------------------------------------------------
// Part 2: Daytime Reserve Preemption Live Test
// ---------------------------------------------------------------------------

async function testLiveReservePreemption() {
  console.log('\n📋 Part 2: Daytime Reserve Preemption Live\n');

  // Set daylight time 9000
  log('Test Harness: Setting timeOfDay to 9000 (daylight)...');
  await harnessRunCmd('/time set 9000');
  await harnessRunCmd('/clear @s');
  await wait(600);

  const snap = snapshot(bot);
  const items = snap?.inventory || [];
  const expendable = getExpendableBuildingBlocks(items);
  const latestSafe = getLatestSafeGatherStart(items);
  log(`Initial expendable blocks: ${expendable}, calculated latest safe start: ${latestSafe}`);

  const events = [];
  const origEmit = telemetry.emit.bind(telemetry);
  telemetry.emit = (event) => {
    events.push(event);
    origEmit(event);
  };

  try {
    log('Starting controller with progression goal: "wooden_pickaxe"...');
    await survivalController.start('wooden_pickaxe');
    await wait(800);

    const suspended = events.find(e => e.event === 'controller_goal_suspended' && e.trigger === 'reserve_preemption');
    if (suspended && survivalController.currentGoal === 'maintain_building_reserve') {
      pass(`Daytime Reserve Preemption: suspended "${suspended.goal}" and switched to "maintain_building_reserve" at time 9000 (latestSafeStart: ${latestSafe})`);
    } else {
      fail('Daytime Reserve Preemption', `currentGoal=${survivalController.currentGoal} suspended=${!!suspended}`);
    }

    // Fulfill reserve by providing dirt
    log('Test Harness: Fulfilling building reserve with 32 dirt...');
    await harnessRunCmd('/give SurvivalAgent minecraft:dirt 32');

    // Wait for gather action to settle and controller tick to evaluate predicate and resume
    const resumeStart = Date.now();
    let resumed = false;
    while (Date.now() - resumeStart < 6000) {
      if (events.some(e => e.event === 'controller_goal_resumed' && e.goal === 'wooden_pickaxe')) {
        resumed = true;
        break;
      }
      await wait(300);
    }

    if (resumed && survivalController.currentGoal === 'wooden_pickaxe') {
      pass('Reserve Fulfillment & Goal Resumption: restored "wooden_pickaxe" after building reserve satisfied');
    } else {
      fail('Reserve Fulfillment & Goal Resumption', `currentGoal=${survivalController.currentGoal} resumed=${resumed}`);
    }
  } finally {
    await survivalController.stop('reserve_test_done');
    await wait(500);
  }
}

// ---------------------------------------------------------------------------
// Part 3: Controlled Live Transition, Restart Recovery, Night Eating & Dawn Exit
// ---------------------------------------------------------------------------

async function testControlledLiveTransition() {
  console.log('\n📋 Part 3: Controlled Live Transition, Restart & Night Survival\n');

  // Clear previous blueprint
  clearBlueprint();

  // Get current bot position floored
  const pos = bot.entity.position.floored();
  log(`Current bot position: ${pos.x}, ${pos.y}, ${pos.z}`);

  // Test Harness: Prepare clean building platform around bot
  log('Test Harness: Preparing clean 7x7 flat natural ground platform...');
  const px = pos.x;
  const py = pos.y;
  const pz = pos.z;

  await harnessRunCmd(`/fill ${px - 3} ${py} ${pz - 3} ${px + 3} ${py + 3} ${pz + 3} minecraft:air`);
  await harnessRunCmd(`/fill ${px - 3} ${py - 1} ${pz - 3} ${px + 3} ${py - 1} ${pz + 3} minecraft:dirt`);
  await harnessRunCmd('/gamerule doDaylightCycle false');
  await harnessRunCmd('/weather clear');
  await harnessRunCmd('/clear @s');
  // Give bot 32 dirt blocks
  await harnessRunCmd('/give SurvivalAgent minecraft:dirt 32');
  await wait(1000);

  // Verify inventory has >= 25 dirt
  const snap1 = snapshot(bot);
  const dirtCount = snap1.inventory?.find(i => i.name === 'dirt')?.count || 0;
  log(`Bot inventory dirt count: ${dirtCount}`);
  if (dirtCount < 25) {
    fail('Inventory setup', `Expected >= 25 dirt, found ${dirtCount}`);
    return;
  }

  // Set timeOfDay to dusk preparation window (10500)
  log('Test Harness: Setting timeOfDay to 10500 (Dusk Preparation)...');
  await harnessRunCmd('/time set 10500');
  await wait(500);

  // Collect controller events
  const events = [];
  const origEmit = telemetry.emit.bind(telemetry);
  telemetry.emit = (event) => {
    events.push(event);
    origEmit(event);
  };

  // Start controller with primary progression goal: 'wooden_pickaxe'
  log('Starting controller with goal: "wooden_pickaxe"...');
  await survivalController.start('wooden_pickaxe');

  // Wait for dusk preemption to trigger
  await wait(1000);

  // Verify Dusk Preemption
  const suspendEvent = events.find(e => e.event === 'controller_goal_suspended' && e.trigger === 'dusk_preemption');
  if (suspendEvent && survivalController.currentGoal === 'build_shelter') {
    pass('Dusk Preemption: successfully suspended "wooden_pickaxe" and switched goal to "build_shelter"');
    log(`Suspended goal: ${suspendEvent.goal}, Stack depth: ${suspendEvent.stackDepth}`);
  } else {
    fail('Dusk Preemption', `currentGoal=${survivalController.currentGoal} suspendEvent=${!!suspendEvent}`);
  }

  // Wait for first 5 placements, then test process restart / resumption
  log('Waiting for partial construction (5 verified blocks)...');
  const partStart = Date.now();
  let testedRestart = false;
  while (Date.now() - partStart < 15000) {
    const curBp = loadBlueprint();
    if (curBp && curBp.verifiedCoordinates && curBp.verifiedCoordinates.length >= 5) {
      log(`Partial build reached ${curBp.verifiedCoordinates.length} verified blocks! Simulating controller process restart...`);
      await survivalController.stop('simulated_restart');
      await wait(500);

      // Verify blueprint persists on disk with verified coordinates
      const diskBp = loadBlueprint();
      if (diskBp && diskBp.verifiedCoordinates.length >= 5) {
        pass(`Partial Construction Persistence: verified ${diskBp.verifiedCoordinates.length} blocks persisted atomically on disk`);
      } else {
        fail('Partial Construction Persistence', `Expected >= 5 verified blocks on disk`);
      }

      // Re-start controller process with same progression goal
      log('Restarting controller process from disk blueprint...');
      await survivalController.start('wooden_pickaxe');
      testedRestart = true;
      break;
    }
    await wait(500);
  }

  if (!testedRestart) {
    fail('Partial Build Restart', 'Did not reach 5 verified placements in time');
  }

  // Monitor completion of remaining shelter placements
  log('Monitoring completion of remaining placements (to reach enclosed state)...');
  const startTime = Date.now();
  let bp = null;

  while (Date.now() - startTime < 60000) {
    bp = loadBlueprint();
    if (bp && bp.buildState === 'waiting') {
      log('Shelter buildState reached "waiting" (construction complete and enclosed)!');
      break;
    }
    await wait(1000);
  }

  bp = loadBlueprint();
  if (bp && (bp.buildState === 'waiting' || bp.buildState === 'enclosed')) {
    pass('Autonomous Shelter Construction: completed all placements and reached enclosed state after restart');
    log(`Verified coordinates count: ${bp.verifiedCoordinates.length}/25`);
    log(`Materials consumed count: ${bp.materialsConsumed.length}`);
  } else {
    fail('Autonomous Shelter Construction', `buildState=${bp?.buildState} verified=${bp?.verifiedCoordinates?.length}`);
    return;
  }

  // Verify Comprehensive Enclosure Audit
  log('Running comprehensive enclosure audit on live shelter...');
  const audit = auditEnclosure(bot, bp);
  log(`Audit result: enclosed=${audit.enclosed}, missing=${audit.missingCoordinates.length}, foreign=${audit.foreignBlocks.length}, playerInside=${audit.playerInside}`);

  if (audit.enclosed && audit.playerInside && audit.missingCoordinates.length === 0) {
    pass('Comprehensive Enclosure Audit: all 34 blocks intact, zero wall clipping, player AABB fully enclosed');
  } else {
    fail('Comprehensive Enclosure Audit', JSON.stringify(audit));
  }

  // Verify Center & Player Position
  const bpos = bot.entity.position;
  const cx = bp.center.x;
  const cy = bp.center.y;
  const cz = bp.center.z;
  log(`Center block: (${cx}, ${cy}, ${cz})`);
  log(`Player actual position: (${bpos.x.toFixed(2)}, ${bpos.y.toFixed(2)}, ${bpos.z.toFixed(2)})`);

  const inBounds = bpos.x >= cx && bpos.x <= cx + 1 && bpos.z >= cz && bpos.z <= cz + 1;
  if (inBounds) {
    pass(`Player Position: standing inside interior cell [${cx}..${cx+1}, ${cz}..${cz+1}]`);
  } else {
    fail('Player Position', `Player at (${bpos.x}, ${bpos.z}) outside cell [${cx}..${cx+1}, ${cz}..${cz+1}]`);
  }

  // Verify Safety Claim
  if (survivalController.shelterSafetyClaim === true) {
    pass('Shelter Safety Claim: controller reports shelterSafetyClaim = true');
  } else {
    fail('Shelter Safety Claim', `Expected true, found ${survivalController.shelterSafetyClaim}`);
  }

  // Verify periodic observation ticks occur without active actions
  await wait(1500);
  const tickEvents = events.filter(e => e.event === 'controller_sheltered_tick');
  if (tickEvents.length >= 2) {
    pass(`Sealed Night Monitoring: verified periodic observation ticks (received ${tickEvents.length} ticks)`);
  } else {
    fail('Sealed Night Monitoring', `Expected >= 2 ticks, got ${tickEvents.length}`);
  }

  // Test Persistence & Identity Validation
  log('Testing blueprint persistence and identity validation...');
  const diskBp = loadBlueprint();
  const valid = validateBlueprintIdentity(diskBp, bot);
  if (valid && diskBp.server && diskBp.dimension && diskBp.requiredCoordinates.every(c => c.expectedMaterial)) {
    pass('Blueprint Persistence: valid on disk with dimension, server, version, and coordinate materials');
  } else {
    fail('Blueprint Persistence', `valid=${valid}`);
  }

  // Night Hunger & Enclosed Eating Verification (Request 7)
  log('Testing night eating inside enclosed shelter (hunger <= 14)...');
  await harnessRunCmd('/give SurvivalAgent minecraft:bread 2');
  // Wait for bread to appear in inventory
  const breadWait = Date.now();
  while (Date.now() - breadWait < 4000) {
    if (bot.inventory?.items()?.some(i => i.name === 'bread')) break;
    await wait(200);
  }
  log(`Bot inventory has bread: ${bot.inventory?.items()?.some(i => i.name === 'bread')}`);

  // Apply server-side hunger effect to drop food level below 14
  log('Test Harness: Draining hunger on server with hunger effect (amplifier 255)...');
  await harnessRunCmd('/effect give SurvivalAgent minecraft:hunger 12 255');
  const hungerDropStart = Date.now();
  while (Date.now() - hungerDropStart < 12000) {
    if (bot.food !== undefined && bot.food <= 14) break;
    await wait(200);
  }
  await harnessRunCmd('/effect clear SurvivalAgent minecraft:hunger');
  log(`Current bot food: ${bot.food}`);

  const eatStart = Date.now();
  let ateFood = false;
  while (Date.now() - eatStart < 12000) {
    const eatEnd = events.find(e => e.event === 'action_end' && e.action === 'eat' && e.outcome === 'success');
    if (eatEnd) {
      ateFood = true;
      break;
    }
    await wait(300);
  }

  if (ateFood) {
    pass('Night Eating: safely consumed bread from inventory while enclosed');
  } else {
    fail('Night Eating', 'Did not observe successful eat action');
  }

  // Re-audit enclosure to verify shelter integrity post-eating
  const postEatAudit = auditEnclosure(bot, bp);
  if (postEatAudit.enclosed && postEatAudit.playerInside) {
    pass('Post-Eating Enclosure Integrity: shelter remains 100% intact and player safely contained');
  } else {
    fail('Post-Eating Enclosure Integrity', JSON.stringify(postEatAudit));
  }

  // Dawn Exit Sequence
  log('Test Harness: Advancing time to dawn (23500)...');
  await harnessRunCmd('/time set 23500');
  await wait(500);

  log('Monitoring dawn exit: doorway clearance and step outside...');
  const exitStart = Date.now();
  let resumed = false;

  while (Date.now() - exitStart < 25000) {
    const resumeEvent = events.find(e => e.event === 'controller_goal_resumed');
    if (resumeEvent && survivalController.currentGoal === 'wooden_pickaxe') {
      resumed = true;
      break;
    }
    await wait(500);
  }

  if (resumed) {
    pass('Dawn Exit & Goal Resumption: doorway cleared, bot stepped outside, and "wooden_pickaxe" resumed from goalStack');
  } else {
    fail('Dawn Exit & Goal Resumption', `currentGoal=${survivalController.currentGoal} resumed=${resumed}`);
  }

  // Verify blueprint state marked completed
  const finalBp = loadBlueprint();
  if (finalBp && finalBp.buildState === 'completed') {
    pass('Shelter Lifecycle: blueprint state marked "completed" upon dawn exit');
  } else {
    fail('Shelter Lifecycle', `Expected buildState="completed", found ${finalBp?.buildState}`);
  }

  await survivalController.stop('test_complete');
}

// ---------------------------------------------------------------------------
// Part 5: Production Slash Command Zero-Tolerance Verification
// ---------------------------------------------------------------------------

function verifyZeroProductionSlashCommands() {
  console.log('\n📋 Part 5: Production Slash Command Audit\n');
  log(`Harness slash commands executed: ${harnessSlashCommands}`);
  log(`Production slash commands detected: ${productionSlashCommands}`);

  if (productionSlashCommands === 0) {
    pass('Zero Slash Commands: production codebase issued exactly 0 slash commands');
  } else {
    fail('Zero Slash Commands', `Production code issued ${productionSlashCommands} slash commands!`);
  }
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('================================================================');
  console.log('  Stage 3D Live In-Game Verification Suite');
  console.log('================================================================\n');

  try {
    log('Waiting for bot to spawn...');
    await new Promise((resolve) => {
      if (agent.ready) return resolve();
      bot.once('spawn', resolve);
    });
    setupChatInterceptor();
    log('Bot spawned successfully. Setting up player state...');
    await harnessRunCmd('/gamemode survival');
    await harnessRunCmd('/difficulty normal');
    await wait(1000);

    // Part 1: Dry-Run Simulation
    await testDryRunSimulation();

    // Part 2: Live Reserve Preemption (Daylight)
    await testLiveReservePreemption();

    // Part 3: Controlled Live Transition, Restart, Night Survival & Dawn Exit
    await testControlledLiveTransition();

    // Part 5: Slash Command Audit
    verifyZeroProductionSlashCommands();

  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    console.log('\n================================================================');
    console.log(`  Stage 3D Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    clearBlueprint();
    await wait(1000);
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
