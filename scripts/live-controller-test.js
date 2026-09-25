'use strict';

/**
 * Live In-Game Verification Suite for Stage 3A:
 * Deterministic Survival-Controller Integration.
 *
 * Test 1: Dry-Run Projected-State Simulation & Step Mode (simulated: true labeling).
 * Test 2: Live Autonomous Wooden Pickaxe Milestone (start empty-handed in daylight -> gather -> craft -> place -> pickaxe).
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
const runId = `controller-test-${Date.now()}`;
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
  console.log('\n🤖 Agent spawned. Preparing controlled daylight environment for Stage 3A test...');
  await new Promise((r) => setTimeout(r, 2000));

  // Ensure daylight, clear weather, peaceful environment
  bot.chat('/time set day');
  bot.chat('/weather clear');
  bot.chat('/difficulty peaceful');
  bot.chat('/clear');
  await new Promise((r) => setTimeout(r, 1000));

  const playerPos = bot.entity.position.floored();

  // Clear any existing crafting tables within 24m
  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  if (tableId && typeof bot.findBlocks === 'function') {
    const existing = bot.findBlocks({ matching: tableId, maxDistance: 24, count: 20 });
    for (const pos of existing) {
      bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} air`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('Beginning Stage 3A Focused Verification Suite...\n');

  try {
    // =========================================================================
    // Part 1: Dry-Run Projected-State Simulator & One-Step Mode
    // =========================================================================
    console.log('--- Part 1: Dry-Run Projected-State Simulator ---');

    // Test 1A: One-step dry-run mode
    console.log('Running dryRun: "step"...');
    const stepRes = await survivalController.start('wooden_pickaxe', { dryRun: 'step' });
    console.log(`1-Step Result: action=${stepRes.plan.action} reason=${stepRes.plan.reason}`);
    if (stepRes.plan.action !== 'gather') {
      throw new Error(`Expected first step to be "gather", got "${stepRes.plan.action}"`);
    }
    if (survivalController.active !== false || survivalController.status !== 'idle') {
      throw new Error('Controller should be idle after step dry-run');
    }
    console.log('✅ PASS: One-step dry-run mode correctly identified "gather" and left controller idle.');

    // Test 1B: Full projected-state simulation
    console.log('\nRunning dryRun: "simulate"...');
    const simRes = await survivalController.start('wooden_pickaxe', { dryRun: 'simulate' });
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
    if (simFinal.status !== 'completed' || simFinal.goal !== 'wooden_pickaxe') {
      throw new Error(`Simulated plan did not reach completion! Last step: ${JSON.stringify(simFinal)}`);
    }

    // Verify inventory in world is still completely empty (dry run did not alter actual state)
    const actualCounts = getInventoryCounts(bot);
    if (Object.keys(actualCounts).length !== 0) {
      throw new Error(`Actual inventory modified during dry-run: ${JSON.stringify(actualCounts)}`);
    }
    console.log('✅ PASS: Projected-state simulation successfully resolved full wooden pickaxe sequence with simulated: true labels without executing world actions.');

    // =========================================================================
    // Part 2: Live Autonomous Wooden Pickaxe Progression
    // =========================================================================
    console.log('\n--- Part 2: Live Autonomous Wooden Pickaxe Progression ---');
    console.log('Starting state: empty inventory, daylight, peaceful environment.');

    // Create a tree column fixture 3 blocks away from the agent
    const treeX = playerPos.x + 3;
    const treeZ = playerPos.z;
    const baseY = playerPos.y;

    console.log(`Creating oak log fixture at (${treeX}, ${baseY}..${baseY + 2}, ${treeZ})...`);
    bot.chat(`/setblock ${treeX} ${baseY} ${treeZ} oak_log`);
    bot.chat(`/setblock ${treeX} ${baseY + 1} ${treeZ} oak_log`);
    bot.chat(`/setblock ${treeX} ${baseY + 2} ${treeZ} oak_log`);
    // Ensure clean solid stone base for crafting table placement
    bot.chat(`/setblock ${playerPos.x + 1} ${baseY - 1} ${playerPos.z} stone`);
    bot.chat(`/setblock ${playerPos.x + 1} ${baseY} ${playerPos.z} air`);
    await new Promise((r) => setTimeout(r, 1000));

    console.log('Launching autonomous survival controller for goal: "wooden_pickaxe"...');
    const startRes = await survivalController.start('wooden_pickaxe');
    console.log(`Controller launched: [${startRes.controllerRunId}] status=${startRes.status}`);

    // Wait for the autonomous controller to achieve the goal or timeout (max 45 seconds)
    const startTime = Date.now();
    const timeoutMs = 45000;
    let completed = false;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));

      const inv = getInventoryCounts(bot);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${elapsed}s] Controller status=${survivalController.status}, dispatchedActions=${failureTracker.getDispatchedActions()}, inventory=${JSON.stringify(inv)}`);

      if (inv.wooden_pickaxe && inv.wooden_pickaxe >= 1) {
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
      throw new Error(`Timed out waiting for autonomous pickaxe creation after ${timeoutMs / 1000}s`);
    }

    // Verify postconditions
    await new Promise((r) => setTimeout(r, 1000));
    const finalInv = getInventoryCounts(bot);
    console.log('\nFinal Inventory:', JSON.stringify(finalInv, null, 2));

    if (!finalInv.wooden_pickaxe || finalInv.wooden_pickaxe < 1) {
      throw new Error('Wooden pickaxe not found in final inventory!');
    }

    console.log(`Dispatched actions: ${failureTracker.getDispatchedActions()}`);
    console.log(`Controller active: ${survivalController.active} (status: ${survivalController.status})`);

    console.log('\n🎉 ALL STAGE 3A AUTONOMOUS SURVIVAL CONTROLLER TESTS PASSED CLEANLY!');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ STAGE 3A TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
});
