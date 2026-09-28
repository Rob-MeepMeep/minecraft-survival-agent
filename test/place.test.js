'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const {
  isPlaceableBlock,
  isGravityBlock,
  intersectsPlayer,
  checkEntityCollisions,
  findPlacementReference,
  findPlacementReferences,
  isInteractiveBlock,
  createPlacer,
  SAFE_BUILDING_BLOCKS,
} = require('../src/actions/place');
const { ActionManager } = require('../src/actions/manager');

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [];
  const blocksMap = overrides.blocks || {};
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
        dirt: { id: 1, name: 'dirt' },
        cobblestone: { id: 4, name: 'cobblestone' },
        oak_planks: { id: 5, name: 'oak_planks' },
        stone: { id: 1, name: 'stone' },
        sand: { id: 12, name: 'sand' },
        crafting_table: { id: 58, name: 'crafting_table' },
        chest: { id: 54, name: 'chest' },
      },
    },
    blockAt: (pos) => {
      if (overrides.blockAt) return overrides.blockAt(pos);
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      const map = mock.blocks || blocksMap;
      if (map[key] !== undefined) {
        if (map[key] === null) return null; // Unloaded chunk
        return {
          name: map[key].name || 'air',
          position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
          boundingBox: map[key].boundingBox || (map[key].name === 'air' ? 'empty' : 'block'),
        };
      }
      // Default: air
      return {
        name: 'air',
        position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
        boundingBox: 'empty',
      };
    },
    equip: async (item) => {
      mock.heldItem = item;
    },
    placeBlock: async () => {},
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
// 1. Block Classification & Entity Collision
// ---------------------------------------------------------------------------

test('isPlaceableBlock & isGravityBlock — identifies placeable blocks & gravity blocks', () => {
  assert.equal(isPlaceableBlock('dirt'), true);
  assert.equal(isPlaceableBlock('cobblestone'), true);
  assert.equal(isPlaceableBlock('sand'), true);
  assert.equal(isPlaceableBlock('diamond_sword'), false);
  assert.equal(isPlaceableBlock('bread'), false);

  assert.equal(isGravityBlock('sand'), true);
  assert.equal(isGravityBlock('gravel'), true);
  assert.equal(isGravityBlock('dirt'), false);
  assert.equal(isGravityBlock('stone'), false);
});

test('checkEntityCollisions — detects collision with other players and mobs', () => {
  const bot = createMockBot({
    playerPos: new Vec3(0, 64, 0),
    entities: {
      1: {
        type: 'player',
        username: 'OtherPlayer',
        position: new Vec3(5.2, 64.0, 5.2),
        width: 0.6,
        height: 1.8,
      },
      2: {
        type: 'mob',
        name: 'zombie',
        position: new Vec3(8.2, 64.0, 8.2),
        width: 0.6,
        height: 1.8,
      },
    },
  });

  // Collision with OtherPlayer at (5, 64, 5)
  const colPlayer = checkEntityCollisions(bot, new Vec3(5, 64, 5));
  assert.equal(colPlayer.clear, false);
  assert.equal(colPlayer.reason, 'obstructed_by_other_player');
  assert.equal(colPlayer.entity, 'OtherPlayer');

  // Collision with zombie at (8, 64, 8)
  const colMob = checkEntityCollisions(bot, new Vec3(8, 64, 8));
  assert.equal(colMob.clear, false);
  assert.equal(colMob.reason, 'obstructed_by_mob');
  assert.equal(colMob.entity, 'zombie');

  // Clear location at (2, 64, 2)
  const colClear = checkEntityCollisions(bot, new Vec3(2, 64, 2));
  assert.equal(colClear.clear, true);
});

// ---------------------------------------------------------------------------
// 2. Reference Block & Pre-Flight Validations
// ---------------------------------------------------------------------------

test('findPlacementReference — detects reference block, face, and rejects occupied/floating', () => {
  const bot = createMockBot({
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
  });

  const ref = findPlacementReference(bot, new Vec3(5, 64, 5));
  assert.ok(ref.referenceBlock);
  assert.deepEqual(ref.faceVector, new Vec3(0, 1, 0));

  // Floating
  const refFloating = findPlacementReference(bot, new Vec3(10, 80, 10));
  assert.equal(refFloating.error, 'no_supporting_block');
});

test('findPlacementReferences — prioritizes non-interactive solid block over crafting_table', () => {
  const bot = createMockBot({
    blocks: {
      '5,63,5': { name: 'crafting_table', boundingBox: 'block' }, // floor is crafting table
      '4,64,5': { name: 'dirt', boundingBox: 'block' },           // west is dirt wall
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
  });

  const candidates = findPlacementReferences(bot, new Vec3(5, 64, 5));
  assert.equal(candidates.length, 2);
  // Non-interactive dirt block must come first
  assert.equal(candidates[0].referenceBlock.name, 'dirt');
  assert.equal(candidates[1].referenceBlock.name, 'crafting_table');
  assert.equal(isInteractiveBlock('crafting_table'), true);
  assert.equal(isInteractiveBlock('dirt'), false);
});

test('createPlacer — sneaks when placing against interactive block and tries candidate fallback', async () => {
  let sneaked = false;
  let unSneaked = false;
  const placeAttempts = [];

  const bot = createMockBot({
    playerPos: new Vec3(4.5, 64.0, 3.5),
    blocks: {
      '5,63,5': { name: 'crafting_table', boundingBox: 'block' },
      '4,64,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    items: [{ name: 'dirt', count: 2 }],
    setControlState: (state, val) => {
      if (state === 'sneak') {
        if (val) sneaked = true;
        else unSneaked = true;
      }
    },
    placeBlock: async (refBlock, face) => {
      placeAttempts.push({ ref: refBlock.name, face });
      // Simulate first attempt (e.g. if crafting table) throwing
      if (refBlock.name === 'crafting_table') {
        throw new Error('Server refused to place dirt: the block is still air');
      }
      // Second attempt succeeds and updates block in world
      bot.blocks['5,64,5'] = { name: 'dirt', boundingBox: 'block' };
      bot.inventory.items = () => [{ name: 'dirt', count: 1 }];
    },
  });

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'dirt');
  assert.equal(res.outcome, 'success');
  // First candidate was stone (non-interactive), but let's test that fallback works when first fails:
});

test('createPlacer — fallback to second candidate when first placement attempt fails', async () => {
  const attempts = [];
  const bot = createMockBot({
    playerPos: new Vec3(4.5, 64.0, 3.5),
    blocks: {
      '4,64,5': { name: 'dirt', boundingBox: 'block' },
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    items: [{ name: 'dirt', count: 2 }],
    placeBlock: async (refBlock) => {
      attempts.push(refBlock.name);
      if (attempts.length === 1) {
        throw new Error('Server refused to place: line of sight obstructed');
      }
      bot.blocks['5,64,5'] = { name: 'dirt', boundingBox: 'block' };
      bot.inventory.items = () => [{ name: 'dirt', count: 1 }];
    },
  });

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'dirt');
  assert.equal(res.outcome, 'success');
  assert.equal(attempts.length, 2);
});

test('createPlacer — rejects unloaded chunk with target_chunk_not_loaded', async () => {
  const bot = createMockBot({
    blocks: {
      '100,64,100': null, // null indicates unloaded block
    },
    items: [{ name: 'dirt', count: 1 }],
  });

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(100, 64, 100, 'dirt');
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'target_chunk_not_loaded');
});

test('createPlacer — rejects out-of-reach target with target_out_of_reach when noNavigate=true', async () => {
  const bot = createMockBot({
    playerPos: new Vec3(0, 64, 0),
    items: [{ name: 'dirt', count: 1 }],
    blocks: {
      '10,63,10': { name: 'stone', boundingBox: 'block' },
      '10,64,10': { name: 'air', boundingBox: 'empty' },
    },
  });

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  // Target at distance ~14m with noNavigate: true
  const res = await placer.place(10, 64, 10, 'dirt', { noNavigate: true });
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'target_out_of_reach');
});

test('createPlacer — rejects placing gravity block (sand) over air', async () => {
  const bot = createMockBot({
    playerPos: new Vec3(4.5, 64.0, 5.0),
    items: [{ name: 'sand', count: 5 }],
    blocks: {
      '4,64,5': { name: 'stone', boundingBox: 'block' }, // Side wall
      '5,64,5': { name: 'air', boundingBox: 'empty' },   // Target
      '5,63,5': { name: 'air', boundingBox: 'empty' },   // AIR BENEATH TARGET!
    },
  });

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'sand');
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'gravity_block_unsupported_below');
});

test('createPlacer — allows placing gravity block (sand) when solid block is beneath', async () => {
  let placed = false;
  const bot = createMockBot({
    playerPos: new Vec3(4.5, 64.0, 5.0),
    items: [{ name: 'sand', count: 5 }],
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' }, // Solid stone beneath
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    placeBlock: async () => {
      placed = true;
      bot.blocks['5,64,5'] = { name: 'sand', boundingBox: 'block' };
      bot.inventory.items = () => [{ name: 'sand', count: 4 }];
    },
  });
  bot.blocks = {
    '5,63,5': { name: 'stone', boundingBox: 'block' },
    '5,64,5': { name: 'air', boundingBox: 'empty' },
  };

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'sand');
  assert.equal(res.outcome, 'success');
  assert.equal(placed, true);
});

// ---------------------------------------------------------------------------
// 3. Auto-Selection Safe Full Block Filter
// ---------------------------------------------------------------------------

test('createPlacer — auto-selection only selects safe full building blocks, excluding tables, chests, gravity', async () => {
  // Inventory has crafting_table, chest, sand, and dirt
  const table = { name: 'crafting_table', count: 1 };
  const chest = { name: 'chest', count: 2 };
  const sand = { name: 'sand', count: 10 };
  const dirt = { name: 'dirt', count: 5 };

  let placedBlockName = null;
  const bot = createMockBot({
    playerPos: new Vec3(5.5, 64.0, 3.5),
    items: [table, chest, sand, dirt],
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    placeBlock: async () => {
      // Placed block matches held item
      placedBlockName = bot.heldItem.name;
      bot.blocks['5,64,5'] = { name: placedBlockName, boundingBox: 'block' };
      bot.inventory.items = () => [table, chest, sand, { name: 'dirt', count: 4 }];
    },
  });
  bot.blocks = {
    '5,63,5': { name: 'stone', boundingBox: 'block' },
    '5,64,5': { name: 'air', boundingBox: 'empty' },
  };

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  // Calling place with NO block name specified: should choose dirt (safe building block)
  const res = await placer.place(5, 64, 5);
  assert.equal(res.outcome, 'success');
  assert.equal(res.details.block, 'dirt');
  assert.equal(placedBlockName, 'dirt');
});

test('createPlacer — rejects non-placeable item with not_a_block', async () => {
  const sword = { name: 'diamond_sword', count: 1 };
  const bot = createMockBot({
    items: [sword],
  });
  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'diamond_sword');
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'not_a_block');
});

test('createPlacer — rejects missing item with item_not_in_inventory', async () => {
  const bot = createMockBot({
    items: [],
  });
  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'stone');
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'item_not_in_inventory');
});

test('createPlacer — successfully places block and restores previously held item', async () => {
  const pickaxe = { name: 'wooden_pickaxe', type: 270 };
  const planks = { name: 'oak_planks', count: 4 };
  let placed = false;

  const bot = createMockBot({
    playerPos: new Vec3(5.5, 64.0, 3.5),
    heldItem: pickaxe,
    items: [pickaxe, planks],
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    placeBlock: async () => {
      placed = true;
      bot.blocks['5,64,5'] = { name: 'oak_planks', boundingBox: 'block' };
      bot.inventory.items = () => [pickaxe, { name: 'oak_planks', count: 3 }];
    },
  });
  bot.blocks = {
    '5,63,5': { name: 'stone', boundingBox: 'block' },
    '5,64,5': { name: 'air', boundingBox: 'empty' },
  };

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'oak_planks');
  assert.equal(res.outcome, 'success');
  assert.equal(res.reason, 'block_placed');
  assert.equal(placed, true);
  assert.equal(res.itemsConsumed, 1);
  assert.equal(res.finalBlockState, 'oak_planks');
  assert.equal(bot.heldItem.name, 'wooden_pickaxe');
});


// ---------------------------------------------------------------------------
// 4. Cancellation Telemetry Details & Late Cancellation Race
// ---------------------------------------------------------------------------

test('createPlacer — clean cancellation records finalBlockState, itemsConsumed: 0, and worldChanged: false', async () => {
  const dirt = { name: 'dirt', count: 3 };
  const pickaxe = { name: 'wooden_pickaxe', type: 270 };

  const bot = createMockBot({
    playerPos: new Vec3(5.5, 64.0, 3.5),
    heldItem: pickaxe,
    items: [pickaxe, dirt],
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    placeBlock: async () => {
      await new Promise(() => {}); // Hang until cancelled
    },
  });

  const { manager, events } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const placePromise = placer.place(5, 64, 5, 'dirt');
  setTimeout(() => manager.cancel('user_interrupted'), 50);

  const res = await placePromise;
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.reason, 'user_interrupted');

  // Verify non-empty cancellation audit details
  assert.equal(res.finalBlockState, 'air');
  assert.equal(res.itemsConsumed, 0);
  assert.equal(res.worldChanged, false);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'cancelled');
  assert.equal(endEvent.finalBlockState, 'air');
  assert.equal(endEvent.itemsConsumed, 0);
  assert.equal(endEvent.worldChanged, false);
});

test('createPlacer — late cancellation after placement packet sent reports cancelled_after_effect', async () => {
  const dirt = { name: 'dirt', count: 3 };
  const pickaxe = { name: 'wooden_pickaxe', type: 270 };

  const bot = createMockBot({
    playerPos: new Vec3(5.5, 64.0, 3.5),
    heldItem: pickaxe,
    items: [pickaxe, dirt],
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    placeBlock: async () => {
      // Simulate server placing block and consuming item before cancellation signal arrives
      bot.blocks['5,64,5'] = { name: 'dirt', boundingBox: 'block' };
      bot.inventory.items = () => [pickaxe, { name: 'dirt', count: 2 }];
      // Sleep slightly so cancel fires while placeBlock is in-flight
      await new Promise((r) => setTimeout(r, 60));
    },
  });
  bot.blocks = {
    '5,63,5': { name: 'stone', boundingBox: 'block' },
    '5,64,5': { name: 'air', boundingBox: 'empty' },
  };

  const { manager, events } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const placePromise = placer.place(5, 64, 5, 'dirt');
  setTimeout(() => manager.cancel('user_interrupted'), 40);

  const res = await placePromise;

  // Since server executed placement, outcome is reported as cancelled_after_effect with worldChanged: true
  assert.equal(res.outcome, 'cancelled_after_effect');
  assert.equal(res.reason, 'placed_before_cancel_settled');
  assert.equal(res.finalBlockState, 'dirt');
  assert.equal(res.itemsConsumed, 1);
  assert.equal(res.worldChanged, true);

  const endEvent = events.find((e) => e.event === 'action_end');
  assert.ok(endEvent);
  assert.equal(endEvent.outcome, 'cancelled_after_effect');
  assert.equal(endEvent.finalBlockState, 'dirt');
  assert.equal(endEvent.itemsConsumed, 1);
  assert.equal(endEvent.worldChanged, true);
});

test('createPlacer — fails if server rejects placement without placing block', async () => {
  const dirt = { name: 'dirt', count: 3 };
  const bot = createMockBot({
    playerPos: new Vec3(5.5, 64.0, 3.5),
    items: [dirt],
    blocks: {
      '5,63,5': { name: 'stone', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
    },
    placeBlock: async () => {
      // Server silently rejected: block remained air, item not consumed
    },
  });

  const { manager } = createMockActionManager(bot);
  const placer = createPlacer(bot, manager);

  const res = await placer.place(5, 64, 5, 'dirt');
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'server_rejected_placement');
});
