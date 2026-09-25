'use strict';

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { getInventoryCounts, computeInventoryDelta } = require('./gather');
const { createSafeMovements } = require('./navigate');

/**
 * Extracts expected output item and consumed ingredients from a recipe delta.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-recipe').Recipe} recipe
 * @param {number} [times=1]
 * @returns {{ output: { name: string, count: number }, consumed: Array<{ name: string, count: number }> }}
 */
function getRecipeDeltas(bot, recipe, times = 1) {
  if (!recipe || !recipe.delta) {
    return { output: null, consumed: [] };
  }

  const consumed = [];
  let output = null;

  for (const item of recipe.delta) {
    const itemName = bot?.registry?.items?.[item.id]?.name || item.name || `item_${item.id}`;
    if (item.count < 0) {
      consumed.push({
        name: itemName,
        count: Math.abs(item.count) * times,
      });
    } else if (item.count > 0) {
      output = {
        name: itemName,
        count: item.count * times,
      };
    }
  }

  // Fallback if recipe.delta lacked positive entry but recipe.result exists
  if (!output && recipe.result) {
    const resName = bot?.registry?.items?.[recipe.result.id]?.name || recipe.result.name;
    output = {
      name: resName,
      count: (recipe.result.count || 1) * times,
    };
  }

  return { output, consumed };
}

/**
 * Finds a suitable recipe for the given item name.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} itemName
 * @param {import('prismarine-block').Block | null} [craftingTableBlock=null]
 * @returns {import('prismarine-recipe').Recipe | null}
 */
function findRecipe(bot, itemName, craftingTableBlock = null) {
  if (!bot?.registry?.itemsByName?.[itemName]) {
    // Check fallback for unit test mocks if registry isn't complete
    if (typeof bot?.findRecipe === 'function') {
      return bot.findRecipe(itemName, craftingTableBlock);
    }
    return null;
  }

  const itemId = bot.registry.itemsByName[itemName].id;

  // First check if player has materials to craft it right now
  if (typeof bot.recipesFor === 'function') {
    const available = bot.recipesFor(itemId, null, 1, craftingTableBlock);
    if (available && available.length > 0) {
      return available[0];
    }
  }

  // Fallback to all possible recipes for this item to determine if it requires a table
  if (typeof bot.recipesAll === 'function') {
    const all = bot.recipesAll(itemId, null, craftingTableBlock);
    if (all && all.length > 0) {
      return all[0];
    }
  }

  return null;
}

/**
 * Searches for a nearby crafting table block within maxDistance.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} [maxDistance=16]
 * @returns {import('prismarine-block').Block | null}
 */
function findCraftingTable(bot, maxDistance = 32) {
  if (!bot.findBlock) return null;

  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  const matcher = tableId !== undefined
    ? tableId
    : (b) => b && b.name === 'crafting_table';

  return bot.findBlock({
    matching: matcher,
    maxDistance,
  });
}

/**
 * Creates the crafting action primitive wired into ActionManager.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 */
function createCrafter(bot, actionManager) {
  let movements = null;

  function getMovements() {
    if (!movements) {
      movements = createSafeMovements(bot);
    }
    return movements;
  }

  /**
   * Crafts an item with exact recipe and ingredient consumption verification.
   *
   * @param {string} itemName Name of item to craft
   * @param {number} [count=1] Number of craft iterations (default 1)
   * @param {object} [options]
   * @param {number} [options.maxDistance=32] Distance to search for crafting table
   * @param {number} [options.timeoutMs=30000] Action timeout
   * @returns {Promise<object>} Settled action result
   */
  async function craft(itemName, count = 1, options = {}) {
    const times = Math.max(1, Math.floor(count));
    const timeoutMs = options.timeoutMs || 30_000;
    const maxDistance = options.maxDistance || 32;

    if (!itemName || typeof itemName !== 'string') {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'craft',
        outcome: 'failed',
        reason: 'invalid_item_name',
        message: 'Must specify a valid item name to craft',
      };
    }

    // 1. Initial recipe inspection to check whether a crafting table is required
    let initialRecipe = findRecipe(bot, itemName, null);
    let requiresTable = initialRecipe ? Boolean(initialRecipe.requiresTable) : false;

    // If no 2x2 recipe found, inspect if 3x3 table recipe exists
    if (!initialRecipe) {
      // Create a dummy table block mock or query recipesAll with crafting table requirement
      const dummyTable = { name: 'crafting_table', position: new Vec3(0, 0, 0) };
      const tableRecipe = findRecipe(bot, itemName, dummyTable);
      if (tableRecipe) {
        requiresTable = true;
        initialRecipe = tableRecipe;
      }
    }

    const targetMeta = {
      item: itemName,
      times,
      requiresTable,
    };

    return actionManager.run('craft', targetMeta, timeoutMs, async (signal) => {
      let craftingTableBlock = null;

      // 2. If table is required, locate and approach crafting table
      if (requiresTable) {
        craftingTableBlock = findCraftingTable(bot, maxDistance);
        if (!craftingTableBlock) {
          return {
            outcome: 'failed',
            reason: 'no_crafting_table_nearby',
            details: {
              item: itemName,
              requiresTable: true,
              note: `Recipe for "${itemName}" requires a 3x3 crafting table, but none was found within ${maxDistance} blocks.`,
            },
          };
        }

        // Approach crafting table within safe reach (~2.5m)
        bot.pathfinder.setMovements(getMovements());
        const reachGoal = new goals.GoalNear(
          craftingTableBlock.position.x,
          craftingTableBlock.position.y,
          craftingTableBlock.position.z,
          2.5
        );

        try {
          await bot.pathfinder.goto(reachGoal);
        } catch (err) {
          if (signal.aborted) throw err;
          return {
            outcome: 'failed',
            reason: 'could_not_reach_crafting_table',
            details: { error: err.message },
          };
        }

        if (signal.aborted) throw new Error('aborted');
      }

      // 3. Find recipe with current context (with or without table)
      const recipe = findRecipe(bot, itemName, craftingTableBlock);
      if (!recipe) {
        return {
          outcome: 'failed',
          reason: 'missing_ingredients',
          details: {
            item: itemName,
            requiresTable,
            note: `Player lacks required ingredients in inventory to craft "${itemName}".`,
          },
        };
      }

      // Extract expected deltas
      const { output, consumed } = getRecipeDeltas(bot, recipe, times);
      const expectedOutputCount = output ? output.count : times;
      const expectedOutputName = output ? output.name : itemName;

      // 4. Record baseline inventory
      const invBefore = getInventoryCounts(bot);

      // Verify that inventory currently has enough of each consumed ingredient
      for (const ing of consumed) {
        const currentCount = invBefore[ing.name] || 0;
        if (currentCount < ing.count) {
          return {
            outcome: 'failed',
            reason: 'insufficient_ingredients',
            details: {
              item: itemName,
              ingredient: ing.name,
              required: ing.count,
              available: currentCount,
            },
          };
        }
      }

      // 5. Execute craft
      try {
        await Promise.race([
          bot.craft(recipe, times, craftingTableBlock),
          new Promise((_, reject) => {
            if (signal.aborted) return reject(new Error('aborted'));
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        ]);
      } catch (err) {
        // Close window if left open
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch { /* ok */ }
        }
        if (signal.aborted) throw err;
        return {
          outcome: 'failed',
          reason: 'crafting_execution_failed',
          details: { error: err.message },
        };
      } finally {
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch { /* ok */ }
        }
      }

      // Settle inventory
      await new Promise((r) => setTimeout(r, 400));

      // 6. Postcondition verification
      const invAfter = getInventoryCounts(bot);
      const deltas = computeInventoryDelta(invBefore, invAfter);
      const deltaMap = Object.fromEntries(deltas.map((d) => [d.name, d.delta]));

      const actualOutputDelta = deltaMap[expectedOutputName] || 0;

      // Verify output item gained
      if (actualOutputDelta < expectedOutputCount) {
        return {
          outcome: 'failed',
          reason: 'output_not_received',
          details: {
            item: expectedOutputName,
            expectedYield: expectedOutputCount,
            actualYield: actualOutputDelta,
            consumed,
            deltas,
          },
        };
      }

      // Verify ingredient consumption
      const missingConsumption = [];
      for (const ing of consumed) {
        const actualConsumed = -(deltaMap[ing.name] || 0);
        if (actualConsumed < ing.count) {
          missingConsumption.push({
            name: ing.name,
            expectedConsumed: ing.count,
            actualConsumed,
          });
        }
      }

      if (missingConsumption.length > 0) {
        return {
          outcome: 'partial',
          reason: 'ingredient_consumption_mismatch',
          details: {
            item: expectedOutputName,
            yield: actualOutputDelta,
            missingConsumption,
            deltas,
          },
        };
      }

      return {
        outcome: 'success',
        reason: 'crafted_item',
        details: {
          item: expectedOutputName,
          yield: actualOutputDelta,
          consumed,
          requiresTable,
          tablePos: craftingTableBlock ? craftingTableBlock.position : null,
          deltas,
        },
      };
    });
  }

  return {
    craft,
    findRecipe,
    findCraftingTable,
    getRecipeDeltas,
  };
}

module.exports = {
  createCrafter,
  findRecipe,
  findCraftingTable,
  getRecipeDeltas,
};
