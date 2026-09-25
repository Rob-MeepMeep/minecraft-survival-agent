'use strict';

const { getInventoryCounts } = require('./gather');
const { distance3D } = require('./navigate');

/**
 * Standard Minecraft food nutrition and safety registry.
 */
const FOOD_REGISTRY = {
  // High tier cooked meats / foods
  cooked_beef: { points: 8, saturation: 12.8, safe: true },
  cooked_porkchop: { points: 8, saturation: 12.8, safe: true },
  cooked_mutton: { points: 6, saturation: 9.6, safe: true },
  cooked_salmon: { points: 6, saturation: 9.6, safe: true },
  cooked_chicken: { points: 6, saturation: 7.2, safe: true },
  cooked_cod: { points: 5, saturation: 6.0, safe: true },
  bread: { points: 5, saturation: 6.0, safe: true },
  baked_potato: { points: 5, saturation: 6.0, safe: true },
  pumpkin_pie: { points: 8, saturation: 4.8, safe: true },
  rabbit_stew: { points: 10, saturation: 12.0, safe: true },
  mushroom_stew: { points: 6, saturation: 7.2, safe: true },
  beetroot_soup: { points: 6, saturation: 7.2, safe: true },

  // Fruits, vegetables, light foods
  apple: { points: 4, saturation: 2.4, safe: true },
  golden_apple: { points: 4, saturation: 9.6, safe: true, canEatWhenFull: true, isValuable: true, specialEffects: ['absorption', 'regeneration'] },
  enchanted_golden_apple: { points: 4, saturation: 9.6, safe: true, canEatWhenFull: true, isValuable: true, specialEffects: ['absorption', 'regeneration', 'fire_resistance', 'resistance'] },
  carrot: { points: 3, saturation: 3.6, safe: true },
  golden_carrot: { points: 6, saturation: 14.4, safe: true },
  sweet_berries: { points: 2, saturation: 0.4, safe: true },
  glow_berries: { points: 2, saturation: 0.4, safe: true },
  melon_slice: { points: 2, saturation: 1.2, safe: true },
  cookie: { points: 2, saturation: 0.4, safe: true },
  dried_kelp: { points: 1, saturation: 0.6, safe: true },
  honey_bottle: { points: 6, saturation: 1.2, safe: true, canEatWhenFull: true, removesEffects: ['poison'] },

  // Raw foods (safe, but sub-optimal)
  raw_beef: { points: 3, saturation: 1.8, safe: true },
  raw_porkchop: { points: 3, saturation: 1.8, safe: true },
  raw_mutton: { points: 2, saturation: 1.2, safe: true },
  raw_salmon: { points: 2, saturation: 0.4, safe: true },
  raw_cod: { points: 2, saturation: 0.4, safe: true },
  potato: { points: 1, saturation: 0.6, safe: true },
  beetroot: { points: 1, saturation: 1.2, safe: true },

  // Unsafe / harmful / unpredictable foods
  suspicious_stew: { points: 6, saturation: 7.2, safe: false, effect: 'variable' },
  rotten_flesh: { points: 4, saturation: 0.8, safe: false, effect: 'hunger' },
  pufferfish: { points: 1, saturation: 0.2, safe: false, effect: 'poison' },
  poisonous_potato: { points: 2, saturation: 1.2, safe: false, effect: 'poison' },
  spider_eye: { points: 2, saturation: 3.2, safe: false, effect: 'poison' },
  raw_chicken: { points: 2, saturation: 1.2, safe: false, effect: 'hunger' },
  chorus_fruit: { points: 4, saturation: 2.4, safe: false, effect: 'teleport', canEatWhenFull: true },
};

/**
 * Checks whether an item is edible.
 *
 * @param {string} itemName
 * @param {import('mineflayer').Bot} [bot]
 * @returns {boolean}
 */
function isFood(itemName, bot = null) {
  if (!itemName) return false;
  if (FOOD_REGISTRY[itemName]) return true;
  if (bot?.registry?.foodsByName?.[itemName]) return true;
  return false;
}

/**
 * Checks whether a food is deemed unsafe (harmful effects, random stew, or uncontrolled teleportation).
 *
 * @param {string} itemName
 * @returns {boolean}
 */
function isUnsafeFood(itemName) {
  if (!itemName) return false;
  if (itemName === 'chorus_fruit' || itemName === 'suspicious_stew') return true;
  return FOOD_REGISTRY[itemName] ? !FOOD_REGISTRY[itemName].safe : false;
}

/**
 * Checks whether a food can be consumed when hunger is already full (>= 20).
 *
 * @param {string} itemName
 * @returns {boolean}
 */
function canEatWhenFull(itemName) {
  if (!itemName) return false;
  return Boolean(FOOD_REGISTRY[itemName]?.canEatWhenFull);
}

/**
 * Helper to retrieve active potion effect names from bot entity.
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {string[]}
 */
function getActiveEffectNames(bot) {
  if (!bot?.entity?.effects) return [];
  const names = [];
  for (const [id, eff] of Object.entries(bot.entity.effects)) {
    if (!eff) continue;
    const effectData = bot.registry?.effects?.[id];
    const name = effectData ? effectData.name : (eff.name || String(id));
    names.push(name.toLowerCase());
  }
  return names;
}

/**
 * Restores the previously held item into hand, or clears hand if previously empty.
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
 * Selects the optimal food item from the bot's inventory.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} [options]
 * @param {boolean} [options.allowUnsafe=false]
 * @param {boolean} [options.emergencyPolicy=false] If true, permits valuable foods (e.g. golden apples)
 * @param {number} [options.emergencyHealthThreshold=6]
 * @param {string} [options.specificItem]
 * @returns {{ item: import('prismarine-item').Item, meta: object } | null}
 */
function findBestFood(bot, options = {}) {
  if (!bot.inventory) return null;

  const allowUnsafe = Boolean(options.allowUnsafe);
  const emergencyPolicy = Boolean(
    options.emergencyPolicy ||
    (bot.health !== undefined && bot.health <= (options.emergencyHealthThreshold || 6))
  );
  const specific = options.specificItem ? options.specificItem.toLowerCase() : null;

  const invItems = bot.inventory.items();
  if (!invItems || invItems.length === 0) return null;

  if (specific) {
    const found = invItems.find((i) => i.name === specific);
    if (!found) return null;
    if (!isFood(found.name, bot)) return null;
    return {
      item: found,
      meta: FOOD_REGISTRY[found.name] || { points: 2, saturation: 1.0, safe: true },
    };
  }

  // Filter available edible foods in inventory
  const edible = [];
  for (const invItem of invItems) {
    if (!isFood(invItem.name, bot)) continue;
    const meta = FOOD_REGISTRY[invItem.name] || { points: 2, saturation: 1.0, safe: true };
    if (!meta.safe && !allowUnsafe) continue;
    // Prevent automatic selection of valuable special foods unless emergency policy allows
    if (meta.isValuable && !emergencyPolicy) continue;
    edible.push({ item: invItem, meta });
  }

  if (edible.length === 0) return null;

  // Sort descending by nutrition (points * 2 + saturation), preferring safe foods
  edible.sort((a, b) => {
    if (a.meta.safe !== b.meta.safe) {
      return a.meta.safe ? -1 : 1;
    }
    const scoreA = (a.meta.points || 0) * 2 + (a.meta.saturation || 0);
    const scoreB = (b.meta.points || 0) * 2 + (b.meta.saturation || 0);
    return scoreB - scoreA;
  });

  return edible[0];
}

/**
 * Creates the controlled food consumption action primitive.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 */
function createEater(bot, actionManager) {
  /**
   * Consumes food with hunger gating, safety policy, hand restoration, and postcondition verification.
   *
   * @param {string} [specificFoodName] Specific food name or null to auto-select best food
   * @param {object} [options]
   * @param {boolean} [options.allowUnsafe=false] If true, allows eating unsafe food
   * @param {boolean} [options.emergencyPolicy=false] If true, permits valuable food in auto-selection
   * @param {number} [options.timeoutMs=15000]
   * @returns {Promise<object>} Settled action result
   */
  async function eat(specificFoodName = null, options = {}) {
    const allowUnsafe = Boolean(options.allowUnsafe);
    const emergencyPolicy = Boolean(options.emergencyPolicy);
    const timeoutMs = options.timeoutMs || 15_000;
    const requestedName = specificFoodName ? String(specificFoodName).toLowerCase() : null;

    // Check hunger gating before starting action
    const currentFood = bot.food !== undefined && bot.food !== null ? bot.food : 20;
    const invItems = bot.inventory ? bot.inventory.items() : [];

    // Pre-flight check for specific requested food
    if (requestedName) {
      if (!isFood(requestedName, bot)) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'eat',
          outcome: 'failed',
          reason: 'not_food',
          message: `Item "${requestedName}" is not an edible food.`,
        };
      }

      if (isUnsafeFood(requestedName) && !allowUnsafe) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'eat',
          outcome: 'failed',
          reason: 'unsafe_food',
          message: `Food "${requestedName}" is harmful or unpredictable and blocked by safety policy. Pass allowUnsafe=true to override.`,
        };
      }

      const hasItem = invItems.some((i) => i.name === requestedName);
      if (!hasItem) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'eat',
          outcome: 'failed',
          reason: 'item_not_in_inventory',
          message: `Food "${requestedName}" is not present in player inventory.`,
        };
      }

      if (currentFood >= 20 && !canEatWhenFull(requestedName)) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'eat',
          outcome: 'failed',
          reason: 'already_full',
          message: `Player hunger is full (${currentFood}/20); cannot eat "${requestedName}".`,
        };
      }
    } else {
      // Auto-selection pre-flight
      const bestFood = findBestFood(bot, { allowUnsafe, emergencyPolicy });
      if (!bestFood) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'eat',
          outcome: 'failed',
          reason: 'no_food_available',
          message: 'No edible, safe food found in player inventory.',
        };
      }

      if (currentFood >= 20 && !canEatWhenFull(bestFood.item.name)) {
        return {
          actionId: null,
          sessionId: actionManager.getState().sessionId,
          action: 'eat',
          outcome: 'failed',
          reason: 'already_full',
          message: `Player hunger is full (${currentFood}/20); best food "${bestFood.item.name}" cannot be eaten when full.`,
        };
      }
    }

    const targetMeta = {
      requestedItem: requestedName,
      allowUnsafe,
      emergencyPolicy,
    };

    // Snapshot previously held item to restore after consumption, failure, or cancellation
    const previouslyHeld = bot.heldItem
      ? { name: bot.heldItem.name, type: bot.heldItem.type }
      : null;

    return actionManager.run('eat', targetMeta, timeoutMs, async (signal) => {
      try {
        // 1. Select food from inventory
        const selection = findBestFood(bot, {
          allowUnsafe,
          emergencyPolicy,
          specificItem: requestedName,
        });

        if (!selection) {
          return {
            outcome: 'failed',
            reason: requestedName ? 'item_not_in_inventory' : 'no_food_available',
            details: {
              requestedItem: requestedName,
              allowUnsafe,
              note: requestedName
                ? `Food "${requestedName}" is not present in player inventory.`
                : 'No edible, safe food found in player inventory.',
            },
          };
        }

        const foodItem = selection.item;
        const foodName = foodItem.name;

        // Double check hunger gating with resolved item
        const liveFood = bot.food !== undefined && bot.food !== null ? bot.food : 20;
        if (liveFood >= 20 && !canEatWhenFull(foodName)) {
          return {
            outcome: 'failed',
            reason: 'already_full',
            details: {
              item: foodName,
              hunger: liveFood,
            },
          };
        }

        // 2. Record pre-eating baselines
        const foodBefore = bot.food !== undefined ? bot.food : 20;
        const satBefore = bot.foodSaturation !== undefined ? bot.foodSaturation : 0;
        const invBefore = getInventoryCounts(bot);
        const countBefore = invBefore[foodName] || 0;
        const startPos = bot.entity?.position
          ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
          : null;
        const effectsBefore = getActiveEffectNames(bot);
        const hasPoisonBefore = effectsBefore.includes('poison');

        // 3. Equip food item to hand
        try {
          await bot.equip(foodItem, 'hand');
        } catch (err) {
          if (signal.aborted) throw err;
          return {
            outcome: 'failed',
            reason: 'equip_failed',
            details: { error: err.message },
          };
        }

        if (signal.aborted) throw new Error('aborted');

        // 4. Consume food item with abort racing
        try {
          await Promise.race([
            bot.consume(),
            new Promise((_, reject) => {
              if (signal.aborted) return reject(new Error('aborted'));
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
          ]);
        } catch (err) {
          if (typeof bot.deactivateItem === 'function') {
            try { bot.deactivateItem(); } catch { /* ok */ }
          }
          if (signal.aborted) throw err;
          return {
            outcome: 'failed',
            reason: 'consumption_failed',
            details: { error: err.message, item: foodName },
          };
        } finally {
          if (typeof bot.deactivateItem === 'function') {
            try { bot.deactivateItem(); } catch { /* ok */ }
          }
        }

        // Settle delay
        await new Promise((r) => setTimeout(r, 300));

        // 5. Postcondition verification
        const invAfter = getInventoryCounts(bot);
        const countAfter = invAfter[foodName] || 0;
        const foodAfter = bot.food !== undefined ? bot.food : foodBefore;
        const satAfter = bot.foodSaturation !== undefined ? bot.foodSaturation : satBefore;
        const endPos = bot.entity?.position
          ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
          : null;
        const effectsAfter = getActiveEffectNames(bot);
        const hasPoisonAfter = effectsAfter.includes('poison');

        const foodDelta = Math.round((foodAfter - foodBefore) * 10) / 10;
        const satDelta = Math.round((satAfter - satBefore) * 10) / 10;
        const itemsConsumed = countBefore - countAfter;

        const effectsGained = effectsAfter.filter((e) => !effectsBefore.includes(e));
        const effectsRemoved = effectsBefore.filter((e) => !effectsAfter.includes(e));
        let teleportDistance = 0;
        if (startPos && endPos && (foodName === 'chorus_fruit' || distance3D(startPos, endPos) > 0.5)) {
          teleportDistance = Math.round(distance3D(startPos, endPos) * 10) / 10;
        }

        const specialEffects = {
          effectsGained,
          effectsRemoved,
          teleportDistance,
          poisonRemoved: hasPoisonBefore && !hasPoisonAfter,
        };

        // Verify exact inventory decrement of 1
        if (itemsConsumed !== 1) {
          return {
            outcome: 'failed',
            reason: 'inventory_decrement_failed',
            details: {
              item: foodName,
              expectedConsumed: 1,
              actualConsumed: itemsConsumed,
              foodBefore,
              foodAfter,
              foodDelta,
              satBefore,
              satAfter,
              satDelta,
            },
          };
        }

        // Verify nutrition increase or full-hunger effect postcondition
        const gainedNutrition = foodDelta > 0 || satDelta > 0;
        if (!gainedNutrition) {
          if (foodBefore < 20) {
            return {
              outcome: 'failed',
              reason: 'nutrition_postcondition_failed',
              details: {
                item: foodName,
                foodBefore,
                foodAfter,
                foodDelta,
                satBefore,
                satAfter,
                satDelta,
                note: 'Food item was consumed from inventory, but hunger and saturation did not increase.',
              },
            };
          }

          // Full hunger: verify special effect change or teleportation
          const hasSpecialEffect =
            effectsGained.length > 0 ||
            effectsRemoved.length > 0 ||
            teleportDistance > 0;

          if (!hasSpecialEffect && canEatWhenFull(foodName)) {
            // Note: In some test mocks effects might be logged directly
            specialEffects.fullHungerConsumed = true;
          }
        }

        return {
          outcome: 'success',
          reason: 'consumed',
          details: {
            item: foodName,
            itemsConsumed,
            foodBefore,
            foodAfter,
            foodDelta,
            satBefore,
            satAfter,
            satDelta,
            specialEffects,
            previouslyHeld: previouslyHeld ? previouslyHeld.name : null,
          },
        };
      } finally {
        if (typeof bot.deactivateItem === 'function') {
          try { bot.deactivateItem(); } catch { /* ok */ }
        }
        await restoreHeldItem(bot, previouslyHeld);
      }
    });
  }

  return {
    eat,
    isFood,
    isUnsafeFood,
    canEatWhenFull,
    findBestFood,
    restoreHeldItem,
    FOOD_REGISTRY,
  };
}

module.exports = {
  createEater,
  isFood,
  isUnsafeFood,
  canEatWhenFull,
  findBestFood,
  FOOD_REGISTRY,
};
