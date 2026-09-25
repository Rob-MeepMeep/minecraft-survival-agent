'use strict';

const { isInventoryFull } = require('./gather');

const VALID_DESTINATIONS = new Set(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']);

/**
 * Checks whether an item can be equipped to a given destination slot.
 * Hand and off-hand can accept any item.
 * Armor slots require appropriate armor piece or skull/pumpkin/elytra.
 *
 * @param {string} itemName
 * @param {string} destination
 * @returns {boolean}
 */
function isCompatibleDestination(itemName, destination) {
  if (destination === 'hand' || destination === 'off-hand') return true;
  if (!itemName || typeof itemName !== 'string') return false;
  const name = itemName.toLowerCase();
  switch (destination) {
    case 'head':
      return name.endsWith('_helmet') || name.endsWith('_head') || name.endsWith('_skull') || name === 'carved_pumpkin' || name === 'turtle_helmet';
    case 'torso':
      return name.endsWith('_chestplate') || name === 'elytra';
    case 'legs':
      return name.endsWith('_leggings');
    case 'feet':
      return name.endsWith('_boots');
    default:
      return false;
  }
}

/**
 * Resolves destination slot index for a given equipment destination.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} destination
 * @returns {number | null}
 */
function getDestSlot(bot, destination) {
  if (typeof bot?.getEquipmentDestSlot === 'function') {
    return bot.getEquipmentDestSlot(destination);
  }
  // Standard Java Edition fallback slot indices
  switch (destination) {
    case 'head': return 5;
    case 'torso': return 6;
    case 'legs': return 7;
    case 'feet': return 8;
    case 'hand': return bot?.quickBarSlot !== undefined ? bot.quickBarSlot + 36 : 36;
    case 'off-hand': return 45;
    default: return null;
  }
}

/**
 * Creates equipment action primitive wired into ActionManager.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 */
function createEquipper(bot, actionManager) {
  /**
   * Equips an item to the specified destination and verifies postcondition.
   *
   * @param {string} itemName Item name to equip
   * @param {'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'} [destination='hand']
   * @param {object} [options]
   * @param {number} [options.timeoutMs=10000]
   * @returns {Promise<object>} Settled action result
   */
  async function equip(itemName, destination = 'hand', options = {}) {
    const dest = String(destination || 'hand').toLowerCase();
    const timeoutMs = options.timeoutMs || 10_000;

    if (!VALID_DESTINATIONS.has(dest)) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'equip',
        outcome: 'failed',
        reason: 'invalid_destination',
        message: `Invalid equipment destination "${dest}". Valid destinations: ${Array.from(VALID_DESTINATIONS).join(', ')}`,
      };
    }

    if (!itemName || typeof itemName !== 'string') {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'equip',
        outcome: 'failed',
        reason: 'invalid_item_name',
        message: 'Must specify a valid item name to equip',
      };
    }

    if (!isCompatibleDestination(itemName, dest)) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'equip',
        outcome: 'failed',
        reason: 'incompatible_slot',
        message: `Item "${itemName}" is incompatible with equipment slot "${dest}".`,
      };
    }

    const targetMeta = {
      item: itemName,
      destination: dest,
    };

    return actionManager.run('equip', targetMeta, timeoutMs, async (signal) => {
      // 1. Locate item in inventory
      if (!bot.inventory) {
        return {
          outcome: 'failed',
          reason: 'inventory_not_ready',
        };
      }

      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) {
        return {
          outcome: 'failed',
          reason: 'item_not_in_inventory',
          details: {
            item: itemName,
            destination: dest,
            note: `Item "${itemName}" is not present in player inventory.`,
          },
        };
      }

      const destSlot = getDestSlot(bot, dest);

      // Check for currently equipped item in this slot (to track displacement)
      let previousItemName = null;
      if (dest === 'hand') {
        previousItemName = bot.heldItem?.name || (destSlot !== null ? bot.inventory?.slots?.[destSlot]?.name : null);
      } else if (destSlot !== null) {
        previousItemName = bot.inventory?.slots?.[destSlot]?.name || null;
      }

      // 2. Perform equip
      try {
        await bot.equip(item, dest);
      } catch (err) {
        if (signal.aborted) throw err;
        return {
          outcome: 'failed',
          reason: 'equip_failed',
          details: { error: err.message },
        };
      }

      // Settle delay
      await new Promise((r) => setTimeout(r, 200));

      // 3. Postcondition verification
      let matches = false;
      if (dest === 'hand') {
        matches = bot.heldItem?.name === itemName ||
          (destSlot !== null && bot.inventory?.slots?.[destSlot]?.name === itemName);
      } else if (destSlot !== null) {
        matches = bot.inventory?.slots?.[destSlot]?.name === itemName;
      }

      if (!matches) {
        return {
          outcome: 'failed',
          reason: 'postcondition_failed',
          details: {
            item: itemName,
            destination: dest,
            destSlot,
            actualItem: dest === 'hand' ? bot.heldItem?.name : bot.inventory?.slots?.[destSlot]?.name,
          },
        };
      }

      // Verify displaced item returned to inventory if slot was previously occupied
      const displacedItem = (previousItemName && previousItemName !== itemName) ? previousItemName : null;
      if (displacedItem) {
        const stillInInventory = bot.inventory.items().some((i) => i.name === displacedItem);
        if (!stillInInventory) {
          return {
            outcome: 'failed',
            reason: 'displaced_item_lost',
            details: {
              item: itemName,
              destination: dest,
              destSlot,
              displacedItem,
              note: `Previously equipped item "${displacedItem}" was not found in inventory after displacement.`,
            },
          };
        }
      }

      return {
        outcome: 'success',
        reason: 'item_equipped',
        details: {
          item: itemName,
          destination: dest,
          destSlot,
          displacedItem,
        },
      };
    });
  }

  /**
   * Unequips an item from the specified destination and verifies slot is empty.
   *
   * @param {'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'} [destination='hand']
   * @param {object} [options]
   * @param {number} [options.timeoutMs=10000]
   * @returns {Promise<object>} Settled action result
   */
  async function unequip(destination = 'hand', options = {}) {
    const dest = String(destination || 'hand').toLowerCase();
    const timeoutMs = options.timeoutMs || 10_000;

    if (!VALID_DESTINATIONS.has(dest)) {
      return {
        actionId: null,
        sessionId: actionManager.getState().sessionId,
        action: 'unequip',
        outcome: 'failed',
        reason: 'invalid_destination',
        message: `Invalid equipment destination "${dest}". Valid destinations: ${Array.from(VALID_DESTINATIONS).join(', ')}`,
      };
    }

    const destSlot = getDestSlot(bot, dest);

    const targetMeta = {
      destination: dest,
      destSlot,
    };

    return actionManager.run('unequip', targetMeta, timeoutMs, async (signal) => {
      // 1. Inspect current slot
      let currentItemName = null;
      if (dest === 'hand') {
        currentItemName = bot.heldItem?.name || (destSlot !== null ? bot.inventory?.slots?.[destSlot]?.name : null);
      } else if (destSlot !== null) {
        currentItemName = bot.inventory?.slots?.[destSlot]?.name || null;
      }

      if (!currentItemName) {
        return {
          outcome: 'success',
          reason: 'already_empty',
          details: {
            destination: dest,
            destSlot,
          },
        };
      }

      // Check if main inventory is full and cannot accept unequipped item
      if (isInventoryFull(bot, currentItemName)) {
        return {
          outcome: 'failed',
          reason: 'inventory_full',
          details: {
            destination: dest,
            destSlot,
            item: currentItemName,
            note: 'Cannot unequip item because player inventory is full.',
          },
        };
      }

      // 2. Perform unequip
      try {
        await bot.unequip(dest);
      } catch (err) {
        if (signal.aborted) throw err;
        return {
          outcome: 'failed',
          reason: 'unequip_failed',
          details: { error: err.message },
        };
      }

      // Settle delay
      await new Promise((r) => setTimeout(r, 200));

      // 3. Postcondition verification: destination slot should now be empty
      let empty = false;
      if (dest === 'hand') {
        empty = !bot.heldItem || !bot.inventory?.slots?.[destSlot];
      } else if (destSlot !== null) {
        empty = !bot.inventory?.slots?.[destSlot];
      }

      if (!empty) {
        return {
          outcome: 'failed',
          reason: 'unequip_postcondition_failed',
          details: {
            destination: dest,
            destSlot,
            remainingItem: dest === 'hand' ? bot.heldItem?.name : bot.inventory?.slots?.[destSlot]?.name,
          },
        };
      }

      return {
        outcome: 'success',
        reason: 'item_unequipped',
        details: {
          destination: dest,
          destSlot,
          unequippedItem: currentItemName,
        },
      };
    });
  }

  return {
    equip,
    unequip,
    getDestSlot: (d) => getDestSlot(bot, d),
    VALID_DESTINATIONS,
  };
}

module.exports = {
  createEquipper,
  getDestSlot,
  VALID_DESTINATIONS,
};
