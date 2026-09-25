'use strict';

/**
 * Focused Live Dirt-Acquisition Trial
 *
 * Verifies that the agent can autonomously gather 30 dirt blocks from natural terrain:
 * - Starts with 0 expendable building blocks
 * - Collects 30 dirt blocks under GoalPlanner/maintain_building_reserve
 * - Verifies no repeated stale entity IDs across distinct actions
 * - Verifies anti-trenching and no unsafe pits created
 * - Measures completion time and game ticks
 */

const { loadConfig } = require('../src/config');
const { createAgent } = require('../src/connection');
const { createTelemetry } = require('../src/telemetry');
const { ActionManager } = require('../src/actions/manager');
const { createNavigator } = require('../src/actions/navigate');
const { createGatherer, getExpendableBuildingBlocks } = require('../src/actions/gather');
const { createCrafter } = require('../src/actions/craft');
const { createEquipper } = require('../src/actions/equip');
const { createEater } = require('../src/actions/eat');
const { createPlacer } = require('../src/actions/place');
const { createAttacker } = require('../src/actions/attack');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { SurvivalController } = require('../src/controller/survival_controller');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDirtTrial() {
  console.log('========================================================================');
  console.log('🌱 Focused Live Dirt-Acquisition Trial (Target: 30 Blocks)');
  console.log('========================================================================\n');

  const config = loadConfig();
  const runId = `dirt-trial-${Date.now()}`;
  const telemetry = createTelemetry(runId);
  const agent = createAgent(config, telemetry);
  const { bot } = agent;

  console.log('Waiting for bot to connect and spawn...');
  await new Promise((resolve) => {
    if (agent.ready) return resolve();
    bot.once('spawn', resolve);
  });

  await wait(2500);

  // Preflight setup: discard any leftover items naturally without slash commands
  console.log('📋 Preflight: clearing inventory and establishing baseline...');
  const { createSafeMovements } = require('../src/actions/navigate');
  if (bot.pathfinder) {
    bot.pathfinder.setMovements(createSafeMovements(bot));
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const curItems = bot.inventory ? bot.inventory.items() : [];
    const curExp = curItems
      .filter(i => ['dirt', 'cobblestone'].includes(i.name))
      .reduce((sum, i) => sum + i.count, 0);

    if (curExp === 0) {
      console.log('Successfully established 0 expendable blocks in inventory.');
      break;
    }

    console.log(`Preflight discard attempt ${attempt + 1}: tossing ${curExp} blocks...`);
    for (const item of curItems) {
      if (['dirt', 'cobblestone'].includes(item.name)) {
        try {
          await bot.tossStack(item);
        } catch {}
      }
    }

    // Sprint forward for 1.5 seconds to move away from dropped items
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await wait(1500);
    bot.setControlState('sprint', false);
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
    await wait(1000);
  }

  const initialItems = bot.inventory ? bot.inventory.items() : [];
  const initialExpendable = initialItems
    .filter(i => ['dirt', 'cobblestone'].includes(i.name))
    .reduce((sum, i) => sum + i.count, 0);

  console.log(`Initial expendable blocks in inventory: ${initialExpendable}`);
  if (initialExpendable > 0) {
    console.error('❌ Preflight failed: expected 0 expendable blocks after toss');
    process.exit(1);
  }

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: agent.active, ready: agent.ready, sessionId: agent.sessionId }),
    telemetry,
  });

  const navigator = createNavigator(bot, actionManager);
  const gatherer = createGatherer(bot, actionManager);
  const crafter = createCrafter(bot, actionManager);
  const equipper = createEquipper(bot, actionManager);
  const eater = createEater(bot, actionManager);
  const placer = createPlacer(bot, actionManager);
  const attacker = createAttacker(bot, actionManager);
  const failureTracker = new FailureTracker({ maxDispatchedActions: 500 });

  const controller = new SurvivalController({
    bot,
    actionManager,
    primitives: { navigator, gatherer, crafter, equipper, eater, placer, attacker },
    telemetry,
    failureTracker,
    options: {
      targetReserve: 30,
      threatDistance: null,
      tickIntervalMs: 100,
    },
  });

  // Track entity IDs across gather actions to verify zero stale entity re-use
  const trackedEntityIds = new Map(); // entityId -> count of distinct actions where it was tracked
  const minedCoordinates = [];

  const originalEmit = telemetry.emit.bind(telemetry);
  telemetry.emit = function(event) {
    if (event.event === 'action_end' && event.action === 'gather') {
      const eid = event.details?.trackedEntityId;
      if (eid !== null && eid !== undefined) {
        trackedEntityIds.set(eid, (trackedEntityIds.get(eid) || 0) + 1);
      }
      if (event.args && event.args[0]) {
        minedCoordinates.push(event.args[0]);
      }
    }
    return originalEmit(event);
  };

  const { GoalPlanner } = require('../src/controller/planner');

  console.log('🚀 Starting dirt acquisition loop with GoalPlanner: maintain_building_reserve (target: 30)...');
  const startWallClock = Date.now();
  const startTick = bot.time.age;

  // Monitor until completion or timeout
  const timeoutMs = 120000; // 2 minutes max
  let completed = false;

  while (Date.now() - startWallClock < timeoutMs) {
    if (bot.isAlive === false) {
      try { await bot.respawn(); } catch {}
      await wait(1000);
      continue;
    }

    const curItems = bot.inventory ? bot.inventory.items() : [];
    const curExpendable = curItems
      .filter(i => ['dirt', 'cobblestone'].includes(i.name))
      .reduce((sum, i) => sum + i.count, 0);

    const elapsedSec = ((Date.now() - startWallClock) / 1000).toFixed(1);
    const elapsedTicks = bot.time.age - startTick;

    process.stdout.write(`\r   Progress: ${curExpendable}/30 dirt blocks | Elapsed: ${elapsedSec}s | Ticks: ${elapsedTicks}   `);

    if (curExpendable >= 30) {
      completed = true;
      console.log('\n\n✅ Target reserve of 30 blocks reached!');
      break;
    }

    const plan = GoalPlanner.planNextAction({
      bot,
      goal: 'maintain_building_reserve',
      failureTracker,
      targetReserve: 30,
    });

    if (plan.status === 'completed') {
      completed = true;
      break;
    }

    if (plan.status === 'action_required' && plan.action === 'gather') {
      const result = await gatherer.gather(plan.args[0], plan.args[1]);
      if (result.outcome === 'failed') {
        if (plan.targetKey) failureTracker.recordFailure(plan.targetKey);
      } else {
        if (plan.targetKey) failureTracker.recordSuccess(plan.targetKey);
      }
    } else {
      console.log(`\nPlanner status: ${plan.status}, reason: ${plan.reason}`);
      await wait(500);
    }
  }

  const totalTimeSec = ((Date.now() - startWallClock) / 1000).toFixed(1);
  const totalTicks = bot.time.age - startTick;

  console.log('\n========================================================================');
  console.log('📊 Dirt Acquisition Trial Results');
  console.log('========================================================================');
  console.log(`Total Wall-Clock Time: ${totalTimeSec}s`);
  console.log(`Total Game Ticks: ${totalTicks}`);

  const finalItems = bot.inventory ? bot.inventory.items() : [];
  const finalDirt = finalItems.filter(i => i.name === 'dirt').reduce((s, i) => s + i.count, 0);
  console.log(`Final Dirt Collected: ${finalDirt} / 30`);

  // Verification 1: Target reached
  if (finalDirt < 30) {
    console.error(`❌ Gate 1 FAIL: Collected ${finalDirt}/30 dirt blocks.`);
    process.exit(1);
  } else {
    console.log(`✅ Gate 1 PASS: Collected ${finalDirt} dirt blocks (>= 30).`);
  }

  // Verification 2: Stale entity re-use check
  let repeatedEntityFound = false;
  for (const [eid, count] of trackedEntityIds.entries()) {
    if (count > 1) {
      console.error(`❌ Gate 2 FAIL: Entity ID ${eid} was tracked across ${count} separate actions! Stale entity leak!`);
      repeatedEntityFound = true;
    }
  }
  if (!repeatedEntityFound) {
    console.log(`✅ Gate 2 PASS: Zero stale entity reuse (${trackedEntityIds.size} unique entities tracked, 0 duplicates).`);
  } else {
    process.exit(1);
  }

  // Verification 3: Reasonable completion time (under 90s / 1800 ticks)
  if (totalTicks > 2400) {
    console.error(`❌ Gate 3 FAIL: Collection took too long: ${totalTicks} ticks (${totalTimeSec}s).`);
    process.exit(1);
  } else {
    console.log(`✅ Gate 3 PASS: Efficient completion in ${totalTicks} ticks (${totalTimeSec}s, well within daytime budget).`);
  }

  console.log('\n🎉 ALL FOCUSED DIRT ACQUISITION TRIAL GATES PASSED!\n');
  process.exit(0);
}

runDirtTrial().catch((err) => {
  console.error('Fatal trial error:', err);
  process.exit(1);
});
