'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Vec3 } = require('vec3');

const {
  GoalPlanner,
  SAFE_FOODS,
  getFoodNutrition,
  calculateHeldNutrition,
  getExpendableBuildingBlocks,
  getLatestSafeGatherStart,
  SHELTER_PREP_TIME,
  SHELTER_DEADLINE,
  DAWN_TIME,
} = require('../src/controller/planner');

const {
  findAlternativeSafeExit,
  checkExitSafety,
  createShelterBlueprint,
  saveBlueprint,
  clearBlueprint,
} = require('../src/actions/shelter');

const { SurvivalController } = require('../src/controller/survival_controller');
const { FailureTracker } = require('../src/controller/failure_tracker');

test('Stage 4 — Nutrition Lookup & Held Nutrition Calculation', () => {
  // Test version-specific bot registry lookup
  const mockBot = {
    registry: {
      foodsByName: {
        bread: { foodPoints: 5, saturation: 6 },
        cooked_beef: { foodPoints: 8, saturation: 12.8 },
        apple: { foodPoints: 4, saturation: 2.4 },
      },
    },
  };

  assert.strictEqual(getFoodNutrition('bread', mockBot), 5);
  assert.strictEqual(getFoodNutrition('cooked_beef', mockBot), 8);
  assert.strictEqual(getFoodNutrition('apple', mockBot), 4);
  assert.strictEqual(getFoodNutrition('poisonous_potato', mockBot), 0); // Not safe food

  // Test static fallback when bot registry is missing
  assert.strictEqual(getFoodNutrition('bread', null), 5);
  assert.strictEqual(getFoodNutrition('cooked_beef', null), 8);
  assert.strictEqual(getFoodNutrition('baked_potato', null), 5);
  assert.strictEqual(getFoodNutrition('sweet_berries', null), 2);
  assert.strictEqual(getFoodNutrition('raw_beef', null), 3);

  // Test calculateHeldNutrition
  const inventory = [
    { name: 'bread', count: 2 },        // 2 * 5 = 10
    { name: 'apple', count: 1 },        // 1 * 4 = 4
    { name: 'dirt', count: 32 },        // 0
    { name: 'rotten_flesh', count: 5 }, // 0 (unsafe)
  ];
  assert.strictEqual(calculateHeldNutrition(inventory, mockBot), 14);
});

test('Stage 4 — Bounded Food Acquisition & Arbitration Order', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  // Mock bot in daylight (time 2000) with 0 food in inventory and hunger 10
  const bot = {
    time: { timeOfDay: 2000, age: 5000 },
    food: 10,
    health: 20,
    inventory: {
      items: () => [{ name: 'dirt', count: 30 }],
    },
    entity: { position: new Vec3(0, 64, 0) },
    findBlock: () => null,
    entities: {
      // 3 eligible adult cows nearby
      1: { id: 1, name: 'cow', type: 'cow', position: new Vec3(5, 64, 5), metadata: [] },
      2: { id: 2, name: 'cow', type: 'cow', position: new Vec3(6, 64, 5), metadata: [] },
      3: { id: 3, name: 'cow', type: 'cow', position: new Vec3(7, 64, 5), metadata: [] },
    },
  };

  const actionManager = { isBusy: false };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
    options: {
      foodReserveNutrition: 10,
      targetReserve: 30,
    },
  });

  // Start with tool progression goal
  await controller.start('wooden_pickaxe');
  await new Promise(r => setTimeout(r, 60));

  // Controller should detect nutrition deficit (< 10) and suspend wooden_pickaxe for acquire_food
  const suspended = events.find(e => e.event === 'controller_goal_suspended' && e.trigger === 'food_reserve_preemption');
  assert.ok(suspended, 'Expected food_reserve_preemption event');
  assert.strictEqual(suspended.newGoal, 'acquire_food');
  assert.strictEqual(controller.currentGoal, 'acquire_food');

  // Verify arbitration order: food acquisition must STOP when building reserve takes precedence
  // Advance time to latestSafeStart with deficient building blocks (e.g. 10 dirt)
  bot.inventory.items = () => [{ name: 'dirt', count: 10 }];
  bot.time.timeOfDay = 9500; // >= latestSafeStart for 20 missing blocks: 10000 - 20*120 = 7600

  // Run controller tick
  await controller._tick(controller.currentRunId);

  const reservePreemption = events.find(e => e.event === 'controller_goal_suspended' && e.trigger === 'reserve_preemption');
  assert.ok(reservePreemption, 'Expected reserve preemption to suspend acquire_food');
  assert.strictEqual(reservePreemption.goal, 'acquire_food');
  assert.strictEqual(controller.currentGoal, 'maintain_building_reserve');

  await controller.stop('test_done');
});


test('Stage 4 — Multi-Directional Alternate Exit Selection under Hostile Threat', () => {
  const center = { x: 10, y: 64, z: 10 };
  const primaryExit = { x: 0, y: 0, z: 1 }; // South exit (landing at 10, 64, 12)
  const blueprint = createShelterBlueprint(center, primaryExit, 'dirt');

  const blocks = {};
  const setBlock = (x, y, z, name) => {
    blocks[`${x},${y},${z}`] = { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z) };
  };

  // Set solid floor beneath footprint and landings
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      setBlock(center.x + dx, center.y - 1, center.z + dz, 'dirt');
    }
  }

  // Set all shelter walls
  for (const c of blueprint.requiredCoordinates) {
    setBlock(c.x, c.y, c.z, 'dirt');
  }

  // Clear air around shelter
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let y = center.y; y <= center.y + 1; y++) {
        if (!blocks[`${center.x + dx},${y},${center.z + dz}`]) {
          setBlock(center.x + dx, y, center.z + dz, 'air');
        }
      }
    }
  }

  // Place a hostile creeper at (10, 64, 17)
  // Distance to South landing (10, 64, 12): 5.0m <= 8m (unsafe)
  // Distance to North landing (10, 64, 8): 9.0m > 8m (safe)
  const bot = {
    blockAt: (v) => blocks[`${v.x},${v.y},${v.z}`] || { name: 'air', boundingBox: 'empty' },
    entity: { position: new Vec3(10.5, 64, 10.5) },
    entities: {
      101: {
        id: 101,
        name: 'creeper',
        type: 'creeper',
        position: new Vec3(10, 64, 17),
      },
    },
  };

  // Primary South exit should fail safety check due to hostile threat
  const primarySafety = checkExitSafety(bot, blueprint, primaryExit);
  assert.strictEqual(primarySafety.safe, false);
  assert.strictEqual(primarySafety.reason, 'hostile_threat_creeper_at_exit');

  // Alternate exit search should find a safe cardinal face (North at z = -1)
  const alt = findAlternativeSafeExit(bot, blueprint);
  assert.ok(alt, 'Expected safe alternate exit to be found');
  assert.notStrictEqual(alt.name, 'south', 'Alternate exit should not be south');
  assert.strictEqual(alt.name, 'north');
  assert.strictEqual(alt.exitCoordinates.length, 2);

  // Verify the chosen alternate exit passes safety checks
  const altSafety = checkExitSafety(bot, blueprint, alt.direction);
  assert.strictEqual(altSafety.safe, true);
  assert.strictEqual(altSafety.reason, 'exit_safe');
});

test('Stage 4 — Bounded Dawn Wait and Exit Blocked Failure', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const center = { x: 10, y: 64, z: 10 };
  const blueprint = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
  blueprint.buildState = 'waiting';
  saveBlueprint(blueprint);

  // Bot surrounded by creepers on all 4 landings
  const bot = {
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
    entity: { position: new Vec3(10.5, 64, 10.5) },
    entities: {
      1: { id: 1, name: 'creeper', type: 'creeper', position: new Vec3(10, 64, 12) },  // South (1.5m)
      2: { id: 2, name: 'creeper', type: 'creeper', position: new Vec3(10, 64, 8) },   // North (2.5m)
      3: { id: 3, name: 'creeper', type: 'creeper', position: new Vec3(12, 64, 10) },  // East (1.5m)
      4: { id: 4, name: 'creeper', type: 'creeper', position: new Vec3(8, 64, 10) },   // West (2.5m)
    },
    inventory: { items: () => [{ name: 'bread', count: 2 }] },
    food: 20,
    health: 20,
    time: { timeOfDay: 23100, age: 30000 },
  };

  const controller = new SurvivalController({
    bot,
    actionManager: { isBusy: false },
    telemetry,
    options: {
      dawnWaitTimeoutMs: 50,
      exitTimeoutMs: 100,
    },
  });

  await controller.start('leave_shelter');
  await new Promise(r => setTimeout(r, 60));

  // Trigger ticks until exitTimeoutMs expires
  controller._dawnWaitStartTime = Date.now() - 150; // force timeout expiry
  await controller._tick(controller.currentRunId);

  assert.strictEqual(controller.status, 'failed_unsafe');
  assert.strictEqual(controller.shelterSafetyClaim, false);
  const stopEvent = events.find(e => e.event === 'controller_stop' && e.reason === 'exit_blocked');
  assert.ok(stopEvent, 'Expected exit_blocked controller_stop event');

  clearBlueprint();
});

test('Stage 4 — Real-Time BlockUpdate Shelter Breach Detection', () => {
  const tmpBp = path.join(process.cwd(), `.test_bp_breach_${Date.now()}.json`);
  process.env.SHELTER_BLUEPRINT_PATH = tmpBp;

  try {
    const events = [];
    const telemetry = { emit: (e) => events.push(e) };
    const center = { x: 20, y: 80, z: 20 };
    const blueprint = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    saveBlueprint(blueprint);

    let blockUpdateCb = null;
    const bot = {
      on: (evt, cb) => {
        if (evt === 'blockUpdate') blockUpdateCb = cb;
      },
      entity: { position: new Vec3(20.5, 80, 20.5) },
      inventory: { items: () => [] },
      food: 20,
      health: 20,
      time: { timeOfDay: 15000, age: 20000 },
    };

    const controller = new SurvivalController({
      bot,
      actionManager: { isBusy: false },
      telemetry,
    });

    controller.active = true;
    controller.currentGoal = 'wait_out_night';
    controller.shelterSafetyClaim = true;

    assert.ok(blockUpdateCb, 'blockUpdate listener should be registered');

    // Simulate an external explosion or enderman breaking wall block at (20, 81, 19)
    const brokenPos = new Vec3(20, 81, 19);
    blockUpdateCb(
      { name: 'dirt', boundingBox: 'block', position: brokenPos },
      { name: 'air', boundingBox: 'empty', position: brokenPos }
    );

    const breach = events.find(e => e.event === 'shelter_breached');
    assert.ok(breach, 'Expected shelter_breached telemetry event');
    assert.strictEqual(controller.shelterSafetyClaim, false);
    assert.strictEqual(breach.position.x, 20);
    assert.strictEqual(breach.position.y, 81);
    assert.strictEqual(breach.position.z, 19);
  } finally {
    delete process.env.SHELTER_BLUEPRINT_PATH;
    try { if (fs.existsSync(tmpBp)) fs.unlinkSync(tmpBp); } catch {}
  }
});

// ---------------------------------------------------------------------------
// Stage 4 Recovery & Threat Evasion Tests (User Requirements 1-6)
// ---------------------------------------------------------------------------

const { hasHostileThreatNearby, createGatherer } = require('../src/actions/gather');
const { ActionManager } = require('../src/actions/manager');

test('Recovery 1: no_exposed_stone_found immediately falls back to early building-reserve gathering without idle', () => {
  const items = [
    { name: 'wooden_pickaxe', count: 1 },
    { name: 'dirt', count: 5 }, // < 30 reserve
  ];

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: { name: 'wooden_pickaxe' },
    inventory: { items: () => items },
    registry: { blocksByName: { stone: { id: 1 }, dirt: { id: 2 }, grass_block: { id: 3 } } },
    findBlock: ({ matching }) => {
      // No stone exists
      if (matching === 1) return null;
      // Dirt block exists
      return { name: 'dirt', position: new Vec3(5, 64, 5) };
    },
    blockAt: () => ({ name: 'air' }),
  };

  const plan = GoalPlanner.planNextAction({
    goal: 'stone_pickaxe',
    bot,
    targetReserve: 30,
  });

  assert.strictEqual(plan.status, 'action_required', 'Should not leave controller blocked/idle');
  assert.strictEqual(plan.action, 'gather');
  assert.strictEqual(plan.reason, 'gather_building_reserve_early');
  assert.strictEqual(plan.args[0].x, 5);
});

test('Recovery 2: shelter and reserve preemption still occur while stone_pickaxe progression is blocked', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  let currentTod = 8500; // Passed latestSafeStart

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }, { name: 'dirt', count: 10 }] },
    food: 20,
    health: 20,
    time: { get timeOfDay() { return currentTod; }, age: 10000 },
    findBlock: () => null, // No stone
    blockAt: () => ({ name: 'air' }),
  };

  const controller = new SurvivalController({
    bot,
    actionManager: { isBusy: false },
    telemetry,
    options: { targetReserve: 30 },
  });

  controller.active = true;
  controller.currentRunId = 'run-1';
  controller.currentGoal = 'stone_pickaxe';

  // Run tick at timeOfDay 8500 -> reserve preemption
  await controller._tick('run-1');
  assert.strictEqual(controller.currentGoal, 'maintain_building_reserve');
  assert.strictEqual(controller.goalStack.length, 1);
  assert.strictEqual(controller.goalStack[0].goal, 'stone_pickaxe');

  // Advance time to 10500 -> dusk preemption
  currentTod = 10500;
  controller.currentGoal = 'stone_pickaxe'; // Simulate being on stone_pickaxe
  await controller._tick('run-1');
  assert.strictEqual(controller.currentGoal, 'build_shelter');
});

test('Recovery 3: daytime threat evasion suspends goal, selects validated safe destination, and restores goal', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  let navigatedTarget = null;

  const hostilePillager = {
    name: 'pillager',
    position: new Vec3(0, 64, 8), // 8m away
  };

  const worldBlocks = {
    // Current bot pos
    '0,63,0': { name: 'dirt', boundingBox: 'block' },
    // Safe destination candidate
    '0,63,-14': { name: 'dirt', boundingBox: 'block' },
    '0,62,-14': { name: 'stone', boundingBox: 'block' },
  };

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 99: hostilePillager },
    inventory: { items: () => [] },
    food: 20,
    health: 20,
    time: { timeOfDay: 3000, age: 3000 },
    blockAt: (pos) => worldBlocks[`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`] || { name: 'air', boundingBox: 'empty' },
  };

  const mockNavigator = {
    navigate: async (x, y, z) => {
      navigatedTarget = { x, y, z };
      return { outcome: 'success' };
    },
  };

  const controller = new SurvivalController({
    bot,
    actionManager: { isBusy: false },
    primitives: { navigator: mockNavigator },
    telemetry,
  });

  controller.active = true;
  controller.currentRunId = 'run-1';
  controller.currentGoal = 'stone_pickaxe';

  // 1. Tick with threat nearby -> suspends stone_pickaxe and switches to flee_threat
  await controller._tick('run-1');
  assert.strictEqual(controller.currentGoal, 'flee_threat');
  assert.strictEqual(controller.goalStack.length, 1);
  assert.strictEqual(controller.goalStack[0].goal, 'stone_pickaxe');

  // 2. Tick in flee_threat -> executes evasion navigation
  await controller._tick('run-1');
  assert.ok(navigatedTarget, 'Should have navigated away from pillager');
  // Pillager was at (0, 64, 8); bot was at (0, 64, 0); flee target must be negative Z (away from threat)
  assert.ok(navigatedTarget.z < 0, `Expected flee target z < 0, got ${navigatedTarget.z}`);

  // 3. Move pillager far away -> threat cleared
  hostilePillager.position = new Vec3(0, 64, 30); // 30m away (> 16m)
  await controller._tick('run-1');

  // Should restore stone_pickaxe!
  assert.strictEqual(controller.currentGoal, 'stone_pickaxe');
  assert.strictEqual(controller.goalStack.length, 0);
  const resumed = events.find(e => e.event === 'controller_goal_resumed');
  assert.ok(resumed, 'Expected controller_goal_resumed event');
  assert.strictEqual(resumed.goal, 'stone_pickaxe');
});

test('Recovery 4: larger detection range for ranged mobs (pillagers/skeletons) than melee mobs (zombies/creepers)', () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
  };

  // Test 1: Skeleton at 14m (ranged) -> should detect
  bot.entities = { 1: { name: 'skeleton', position: new Vec3(0, 64, 14) } };
  assert.strictEqual(hasHostileThreatNearby(bot, 10.0, null, 16.0), true, 'Skeleton at 14m should be detected with 16m ranged range');

  // Test 2: Pillager at 14m (ranged) -> should detect
  bot.entities = { 1: { name: 'pillager', position: new Vec3(0, 64, 14) } };
  assert.strictEqual(hasHostileThreatNearby(bot, 10.0, null, 16.0), true, 'Pillager at 14m should be detected with 16m ranged range');

  // Test 3: Zombie at 14m (melee) -> should NOT detect (outside 10m melee range)
  bot.entities = { 1: { name: 'zombie', position: new Vec3(0, 64, 14) } };
  assert.strictEqual(hasHostileThreatNearby(bot, 10.0, null, 16.0), false, 'Zombie at 14m should NOT be detected with 10m melee range');

  // Test 4: Zombie at 8m (melee) -> should detect
  bot.entities = { 1: { name: 'zombie', position: new Vec3(0, 64, 8) } };
  assert.strictEqual(hasHostileThreatNearby(bot, 10.0, null, 16.0), true, 'Zombie at 8m should be detected with 10m melee range');
});

test('Recovery 5: digging aborts cleanly when a hostile enters the configured threat radius', async () => {
  let digAborted = false;
  const world = {
    '0,64,1': { name: 'dirt', boundingBox: 'block', position: { x: 0, y: 64, z: 1 } },
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air', boundingBox: 'empty' },
    canDigBlock: () => true,
    dig: async () => {
      // Simulate digging taking 500ms; hostile spawns at 150ms
      await new Promise(r => setTimeout(r, 150));
      bot.entities[1] = { name: 'creeper', position: new Vec3(0, 64, 4) }; // within 8m
      // Wait for abortion
      await new Promise(r => setTimeout(r, 200));
    },
    stopDigging: () => {
      digAborted = true;
    },
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => [],
      emptySlotCount: () => 30,
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.strictEqual(result.outcome, 'failed');
  assert.strictEqual(result.reason, 'hostile_threat_nearby');
  assert.strictEqual(digAborted, true, 'stopDigging should have been called');
});

test('Recovery 6: repeated threat events do not duplicate goal-stack frames or cause infinite flee loop', async () => {
  const hostile = {
    name: 'creeper',
    position: new Vec3(0, 64, 4), // 4m away
  };

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 1: hostile },
    inventory: { items: () => [] },
    food: 20,
    health: 20,
    time: { timeOfDay: 3000, age: 3000 },
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
  };

  const mockNavigator = {
    navigate: async () => ({ outcome: 'success' }),
  };

  const controller = new SurvivalController({
    bot,
    actionManager: { isBusy: false },
    primitives: { navigator: mockNavigator },
    telemetry: { emit: () => {} },
  });

  controller.active = true;
  controller.currentRunId = 'run-1';
  controller.currentGoal = 'stone_pickaxe';

  // Tick 1: detects threat, suspends stone_pickaxe
  await controller._tick('run-1');
  assert.strictEqual(controller.currentGoal, 'flee_threat');
  assert.strictEqual(controller.goalStack.length, 1);

  // Tick 2: repeated threat detected while ALREADY in flee_threat
  await controller._tick('run-1');
  assert.strictEqual(controller.currentGoal, 'flee_threat');
  assert.strictEqual(controller.goalStack.length, 1, 'goalStack must NOT duplicate frames');

  // Tick 3: repeated threat again
  await controller._tick('run-1');
  assert.strictEqual(controller.goalStack.length, 1, 'goalStack must still have depth 1');

  // Simulate attempts exhausting (fleeAttemptCount reaches 10)
  controller._fleeAttemptCount = 10;
  await controller._tick('run-1');

  // Should exhaust flee attempts and safely resume goal without infinite loop!
  assert.strictEqual(controller.currentGoal, 'stone_pickaxe', 'Should exhaust flee attempts and resume stack goal');
  assert.strictEqual(controller.goalStack.length, 0);
});
