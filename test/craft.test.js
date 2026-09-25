'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getRecipeDeltas,
  findRecipe,
  findCraftingTable,
  createCrafter,
} = require('../src/actions/craft');
const {
  getDestSlot,
  VALID_DESTINATIONS,
  createEquipper,
} = require('../src/actions/equip');
const { ActionManager } = require('../src/actions/manager');

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [];
  const slots = new Array(46).fill(null);

  // Populate slots from items
  inventoryItems.forEach((item, idx) => {
    slots[36 + idx] = item;
  });

  return {
    entity: {
      position: { x: 0, y: 64, z: 0 },
    },
    inventory: {
      items: () => inventoryItems,
      slots: overrides.slots || slots,
      emptySlotCount: () => (overrides.slots || slots).slice(9, 45).filter((s) => s === null).length,
    },
    heldItem: overrides.heldItem || null,
    quickBarSlot: 0,
    currentWindow: null,
    registry: {
      itemsByName: {
        oak_log: { id: 10, name: 'oak_log' },
        oak_planks: { id: 20, name: 'oak_planks' },
        stick: { id: 30, name: 'stick' },
        crafting_table: { id: 40, name: 'crafting_table' },
        wooden_pickaxe: { id: 50, name: 'wooden_pickaxe' },
        iron_helmet: { id: 60, name: 'iron_helmet' },
        shield: { id: 70, name: 'shield' },
      },
      items: {
        10: { id: 10, name: 'oak_log' },
        20: { id: 20, name: 'oak_planks' },
        30: { id: 30, name: 'stick' },
        40: { id: 40, name: 'crafting_table' },
        50: { id: 50, name: 'wooden_pickaxe' },
        60: { id: 60, name: 'iron_helmet' },
        70: { id: 70, name: 'shield' },
      },
      blocksByName: {
        crafting_table: { id: 40, name: 'crafting_table' },
      },
    },
    pathfinder: {
      setMovements: () => {},
      setGoal: () => {},
      stop: () => {},
      goto: async () => {},
    },
    craft: async () => {},
    equip: async () => {},
    unequip: async () => {},
    openBlock: async () => ({ close: () => {} }),
    closeWindow: (w) => {},
    findBlock: () => null,
    recipesFor: () => [],
    recipesAll: () => [],
    getEquipmentDestSlot: (dest) => {
      switch (dest) {
        case 'head': return 5;
        case 'torso': return 6;
        case 'legs': return 7;
        case 'feet': return 8;
        case 'hand': return 36;
        case 'off-hand': return 45;
        default: return null;
      }
    },
    ...overrides,
  };
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
// 1. Recipe Deltas & Accounting
// ---------------------------------------------------------------------------

test('getRecipeDeltas — computes exact consumed and yield for 2x2 recipes', () => {
  const bot = createMockBot();

  // Recipe for oak_planks from oak_log: 1 oak_log -> 4 oak_planks
  const plankRecipe = {
    delta: [
      { id: 10, name: 'oak_log', count: -1 },
      { id: 20, name: 'oak_planks', count: 4 },
    ],
  };

  const delta1 = getRecipeDeltas(bot, plankRecipe, 1);
  assert.deepEqual(delta1.consumed, [{ name: 'oak_log', count: 1 }]);
  assert.deepEqual(delta1.output, { name: 'oak_planks', count: 4 });

  // Times = 3
  const delta3 = getRecipeDeltas(bot, plankRecipe, 3);
  assert.deepEqual(delta3.consumed, [{ name: 'oak_log', count: 3 }]);
  assert.deepEqual(delta3.output, { name: 'oak_planks', count: 12 });
});

test('getRecipeDeltas — computes exact consumed and yield for 3x3 multi-ingredient recipes', () => {
  const bot = createMockBot();

  // Recipe for wooden_pickaxe: 3 planks, 2 sticks -> 1 wooden_pickaxe
  const pickaxeRecipe = {
    delta: [
      { id: 20, name: 'oak_planks', count: -3 },
      { id: 30, name: 'stick', count: -2 },
      { id: 50, name: 'wooden_pickaxe', count: 1 },
    ],
  };

  const deltas = getRecipeDeltas(bot, pickaxeRecipe, 2);
  assert.equal(deltas.consumed.length, 2);
  assert.deepEqual(deltas.consumed, [
    { name: 'oak_planks', count: 6 },
    { name: 'stick', count: 4 },
  ]);
  assert.deepEqual(deltas.output, { name: 'wooden_pickaxe', count: 2 });
});

test('getRecipeDeltas — handles null/missing delta gracefully', () => {
  const bot = createMockBot();
  const deltas = getRecipeDeltas(bot, null);
  assert.equal(deltas.output, null);
  assert.deepEqual(deltas.consumed, []);
});

// ---------------------------------------------------------------------------
// 2. Recipe Selection & 2x2 vs 3x3 Grid
// ---------------------------------------------------------------------------

test('findRecipe — identifies 2x2 player inventory recipes vs 3x3 table recipes', () => {
  const plankRecipe = {
    result: { id: 20, count: 4 },
    requiresTable: false,
    delta: [{ id: 10, count: -1 }, { id: 20, count: 4 }],
  };

  const pickaxeRecipe = {
    result: { id: 50, count: 1 },
    requiresTable: true,
    delta: [{ id: 20, count: -3 }, { id: 30, count: -2 }, { id: 50, count: 1 }],
  };

  const bot = createMockBot({
    recipesFor: (id) => {
      if (id === 20) return [plankRecipe];
      if (id === 50) return [pickaxeRecipe];
      return [];
    },
    recipesAll: (id) => {
      if (id === 20) return [plankRecipe];
      if (id === 50) return [pickaxeRecipe];
      return [];
    },
  });

  const foundPlanks = findRecipe(bot, 'oak_planks');
  assert.ok(foundPlanks);
  assert.equal(foundPlanks.requiresTable, false);

  const foundPickaxe = findRecipe(bot, 'wooden_pickaxe');
  assert.ok(foundPickaxe);
  assert.equal(foundPickaxe.requiresTable, true);
});

// ---------------------------------------------------------------------------
// 3. Crafting Table Requirement & Search
// ---------------------------------------------------------------------------

test('findCraftingTable — finds nearby crafting table within range', () => {
  const tablePos = { x: 3, y: 64, z: 2 };
  const mockTable = { position: tablePos, name: 'crafting_table' };

  const bot = createMockBot({
    findBlock: ({ point, maxDistance, matching }) => {
      return mockTable;
    },
  });

  const table = findCraftingTable(bot, 16);
  assert.ok(table);
  assert.equal(table.name, 'crafting_table');
});

test('createCrafter — rejects 3x3 recipe with no_crafting_table_nearby when no table exists', async () => {
  const pickaxeRecipe = {
    result: { id: 50, count: 1 },
    requiresTable: true,
    delta: [{ id: 20, count: -3 }, { id: 30, count: -2 }, { id: 50, count: 1 }],
  };

  const bot = createMockBot({
    recipesAll: () => [pickaxeRecipe],
    findBlock: () => null, // No table in range
  });

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('wooden_pickaxe', 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'no_crafting_table_nearby');

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'failed');
  assert.equal(endEvent.reason, 'no_crafting_table_nearby');
});

// ---------------------------------------------------------------------------
// 4. Exact Ingredient and Yield Postconditions
// ---------------------------------------------------------------------------

test('createCrafter — succeeds and verifies exact inventory delta postcondition for 2x2 craft', async () => {
  const plankRecipe = {
    result: { id: 20, count: 4 },
    requiresTable: false,
    delta: [{ id: 10, count: -1 }, { id: 20, count: 4 }],
  };

  let inventory = [{ name: 'oak_log', count: 2 }];

  const bot = createMockBot({
    recipesFor: () => [plankRecipe],
    recipesAll: () => [plankRecipe],
    craft: async (recipe, count) => {
      // Simulate crafting: consume 1 log, add 4 planks
      inventory = [
        { name: 'oak_log', count: 1 },
        { name: 'oak_planks', count: 4 },
      ];
    },
  });
  bot.inventory.items = () => inventory;

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('oak_planks', 1);
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'crafted_item');
  assert.equal(result.item, 'oak_planks');
  assert.equal(result.yield, 4);

  // Check telemetry action_end
  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'success');
  assert.equal(endEvent.reason, 'crafted_item');
  assert.equal(endEvent.item, 'oak_planks');
  assert.equal(endEvent.yield, 4);
  assert.deepEqual(endEvent.consumed, [{ name: 'oak_log', count: 1 }]);
});

test('createCrafter — fails if ingredients are not consumed as expected', async () => {
  const plankRecipe = {
    result: { id: 20, count: 4 },
    requiresTable: false,
    delta: [{ id: 10, count: -1 }, { id: 20, count: 4 }],
  };

  // Inventory has log, but craft mock does not consume it
  let inventory = [{ name: 'oak_log', count: 2 }];

  const bot = createMockBot({
    recipesFor: () => [plankRecipe],
    recipesAll: () => [plankRecipe],
    craft: async () => {
      // Buggy craft: gained planks but did NOT consume log
      inventory = [
        { name: 'oak_log', count: 2 },
        { name: 'oak_planks', count: 4 },
      ];
    },
  });
  bot.inventory.items = () => inventory;

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('oak_planks', 1);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'ingredient_consumption_mismatch');

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.equal(endEvent.outcome, 'partial');
  assert.equal(endEvent.reason, 'ingredient_consumption_mismatch');
});

test('createCrafter — fails if output item is not gained as expected', async () => {
  const plankRecipe = {
    result: { id: 20, count: 4 },
    requiresTable: false,
    delta: [{ id: 10, count: -1 }, { id: 20, count: 4 }],
  };

  let inventory = [{ name: 'oak_log', count: 2 }];

  const bot = createMockBot({
    recipesFor: () => [plankRecipe],
    recipesAll: () => [plankRecipe],
    craft: async () => {
      // Consumed log but output item didn't make it to inventory
      inventory = [{ name: 'oak_log', count: 1 }];
    },
  });
  bot.inventory.items = () => inventory;

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('oak_planks', 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'output_not_received');

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.equal(endEvent.outcome, 'failed');
  assert.equal(endEvent.reason, 'output_not_received');
});

// ---------------------------------------------------------------------------
// 5. Equipment Postcondition Verification
// ---------------------------------------------------------------------------

test('getDestSlot — maps all standard equipment destinations', () => {
  const bot = createMockBot();
  assert.equal(getDestSlot(bot, 'head'), 5);
  assert.equal(getDestSlot(bot, 'torso'), 6);
  assert.equal(getDestSlot(bot, 'legs'), 7);
  assert.equal(getDestSlot(bot, 'feet'), 8);
  assert.equal(getDestSlot(bot, 'hand'), 36);
  assert.equal(getDestSlot(bot, 'off-hand'), 45);
  assert.equal(getDestSlot(bot, 'unknown'), null);
});

test('createEquipper — rejects invalid equipment destination', async () => {
  const bot = createMockBot();
  const { manager } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.equip('wooden_pickaxe', 'shoulder');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'invalid_destination');
});

test('createEquipper — rejects equip when item is not in inventory', async () => {
  const bot = createMockBot({ items: [] });
  const { manager } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.equip('wooden_pickaxe', 'hand');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'item_not_in_inventory');
});

test('createEquipper — equips item to hand and verifies postcondition', async () => {
  const pickaxeItem = { name: 'wooden_pickaxe', type: 50, count: 1 };
  const slots = new Array(46).fill(null);
  slots[36] = null; // hand slot empty initially
  slots[37] = pickaxeItem;

  const bot = createMockBot({
    items: [pickaxeItem],
    slots,
    equip: async (item, dest) => {
      // Simulate equipping to hand
      bot.heldItem = item;
      bot.inventory.slots[36] = item;
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.equip('wooden_pickaxe', 'hand');
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'item_equipped');
  assert.equal(result.destination, 'hand');
  assert.equal(result.destSlot, 36);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'success');
  assert.equal(endEvent.destination, 'hand');
  assert.equal(endEvent.destSlot, 36);
});

test('createEquipper — fails equip postcondition if slot does not match after equip', async () => {
  const pickaxeItem = { name: 'wooden_pickaxe', type: 50, count: 1 };
  const slots = new Array(46).fill(null);
  slots[37] = pickaxeItem;

  const bot = createMockBot({
    items: [pickaxeItem],
    slots,
    equip: async () => {
      // Simulate failed equip: slot remains null
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.equip('wooden_pickaxe', 'hand');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'postcondition_failed');

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.equal(endEvent.outcome, 'failed');
  assert.equal(endEvent.reason, 'postcondition_failed');
});

test('createEquipper — reports already_empty when unequip called on empty destination slot', async () => {
  const slots = new Array(46).fill(null);
  const bot = createMockBot({ slots });

  const { manager } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.unequip('head');
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'already_empty');
});

test('createEquipper — unequips item and verifies empty slot postcondition', async () => {
  const helmetItem = { name: 'iron_helmet', type: 60, count: 1 };
  const slots = new Array(46).fill(null);
  slots[5] = helmetItem; // head slot has helmet

  const bot = createMockBot({
    slots,
    unequip: async (dest) => {
      // Simulate unequip: slot becomes null
      bot.inventory.slots[5] = null;
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.unequip('head');
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'item_unequipped');
  assert.equal(result.destination, 'head');
  assert.equal(result.destSlot, 5);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'success');
  assert.equal(endEvent.reason, 'item_unequipped');
  assert.equal(endEvent.destination, 'head');
  assert.equal(endEvent.destSlot, 5);
});

// ---------------------------------------------------------------------------
// 6. Regression Suite: Edge Cases & Robustness
// ---------------------------------------------------------------------------

test('createCrafter — crafts multiple batches with times > 1 and exact consumption/yield', async () => {
  const plankRecipe = {
    result: { id: 20, count: 4 },
    requiresTable: false,
    delta: [{ id: 10, count: -1 }, { id: 20, count: 4 }],
  };

  let inventory = [{ name: 'oak_log', count: 3 }];

  const bot = createMockBot({
    recipesFor: () => [plankRecipe],
    recipesAll: () => [plankRecipe],
    craft: async (recipe, count) => {
      // Crafting 2 batches: consume 2 logs, gain 8 planks
      inventory = [
        { name: 'oak_log', count: 1 },
        { name: 'oak_planks', count: 8 },
      ];
    },
  });
  bot.inventory.items = () => inventory;

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('oak_planks', 2);
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'crafted_item');
  assert.equal(result.item, 'oak_planks');
  assert.equal(result.yield, 8);
  assert.deepEqual(result.consumed, [{ name: 'oak_log', count: 2 }]);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.yield, 8);
  assert.deepEqual(endEvent.consumed, [{ name: 'oak_log', count: 2 }]);
});

test('createCrafter — fails with missing_ingredients when player has 0 ingredients', async () => {
  const bot = createMockBot({
    items: [],
    recipesFor: () => [],
    recipesAll: () => [],
  });

  const { manager } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('oak_planks', 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'missing_ingredients');
});

test('createCrafter — fails with insufficient_ingredients when player has partial ingredients', async () => {
  const tableRecipe = {
    result: { id: 40, count: 1 },
    requiresTable: false,
    delta: [{ id: 20, count: -4 }, { id: 40, count: 1 }],
  };

  // Player has 2 planks, but crafting_table requires 4
  const inventory = [{ name: 'oak_planks', count: 2 }];

  const bot = createMockBot({
    items: inventory,
    recipesFor: () => [tableRecipe],
    recipesAll: () => [tableRecipe],
  });

  const { manager } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('crafting_table', 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'insufficient_ingredients');
  assert.equal(result.details.required, 4);
  assert.equal(result.details.available, 2);
});

test('createCrafter — crafts recipe with mixed wood / plank types and tracks each ingredient', async () => {
  // Mixed stick recipe: 1 oak_planks + 1 birch_planks -> 4 stick
  const mixedStickRecipe = {
    result: { id: 30, count: 4 },
    requiresTable: false,
    delta: [
      { id: 20, name: 'oak_planks', count: -1 },
      { id: 21, name: 'birch_planks', count: -1 },
      { id: 30, name: 'stick', count: 4 },
    ],
  };

  let inventory = [
    { name: 'oak_planks', count: 2 },
    { name: 'birch_planks', count: 2 },
  ];

  const bot = createMockBot({
    items: inventory,
    recipesFor: () => [mixedStickRecipe],
    recipesAll: () => [mixedStickRecipe],
    craft: async () => {
      inventory = [
        { name: 'oak_planks', count: 1 },
        { name: 'birch_planks', count: 1 },
        { name: 'stick', count: 4 },
      ];
    },
  });
  bot.inventory.items = () => inventory;

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const result = await crafter.craft('stick', 1);
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'crafted_item');
  assert.equal(result.yield, 4);
  assert.deepEqual(result.consumed, [
    { name: 'oak_planks', count: 1 },
    { name: 'birch_planks', count: 1 },
  ]);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.deepEqual(endEvent.consumed, [
    { name: 'oak_planks', count: 1 },
    { name: 'birch_planks', count: 1 },
  ]);
});

test('createCrafter — closes crafting window when cancelled while window is open', async () => {
  const pickaxeRecipe = {
    result: { id: 50, count: 1 },
    requiresTable: true,
    delta: [{ id: 20, count: -3 }, { id: 30, count: -2 }, { id: 50, count: 1 }],
  };

  let windowClosed = false;
  const mockWindow = { id: 1, type: 'crafting_table' };

  const bot = createMockBot({
    items: [
      { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 },
    ],
    findBlock: () => ({ position: { x: 1, y: 64, z: 1 }, name: 'crafting_table' }),
    recipesFor: () => [pickaxeRecipe],
    recipesAll: () => [pickaxeRecipe],
    craft: async () => {
      bot.currentWindow = mockWindow;
      // Hang until aborted
      await new Promise((_, reject) => {
        // Will be interrupted
      });
    },
    closeWindow: (w) => {
      if (w === mockWindow) windowClosed = true;
      bot.currentWindow = null;
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const crafter = createCrafter(bot, manager);

  const craftPromise = crafter.craft('wooden_pickaxe', 1);

  // Cancel action after short tick
  setTimeout(() => {
    manager.cancel('user_interrupted');
  }, 50);

  const result = await craftPromise;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.reason, 'user_interrupted');
  assert.equal(windowClosed, true);
  assert.equal(bot.currentWindow, null);

  const endEvents = events.filter((e) => e.event === 'action_end');
  assert.equal(endEvents.length, 1);
});

test('createEquipper — equips into occupied slot and verifies displaced item', async () => {
  const leatherHelmet = { name: 'leather_helmet', type: 61, count: 1 };
  const ironHelmet = { name: 'iron_helmet', type: 60, count: 1 };

  const slots = new Array(46).fill(null);
  slots[5] = leatherHelmet; // head occupied by leather_helmet
  slots[36] = ironHelmet;   // inventory has iron_helmet

  let inventoryItems = [ironHelmet];

  const bot = createMockBot({
    slots,
    items: inventoryItems,
    equip: async (item, dest) => {
      // Simulate Minecraft: leather_helmet is displaced back to inventory, iron_helmet equipped to slot 5
      bot.inventory.slots[5] = ironHelmet;
      bot.inventory.slots[36] = leatherHelmet;
      inventoryItems = [leatherHelmet];
    },
  });
  bot.inventory.items = () => inventoryItems;

  const { manager, events } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.equip('iron_helmet', 'head');
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'item_equipped');
  assert.equal(result.destination, 'head');
  assert.equal(result.destSlot, 5);
  assert.equal(result.displacedItem, 'leather_helmet');

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.displacedItem, 'leather_helmet');
});

test('createEquipper — rejects unequip when main inventory is full', async () => {
  const helmetItem = { name: 'iron_helmet', type: 60, count: 1 };
  const slots = new Array(46).fill(null);
  slots[5] = helmetItem;

  // Fill all main inventory slots (9 to 44) with full stacks of cobblestone
  for (let i = 9; i <= 44; i++) {
    slots[i] = { name: 'cobblestone', count: 64, stackSize: 64 };
  }

  const bot = createMockBot({
    slots,
    items: slots.slice(9, 45),
  });

  const { manager } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  const result = await equipper.unequip('head');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'inventory_full');
  assert.ok(result.details.note.includes('inventory is full'));
});

test('createEquipper — rejects invalid armor slot combinations', async () => {
  const pickaxe = { name: 'wooden_pickaxe', type: 50, count: 1 };
  const apple = { name: 'apple', type: 51, count: 1 };
  const dirt = { name: 'dirt', type: 52, count: 1 };

  const bot = createMockBot({
    items: [pickaxe, apple, dirt],
  });

  const { manager } = createMockActionManager(bot);
  const equipper = createEquipper(bot, manager);

  // Pickaxe to head
  const r1 = await equipper.equip('wooden_pickaxe', 'head');
  assert.equal(r1.outcome, 'failed');
  assert.equal(r1.reason, 'incompatible_slot');

  // Apple to torso
  const r2 = await equipper.equip('apple', 'torso');
  assert.equal(r2.outcome, 'failed');
  assert.equal(r2.reason, 'incompatible_slot');

  // Dirt to feet
  const r3 = await equipper.equip('dirt', 'feet');
  assert.equal(r3.outcome, 'failed');
  assert.equal(r3.reason, 'incompatible_slot');
});
