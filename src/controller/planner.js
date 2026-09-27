'use strict';

const { Vec3 } = require('vec3');
const { FailureTracker } = require('./failure_tracker');

const LOG_TYPES = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
];

/**
 * Harvestable crop block types with their maturity age thresholds.
 * @type {Record<string, number>} blockName → minimum age property value for harvest-readiness
 */
const CROP_MATURITY = {
  wheat:            7,  // age 7
  carrots:          7,  // age 7
  potatoes:         7,  // age 7
  beetroots:        3,  // age 3
  melon:            0,  // melon fruit block (always ready, preserves stem)
  melon_block:      0,  // legacy compatibility
  sweet_berry_bush: 2,  // age 2+
};

/** Passive food animal entity types that may be hunted for food. */
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];

/** Safe foods that may be eaten without cooking or food poisoning risk. */
const SAFE_FOODS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_salmon', 'cooked_cod', 'cooked_rabbit',
  'bread', 'baked_potato', 'apple', 'carrot', 'melon_slice',
  'sweet_berries', 'glow_berries', 'golden_carrot', 'pumpkin_pie',
  'mushroom_stew', 'beetroot_soup', 'rabbit_stew',
  'raw_beef', 'beef', 'raw_porkchop', 'porkchop', 'raw_mutton', 'mutton', 'raw_salmon', 'salmon', 'raw_cod', 'cod',
  'potato', 'beetroot',
]);

/** Cooked meat item names considered high-nutrition acquired food. */
const COOKED_FOOD_ITEMS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_salmon', 'cooked_cod', 'cooked_rabbit',
  'bread', 'baked_potato', 'apple', 'carrot', 'melon_slice',
  'sweet_berries', 'glow_berries',
]);

const PLANK_TYPES = [
  'oak_planks',
  'birch_planks',
  'spruce_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
];

/**
 * Maps any log name to its corresponding plank name.
 *
 * @param {string} logName
 * @returns {string}
 */
function getPlankForLog(logName) {
  if (logName.endsWith('_log')) {
    return logName.replace(/_log$/, '_planks');
  }
  return 'oak_planks';
}

/**
 * Checks whether an item name is any valid log type.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isLog(name) {
  return LOG_TYPES.includes(name) || name.endsWith('_log');
}

/**
 * Checks whether an item name is any valid plank type.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isPlank(name) {
  return PLANK_TYPES.includes(name) || name.endsWith('_planks');
}

/**
 * Counts total items matching a predicate or list in the inventory.
 *
 * @param {Array<{name: string, count: number}>} items
 * @param {function(string): boolean} predicate
 * @returns {number}
 */
function countMatching(items, predicate) {
  if (!items || !Array.isArray(items)) return 0;
  return items.reduce((sum, item) => (predicate(item.name) ? sum + item.count : sum), 0);
}

/**
 * Finds the first item in inventory matching a predicate.
 *
 * @param {Array<{name: string, count: number}>} items
 * @param {function(string): boolean} predicate
 * @returns {{name: string, count: number}|null}
 */
function findFirstMatching(items, predicate) {
  if (!items || !Array.isArray(items)) return null;
  return items.find(item => predicate(item.name)) || null;
}

/**
 * Searches for a nearby crafting table block within range.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} [maxDistance=24]
 * @param {import('./failure_tracker').FailureTracker|null} [failureTracker=null]
 * @returns {import('prismarine-block').Block|null}
 */
function findNearbyCraftingTable(bot, maxDistance = 24, failureTracker = null) {
  if (!bot || !bot.findBlock) return null;
  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  if (!tableId) return null;

  return bot.findBlock({
    matching: tableId,
    maxDistance,
    useExtraInfo: b => {
      if (!failureTracker) return true;
      const key = FailureTracker.makeKey('crafting_table', { x: b.position.x, y: b.position.y, z: b.position.z });
      return !failureTracker.isOnCooldown(key);
    },
  });
}

/**
 * Finds a suitable adjacent placement location for a crafting table.
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Vec3|null}
 */
function findTablePlacementSite(bot) {
  if (!bot || !bot.entity?.position || !bot.blockAt) return null;
  const pos = bot.entity.position.floored();

  // Try 4 cardinal directions at player feet level
  const offsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  for (const offset of offsets) {
    const target = pos.plus(offset);
    const below = target.offset(0, -1, 0);

    const targetBlock = bot.blockAt(target);
    const belowBlock = bot.blockAt(below);

    if (
      targetBlock &&
      (targetBlock.name === 'air' || targetBlock.boundingBox === 'empty') &&
      belowBlock &&
      belowBlock.boundingBox === 'block'
    ) {
      return target;
    }
  }

  return null;
}

const { isDirectlyUnderFeet, hasGravityBlocksAbove, findSafeBlock, willExposeFluid, isNearFluid, hasHostileThreatNearby } = require('../actions/gather');
const { isEligibleAdultAnimal, countEligibleAdults } = require('../actions/attack');
const {
  findSafeShelterSite,
  createShelterBlueprint,
  saveBlueprint,
  loadBlueprint,
  validateBlueprintIdentity,
  getServerFingerprint,
  auditEnclosure,
  checkExitSafety,
  isReplaceableVegetation,
  APPROVED_SHELTER_MATERIALS,
} = require('../actions/shelter');

const SHELTER_PREP_TIME = 10000;
const SHELTER_DEADLINE = 12000;
const DAWN_TIME = 23000;

/** Static fallback food points for safe foods when bot registry is unavailable. */
const STATIC_SAFE_FOOD_NUTRITION = {
  cooked_beef: 8,
  cooked_porkchop: 8,
  cooked_mutton: 6,
  cooked_chicken: 6,
  cooked_salmon: 6,
  cooked_cod: 5,
  cooked_rabbit: 5,
  bread: 5,
  baked_potato: 5,
  apple: 4,
  carrot: 3,
  melon_slice: 2,
  sweet_berries: 2,
  glow_berries: 2,
  golden_carrot: 6,
  pumpkin_pie: 8,
  mushroom_stew: 6,
  beetroot_soup: 6,
  rabbit_stew: 10,
  raw_beef: 3,
  beef: 3,
  raw_porkchop: 3,
  porkchop: 3,
  raw_mutton: 2,
  mutton: 2,
  raw_salmon: 2,
  salmon: 2,
  raw_cod: 2,
  cod: 2,
  potato: 1,
  beetroot: 1,
};

/**
 * Returns the nutritional value (food points) for a given safe food item.
 * Prioritizes version-specific bot registry data, falling back to static map.
 *
 * @param {string} itemName
 * @param {import('mineflayer').Bot} [bot]
 * @returns {number}
 */
function getFoodNutrition(itemName, bot = null) {
  if (!SAFE_FOODS.has(itemName)) return 0;
  if (bot?.registry?.foodsByName?.[itemName]?.foodPoints !== undefined) {
    return bot.registry.foodsByName[itemName].foodPoints;
  }
  return STATIC_SAFE_FOOD_NUTRITION[itemName] ?? 0;
}

/**
 * Calculates the total nutritional value of all safe foods in inventory.
 *
 * @param {Array<{name: string, count: number}>} items
 * @param {import('mineflayer').Bot} [bot]
 * @returns {number}
 */
function calculateHeldNutrition(items, bot = null) {
  if (!items || !Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) {
    if (SAFE_FOODS.has(item.name)) {
      const nutrition = getFoodNutrition(item.name, bot);
      total += nutrition * (item.count || 1);
    }
  }
  return total;
}

/**
 * Counts expendable solid building blocks in inventory (dirt + cobblestone minus 3 reserved for stone pickaxe).
 * Rejects gravity blocks (sand, gravel), leaves, logs, planks, ores.
 *
 * @param {Array<{name: string, count: number}>} items
 * @returns {number}
 */
function getExpendableBuildingBlocks(items) {
  if (!items || !Array.isArray(items)) return 0;
  const dirtCount = countMatching(items, name => name === 'dirt' || name === 'grass_block');
  const stoneCount = countMatching(items, name => name === 'cobblestone' || name === 'stone');
  const expendableStone = Math.max(0, stoneCount - 3);
  return dirtCount + expendableStone;
}

/**
 * Calculates the latest safe timeOfDay to begin gathering materials before dusk.
 *
 * @param {Array<{name: string, count: number}>} items
 * @param {number} [targetReserve=25] - building reserve margin (default 25, configurable up to 28-32)
 * @returns {number}
 */
function getLatestSafeGatherStart(items, targetReserve = 25) {
  const current = getExpendableBuildingBlocks(items);
  const needed = Math.max(0, targetReserve - current);
  const estimatedTicks = needed * 120;
  return Math.max(0, SHELTER_PREP_TIME - estimatedTicks);
}


/**
 * Finds the nearest mature, harvestable crop block within range.
 * Only returns blocks that have reached harvest maturity (age threshold).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {FailureTracker} [failureTracker]
 * @param {number} [maxDistance=24]
 * @returns {import('prismarine-block').Block|null}
 */
function findHarvestableCrop(bot, failureTracker, maxDistance = 24) {
  if (!bot || !bot.findBlock) return null;

  let matching;
  if (bot.registry?.blocksByName) {
    matching = Object.keys(CROP_MATURITY)
      .map(name => bot.registry.blocksByName?.[name]?.id)
      .filter(id => id !== undefined);
    if (matching.length === 0) return null;
  } else {
    matching = (b) => b && Object.prototype.hasOwnProperty.call(CROP_MATURITY, b.name);
  }

  return bot.findBlock({
    matching,
    maxDistance,
    useExtraInfo: (b) => {
      // Cooldown check
      const key = FailureTracker.makeKey('gather', { x: b.position.x, y: b.position.y, z: b.position.z, block: b.name });
      if (failureTracker && failureTracker.isOnCooldown(key)) return false;

      // Not under feet
      if (isDirectlyUnderFeet(bot, b.position)) return false;

      // Maturity check
      const minAge = CROP_MATURITY[b.name];
      if (minAge === undefined) return false;
      if (minAge === 0) return true; // melon fruit always harvestable

      const props = b.getProperties ? b.getProperties() : (b._properties || {});
      const ageVal = props.age !== undefined ? props.age : b.metadata;
      if (ageVal === undefined || ageVal === null) return false;
      return Number(ageVal) >= minAge;
    },
  });
}

/**
 * Finds the nearest passive food animal entity within range,
 * enforcing population preservation (requires >= 3 adults of species).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {FailureTracker} [failureTracker]
 * @param {number} [maxDistance=16]
 * @returns {{ entity: object, type: string, distance: number }|null}
 */
function findFoodAnimal(bot, failureTracker, maxDistance = 16) {
  if (!bot || !bot.entities || !bot.entity?.position) return null;

  let best = null;
  let bestDist = Infinity;

  for (const entity of Object.values(bot.entities)) {
    const type = entity.name || entity.type;
    if (!FOOD_ANIMALS.includes(type)) continue;
    if (!isEligibleAdultAnimal(entity)) continue;

    const pos = entity.position;
    if (!pos) continue;

    // Cooldown check
    if (failureTracker) {
      const key = FailureTracker.makeKey('attack', { entityId: entity.id, type });
      if (failureTracker.isOnCooldown(key)) continue;
    }

    const dist = bot.entity.position.distanceTo(pos);
    if (dist <= maxDistance && dist < bestDist) {
      // Check population preservation: need >= 3 adults so at least 2 remain
      const count = countEligibleAdults(bot, type, maxDistance);
      if (count >= 3) {
        best = { entity, type, distance: dist };
        bestDist = dist;
      }
    }
  }

  return best;
}


/**
 * Searches for safe, exposed stone blocks (adjacent to air, not under feet, no gravity hazards overhead).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {FailureTracker} [failureTracker]
 * @param {number} [maxDistance=32]
 * @returns {import('prismarine-block').Block|null}
 */
function findExposedStone(bot, failureTracker, maxDistance = 32) {
  if (!bot || !bot.findBlock) return null;
  const stoneId = bot.registry?.blocksByName?.stone?.id;
  if (!stoneId) return null;

  return bot.findBlock({
    matching: stoneId,
    maxDistance,
    useExtraInfo: (b) => {
      // Must not be on cooldown
      const colKey = `gather:col:${Math.floor(b.position.x)},${Math.floor(b.position.z)}`;
      if (failureTracker && failureTracker.isOnCooldown(colKey)) return false;
      const key = FailureTracker.makeKey('gather', { x: b.position.x, y: b.position.y, z: b.position.z, block: b.name });
      if (failureTracker && failureTracker.isOnCooldown(key)) return false;

      // Must be near bot walking elevation (+-2.5 blocks)
      if (bot.entity?.position && Math.abs(b.position.y - bot.entity.position.y) > 2.5) return false;

      // Must not be under feet
      if (isDirectlyUnderFeet(bot, b.position)) return false;

      // Must not have gravity blocks overhead
      if (hasGravityBlocksAbove(bot, b.position)) return false;

      // Must not expose fluid or be near water/lava
      if (willExposeFluid(bot, b.position) || isNearFluid(bot, b.position, 2)) return false;

      // Must not have hostile mobs near the stone target
      if (hasHostileThreatNearby(bot, 8.0, b.position)) return false;

      // Must be exposed: at least one adjacent face is air
      const offsets = [
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 1, 0),
        new Vec3(0, -1, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1),
      ];
      for (const off of offsets) {
        const neighbor = bot.blockAt(b.position.plus(off));
        if (neighbor && (neighbor.name === 'air' || neighbor.boundingBox === 'empty')) {
          return true;
        }
      }
      return false;
    },
  });
}


/**
 * Goal Planner and Prerequisite Solver for Wooden Pickaxe Progression.
 */
class GoalPlanner {
  /**
   * Evaluates current state and resolves the next prerequisite action for the target progression goal.
   * Supports 'wooden_pickaxe' (Tier 1) and 'stone_pickaxe' (Tier 2).
   *
   * @param {object} params
   * @param {import('mineflayer').Bot} params.bot
   * @param {string} [params.goal='wooden_pickaxe']
   * @param {FailureTracker} [params.failureTracker]
   * @param {object} [params.simulatedState] - Optional state override for projected simulations
   * @returns {object} Action proposal or status result
   */
  static planNextAction({ bot, goal = 'wooden_pickaxe', failureTracker = new FailureTracker(), simulatedState = null, targetReserve = 30, targetNutrition = null }) {
    const items = simulatedState ? simulatedState.inventory : (bot.inventory?.items() || []);

    if (goal === 'observe_daylight') {
      return {
        status: 'waiting',
        reason: 'awaiting_dusk_shelter_prep',
        message: 'Progression and reserves complete; observing daylight until dusk shelter preparation.',
      };
    }

    // =========================================================================
    // Stage 3C & Stage 4: Acquire Food Goal
    // =========================================================================
    if (goal === 'acquire_food') {
      const currentFood = simulatedState
        ? (simulatedState.food ?? 20)
        : (bot.food ?? 20);
      const isNight = simulatedState
        ? Boolean(simulatedState.isNight)
        : (bot.time?.timeOfDay !== undefined ? (bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500) : false);

      // --- Emergency Gate: food critically low + have safe food → eat immediately ---
      if (currentFood <= 6) {
        const safeFood = items.find(i => SAFE_FOODS.has(i.name) && i.count > 0);
        if (safeFood) {
          return {
            status: 'action_required',
            action: 'eat',
            args: [safeFood.name],
            reason: 'emergency_eat',
            details: { food: currentFood, item: safeFood.name },
            targetKey: FailureTracker.makeKey('eat', safeFood.name),
          };
        }
      }

      // Check held nutrition in inventory
      const heldNutrition = calculateHeldNutrition(items, bot);

      // --- Terminal: Nutrition Reserve Target (Stage 4) ---
      if (targetNutrition !== null && targetNutrition !== undefined) {
        if (heldNutrition >= targetNutrition) {
          return { status: 'completed', goal: 'acquire_food', message: `Held food nutrition reserve sufficient (>= ${targetNutrition}).` };
        }
      } else {
        // --- Terminal: food >= 18 (well-fed) ---
        if (currentFood >= 18) {
          return { status: 'completed', goal: 'acquire_food', message: 'Food level sufficient.' };
        }

        // --- Terminal: food >= 14 and inventory already has adequate high-nutrition food reserve (>= 2 items) ---
        const cookedCount = countMatching(items, name => COOKED_FOOD_ITEMS.has(name));
        if (currentFood >= 14 && cookedCount >= 2) {
          return { status: 'completed', goal: 'acquire_food', message: 'Sufficient cooked/safe food in inventory.' };
        }
      }

      // --- Eat available safe food if hungry ---
      const availableSafeFood = items.find(i => SAFE_FOODS.has(i.name) && i.count > 0);
      if (availableSafeFood && currentFood <= 14) {
        return {
          status: 'action_required',
          action: 'eat',
          args: [availableSafeFood.name],
          reason: 'eat_acquired_food',
          details: { food: currentFood, item: availableSafeFood.name },
          targetKey: FailureTracker.makeKey('eat', availableSafeFood.name),
        };
      }

      // --- Dynamic Nutrition Calculation ---
      const neededFood = (targetNutrition !== null && targetNutrition !== undefined)
        ? Math.max(18 - currentFood, targetNutrition - heldNutrition)
        : Math.max(0, 18 - currentFood);
      // 1 bread = 5 food points
      const neededBread = Math.ceil(neededFood / 5);
      const neededWheat = neededBread * 3;
      const currentWheat = countMatching(items, name => name === 'wheat');

      // --- Phase 1: Bread Crafting (3 wheat per bread, requires crafting table) ---
      if (currentWheat >= 3) {
        const breadToCraft = Math.min(Math.floor(currentWheat / 3), neededBread);

        // Check if crafting table is nearby
        const table = simulatedState
          ? (simulatedState.hasCraftingTable ? { position: { x: 0, y: 64, z: 0 } } : null)
          : findNearbyCraftingTable(bot, 24);

        if (table) {
          return {
            status: 'action_required',
            action: 'craft',
            args: ['bread', breadToCraft],
            reason: 'craft_bread_for_food',
            details: { wheatUsed: breadToCraft * 3, breadProduced: breadToCraft, requiresTable: true },
            targetKey: FailureTracker.makeKey('craft', 'bread'),
          };
        }

        // Table not nearby: check if table can be placed from inventory
        const hasTableInInv = countMatching(items, name => name === 'crafting_table') > 0;
        if (hasTableInInv) {
          const site = simulatedState ? { x: 0, y: 64, z: 1 } : findTablePlacementSite(bot);
          if (site) {
            return {
              status: 'action_required',
              action: 'place',
              args: [site.x, site.y, site.z, 'crafting_table'],
              reason: 'place_crafting_table_for_bread',
              details: { position: site },
              targetKey: FailureTracker.makeKey('place', site),
            };
          }
        }

        // Check if table can be crafted from planks
        const totalPlanks = countMatching(items, name => PLANK_TYPES.includes(name));
        if (totalPlanks >= 4) {
          return {
            status: 'action_required',
            action: 'craft',
            args: ['crafting_table', 1],
            reason: 'craft_crafting_table_for_bread',
            targetKey: FailureTracker.makeKey('craft', 'crafting_table'),
          };
        }

        // Cannot place or craft table: block with no_crafting_table_nearby
        return {
          status: 'blocked',
          reason: 'no_crafting_table_nearby',
          message: 'Bread requires a crafting table, but none was found nearby.',
        };
      }

      // --- Phase 2: Crop Harvest (preferred, replanting enabled) ---
      if (!simulatedState) {
        const cropBlock = findHarvestableCrop(bot, failureTracker, 24);
        if (cropBlock) {
          const targetKey = FailureTracker.makeKey('gather', {
            x: cropBlock.position.x, y: cropBlock.position.y, z: cropBlock.position.z, block: cropBlock.name,
          });
          return {
            status: 'action_required',
            action: 'gather',
            args: [cropBlock.position, { maxDistance: 24, timeoutMs: 20000, replant: true }],
            reason: 'harvest_crop_for_food',
            details: { crop: cropBlock.name, position: cropBlock.position },
            targetKey,
          };
        }
      } else if (simulatedState.hasCrop) {
        return {
          status: 'action_required',
          action: 'gather',
          args: ['wheat', { maxDistance: 24, timeoutMs: 20000, replant: true }],
          reason: 'harvest_crop_for_food',
          details: { crop: 'wheat', simulated: true },
          targetKey: FailureTracker.makeKey('gather', 'wheat'),
        };
      }

      // --- Phase 3: Animal Attack (last resort, daylight only) ---
      if (!isNight) {
        let animalTarget = null;
        if (!simulatedState) {
          // Check if only chickens exist nearby (raw chicken requires cooking before attack)
          const nearbyChickens = Object.values(bot.entities || {}).filter(e =>
            (e.name === 'chicken' || e.type === 'chicken') && isEligibleAdultAnimal(e)
          );
          const hasSafeAnimal = ['cow', 'pig', 'sheep'].some(t => {
            for (const e of Object.values(bot.entities || {})) {
              if ((e.name || e.type) === t && isEligibleAdultAnimal(e)) return true;
            }
            return false;
          });

          if (nearbyChickens.length > 0 && !hasSafeAnimal) {
            return {
              status: 'blocked',
              reason: 'unsafe_food_requires_cooking',
              message: 'Raw chicken requires cooking to prevent food poisoning.',
            };
          }

          animalTarget = findFoodAnimal(bot, failureTracker, 16);
        } else if (simulatedState.hasAnimal) {
          const aType = simulatedState.animalType || 'cow';
          if (aType === 'chicken') {
            return {
              status: 'blocked',
              reason: 'unsafe_food_requires_cooking',
              message: 'Raw chicken requires cooking to prevent food poisoning.',
            };
          }
          animalTarget = { entity: { id: 999 }, type: aType, distance: 8 };
        }

        if (animalTarget) {
          const adults = !simulatedState
            ? countEligibleAdults(bot, animalTarget.type, 16)
            : (simulatedState.adultCount !== undefined ? simulatedState.adultCount : 3);

          if (adults < 3) {
            return {
              status: 'blocked',
              reason: 'insufficient_food_acquired',
              message: `Fewer than 3 adult ${animalTarget.type} nearby; population must be preserved.`,
            };
          }

          const entityId = animalTarget.entity?.id ?? animalTarget.entityId;
          const targetKey = FailureTracker.makeKey('attack', { entityId, type: animalTarget.type });
          return {
            status: 'action_required',
            action: 'attack',
            args: [animalTarget.type],
            reason: 'kill_animal_for_food',
            details: { animalType: animalTarget.type, entityId, distance: animalTarget.distance },
            targetKey,
          };
        }
      }

      return {
        status: 'blocked',
        reason: 'no_food_source_available',
        message: 'No harvestable crops or safe food animals found within range.',
      };
    }

    // =========================================================================
    // Stage 3D: Maintain Building Reserve Goal
    // =========================================================================
    if (goal === 'maintain_building_reserve') {
      const expendable = getExpendableBuildingBlocks(items);
      const req = targetReserve || 30;
      if (expendable >= req) {
        return { status: 'completed', goal: 'maintain_building_reserve', message: `Material reserve maintained (>= ${req} expendable blocks).` };
      }

      // Find safe dirt/grass_block to gather without trenching or creating pits
      let dirtPos = null;
      if (!simulatedState && bot) {
        const dirtBlock = findSafeBlock(bot, 'dirt', 24, failureTracker);
        if (dirtBlock) dirtPos = dirtBlock.position;
      } else {
        dirtPos = { x: 0, y: 64, z: 1 };
      }

      if (!dirtPos) {
        return {
          status: 'blocked',
          reason: 'no_building_materials_nearby',
          message: 'Could not find reachable dirt blocks to maintain building reserve.',
        };
      }

      const targetKey = FailureTracker.makeKey('gather', dirtPos);
      return {
        status: 'action_required',
        action: 'gather',
        args: [dirtPos, { maxDistance: 24, timeoutMs: 20000 }],
        reason: 'gather_dirt_reserve',
        details: { currentExpendable: expendable, target: dirtPos },
        targetKey,
      };
    }

    // =========================================================================
    // Stage 3D: Build Shelter Goal
    // =========================================================================
    if (goal === 'build_shelter') {
      const timeOfDay = simulatedState?.timeOfDay ?? (bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 10500);

      // Deadline Failure Check: if timeOfDay >= SHELTER_DEADLINE and not enclosed
      if (timeOfDay >= SHELTER_DEADLINE && !simulatedState?.enclosed) {
        const bp = simulatedState?.blueprint || (bot ? loadBlueprint() : null);
        if (bp && bp.buildState !== 'completed') {
          bp.buildState = 'abandoned';
          if (bot) saveBlueprint(bp);
        }
        return {
          status: 'failed',
          reason: 'shelter_deadline_missed',
          message: `Shelter could not be completed before nightfall (timeOfDay: ${timeOfDay} >= ${SHELTER_DEADLINE}).`,
        };
      }

      // Blueprint resolution
      let blueprint = simulatedState?.blueprint || (bot ? loadBlueprint() : null);
      if (!blueprint || (bot && !validateBlueprintIdentity(blueprint, bot))) {
        let siteResult = null;
        if (!simulatedState && bot) {
          siteResult = findSafeShelterSite(bot, failureTracker, 16);
        } else {
          siteResult = {
            site: { x: 20, y: 86, z: 5 },
            center: { x: 20, y: 86, z: 5 },
            exitDirection: { x: 0, y: 0, z: 1 },
          };
        }

        if (!siteResult) {
          return {
            status: 'failed',
            reason: 'no_safe_site',
            message: 'No safe, flat 3x3 natural shelter site found within range.',
          };
        }

        blueprint = createShelterBlueprint(siteResult.center, siteResult.exitDirection, 'dirt', {
          server: getServerFingerprint(bot),
          dimension: bot?.game?.dimension || 'overworld',
          mcVersion: bot?.version || '1.20',
        });
        if (bot) saveBlueprint(blueprint);
      }

      // Check remaining materials needed for this blueprint
      const remainingNeeded = blueprint.requiredCoordinates.filter(
        c => !blueprint.verifiedCoordinates.includes(`${c.x},${c.y},${c.z}`)
      ).length;

      const expendable = getExpendableBuildingBlocks(items);
      const isInitialGather = (blueprint.verifiedCoordinates || []).length === 0;
      const targetMaterials = isInitialGather ? Math.max(remainingNeeded, targetReserve || 30) : remainingNeeded;
      if (expendable < targetMaterials && !simulatedState?.hasBlueprint) {
        let gatherPos = null;
        if (!simulatedState && bot?.findBlock) {
          const dirtIds = [
            bot.registry?.blocksByName?.dirt?.id,
            bot.registry?.blocksByName?.grass_block?.id,
          ].filter(Boolean);
          const cx = blueprint.center.x;
          const cy = blueprint.center.y;
          const cz = blueprint.center.z;
          const targetBlock = bot.findBlock({
            matching: dirtIds.length > 0 ? dirtIds : 'dirt',
            maxDistance: 24,
            useExtraInfo: (b) => {
              if (!b || !b.position) return false;
              // Strictly exclude shelter 3x3 footprint and perimeter to prevent gathering own shelter blocks or digging holes around entrance
              if (Math.abs(b.position.x - cx) <= 3 && Math.abs(b.position.z - cz) <= 3) {
                return false;
              }
              if (isDirectlyUnderFeet(bot, b.position)) return false;
              if (hasGravityBlocksAbove(bot, b.position)) return false;
              if (bot.entity?.position) {
                const dy = b.position.y - Math.floor(bot.entity.position.y);
                // Prefer surface dirt at foot level (dy = -1) or waist level (dy = 0)
                // Never dig trenches (dy < -1) or elevated ledge blocks (dy > 1)
                if (dy > 1 || dy < -1) return false;
              }
              // Prevent trenching: block must be on surface (air or foliage above it)
              const above = bot.blockAt ? bot.blockAt(b.position.offset(0, 1, 0)) : null;
              if (above && !['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'dandelion', 'poppy'].includes(above.name)) {
                return false;
              }
              // Prevent creating pits: block directly below must be solid supporting ground
              const below = bot.blockAt ? bot.blockAt(b.position.offset(0, -1, 0)) : null;
              if (!below || ['air', 'cave_air', 'water', 'lava'].includes(below.name)) {
                return false;
              }
              const colKey = `gather:col:${Math.floor(b.position.x)},${Math.floor(b.position.z)}`;
              if (failureTracker && failureTracker.isOnCooldown(colKey)) return false;
              const key = FailureTracker.makeKey('gather', b.position);
              return !failureTracker || !failureTracker.isOnCooldown(key);
            },
          });
          if (targetBlock) gatherPos = targetBlock.position;
        }

        if (!simulatedState && !gatherPos) {
          return {
            status: 'failed',
            reason: 'no_safe_material_source',
            details: { currentExpendable: expendable, needed: targetMaterials - expendable },
          };
        }

        return {
          status: 'action_required',
          action: 'gather',
          args: [gatherPos || 'dirt', { maxDistance: 24, timeoutMs: 20000 }],
          reason: 'gather_materials_for_shelter',
          details: { currentExpendable: expendable, needed: targetMaterials - expendable },
          targetKey: FailureTracker.makeKey('gather', gatherPos || 'dirt'),
        };
      }

      // Immediate Navigation to Center: bot must stand at center before placing blocks
      const centerTarget = {
        x: blueprint.center.x + 0.5,
        y: blueprint.center.y,
        z: blueprint.center.z + 0.5,
      };

      if (!simulatedState && bot) {
        const bpos = bot.entity?.position;
        const distToCenter = bpos ? Math.hypot(bpos.x - centerTarget.x, bpos.z - centerTarget.z) : 0;
        if (distToCenter > 0.4) {
          const targetKey = FailureTracker.makeKey('navigate', blueprint.center);
          return {
            status: 'action_required',
            action: 'navigate',
            args: [centerTarget.x, centerTarget.y, centerTarget.z, 0.2],
            reason: 'navigate_to_shelter_center',
            details: { center: blueprint.center, target: centerTarget },
            targetKey,
          };
        }
      }

      // Check coordinates sequentially
      for (const coord of blueprint.requiredCoordinates) {
        const coordKey = `${coord.x},${coord.y},${coord.z}`;
        if (blueprint.verifiedCoordinates.includes(coordKey)) continue;

        if (!simulatedState && bot) {
          const block = bot.blockAt(new Vec3(coord.x, coord.y, coord.z));
          const expectedMat = coord.expectedMaterial || blueprint.material;
          const isApproved = block && (
            block.name === expectedMat ||
            (APPROVED_SHELTER_MATERIALS.has(block.name) && APPROVED_SHELTER_MATERIALS.has(expectedMat))
          );

          if (block && isApproved) {
            if (block.name !== expectedMat) {
              coord.expectedMaterial = block.name;
              coord.material = block.name;
              coord.substitutionReason = 'pre_existing_approved_material';
            }
            blueprint.verifiedCoordinates.push(coordKey);
            saveBlueprint(blueprint);
            continue;
          }

          if (block && isReplaceableVegetation(block.name)) {
            const targetKey = FailureTracker.makeKey('gather', coord);
            return {
              status: 'action_required',
              action: 'gather',
              args: [coord, { timeoutMs: 10000, collectionOptional: true }],
              reason: 'clear_vegetation_for_shelter',
              details: { block: block.name, coordinate: coord },
              targetKey,
            };
          }

          if (block && block.boundingBox === 'block' && !isApproved) {
            blueprint.buildState = 'abandoned';
            saveBlueprint(blueprint);
            return {
              status: 'failed',
              reason: 'foreign_block_in_shelter_footprint',
              message: `Foreign block "${block.name}" occupies blueprint coordinate (${coord.x}, ${coord.y}, ${coord.z}).`,
              details: { foreignBlock: block.name, coordinate: coord },
            };
          }

          // Block is empty air -> dispatch place
          const targetKey = FailureTracker.makeKey('place', coord);
          return {
            status: 'action_required',
            action: 'place',
            args: [coord.x, coord.y, coord.z, blueprint.material],
            reason: 'place_shelter_block',
            details: {
              phase: coord.phase,
              blockIndex: coord.blockIndex,
              coordinate: coord,
              material: blueprint.material,
            },
            targetKey,
          };
        } else {
          // Simulation path
          blueprint.verifiedCoordinates.push(coordKey);
          return {
            status: 'action_required',
            action: 'place',
            args: [coord.x, coord.y, coord.z, blueprint.material],
            reason: 'place_shelter_block',
            details: {
              phase: coord.phase,
              blockIndex: coord.blockIndex,
              coordinate: coord,
              material: blueprint.material,
            },
            targetKey: FailureTracker.makeKey('place', coord),
          };
        }
      }

      // All 25 blocks placed -> run comprehensive enclosure audit!
      const audit = (simulatedState || !bot)
        ? { enclosed: true, missingCoordinates: [], playerInside: true }
        : auditEnclosure(bot, blueprint);

      if (audit.enclosed) {
        blueprint.buildState = 'enclosed';
        if (bot) saveBlueprint(blueprint);
        return {
          status: 'completed',
          goal: 'build_shelter',
          message: 'Shelter construction complete and fully enclosed.',
          details: { center: blueprint.center, material: blueprint.material },
        };
      }

      return {
        status: 'failed',
        reason: 'enclosure_audit_failed',
        message: 'Shelter coordinates placed but full enclosure audit failed.',
        details: audit,
      };
    }

    // =========================================================================
    // Stage 3D: Wait Out Night Goal
    // =========================================================================
    if (goal === 'wait_out_night') {
      const timeOfDay = simulatedState?.timeOfDay ?? (bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 13000);

      // Safe Exit Window: timeOfDay >= 23000 || timeOfDay < 10000
      if (timeOfDay >= DAWN_TIME || timeOfDay < SHELTER_PREP_TIME) {
        return {
          status: 'completed',
          goal: 'wait_out_night',
          message: `Daylight safe exit window reached (timeOfDay: ${timeOfDay}).`,
        };
      }

      // Check hunger while sheltered
      const currentFood = simulatedState ? (simulatedState.food ?? 20) : (bot.food ?? 20);
      if (currentFood <= 14) {
        const safeFood = items.find(i => SAFE_FOODS.has(i.name) && i.count > 0);
        if (safeFood) {
          return {
            status: 'action_required',
            action: 'eat',
            args: [safeFood.name],
            reason: 'eat_while_sheltered',
            details: { food: currentFood, item: safeFood.name },
            targetKey: FailureTracker.makeKey('eat', safeFood.name),
          };
        }
      }

      return {
        status: 'waiting',
        reason: 'waiting_for_daylight',
        message: `Waiting safely inside shelter (timeOfDay: ${timeOfDay}).`,
        details: { timeOfDay },
      };
    }

    // =========================================================================
    // Stage 3D: Leave Shelter Goal
    // =========================================================================
    if (goal === 'leave_shelter') {
      const blueprint = simulatedState?.blueprint || (bot ? loadBlueprint() : null);
      if (!blueprint) {
        return { status: 'completed', goal: 'leave_shelter', message: 'No active blueprint; already outside.' };
      }

      // 1. Pre-exit safety recheck
      const safety = simulatedState || !bot ? { safe: true, reason: 'exit_safe' } : checkExitSafety(bot, blueprint);
      if (!safety.safe) {
        return {
          status: 'waiting',
          reason: safety.reason,
          message: `Exit outside is currently unsafe (${safety.reason}); delaying doorway opening.`,
        };
      }

      // 2. Doorway clearance: upper exit block (y=1) then lower exit block (y=0)
      const upperExit = blueprint.exitCoordinates.find(c => c.layer === 1) || blueprint.exitCoordinates[1];
      const lowerExit = blueprint.exitCoordinates.find(c => c.layer === 0) || blueprint.exitCoordinates[0];

      if (!simulatedState && bot) {
        const upperBlock = bot.blockAt(new Vec3(upperExit.x, upperExit.y, upperExit.z));
        if (upperBlock && upperBlock.name !== 'air') {
          const targetKey = FailureTracker.makeKey('gather', upperExit);
          return {
            status: 'action_required',
            action: 'gather',
            args: [upperExit, { timeoutMs: 15000, collectionOptional: true }],
            reason: 'clear_upper_exit_doorway',
            details: { target: upperExit },
            targetKey,
          };
        }

        const lowerBlock = bot.blockAt(new Vec3(lowerExit.x, lowerExit.y, lowerExit.z));
        if (lowerBlock && lowerBlock.name !== 'air') {
          const targetKey = FailureTracker.makeKey('gather', lowerExit);
          return {
            status: 'action_required',
            action: 'gather',
            args: [lowerExit, { timeoutMs: 15000, collectionOptional: true }],
            reason: 'clear_lower_exit_doorway',
            details: { target: lowerExit },
            targetKey,
          };
        }

        // 3. Step outside doorway
        const landing = {
          x: blueprint.center.x + blueprint.exitDirection.x * 2 + 0.5,
          y: blueprint.center.y,
          z: blueprint.center.z + blueprint.exitDirection.z * 2 + 0.5,
        };
        const bpos = bot.entity?.position;
        const distToLanding = bpos ? Math.hypot(bpos.x - landing.x, bpos.z - landing.z) : 0;

        if (distToLanding > 0.6) {
          const targetKey = FailureTracker.makeKey('navigate', landing);
          return {
            status: 'action_required',
            action: 'navigate',
            args: [landing.x, landing.y, landing.z, 0.4],
            reason: 'step_outside_shelter',
            details: { landing },
            targetKey,
          };
        }
      }

      // Mark completed & clean up
      blueprint.buildState = 'completed';
      if (bot) saveBlueprint(blueprint);
      return {
        status: 'completed',
        goal: 'leave_shelter',
        message: 'Successfully exited shelter at dawn.',
      };
    }

    // =========================================================================
    // Tier 2: Stone Pickaxe Progression
    // =========================================================================
    if (goal === 'stone_pickaxe') {
      const hasStonePickaxe = countMatching(items, name => name === 'stone_pickaxe') > 0;
      if (hasStonePickaxe) {
        return { status: 'completed', goal: 'stone_pickaxe', message: 'Stone pickaxe acquired.' };
      }

      // 1. Check if agent has a pickaxe (wooden_pickaxe or better) to harvest stone
      const hasPickaxe = countMatching(items, name => name.endsWith('_pickaxe')) > 0;
      if (!hasPickaxe) {
        // Delegate to Tier 1 planner to produce wooden_pickaxe first!
        const subPlan = GoalPlanner.planNextAction({ bot, goal: 'wooden_pickaxe', failureTracker, simulatedState });
        return subPlan;
      }

      // 2. Check cobblestone: need 3 cobblestone
      const totalCobble = countMatching(items, name => name === 'cobblestone');
      if (totalCobble < 3) {
        // Check if pickaxe is currently equipped in hand
        const heldItem = simulatedState ? simulatedState.heldItem : bot?.heldItem?.name;
        if (heldItem !== 'wooden_pickaxe' && !heldItem?.endsWith('_pickaxe')) {
          const pickaxeItem = findFirstMatching(items, name => name.endsWith('_pickaxe'));
          const toolName = pickaxeItem ? pickaxeItem.name : 'wooden_pickaxe';
          const targetKey = FailureTracker.makeKey('equip', toolName);
          return {
            status: 'action_required',
            action: 'equip',
            args: [toolName, 'hand'],
            reason: 'equip_pickaxe_for_mining',
            details: { tool: toolName },
            targetKey,
          };
        }


        // Find safe exposed stone
        let stonePos = null;
        if (!simulatedState) {
          const block = findExposedStone(bot, failureTracker, 32);
          if (!block) {
            const expendable = getExpendableBuildingBlocks(items);
            if (expendable < (targetReserve || 30)) {
              const dirtBlock = findSafeBlock(bot, 'dirt', 24, failureTracker);
              if (dirtBlock) {
                const targetKey = FailureTracker.makeKey('gather', dirtBlock.position);
                return {
                  status: 'action_required',
                  action: 'gather',
                  args: [dirtBlock.position, { maxDistance: 24, timeoutMs: 30000 }],
                  reason: 'gather_building_reserve_early',
                  details: { currentExpendable: expendable, targetReserve: targetReserve || 30 },
                  targetKey,
                };
              }
            }
            return {
              status: 'blocked',
              reason: 'no_exposed_stone_found',
              message: 'No safe exposed stone blocks found within reach.',
            };
          }
          stonePos = block.position;
        }

        const targetKey = FailureTracker.makeKey('gather', stonePos || 'stone');
        return {
          status: 'action_required',
          action: 'gather',
          args: [stonePos || 'stone', { maxDistance: 32, timeoutMs: 30000 }],
          reason: 'gather_stone_for_cobblestone',
          details: { currentCobblestone: totalCobble, neededCobblestone: 3 },
          targetKey,
        };
      }

      // 3. Cobblestone >= 3! Check sticks: need 2 sticks
      const totalSticks = countMatching(items, name => name === 'stick');
      if (totalSticks < 2) {
        const totalPlanks = countMatching(items, isPlank);
        if (totalPlanks >= 2) {
          const targetKey = FailureTracker.makeKey('craft', 'stick');
          return {
            status: 'action_required',
            action: 'craft',
            args: ['stick', 1],
            reason: 'craft_sticks_for_stone_pickaxe',
            details: { currentSticks: totalSticks, neededSticks: 2 },
            targetKey,
          };
        }

        // Need planks: craft from log if available
        const firstLog = findFirstMatching(items, isLog);
        if (firstLog) {
          const plankType = getPlankForLog(firstLog.name);
          return {
            status: 'action_required',
            action: 'craft',
            args: [plankType, 1],
            reason: 'craft_planks_for_sticks',
            details: { logUsed: firstLog.name },
            targetKey: FailureTracker.makeKey('craft', plankType),
          };
        }

        return {
          status: 'action_required',
          action: 'gather',
          args: ['oak_log', { maxDistance: 32, timeoutMs: 30000 }],
          reason: 'gather_wood_for_sticks',
          details: {},
          targetKey: FailureTracker.makeKey('gather', 'oak_log'),
        };
      }

      // 4. Cobblestone >= 3, sticks >= 2! Check Crafting Table (scanning up to 24m to reuse)
      const craftStonePickKey = FailureTracker.makeKey('craft', 'stone_pickaxe');
      const isStoneCraftOnCooldown = failureTracker ? failureTracker.isOnCooldown(craftStonePickKey) : false;
      const nearbyStoneTable = (!isStoneCraftOnCooldown && bot)
        ? findNearbyCraftingTable(bot, 24, failureTracker)
        : null;

      const hasWorldTable = simulatedState
        ? Boolean(simulatedState.hasCraftingTable)
        : Boolean(nearbyStoneTable);

      if (!hasWorldTable) {
        const hasTableItem = countMatching(items, name => name === 'crafting_table') > 0;
        if (hasTableItem) {
          let placePos = null;
          if (!simulatedState) {
            placePos = findTablePlacementSite(bot);
          } else {
            placePos = new Vec3(0, 64, 1);
          }

          if (!placePos) {
            return {
              status: 'blocked',
              reason: 'no_suitable_placement_site',
              message: 'Could not find a valid adjacent block to place crafting table.',
            };
          }

          const targetKey = FailureTracker.makeKey('place', { x: placePos.x, y: placePos.y, z: placePos.z, block: 'crafting_table' });
          return {
            status: 'action_required',
            action: 'place',
            args: [placePos.x, placePos.y, placePos.z, 'crafting_table'],
            reason: 'place_crafting_table',
            details: { position: placePos },
            targetKey,
          };
        } else {
          // Need to craft crafting_table
          const totalPlanks = countMatching(items, isPlank);
          if (totalPlanks >= 4) {
            return {
              status: 'action_required',
              action: 'craft',
              args: ['crafting_table', 1],
              reason: 'craft_crafting_table',
              details: { planksRemaining: totalPlanks },
              targetKey: FailureTracker.makeKey('craft', 'crafting_table'),
            };
          } else {
            const firstLog = findFirstMatching(items, isLog);
            if (firstLog) {
              const plankType = getPlankForLog(firstLog.name);
              return {
                status: 'action_required',
                action: 'craft',
                args: [plankType, 1],
                reason: 'craft_planks_for_table',
                details: { logUsed: firstLog.name },
                targetKey: FailureTracker.makeKey('craft', plankType),
              };
            }
            return {
              status: 'action_required',
              action: 'gather',
              args: ['oak_log', { maxDistance: 32, timeoutMs: 30000 }],
              reason: 'gather_wood_for_table',
              details: {},
              targetKey: FailureTracker.makeKey('gather', 'oak_log'),
            };
          }
        }
      }

      // 5. Everything ready! Table nearby, cobblestone >= 3, sticks >= 2:
      const targetKey = craftStonePickKey;
      return {
        status: 'action_required',
        action: 'craft',
        args: ['stone_pickaxe', 1],
        reason: 'craft_stone_pickaxe',
        details: { cobblestone: totalCobble, sticks: totalSticks },
        targetKey,
      };
    }

    // =========================================================================
    // Tier 1: Wooden Pickaxe Progression (default)
    // =========================================================================
    const hasPickaxe = countMatching(items, name => name === 'wooden_pickaxe') > 0;
    if (hasPickaxe) {
      return { status: 'completed', goal: 'wooden_pickaxe', message: 'Wooden pickaxe acquired.' };
    }

    // 1. Inventory counts
    const totalLogs = countMatching(items, isLog);
    const totalPlanks = countMatching(items, isPlank);
    const totalSticks = countMatching(items, name => name === 'stick');
    const hasTableItem = countMatching(items, name => name === 'crafting_table') > 0;

    const craftPickaxeKey = FailureTracker.makeKey('craft', 'wooden_pickaxe');
    const isPickaxeCraftOnCooldown = failureTracker ? failureTracker.isOnCooldown(craftPickaxeKey) : false;

    // 2. Check for crafting table in world or simulated world
    const nearbyWoodTable = (!isPickaxeCraftOnCooldown && bot)
      ? findNearbyCraftingTable(bot, 24, failureTracker)
      : null;

    const hasWorldTable = simulatedState
      ? Boolean(simulatedState.hasCraftingTable)
      : Boolean(nearbyWoodTable);

    // 3. Exact material requirements:
    // - Wooden Pickaxe: 3 planks + 2 sticks
    // - Sticks: 2 planks (yields 4 sticks) -> needed if sticks < 2
    // - Table: 4 planks -> needed if no world table and no table item
    const planksForTable = (hasWorldTable || hasTableItem) ? 0 : 4;
    const planksForSticks = (totalSticks >= 2) ? 0 : 2;
    const planksForPickaxe = 3;
    const totalPlanksNeeded = planksForTable + planksForSticks + planksForPickaxe;

    // Total wood power = current planks + (logs * 4)
    const totalPotentialPlanks = totalPlanks + (totalLogs * 4);

    // 4. Resolve Wood / Logs Prerequisite
    if (totalPotentialPlanks < totalPlanksNeeded) {
      const logsNeeded = Math.ceil((totalPlanksNeeded - totalPotentialPlanks) / 4);

      let targetLog = 'oak_log';
      let targetPos = null;

      if (!simulatedState && bot.findBlock) {
        const logIds = LOG_TYPES.map(name => bot.registry?.blocksByName?.[name]?.id).filter(Boolean);
        const botY = bot.entity?.position?.y;

        // Pass 1: Prioritize logs near player elevation (within +/- 4 blocks in Y)
        let block = bot.findBlock({
          matching: logIds,
          maxDistance: 32,
          useExtraInfo: b => {
            if (botY !== undefined && Math.abs(b.position.y - botY) > 4) return false;
            const colKey = `gather:col:${Math.floor(b.position.x)},${Math.floor(b.position.z)}`;
            if (failureTracker.isOnCooldown(colKey)) return false;
            const key = FailureTracker.makeKey('gather', { x: b.position.x, y: b.position.y, z: b.position.z, block: b.name });
            return !failureTracker.isOnCooldown(key);
          },
        });

        // Pass 2: Fallback to any log within 32 blocks
        if (!block) {
          block = bot.findBlock({
            matching: logIds,
            maxDistance: 32,
            useExtraInfo: b => {
              const colKey = `gather:col:${Math.floor(b.position.x)},${Math.floor(b.position.z)}`;
              if (failureTracker.isOnCooldown(colKey)) return false;
              const key = FailureTracker.makeKey('gather', { x: b.position.x, y: b.position.y, z: b.position.z, block: b.name });
              return !failureTracker.isOnCooldown(key);
            },
          });
        }

        if (block) {
          targetLog = block.name;
          targetPos = block.position;
        }
      }

      const targetKey = FailureTracker.makeKey('gather', targetPos || targetLog);
      return {
        status: 'action_required',
        action: 'gather',
        args: [targetPos || targetLog, { maxDistance: 32, timeoutMs: 30000 }],
        reason: 'gather_logs_for_planks',
        details: {
          neededPlanks: totalPlanksNeeded,
          currentPlanks: totalPlanks,
          currentLogs: totalLogs,
          logsNeeded,
        },
        targetKey,
      };
    }

    // 5. Convert Logs to Planks if needed
    if (totalPlanks < totalPlanksNeeded) {
      const firstLog = findFirstMatching(items, isLog);
      if (firstLog) {
        const plankType = getPlankForLog(firstLog.name);
        const targetKey = FailureTracker.makeKey('craft', plankType);
        return {
          status: 'action_required',
          action: 'craft',
          args: [plankType, 1],
          reason: 'craft_planks',
          details: { logUsed: firstLog.name, plankProduced: plankType },
          targetKey,
        };
      }
    }

    // 6. Craft Sticks if needed
    if (totalSticks < 2) {
      const targetKey = FailureTracker.makeKey('craft', 'stick');
      return {
        status: 'action_required',
        action: 'craft',
        args: ['stick', 1],
        reason: 'craft_sticks',
        details: { currentSticks: totalSticks, neededSticks: 2 },
        targetKey,
      };
    }

    // 7. Craft Table if needed and not in inventory
    if (!hasWorldTable && !hasTableItem) {
      const targetKey = FailureTracker.makeKey('craft', 'crafting_table');
      return {
        status: 'action_required',
        action: 'craft',
        args: ['crafting_table', 1],
        reason: 'craft_crafting_table',
        details: { planksRemaining: totalPlanks },
        targetKey,
      };
    }

    // 8. Place Crafting Table if in inventory and none nearby
    if (!hasWorldTable && hasTableItem) {
      let placePos = null;
      if (!simulatedState) {
        placePos = findTablePlacementSite(bot);
      } else {
        placePos = new Vec3(0, 64, 1);
      }

      if (!placePos) {
        return {
          status: 'blocked',
          reason: 'no_suitable_placement_site',
          message: 'Could not find a valid adjacent block to place crafting table.',
        };
      }

      const targetKey = FailureTracker.makeKey('place', { x: placePos.x, y: placePos.y, z: placePos.z, block: 'crafting_table' });
      return {
        status: 'action_required',
        action: 'place',
        args: [placePos.x, placePos.y, placePos.z, 'crafting_table'],
        reason: 'place_crafting_table',
        details: { position: placePos },
        targetKey,
      };
    }

    // 9. Craft Wooden Pickaxe (3 planks, 2 sticks, at crafting table)
    if (hasWorldTable && totalPlanks >= 3 && totalSticks >= 2 && !isPickaxeCraftOnCooldown) {
      const targetKey = craftPickaxeKey;
      return {
        status: 'action_required',
        action: 'craft',
        args: ['wooden_pickaxe', 1],
        reason: 'craft_wooden_pickaxe',
        details: { totalPlanks, totalSticks },
        targetKey,
      };
    }

    return {
      status: 'blocked',
      reason: 'unresolved_dependencies',
      message: 'Controller could not resolve next action for wooden pickaxe.',
    };
  }

  /**
   * Runs a projected-state simulation from the given starting inventory and world state,
   * labeling every state transition explicitly with simulated: true.
   *
   * @param {object} params
   * @param {Array<{name: string, count: number}>} params.initialInventory
   * @param {boolean} [params.hasCraftingTable=false]
   * @param {string} [params.goal='wooden_pickaxe']
   * @param {number} [params.maxSteps=30]
   * @returns {Array<object>} Simulated action trace
   */
  static simulatePlan({ initialInventory = [], hasCraftingTable = false, goal = 'wooden_pickaxe', maxSteps = 30,
    initialFood = 10, hasCrop = false, hasAnimal = false } = {}) {
    const simInventory = initialInventory.map(item => ({ name: item.name, count: item.count }));
    const simState = {
      inventory: simInventory,
      hasCraftingTable,
      food: initialFood,
      hasCrop,
      hasAnimal,
      isNight: false,
    };

    const trace = [];

    function addItem(name, count) {
      const existing = simState.inventory.find(i => i.name === name);
      if (existing) {
        existing.count += count;
      } else {
        simState.inventory.push({ name, count });
      }
    }

    function removeItem(name, count) {
      const existing = simState.inventory.find(i => i.name === name);
      if (existing) {
        existing.count -= count;
        if (existing.count <= 0) {
          simState.inventory = simState.inventory.filter(i => i !== existing);
        }
      }
    }

    function removeMatching(predicate, count) {
      let remaining = count;
      for (const item of [...simState.inventory]) {
        if (predicate(item.name)) {
          const deduct = Math.min(item.count, remaining);
          item.count -= deduct;
          remaining -= deduct;
          if (item.count <= 0) {
            simState.inventory = simState.inventory.filter(i => i !== item);
          }
          if (remaining <= 0) break;
        }
      }
    }

    for (let step = 1; step <= maxSteps; step++) {
      const plan = GoalPlanner.planNextAction({
        bot: null,
        goal,
        simulatedState: simState,
      });

      if (plan.status === 'completed') {
        trace.push({
          step,
          simulated: true,
          status: 'completed',
          goal: plan.goal,
          message: plan.message,
          resultingInventory: simState.inventory.map(i => ({ ...i })),
        });
        break;
      }

      if (plan.status !== 'action_required') {
        trace.push({
          step,
          simulated: true,
          status: plan.status,
          reason: plan.reason,
          message: plan.message,
          resultingInventory: simState.inventory.map(i => ({ ...i })),
        });
        break;
      }

      // Apply expected simulated effects
      const entry = {
        step,
        simulated: true,
        action: plan.action,
        args: plan.args,
        reason: plan.reason,
        details: plan.details,
      };

      if (plan.action === 'equip') {
        simState.heldItem = plan.args[0];
        entry.details = { ...entry.details, simulated_equip: true };
      } else if (plan.action === 'eat') {
        // Simulate eating: remove 1 food item, restore some food points
        const foodName = plan.args[0];
        removeItem(foodName, 1);
        simState.food = Math.min(20, simState.food + 6); // approximate restoration
        entry.details = { ...entry.details, foodAfter: simState.food };
      } else if (plan.action === 'attack') {
        // Simulate animal kill: add raw loot, mark animal gone
        const animalType = plan.args[0];
        const loot = {
          chicken: 'raw_chicken', cow: 'raw_beef', pig: 'raw_porkchop',
          sheep: 'raw_mutton', rabbit: 'raw_rabbit',
        };
        const drop = loot[animalType] || 'raw_beef';
        addItem(drop, 1);
        simState.hasAnimal = false; // consumed animal
        entry.details = { ...entry.details, loot: drop };
      } else if (plan.action === 'navigate') {
        entry.details = { ...entry.details, simulated_navigation: true };
      } else if (plan.action === 'gather') {
        if (plan.reason === 'gather_stone_for_cobblestone') {
          addItem('cobblestone', 1);
        } else if (plan.reason === 'harvest_crop_for_food') {
          addItem('wheat', 3); // simulate wheat harvest yield
          simState.hasCrop = false; // crop harvested
          entry.details = { ...entry.details, simulated_crop_yield: 3 };
        } else if (plan.reason === 'gather_dirt_reserve' || plan.reason === 'gather_materials_for_shelter') {
          addItem('dirt', 1);
        } else {
          addItem('oak_log', 1);
        }
      } else if (plan.action === 'craft') {
        const itemCrafted = plan.args[0];
        if (isPlank(itemCrafted)) {
          removeMatching(isLog, 1);
          addItem(itemCrafted, 4);
        } else if (itemCrafted === 'stick') {
          removeMatching(isPlank, 2);
          addItem('stick', 4);
        } else if (itemCrafted === 'crafting_table') {
          removeMatching(isPlank, 4);
          addItem('crafting_table', 1);
        } else if (itemCrafted === 'wooden_pickaxe') {
          removeMatching(isPlank, 3);
          removeItem('stick', 2);
          addItem('wooden_pickaxe', 1);
        } else if (itemCrafted === 'stone_pickaxe') {
          removeItem('cobblestone', 3);
          removeItem('stick', 2);
          addItem('stone_pickaxe', 1);
        } else if (itemCrafted === 'bread') {
          const count = plan.args[1] || 1;
          removeItem('wheat', count * 3);
          addItem('bread', count);
        }
      } else if (plan.action === 'place') {
        const blockPlaced = plan.args[3];
        entry.simulated_placeholder = true;
        if (blockPlaced === 'crafting_table') {
          removeItem('crafting_table', 1);
          simState.hasCraftingTable = true;
        } else if (blockPlaced === 'dirt' || blockPlaced === 'cobblestone') {
          removeItem(blockPlaced, 1);
        }
      }

      entry.resultingInventory = simState.inventory.map(i => ({ ...i }));
      trace.push(entry);
    }

    return trace;
  }
}

module.exports = {
  GoalPlanner,
  LOG_TYPES,
  PLANK_TYPES,
  CROP_MATURITY,
  FOOD_ANIMALS,
  COOKED_FOOD_ITEMS,
  getPlankForLog,
  isLog,
  isPlank,
  findNearbyCraftingTable,
  findTablePlacementSite,
  findExposedStone,
  findHarvestableCrop,
  findFoodAnimal,
  SAFE_FOODS,
  SHELTER_PREP_TIME,
  SHELTER_DEADLINE,
  DAWN_TIME,
  getExpendableBuildingBlocks,
  getLatestSafeGatherStart,
  getFoodNutrition,
  calculateHeldNutrition,
  STATIC_SAFE_FOOD_NUTRITION,
};

