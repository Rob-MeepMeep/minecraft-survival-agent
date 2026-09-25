'use strict';

/**
 * Live In-Game Verification Suite for Stage 3B:
 * Autonomous Stone-Pickaxe Progression.
 *
 * Test 1: Dry-Run Projected-State Simulation for stone_pickaxe (simulated: true labeling).
 * Test 2: Live Autonomous Stone Pickaxe Milestone:
 *         Start empty-handed in daylight -> produce wooden pickaxe -> equip tool ->
 *         gather 3 exposed stone -> reuse crafting table -> craft stone pickaxe.
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createNavigator } = require('../src/actions/navigate');
const { createGatherer, getInventoryCounts } = require('../src/actions/gather');
const { createCrafter } = require('../src/actions/craft');
const { createEquipper } = require('../src/actions/equip');
const { createEater } = require('../src/actions/eat');
const { createPlacer } = require('../src/actions/place');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { SurvivalController } = require('../src/controller/survival_controller');

const config = loadConfig();
const runId = `stone-test-${Date.now()}`;
const telemetry = createTelemetry(runId);

const agent = createAgent(config, telemetry);
const { bot } = agent;

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
  },
  telemetry,
  failureTracker,
});

bot.once('spawn', async () => {
  console.log('\n🤖 Agent spawned. Preparing controlled daylight environment for Stage 3B test...');
  await new Promise((r) => setTimeout(r, 2000));

  // Ensure daylight, clear weather, peaceful environment
  bot.chat('/time set day');
  bot.chat('/weather clear');
  bot.chat('/difficulty peaceful');
  bot.chat('/clear');
  await new Promise((r) => setTimeout(r, 1000));

  const playerPos = bot.entity.position.floored();

  // Clear any existing crafting tables within 32m to test autonomous creation & reuse of its own table
  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  if (tableId && typeof bot.findBlocks === 'function') {
    const existing = bot.findBlocks({ matching: tableId, maxDistance: 32, count: 20 });
    for (const pos of existing) {
      bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} air`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('Beginning Stage 3B Focused Verification Suite...\n');

  try {
    // =========================================================================
    // Part 1: Dry-Run Projected-State Simulator for Stone Pickaxe
    // =========================================================================
    console.log('--- Part 1: Dry-Run Projected-State Simulator for stone_pickaxe ---');

    console.log('Running dryRun: "simulate" for stone_pickaxe...');
    const simRes = await survivalController.start('stone_pickaxe', { dryRun: 'simulate' });
    console.log(`Simulated trace generated ${simRes.trace.length} steps.`);

    for (const step of simRes.trace) {
      if (!step.simulated) {
        throw new Error(`Step ${step.step} missing simulated: true tag!`);
      }
      if (step.action) {
        console.log(`  Step ${step.step} [SIMULATED]: ${step.action} (${step.reason}) -> args: ${JSON.stringify(step.args)}`);
      } else {
        console.log(`  Step ${step.step} [SIMULATED]: ${step.status} -> ${step.message || step.reason}`);
      }
    }

    const simFinal = simRes.trace[simRes.trace.length - 1];
    if (simFinal.status !== 'completed' || simFinal.goal !== 'stone_pickaxe') {
      throw new Error(`Simulated plan did not reach completion! Last step: ${JSON.stringify(simFinal)}`);
    }

    // Verify inventory in world is still completely empty
    const actualCounts = getInventoryCounts(bot);
    if (Object.keys(actualCounts).length !== 0) {
      throw new Error(`Actual inventory modified during dry-run: ${JSON.stringify(actualCounts)}`);
    }
    console.log('✅ PASS: Projected-state simulation successfully resolved full stone pickaxe sequence with simulated: true labels without executing world actions.');

    // =========================================================================
    // Part 2: Live Autonomous Stone Pickaxe Progression
    // =========================================================================
    console.log('\n--- Part 2: Live Autonomous Stone Pickaxe Progression ---');
    console.log('Starting state: empty inventory, daylight, peaceful environment.');

    // Set up tree logs fixture for Tier 1
    const treeX = playerPos.x + 3;
    const treeZ = playerPos.z;
    const baseY = playerPos.y;

    console.log(`Creating oak log fixture at (${treeX}, ${baseY}..${baseY + 2}, ${treeZ})...`);
    bot.chat(`/setblock ${treeX} ${baseY} ${treeZ} oak_log`);
    bot.chat(`/setblock ${treeX} ${baseY + 1} ${treeZ} oak_log`);
    bot.chat(`/setblock ${treeX} ${baseY + 2} ${treeZ} oak_log`);

    // Ensure clean solid stone base for crafting table placement adjacent to player
    bot.chat(`/setblock ${playerPos.x + 1} ${baseY - 1} ${playerPos.z} stone`);
    bot.chat(`/setblock ${playerPos.x + 1} ${baseY} ${playerPos.z} air`);

    // Set up 4 exposed stone blocks nearby
    const stonePositions = [
      { x: playerPos.x + 2, y: baseY, z: playerPos.z + 2 },
      { x: playerPos.x + 2, y: baseY, z: playerPos.z - 2 },
      { x: playerPos.x - 2, y: baseY, z: playerPos.z + 2 },
      { x: playerPos.x - 2, y: baseY, z: playerPos.z - 2 },
    ];

    console.log('Creating exposed stone fixtures...');
    for (const sp of stonePositions) {
      bot.chat(`/setblock ${sp.x} ${sp.y} ${sp.z} stone`);
      bot.chat(`/setblock ${sp.x} ${sp.y + 1} ${sp.z} air`); // Ensure exposed
    }
    await new Promise((r) => setTimeout(r, 1000));

    console.log('Launching autonomous survival controller for goal: "stone_pickaxe"...');
    const startRes = await survivalController.start('stone_pickaxe');
    console.log(`Controller launched: [${startRes.controllerRunId}] status=${startRes.status}`);

    // Wait for the autonomous controller to achieve the goal or timeout (max 75 seconds)
    const startTime = Date.now();
    const timeoutMs = 75000;
    let completed = false;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));

      const inv = getInventoryCounts(bot);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${elapsed}s] Controller status=${survivalController.status}, dispatchedActions=${failureTracker.getDispatchedActions()}, inventory=${JSON.stringify(inv)}`);

      if (inv.stone_pickaxe && inv.stone_pickaxe >= 1) {
        completed = true;
        break;
      }

      if (!survivalController.active && survivalController.status !== 'running') {
        if (survivalController.status === 'completed') {
          completed = true;
          break;
        } else {
          throw new Error(`Controller stopped unexpectedly with status: ${survivalController.status}`);
        }
      }
    }

    if (!completed) {
      throw new Error(`Timed out waiting for autonomous stone pickaxe creation after ${timeoutMs / 1000}s`);
    }

    // Verify postconditions
    await new Promise((r) => setTimeout(r, 1000));
    const finalInv = getInventoryCounts(bot);
    console.log('\nFinal Inventory:', JSON.stringify(finalInv, null, 2));

    if (!finalInv.stone_pickaxe || finalInv.stone_pickaxe < 1) {
      throw new Error('Stone pickaxe not found in final inventory!');
    }

    console.log(`Dispatched actions: ${failureTracker.getDispatchedActions()}`);
    console.log(`Controller active: ${survivalController.active} (status: ${survivalController.status})`);

    console.log('\n🎉 ALL STAGE 3B AUTONOMOUS STONE-PICKAXE TESTS PASSED CLEANLY!');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ STAGE 3B TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
});
