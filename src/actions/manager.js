'use strict';

/**
 * Manages single-flight action execution, unique action IDs,
 * bounded timeouts, and cancellation hooks (pause, quit, death, disconnect).
 */
class ActionManager {
  /**
   * @param {object} params
   * @param {import('mineflayer').Bot} params.bot
   * @param {() => { active: boolean, ready: boolean, sessionId: number }} params.getState
   * @param {object} params.telemetry
   */
  constructor({ bot, getState, telemetry }) {
    this.bot = bot;
    this.getState = getState;
    this.telemetry = telemetry;
    this.actionCounter = 0;
    this.currentAction = null;
  }

  /**
   * True if an action is currently executing.
   */
  get isBusy() {
    return this.currentAction !== null;
  }

  /**
   * Returns current action summary or null.
   */
  getStatus() {
    if (!this.currentAction) return null;
    return {
      actionId: this.currentAction.actionId,
      sessionId: this.currentAction.sessionId,
      action: this.currentAction.actionName,
      elapsedMs: Date.now() - this.currentAction.startedAt,
      target: this.currentAction.target,
    };
  }

  /**
   * Executes a bounded, cancellable action primitive.
   * Enforces single-flight concurrency: rejects if another action is in progress.
   * Guarantees EXACTLY ONE action_end is emitted per action run.
   *
   * @param {string} actionName
   * @param {object} target
   * @param {number} timeoutMs
   * @param {(signal: AbortSignal, actionId: string) => Promise<object>} executeFn
   * @returns {Promise<object>} Settled action result
   */
  async run(actionName, target, timeoutMs, executeFn) {
    const state = this.getState();
    if (!state.active || !state.ready) {
      return {
        actionId: null,
        sessionId: state.sessionId,
        action: actionName,
        outcome: 'failed',
        reason: 'agent_not_ready',
        message: 'Agent is not spawned or not ready',
      };
    }

    if (this.currentAction) {
      return {
        actionId: null,
        sessionId: state.sessionId,
        action: actionName,
        outcome: 'failed',
        reason: 'action_in_flight',
        message: `Action ${this.currentAction.actionId} (${this.currentAction.actionName}) is already running`,
      };
    }

    const actionId = `action-${++this.actionCounter}`;
    const sessionId = state.sessionId;
    const startedAt = Date.now();
    const abortController = new AbortController();
    const { signal } = abortController;

    const actionRecord = {
      actionId,
      sessionId,
      actionName,
      startedAt,
      target,
      abortController,
      timeoutHandle: null,
    };

    this.currentAction = actionRecord;

    const startPos = this.bot.entity?.position
      ? {
          x: Math.round(this.bot.entity.position.x * 10) / 10,
          y: Math.round(this.bot.entity.position.y * 10) / 10,
          z: Math.round(this.bot.entity.position.z * 10) / 10,
        }
      : null;

    this.telemetry.emit({
      event: 'action_start',
      actionId,
      sessionId,
      action: actionName,
      target,
      timeoutMs,
      startPos,
    });

    let result;

    try {
      const timeoutPromise = new Promise((resolve) => {
        actionRecord.timeoutHandle = setTimeout(() => {
          this._stopBotMovement();
          abortController.abort(new Error('TIMED_OUT'));
          resolve({
            outcome: 'timed_out',
            reason: `Exceeded timeout of ${timeoutMs}ms`,
          });
        }, timeoutMs);
        if (actionRecord.timeoutHandle.unref) actionRecord.timeoutHandle.unref();
      });

      const abortPromise = new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            const reason = signal.reason?.message || signal.reason || 'cancelled';
            if (reason !== 'TIMED_OUT') {
              this._stopBotMovement();
              resolve({
                outcome: 'cancelled',
                reason: String(reason),
              });
            }
          },
          { once: true }
        );
      });

      let executionPromise;
      try {
        executionPromise = Promise.resolve(executeFn(signal, actionId, actionRecord));
      } catch (err) {
        executionPromise = Promise.reject(err);
      }
      actionRecord.executionPromise = executionPromise;

      // Race between the execution function, timeout, and manual abort.
      result = await Promise.race([
        executionPromise,
        timeoutPromise,
        abortPromise,
      ]);
    } catch (err) {
      this._stopBotMovement();
      result = {
        outcome: 'failed',
        reason: err.message || 'unknown_error',
      };
    } finally {
      if (actionRecord.timeoutHandle) {
        clearTimeout(actionRecord.timeoutHandle);
        actionRecord.timeoutHandle = null;
      }
      this._stopBotMovement();

      if (actionRecord.executionPromise) {
        const settlementPromise = actionRecord.executionPromise
          .catch(() => {})
          .finally(() => {
            if (this.currentAction === actionRecord) {
              this.currentAction = null;
            }
          });

        // Bounded cleanup wait (up to 500ms) before returning from run()
        await Promise.race([
          settlementPromise,
          new Promise(r => setTimeout(r, 500)),
        ]);
      } else {
        if (this.currentAction === actionRecord) {
          this.currentAction = null;
        }
      }
    }

    // Run action audit hook if provided (e.g. for post-cancellation state capture)
    if (typeof actionRecord.getAudit === 'function') {
      try {
        const audit = await actionRecord.getAudit();
        if (audit && typeof audit === 'object') {
          result.details = { ...result.details, ...audit };
          // Late cancellation race check:
          // If action was cancelled/timed out, but the block was actually placed in the world!
          if ((result.outcome === 'cancelled' || result.outcome === 'timed_out') && audit.worldChanged) {
            result.outcome = 'cancelled_after_effect';
            result.reason = 'placed_before_cancel_settled';
          }
        }
      } catch {
        // Ignore audit error
      }
    }

    const durationMs = Date.now() - startedAt;
    const finalPos = this.bot.entity?.position
      ? {
          x: Math.round(this.bot.entity.position.x * 10) / 10,
          y: Math.round(this.bot.entity.position.y * 10) / 10,
          z: Math.round(this.bot.entity.position.z * 10) / 10,
        }
      : null;

    const settled = {
      actionId,
      sessionId,
      action: actionName,
      outcome: result.outcome || 'completed',
      reason: result.reason || 'ok',
      durationMs,
      startPos,
      targetPos: target,
      finalPos,
      ...result.details,
      details: result.details || {},
    };

    // Guarantee strictly ONE action_end per action
    if (!actionRecord.ended) {
      actionRecord.ended = true;
      this.telemetry.emit({
        event: 'action_end',
        ...settled,
      });
    }

    return settled;
  }

  /**
   * Cancels the currently active action if any.
   * Idempotent: can be called multiple times safely.
   *
   * @param {string} reason 'paused' | 'quit' | 'died' | 'disconnected' | 'user_cancel'
   * @returns {boolean} True if an action was cancelled
   */
  cancel(reason = 'cancelled') {
    if (!this.currentAction) return false;
    const action = this.currentAction;
    this._stopBotMovement();
    try {
      action.abortController.abort(new Error(reason));
    } catch {
      // Ignore
    }
    return true;
  }

  /**
   * Awaits until the current action in flight completely settles.
   *
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<void>}
   */
  async waitForIdle(timeoutMs = 5000) {
    const start = Date.now();
    while (this.isBusy && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }


  /**
   * Safely stops pathfinding and clears bot movement controls.
   */
  _stopBotMovement() {
    try {
      if (this.bot.pathfinder) {
        this.bot.pathfinder.stop();
        this.bot.pathfinder.setGoal(null);
      }
    } catch {
      // Ignore if pathfinder not ready
    }
    try {
      this.bot.clearControlStates();
    } catch {
      // Ignore
    }
    try {
      this.bot.stopDigging();
    } catch {
      // Ignore
    }
    try {
      if (this.bot.currentWindow) {
        this.bot.closeWindow(this.bot.currentWindow);
      }
    } catch {
      // Ignore
    }
    try {
      if (typeof this.bot.deactivateItem === 'function') {
        this.bot.deactivateItem();
      }
    } catch {
      // Ignore
    }
  }
}

module.exports = { ActionManager };
