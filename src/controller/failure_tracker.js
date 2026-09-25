'use strict';

/**
 * Tracks failures, fine-grained target cooldowns, and dispatched action budgets
 * for a SurvivalController instance.
 */
class FailureTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.defaultCooldownMs=10000] - Default cooldown duration when an action fails.
   * @param {number} [options.maxDispatchedActions=20] - Max dispatched actions allowed before budget exhaustion.
   */
  constructor(options = {}) {
    this.defaultCooldownMs = options.defaultCooldownMs ?? 10000;
    this.maxDispatchedActions = options.maxDispatchedActions ?? 500;
    this.maxDispatchedPerGoal = options.maxDispatchedPerGoal ?? 150;

    /** @type {Map<string, { count: number, lastFailedAt: number, cooldownUntil: number, lastReason: string }>} */
    this.failures = new Map();

    /** @type {number} */
    this.dispatchedCount = 0;

    /** @type {Map<string, number>} */
    this.goalDispatched = new Map();
  }

  /**
   * Constructs an action signature scoped by action name and specific target coordinate/identifier.
   *
   * @param {string} action
   * @param {string|object} [target]
   * @returns {string}
   */
  static makeKey(action, target) {
    if (!target) return action;
    if (typeof target === 'string') return `${action}:${target}`;
    if (target.x !== undefined && target.y !== undefined && target.z !== undefined) {
      const coord = `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`;
      return `${action}:${coord}`;
    }
    return `${action}:${JSON.stringify(target)}`;
  }

  /**
   * Records a successful action completion, resetting consecutive failure streak for the key.
   *
   * @param {string} key
   */
  recordSuccess(key) {
    this.failures.delete(key);
  }

  /**
   * Records a failed action and sets a temporary cooldown.
   *
   * @param {string} key
   * @param {string} [reason='failed']
   * @param {number} [cooldownMs]
   */
  recordFailure(key, reason = 'failed', cooldownMs = this.defaultCooldownMs) {
    const now = Date.now();
    const existing = this.failures.get(key) || { count: 0, lastFailedAt: 0, cooldownUntil: 0, lastReason: '' };
    this.failures.set(key, {
      count: existing.count + 1,
      lastFailedAt: now,
      cooldownUntil: now + cooldownMs,
      lastReason: reason,
    });
  }

  /**
   * Checks whether an action key is currently on cooldown.
   *
   * @param {string} key
   * @param {number} [now=Date.now()]
   * @returns {boolean}
   */
  isOnCooldown(key, now = Date.now()) {
    const entry = this.failures.get(key);
    if (!entry) return false;
    return now < entry.cooldownUntil;
  }

  /**
   * Checks whether an action key has exceeded a consecutive failure limit.
   *
   * @param {string} key
   * @param {number} [threshold=3]
   * @returns {boolean}
   */
  isBlacklisted(key, threshold = 3) {
    const entry = this.failures.get(key);
    return Boolean(entry && entry.count >= threshold);
  }

  /**
   * Increments the count of actual dispatched actions against the step budget.
   * Observation cycles and cooldown waiting do not increment this counter.
   *
   * @param {string} [goal]
   * @returns {number}
   */
  incrementDispatchedActions(goal = null) {
    this.dispatchedCount += 1;
    if (goal) {
      this.goalDispatched.set(goal, (this.goalDispatched.get(goal) || 0) + 1);
    }
    return this.dispatchedCount;
  }

  /**
   * @returns {number}
   */
  getDispatchedActions() {
    return this.dispatchedCount;
  }

  /**
   * @param {string} [goal]
   * @returns {number}
   */
  getDispatchedActionsForGoal(goal) {
    return goal ? (this.goalDispatched.get(goal) || 0) : 0;
  }

  /**
   * @param {string} [goal]
   * @returns {boolean}
   */
  isBudgetExceeded(goal = null) {
    if (this.dispatchedCount >= this.maxDispatchedActions) return true;
    if (goal && (this.goalDispatched.get(goal) || 0) >= this.maxDispatchedPerGoal) return true;
    return false;
  }

  /**
   * Resets all tracking state.
   */
  reset() {
    this.failures.clear();
    this.dispatchedCount = 0;
    this.goalDispatched.clear();
  }
}

module.exports = { FailureTracker };
