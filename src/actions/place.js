'use strict';

const { Vec3 } = require('vec3');
const { createSafeMovements, distance3D } = require('./navigate');
const { getInventoryCounts } = require('./gather');

/**
 * Common placeable blocks.
 */
const COMMON_BLOCKS = [
  'dirt', 'cobblestone', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'oak_log', 'crafting_table', 'furnace', 'sand', 'gravel', 'glass',
  'white_wool', 'terracotta', 'brick', 'stone_bricks', 'obsidian', 'deepslate_cobbled',
  'netherrack', 'andesite', 'diorite', 'granite',
];

/**
 * Gravity-affected falling blocks that require a solid block directly beneath them.
 */
const GRAVITY_BLOCKS = [
  'sand', 'red_sand', 'gravel', 'concrete_powder', 'anvil',
];

/**
 * Safe, ordinary full blocks permitted for automatic block selection.
 * Excludes workstations, storage, valuable blocks, interactive blocks, and gravity-affected blocks.
 */
const SAFE_BUILDING_BLOCKS = [
  'dirt', 'cobblestone', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'stone_bricks', 'deepslate_cobbled', 'netherrack', 'andesite', 'diorite', 'granite',
  'terracotta',
];

/**
 * Checks whether an item name is a placeable block.
 *
 * @param {string} itemName
 * @param {import('mineflayer').Bot} [bot]
 * @returns {boolean}
 */
function isPlaceableBlock(itemName, bot = null) {
  if (!itemName) return false;
  if (bot?.registry?.blocksByName?.[itemName]) return true;
  return COMMON_BLOCKS.includes(itemName);
}

/**
 * Checks whether a block is gravity-affected (falls if unsupported below).
 *
 * @param {string} blockName
 * @returns {boolean}
 */
function isGravityBlock(blockName) {
  if (!blockName) return false;
  return GRAVITY_BLOCKS.some((g) => blockName.includes(g));
}

/**
 * Checks if a block volume overlaps an entity bounding box.
 *
 * @param {Vec3} entityPos
 * @param {number} width
 * @param {number} height
 * @param {Vec3} blockPos
 * @returns {boolean}
 */
function entityIntersectsBlock(entityPos, width, height, blockPos) {
  const halfW = width / 2;
  const eMinX = entityPos.x - halfW;
  const eMaxX = entityPos.x + halfW;
  const eMinY = entityPos.y;
  const eMaxY = entityPos.y + height;
  const eMinZ = entityPos.z - halfW;
  const eMaxZ = entityPos.z + halfW;

  const bMinX = Math.floor(blockPos.x);
  const bMaxX = bMinX + 1;
  const bMinY = Math.floor(blockPos.y);
  const bMaxY = bMinY + 1;
  const bMinZ = Math.floor(blockPos.z);
  const bMaxZ = bMinZ + 1;

  return (
    eMinX < bMaxX && eMaxX > bMinX &&
    eMinY < bMaxY && eMaxY > bMinY &&
    eMinZ < bMaxZ && eMaxZ > bMinZ
  );
}

/**
 * Checks collision with the agent, other players, and nearby mobs.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Vec3} targetVec
 * @returns {{ clear: boolean, reason?: string, entity?: string }}
 */
function checkEntityCollisions(bot, targetVec) {
  // 1. Agent collision
  const playerPos = bot.entity?.position;
  if (playerPos && entityIntersectsBlock(playerPos, 0.6, 1.8, targetVec)) {
    return { clear: false, reason: 'obstructed_by_player', entity: 'SurvivalAgent' };
  }

  // 2. Other players and mobs collision
  if (bot.entities) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.position) continue;

      const isPlayer = entity.type === 'player';
      const isMob = entity.type === 'mob' || entity.type === 'animal' || entity.type === 'hostile';

      if (!isPlayer && !isMob) continue;

      const width = entity.width || (isPlayer ? 0.6 : 0.6);
      const height = entity.height || (isPlayer ? 1.8 : 1.8);

      if (entityIntersectsBlock(entity.position, width, height, targetVec)) {
        const reason = isPlayer ? 'obstructed_by_other_player' : 'obstructed_by_mob';
        const name = entity.username || entity.name || entity.type;
        return { clear: false, reason, entity: name };
      }
    }
  }

  return { clear: true };
}

/**
 * Legacy alias for agent-only bounding box intersection check.
 *
 * @param {Vec3} playerPos
 * @param {Vec3} blockPos
 * @returns {boolean}
 */
function intersectsPlayer(playerPos, blockPos) {
  if (!playerPos || !blockPos) return false;
  return entityIntersectsBlock(playerPos, 0.6, 1.8, blockPos);
}

/**
 * Finds a solid adjacent reference block and the corresponding face vector to attach the new block.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Vec3} targetVec
 * @returns {{ referenceBlock: import('prismarine-block').Block, faceVector: Vec3 } | { error: string, occupiedBy?: string }}
 */
function findPlacementReference(bot, targetVec) {
  const targetBlock = bot.blockAt(targetVec);
  if (!targetBlock) {
    return { error: 'target_chunk_not_loaded' };
  }

  // Target position must be replaceable or air
  const isReplaceable =
    targetBlock.name === 'air' ||
    targetBlock.name === 'water' ||
    targetBlock.name === 'lava' ||
    targetBlock.name === 'short_grass' ||
    targetBlock.name === 'grass' ||
    targetBlock.name === 'fern' ||
    targetBlock.material?.includes('replaceable');

  if (!isReplaceable && targetBlock.boundingBox === 'block') {
    return { error: 'target_occupied', occupiedBy: targetBlock.name };
  }

  // 6 adjacent face candidates
  const ADJACENT_FACES = [
    { dir: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) }, // Supporting block below (top face)
    { dir: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },  // Ceiling above (bottom face)
    { dir: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },  // West wall (east face)
    { dir: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },  // East wall (west face)
    { dir: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },  // North wall (south face)
    { dir: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },  // South wall (north face)
  ];

  for (const { dir, face } of ADJACENT_FACES) {
    const refPos = targetVec.plus(dir);
    const refBlock = bot.blockAt(refPos);
    if (!refBlock) continue;

    // Must be a solid, physical block
    if (
      refBlock.name !== 'air' &&
      refBlock.name !== 'water' &&
      refBlock.name !== 'lava' &&
      refBlock.boundingBox === 'block'
    ) {
      return { referenceBlock: refBlock, faceVector: face };
    }
  }

  return { error: 'no_supporting_block' };
}

/**
 * Restores previously held item into hand, or clears hand if previously empty.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ name: string, type: number } | null} previouslyHeld
 */
async function restoreHeldItem(bot, previouslyHeld) {
  if (!bot) return;
  try {
    if (previouslyHeld) {
      const invItems = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
      const itemToRestore = invItems.find(
        (i) => i.name === previouslyHeld.name || i.type === previouslyHeld.type
      );
      if (itemToRestore && typeof bot.equip === 'function') {
        await bot.equip(itemToRestore, 'hand');
      }
    } else if (bot.heldItem && typeof bot.unequip === 'function') {
      await bot.unequip('hand');
    }
  } catch {
    // Best-effort restoration
  }
}

/**
 * Creates the controlled block placement action primitive.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 */
function createPlacer(bot, actionManager) {
  /**
   * Places a block at target coordinates with collision check, reference detection, and postconditions.
   *
   * @param {number|Vec3} x X coordinate or Vec3 position
   * @param {number} [y] Y coordinate
   * @param {number} [z] Z coordinate
   * @param {string} [specificBlockName] Block item name to place (optional, auto-selects from safe blocks if omitted)
   * @param {object} [options]
   * @param {boolean} [options.allowFalling=false] If true, allows placing gravity blocks over air
   * @param {number} [options.maxReach=4.5] Maximum interaction reach without navigation
   * @param {number} [options.timeoutMs=15000]
   * @returns {Promise<object>} Settled action result
   */
  async function place(x, y, z, specificBlockName = null, options = {}) {
    let targetVec;
    let blockName = specificBlockName;
    let timeoutMs = options.timeoutMs || 15_000;

    if (x && typeof x === 'object' && 'x' in x) {
      targetVec = new Vec3(Math.floor(x.x), Math.floor(x.y), Math.floor(x.z));
      if (typeof y === 'string') {
        blockName = y;
      }
      if (z && typeof z === 'object') {
        timeoutMs = z.timeoutMs || timeoutMs;
      }
    } else {
      if (x === undefined || y === undefined || z === undefined) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'place',
          outcome: 'failed',
          reason: 'invalid_coordinates',
          message: 'Target coordinates (x, y, z) are required for placement.',
        };
      }
      targetVec = new Vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
    }

    const requestedName = blockName ? String(blockName).toLowerCase() : null;
    const invItems = bot.inventory ? bot.inventory.items() : [];

    // 1. Resolve block item
    let selectedItem = null;
    if (requestedName) {
      if (!isPlaceableBlock(requestedName, bot)) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'place',
          outcome: 'failed',
          reason: 'not_a_block',
          message: `Item "${requestedName}" is not a placeable block.`,
        };
      }

      selectedItem = invItems.find((i) => i.name === requestedName);
      if (!selectedItem) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'place',
          outcome: 'failed',
          reason: 'item_not_in_inventory',
          message: `Block item "${requestedName}" is not present in player inventory.`,
        };
      }
    } else {
      // Auto-select: ONLY from SAFE_BUILDING_BLOCKS (excludes crafting tables, storage, valuable, interactive, and gravity blocks)
      selectedItem = invItems.find((i) => SAFE_BUILDING_BLOCKS.includes(i.name));
      if (!selectedItem) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'place',
          outcome: 'failed',
          reason: 'no_safe_blocks_in_inventory',
          message: 'No safe building blocks found in inventory for automatic placement. Specify block explicitly.',
        };
      }
    }

    const chosenBlockName = selectedItem.name;

    // 2. Pre-flight entity collision check (agent, other players, mobs)
    const collision = checkEntityCollisions(bot, targetVec);
    if (!collision.clear) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'place',
        outcome: 'failed',
        reason: collision.reason,
        message: `Target block position is obstructed by ${collision.entity || 'an entity'}.`,
        details: { target: targetVec, collision },
      };
    }

    // 3. Pre-flight loaded chunk check
    const targetBlock = bot.blockAt(targetVec);
    if (!targetBlock) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'place',
        outcome: 'failed',
        reason: 'target_chunk_not_loaded',
        message: `Target coordinates (${targetVec.x}, ${targetVec.y}, ${targetVec.z}) are in an unloaded chunk.`,
      };
    }

    // 4. Pre-flight reach check (if navigation is not used or distance is excessive)
    const currentDist = bot.entity?.position ? distance3D(bot.entity.position, targetVec) : 0;
    if (options.noNavigate && currentDist > (options.maxReach || 4.5)) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'place',
        outcome: 'failed',
        reason: 'target_out_of_reach',
        message: `Target distance (${currentDist.toFixed(1)}m) exceeds maximum reach (${options.maxReach || 4.5}m).`,
        details: { distance: currentDist, maxReach: options.maxReach || 4.5 },
      };
    }

    // 5. Pre-flight reference and occupancy check
    const refResult = findPlacementReference(bot, targetVec);
    if (refResult.error) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'place',
        outcome: 'failed',
        reason: refResult.error,
        message:
          refResult.error === 'target_occupied'
            ? `Target location is already occupied by "${refResult.occupiedBy}".`
            : 'No solid supporting block found adjacent to target coordinates.',
        details: { target: targetVec, error: refResult.error },
      };
    }

    // 6. Pre-flight gravity block check: falling blocks require solid block directly beneath
    if (isGravityBlock(chosenBlockName) && !options.allowFalling) {
      const blockBelow = bot.blockAt(targetVec.offset(0, -1, 0));
      if (!blockBelow || blockBelow.boundingBox !== 'block') {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'place',
          outcome: 'failed',
          reason: 'gravity_block_unsupported_below',
          message: `Gravity-affected block "${chosenBlockName}" requires a solid block below to prevent falling.`,
          details: { target: targetVec, blockBelow: blockBelow?.name || 'none' },
        };
      }
    }

    const targetMeta = {
      x: targetVec.x,
      y: targetVec.y,
      z: targetVec.z,
      block: chosenBlockName,
      referencePos: refResult.referenceBlock?.position,
      faceVector: refResult.faceVector,
    };

    const previouslyHeld = bot.heldItem
      ? { name: bot.heldItem.name, type: bot.heldItem.type }
      : null;

    return actionManager.run('place', targetMeta, timeoutMs, async (signal, actionId, actionRecord) => {
      const initialBlock = bot.blockAt(targetVec);
      const initialBlockState = initialBlock ? initialBlock.name : 'air';
      const invBefore = getInventoryCounts(bot);
      const countBefore = invBefore[chosenBlockName] || 0;

      // Provide audit hook so ActionManager records finalBlockState, itemsConsumed, and worldChanged
      // even if the action is cancelled mid-flight or times out
      if (actionRecord) {
        actionRecord.getAudit = async () => {
          const currentBlock = bot.blockAt(targetVec);
          const finalBlockState = currentBlock ? currentBlock.name : 'unknown';
          const invCurrent = getInventoryCounts(bot);
          const countCurrent = invCurrent[chosenBlockName] || 0;
          const itemsConsumed = Math.max(0, countBefore - countCurrent);
          const worldChanged = finalBlockState === chosenBlockName || finalBlockState !== initialBlockState;
          return {
            finalBlockState,
            itemsConsumed,
            worldChanged,
            previouslyHeld: previouslyHeld ? previouslyHeld.name : null,
          };
        };
      }

      try {
        // Approach if beyond reach distance (> 4.0 blocks)
        const currentPos = bot.entity.position;
        const distToTarget = distance3D(currentPos, targetVec);

        if (distToTarget > 4.0 && bot.pathfinder) {
          const { goals } = require('mineflayer-pathfinder');
          const safeMovements = createSafeMovements(bot);
          bot.pathfinder.setMovements(safeMovements);
          const goal = new goals.GoalNear(targetVec.x, targetVec.y, targetVec.z, 3.0);
          bot.pathfinder.setGoal(goal);

          await Promise.race([
            new Promise((resolve, reject) => {
              const onGoalReached = () => {
                cleanup();
                resolve();
              };
              const cleanup = () => {
                bot.off('goal_reached', onGoalReached);
                signal.removeEventListener('abort', onAbort);
              };
              const onAbort = () => {
                cleanup();
                bot.pathfinder.setGoal(null);
                reject(new Error('aborted'));
              };
              bot.on('goal_reached', onGoalReached);
              signal.addEventListener('abort', onAbort, { once: true });
            }),
            new Promise((_, reject) => {
              if (signal.aborted) reject(new Error('aborted'));
            }),
          ]);

          bot.pathfinder.setGoal(null);
        }

        if (signal.aborted) throw new Error('aborted');

        // Re-verify reach after movement
        const postMoveDist = distance3D(bot.entity.position, targetVec);
        if (postMoveDist > (options.maxReach || 4.5)) {
          return {
            outcome: 'failed',
            reason: 'target_out_of_reach',
            details: { distance: postMoveDist, maxReach: options.maxReach || 4.5 },
          };
        }

        // Re-verify collision after movement
        const postMoveCollision = checkEntityCollisions(bot, targetVec);
        if (!postMoveCollision.clear) {
          return {
            outcome: 'failed',
            reason: postMoveCollision.reason,
            details: { target: targetVec, collision: postMoveCollision },
          };
        }

        // Re-verify reference block
        const liveRef = findPlacementReference(bot, targetVec);
        if (liveRef.error) {
          return {
            outcome: 'failed',
            reason: liveRef.error,
            details: { target: targetVec, error: liveRef.error },
          };
        }

        // Equip block item
        const itemToEquip = bot.inventory.items().find((i) => i.name === chosenBlockName);
        if (!itemToEquip) {
          return {
            outcome: 'failed',
            reason: 'item_not_in_inventory',
            details: { item: chosenBlockName },
          };
        }

        try {
          await bot.equip(itemToEquip, 'hand');
        } catch (err) {
          if (signal.aborted) throw err;
          return {
            outcome: 'failed',
            reason: 'equip_failed',
            details: { error: err.message },
          };
        }

        if (signal.aborted) throw new Error('aborted');

        // Place block with abort racing
        try {
          await Promise.race([
            bot.placeBlock(liveRef.referenceBlock, liveRef.faceVector),
            new Promise((_, reject) => {
              if (signal.aborted) return reject(new Error('aborted'));
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
          ]);
        } catch (err) {
          if (signal.aborted) throw err;
          return {
            outcome: 'failed',
            reason: 'placement_failed',
            details: { error: err.message, target: targetVec },
          };
        }

        // Settle delay for server block update
        await new Promise((r) => setTimeout(r, 250));

        // Postcondition verification
        const placedBlock = bot.blockAt(targetVec);
        const invAfter = getInventoryCounts(bot);
        const countAfter = invAfter[chosenBlockName] || 0;
        const itemsConsumed = countBefore - countAfter;

        const blockVerified = placedBlock && placedBlock.name === chosenBlockName;

        if (!blockVerified) {
          return {
            outcome: 'failed',
            reason: 'server_rejected_placement',
            details: {
              target: targetVec,
              expectedBlock: chosenBlockName,
              actualBlock: placedBlock ? placedBlock.name : 'unknown',
              itemsConsumed,
              worldChanged: placedBlock && placedBlock.name !== initialBlockState,
            },
          };
        }

        if (itemsConsumed !== 1) {
          return {
            outcome: 'failed',
            reason: 'inventory_decrement_failed',
            details: {
              target: targetVec,
              item: chosenBlockName,
              expectedConsumed: 1,
              actualConsumed: itemsConsumed,
            },
          };
        }

        return {
          outcome: 'success',
          reason: 'block_placed',
          details: {
            target: { x: targetVec.x, y: targetVec.y, z: targetVec.z },
            block: chosenBlockName,
            finalBlockState: chosenBlockName,
            itemsConsumed: 1,
            worldChanged: true,
            referencePos: liveRef.referenceBlock.position,
            previouslyHeld: previouslyHeld ? previouslyHeld.name : null,
          },
        };
      } finally {
        await restoreHeldItem(bot, previouslyHeld);
      }
    });
  }

  return {
    place,
    findPlacementReference,
    checkEntityCollisions,
    checkBoundingBoxClearance: (target) => checkEntityCollisions(bot, target).clear,
    isPlaceableBlock,
    isGravityBlock,
    SAFE_BUILDING_BLOCKS,
  };
}

module.exports = {
  createPlacer,
  findPlacementReference,
  checkEntityCollisions,
  intersectsPlayer,
  isPlaceableBlock,
  isGravityBlock,
  SAFE_BUILDING_BLOCKS,
};
