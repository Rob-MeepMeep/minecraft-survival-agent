'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAttacker,
  isFoodAnimal,
  isEligibleAdultAnimal,
  countEligibleAdults,
  findNearestFoodAnimal,
  FOOD_ANIMAL_TYPES,
  ANIMAL_DROPS,
} = require('../src/actions/attack');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockManager({ failWith = null, busy = false } = {}) {
  return {
    get isBusy() { return busy; },
    _stopBotMovement() {},

    async run(actionName, target, timeoutMs, executeFn) {
      if (busy) {
        return { actionId: null, action: actionName, outcome: 'failed', reason: 'action_in_flight' };
      }
      if (failWith) {
        return { actionId: 'action-x', action: actionName, outcome: 'failed', reason: failWith };
      }

      const abortController = new AbortController();
      const actionRecord = { actionId: 'action-1', ended: false, actionName };

      let result;
      try {
        result = await executeFn(abortController.signal, 'action-1', actionRecord);
      } catch (err) {
        result = { outcome: 'failed', reason: err.message };
      }

      return {
        actionId: 'action-1',
        action: actionName,
        outcome: result.outcome || 'failed',
        reason: result.reason || 'ok',
        ...result.details,
        details: result.details || {},
      };
    },
  };
}

function makeMockBot({ entities = {}, inventoryItems = [] } = {}) {
  return {
    entities,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items() { return inventoryItems; },
    },
    pathfinder: {
      stop: () => {},
      setGoal: () => {},
    },
    async attack(entity) {
      delete this.entities[entity.id];
    },
  };
}

// ---------------------------------------------------------------------------
// 1. isFoodAnimal
// ---------------------------------------------------------------------------

describe('isFoodAnimal', () => {
  it('correctly identifies food animals', () => {
    assert.equal(isFoodAnimal('chicken'), true);
    assert.equal(isFoodAnimal('cow'), true);
    assert.equal(isFoodAnimal('pig'), true);
    assert.equal(isFoodAnimal('sheep'), true);
    assert.equal(isFoodAnimal('rabbit'), true);
  });

  it('rejects non-food entities', () => {
    assert.equal(isFoodAnimal('zombie'), false);
    assert.equal(isFoodAnimal('creeper'), false);
    assert.equal(isFoodAnimal('wolf'), false);
    assert.equal(isFoodAnimal('player'), false);
  });
});

// ---------------------------------------------------------------------------
// 2. isEligibleAdultAnimal
// ---------------------------------------------------------------------------

describe('isEligibleAdultAnimal', () => {
  it('accepts normal adult food animals', () => {
    const cow = { id: 1, name: 'cow', isBaby: false };
    assert.equal(isEligibleAdultAnimal(cow), true);
  });

  it('rejects baby animals (isBaby: true)', () => {
    const babyCow = { id: 2, name: 'cow', isBaby: true };
    assert.equal(isEligibleAdultAnimal(babyCow), false);
  });

  it('rejects baby animals via metadata index 16 negative age', () => {
    const babyPig = { id: 3, name: 'pig', metadata: { 16: -24000 } };
    assert.equal(isEligibleAdultAnimal(babyPig), false);
  });

  it('rejects named animals (customName)', () => {
    const namedCow = { id: 4, name: 'cow', customName: 'Bessie' };
    assert.equal(isEligibleAdultAnimal(namedCow), false);
  });

  it('rejects leashed animals (leashed: true)', () => {
    const leashedSheep = { id: 5, name: 'sheep', leashed: true };
    assert.equal(isEligibleAdultAnimal(leashedSheep), false);
  });
});

// ---------------------------------------------------------------------------
// 3. findNearestFoodAnimal & Population Preservation
// ---------------------------------------------------------------------------

describe('findNearestFoodAnimal & countEligibleAdults', () => {
  it('returns null when fewer than 3 adults of species exist (< 3 preserves breeding pair)', () => {
    const bot = makeMockBot({
      entities: {
        10: { id: 10, name: 'cow', position: { x: 5, y: 64, z: 0 } },
        11: { id: 11, name: 'cow', position: { x: 6, y: 64, z: 0 } }, // only 2 cows!
      },
    });
    assert.equal(countEligibleAdults(bot, 'cow', 16), 2);
    const result = findNearestFoodAnimal(bot, 'cow', 16);
    assert.equal(result, null, 'Must preserve breeding pair when < 3 adults present');
  });

  it('finds nearest adult when at least 3 eligible adults exist', () => {
    const bot = makeMockBot({
      entities: {
        10: { id: 10, name: 'cow', position: { x: 5, y: 64, z: 0 } },
        11: { id: 11, name: 'cow', position: { x: 8, y: 64, z: 0 } },
        12: { id: 12, name: 'cow', position: { x: 10, y: 64, z: 0 } },
      },
    });
    assert.equal(countEligibleAdults(bot, 'cow', 16), 3);
    const result = findNearestFoodAnimal(bot, 'cow', 16);
    assert.ok(result);
    assert.equal(result.type, 'cow');
    assert.equal(result.entity.id, 10);
  });
});

// ---------------------------------------------------------------------------
// 4. attack primitive
// ---------------------------------------------------------------------------

describe('createAttacker — attack primitive', () => {
  it('rejects if action is already in flight', async () => {
    const bot = makeMockBot();
    const manager = makeMockManager({ busy: true });
    const { attack } = createAttacker(bot, manager);
    const result = await attack('cow');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'action_in_flight');
  });

  it('fails with entity_not_found when no matching entity exists', async () => {
    const bot = makeMockBot({ entities: {} });
    const manager = makeMockManager();
    const { attack } = createAttacker(bot, manager);
    const result = await attack('cow', { timeoutMs: 500 });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'entity_not_found');
  });

  it('fails with population_preservation_limit when fewer than 3 adults exist', async () => {
    const bot = makeMockBot({
      entities: {
        1: { id: 1, name: 'cow', position: { x: 2, y: 64, z: 0 } },
        2: { id: 2, name: 'cow', position: { x: 3, y: 64, z: 0 } },
      },
    });
    const manager = makeMockManager();
    const { attack } = createAttacker(bot, manager);
    // Explicit targeting of cow ID 1
    const result = await attack(1, { timeoutMs: 2000 });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'population_preservation_limit');
  });

  it('navigates to entity, attacks, tracks damage and confirms kill with loot attribution', async () => {
    const entities = {
      1: { id: 1, name: 'cow', health: 10, position: { x: 2, y: 64, z: 0 } },
      2: { id: 2, name: 'cow', health: 10, position: { x: 4, y: 64, z: 0 } },
      3: { id: 3, name: 'cow', health: 10, position: { x: 6, y: 64, z: 0 } },
    };
    let inventoryItems = [];

    const bot = {
      entities,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => inventoryItems },
      pathfinder: { stop: () => {}, setGoal: () => {} },
      async attack(entity) {
        inventoryItems = [{ name: 'raw_beef', count: 2 }, { name: 'leather', count: 1 }];
        delete entities[entity.id];
      },
    };

    const manager = makeMockManager();
    const { attack } = createAttacker(bot, manager);
    const result = await attack('cow', { timeoutMs: 5000, meleeRange: 5 });

    assert.equal(result.outcome, 'success');
    assert.equal(result.reason, 'death_confirmed');
    assert.equal(result.deathConfirmed, true);
    assert.equal(result.damageConfirmed, true);
    assert.ok(result.hitAttempted >= 1);

    const loot = result.matchedLoot || result.details?.matchedLoot;
    assert.ok(loot);
    assert.ok(loot.some(l => l.name === 'raw_beef' && l.delta === 2));
  });

  it('returns timed_out when entity survives timeout', async () => {
    const entities = {
      1: { id: 1, name: 'pig', health: 10, position: { x: 2, y: 64, z: 0 } },
      2: { id: 2, name: 'pig', health: 10, position: { x: 4, y: 64, z: 0 } },
      3: { id: 3, name: 'pig', health: 10, position: { x: 6, y: 64, z: 0 } },
    };

    const bot = {
      entities,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] },
      pathfinder: { stop: () => {}, setGoal: () => {} },
      async attack() {
        // Does not die
      },
    };

    const manager = makeMockManager();
    const { attack } = createAttacker(bot, manager);
    const result = await attack('pig', { timeoutMs: 600, meleeRange: 5 });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'timed_out');
    assert.equal(result.deathConfirmed, false);
  });

  it('returns cancelled_before_first_hit when cancelled before swing', async () => {
    const entities = {
      1: { id: 1, name: 'cow', position: { x: 10, y: 64, z: 0 } },
      2: { id: 2, name: 'cow', position: { x: 12, y: 64, z: 0 } },
      3: { id: 3, name: 'cow', position: { x: 14, y: 64, z: 0 } },
    };

    const bot = {
      entities,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] },
      pathfinder: { stop: () => {}, setGoal: () => {} },
      async attack() {},
    };

    const cancelManager = {
      get isBusy() { return false; },
      async run(actionName, target, timeoutMs, executeFn) {
        const abortController = new AbortController();
        const actionRecord = { actionId: 'cancel-1', ended: false };
        // Abort immediately before navigation finishes
        setTimeout(() => abortController.abort(), 0);

        const result = await executeFn(abortController.signal, 'cancel-1', actionRecord);
        return { actionId: 'cancel-1', action: actionName, outcome: result.outcome, reason: result.reason, details: result.details || {} };
      },
    };

    const { attack } = createAttacker(bot, cancelManager);
    const result = await attack('cow', { timeoutMs: 5000 });

    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.reason, 'cancelled_before_first_hit');
  });

  it('returns cancelled_after_effect when cancelled after swing attempted', async () => {
    const entities = {
      1: { id: 1, name: 'cow', health: 10, position: { x: 1, y: 64, z: 0 } },
      2: { id: 2, name: 'cow', health: 10, position: { x: 2, y: 64, z: 0 } },
      3: { id: 3, name: 'cow', health: 10, position: { x: 3, y: 64, z: 0 } },
    };

    let attackAttempted = false;
    let abortCtrl = null;

    const bot = {
      entities,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] },
      pathfinder: { stop: () => {}, setGoal: () => {} },
      async attack() {
        attackAttempted = true;
        // Abort right after attack swing
        if (abortCtrl) abortCtrl.abort();
      },
    };

    const lateCancelManager = {
      get isBusy() { return false; },
      async run(actionName, target, timeoutMs, executeFn) {
        abortCtrl = new AbortController();
        const actionRecord = { actionId: 'cancel-2', ended: false };

        const result = await executeFn(abortCtrl.signal, 'cancel-2', actionRecord);
        return { actionId: 'cancel-2', action: actionName, outcome: result.outcome, reason: result.reason, details: result.details || {} };
      },
    };

    const { attack } = createAttacker(bot, lateCancelManager);
    const result = await attack('cow', { timeoutMs: 5000, meleeRange: 5 });

    assert.equal(result.outcome, 'cancelled_after_effect');
    assert.equal(result.reason, 'cancelled_after_effect');
    assert.ok(result.details.hitAttempted >= 1);
  });
});
