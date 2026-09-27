'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');

const {
  SurvivalController,
  HEALTH_THRESHOLDS,
  findSafeFleeDestination,
} = require('../src/controller/survival_controller');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { GoalPlanner } = require('../src/controller/planner');

test('Health Policy — HEALTH_THRESHOLDS constants and reasoning', () => {
  assert.strictEqual(HEALTH_THRESHOLDS.OPTIMAL, 20, 'Full health is 20 (10 hearts)');
  assert.strictEqual(HEALTH_THRESHOLDS.REGEN_FOOD_THRESHOLD, 18, 'Minecraft 1.21 requires food >= 18 for natural health regen');
  assert.strictEqual(HEALTH_THRESHOLDS.SAFE_MINIMUM, 14, 'Warning threshold is 14 (7 hearts) for early shelter/preemption');
  assert.strictEqual(HEALTH_THRESHOLDS.DANGER, 10, 'Danger threshold is 10 (5 hearts) for strict evasion');
  assert.strictEqual(HEALTH_THRESHOLDS.MIN_ACCEPTANCE_HEALTH, 8, 'Acceptance gate minimum health is 8.0 (4 hearts)');
  assert.strictEqual(HEALTH_THRESHOLDS.MIN_FINAL_HEALTH, 12, 'Acceptance gate final health is 12.0 (6 hearts)');
  assert.strictEqual(HEALTH_THRESHOLDS.TERMINAL_CRITICAL, 6, 'Terminal critical threshold is 6 (3 hearts)');
});

test('Health Policy — Damage Detection and Structured Telemetry Recording', () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  const bot = {
    health: 20,
    food: 17,
    time: { timeOfDay: 6000, age: 1000 },
    entity: { position: new Vec3(10, 64, 10) },
    entities: {
      1: {
        id: 1,
        name: 'spider',
        type: 'spider',
        position: new Vec3(12, 64, 10),
      },
    },
    inventory: { items: () => [] },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  // Initialize baseline health
  controller._checkAndRecordDamage('init');
  assert.strictEqual(controller.damageTimeline.length, 0);

  // Take damage: 20 -> 16
  bot.health = 16;
  const record = controller._checkAndRecordDamage('test_hit');
  assert.ok(record, 'Damage record should be generated');
  assert.strictEqual(record.previousHealth, 20);
  assert.strictEqual(record.currentHealth, 16);
  assert.strictEqual(record.damageAmount, 4);
  assert.strictEqual(record.attacker?.name, 'spider');
  assert.strictEqual(record.attacker?.id, 1);
  assert.strictEqual(record.healthState, 'good');

  // Verify telemetry emitted
  const dmgEvt = events.find(e => e.event === 'damage_taken');
  assert.ok(dmgEvt, 'damage_taken event should be emitted');
  assert.strictEqual(dmgEvt.damageAmount, 4);

  // Verify active aggressor recorded and spider daylight neutrality bypassed
  assert.ok(bot._activeAggressors.has(1) || bot._activeAggressors.has('spider'));
  const nearbyThreats = controller._getNearbyThreats(18.0);
  assert.strictEqual(nearbyThreats.length, 1, 'Aggroed spider must be treated as threat despite daylight');
});

test('Health Policy — Damage received immediately clears flee cooldown and preempts action', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  let actionCancelled = false;
  const actionManager = {
    isBusy: true,
    currentAction: { actionName: 'gather' },
    cancel: () => { actionCancelled = true; },
    waitForIdle: async () => {},
  };

  const bot = {
    health: 20,
    food: 16,
    time: { timeOfDay: 4000, age: 2000 },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      99: { id: 99, name: 'zombie', position: new Vec3(3, 64, 0) },
    },
    inventory: { items: () => [] },
    on: () => {},
    removeListener: () => {},
  };

  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'test-run';
  controller.currentGoal = 'wooden_pickaxe';
  controller._lastHealth = 20;
  controller._fleeCooldownUntil = Date.now() + 10000; // Locked in cooldown

  // Bot takes damage
  bot.health = 17;
  await controller._tick('test-run');

  assert.strictEqual(controller._fleeCooldownUntil, 0, 'Flee cooldown must be cleared on damage');
  assert.ok(actionCancelled, 'In-flight gather action must be cancelled on damage');
  assert.strictEqual(controller.currentGoal, 'flee_threat', 'Goal must switch to flee_threat');
  assert.strictEqual(controller.goalStack.length, 1, 'Original goal must be pushed to goal stack');
  assert.strictEqual(controller.goalStack[0].goal, 'wooden_pickaxe');
});

test('Health Policy — Avoids re-engaging threats after taking damage or when health <= 14', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  let attacked = false;
  const bot = {
    health: 12, // Unsafe health (<= 14)
    food: 18,
    time: { timeOfDay: 3000, age: 3000 },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      5: { id: 5, name: 'zombie', position: new Vec3(2, 64, 0) }, // in striking reach (2m)
    },
    attack: () => { attacked = true; },
    lookAt: async () => {},
    inventory: { items: () => [] },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'test-run';
  controller.currentGoal = 'flee_threat';
  controller._lastDamageTime = Date.now(); // Recently damaged

  await controller._tick('test-run');

  assert.strictEqual(attacked, false, 'Bot must NOT attempt attack/knockback when health is unsafe or recently damaged');
  const warningEvt = events.find(e => e.warning === 'no_safe_flee_destination');
  assert.ok(warningEvt, 'Warning should be emitted when safe flee destination cannot be found');
  assert.strictEqual(warningEvt.reEngagePrevented, true, 'Telemetry should record that re-engagement was prevented');
});

test('Health Policy — Preempts progression to build emergency shelter when health <= 14 and materials exist', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  const bot = {
    health: 13, // Unsafe health (<= 14)
    food: 19,
    time: { timeOfDay: 5000, age: 4000 }, // Mid-day (far before ordinary dusk prep 10000)
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: {
      items: () => [{ name: 'dirt', count: 32 }], // Has >= 25 expendable building blocks
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'test-run';
  controller.currentGoal = 'stone_pickaxe';
  controller._lastHealth = 13;

  await controller._tick('test-run');

  assert.strictEqual(controller.currentGoal, 'build_shelter', 'Goal must preemptively switch to build_shelter due to unsafe health');
  const preemptionEvt = events.find(e => e.reason === 'emergency_shelter_due_to_low_health');
  assert.ok(preemptionEvt, 'Telemetry should record emergency shelter preemption due to low health');
});

test('Health Policy — Natural Regeneration Eating Trigger (food >= 18 when health < 20)', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  let eatenFood = null;
  const primitives = {
    eater: {
      eat: async (item) => { eatenFood = item; },
    },
  };

  // Bot has taken damage (health: 15 < 20), food is 16 (< 18 threshold for natural regen)
  const bot = {
    health: 15,
    food: 16,
    time: { timeOfDay: 4000, age: 5000 },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: {
      items: () => [
        { name: 'apple', count: 3 },
      ],
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    primitives,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'test-run';
  controller.currentGoal = 'stone_pickaxe';
  controller._lastHealth = 15;

  await controller._tick('test-run');

  assert.strictEqual(eatenFood, 'apple', 'Should eat safe food to restore food to the >= 18 regen threshold');
  const eatIntent = events.find(e => e.action === 'eat' && e.reason === 'natural_regeneration_food_threshold');
  assert.ok(eatIntent, 'Telemetry should record natural_regeneration_food_threshold reason');
});

test('Health Policy — Bounded transition to critical_health_no_recovery when unrecoverable', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  // Bot has critical health 4 (<= 6), no safe food, 0 building blocks, and hostile nearby with no escape
  const bot = {
    health: 4,
    food: 10,
    time: { timeOfDay: 5000, age: 6000 },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      1: { id: 1, name: 'zombie', position: new Vec3(2, 64, 0) },
    },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air' }), // all air, no valid floor to flee to
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'test-run';
  controller.currentGoal = 'stone_pickaxe';
  controller._lastHealth = 4;

  await controller._tick('test-run');

  assert.strictEqual(controller.status, 'critical_health_no_recovery');
  assert.strictEqual(controller.active, false);
  const criticalEvt = events.find(e => e.event === 'controller_critical_health_no_recovery');
  assert.ok(criticalEvt, 'controller_critical_health_no_recovery telemetry event must be emitted');
});

test('Health Policy — Acceptance Gate Verification: min health and final health thresholds', () => {
  // Scenario 1: Previous near-death run (0.0000019 HP) must FAIL acceptance gates
  const nearDeathMinHealth = 0.0000019;
  const nearDeathFinalHealth = 0.0000019;
  const gateMinPass1 = nearDeathMinHealth >= HEALTH_THRESHOLDS.MIN_ACCEPTANCE_HEALTH;
  const gateFinalPass1 = nearDeathFinalHealth >= HEALTH_THRESHOLDS.MIN_FINAL_HEALTH;
  assert.strictEqual(gateMinPass1, false, 'Near-death min health must fail gate');
  assert.strictEqual(gateFinalPass1, false, 'Near-death final health must fail gate');

  // Scenario 2: Healthy survival (min health 14.0, final health 20.0) must PASS acceptance gates
  const healthyMinHealth = 14.0;
  const healthyFinalHealth = 20.0;
  const gateMinPass2 = healthyMinHealth >= HEALTH_THRESHOLDS.MIN_ACCEPTANCE_HEALTH;
  const gateFinalPass2 = healthyFinalHealth >= HEALTH_THRESHOLDS.MIN_FINAL_HEALTH;
  assert.strictEqual(gateMinPass2, true, 'Healthy min health >= 8.0 must pass');
  assert.strictEqual(gateFinalPass2, true, 'Healthy final health >= 12.0 must pass');
});
