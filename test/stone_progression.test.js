'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { FailureTracker } = require('../src/controller/failure_tracker');
const { GoalPlanner, findExposedStone } = require('../src/controller/planner');
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
    heldItem: overrides.heldItem || null,
    registry: {
      blocksByName: {
        oak_log: { id: 17, name: 'oak_log' },
        oak_planks: { id: 5, name: 'oak_planks' },
        stick: { id: 280, name: 'stick' },
        crafting_table: { id: 58, name: 'crafting_table' },
        wooden_pickaxe: { id: 270, name: 'wooden_pickaxe' },
        stone: { id: 1, name: 'stone' },
        cobblestone: { id: 4, name: 'cobblestone' },
        stone_pickaxe: { id: 274, name: 'stone_pickaxe' },
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
// 1. Prerequisite Chaining & Tool Equipping
// ---------------------------------------------------------------------------

test('GoalPlanner — missing wooden pickaxe delegates to wooden pickaxe planner first', () => {
  // Empty inventory: goal is stone_pickaxe -> must resolve wooden pickaxe first
  const bot = createMockBot({ items: [] });
  const plan = GoalPlanner.planNextAction({ bot, goal: 'stone_pickaxe' });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'gather');
  assert.equal(plan.reason, 'gather_logs_for_planks');
});

test('GoalPlanner — equips wooden pickaxe before gathering stone if not held', () => {
  const bot = createMockBot({
    items: [{ name: 'wooden_pickaxe', count: 1 }],
    heldItem: null, // Nothing in hand
  });
  const plan = GoalPlanner.planNextAction({ bot, goal: 'stone_pickaxe' });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'equip');
  assert.equal(plan.args[0], 'wooden_pickaxe');
  assert.equal(plan.args[1], 'hand');
  assert.equal(plan.reason, 'equip_pickaxe_for_mining');
});

// ---------------------------------------------------------------------------
// 2. Safe Exposed Stone Detection
// ---------------------------------------------------------------------------

test('findExposedStone — ignores blocks directly under feet or beneath gravity blocks', () => {
  const playerPos = new Vec3(5, 64, 5);
  const blocksMap = {
    // Under feet: (5, 63, 5) -> stone
    '5,63,5': { name: 'stone', boundingBox: 'block' },
    // Stone beneath gravity sand: (8, 64, 8) stone, (8, 65, 8) sand
    '8,64,8': { name: 'stone', boundingBox: 'block' },
    '8,65,8': { name: 'sand', boundingBox: 'block' },
    // Exposed safe stone: (10, 64, 5) stone, with air at (10, 65, 5)
    '10,64,5': { name: 'stone', boundingBox: 'block' },
    '10,65,5': { name: 'air', boundingBox: 'empty' },
  };

  const bot = createMockBot({
    playerPos,
    blockAt: (pos) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (blocksMap[key]) {
        return { ...blocksMap[key], position: new Vec3(pos.x, pos.y, pos.z) };
      }
      return { name: 'air', position: new Vec3(pos.x, pos.y, pos.z), boundingBox: 'empty' };
    },
    findBlock: ({ matching, useExtraInfo }) => {
      // Simulate checking blocks
      const candidates = [
        { name: 'stone', position: new Vec3(5, 63, 5) },
        { name: 'stone', position: new Vec3(8, 64, 8) },
        { name: 'stone', position: new Vec3(10, 64, 5) },
      ];
      for (const cand of candidates) {
        if (useExtraInfo(cand)) return cand;
      }
      return null;
    },
  });

  const selected = findExposedStone(bot, new FailureTracker());
  assert.ok(selected);
  assert.deepEqual(selected.position, new Vec3(10, 64, 5));
});

// ---------------------------------------------------------------------------
// 3. Exact 3 Cobblestone + 2 Stick Consumption & Table Reuse
// ---------------------------------------------------------------------------

test('GoalPlanner — reuses existing crafting table within 24m for stone pickaxe craft', () => {
  const tablePos = new Vec3(6, 64, 5);
  const bot = createMockBot({
    heldItem: { name: 'wooden_pickaxe' },
    items: [
      { name: 'wooden_pickaxe', count: 1 },
      { name: 'cobblestone', count: 3 },
      { name: 'stick', count: 2 },
    ],
    findBlock: ({ matching }) => {
      if (matching === 58) return { name: 'crafting_table', position: tablePos };
      return null;
    },
  });

  const plan = GoalPlanner.planNextAction({ bot, goal: 'stone_pickaxe' });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'craft');
  assert.equal(plan.args[0], 'stone_pickaxe');
  assert.equal(plan.reason, 'craft_stone_pickaxe');
  assert.equal(plan.details.cobblestone, 3);
  assert.equal(plan.details.sticks, 2);
});

// ---------------------------------------------------------------------------
// 4. Projected-State Simulation for Stone Pickaxe
// ---------------------------------------------------------------------------

test('GoalPlanner.simulatePlan — produces complete stone_pickaxe trace labeled with simulated: true', () => {
  const trace = GoalPlanner.simulatePlan({
    initialInventory: [],
    hasCraftingTable: false,
    goal: 'stone_pickaxe',
    maxSteps: 25,
  });

  assert.ok(trace.length >= 12);
  for (const step of trace) {
    assert.equal(step.simulated, true);
  }

  // Verify actions sequence includes wooden pickaxe production, tool equip, 3 stone gathers, and stone pickaxe craft
  const actions = trace.map(t => t.action).filter(Boolean);
  assert.ok(actions.includes('gather'));
  assert.ok(actions.includes('craft'));
  assert.ok(actions.includes('equip'));
  assert.ok(actions.includes('place'));

  const lastStep = trace[trace.length - 1];
  assert.equal(lastStep.status, 'completed');
  assert.equal(lastStep.goal, 'stone_pickaxe');
  const hasStonePickaxe = lastStep.resultingInventory.some(i => i.name === 'stone_pickaxe');
  assert.equal(hasStonePickaxe, true);
});

// ---------------------------------------------------------------------------
// 5. Recovery via Fine-Grained Cooldown
// ---------------------------------------------------------------------------

test('GoalPlanner — recovery: skips stone coordinate on cooldown and selects next available', () => {
  const tracker = new FailureTracker();
  const badStonePos = new Vec3(10, 64, 5);
  const goodStonePos = new Vec3(12, 64, 5);

  const badKey = FailureTracker.makeKey('gather', { x: 10, y: 64, z: 5, block: 'stone' });
  tracker.recordFailure(badKey, 'unreachable');

  const bot = createMockBot({
    heldItem: { name: 'wooden_pickaxe' },
    items: [{ name: 'wooden_pickaxe', count: 1 }],
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    findBlock: ({ useExtraInfo }) => {
      const candidates = [
        { name: 'stone', position: badStonePos },
        { name: 'stone', position: goodStonePos },
      ];
      for (const cand of candidates) {
        if (useExtraInfo(cand)) return cand;
      }
      return null;
    },
  });

  const plan = GoalPlanner.planNextAction({ bot, goal: 'stone_pickaxe', failureTracker: tracker });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'gather');
  assert.deepEqual(plan.args[0], goodStonePos); // Pivoted to goodStonePos!
});

test('GoalPlanner — recovery: falls back to local table craft/place when wooden pickaxe craft is on cooldown', () => {
  const tracker = new FailureTracker();
  const craftKey = FailureTracker.makeKey('craft', 'wooden_pickaxe');
  tracker.recordFailure(craftKey, 'no_crafting_table_nearby');

  const remoteTablePos = new Vec3(20, 90, 13);
  const bot = createMockBot({
    items: [
      { name: 'oak_planks', count: 8 },
      { name: 'stick', count: 4 },
    ],
    findBlock: ({ matching }) => {
      if (matching === 58) return { name: 'crafting_table', position: remoteTablePos };
      return null;
    },
  });

  // When craft:wooden_pickaxe is on cooldown, planner should NOT try to craft wooden_pickaxe at remote table.
  // Since inventory has 8 planks and 0 crafting_table item, it should plan craft: crafting_table!
  const plan = GoalPlanner.planNextAction({ bot, goal: 'wooden_pickaxe', failureTracker: tracker });

  assert.equal(plan.status, 'action_required');
  assert.equal(plan.action, 'craft');
  assert.equal(plan.args[0], 'crafting_table');
  assert.equal(plan.reason, 'craft_crafting_table');
});

