'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isFood,
  isUnsafeFood,
  canEatWhenFull,
  findBestFood,
  createEater,
  FOOD_REGISTRY,
} = require('../src/actions/eat');
const { ActionManager } = require('../src/actions/manager');

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [];
  const slots = new Array(46).fill(null);

  inventoryItems.forEach((item, idx) => {
    slots[36 + idx] = item;
  });

  const mock = {
    food: overrides.food !== undefined ? overrides.food : 14,
    foodSaturation: overrides.foodSaturation !== undefined ? overrides.foodSaturation : 5.0,
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
      foodsByName: {
        cooked_beef: { id: 100, name: 'cooked_beef' },
        bread: { id: 101, name: 'bread' },
        apple: { id: 102, name: 'apple' },
        golden_apple: { id: 103, name: 'golden_apple' },
        rotten_flesh: { id: 104, name: 'rotten_flesh' },
      },
    },
    equip: async (item, dest) => {
      mock.heldItem = item;
    },
    consume: async () => {},
    deactivateItem: () => {},
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
// 1. Food Classification & Registry
// ---------------------------------------------------------------------------

test('isFood — correctly identifies edible foods vs non-foods', () => {
  assert.equal(isFood('cooked_beef'), true);
  assert.equal(isFood('bread'), true);
  assert.equal(isFood('apple'), true);
  assert.equal(isFood('golden_apple'), true);
  assert.equal(isFood('rotten_flesh'), true);

  assert.equal(isFood('diamond'), false);
  assert.equal(isFood('stick'), false);
  assert.equal(isFood('dirt'), false);
  assert.equal(isFood(null), false);
});

test('isUnsafeFood — correctly flags harmful / toxic foods', () => {
  assert.equal(isUnsafeFood('rotten_flesh'), true);
  assert.equal(isUnsafeFood('pufferfish'), true);
  assert.equal(isUnsafeFood('spider_eye'), true);
  assert.equal(isUnsafeFood('poisonous_potato'), true);
  assert.equal(isUnsafeFood('raw_chicken'), true);

  assert.equal(isUnsafeFood('cooked_beef'), false);
  assert.equal(isUnsafeFood('bread'), false);
  assert.equal(isUnsafeFood('apple'), false);
  assert.equal(isUnsafeFood('golden_apple'), false);
});

test('canEatWhenFull — distinguishes full-hunger exempt items', () => {
  assert.equal(canEatWhenFull('golden_apple'), true);
  assert.equal(canEatWhenFull('enchanted_golden_apple'), true);
  assert.equal(canEatWhenFull('honey_bottle'), true);
  assert.equal(canEatWhenFull('chorus_fruit'), true);

  assert.equal(canEatWhenFull('cooked_beef'), false);
  assert.equal(canEatWhenFull('bread'), false);
  assert.equal(canEatWhenFull('apple'), false);
});

// ---------------------------------------------------------------------------
// 2. Food Selection Logic
// ---------------------------------------------------------------------------

test('findBestFood — selects highest nutrition food and respects safety policy', () => {
  const apple = { name: 'apple', count: 5 };
  const cookedBeef = { name: 'cooked_beef', count: 2 };
  const rottenFlesh = { name: 'rotten_flesh', count: 10 };

  // Between apple (points 4) and cooked_beef (points 8), choose cooked_beef
  const bot1 = createMockBot({ items: [apple, cookedBeef] });
  const best1 = findBestFood(bot1);
  assert.ok(best1);
  assert.equal(best1.item.name, 'cooked_beef');

  // Inventory with only unsafe food: rejected by default
  const bot2 = createMockBot({ items: [rottenFlesh] });
  assert.equal(findBestFood(bot2, { allowUnsafe: false }), null);

  // Allowed when allowUnsafe=true
  const bestUnsafe = findBestFood(bot2, { allowUnsafe: true });
  assert.ok(bestUnsafe);
  assert.equal(bestUnsafe.item.name, 'rotten_flesh');

  // Specific item selection
  const bestSpecific = findBestFood(bot1, { specificItem: 'apple' });
  assert.ok(bestSpecific);
  assert.equal(bestSpecific.item.name, 'apple');
});

// ---------------------------------------------------------------------------
// 3. Hunger Gating
// ---------------------------------------------------------------------------

test('createEater — rejects eating when hunger is full (already_full)', async () => {
  const cookedBeef = { name: 'cooked_beef', count: 3 };
  const bot = createMockBot({ food: 20, items: [cookedBeef] });

  const { manager, events } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  // Auto-selection
  const r1 = await eater.eat();
  assert.equal(r1.outcome, 'failed');
  assert.equal(r1.reason, 'already_full');

  // Explicit item
  const r2 = await eater.eat('cooked_beef');
  assert.equal(r2.outcome, 'failed');
  assert.equal(r2.reason, 'already_full');
});

test('createEater — allows eating when full if food is golden_apple', async () => {
  const gApple = { name: 'golden_apple', count: 2 };
  let consumed = false;

  const bot = createMockBot({
    food: 20,
    foodSaturation: 10.0,
    items: [gApple],
    consume: async () => {
      consumed = true;
      bot.foodSaturation = 19.6; // Saturation increases
      bot.inventory.items = () => [{ name: 'golden_apple', count: 1 }];
    },
  });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('golden_apple');
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'consumed');
  assert.equal(result.item, 'golden_apple');
  assert.equal(consumed, true);
});

// ---------------------------------------------------------------------------
// 4. Unsafe Food Policy
// ---------------------------------------------------------------------------

test('createEater — rejects unsafe food by default', async () => {
  const flesh = { name: 'rotten_flesh', count: 5 };
  const bot = createMockBot({ food: 10, items: [flesh] });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('rotten_flesh');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'unsafe_food');
});

test('createEater — allows unsafe food when allowUnsafe: true is specified', async () => {
  const flesh = { name: 'rotten_flesh', count: 5 };
  let consumed = false;

  const bot = createMockBot({
    food: 10,
    items: [flesh],
    consume: async () => {
      consumed = true;
      bot.food = 14;
      bot.inventory.items = () => [{ name: 'rotten_flesh', count: 4 }];
    },
  });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('rotten_flesh', { allowUnsafe: true });
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'consumed');
  assert.equal(result.item, 'rotten_flesh');
  assert.equal(consumed, true);
});

// ---------------------------------------------------------------------------
// 5. Missing Food & Non-Food Rejection
// ---------------------------------------------------------------------------

test('createEater — rejects non-food items with not_food', async () => {
  const bot = createMockBot({ food: 10, items: [] });
  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('diamond');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'not_food');
});

test('createEater — rejects with no_food_available when inventory lacks food', async () => {
  const bot = createMockBot({ food: 10, items: [] });
  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'no_food_available');
});

// ---------------------------------------------------------------------------
// 6. Successful Consumption & Postcondition Verification
// ---------------------------------------------------------------------------

test('createEater — successfully consumes food and verifies inventory & hunger deltas', async () => {
  const bread = { name: 'bread', count: 3 };
  let consumed = false;

  const bot = createMockBot({
    food: 12,
    foodSaturation: 2.0,
    items: [bread],
    consume: async () => {
      consumed = true;
      // Simulate eating: 1 bread consumed, food +5 (17), saturation +6 (8.0)
      bot.food = 17;
      bot.foodSaturation = 8.0;
      bot.inventory.items = () => [{ name: 'bread', count: 2 }];
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('bread');
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'consumed');
  assert.equal(result.item, 'bread');
  assert.equal(result.itemsConsumed, 1);
  assert.equal(result.foodBefore, 12);
  assert.equal(result.foodAfter, 17);
  assert.equal(result.foodDelta, 5);
  assert.equal(result.satBefore, 2.0);
  assert.equal(result.satAfter, 8.0);
  assert.equal(result.satDelta, 6.0);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'success');
  assert.equal(endEvent.reason, 'consumed');
  assert.equal(endEvent.foodDelta, 5);
});

test('createEater — fails if inventory decrement does not occur', async () => {
  const bread = { name: 'bread', count: 3 };

  const bot = createMockBot({
    food: 12,
    items: [bread],
    consume: async () => {
      // Buggy consume: hunger increased but item count was NOT decremented
      bot.food = 17;
    },
  });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('bread');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'inventory_decrement_failed');
});

test('createEater — fails if hunger and saturation do not increase', async () => {
  const bread = { name: 'bread', count: 3 };

  const bot = createMockBot({
    food: 12,
    foodSaturation: 2.0,
    items: [bread],
    consume: async () => {
      // Buggy consume: item decremented but hunger didn't increase
      bot.inventory.items = () => [{ name: 'bread', count: 2 }];
    },
  });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('bread');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'nutrition_postcondition_failed');
});

// ---------------------------------------------------------------------------
// 7. Cancellation Boundaries & Item Deactivation
// ---------------------------------------------------------------------------

test('createEater — cancels cleanly during consumption and deactivates item', async () => {
  const bread = { name: 'bread', count: 3 };
  let deactivated = false;

  const bot = createMockBot({
    food: 12,
    items: [bread],
    consume: async () => {
      // Hang until aborted
      await new Promise(() => {});
    },
    deactivateItem: () => {
      deactivated = true;
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const eatPromise = eater.eat('bread');

  setTimeout(() => {
    manager.cancel('user_interrupted');
  }, 50);

  const result = await eatPromise;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.reason, 'user_interrupted');
  assert.equal(deactivated, true);

  const endEvents = events.filter((e) => e.event === 'action_end');
  assert.equal(endEvents.length, 1);
});

// ---------------------------------------------------------------------------
// 8. Follow-up Policy, Restoration & Special Food Coverage
// ---------------------------------------------------------------------------

test('createEater — rejects missing requested item with item_not_in_inventory', async () => {
  const beef = { name: 'cooked_beef', count: 2 };
  const bot = createMockBot({ food: 10, items: [beef] });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const result = await eater.eat('bread');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'item_not_in_inventory');
});

test('isUnsafeFood — treats chorus_fruit and suspicious_stew as unsafe by default', () => {
  assert.equal(isUnsafeFood('chorus_fruit'), true);
  assert.equal(isUnsafeFood('suspicious_stew'), true);
});

test('findBestFood — prevents automatic selection of valuable foods unless emergency policy allows', () => {
  const apple = { name: 'apple', count: 3 };
  const gApple = { name: 'golden_apple', count: 2 };

  // Normal health, no emergency policy: apple chosen over golden_apple
  const botNormal = createMockBot({ health: 20, items: [apple, gApple] });
  const bestNormal = findBestFood(botNormal);
  assert.ok(bestNormal);
  assert.equal(bestNormal.item.name, 'apple');

  // Explicit emergency policy: golden_apple permitted and chosen for higher nutrition/sat
  const bestEmergency = findBestFood(botNormal, { emergencyPolicy: true });
  assert.ok(bestEmergency);
  assert.equal(bestEmergency.item.name, 'golden_apple');

  // Low health (<= 6): auto-triggers emergency policy
  const botLowHealth = createMockBot({ health: 4, items: [apple, gApple] });
  const bestLowHealth = findBestFood(botLowHealth);
  assert.ok(bestLowHealth);
  assert.equal(bestLowHealth.item.name, 'golden_apple');
});

test('createEater — restores previously held item on success and cancellation', async () => {
  const pickaxe = { name: 'wooden_pickaxe', type: 270 };
  const bread = { name: 'bread', count: 2, type: 297 };

  // 1. Success case
  const bot1 = createMockBot({
    food: 14,
    heldItem: pickaxe,
    items: [pickaxe, bread],
    consume: async () => {
      bot1.food = 19;
      bot1.inventory.items = () => [pickaxe, { name: 'bread', count: 1, type: 297 }];
    },
  });

  const { manager: m1 } = createMockActionManager(bot1);
  const eater1 = createEater(bot1, m1);

  const res1 = await eater1.eat('bread');
  assert.equal(res1.outcome, 'success');
  // Verify pickaxe restored to hand
  assert.ok(bot1.heldItem);
  assert.equal(bot1.heldItem.name, 'wooden_pickaxe');

  // 2. Cancellation case
  let deactivated = false;
  const bot2 = createMockBot({
    food: 14,
    heldItem: pickaxe,
    items: [pickaxe, bread],
    consume: async () => {
      await new Promise(() => {});
    },
    deactivateItem: () => {
      deactivated = true;
    },
  });

  const { manager: m2 } = createMockActionManager(bot2);
  const eater2 = createEater(bot2, m2);

  const eatPromise = eater2.eat('bread');
  setTimeout(() => m2.cancel('user_interrupted'), 50);

  const res2 = await eatPromise;
  assert.equal(res2.outcome, 'cancelled');
  assert.equal(deactivated, true);
  // Pickaxe restored to hand after cancellation
  assert.ok(bot2.heldItem);
  assert.equal(bot2.heldItem.name, 'wooden_pickaxe');
});

test('createEater — cancellation verifies zero items consumed and no active-use state', async () => {
  const bread = { name: 'bread', count: 5 };
  let deactivated = false;

  const bot = createMockBot({
    food: 12,
    items: [bread],
    consume: async () => {
      await new Promise(() => {});
    },
    deactivateItem: () => {
      deactivated = true;
    },
  });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const eatPromise = eater.eat('bread');
  setTimeout(() => manager.cancel('user_interrupted'), 50);

  const res = await eatPromise;
  assert.equal(res.outcome, 'cancelled');
  assert.equal(deactivated, true);

  // Exact inventory unchanged (5 bread remains)
  const remainingBread = bot.inventory.items().find((i) => i.name === 'bread');
  assert.equal(remainingBread.count, 5);
});

test('createEater — allows chorus_fruit when allowUnsafe=true and records position change', async () => {
  const fruit = { name: 'chorus_fruit', count: 2 };
  const bot = createMockBot({
    food: 14,
    items: [fruit],
    entity: {
      position: { x: 10, y: 64, z: 10 },
    },
    consume: async () => {
      bot.food = 18;
      bot.entity.position = { x: 14, y: 64, z: 13 }; // Teleported ~5 blocks
      bot.inventory.items = () => [{ name: 'chorus_fruit', count: 1 }];
    },
  });

  const { manager } = createMockActionManager(bot);
  const eater = createEater(bot, manager);

  const res = await eater.eat('chorus_fruit', { allowUnsafe: true });
  assert.equal(res.outcome, 'success');
  assert.ok(res.details.specialEffects);
  assert.equal(res.details.specialEffects.teleportDistance, 5);
});

test('createEater — logs effect changes or poison removal for special foods at full hunger', async () => {
  // Golden apple logs absorption and regeneration effect gains
  const gApple = { name: 'golden_apple', count: 1 };
  const bot1 = createMockBot({
    food: 20,
    foodSaturation: 10,
    items: [gApple],
    entity: {
      effects: {},
      position: { x: 0, y: 64, z: 0 },
    },
    consume: async () => {
      bot1.entity.effects = {
        22: { id: 22, name: 'absorption' },
        10: { id: 10, name: 'regeneration' },
      };
      bot1.inventory.items = () => [];
    },
  });

  const { manager: m1 } = createMockActionManager(bot1);
  const eater1 = createEater(bot1, m1);

  const res1 = await eater1.eat('golden_apple');
  assert.equal(res1.outcome, 'success');
  assert.ok(res1.details.specialEffects);
  assert.ok(res1.details.specialEffects.effectsGained.includes('absorption'));
  assert.ok(res1.details.specialEffects.effectsGained.includes('regeneration'));

  // Honey bottle removes poison effect
  const honey = { name: 'honey_bottle', count: 1 };
  const bot2 = createMockBot({
    food: 20,
    foodSaturation: 10,
    items: [honey],
    entity: {
      effects: { 19: { id: 19, name: 'poison' } },
      position: { x: 0, y: 64, z: 0 },
    },
    consume: async () => {
      bot2.entity.effects = {}; // Poison cured by honey
      bot2.inventory.items = () => [];
    },
  });

  const { manager: m2 } = createMockActionManager(bot2);
  const eater2 = createEater(bot2, m2);

  const res2 = await eater2.eat('honey_bottle');
  assert.equal(res2.outcome, 'success');
  assert.ok(res2.details.specialEffects);
  assert.equal(res2.details.specialEffects.poisonRemoved, true);
  assert.ok(res2.details.specialEffects.effectsRemoved.includes('poison'));
});

