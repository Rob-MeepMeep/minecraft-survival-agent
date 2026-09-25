'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { GoalPlanner } = require('../src/controller/planner');
const { SurvivalController } = require('../src/controller/survival_controller');
const { ActionManager } = require('../src/actions/manager');

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [];
  const entitiesMap = overrides.entities || {};

  const mock = {
    entity: {
      position: overrides.playerPos || new Vec3(0, 64, 0),
    },
    entities: entitiesMap,
    inventory: {
      items: () => inventoryItems,
    },
    registry: {
      blocksByName: {
        oak_log: { id: 17, name: 'oak_log' },
        birch_log: { id: 18, name: 'birch_log' },
        oak_planks: { id: 5, name: 'oak_planks' },
        birch_planks: { id: 6, name: 'birch_planks' },
        stick: { id: 280, name: 'stick' },
        crafting_table: { id: 58, name: 'crafting_table' },
        wooden_pickaxe: { id: 270, name: 'wooden_pickaxe' },
      },
    },
    blockAt: overrides.blockAt || ((pos) => ({
      name: 'air',
      position: new Vec3(pos.x, pos.y, pos.z),
      boundingBox: 'empty',
    })),
    findBlock: overrides.findBlock || (() => null),
    time: overrides.time || { timeOfDay: 1000, day: 1 },
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    foodSaturation: overrides.foodSaturation ?? 5,
    on: () => {},
    removeListener: () => {},
    clearControlStates: () => {},
    ...overrides,
  };

  return mock;
}

function createMockActionManager(bot, overrides = {}) {
  const events = [];
  const telemetry = {
    emit: (event) => events.push(event),
  };

  const manager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 'test-session' }),
    telemetry,
    ...overrides,
  });

  return { manager, events, telemetry };
}

// ---------------------------------------------------------------------------
// 1. Goal Planner & Prerequisite Solving
// ---------------------------------------------------------------------------

test('GoalPlanner — exact 9-plank reservation (3 logs) when no crafting table exists', () => {
  // Empty inventory: need 4 (table) + 2 (sticks) + 3 (pickaxe) = 9 planks => 3 logs
  const bot = createMockBot({ items: [] });
  const plan = GoalPlanner.planNextAction({ bot });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'gather');
  assert.equal(plan.details.neededPlanks, 9);
  assert.equal(plan.details.logsNeeded, 3);
});

test('GoalPlanner — exact 5-plank reservation (2 logs) when crafting table already nearby', () => {
  // Crafting table already exists nearby: need 0 (table) + 2 (sticks) + 3 (pickaxe) = 5 planks => 2 logs
  const bot = createMockBot({
    items: [],
    findBlock: ({ matching }) => (matching === 58 ? { name: 'crafting_table', position: new Vec3(2, 64, 0) } : null),
  });
  const plan = GoalPlanner.planNextAction({ bot });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'gather');
  assert.equal(plan.details.neededPlanks, 5);
  assert.equal(plan.details.logsNeeded, 2);
});

test('GoalPlanner — multi-wood support converts birch_log into birch_planks', () => {
  const bot = createMockBot({
    items: [{ name: 'birch_log', count: 3 }],
  });
  const plan = GoalPlanner.planNextAction({ bot });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'craft');
  assert.equal(plan.args[0], 'birch_planks');
  assert.equal(plan.details.logUsed, 'birch_log');
  assert.equal(plan.details.plankProduced, 'birch_planks');
});

test('GoalPlanner — mixed wood types: crafts sticks from available planks', () => {
  // Has 1 oak_planks and 1 birch_planks (total 2 planks) -> enough to craft sticks
  const bot = createMockBot({
    items: [
      { name: 'oak_planks', count: 5 },
      { name: 'birch_planks', count: 4 },
    ],
  });
  const plan = GoalPlanner.planNextAction({ bot });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'craft');
  assert.equal(plan.args[0], 'stick');
});

// ---------------------------------------------------------------------------
// 2. Projected-State Simulation Trace
// ---------------------------------------------------------------------------

test('GoalPlanner.simulatePlan — produces complete progression trace labeled with simulated: true', () => {
  const trace = GoalPlanner.simulatePlan({
    initialInventory: [],
    hasCraftingTable: false,
    maxSteps: 15,
  });

  // Verify all steps are explicitly tagged as simulated
  assert.ok(trace.length >= 7);
  for (const step of trace) {
    assert.equal(step.simulated, true);
  }

  // Verify full progression sequence
  const actions = trace.map(t => t.action).filter(Boolean);
  // Expected sequence: 3 gathers (to reach 3 logs for 9 planks), planks craft, sticks craft, table craft, table place, pickaxe craft
  assert.deepEqual(actions, [
    'gather',
    'gather',
    'gather',
    'craft', // planks
    'craft', // planks
    'craft', // planks
    'craft', // stick
    'craft', // crafting_table
    'place', // crafting_table
    'craft', // wooden_pickaxe
  ]);

  const lastStep = trace[trace.length - 1];
  assert.equal(lastStep.status, 'completed');
  assert.equal(lastStep.goal, 'wooden_pickaxe');
  const finalHasPickaxe = lastStep.resultingInventory.some(i => i.name === 'wooden_pickaxe');
  assert.equal(finalHasPickaxe, true);
});

// ---------------------------------------------------------------------------
// 3. Fine-Grained Failure Cooldowns & Budgets
// ---------------------------------------------------------------------------

test('FailureTracker — cooldown is scoped to specific coordinate; does not blacklist all logs', () => {
  const tracker = new FailureTracker({ defaultCooldownMs: 5000 });

  const key1 = FailureTracker.makeKey('gather', { x: 10, y: 64, z: 12, block: 'oak_log' });
  const key2 = FailureTracker.makeKey('gather', { x: 15, y: 64, z: 20, block: 'oak_log' });

  tracker.recordFailure(key1, 'unreachable');

  assert.equal(tracker.isOnCooldown(key1), true);
  assert.equal(tracker.isOnCooldown(key2), false); // Key 2 is completely available!
});

test('FailureTracker — only actual dispatched actions increment budget, not observation cycles', () => {
  const tracker = new FailureTracker({ maxDispatchedActions: 3 });

  assert.equal(tracker.getDispatchedActions(), 0);
  assert.equal(tracker.isBudgetExceeded(), false);

  tracker.incrementDispatchedActions();
  tracker.incrementDispatchedActions();
  assert.equal(tracker.getDispatchedActions(), 2);
  assert.equal(tracker.isBudgetExceeded(), false);

  tracker.incrementDispatchedActions();
  assert.equal(tracker.getDispatchedActions(), 3);
  assert.equal(tracker.isBudgetExceeded(), true);
});

// ---------------------------------------------------------------------------
// 4. SurvivalController Lifecycle, Preemption & Tokens
// ---------------------------------------------------------------------------

test('SurvivalController — dryRun step mode reports single next intended action without execution', async () => {
  const bot = createMockBot({ items: [] });
  const { manager, telemetry } = createMockActionManager(bot);
  const controller = new SurvivalController({
    bot,
    actionManager: manager,
    primitives: {},
    telemetry,
  });

  const res = await controller.start('wooden_pickaxe', { dryRun: 'step' });
  assert.equal(res.mode, 'step');
  assert.equal(res.plan.action, 'gather');
  assert.equal(controller.active, false);
  assert.equal(controller.status, 'idle');
});

test('SurvivalController — preemption halts with blocked_by_threat when hostile mob is within 8m', async () => {
  const bot = createMockBot({
    items: [],
    entities: {
      1: {
        type: 'hostile',
        name: 'zombie',
        position: new Vec3(4, 64, 0), // 4 blocks away (< 8m)
      },
    },
  });
  const { manager, events, telemetry } = createMockActionManager(bot);
  const controller = new SurvivalController({
    bot,
    actionManager: manager,
    primitives: {},
    telemetry,
    options: { threatDistance: 8 },
  });

  await controller.start('wooden_pickaxe');
  // Allow scheduled tick to execute
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(controller.active, false);
  assert.equal(controller.status, 'blocked_by_threat');

  const preemptionEvent = events.find(e => e.event === 'controller_preemption');
  assert.ok(preemptionEvent);
  assert.equal(preemptionEvent.reason, 'blocked_by_threat');
});

test('SurvivalController — preemption suspends goal with dusk_preemption when dusk arrives', async () => {
  const bot = createMockBot({
    items: [{ name: 'dirt', count: 30 }],
    time: { timeOfDay: 10500, day: 1 }, // Dusk preparation window (10000 <= timeOfDay < 12000)
    blockAt: (pos) => {
      if (Math.floor(pos.y) < 64) {
        return { name: 'dirt', boundingBox: 'block' };
      }
      return { name: 'air', boundingBox: 'empty' };
    },
  });
  const { manager, events, telemetry } = createMockActionManager(bot);
  const controller = new SurvivalController({
    bot,
    actionManager: manager,
    primitives: {},
    telemetry,
  });

  await controller.start('wooden_pickaxe');
  // Allow scheduled tick to execute
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(controller.currentGoal, 'build_shelter');
  assert.equal(controller.goalStack.length, 1);
  assert.equal(controller.goalStack[0].goal, 'wooden_pickaxe');
  assert.equal(controller.goalStack[0].trigger, 'dusk_preemption');

  const suspendedEvent = events.find(e => e.event === 'controller_goal_suspended');
  assert.ok(suspendedEvent);
  assert.equal(suspendedEvent.trigger, 'dusk_preemption');
  assert.equal(suspendedEvent.newGoal, 'build_shelter');
});

test('SurvivalController — preemption halts with night_fell when haltOnDusk option is enabled', async () => {
  const bot = createMockBot({
    items: [],
    time: { timeOfDay: 13000, day: 1 },
  });
  const { manager, events, telemetry } = createMockActionManager(bot);
  const controller = new SurvivalController({
    bot,
    actionManager: manager,
    primitives: {},
    telemetry,
    options: { haltOnDusk: true },
  });

  await controller.start('wooden_pickaxe');
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(controller.active, false);
  assert.equal(controller.status, 'night_fell');

  const preemptionEvent = events.find(e => e.event === 'controller_preemption');
  assert.ok(preemptionEvent);
  assert.equal(preemptionEvent.reason, 'night_fell');
});

test('SurvivalController — preemption halts with starving_no_food when food <= 6 and no food available', async () => {
  const bot = createMockBot({
    items: [], // No food
    food: 4,   // Critical food
  });
  const { manager, events, telemetry } = createMockActionManager(bot);
  const controller = new SurvivalController({
    bot,
    actionManager: manager,
    primitives: {},
    telemetry,
    options: { criticalFood: 6 },
  });

  await controller.start('wooden_pickaxe');
  // Allow scheduled tick to execute
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(controller.active, false);
  assert.equal(controller.status, 'starving_no_food');

  const preemptionEvent = events.find(e => e.event === 'controller_preemption');
  assert.ok(preemptionEvent);
  assert.equal(preemptionEvent.reason, 'starving_no_food');
});


test('SurvivalController — restart increments generation token and discards stale action completion', async () => {
  const bot = createMockBot({ items: [] });
  const { manager, telemetry } = createMockActionManager(bot);

  let finishFirstAction = null;
  const mockGatherer = {
    gather: async () => {
      return new Promise((resolve) => {
        finishFirstAction = resolve;
      });
    },
  };

  const controller = new SurvivalController({
    bot,
    actionManager: manager,
    primitives: { gatherer: mockGatherer },
    telemetry,
  });

  // Start Run 1
  await controller.start('wooden_pickaxe');
  const run1Id = controller.currentRunId;
  assert.equal(run1Id, 'controller-run-1');

  // Stop Run 1 and restart Run 2
  await controller.stop('stopped');
  await controller.start('wooden_pickaxe');
  const run2Id = controller.currentRunId;
  assert.equal(run2Id, 'controller-run-2');

  // Now resolve the hung action from Run 1
  if (finishFirstAction) {
    finishFirstAction({ outcome: 'success' });
  }

  // Controller runId should still be Run 2
  assert.equal(controller.currentRunId, run2Id);
  assert.equal(controller.generation, 2);

  await controller.stop('cleaned_up');
  assert.equal(controller.active, false);
  assert.equal(controller.tickTimer, null);
});
