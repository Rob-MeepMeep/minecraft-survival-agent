'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isDirectlyUnderFeet,
  hasGravityBlocksAbove,
  getInventoryCounts,
  computeInventoryDelta,
  findSafeBlock,
  getExpectedDrops,
  computeAttribution,
  isInventoryFull,
  createGatherer,
  GRAVITY_BLOCK_NAMES,
} = require('../src/actions/gather');
const { ActionManager } = require('../src/actions/manager');
const { FailureTracker } = require('../src/controller/failure_tracker');

// ---------------------------------------------------------------------------
// 1. Under-Feet Safety Checks
// ---------------------------------------------------------------------------

test('isDirectlyUnderFeet — detects supporting block directly beneath feet', () => {
  const bot = {
    entity: {
      position: { x: 10.4, y: 64.0, z: -5.8 },
    },
  };

  // Directly under feet: x=10, y=63, z=-6 (floor(-5.8) is -6)
  assert.equal(isDirectlyUnderFeet(bot, { x: 10, y: 63, z: -6 }), true);

  // Adjacent horizontally: safe
  assert.equal(isDirectlyUnderFeet(bot, { x: 11, y: 63, z: -6 }), false);
  assert.equal(isDirectlyUnderFeet(bot, { x: 10, y: 63, z: -5 }), false);

  // Eye-level block in front: safe
  assert.equal(isDirectlyUnderFeet(bot, { x: 10, y: 64, z: -5 }), false);

  // Null/missing bot entity
  assert.equal(isDirectlyUnderFeet({}, { x: 10, y: 63, z: -6 }), false);
});

// ---------------------------------------------------------------------------
// 2. Gravity Block Overhead Safety Checks
// ---------------------------------------------------------------------------

test('hasGravityBlocksAbove — detects sand and gravel overhead', () => {
  const worldBlocks = new Map();
  worldBlocks.set('10,65,10', { name: 'sand', boundingBox: 'block' });
  worldBlocks.set('10,66,10', { name: 'air' });

  const bot = {
    blockAt: (pos) => worldBlocks.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air' },
  };

  // Target at y=64 has sand at y=65
  assert.equal(hasGravityBlocksAbove(bot, { x: 10, y: 64, z: 10 }), true);

  // Target at y=64 with only stone above: safe
  worldBlocks.set('10,65,10', { name: 'stone', boundingBox: 'block' });
  assert.equal(hasGravityBlocksAbove(bot, { x: 10, y: 64, z: 10 }), false);

  // Target with stone, then sand on top of stone: stone supports sand, so safe
  worldBlocks.set('10,65,10', { name: 'stone', boundingBox: 'block' });
  worldBlocks.set('10,66,10', { name: 'gravel', boundingBox: 'block' });
  assert.equal(hasGravityBlocksAbove(bot, { x: 10, y: 64, z: 10 }), false);
});

// ---------------------------------------------------------------------------
// 3. Inventory Delta Calculations
// ---------------------------------------------------------------------------

test('computeInventoryDelta — calculates positive and negative changes', () => {
  const before = { oak_log: 2, dirt: 5 };
  const after = { oak_log: 3, dirt: 5, apple: 1 };

  const deltas = computeInventoryDelta(before, after);
  const map = Object.fromEntries(deltas.map((d) => [d.name, d.delta]));

  assert.equal(map.oak_log, 1);
  assert.equal(map.apple, 1);
  assert.equal(map.dirt, undefined); // No change, not in deltas
});

test('getInventoryCounts — aggregates duplicate item stacks in inventory', () => {
  const bot = {
    inventory: {
      items: () => [
        { name: 'dirt', count: 64 },
        { name: 'dirt', count: 12 },
        { name: 'bamboo', count: 5 },
      ],
    },
  };

  const counts = getInventoryCounts(bot);
  assert.equal(counts.dirt, 76);
  assert.equal(counts.bamboo, 5);
  assert.equal(counts.stone, undefined);
});

// ---------------------------------------------------------------------------
// 4. Safe Resource Filter
// ---------------------------------------------------------------------------

test('findSafeBlock — excludes blocks under feet and under sand', () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => {
      if (pos.x === 0 && pos.y === 65 && pos.z === 2) return { name: 'sand', boundingBox: 'block' };
      return { name: 'air' };
    },
    findBlock: ({ matching }) => {
      // Test 1: Block directly under feet
      const underFeet = { name: 'dirt', position: { x: 0, y: 63, z: 0 } };
      if (matching(underFeet)) return underFeet;

      // Test 2: Block with sand overhead
      const underSand = { name: 'dirt', position: { x: 0, y: 64, z: 2 } };
      if (matching(underSand)) return underSand;

      // Test 3: Safe block in front
      const safeBlock = { name: 'dirt', position: { x: 0, y: 64, z: 1 } };
      if (matching(safeBlock)) return safeBlock;

      return null;
    },
  };

  const chosen = findSafeBlock(bot, 'dirt', 10);
  assert.notEqual(chosen, null);
  assert.deepEqual(chosen.position, { x: 0, y: 64, z: 1 });
});

test('findSafeBlock — prioritizes walkable elevation and rejects steep drops', () => {
  const cliffBlock = { name: 'grass_block', position: { x: 3, y: 66, z: 0 } }; // dy = -4 from y=70
  const flatBlock = { name: 'dirt', position: { x: 5, y: 70, z: 0 } }; // dy = 0

  const bot = {
    entity: { position: { x: 0, y: 70, z: 0 } },
    blockAt: () => ({ name: 'air' }),
    findBlock: ({ matching }) => {
      // If cliffBlock matches, bot would mistakenly pick it without elevation filtering
      if (matching(cliffBlock)) return cliffBlock;
      if (matching(flatBlock)) return flatBlock;
      return null;
    },
  };

  const chosen = findSafeBlock(bot, 'dirt', 16);
  assert.notEqual(chosen, null);
  assert.deepEqual(chosen.position, { x: 5, y: 70, z: 0 }, 'Should select flat surface block instead of cliff drop');
});

test('findSafeBlock — respects column cooldown in failureTracker', () => {
  const colBlock1 = { name: 'dirt', position: { x: 4, y: 70, z: 2 } };
  const colBlock2 = { name: 'dirt', position: { x: 8, y: 70, z: 2 } };

  const bot = {
    entity: { position: { x: 0, y: 70, z: 0 } },
    blockAt: () => ({ name: 'air' }),
    findBlock: ({ matching }) => {
      if (matching(colBlock1)) return colBlock1;
      if (matching(colBlock2)) return colBlock2;
      return null;
    },
  };

  const tracker = new FailureTracker();
  tracker.recordFailure('gather:col:4,2', 'column_unreachable', 30000);

  const chosen = findSafeBlock(bot, 'dirt', 16, tracker);
  assert.notEqual(chosen, null);
  assert.deepEqual(chosen.position, { x: 8, y: 70, z: 2 }, 'Should bypass column on cooldown and select colBlock2');
});

test('findSafeBlock — falls back to lower ground elevation when standing on tree or mound', () => {
  const groundBlock = { name: 'grass_block', position: { x: 3, y: 65, z: 0 } }; // dy = -5 from y=70

  const bot = {
    entity: { position: { x: 0, y: 70, z: 0 } },
    blockAt: () => ({ name: 'air' }),
    findBlock: ({ matching }) => {
      if (matching(groundBlock)) return groundBlock;
      return null;
    },
  };

  const chosen = findSafeBlock(bot, 'dirt', 16);
  assert.notEqual(chosen, null);
  assert.deepEqual(chosen.position, { x: 3, y: 65, z: 0 }, 'Should find ground below tree/mound via Pass 2 fallback');
});

// ---------------------------------------------------------------------------
// 5. Expected Drops & Tool Harvest Requirements
// ---------------------------------------------------------------------------

test('getExpectedDrops — grass_block drops dirt', () => {
  const drops = getExpectedDrops({}, { name: 'grass_block' });
  assert.deepEqual(drops, ['dirt']);
});

test('getExpectedDrops — bamboo drops bamboo', () => {
  const drops = getExpectedDrops({}, { name: 'bamboo' });
  assert.deepEqual(drops, ['bamboo']);
});

test('getExpectedDrops — stone requires tool: drops cobblestone with pickaxe, empty without', () => {
  const stoneBlock = {
    name: 'stone',
    canHarvest: (toolType) => toolType === 101, // tool 101 is pickaxe
  };

  // With pickaxe tool
  const pickDrops = getExpectedDrops({}, stoneBlock, { type: 101 });
  assert.deepEqual(pickDrops, ['cobblestone']);

  // Unarmed / bare hands
  const bareDrops = getExpectedDrops({}, stoneBlock, null);
  assert.deepEqual(bareDrops, []);
});

// ---------------------------------------------------------------------------
// 6. Attribution: Separating Matched Drops vs Unrelated Pickups
// ---------------------------------------------------------------------------

test('computeAttribution — separates matched drops from unrelated inventory gains', () => {
  // Scenario: Dug grass_block (expected: dirt), but both dirt and stray bamboo were picked up
  const deltas = [
    { name: 'dirt', delta: 1 },
    { name: 'bamboo', delta: 5 },
  ];
  const expectedDrops = ['dirt'];

  const { matchedAcquisitions, unrelatedAcquisitions } = computeAttribution(deltas, expectedDrops);

  assert.deepEqual(matchedAcquisitions, [{ name: 'dirt', delta: 1 }]);
  assert.deepEqual(unrelatedAcquisitions, [{ name: 'bamboo', delta: 5 }]);
});

test('computeAttribution — rejects unrelated pickup when target drop is missing', () => {
  // Scenario: Dug grass_block (expected: dirt), but ONLY stray bamboo was picked up!
  const deltas = [{ name: 'bamboo', delta: 5 }];
  const expectedDrops = ['dirt'];

  const { matchedAcquisitions, unrelatedAcquisitions } = computeAttribution(deltas, expectedDrops);

  assert.equal(matchedAcquisitions.length, 0);
  assert.deepEqual(unrelatedAcquisitions, [{ name: 'bamboo', delta: 5 }]);
});

// ---------------------------------------------------------------------------
// 7. Full Inventory Detection
// ---------------------------------------------------------------------------

test('isInventoryFull — accurately checks inventory capacity', () => {
  // Scenario A: Slots available
  const botWithSlots = {
    inventory: {
      emptySlotCount: () => 3,
      items: () => [],
    },
  };
  assert.equal(isInventoryFull(botWithSlots, 'dirt'), false);

  // Scenario B: Zero empty slots and existing stack full (64)
  const botFull = {
    inventory: {
      emptySlotCount: () => 0,
      items: () => [{ name: 'dirt', count: 64, stackSize: 64 }],
    },
  };
  assert.equal(isInventoryFull(botFull, 'dirt'), true);

  // Scenario C: Zero empty slots but matching item has room (count: 32 < 64)
  const botStackable = {
    inventory: {
      emptySlotCount: () => 0,
      items: () => [{ name: 'dirt', count: 32, stackSize: 64 }],
    },
  };
  assert.equal(isInventoryFull(botStackable, 'dirt'), false);
});

// ---------------------------------------------------------------------------
// 8. Gather Attribution & State Verification Flow Integration Tests
// ---------------------------------------------------------------------------

test('createGatherer — rejects success when target block is not broken', async () => {
  const world = {
    '0,64,1': { name: 'grass_block', position: { x: 0, y: 64, z: 1 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async () => {
      // Simulate dig failing to change the world block state!
    },
    stopDigging: () => {},
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

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'block_not_broken');
});

test('createGatherer — rejects success and reports unmatched_inventory_gain when only unrelated items are picked up', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'grass_block', position: { x: 0, y: 64, z: 1 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async () => {
      // Block breaks into air
      delete world['0,64,1'];
      // Stray bamboo picked up instead of dirt
      invItems = [{ name: 'bamboo', count: 5 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'unmatched_inventory_gain');
  assert.equal(result.details.unrelatedAcquisitions[0].name, 'bamboo');
  assert.equal(result.details.matchedAcquisitions.length, 0);
});

test('createGatherer — succeeds when expected target drop is collected into inventory', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'grass_block', position: { x: 0, y: 64, z: 1 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async () => {
      // Block breaks into air
      delete world['0,64,1'];
      // Expected dirt collected
      invItems = [{ name: 'dirt', count: 1 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'gathered_item');
  assert.deepEqual(result.details.acquiredItems, [{ name: 'dirt', delta: 1 }]);
});

test('createGatherer — reports inventory_full when item cannot be picked up due to full inventory', async () => {
  const world = {
    '0,64,1': { name: 'bamboo', position: { x: 0, y: 64, z: 1 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async () => {
      // Block breaks, but full inventory prevents collecting
      delete world['0,64,1'];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => [{ name: 'cobblestone', count: 64, stackSize: 64 }],
      emptySlotCount: () => 0, // 0 empty slots
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'inventory_full');
});

test('createGatherer — delayed inventory pickup arriving between actions is not credited to subsequent action', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'grass_block', position: { x: 0, y: 64, z: 1 } },
    '0,64,2': { name: 'grass_block', position: { x: 0, y: 64, z: 2 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      // Neither action produces items directly during dig in this test
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);

  // Action 1: Dig block at (0,64,1). No drop collected -> fails
  const res1 = await gatherer.gather({ x: 0, y: 64, z: 1 });
  assert.equal(res1.outcome, 'failed');
  assert.equal(res1.reason, 'drop_not_collected');

  // Delayed pickup happens BETWEEN actions (while idle)
  invItems = [{ name: 'dirt', count: 1 }];

  // Action 2 starts AFTER delayed pickup already landed in inventory
  // Action 2 targets (0,64,2). Because dirt was already in inventory before Action 2 started/dug,
  // delta for Action 2 is 0 dirt, so Action 2 must NOT falsely claim success from the delayed pickup!
  const res2 = await gatherer.gather({ x: 0, y: 64, z: 2 });
  assert.equal(res2.outcome, 'failed');
  assert.equal(res2.reason, 'drop_not_collected');
  assert.equal(res2.matchedAcquisitions.length, 0);
});

test('getExpectedDrops — wheat drops both wheat and wheat_seeds', () => {
  const drops = getExpectedDrops({}, { name: 'wheat' });
  assert.deepEqual(drops, ['wheat', 'wheat_seeds']);
});

test('computeAttribution — classifies wheat and wheat_seeds as matchedAcquisitions from wheat block', () => {
  const deltas = [
    { name: 'wheat', delta: 2 },
    { name: 'wheat_seeds', delta: 3 },
    { name: 'dirt', delta: 1 },
  ];
  const expectedDrops = getExpectedDrops({}, { name: 'wheat' });
  const { matchedAcquisitions, unrelatedAcquisitions } = computeAttribution(deltas, expectedDrops);

  assert.deepEqual(matchedAcquisitions, [
    { name: 'wheat', delta: 2 },
    { name: 'wheat_seeds', delta: 3 },
  ]);
  assert.deepEqual(unrelatedAcquisitions, [{ name: 'dirt', delta: 1 }]);
});

test('createGatherer — rejects food harvest with seed_only_no_food_acquired when only seeds collected', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'wheat', position: { x: 0, y: 64, z: 1 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      // Only wheat_seeds collected, zero wheat!
      invItems = [{ name: 'wheat_seeds', count: 2 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 }, { replant: true });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'seed_only_no_food_acquired');
});

test('createGatherer — reports finalCropState with name and age 0 after replanting', async () => {
  let invItems = [{ name: 'wheat_seeds', count: 5 }];
  const world = {
    '0,63,1': { name: 'farmland', position: { x: 0, y: 63, z: 1 } },
    '0,64,1': { name: 'wheat', position: { x: 0, y: 64, z: 1 } },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      invItems = [{ name: 'wheat_seeds', count: 6 }, { name: 'wheat', count: 2 }];
    },
    stopDigging: () => {},
    equip: async () => {},
    activateBlock: async (belowBlock) => {
      // Replant wheat at age 0
      world['0,64,1'] = {
        name: 'wheat',
        position: { x: 0, y: 64, z: 1 },
        metadata: 0,
        getProperties: () => ({ age: 0 }),
      };
    },
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 }, { replant: true });

  assert.equal(result.outcome, 'success');
  assert.equal(result.replanted, true);
  assert.deepEqual(result.finalCropState, { name: 'wheat', age: 0 });
});

// ---------------------------------------------------------------------------
// 9. Stage 4 Drop Attribution & Entity Tracking Regressions
// ---------------------------------------------------------------------------

test('regression 1: invalid cached entity is ignored', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  let targetGoalPos = null;
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {
      999: { id: 999, name: 'item', isValid: false, position: { x: 0, y: 64, z: 0 } },
    },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      invItems = [{ name: 'dirt', count: 1 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async (goal) => {
        targetGoalPos = goal;
      },
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  // Stale entity 999 was ignored; trackedEntityId must not be 999
  assert.notEqual(result.details.trackedEntityId, 999);
});

test('regression 2: unrelated valid nearby item is ignored', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {
      888: {
        id: 888,
        name: 'item',
        isValid: true,
        item: { name: 'bone' },
        position: { x: 0.5, y: 64, z: 1.2 },
      },
    },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      invItems = [{ name: 'dirt', count: 1 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  // Unrelated bone entity 888 must not be tracked for dirt dig
  assert.notEqual(result.details.trackedEntityId, 888);
});

test('regression 3: expected new drop is selected', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  let spawnListener = null;
  const newDropEntity = {
    id: 777,
    name: 'item',
    isValid: true,
    item: { name: 'dirt' },
    position: { x: 0.5, y: 64, z: 1.5, distanceTo: () => 0.5 },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      bot.entities[777] = newDropEntity;
      if (spawnListener) spawnListener(newDropEntity);
      invItems = [{ name: 'dirt', count: 1 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
    on: (evt, fn) => {
      if (evt === 'entitySpawn') spawnListener = fn;
    },
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  assert.equal(result.details.trackedEntityId, 777);
});

test('regression 4: new entity disappears before navigation', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  let spawnListener = null;
  const newDropEntity = {
    id: 666,
    name: 'item',
    isValid: true,
    item: { name: 'dirt' },
    position: { x: 0.5, y: 64, z: 1.5, distanceTo: () => 0.5 },
  };

  let gotoCalls = [];
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      if (spawnListener) spawnListener(newDropEntity);
      // Entity disappears from entities map before navigation
      newDropEntity.isValid = false;
      delete bot.entities[666];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async (goal) => {
        gotoCalls.push(goal);
        if (gotoCalls.length === 2) {
          invItems = [{ name: 'dirt', count: 1 }];
        }
      },
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
    on: (evt, fn) => {
      if (evt === 'entitySpawn') spawnListener = fn;
    },
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  // Two goto calls: initial reach goal and pickup goal (GoalNear floors coordinates)
  assert.equal(gotoCalls.length, 2);
  const pickupGoal = gotoCalls[1];
  assert.equal(pickupGoal.x, 0);
  assert.equal(pickupGoal.z, 1);
  assert.ok(Math.abs(pickupGoal.rangeSq - 0.64) < 1e-4);
});

test('regression: skips drop pickup navigation when drop is already collected in inventory', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  let gotoCalls = [];
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      // Item instantly vacuumed upon block break
      invItems = [{ name: 'dirt', count: 1 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async (goal) => {
        gotoCalls.push(goal);
      },
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  // Only 1 goto call (reach goal), pickup navigation skipped because item was already collected
  assert.equal(gotoCalls.length, 1);
});

test('regression 5: inventory updates before entity tracking completes', async () => {
  let invItems = [];
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      // Inventory immediately increments during dig
      invItems = [{ name: 'dirt', count: 1 }];
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 20,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const startTime = Date.now();
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'success');
  // Settle loop exits immediately without polling for 2000ms
  assert.ok(Date.now() - startTime < 1000);
});

test('regression 6: target becomes directly underfoot after navigation', async () => {
  const world = {
    '0,63,1': { name: 'dirt', position: { x: 0, y: 63, z: 1 }, canHarvest: () => true },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async () => {
      assert.fail('bot.dig should not be called when block is directly underfoot');
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {
        // Bot moved and stepped directly on top of target block: x=0, y=64, z=1
        bot.entity.position = { x: 0.5, y: 64.0, z: 1.5 };
      },
    },
    inventory: {
      items: () => [],
      emptySlotCount: () => 20,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 63, z: 1 });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'target_under_feet');
});

test('regression 7: full inventory still reports collection failure', async () => {
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  const fullItems = Array.from({ length: 36 }, (_, i) => ({ name: `item_${i}`, count: 64 }));

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      // Inventory is full, no dirt collected
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => fullItems,
      emptySlotCount: () => 0,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'inventory_full');
});

test('regression 8: collectionOptional succeeds solely from the block becoming air', async () => {
  const world = {
    '0,64,1': { name: 'dirt', position: { x: 0, y: 64, z: 1 }, canHarvest: () => true },
  };

  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
    canDigBlock: () => true,
    dig: async (block) => {
      delete world[`${block.position.x},${block.position.y},${block.position.z}`];
      // No items collected into inventory
    },
    stopDigging: () => {},
    pathfinder: {
      setMovements: () => {},
      goto: async () => {},
    },
    inventory: {
      items: () => [],
      emptySlotCount: () => 20,
    },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = new ActionManager({
    bot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });

  const gatherer = createGatherer(bot, actionManager);
  const result = await gatherer.gather({ x: 0, y: 64, z: 1 }, { collectionOptional: true });

  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'block_cleared');
});



