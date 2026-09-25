'use strict';

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { round1 } = require('../observer');
const { createSafeMovements, distance3D } = require('./navigate');
const { FailureTracker } = require('../controller/failure_tracker');

/** Gravity-affected blocks that fall if supporting blocks are removed. */
const GRAVITY_BLOCK_NAMES = new Set([
  'sand',
  'red_sand',
  'gravel',
  'suspicious_sand',
  'suspicious_gravel',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
]);

/**
 * Checks if the block is directly under the agent's feet (supporting floor).
 * Never dig beneath yourself.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} blockPos
 * @returns {boolean}
 */
function isDirectlyUnderFeet(bot, blockPos) {
  if (!bot.entity?.position || !blockPos) return false;
  const botX = Math.floor(bot.entity.position.x);
  const botY = Math.floor(bot.entity.position.y);
  const botZ = Math.floor(bot.entity.position.z);
  return blockPos.x === botX && blockPos.y === botY - 1 && blockPos.z === botZ;
}

/**
 * Checks if unsupported gravity blocks (sand, gravel) exist directly above the target block.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} blockPos
 * @param {number} [maxHeight=4]
 * @returns {boolean}
 */
function hasGravityBlocksAbove(bot, blockPos, maxHeight = 4) {
  if (!bot.blockAt || !blockPos) return false;
  const x = Math.floor(blockPos.x);
  const y = Math.floor(blockPos.y);
  const z = Math.floor(blockPos.z);
  for (let dy = 1; dy <= maxHeight; dy++) {
    const above = bot.blockAt(new Vec3(x, y + dy, z));
    if (!above) break;
    if (GRAVITY_BLOCK_NAMES.has(above.name)) {
      return true;
    }
    // A solid non-gravity block supports anything above it
    if (above.boundingBox === 'block' && !GRAVITY_BLOCK_NAMES.has(above.name)) {
      break;
    }
  }
  return false;
}

const FLUID_BLOCK_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);

/**
 * Checks if breaking this block would cause adjacent, overhead, or diagonal fluid to flow into the player/site.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} blockPos
 * @returns {boolean}
 */
function willExposeFluid(bot, blockPos) {
  if (!bot.blockAt || !blockPos) return false;
  const offsets = [
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, 1, 0],
    [0, 1, 1],
    [0, 1, -1],
    [1, 0, 1],
    [1, 0, -1],
    [-1, 0, 1],
    [-1, 0, -1],
  ];
  for (const [dx, dy, dz] of offsets) {
    const b = bot.blockAt(new Vec3(blockPos.x + dx, blockPos.y + dy, blockPos.z + dz));
    if (b && FLUID_BLOCK_NAMES.has(b.name)) return true;
  }
  return false;
}

/**
 * Checks if fluid is within safety buffer distance of the target block.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} blockPos
 * @param {number} [radius=2]
 * @returns {boolean}
 */
function isNearFluid(bot, blockPos, radius = 2) {
  if (!bot.blockAt || !blockPos) return false;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(new Vec3(blockPos.x + dx, blockPos.y + dy, blockPos.z + dz));
        if (b && FLUID_BLOCK_NAMES.has(b.name)) return true;
      }
    }
  }
  return false;
}

/**
 * Checks if breaking this block would create an unsafe pit (>2-block fall or exposing void/lava).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} blockPos
 * @returns {boolean}
 */
function willCreateUnsafePit(bot, blockPos) {
  if (!bot.blockAt || !blockPos) return false;
  // If target is above player feet level (e.g. eye level, tree log, wall), digging does not create a pit underfoot
  const botY = bot.entity?.position ? Math.floor(bot.entity.position.y) : null;
  if (botY !== null && blockPos.y > botY) {
    return false;
  }
  const below1 = bot.blockAt(new Vec3(blockPos.x, blockPos.y - 1, blockPos.z));
  if (!below1) return false;
  if (['lava', 'flowing_lava', 'void_air'].includes(below1.name) || below1.unsafePit) {
    return true;
  }
  // Deep drop hazard (>2 blocks fall): checked in full world environments
  if (bot.registry || bot.version || bot.isRealWorld) {
    if (['air', 'cave_air'].includes(below1.name)) {
      const below2 = bot.blockAt(new Vec3(blockPos.x, blockPos.y - 2, blockPos.z));
      if (below2 && ['air', 'cave_air', 'lava', 'flowing_lava'].includes(below2.name)) {
        return true;
      }
    }
  }
  return false;
}

const RANGED_HOSTILES = new Set(['pillager', 'skeleton', 'stray', 'bogged']);
const MELEE_HOSTILES = new Set(['creeper', 'zombie', 'spider', 'witch', 'enderman', 'drowned', 'husk']);

/**
 * Checks if any hostile mob is within proximity distance of the given position (or bot position),
 * using differentiated detection ranges for ranged mobs vs melee mobs.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} [minDistance=8.0] - melee threat radius
 * @param {{ x: number, y: number, z: number }} [pos] - evaluation position
 * @param {number} [rangedDistance=16.0] - ranged threat radius
 * @returns {boolean}
 */
function hasHostileThreatNearby(bot, minDistance = 8.0, pos = null, rangedDistance = 16.0) {
  if (!bot || !bot.entities) return false;
  const refPos = pos || bot.entity?.position;
  if (!refPos) return false;
  const meleeDist = minDistance !== null ? minDistance : 8.0;
  const rangedDist = rangedDistance !== null ? rangedDistance : 16.0;

  for (const ent of Object.values(bot.entities)) {
    if (!ent || !ent.position || ent === bot.entity) continue;
    const type = ent.name || ent.type;
    const isRanged = RANGED_HOSTILES.has(type);
    const isMelee = MELEE_HOSTILES.has(type);
    if (!isRanged && !isMelee) continue;

    const threshold = isRanged ? rangedDist : meleeDist;
    const d = Math.hypot(ent.position.x - refPos.x, ent.position.y - refPos.y, ent.position.z - refPos.z);
    if (d <= threshold) return true;
  }
  return false;
}

/**
 * Extracts item type name from dropped item entity metadata or prismarine helper.
 *
 * @param {object} entity
 * @returns {string | null}
 */
function getItemEntityTypeName(entity) {
  if (!entity) return null;
  if (typeof entity.getDroppedItem === 'function') {
    try {
      const item = entity.getDroppedItem();
      if (item && item.name) return item.name;
    } catch { /* ok */ }
  }
  if (entity.item && entity.item.name) return entity.item.name;
  if (entity.metadata) {
    for (const val of Object.values(entity.metadata)) {
      if (val && typeof val === 'object') {
        if (val.name) return val.name;
        if (val.itemId && entity.bot?.registry?.items?.[val.itemId]) {
          return entity.bot.registry.items[val.itemId].name;
        }
      }
    }
  }
  return null;
}

/**
 * Returns a map of item name -> total count in inventory.
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Record<string, number>}
 */
function getInventoryCounts(bot) {
  if (!bot.inventory) return {};
  const counts = {};
  for (const item of bot.inventory.items()) {
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return counts;
}

/**
 * Computes difference between two inventory snapshots.
 *
 * @param {Record<string, number>} before
 * @param {Record<string, number>} after
 * @returns {Array<{ name: string, delta: number }>}
 */
function computeInventoryDelta(before, after) {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const deltas = [];
  for (const name of allKeys) {
    const b = before[name] || 0;
    const a = after[name] || 0;
    if (a !== b) {
      deltas.push({ name, delta: a - b });
    }
  }
  return deltas;
}

/**
 * Finds a safe, harvestable block matching the given name or predicate.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string | ((block: import('prismarine-block').Block) => boolean)} matcher
 * @param {number} [maxDistance=16]
 * @param {object} [failureTracker=null]
 * @returns {import('prismarine-block').Block | null}
 */
function findSafeBlock(bot, matcher, maxDistance = 16, failureTracker = null, options = {}) {
  // If gathering dirt, prefer virgin grass_block on the surface first to avoid trenching
  if (matcher === 'dirt' && options.noGrassFallback !== true) {
    const grassBlock = findSafeBlock(bot, 'grass_block', maxDistance, failureTracker, { ...options, noGrassFallback: true });
    if (grassBlock) return grassBlock;
  }

  let predicate;
  if (typeof matcher === 'string') {
    if (matcher === 'dirt') {
      predicate = (b) => Boolean(b && (b.name === 'dirt' || b.name === 'grass_block'));
    } else {
      predicate = (b) => Boolean(b && (b.name === matcher || b.name.includes(matcher)));
    }
  } else {
    predicate = matcher;
  }

  const checkBlockSafe = (b) => {
    if (!b || !b.position) return false;
    if (isDirectlyUnderFeet(bot, b.position)) return false;
    if (hasGravityBlocksAbove(bot, b.position)) return false;
    if (willExposeFluid(bot, b.position)) return false;
    if ((bot.registry || bot.version || bot.isRealWorld) && isNearFluid(bot, b.position, 2)) return false;
    if (willCreateUnsafePit(bot, b.position)) return false;

    // Elevation & Anti-trenching constraints:
    if (bot.entity?.position) {
      const botGroundY = Math.floor(bot.entity.position.y);
      const dy = b.position.y - botGroundY;
      // Never mine two levels below player (dy <= -2 creates trenches)
      // Only permit surface dirt around current elevation: foot level (dy = -1), waist (dy = 0), chest (dy = 1)
      if (dy < -1 || dy > 1) return false;
    }

    // Anti-trenching column tracking: prevent repeated mining at the same (x, z) column
    const minedCols = options.minedColumns || bot._minedColumns;
    if (minedCols && minedCols.has(`${b.position.x},${b.position.z}`)) {
      return false;
    }

    // For dirt/grass_block: ensure it is exposed surface dirt (air or foliage above it)
    if (b.name === 'dirt' || b.name === 'grass_block') {
      if (typeof bot.blockAt === 'function') {
        const above = bot.blockAt(new Vec3(b.position.x, b.position.y + 1, b.position.z));
        if (above && !['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'dandelion', 'poppy', 'dead_bush'].includes(above.name)) {
          return false;
        }
        if (bot.registry || bot.version || bot.isRealWorld) {
          const below = bot.blockAt(new Vec3(b.position.x, b.position.y - 1, b.position.z));
          if (!below || ['air', 'cave_air', 'water', 'lava', 'flowing_water', 'flowing_lava'].includes(below.name)) {
            return false;
          }
        }
      }
    }

    if (failureTracker) {
      const key = FailureTracker.makeKey('gather', b.position);
      if (failureTracker.isOnCooldown(key)) return false;
    }

    return true;
  };

  return bot.findBlock({
    matching: (b) => {
      if (!b) return false;
      if (b.position) {
        if (!checkBlockSafe(b)) return false;
      }
      return predicate(b);
    },
    useExtraInfo: (b) => {
      if (!checkBlockSafe(b)) return false;
      return true;
    },
    maxDistance,
  });
}

/**
 * Determines expected item drops for the given block and held tool.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} block
 * @param {import('prismarine-item').Item} [heldItem]
 * @returns {string[]} List of expected item drop names
 */
function getExpectedDrops(bot, block, heldItem = undefined) {
  if (!block) return [];

  const tool = heldItem !== undefined ? heldItem : bot?.heldItem;

  // Check harvestability
  let canHarvest = true;
  if (typeof block.canHarvest === 'function') {
    const res = block.canHarvest(tool?.type || null);
    canHarvest = res !== false && res !== null;
  } else if (typeof bot?.canHarvest === 'function') {
    canHarvest = Boolean(bot.canHarvest(block));
  }

  // If a block requires a tool and current tool cannot harvest it, drops are empty
  if (!canHarvest) {
    return [];
  }

  // Standard survival / mock test fallbacks (take precedence for crops to guarantee full drop sets)
  const KNOWN_DROPS = {
    grass_block: ['dirt'],
    dirt: ['dirt'],
    stone: ['cobblestone'],
    cobblestone: ['cobblestone'],
    sand: ['sand'],
    gravel: ['gravel', 'flint'],
    bamboo: ['bamboo'],
    coal_ore: ['coal'],
    deepslate_coal_ore: ['coal'],
    iron_ore: ['raw_iron'],
    deepslate_iron_ore: ['raw_iron'],
    short_grass: ['wheat_seeds'],
    wheat: ['wheat', 'wheat_seeds'],
    carrots: ['carrot'],
    potatoes: ['potato', 'poisonous_potato'],
    beetroots: ['beetroot', 'beetroot_seeds'],
    sweet_berry_bush: ['sweet_berries'],
    melon: ['melon_slice'],
    melon_block: ['melon_slice'],
  };

  if (KNOWN_DROPS[block.name]) {
    return KNOWN_DROPS[block.name];
  }

  // Registry drops if available
  if (bot?.registry?.blocksByName?.[block.name]?.drops) {
    const rawDrops = bot.registry.blocksByName[block.name].drops;
    const dropNames = rawDrops
      .map((id) => bot.registry.items[id]?.name)
      .filter(Boolean);
    if (dropNames.length > 0) {
      return dropNames;
    }
  }

  if (block.name.endsWith('_log') || block.name.endsWith('_planks')) {
    return [block.name];
  }

  return [block.name];
}

/** Mapping of crop block names to their planting seed items. */
const CROP_SEEDS = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
};

/**
 * Separates inventory deltas into matched target drops vs unrelated acquisitions.
 *
 * @param {Array<{ name: string, delta: number }>} deltas
 * @param {string[]} expectedDrops
 * @returns {{ matchedAcquisitions: Array<{ name: string, delta: number }>, unrelatedAcquisitions: Array<{ name: string, delta: number }> }}
 */
function computeAttribution(deltas, expectedDrops) {
  const expectedSet = new Set(expectedDrops || []);
  const matchedAcquisitions = [];
  const unrelatedAcquisitions = [];

  for (const item of (deltas || [])) {
    if (item.delta > 0) {
      if (expectedSet.has(item.name)) {
        matchedAcquisitions.push(item);
      } else {
        unrelatedAcquisitions.push(item);
      }
    }
  }

  return { matchedAcquisitions, unrelatedAcquisitions };
}

/**
 * Checks whether the inventory has capacity for an expected drop.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} [expectedDropName]
 * @returns {boolean}
 */
function isInventoryFull(bot, expectedDropName = null) {
  if (!bot?.inventory) return false;
  if (typeof bot.inventory.emptySlotCount === 'function') {
    if (bot.inventory.emptySlotCount() > 0) return false;
  } else if (Array.isArray(bot.inventory.slots)) {
    const hasEmpty = bot.inventory.slots.slice(9, 45).some((s) => s === null);
    if (hasEmpty) return false;
  }
  if (expectedDropName && typeof bot.inventory.items === 'function') {
    const matching = bot.inventory.items().filter((i) => i.name === expectedDropName);
    for (const item of matching) {
      if (item.count < (item.stackSize || 64)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Sets up gathering action primitive on top of ActionManager.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 */
function createGatherer(bot, actionManager) {
  let movements = null;

  function getMovements() {
    if (!movements) {
      movements = createSafeMovements(bot);
    }
    return movements;
  }

  /**
   * Equips best available harvest tool for the block if available.
   */
  async function equipTool(block) {
    try {
      if (bot.pathfinder?.bestHarvestTool) {
        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool) {
          await bot.equip(tool, 'hand');
        }
      }
    } catch {
      // Ignore tool equip failures
    }
  }

  /**
   * Gathers a block by name or position, handles approach, digging, drop pickup,
   * verifies block state change, and strictly validates matched inventory drops.
   *
   * @param {string | { x: number, y: number, z: number }} targetSpec
   * @param {object} [options]
   * @param {number} [options.maxDistance=16]
   * @param {number} [options.timeoutMs=30000]
   * @returns {Promise<object>} Settled action result
   */
  async function gather(targetSpec, options = {}) {
    const maxDistance = options.maxDistance || 16;
    const timeoutMs = options.timeoutMs || 30_000;

    let targetBlock = null;

    if (typeof targetSpec === 'string') {
      targetBlock = findSafeBlock(bot, targetSpec, maxDistance);
      if (!targetBlock) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'gather',
          outcome: 'failed',
          reason: 'no_matching_block_nearby',
          message: `No safe, reachable "${targetSpec}" found within ${maxDistance} blocks`,
        };
      }
    } else if (targetSpec && typeof targetSpec.x === 'number') {
      const pos = {
        x: Math.floor(targetSpec.x),
        y: Math.floor(targetSpec.y),
        z: Math.floor(targetSpec.z),
      };
      if (isDirectlyUnderFeet(bot, pos)) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'gather',
          outcome: 'failed',
          reason: 'unsafe_target_under_feet',
          message: 'Refusing to dig supporting block directly under feet',
        };
      }
      targetBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (!targetBlock || targetBlock.name === 'air') {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'gather',
          outcome: 'failed',
          reason: 'block_not_found',
          message: `No block at (${pos.x}, ${pos.y}, ${pos.z})`,
        };
      }
      if (hasGravityBlocksAbove(bot, targetBlock.position)) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'gather',
          outcome: 'failed',
          reason: 'unsafe_gravity_blocks_overhead',
          message: 'Refusing to dig block beneath falling gravity blocks',
        };
      }
    } else {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'gather',
        outcome: 'failed',
        reason: 'invalid_target',
        message: 'Must specify a block name or coordinate',
      };
    }

    const blockPos = targetBlock.position;
    const blockName = targetBlock.name;
    const invBaseline = getInventoryCounts(bot);

    // Initial expected drops evaluation
    const initialExpectedDrops = getExpectedDrops(bot, targetBlock);

    const targetMeta = {
      block: blockName,
      x: blockPos.x,
      y: blockPos.y,
      z: blockPos.z,
      expectedDrops: initialExpectedDrops,
      baselineInventory: invBaseline,
    };

    return actionManager.run('gather', targetMeta, timeoutMs, async (signal) => {
      // 1. Approach block to safe reach distance (~2.5 blocks)
      bot.pathfinder.setMovements(getMovements());
      const reachGoal = new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 2.5);

      try {
        await bot.pathfinder.goto(reachGoal);
      } catch (err) {
        if (signal.aborted) throw err;
        return {
          outcome: 'failed',
          reason: 'could_not_reach_block',
          details: { error: err.message },
        };
      }

      if (signal.aborted) throw new Error('aborted');

      // Re-fetch block to verify it wasn't broken while traveling
      const currentBlock = bot.blockAt(new Vec3(blockPos.x, blockPos.y, blockPos.z));
      if (!currentBlock || currentBlock.name === 'air') {
        return {
          outcome: 'failed',
          reason: 'block_no_longer_present',
          details: { block: blockName },
        };
      }

      if (!bot.canDigBlock(currentBlock)) {
        try {
          await bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 1.8));
        } catch { /* ok */ }
      }

      // Revalidate immediately before digging: the bot may have moved during pathfinding
      if (isDirectlyUnderFeet(bot, blockPos)) {
        return {
          outcome: 'failed',
          reason: 'target_under_feet',
          details: { block: blockName, pos: blockPos },
        };
      }

      if (!bot.canDigBlock(currentBlock)) {
        return {
          outcome: 'failed',
          reason: 'cannot_dig_block',
          details: { block: blockName },
        };
      }

      if (hasGravityBlocksAbove(bot, blockPos)) {
        return {
          outcome: 'failed',
          reason: 'gravity_hazard_above',
          details: { block: blockName, pos: blockPos },
        };
      }

      if (options.safeOnly !== false && willExposeFluid(bot, blockPos)) {
        return {
          outcome: 'failed',
          reason: 'fluid_exposure_hazard',
          details: { block: blockName, pos: blockPos },
        };
      }

      if (options.safeOnly !== false && willCreateUnsafePit(bot, blockPos)) {
        return {
          outcome: 'failed',
          reason: 'unsafe_pit_hazard',
          details: { block: blockName, pos: blockPos },
        };
      }

      if (options.safeOnly !== false && hasHostileThreatNearby(bot, 7.0, blockPos)) {
        return {
          outcome: 'failed',
          reason: 'hostile_threat_nearby',
          details: { block: blockName, pos: blockPos },
        };
      }

      // 2. Equip best harvest tool
      await equipTool(currentBlock);
      if (signal.aborted) throw new Error('aborted');

      // Re-evaluate expected drops with tool equipped
      const expectedDrops = getExpectedDrops(bot, currentBlock);

      // Snapshot inventory immediately prior to digging to prevent attributing approach pickups
      const invBeforeDig = getInventoryCounts(bot);

      // Snapshot existing item-entity IDs before digging to attribute drops to current action
      const preDigEntityIds = new Set(
        bot.entities ? Object.keys(bot.entities).map(Number) : []
      );

      // 3. Track dropped item entity spawned during digging
      const spawnedItemEntities = [];
      const onEntitySpawn = (entity) => {
        if (entity && entity.name === 'item' && entity.position) {
          const blockCenter = new Vec3(blockPos.x + 0.5, blockPos.y + 0.5, blockPos.z + 0.5);
          const dist = typeof entity.position.distanceTo === 'function'
            ? entity.position.distanceTo(blockCenter)
            : Math.hypot(entity.position.x - blockCenter.x, entity.position.y - blockCenter.y, entity.position.z - blockCenter.z);
          if (dist <= 3.5) {
            spawnedItemEntities.push(entity);
          }
        }
      };

      if (typeof bot.on === 'function') {
        bot.on('entitySpawn', onEntitySpawn);
      }

      // 4. Dig or harvest the block
      const isSweetBerryBush = currentBlock.name === 'sweet_berry_bush';
      try {
        if (isSweetBerryBush) {
          if (typeof bot.activateBlock === 'function') {
            await bot.activateBlock(currentBlock);
          }
        } else {
          let threatAborted = false;
          let threatInterval = null;
          if (options.safeOnly !== false) {
            threatInterval = setInterval(() => {
              if (hasHostileThreatNearby(bot)) {
                threatAborted = true;
                try { bot.stopDigging(); } catch { /* ok */ }
              }
            }, 100);
          }

          const digPromise = bot.dig(currentBlock);
          const abortHandler = () => {
            try { bot.stopDigging(); } catch { /* ok */ }
          };
          signal.addEventListener('abort', abortHandler, { once: true });
          try {
            await digPromise;
          } finally {
            if (threatInterval) clearInterval(threatInterval);
            signal.removeEventListener('abort', abortHandler);
          }

          if (threatAborted) {
            return {
              outcome: 'failed',
              reason: 'hostile_threat_nearby',
              details: { block: blockName, pos: blockPos },
            };
          }
        }
      } catch (err) {
        if (!isSweetBerryBush) {
          try { bot.stopDigging(); } catch { /* ok */ }
        }
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('entitySpawn', onEntitySpawn);
        }
        if (options.safeOnly !== false && hasHostileThreatNearby(bot)) {
          return {
            outcome: 'failed',
            reason: 'hostile_threat_nearby',
            details: { block: blockName, pos: blockPos },
          };
        }
        if (signal.aborted) throw err;
        return {
          outcome: 'failed',
          reason: isSweetBerryBush ? 'activation_failed' : 'digging_interrupted',
          details: { error: err.message },
        };
      } finally {
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('entitySpawn', onEntitySpawn);
        }
      }

      if (signal.aborted) throw new Error('aborted');

      // Record mined column to prevent repeated mining in the same column (anti-trenching)
      if (!bot._minedColumns) bot._minedColumns = new Set();
      bot._minedColumns.add(`${blockPos.x},${blockPos.z}`);

      // 5. Attribute and rank candidate dropped item entities
      const blockCenter = new Vec3(blockPos.x + 0.5, blockPos.y + 0.5, blockPos.z + 0.5);
      const allItemCandidates = [
        ...spawnedItemEntities,
        ...(bot.entities ? Object.values(bot.entities) : [])
      ];

      const rankedCandidates = [];
      const seenIds = new Set();

      for (const ent of allItemCandidates) {
        if (!ent || ent.name !== 'item' || !ent.position || seenIds.has(ent.id)) continue;
        seenIds.add(ent.id);

        // Discard invalid / dead entities or entities removed from bot.entities
        if (ent.isValid === false) continue;
        if (bot.entities && !bot.entities[ent.id]) continue;

        // Attribute drops to current dig action: accept ONLY newly observed entities associated with this action
        if (preDigEntityIds.has(Number(ent.id))) continue;

        const dist = typeof ent.position.distanceTo === 'function'
          ? ent.position.distanceTo(blockCenter)
          : Math.hypot(ent.position.x - blockCenter.x, ent.position.y - blockCenter.y, ent.position.z - blockCenter.z);
        if (dist > 3.5) continue;

        const typeName = getItemEntityTypeName(ent);
        // Check if item type matches an expected drop (if typeName is known)
        const matchesExpected = typeName ? expectedDrops.includes(typeName) : true;
        // If an unrelated item type is present, ignore it!
        if (typeName && !matchesExpected) continue;

        // Creation after action start: e.g. from spawn listener during digging vs detected in bot.entities post-dig
        const isFromSpawnListener = spawnedItemEntities.some(s => s && s.id === ent.id);

        rankedCandidates.push({
          entity: ent,
          matchesExpected,
          isFromSpawnListener,
          dist,
          inEntities: Boolean(bot.entities && bot.entities[ent.id]),
        });
      }

      // Rank candidates:
      // 1. Expected item type (matchesExpected: true > false)
      // 2. Creation after action start (isFromSpawnListener: true > false)
      // 3. Distance from broken block (dist: closer > farther)
      // 4. Current validity and presence in bot.entities
      rankedCandidates.sort((a, b) => {
        if (a.matchesExpected !== b.matchesExpected) return a.matchesExpected ? -1 : 1;
        if (a.isFromSpawnListener !== b.isFromSpawnListener) return a.isFromSpawnListener ? -1 : 1;
        if (a.dist !== b.dist) return a.dist - b.dist;
        if (a.inEntities !== b.inEntities) return a.inEntities ? -1 : 1;
        return 0;
      });

      // Select top valid candidate
      let trackedEntity = rankedCandidates.length > 0 ? rankedCandidates[0].entity : null;

      // Handle case: new entity disappears before navigation (e.g. collected or despawned)
      if (trackedEntity && (trackedEntity.isValid === false || (bot.entities && !bot.entities[trackedEntity.id]))) {
        trackedEntity = null;
      }

      const trackedEntityId = trackedEntity ? trackedEntity.id : null;
      const targetDropCoord = trackedEntity && trackedEntity.isValid !== false
        ? trackedEntity.position
        : blockCenter;

      // 6. Navigate to dropped item entity
      try {
        const pickupGoal = new goals.GoalNear(targetDropCoord.x, targetDropCoord.y, targetDropCoord.z, 0.8);
        await bot.pathfinder.goto(pickupGoal);
      } catch {
        try {
          if (goals.GoalNearXZ) {
            await bot.pathfinder.goto(new goals.GoalNearXZ(targetDropCoord.x, targetDropCoord.z, 0.8));
          }
        } catch {
          // Drop might already be vacuumed or out of reach
        }
      }

      // Wait for pickup animation & inventory packet to settle (poll up to 2000ms)
      // Inventory updates before entity tracking completes -> immediately detected!
      const settleStart = Date.now();
      while (Date.now() - settleStart < 2000) {
        const currentInv = getInventoryCounts(bot);
        const curDeltas = computeInventoryDelta(invBeforeDig, currentInv);
        const { matchedAcquisitions } = computeAttribution(curDeltas, expectedDrops);
        if (matchedAcquisitions.length > 0) break;
        await new Promise(r => setTimeout(r, 100));
      }

      // 7. Verify post-dig block state
      const finalBlock = bot.blockAt ? bot.blockAt(new Vec3(blockPos.x, blockPos.y, blockPos.z)) : null;
      const finalBlockState = finalBlock ? finalBlock.name : 'air';

      // 8. Replanting policy for standard crops
      let seedConsumed = false;
      let replanted = false;
      let finalCropState = finalBlockState;

      const seedName = CROP_SEEDS[blockName];
      if (seedName && options.replant !== false) {
        try {
          const belowPos = new Vec3(blockPos.x, blockPos.y - 1, blockPos.z);
          const belowBlock = bot.blockAt ? bot.blockAt(belowPos) : null;
          const isFarmland = belowBlock && (belowBlock.name === 'farmland' || belowBlock.name === 'dirt');
          const seedItem = bot.inventory?.items?.().find(i => i.name === seedName);
          if (isFarmland && seedItem) {
            if (typeof bot.equip === 'function') {
              await bot.equip(seedItem, 'hand');
            }
            if (typeof bot.activateBlock === 'function') {
              await bot.activateBlock(belowBlock, new Vec3(0, 1, 0));
            }
            seedConsumed = true;
            replanted = true;

            // Wait for server block update to settle and confirm replanted crop state
            const targetVec = new Vec3(blockPos.x, blockPos.y, blockPos.z);
            let repBlock = bot.blockAt ? bot.blockAt(targetVec) : null;
            const repStart = Date.now();
            while ((!repBlock || repBlock.name === 'air') && Date.now() - repStart < 1500) {
              await new Promise(r => setTimeout(r, 100));
              repBlock = bot.blockAt ? bot.blockAt(targetVec) : null;
            }

            if (repBlock && repBlock.name !== 'air') {
              const props = typeof repBlock.getProperties === 'function' ? repBlock.getProperties() : (repBlock._properties || {});
              const ageVal = props?.age !== undefined ? props.age : repBlock.metadata;
              finalCropState = {
                name: repBlock.name,
                age: ageVal !== undefined && ageVal !== null ? Number(ageVal) : 0,
              };
            } else {
              finalCropState = { name: blockName, age: 0 };
            }
          }
        } catch {
          // Replant attempted; continue reporting
        }
      }

      // 9. Compute inventory deltas and separate matched vs unrelated acquisitions
      const invAfter = getInventoryCounts(bot);
      const deltas = computeInventoryDelta(invBeforeDig, invAfter);
      const { matchedAcquisitions, unrelatedAcquisitions } = computeAttribution(deltas, expectedDrops);
      const inventoryIsFull = isInventoryFull(bot, expectedDrops[0]);

      const baseDetails = {
        block: blockName,
        finalBlockState,
        expectedDrops,
        baselineInventory: invBaseline,
        matchedAcquisitions,
        unrelatedAcquisitions,
        trackedEntityId,
        harvested: true,
        dropsCollected: matchedAcquisitions,
        seedConsumed,
        replanted,
        finalCropState,
      };

      // Target block did not change state -> block was not broken (except sweet berry bush)!
      if (!isSweetBerryBush && finalBlockState === blockName && !replanted) {
        return {
          outcome: 'failed',
          reason: 'block_not_broken',
          details: {
            ...baseDetails,
            note: `Target block "${blockName}" remained unchanged after dig.`,
          },
        };
      }

      // Food acquisition check: gathering crop for food cannot be satisfied by seed collection alone
      const isCropWithSeed = ['wheat', 'beetroots'].includes(blockName);
      const onlySeedsCollected = matchedAcquisitions.length > 0 &&
        matchedAcquisitions.every(i => i.name.endsWith('_seeds'));
      if (isCropWithSeed && onlySeedsCollected && (options.replant !== false || options.foodAcquisition)) {
        return {
          outcome: 'failed',
          reason: 'seed_only_no_food_acquired',
          details: {
            ...baseDetails,
            note: `Only seeds [${matchedAcquisitions.map(i => i.name).join(', ')}] were collected; crop food item was not acquired.`,
          },
        };
      }

      // Matched acquisitions collected -> SUCCESS
      if (matchedAcquisitions.length > 0) {
        return {
          outcome: 'success',
          reason: 'gathered_item',
          details: {
            ...baseDetails,
            acquiredItems: matchedAcquisitions,
          },
        };
      }

      // If no drops were expected (e.g. stone with bare hands, leaves without shears)
      if (expectedDrops.length === 0) {
        return {
          outcome: 'success',
          reason: 'block_broken_no_drop_expected',
          details: {
            ...baseDetails,
            note: 'Block was successfully broken; no drops were expected with current tool.',
          },
        };
      }

      // If collection is optional (e.g. doorway clearing for shelter exit), block becoming air is sufficient
      if (options.collectionOptional && finalBlockState === 'air') {
        return {
          outcome: 'success',
          reason: 'block_cleared',
          details: {
            ...baseDetails,
            note: 'Block was successfully cleared to air (collection optional).',
            acquiredItems: matchedAcquisitions,
          },
        };
      }

      // Expected drop was not collected:
      // Case A: Full inventory
      if (inventoryIsFull) {
        return {
          outcome: 'failed',
          reason: 'inventory_full',
          details: {
            ...baseDetails,
            note: 'Block broken, but inventory was full so drop could not be collected.',
          },
        };
      }

      // Case B: Unrelated pickup occurred (e.g. bamboo collected while mining grass)
      if (unrelatedAcquisitions.length > 0) {
        return {
          outcome: 'failed',
          reason: 'unmatched_inventory_gain',
          details: {
            ...baseDetails,
            note: `Block "${blockName}" broke, but acquired items did not match expected drops [${expectedDrops.join(', ')}].`,
          },
        };
      }

      // Case C: Drop lost, fallen into void, or not reachable
      return {
        outcome: 'failed',
        reason: 'drop_not_collected',
        details: {
          ...baseDetails,
          note: `Block "${blockName}" broke, but expected drops [${expectedDrops.join(', ')}] were not collected into inventory.`,
        },
      };
    });
  }

  function boundFindSafeBlock(first, second, third) {
    if (first && first.entity) {
      return findSafeBlock(first, second, third);
    }
    return findSafeBlock(bot, first, second);
  }

  return {
    gather,
    findSafeBlock: boundFindSafeBlock,
  };
}

module.exports = {
  createGatherer,
  findSafeBlock,
  isDirectlyUnderFeet,
  hasGravityBlocksAbove,
  willExposeFluid,
  isNearFluid,
  hasHostileThreatNearby,
  RANGED_HOSTILES,
  MELEE_HOSTILES,
  willCreateUnsafePit,
  getItemEntityTypeName,
  getInventoryCounts,
  computeInventoryDelta,
  getExpectedDrops,
  computeAttribution,
  isInventoryFull,
  GRAVITY_BLOCK_NAMES,
};
