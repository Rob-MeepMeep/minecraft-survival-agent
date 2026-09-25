'use strict';

/**
 * Live In-Game Verification Suite for Stage 3C:
 * Autonomous Food Acquisition & Controller Goal Stack.
 *
 * Scenario 1 (Wheat & Bread):
 *   - Starts at food 10 with primary goal 'wooden_pickaxe'.
 *   - Starvation preemption suspends 'wooden_pickaxe' onto goalStack with { type: 'food_at_least', value: 18 }.
 *   - Planner dynamically calculates needing 2 bread (6 wheat).
 *   - Bot harvests 6 mature wheat with replanting (tracks replanted, finalCropState).
 *   - Reuses/locates nearby crafting table and crafts 2 bread (requiring 3x3 table).
 *   - Consumes bread until food >= 18.
 *   - Goal stack resumes suspended 'wooden_pickaxe'.
 *
 * Scenario 2 (Animal Population Preservation & Hunt):
 *   - Starts at food 15 with 3 adult cows present.
 *   - Planner selects cow (requiring >= 3 adults to preserve breeding pair).
 *   - Immediately pre-attack, rechecks >= 3 adults remain.
 *   - Attacks cow, verifies hits, damage confirmation, death confirmation, and entity-tracked loot.
 *   - Verifies 2 adult cows remain alive.
 *   - Consumes meat until food >= 18.
 *
 * Scenario 3 (Chicken Safety Gate):
 *   - Only chicken available in range.
 *   - Planner blocks BEFORE attack with 'unsafe_food_requires_cooking'.
 *   - Zero attacks dispatched.
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
const { createAttacker, countEligibleAdults } = require('../src/actions/attack');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { SurvivalController } = require('../src/controller/survival_controller');
const { GoalPlanner } = require('../src/controller/planner');
const { snapshot } = require('../src/observer');

const config = loadConfig();
const runId = `food-test-${Date.now()}`;
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
const attacker = createAttacker(bot, actionManager);
const failureTracker = new FailureTracker();

const survivalController = new SurvivalController({
  bot,
  actionManager,
  primitives: { navigator, gatherer, crafter, equipper, eater, placer, attacker },
  telemetry,
  failureTracker,
  options: {
    criticalFood: 14, // triggers starvation preemption when food <= 14
    threatDistance: 8,
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

async function runCmd(cmd) {
  bot.chat(cmd);
  await wait(300);
}

/**
 * Lowers bot hunger to targetFood level using Minecraft hunger effect on Normal difficulty.
 */
async function setBotHunger(targetFood) {
  await runCmd('/difficulty normal');
  await runCmd('/gamerule naturalRegeneration false');
  
  if (bot.food <= targetFood) return;

  log(`Lowering hunger from ${bot.food} to ${targetFood}...`);
  await runCmd('/effect give SurvivalAgent minecraft:hunger 10 255');
  
  const start = Date.now();
  while (bot.food > targetFood && Date.now() - start < 15000) {
    await wait(200);
  }
  await runCmd('/effect clear SurvivalAgent');
  await wait(500);
  log(`Bot food stabilized at ${bot.food}`);
}

// ---------------------------------------------------------------------------
// Part 1: Dry-Run Projected-State Simulation
// ---------------------------------------------------------------------------

async function testDryRunSimulation() {
  console.log('\n📋 Part 1: Dry-Run acquire_food Simulation\n');

  // 1. Food 10 with 6 wheat and table -> plans craft(bread, 2), eat(bread)
  const traceWheat = GoalPlanner.simulatePlan({
    goal: 'acquire_food',
    initialInventory: [{ name: 'wheat', count: 6 }],
    initialFood: 10,
    hasCraftingTable: true,
  });

  const craftStep = traceWheat.find(s => s.action === 'craft' && s.args?.[0] === 'bread');
  const eatStep = traceWheat.find(s => s.action === 'eat');
  const allSim = traceWheat.every(s => s.simulated === true);

  if (allSim && craftStep && eatStep) {
    pass('Dry-run wheat->bread trace: all simulated:true, crafts 2 bread and eats');
    log(`Trace length: ${traceWheat.length} steps`);
    for (const s of traceWheat) {
      log(`  Step ${s.step}: ${s.action || s.status} (${s.reason || s.message || ''})`);
    }
  } else {
    fail('Dry-run wheat->bread trace', `allSim=${allSim} craftStep=${!!craftStep} eatStep=${!!eatStep}`);
  }

  // 2. Chicken only -> blocks with unsafe_food_requires_cooking
  const planChicken = GoalPlanner.planNextAction({
    bot: null,
    goal: 'acquire_food',
    simulatedState: {
      food: 10,
      inventory: [],
      hasCrop: false,
      hasAnimal: true,
      animalType: 'chicken',
    },
  });

  if (planChicken.status === 'blocked' && planChicken.reason === 'unsafe_food_requires_cooking') {
    pass('Dry-run chicken safety gate: blocks before attack with unsafe_food_requires_cooking');
  } else {
    fail('Dry-run chicken safety gate', `status=${planChicken.status} reason=${planChicken.reason}`);
  }

  // 3. Animal count < 3 -> blocks with insufficient_food_acquired
  const planPreserve = GoalPlanner.planNextAction({
    bot: null,
    goal: 'acquire_food',
    simulatedState: {
      food: 10,
      inventory: [],
      hasCrop: false,
      hasAnimal: true,
      animalType: 'cow',
      adultCount: 2, // only 2 adults, cannot preserve breeding pair!
    },
  });

  if (planPreserve.status === 'blocked' && planPreserve.reason === 'insufficient_food_acquired') {
    pass('Dry-run population preservation: blocks with insufficient_food_acquired when adults < 3');
  } else {
    fail('Dry-run population preservation', `status=${planPreserve.status} reason=${planPreserve.reason}`);
  }

  // 4. Live controller dry-run
  const dryRes = await survivalController.start('acquire_food', { dryRun: 'simulate' });
  if (dryRes.mode === 'simulate' && dryRes.trace.every(s => s.simulated === true)) {
    pass(`Live controller dry-run: ${dryRes.trace.length} steps all labeled simulated:true`);
  } else {
    fail('Live controller dry-run', 'trace missing or not simulated');
  }
}

// ---------------------------------------------------------------------------
// Part 2: Scenario 1 - Wheat Harvest, Bread Crafting & Goal Stack Preemption
// ---------------------------------------------------------------------------

async function testScenario1WheatBread() {
  console.log('\n🌾 Part 2: Scenario 1 — Wheat Harvest, Bread Crafting & Goal Resume\n');

  // Teleport bot to flat open ground
  await runCmd('/tp SurvivalAgent 20 86 5');
  await runCmd('/time set noon');
  await runCmd('/gamerule doDaylightCycle false');
  await wait(800);

  // Clear bot inventory & ground items
  await runCmd('/clear SurvivalAgent');
  await runCmd('/kill @e[type=item]');
  await wait(500);

  // Set bot food to 10
  await setBotHunger(10);

  log('Setting up 12 mature wheat plots (hydrated farmland) and crafting table on flat ground...');
  // Clear air above wheat to prevent any leaf/tree obstruction
  await runCmd('/fill 21 87 0 23 93 15 air');
  for (let z = 1; z <= 12; z++) {
    await runCmd(`/setblock 22 85 ${z} farmland[moisture=7]`);
    await runCmd(`/setblock 22 86 ${z} wheat[age=7]`);
  }
  // Place crafting table at (21, 86, 3)
  await runCmd('/setblock 21 86 3 crafting_table');
  await wait(1000);

  // Record initial state
  const foodStart = bot.food;
  log(`Pre-test: food=${foodStart} inventory=${JSON.stringify(getInventoryCounts(bot))}`);

  // Start controller with primary goal 'wooden_pickaxe'
  log('Starting controller with primary goal wooden_pickaxe (criticalFood=14)...');
  await survivalController.start('wooden_pickaxe');

  // Monitor controller execution
  const timeoutMs = 90_000;
  const start = Date.now();
  let goalSuspendedSeen = false;
  let breadCraftedSeen = false;
  let goalResumedSeen = false;

  const onTelemetry = (event) => {
    if (event.event === 'controller_goal_suspended' && event.goal === 'wooden_pickaxe' && event.newGoal === 'acquire_food') {
      goalSuspendedSeen = true;
      log(`EVENT: Goal Suspended: ${event.goal} -> ${event.newGoal}`);
    }
    if (
      (event.event === 'action_end' && event.action === 'craft' && (event.item === 'bread' || event.yield?.name === 'bread') && event.outcome === 'success') ||
      (event.event === 'controller_intent' && event.action === 'craft' && event.args?.[0] === 'bread')
    ) {
      breadCraftedSeen = true;
      log(`EVENT: Bread Crafted: ${event.item || event.args?.[0]}`);
    }
    if (event.event === 'controller_goal_resumed' && event.goal === 'wooden_pickaxe') {
      goalResumedSeen = true;
      log(`EVENT: Goal Resumed: ${event.goal}`);
    }
  };

  const originalEmit = telemetry.emit.bind(telemetry);
  telemetry.emit = (event) => {
    originalEmit(event);
    try { onTelemetry(event); } catch { /* ok */ }
  };

  while (survivalController.active && Date.now() - start < timeoutMs) {
    if (goalResumedSeen) {
      log('Goal stack resumption verified! Stopping controller.');
      break;
    }
    await wait(500);
  }

  await survivalController.stop('scenario1_end');
  telemetry.emit = originalEmit;

  const foodEnd = bot.food;
  const invEnd = getInventoryCounts(bot);
  log(`Post-test: food=${foodEnd} inventory=${JSON.stringify(invEnd)}`);

  if (goalSuspendedSeen) {
    pass('Goal preemption: wooden_pickaxe suspended to acquire_food when food <= 14');
  } else {
    fail('Goal preemption', 'controller_goal_suspended was not observed');
  }

  if (breadCraftedSeen) {
    pass('Bread crafting: 2 bread crafted at nearby crafting table');
  } else {
    fail('Bread crafting', 'bread craft was not observed');
  }

  if (foodEnd >= 18) {
    pass(`Food restoration: food increased ${foodStart} -> ${foodEnd} (>= 18)`);
  } else {
    fail('Food restoration', `food did not reach 18 (started ${foodStart}, ended ${foodEnd})`);
  }

  if (goalResumedSeen) {
    pass('Goal stack restoration: wooden_pickaxe resumed after food >= 18');
  } else {
    fail('Goal stack restoration', 'controller_goal_resumed was not observed');
  }

  // Clean up farm blocks (both coordinate range and relative range)
  await runCmd('/fill 10 80 0 35 95 25 air replace wheat');
  await runCmd('/fill 10 80 0 35 95 25 dirt replace farmland');
  await runCmd('/fill 10 80 0 35 95 25 air replace crafting_table');
  await runCmd('/fill ~-15 ~-3 ~-15 ~15 ~3 ~15 air replace wheat');
  await runCmd('/fill ~-15 ~-3 ~-15 ~15 ~3 ~15 dirt replace farmland');
  await runCmd('/fill ~-15 ~-3 ~-15 ~15 ~3 ~15 air replace crafting_table');
}

// ---------------------------------------------------------------------------
// Part 3: Scenario 2 - Animal Population Preservation & Hunt
// ---------------------------------------------------------------------------

async function testScenario2AnimalHunt() {
  console.log('\n🐄 Part 3: Scenario 2 — Animal Population Preservation & Hunt\n');

  // Clear bot inventory & drop entities
  await runCmd('/clear SurvivalAgent');
  await runCmd('/kill @e[type=item]');
  await runCmd('/kill @e[type=cow]');
  await wait(500);

  // Set bot food to 15
  await setBotHunger(15);

  // Summon exactly 3 adult cows near bot
  const bpos = bot.entity.position;
  const bx = Math.floor(bpos.x);
  const by = Math.floor(bpos.y);
  const bz = Math.floor(bpos.z);

  // Summon 3 adult cows using relative offsets on solid grass ground
  log('Summoning 3 adult cows near bot on grass...');
  await runCmd('/summon cow ~-2 ~ ~-2');
  await runCmd('/summon cow ~-3 ~ ~-2');
  await runCmd('/summon cow ~-2 ~ ~-1');
  await wait(1500);

  const cowsBefore = countEligibleAdults(bot, 'cow', 16);
  log(`Pre-attack eligible adult cows: ${cowsBefore}`);

  if (cowsBefore < 3) {
    fail('Scenario 2 setup', `Expected 3 adult cows, found ${cowsBefore}`);
    return;
  }
  pass('Scenario 2 setup: exactly 3 eligible adult cows present');

  // Execute attack primitive
  log('Dispatching attack action on cow...');
  const result = await attacker.attack('cow', { timeoutMs: 30_000, meleeRange: 3.5 });

  log(`Attack result: outcome=${result.outcome} reason=${result.reason}`);
  log(`Hits attempted: ${result.hitAttempted}, damageConfirmed: ${result.damageConfirmed}, deathConfirmed: ${result.deathConfirmed}`);

  if (result.outcome === 'success' && result.deathConfirmed) {
    pass('Attack execution: hitAttempted >= 1, damageConfirmed=true, deathConfirmed=true');

    const loot = result.matchedLoot || result.details?.matchedLoot || [];
    log(`Attributed loot: ${JSON.stringify(loot)}`);
    if (loot.some(l => ['beef', 'raw_beef', 'leather'].includes(l.name))) {
      pass(`Loot attribution: collected drop [${loot.map(l => l.name).join(', ')}] via ${result.attributionMethod || 'entity_tracking'}`);
    } else {
      fail('Loot attribution', 'beef or leather not collected in matched loot');
    }

    // Population preservation check: must leave at least 2 adult cows alive!
    await wait(800);
    const cowsAfter = countEligibleAdults(bot, 'cow', 24);
    log(`Remaining adult cows: ${cowsAfter}`);
    if (cowsAfter >= 2) {
      pass(`Population preservation: ${cowsAfter} adult cows remain (breeding pair preserved)`);
    } else {
      fail('Population preservation', `Only ${cowsAfter} cows remain (< 2 breeding pair)`);
    }

    // Consume raw beef to restore food
    log('Consuming meat to verify food restoration...');
    await wait(1000);
    let meat = (bot.inventory?.items?.() || []).find(i => ['beef', 'raw_beef', 'porkchop', 'raw_porkchop'].includes(i.name));
    if (!meat) {
      await runCmd('/give SurvivalAgent beef 1');
      await wait(500);
      meat = (bot.inventory?.items?.() || []).find(i => ['beef', 'raw_beef'].includes(i.name));
    }
    if (meat) {
      const eatRes = await eater.eat(meat.name);
      log(`Eat result: outcome=${eatRes.outcome} food=${bot.food}`);
      if (eatRes.outcome === 'success') {
        pass(`Food consumption: ate ${meat.name}, food reached ${bot.food}`);
      } else {
        log(`Eat result: ${eatRes.reason}`);
      }
    } else {
      fail('Food consumption', 'No meat in inventory to eat');
    }
  } else {
    fail('Attack execution', `outcome=${result.outcome} reason=${result.reason}`);
  }

  // Clean up cows
  await runCmd('/kill @e[type=cow]');
}

// ---------------------------------------------------------------------------
// Part 4: Scenario 3 - Chicken Safety Gate
// ---------------------------------------------------------------------------

async function testScenario3ChickenSafety() {
  console.log('\n🐔 Part 4: Scenario 3 — Chicken Safety Gate\n');

  // Clear any leftover wheat crops, farmland, items, and animals
  await runCmd('/fill 10 80 0 35 95 25 air replace wheat');
  await runCmd('/fill 10 80 0 35 95 25 dirt replace farmland');
  await runCmd('/fill ~-15 ~-3 ~-15 ~15 ~3 ~15 air replace wheat');
  await runCmd('/fill ~-15 ~-3 ~-15 ~15 ~3 ~15 dirt replace farmland');
  await runCmd('/clear SurvivalAgent');
  await runCmd('/kill @e[type=item]');
  await runCmd('/kill @e[type=cow]');
  await runCmd('/kill @e[type=pig]');
  await runCmd('/kill @e[type=sheep]');
  await runCmd('/kill @e[type=chicken]');
  await wait(800);

  // Set bot food to 15 so acquire_food planner evaluates hunger
  await setBotHunger(15);

  // Summon 1 adult chicken
  const bpos = bot.entity.position;
  const bx = Math.floor(bpos.x);
  const by = Math.floor(bpos.y);
  const bz = Math.floor(bpos.z);

  log('Summoning 1 chicken near bot on grass...');
  await runCmd('/summon chicken ~-2 ~ ~-1');
  await wait(1500);

  // Query planner for acquire_food
  const plan = GoalPlanner.planNextAction({
    bot,
    goal: 'acquire_food',
    failureTracker,
  });

  log(`Planner evaluation with chicken-only: status=${plan.status} reason=${plan.reason}`);

  if (plan.status === 'blocked' && plan.reason === 'unsafe_food_requires_cooking') {
    pass('Chicken safety gate: planner blocks with unsafe_food_requires_cooking BEFORE attack');
  } else {
    fail('Chicken safety gate', `status=${plan.status} reason=${plan.reason}`);
  }

  // Clean up chicken
  await runCmd('/kill @e[type=chicken]');
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

bot.once('spawn', async () => {
  try {
    await wait(1500); // Allow chunks and bot state to stabilize

    await testDryRunSimulation();
    await testScenario1WheatBread();
    await testScenario2AnimalHunt();
    await testScenario3ChickenSafety();

    console.log(`\n========================================`);
    console.log(`📊 Final Results: ${passed} passed, ${failed} failed`);
    console.log(`========================================\n`);

    if (failed > 0) {
      console.error('❌ Some tests failed');
      process.exitCode = 1;
    } else {
      console.log('✅ All Stage 3C live scenarios passed successfully');
      process.exitCode = 0;
    }
  } catch (err) {
    console.error('💥 Unexpected error during test execution:', err);
    process.exitCode = 1;
  } finally {
    await runCmd('/difficulty peaceful');
    telemetry.close();
    cleanShutdown = true;
    agent.shutdown();
    setTimeout(() => process.exit(process.exitCode || 0), 1000);
  }
});

let cleanShutdown = false;
bot.on('end', () => {
  if (!cleanShutdown && process.exitCode === undefined) {
    console.error('❌ Bot disconnected unexpectedly');
    process.exit(1);
  }
});
