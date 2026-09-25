'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { GoalPlanner, CROP_MATURITY, FOOD_ANIMALS, COOKED_FOOD_ITEMS, SAFE_FOODS } = require('../src/controller/planner');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { SurvivalController } = require('../src/controller/survival_controller');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a simulated state for planNextAction.
 */
function makeSimState({ food = 10, inventory = [], hasCrop = false, hasAnimal = false, animalType = 'cow', adultCount = 3, hasCraftingTable = false, isNight = false } = {}) {
  return { food, inventory, hasCrop, hasAnimal, animalType, adultCount, hasCraftingTable, isNight };
}

// ---------------------------------------------------------------------------
// 1. acquire_food: Emergency eat gate
// ---------------------------------------------------------------------------

describe('GoalPlanner acquire_food — emergency eat gate', () => {
  it('emits eat immediately when food <= 6 and safe food is in inventory', () => {
    const simState = makeSimState({
      food: 4,
      inventory: [{ name: 'bread', count: 2 }],
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'eat');
    assert.equal(plan.reason, 'emergency_eat');
    assert.equal(plan.args[0], 'bread');
  });

  it('does NOT eat when food <= 6 but no safe food in inventory (falls through)', () => {
    const simState = makeSimState({
      food: 5,
      inventory: [],
      hasCrop: false,
      hasAnimal: false,
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.reason, 'no_food_source_available');
  });
});

// ---------------------------------------------------------------------------
// 2. acquire_food: Terminal conditions
// ---------------------------------------------------------------------------

describe('GoalPlanner acquire_food — terminal conditions', () => {
  it('completes when food >= 18', () => {
    const simState = makeSimState({ food: 18 });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'completed');
    assert.equal(plan.goal, 'acquire_food');
  });

  it('completes when inventory has >= 2 cooked/safe food items', () => {
    const simState = makeSimState({
      food: 14,
      inventory: [
        { name: 'cooked_beef', count: 2 },
        { name: 'bread', count: 1 },
      ],
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'completed');
    assert.match(plan.message, /inventory/i);
  });

  it('does NOT complete when only 1 cooked food item in inventory', () => {
    const simState = makeSimState({
      food: 12,
      inventory: [{ name: 'cooked_beef', count: 1 }],
      hasAnimal: true,
      animalType: 'cow',
      adultCount: 3,
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    // Since food is 12 and 1 cooked_beef is in inventory, it should plan eating it!
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'eat');
    assert.equal(plan.args[0], 'cooked_beef');
  });
});

// ---------------------------------------------------------------------------
// 3. acquire_food: Dynamic Bread Crafting & Crafting Table Requirement
// ---------------------------------------------------------------------------

describe('GoalPlanner acquire_food — dynamic bread crafting', () => {
  it('at food 10, calculates requirement of 2 bread (6 wheat) and crafts at nearby table', () => {
    // food 10: neededFood = 8, neededBread = ceil(8/5) = 2, neededWheat = 6.
    const simState = makeSimState({
      food: 10,
      inventory: [{ name: 'wheat', count: 6 }],
      hasCraftingTable: true,
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'craft');
    assert.equal(plan.args[0], 'bread');
    assert.equal(plan.args[1], 2);
    assert.equal(plan.details.requiresTable, true);
  });

  it('blocks with no_crafting_table_nearby if 6 wheat are present but no table exists', () => {
    const simState = makeSimState({
      food: 10,
      inventory: [{ name: 'wheat', count: 6 }],
      hasCraftingTable: false, // no table nearby, no table in inventory, no planks
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.reason, 'no_crafting_table_nearby');
  });

  it('plans table placement if table is in inventory and needed for bread', () => {
    const simState = makeSimState({
      food: 10,
      inventory: [{ name: 'wheat', count: 6 }, { name: 'crafting_table', count: 1 }],
      hasCraftingTable: false,
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'place');
    assert.equal(plan.args[3], 'crafting_table');
  });
});

// ---------------------------------------------------------------------------
// 4. acquire_food: Crop harvest phase
// ---------------------------------------------------------------------------

describe('GoalPlanner acquire_food — crop harvest', () => {
  it('emits gather with replant: true for mature crop when hasCrop=true', () => {
    const simState = makeSimState({ food: 10, hasCrop: true });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'gather');
    assert.equal(plan.reason, 'harvest_crop_for_food');
    assert.equal(plan.args[1].replant, true);
  });

  it('falls through to animal phase when hasCrop=false', () => {
    const simState = makeSimState({ food: 10, hasCrop: false, hasAnimal: true, animalType: 'cow', adultCount: 3 });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'attack');
    assert.equal(plan.args[0], 'cow');
  });
});

// ---------------------------------------------------------------------------
// 5. acquire_food: Animal attack & safety rules
// ---------------------------------------------------------------------------

describe('GoalPlanner acquire_food — animal attack & safety', () => {
  it('blocks before attack with unsafe_food_requires_cooking when only chicken is available', () => {
    const simState = makeSimState({
      food: 10,
      hasCrop: false,
      hasAnimal: true,
      animalType: 'chicken', // unsafe raw food!
      adultCount: 3,
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.reason, 'unsafe_food_requires_cooking');
  });

  it('blocks with insufficient_food_acquired when adult count < 3 (preserves breeding pair)', () => {
    const simState = makeSimState({
      food: 10,
      hasCrop: false,
      hasAnimal: true,
      animalType: 'cow',
      adultCount: 2, // only 2 adults, cannot kill without leaving < 2!
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.reason, 'insufficient_food_acquired');
  });

  it('emits attack on cow when at least 3 adult cows exist', () => {
    const simState = makeSimState({
      food: 10,
      hasCrop: false,
      hasAnimal: true,
      animalType: 'cow',
      adultCount: 3,
    });
    const plan = GoalPlanner.planNextAction({ bot: null, goal: 'acquire_food', simulatedState: simState });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'attack');
    assert.equal(plan.args[0], 'cow');
  });
});

// ---------------------------------------------------------------------------
// 6. acquire_food: Projected-state simulation trace
// ---------------------------------------------------------------------------

describe('GoalPlanner.simulatePlan — acquire_food', () => {
  it('produces a simulation trace labeled simulated: true', () => {
    const trace = GoalPlanner.simulatePlan({
      goal: 'acquire_food',
      initialInventory: [{ name: 'bread', count: 2 }],
      initialFood: 10,
      hasCrop: false,
      hasAnimal: false,
    });

    assert.ok(trace.length > 0);
    assert.ok(trace.every(s => s.simulated === true));
  });

  it('terminates immediately when food >= 18', () => {
    const trace = GoalPlanner.simulatePlan({
      goal: 'acquire_food',
      initialInventory: [],
      initialFood: 18,
    });
    assert.equal(trace.length, 1);
    assert.equal(trace[0].status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// 7. SurvivalController Goal Stack & Suspension/Resumption
// ---------------------------------------------------------------------------

describe('SurvivalController — Goal Stack & Sub-Goal Preemption', () => {
  it('pushes serializable predicate onto goalStack and resumes suspended goal when predicate satisfied', async () => {
    const emittedEvents = [];
    const mockTelemetry = {
      emit(e) { emittedEvents.push(e); },
    };

    let currentFood = 4;
    const mockBot = {
      get food() { return currentFood; },
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] },
      findBlock: () => ({ position: { x: 2, y: 64, z: 0 }, name: 'wheat', getProperties: () => ({ age: '7' }) }),
    };

    const controller = new SurvivalController({
      bot: mockBot,
      actionManager: { isBusy: false },
      primitives: {},
      telemetry: mockTelemetry,
    });

    await controller.start('wooden_pickaxe');

    // Trigger starvation preemption tick:
    // Food = 4, wheat crop exists -> should suspend wooden_pickaxe and switch to acquire_food
    await controller._tick(controller.currentRunId);

    assert.equal(controller.currentGoal, 'acquire_food');
    assert.equal(controller.goalStack.length, 1);
    assert.equal(controller.goalStack[0].goal, 'wooden_pickaxe');
    assert.deepEqual(controller.goalStack[0].completionPredicate, { type: 'food_at_least', value: 18 });

    // Verify suspension event
    const suspendEvent = emittedEvents.find(e => e.event === 'controller_goal_suspended');
    assert.ok(suspendEvent, 'Should emit controller_goal_suspended');
    assert.equal(suspendEvent.goal, 'wooden_pickaxe');
    assert.equal(suspendEvent.newGoal, 'acquire_food');

    // Starvation tick while acquire_food is already active should NOT push duplicate
    await controller._tick(controller.currentRunId);
    assert.equal(controller.goalStack.length, 1, 'Must not push duplicate food goals onto stack');

    // Now simulate food restored to 18
    currentFood = 18;
    await controller._tick(controller.currentRunId);

    // Goal stack should be popped and restored to wooden_pickaxe
    const resumeEvent = emittedEvents.find(e => e.event === 'controller_goal_resumed');
    assert.ok(resumeEvent, 'Should emit controller_goal_resumed');
    assert.equal(resumeEvent.goal, 'wooden_pickaxe');
    assert.equal(controller.currentGoal, 'wooden_pickaxe');
    assert.equal(controller.goalStack.length, 0);

    await controller.stop('test_complete');
    assert.equal(controller.goalStack.length, 0, 'Stack must be cleared on stop');
  });
});
