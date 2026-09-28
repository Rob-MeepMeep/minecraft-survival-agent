'use strict';

const { Vec3 } = require('vec3');
const { snapshot } = require('../observer');
const { FailureTracker } = require('./failure_tracker');
const {
  GoalPlanner,
  findHarvestableCrop,
  findFoodAnimal,
  getExpendableBuildingBlocks,
  getLatestSafeGatherStart,
  getFoodNutrition,
  calculateHeldNutrition,
  SHELTER_PREP_TIME,
  SHELTER_DEADLINE,
  DAWN_TIME,
  SAFE_FOODS,
} = require('./planner');
const {
  loadBlueprint,
  saveBlueprint,
  validateBlueprintIdentity,
  checkExitSafety,
  findAlternativeSafeExit,
  auditEnclosure,
} = require('../actions/shelter');
const {
  hasHostileThreatNearby,
  RANGED_HOSTILES,
  MELEE_HOSTILES,
} = require('../actions/gather');

/**
 * Sensible Health and Nutrition Thresholds for Autonomous Survival
 */
const HEALTH_THRESHOLDS = {
  OPTIMAL: 20,                // 10 full hearts (full health)
  REGEN_FOOD_THRESHOLD: 18,   // Vanilla Minecraft 1.21 mechanic: natural passive health regen requires food >= 18
  SAFE_MINIMUM: 14,           // 7 hearts: warning threshold, pause progression, prioritize recovery/shelter
  DANGER: 10,                 // 5 hearts: danger threshold, strict evasion, disengage from combat
  MIN_ACCEPTANCE_HEALTH: 8,   // 4 hearts: minimum health allowed at any point during acceptance run
  MIN_FINAL_HEALTH: 12,       // 6 hearts: minimum final health required at end of acceptance run
  TERMINAL_CRITICAL: 6,       // 3 hearts: critical threshold, enter critical_health_no_recovery if unrecoverable
};

/**
 * Checks whether a given position corresponds to one of the 34 solid enclosure coordinates.
 * Excludes the 2 interior vertical air cells.
 *
 * @param {{x: number, y: number, z: number}} pos
 * @param {object} bp
 * @returns {boolean}
 */
function isShelterCoordinate(pos, bp) {
  if (!pos || !bp || !bp.center) return false;
  const cx = bp.center.x;
  const cy = bp.center.y;
  const cz = bp.center.z;
  const px = Math.floor(pos.x);
  const py = Math.floor(pos.y);
  const pz = Math.floor(pos.z);
  if (px >= cx - 1 && px <= cx + 1 && pz >= cz - 1 && pz <= cz + 1 && py >= cy - 1 && py <= cy + 2) {
    if (px === cx && pz === cz && (py === cy || py === cy + 1)) {
      return false; // Interior air cells
    }
    return true;
  }
  return false;
}

/**
 * Checks whether a position is one of the designated exit doorway coordinates.
 *
 * @param {import('vec3').Vec3|object} pos
 * @param {object} bp
 * @returns {boolean}
 */
function isExitCoordinate(pos, bp) {
  if (!pos || !bp || !Array.isArray(bp.exitCoordinates)) return false;
  const px = Math.floor(pos.x);
  const py = Math.floor(pos.y);
  const pz = Math.floor(pos.z);
  return bp.exitCoordinates.some(c => c.x === px && c.y === py && c.z === pz);
}



/**
 * Selects a pathfinding-validated destination for daytime threat evasion:
 * - safe footing (solid block beneath)
 * - no fluid (not water or lava)
 * - no cliff (not falling >2 blocks)
 * - clear body and head space
 * - does not bring the agent closer to any nearby hostile mob
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Array<object>} threats
 * @param {number} [minFleeDist=12]
 * @param {number} [maxFleeDist=18]
 * @returns {import('vec3').Vec3 | null}
 */
function findSafeFleeDestination(bot, threats, minFleeDist = 12, maxFleeDist = 18, blacklist = null) {
  if (!bot.entity?.position) return null;
  const botPos = bot.entity.position;

  const validThreats = (threats || []).filter(t => t && t.position);

  let baseAngle = 0;
  let nearestThreat = null;
  let nearestDist = Infinity;

  if (validThreats.length > 0) {
    for (const t of validThreats) {
      const d = botPos.distanceTo(t.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearestThreat = t;
      }
    }

    // Calculate weighted vector away from threats (weighted inversely by distance so closer threats dominate)
    let awayX = 0;
    let awayZ = 0;
    for (const t of validThreats) {
      const dx = botPos.x - t.position.x;
      const dz = botPos.z - t.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const weight = 1 / Math.max(d, 1);
      awayX += (dx / d) * weight;
      awayZ += (dz / d) * weight;
    }
    const awayLen = Math.hypot(awayX, awayZ) || 1;
    baseAngle = Math.atan2(awayZ / awayLen, awayX / awayLen);
  } else {
    // Environmental damage / hazard evasion: move away from current position in any clear direction
    baseAngle = typeof bot.entity.yaw === 'number' ? -bot.entity.yaw : 0;
  }

  // Progressive angle offsets (including lateral escape vectors)
  const angleOffsets = [0, 0.44, -0.44, 0.87, -0.87, 1.3, -1.3, 1.74, -1.74, 2.18, -2.18, Math.PI];
  // Vertical offsets covering natural jumpable inclines (0, +1) and descents (-1 to -3)
  const verticalOffsets = [0, 1, -1, -2, -3];

  // Try standard flee distances first, then shorter emergency burst distances if terrain is constrained
  const distanceTiers = validThreats.length > 0
    ? [
        [minFleeDist, 14, (minFleeDist + maxFleeDist) / 2, 16, maxFleeDist],
        [10, 8, 6],
      ]
    : [
        [6, 8, 4, 10],
      ];

  for (const distances of distanceTiers) {
    for (const dist of distances) {
      for (const ang of angleOffsets) {
        const angle = baseAngle + ang;
        const targetX = Math.floor(botPos.x + Math.cos(angle) * dist) + 0.5;
        const targetZ = Math.floor(botPos.z + Math.sin(angle) * dist) + 0.5;

        for (const dy of verticalOffsets) {
          const floorY = Math.floor(botPos.y) + dy;
          const candidatePos = new Vec3(targetX, floorY + 1, targetZ);
          const candKey = `${Math.floor(targetX)},${floorY + 1},${Math.floor(targetZ)}`;
          if (blacklist && blacklist.has(candKey)) continue;
          const floorBlock = bot.blockAt ? bot.blockAt(new Vec3(targetX, floorY, targetZ)) : null;
          const bodyBlock = bot.blockAt ? bot.blockAt(candidatePos) : null;
          const headBlock = bot.blockAt ? bot.blockAt(new Vec3(targetX, floorY + 2, targetZ)) : null;

          if (!floorBlock || floorBlock.boundingBox !== 'block') continue;
          if (['water', 'flowing_water', 'lava', 'flowing_lava'].includes(floorBlock.name)) continue;
          if (bodyBlock && ['water', 'flowing_water', 'lava', 'flowing_lava'].includes(bodyBlock.name)) continue;
          if (headBlock && ['water', 'flowing_water', 'lava', 'flowing_lava'].includes(headBlock.name)) continue;
          if (bodyBlock && bodyBlock.boundingBox === 'block') continue;
          if (headBlock && headBlock.boundingBox === 'block') continue;

          const subFloor = bot.blockAt ? bot.blockAt(new Vec3(targetX, floorY - 1, targetZ)) : null;
          if (!subFloor || subFloor.name === 'lava' || subFloor.name === 'flowing_lava') continue;

          // Must gain distance from the primary/nearest threat
          if (nearestThreat) {
            const candNearestDist = candidatePos.distanceTo(nearestThreat.position);
            if (candNearestDist <= nearestDist + 0.5) continue;
          }

          // Must not run into immediate danger reach of any threat
          let bringsCloser = false;
          for (const t of validThreats) {
            const currentDist = botPos.distanceTo(t.position);
            const candidateDist = candidatePos.distanceTo(t.position);
            const isRanged = RANGED_HOSTILES.has(t.name || t.type);
            const dangerReach = isRanged ? 8.0 : 4.5;

            // If candidate is within danger reach and gets closer, reject
            if (candidateDist < dangerReach && candidateDist <= currentDist) {
              bringsCloser = true;
              break;
            }
          }
          if (bringsCloser) continue;

          return candidatePos;
        }
      }
    }
  }

  // If no validated candidate found, return null to avoid moving into unvalidated hazards
  return null;
}

/**
 * Evaluates a serializable completion predicate descriptor against bot state.
 *
 * @param {{ type: string, value?: any, item?: string, count?: number, meleeDistance?: number, rangedDistance?: number }} predicate
 * @param {import('mineflayer').Bot} bot
 * @returns {boolean}
 */
function evaluatePredicate(predicate, bot) {
  if (!predicate) return true;
  if (predicate.type === 'food_at_least') {
    return (bot?.food ?? 20) >= (predicate.value ?? 18);
  }
  if (predicate.type === 'nutrition_reserve') {
    const items = bot?.inventory?.items?.() || [];
    return calculateHeldNutrition(items, bot) >= (predicate.value ?? 10);
  }
  if (predicate.type === 'has_item') {
    const items = bot?.inventory?.items?.() || [];
    const count = items.filter(i => i.name === predicate.item).reduce((s, i) => s + i.count, 0);
    return count >= (predicate.count ?? 1);
  }
  if (predicate.type === 'has_expendable_blocks') {
    const items = bot?.inventory?.items?.() || [];
    return getExpendableBuildingBlocks(items) >= (predicate.count ?? 25);
  }
  if (predicate.type === 'daylight') {
    const tod = bot?.time?.timeOfDay ?? 0;
    return tod >= DAWN_TIME || tod < SHELTER_PREP_TIME;
  }
  if (predicate.type === 'threat_cleared') {
    return !hasHostileThreatNearby(bot, predicate.meleeDistance || 10.0, null, predicate.rangedDistance || 16.0);
  }
  return true;
}


/**
 * Deterministic Survival Controller scoped per agent instance.
 * Manages autonomous goal progression, preemption, step budgets,
 * fine-grained failure cooldowns, and dry-run execution.
 */
class SurvivalController {
  /**
   * @param {object} params
   * @param {import('mineflayer').Bot} params.bot
   * @param {import('../actions/manager').ActionManager} params.actionManager
   * @param {object} params.primitives - { navigator, gatherer, crafter, equipper, eater, placer }
   * @param {object} params.telemetry
   * @param {FailureTracker} [params.failureTracker]
   * @param {object} [params.options]
   */
  constructor({
    bot,
    actionManager,
    primitives,
    telemetry,
    failureTracker = new FailureTracker(),
    options = {},
  }) {
    this.bot = bot;
    this.actionManager = actionManager;
    this.primitives = primitives;
    this.telemetry = telemetry;
    this.failureTracker = failureTracker;

    this.options = {
      threatDistance: null,
      criticalFood: 6,
      eatThreshold: 14,
      targetReserve: 30,
      foodReserveNutrition: 10,
      exitTimeoutMs: 60000,
      dawnWaitTimeoutMs: 10000,
      tickIntervalMs: 100,
      ...options,
    };

    /** @type {boolean} */
    this.active = false;

    /** @type {string} */
    this.primaryGoal = 'stone_pickaxe';

    /** @type {string} */
    this.status = 'idle';

    /** @type {number} */
    this.generation = 0;

    /** @type {string|null} */
    this.currentRunId = null;

    /** @type {Array<{ goal: string, args: any[], trigger: string, completionPredicate: object, controllerRunId: string }>} LIFO Goal Stack */
    this.goalStack = [];

    /** @type {NodeJS.Timeout|null} */
    this.tickTimer = null;

    /** @type {boolean} */
    this.shelterSafetyClaim = false;

    /** @type {number|null} */
    this._dawnWaitStartTime = null;

    /** @type {number} */
    this._shelteredTickCount = 0;

    this.breachDetected = false;
    this._failedFleeTargets = new Set();

    /** Stage 4 progression milestones */
    this.milestones = {
      woodenPickaxeAchieved: false,
      stonePickaxeAchieved: false,
      foodReserveAcquired: false,
      buildingReserveAcquired: false,
      shelterEnclosed: false,
      nightSurvived: false,
      dawnExitCompleted: false,
    };
    this._recordedMilestones = new Set();

    /** Damage and Threat Emergency Tracking */
    this.damageTimeline = [];
    this._activeAggressors = new Map();
    this._lastDamageTime = 0;
    this._lastHealth = undefined;
    if (this.bot && !this.bot._activeAggressors) {
      this.bot._activeAggressors = new Set();
    }

    // Attach lifecycle listeners to cleanly stop controller on death or disconnect
    this._onDeath = () => {
      const bp = loadBlueprint();
      if (bp && bp.buildState !== 'completed') {
        bp.buildState = 'abandoned';
        saveBlueprint(bp);
      }
      this.shelterSafetyClaim = false;
      if (this.active) this.stop('died');
    };
    this._onEnd = () => {
      if (this.active) this.stop('disconnected');
    };

    // Attach entityHurt listener for damage recording
    this._onEntityHurt = (entity) => {
      if (!this.active || !this.bot) return;
      if (entity === this.bot.entity) {
        this._checkAndRecordDamage('entity_hurt_event');
      }
    };

    // Attach blockUpdate listener for instantaneous shelter breach detection
    this._onBlockUpdate = (oldBlock, newBlock) => {
      if (!this.active) return;
      if (this.currentGoal === 'wait_out_night' && this.shelterSafetyClaim) {
        const bp = loadBlueprint();
        if (!bp || !bp.center) return;
        const pos = newBlock?.position || oldBlock?.position;
        if (pos && isShelterCoordinate(pos, bp)) {
          if (isExitCoordinate(pos, bp)) return;
          if (!newBlock || newBlock.boundingBox !== 'block') {
            this.telemetry?.emit({
              event: 'shelter_breached',
              controllerRunId: this.currentRunId,
              generation: this.generation,
              position: { x: pos.x, y: pos.y, z: pos.z },
              oldBlock: oldBlock?.name,
              newBlock: newBlock?.name,
              reason: 'block_broken_during_night',
            });
            this._handleShelterBreach(pos, 'block_broken_during_night', this.currentRunId);
          }
        }
      }
    };

    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('death', this._onDeath);
      this.bot.on('end', this._onEnd);
      this.bot.on('blockUpdate', this._onBlockUpdate);
      this.bot.on('entityHurt', this._onEntityHurt);
    }
  }

  /**
   * Categorizes bot health into human-readable policy states.
   *
   * @param {number} [hp]
   * @returns {string}
   */
  _getHealthThresholdState(hp) {
    const health = hp ?? 20;
    if (health >= HEALTH_THRESHOLDS.OPTIMAL) return 'optimal';
    if (health > HEALTH_THRESHOLDS.SAFE_MINIMUM) return 'good';
    if (health > HEALTH_THRESHOLDS.DANGER) return 'warning';
    if (health > HEALTH_THRESHOLDS.TERMINAL_CRITICAL) return 'danger';
    return 'terminal_critical';
  }

  /**
   * Synchronizes active aggressors and purges expired entries.
   */
  _syncActiveAggressors() {
    const now = Date.now();
    for (const [key, expires] of this._activeAggressors.entries()) {
      if (now > expires) {
        this._activeAggressors.delete(key);
      }
    }
    if (this.bot) {
      if (!this.bot._activeAggressors) this.bot._activeAggressors = new Set();
      this.bot._activeAggressors.clear();
      for (const key of this._activeAggressors.keys()) {
        this.bot._activeAggressors.add(key);
      }
    }
  }

  /**
   * Finds nearby hostile threats, including active aggressors and ranged mobs.
   *
   * @param {number} [maxDist=18.0]
   * @returns {Array<object>}
   */
  _getNearbyThreats(maxDist = 18.0) {
    if (!this.bot?.entity?.position) return [];
    this._syncActiveAggressors();
    const botPos = this.bot.entity.position;
    const isDaylight = this.bot.time ? (this.bot.time.timeOfDay < 12000 || this.bot.time.timeOfDay >= 23000) : false;
    const threats = Object.values(this.bot.entities || {}).filter(e => {
      if (!e || !e.position || e === this.bot.entity) return false;
      const type = e.name || e.type;
      const isRanged = RANGED_HOSTILES.has(type);
      const isMelee = MELEE_HOSTILES.has(type);
      if (!isRanged && !isMelee) return false;
      const d = botPos.distanceTo(e.position);
      const isAggressor = Boolean(
        this.bot._activeAggressors && (this.bot._activeAggressors.has(e.id) || this.bot._activeAggressors.has(type))
      );
      // Spiders are neutral in daylight unless provoked or within 3m
      if ((type === 'spider' || type === 'cave_spider') && isDaylight && !isAggressor) {
        return d <= 3.0;
      }
      if (isMelee && Math.abs(botPos.y - e.position.y) > 4.5) {
        return false;
      }
      return d <= (isRanged ? Math.max(16.0, maxDist) : Math.min(10.0, maxDist));
    });
    return threats.sort((a, b) => botPos.distanceTo(a.position) - botPos.distanceTo(b.position));
  }

  /**
   * Health-Aware Damage Detection & Telemetry Recording.
   * Records attacker, damage amount, position, time, current goal, and nearby threats.
   *
   * @param {string} [reason='tick_check']
   * @param {object} [forcedAttacker=null]
   * @returns {object|null}
   */
  _checkAndRecordDamage(reason = 'tick_check', forcedAttacker = null) {
    if (!this.bot) return null;
    const currentHealth = this.bot.health ?? 20;
    if (this._lastHealth === undefined) {
      this._lastHealth = currentHealth;
      return null;
    }

    if (currentHealth < this._lastHealth) {
      const damageAmount = this._lastHealth - currentHealth;
      const prevHealth = this._lastHealth;
      this._lastHealth = currentHealth;
      this._lastDamageTime = Date.now();
      // Immediately clear flee cooldown on damage so the agent can react
      this._fleeCooldownUntil = 0;

      let attacker = forcedAttacker;
      const threats = this._getNearbyThreats(18.0);
      if (!attacker && threats.length > 0) {
        attacker = threats[0];
      }

      if (attacker) {
        const attackerId = attacker.id || attacker.name || 'unknown';
        this._activeAggressors.set(attackerId, Date.now() + 60000);
        if (attacker.name) this._activeAggressors.set(attacker.name, Date.now() + 60000);
        this._syncActiveAggressors();
      }

      const botPos = this.bot.entity?.position;
      const damageRecord = {
        timestamp: new Date().toISOString(),
        timeOfDay: this.bot.time?.timeOfDay ?? null,
        worldAge: this.bot.time?.age ?? null,
        controllerRunId: this.currentRunId,
        generation: this.generation,
        currentGoal: this.currentGoal,
        damageAmount: Math.round(damageAmount * 100) / 100,
        previousHealth: Math.round(prevHealth * 100) / 100,
        currentHealth: Math.round(currentHealth * 100) / 100,
        position: botPos ? {
          x: Math.round(botPos.x * 100) / 100,
          y: Math.round(botPos.y * 100) / 100,
          z: Math.round(botPos.z * 100) / 100,
        } : null,
        attacker: attacker ? {
          id: attacker.id,
          name: attacker.name || attacker.type || 'unknown',
          position: attacker.position ? {
            x: Math.round(attacker.position.x * 100) / 100,
            y: Math.round(attacker.position.y * 100) / 100,
            z: Math.round(attacker.position.z * 100) / 100,
          } : null,
          distance: attacker.position && botPos
            ? Math.round(botPos.distanceTo(attacker.position) * 100) / 100
            : null,
        } : null,
        nearbyThreats: threats.map(t => ({
          id: t.id,
          name: t.name || t.type,
          distance: t.position && botPos ? Math.round(botPos.distanceTo(t.position) * 100) / 100 : null,
        })),
        reason,
        healthState: this._getHealthThresholdState(currentHealth),
      };

      this.damageTimeline.push(damageRecord);

      this.telemetry?.emit({
        event: 'damage_taken',
        controllerRunId: this.currentRunId,
        generation: this.generation,
        ...damageRecord,
      });

      return damageRecord;
    }

    this._lastHealth = currentHealth;
    return null;
  }

  /**
   * Explicit state transition handling when a shelter breach occurs.
   *
   * @param {import('vec3').Vec3|object} [pos]
   * @param {string} [reason='shelter_breached']
   * @param {string} [runId]
   */
  _handleShelterBreach(pos, reason = 'shelter_breached', runId = this.currentRunId) {
    this.shelterSafetyClaim = false;
    this.breachDetected = true;
    const timeOfDay = this.bot?.time?.timeOfDay ?? 0;
    const isNight = timeOfDay >= 12000 && timeOfDay < 23000;

    const bp = loadBlueprint();
    if (bp && Array.isArray(bp.verifiedCoordinates) && pos) {
      const posKey = `${pos.x},${pos.y},${pos.z}`;
      bp.verifiedCoordinates = bp.verifiedCoordinates.filter(c => c !== posKey);
      if (Array.isArray(bp.requiredCoordinates)) {
        const rc = bp.requiredCoordinates.find(c => c.x === pos.x && c.y === pos.y && c.z === pos.z);
        if (rc) rc.verified = false;
      }
      saveBlueprint(bp);
    }

    if (!isNight && timeOfDay < 12000) {
      // Before dusk: transition to build_shelter for bounded repair
      this.currentGoal = 'build_shelter';
      this._scheduleTick(0, runId);
    } else {
      // During night: transition to failed_unsafe emergency policy
      this.status = 'failed_unsafe';
      this.active = false;
      this.telemetry?.emit({
        event: 'shelter_breach_terminal',
        controllerRunId: runId,
        reason: 'breach_during_night_unrecoverable',
        timeOfDay,
      });
    }
  }

  /**
   * Starts the controller with the specified goal.
   *
   * @param {string} [goal='wooden_pickaxe']
   * @param {object} [runOptions]
   * @param {boolean|string} [runOptions.dryRun=false] - false | 'simulate' | 'step' | true
   * @returns {Promise<object>|object}
   */
  async start(goal = 'wooden_pickaxe', runOptions = {}) {
    // If already active, stop previous run first
    if (this.active) {
      await this.stop('restarted');
    }

    // Reset FailureTracker and run-scoped state
    if (this.failureTracker && typeof this.failureTracker.reset === 'function') {
      this.failureTracker.reset();
    }
    this.milestones = {
      woodenPickaxeAchieved: false,
      stonePickaxeAchieved: false,
      foodReserveAcquired: false,
      buildingReserveAcquired: false,
      shelterEnclosed: false,
      nightSurvived: false,
      dawnExitCompleted: false,
    };
    this._recordedMilestones = new Set();
    this._dawnWaitStartTime = null;
    this._shelteredTickCount = 0;
    this._fleeAttemptCount = 0;
    this._failedFleeTargets = new Set();
    this.breachDetected = false;
    this.goalStack = [];

    // Validate any persisted blueprint identity
    const existingBp = loadBlueprint();
    if (existingBp && existingBp.buildState !== 'completed' && existingBp.buildState !== 'abandoned') {
      if (!validateBlueprintIdentity(existingBp, this.bot)) {
        existingBp.buildState = 'abandoned';
        saveBlueprint(existingBp);
      }
    }

    this.generation += 1;
    const runId = `controller-run-${this.generation}`;
    this.currentRunId = runId;
    this.active = true;
    this.status = 'running';
    this.primaryGoal = goal;
    this.currentGoal = goal;
    this.shelterSafetyClaim = false;

    const dryRun = runOptions.dryRun ?? this.options.dryRun ?? false;

    this.telemetry?.emit({
      event: 'controller_start',
      controllerRunId: runId,
      generation: this.generation,
      goal,
      dryRun,
    });

    // 1. Dry Run: One-Step Mode
    if (dryRun === 'step') {
      const plan = GoalPlanner.planNextAction({
        bot: this.bot,
        goal,
        failureTracker: this.failureTracker,
      });

      this.telemetry?.emit({
        event: 'controller_intent',
        controllerRunId: runId,
        generation: this.generation,
        goal,
        dryRun: 'step',
        simulated: false,
        plan,
      });

      this.active = false;
      this.status = 'idle';
      this.currentRunId = null;
      return { controllerRunId: runId, mode: 'step', plan };
    }

    // 2. Dry Run: Projected-State Simulation Trace
    if (dryRun === 'simulate' || dryRun === true) {
      const snap = snapshot(this.bot);
      const initialInventory = snap?.inventory || [];
      const hasCraftingTable = Boolean(this.bot?.findBlock && this.bot.findBlock({
        matching: this.bot.registry?.blocksByName?.crafting_table?.id,
        maxDistance: 24,
      }));

      const trace = GoalPlanner.simulatePlan({
        initialInventory,
        hasCraftingTable,
        goal,
        maxSteps: 30,
      });


      for (const entry of trace) {
        this.telemetry?.emit({
          event: 'controller_intent',
          controllerRunId: runId,
          generation: this.generation,
          goal,
          dryRun: 'simulate',
          simulated: true,
          ...entry,
        });
      }

      this.active = false;
      this.status = 'idle';
      this.currentRunId = null;
      return { controllerRunId: runId, mode: 'simulate', trace };
    }

    // 3. Live Autonomous Execution Loop
    this._scheduleTick(0, runId);
    return { controllerRunId: runId, status: 'running' };
  }

  /**
   * Stops the controller, clears any scheduled ticks, and settles any active action.
   *
   * @param {string} [reason='stopped']
   * @returns {Promise<void>}
   */
  async stop(reason = 'stopped') {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    const prevRunId = this.currentRunId;
    this.active = false;
    this.status = reason;
    this.currentRunId = null;
    this.goalStack = [];

    if (this.actionManager && this.actionManager.isBusy) {
      this.actionManager.cancel(`controller_${reason}`);
      await this.actionManager.waitForIdle(2000);
    }

    this.telemetry?.emit({
      event: 'controller_stop',
      controllerRunId: prevRunId,
      generation: this.generation,
      reason,
      status: this.status,
    });
  }

  /**
   * Records a milestone achieved and emits full telemetry payload.
   *
   * @param {string} milestoneName
   * @param {string} runId
   */
  _recordMilestone(milestoneName, runId) {
    if (milestoneName === 'wooden_pickaxe') this.milestones.woodenPickaxeAchieved = true;
    if (milestoneName === 'stone_pickaxe') this.milestones.stonePickaxeAchieved = true;
    if (milestoneName === 'building_reserve_acquired') this.milestones.buildingReserveAcquired = true;
    if (milestoneName === 'food_reserve_acquired') this.milestones.foodReserveAcquired = true;
    if (milestoneName === 'shelter_enclosed') this.milestones.shelterEnclosed = true;
    if (milestoneName === 'dawn_exit_completed') this.milestones.dawnExitCompleted = true;
    if (milestoneName === 'night_survived') {
      if (this.breachDetected) return;
      this.milestones.nightSurvived = true;
    }

    if (this._recordedMilestones.has(milestoneName)) return;
    this._recordedMilestones.add(milestoneName);

    this.telemetry?.emit({
      event: 'milestone_achieved',
      controllerRunId: runId,
      generation: this.generation,
      milestone: milestoneName,
      timestamp: new Date().toISOString(),
      worldAge: this.bot?.time?.age ?? null,
      timeOfDay: this.bot?.time?.timeOfDay ?? null,
      position: this.bot?.entity?.position ? {
        x: Math.round(this.bot.entity.position.x * 10) / 10,
        y: Math.round(this.bot.entity.position.y * 10) / 10,
        z: Math.round(this.bot.entity.position.z * 10) / 10,
      } : null,
      health: this.bot?.health ?? null,
      food: this.bot?.food ?? null,
      saturation: this.bot?.foodSaturation ?? null,
      currentGoal: this.currentGoal,
      goalStackDepth: this.goalStack ? this.goalStack.length : 0,
    });
  }

  /**
   * Internal scheduler for controller ticks bound to a specific generation token.
   *
   * @param {number} delayMs
   * @param {string} runId
   */
  _scheduleTick(delayMs, runId) {
    if (!this.active || this.currentRunId !== runId) return;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this._tick(runId);
    }, delayMs);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  /**
   * Main controller execution tick.
   *
   * @param {string} runId
   */
  async _tick(runId) {
    if (!this.active || this.currentRunId !== runId) return;

    this._syncActiveAggressors();
    const damageRecord = this._checkAndRecordDamage('tick');
    const tookDamage = Boolean(damageRecord || (this._lastDamageTime && Date.now() - this._lastDamageTime < 2500));

    // 1. Single-Flight Concurrency Guarantee: Yield if action is in progress, but preempt on urgent danger
    if (this.actionManager && this.actionManager.isBusy) {
      const isShelterGoal = this.currentGoal === 'build_shelter' ||
        this.currentGoal === 'wait_out_night' ||
        this.currentGoal === 'leave_shelter';

      // Check for urgent threat or damage during in-flight actions
      if (!isShelterGoal && !this.shelterSafetyClaim && this.bot?.entities && this.bot?.entity?.position) {
        const threats = this._getNearbyThreats(14.0);

        if (threats.length > 0 || tookDamage) {
          const actionName = this.actionManager.currentAction?.actionName;
          const isEvading = this.currentGoal === 'flee_threat' && actionName === 'navigate';
          if (!isEvading) {
            this.telemetry?.emit({
              event: 'controller_preemption',
              controllerRunId: runId,
              generation: this.generation,
              action: actionName,
              reason: threats.length > 0 ? 'hostile_threat_nearby' : 'damage_received',
            });
            this.actionManager.cancel('hostile_threat_nearby');

            const frame = {
              goal: this.currentGoal,
              args: [],
              trigger: tookDamage ? 'damage_evasion' : 'threat_evasion',
              completionPredicate: threats.length > 0
                ? { type: 'threat_cleared', meleeDistance: 12.0, rangedDistance: 18.0 }
                : { type: 'damage_cleared' },
              controllerRunId: runId,
            };
            this.goalStack.push(frame);

            this.currentGoal = 'flee_threat';
            this._fleeAttemptCount = 0;
            this._scheduleTick(0, runId);
            return;
          }
        }
      }

      this._scheduleTick(100, runId);
      return;
    }

    const snap = snapshot(this.bot);

    // 2. Preemption Check: Hostile Mob Threat within danger threshold
    const threat = this.options.threatDistance
      ? snap.nearbyThreats?.find(t => t.distance <= this.options.threatDistance)
      : null;
    if (threat) {
      const bp = loadBlueprint();
      const isSheltered = (this.currentGoal === 'wait_out_night' || this.currentGoal === 'leave_shelter') &&
        bp && (bp.buildState === 'enclosed' || bp.buildState === 'waiting' || bp.buildState === 'exiting');

      if (!isSheltered || threat.distance < 0.8) {
        this.telemetry?.emit({
          event: 'controller_preemption',
          controllerRunId: runId,
          generation: this.generation,
          reason: 'blocked_by_threat',
          threat,
        });
        await this.stop('blocked_by_threat');
        return;
      }

    }

    const timeOfDay = snap.timeOfDay !== null && snap.timeOfDay !== undefined
      ? snap.timeOfDay
      : (this.bot?.time?.timeOfDay !== undefined ? this.bot.time.timeOfDay : null);

    const isShelterGoal = this.currentGoal === 'build_shelter' ||
      this.currentGoal === 'wait_out_night' ||
      this.currentGoal === 'leave_shelter';

    const items = snap.inventory || [];

    // Update Stage 4 milestones
    if (items.some(i => i.name === 'wooden_pickaxe')) {
      this._recordMilestone('wooden_pickaxe', runId);
    }
    if (items.some(i => i.name === 'stone_pickaxe')) {
      this._recordMilestone('stone_pickaxe', runId);
    }
    const currentExpendable = getExpendableBuildingBlocks(items);
    if (currentExpendable >= (this.options.targetReserve || 30)) {
      this._recordMilestone('building_reserve_acquired', runId);
    }
    const currentNutrition = calculateHeldNutrition(items, this.bot);
    if (currentNutrition >= (this.options.foodReserveNutrition || 10)) {
      this._recordMilestone('food_reserve_acquired', runId);
    }

    // 0A. Daytime Hostile Threat Evasion Active Goal Handler
    if (this.currentGoal === 'flee_threat') {
      const currentHealth = this.bot.health ?? 20;
      const threats = this._getNearbyThreats(18.0);
      const recentDamage = this._lastDamageTime && (Date.now() - this._lastDamageTime < 5000);
      const fleeAttempts = this._fleeAttemptCount || 0;
      const isCleared = threats.length === 0 && !recentDamage && fleeAttempts >= 1;

      if (isCleared || fleeAttempts >= 10) {
        if (this._failedFleeTargets) this._failedFleeTargets.clear();
        this._fleeCooldownUntil = Date.now() + 2000;
        if (this.goalStack.length > 0) {
          const restored = this.goalStack.pop();
          this.currentGoal = restored.goal;
          this._fleeAttemptCount = 0;
          this.telemetry?.emit({
            event: 'controller_goal_resumed',
            controllerRunId: runId,
            generation: this.generation,
            goal: restored.goal,
            predicate: restored.completionPredicate,
            stackDepth: this.goalStack.length,
            reason: isCleared ? 'threat_cleared' : 'flee_attempts_exhausted',
          });
          this._scheduleTick(0, runId);
          return;
        } else {
          this.currentGoal = 'stone_pickaxe';
          this._fleeAttemptCount = 0;
          this._scheduleTick(0, runId);
          return;
        }
      }

      this._fleeAttemptCount = fleeAttempts + 1;
      const safeTarget = findSafeFleeDestination(this.bot, threats, 12, 18, this._failedFleeTargets);

      if (safeTarget && this.primitives?.navigator) {
        this.telemetry?.emit({
          event: 'controller_intent',
          controllerRunId: runId,
          generation: this.generation,
          action: 'navigate',
          reason: 'evade_hostile_threat',
          details: { attempt: this._fleeAttemptCount, target: safeTarget },
        });
        let navResult = null;
        try {
          if (this.primitives.navigator.goto) {
            navResult = await this.primitives.navigator.goto({ x: safeTarget.x, y: safeTarget.y, z: safeTarget.z, range: 2.0 }, 6000);
          } else if (this.primitives.navigator.navigate) {
            navResult = await this.primitives.navigator.navigate(safeTarget.x, safeTarget.y, safeTarget.z, 2.0, 6000);
          }
        } catch (err) {
          this.telemetry?.emit({
            event: 'controller_warning',
            controllerRunId: runId,
            warning: 'evasion_navigation_failed',
            error: err.message,
          });
        }
        if (!navResult || navResult.outcome !== 'success') {
          if (!this._failedFleeTargets) this._failedFleeTargets = new Set();
          const candKey = `${Math.floor(safeTarget.x)},${Math.floor(safeTarget.y)},${Math.floor(safeTarget.z)}`;
          this._failedFleeTargets.add(candKey);
        }
        if (!this.active || this.currentRunId !== runId) return;
        this._scheduleTick(100, runId);
        return;
      } else {
        // Safe destination could not be found
        // If at terminal critical health with no recovery options, enter explicit bounded critical_health_no_recovery
        if (currentHealth <= HEALTH_THRESHOLDS.TERMINAL_CRITICAL) {
          const expendable = getExpendableBuildingBlocks(items);
          const safeFood = items.find(i => SAFE_FOODS.has(i.name) && i.count > 0);
          if (!safeFood && (this.bot.food ?? 20) < HEALTH_THRESHOLDS.REGEN_FOOD_THRESHOLD && expendable < 25) {
            this.status = 'critical_health_no_recovery';
            this.active = false;
            this.telemetry?.emit({
              event: 'controller_critical_health_no_recovery',
              controllerRunId: runId,
              generation: this.generation,
              health: currentHealth,
              reason: 'flee_exhausted_at_terminal_health',
            });
            await this.stop('critical_health_no_recovery');
            return;
          }
        }

        // Avoid re-engaging threats after taking damage or when health is unsafe!
        const canDefend = currentHealth > HEALTH_THRESHOLDS.SAFE_MINIMUM && !recentDamage;
        if (canDefend) {
          const nearestThreat = threats[0];
          const dist = nearestThreat ? this.bot.entity.position.distanceTo(nearestThreat.position) : Infinity;
          if (nearestThreat && dist <= 3.5 && nearestThreat.name !== 'creeper' && typeof this.bot.attack === 'function') {
            try {
              if (typeof this.bot.lookAt === 'function') {
                const eyeY = nearestThreat.height ? nearestThreat.height * 0.8 : 1.4;
                await this.bot.lookAt(nearestThreat.position.offset(0, eyeY, 0));
              }
              this.bot.attack(nearestThreat);
            } catch {}
          }
        }

        this.telemetry?.emit({
          event: 'controller_warning',
          controllerRunId: runId,
          generation: this.generation,
          warning: 'no_safe_flee_destination',
          threatCount: threats.length,
          reEngagePrevented: !canDefend,
        });
        if (!this.active || this.currentRunId !== runId) return;
        this._scheduleTick(500, runId);
        return;
      }
    }

    // 0AA. Terminal Critical Health Check: Bounded transition to critical_health_no_recovery if unrecoverable
    if (snap.health !== null && snap.health <= HEALTH_THRESHOLDS.TERMINAL_CRITICAL) {
      const currentExpendable = getExpendableBuildingBlocks(items);
      const safeFood = items.find(i => SAFE_FOODS.has(i.name) && i.count > 0);
      const bp = loadBlueprint();
      const isEnclosed = bp && (bp.buildState === 'enclosed' || bp.buildState === 'waiting');
      const threats = this._getNearbyThreats(16.0);
      const safeFleeDest = findSafeFleeDestination(this.bot, threats, 12, 18, this._failedFleeTargets);

      if (!isEnclosed && !safeFood && (snap.food ?? 20) < HEALTH_THRESHOLDS.REGEN_FOOD_THRESHOLD && currentExpendable < 25 && (threats.length > 0 && !safeFleeDest)) {
        this.status = 'critical_health_no_recovery';
        this.active = false;
        this.telemetry?.emit({
          event: 'controller_critical_health_no_recovery',
          controllerRunId: runId,
          generation: this.generation,
          health: snap.health,
          food: snap.food,
          reason: 'critical_health_no_recovery_possible',
        });
        await this.stop('critical_health_no_recovery');
        return;
      }
    }

    // 0B. Threat or Damage Detection: suspend current goal onto stack and flee
    if (!isShelterGoal && this.currentGoal !== 'flee_threat' && !this.shelterSafetyClaim && this.bot.entity?.position) {
      const threats = this._getNearbyThreats(16.0);
      const canFlee = !this._fleeCooldownUntil || Date.now() >= this._fleeCooldownUntil || tookDamage;

      if ((threats.length > 0 && canFlee) || tookDamage) {
        const nearest = threats[0];
        const nearestDist = nearest ? this.bot.entity.position.distanceTo(nearest.position) : null;

        const frame = {
          goal: this.currentGoal,
          args: [],
          trigger: tookDamage ? 'damage_evasion' : 'threat_evasion',
          completionPredicate: threats.length > 0
            ? { type: 'threat_cleared', meleeDistance: 12.0, rangedDistance: 18.0 }
            : { type: 'damage_cleared' },
          controllerRunId: runId,
        };
        this.goalStack.push(frame);

        this.telemetry?.emit({
          event: 'controller_goal_suspended',
          controllerRunId: runId,
          generation: this.generation,
          goal: frame.goal,
          trigger: tookDamage ? 'damage_evasion' : 'threat_evasion',
          newGoal: 'flee_threat',
          threat: nearest?.name || 'environmental_hazard',
          distance: nearestDist,
          stackDepth: this.goalStack.length,
        });

        this.currentGoal = 'flee_threat';
        this._fleeAttemptCount = 0;
        this._scheduleTick(0, runId);
        return;
      }
    }

    // 1. Arbitration: Emergency & Natural Regeneration Eating
    // Note: Eating does NOT directly restore health; it restores food/saturation to enable vanilla Minecraft natural regeneration.
    const needsEmergencyFood = snap.food !== null && snap.food <= (this.options.eatThreshold || 14);
    const needsRegenFood = snap.food !== null && snap.food < HEALTH_THRESHOLDS.REGEN_FOOD_THRESHOLD && (snap.health ?? 20) < HEALTH_THRESHOLDS.OPTIMAL;
    if (needsEmergencyFood || needsRegenFood) {
      const nearbyImmediateThreat = snap.nearbyThreats?.some(t => t.distance <= 3.0);
      if (!nearbyImmediateThreat) {
        const safeFood = items.find(i => SAFE_FOODS.has(i.name) && i.count > 0);
        if (safeFood && this.primitives?.eater) {
          this.telemetry?.emit({
            event: 'controller_intent',
            controllerRunId: runId,
            generation: this.generation,
            action: 'eat',
            args: [safeFood.name],
            reason: needsRegenFood ? 'natural_regeneration_food_threshold' : (this.status === 'failed_unsafe' ? 'emergency_eat_in_failed_unsafe' : 'emergency_eat_low_hunger'),
            details: { food: snap.food, health: snap.health, item: safeFood.name },
          });
          try {
            await this.primitives.eater.eat(safeFood.name);
          } catch {
            // ignore eat error in emergency loop
          }
          if (!this.active || this.currentRunId !== runId) return;
        }
      }
    }

    // 1B. Health Safety Preemption: If health is unsafe (<= 14), prioritize shelter immediately if materials exist
    if (!isShelterGoal && snap.health !== null && snap.health <= HEALTH_THRESHOLDS.SAFE_MINIMUM) {
      const currentExpendable = getExpendableBuildingBlocks(items);
      if (currentExpendable >= 25) {
        this.telemetry?.emit({
          event: 'controller_preemption',
          controllerRunId: runId,
          generation: this.generation,
          reason: 'emergency_shelter_due_to_low_health',
          health: snap.health,
          expendableBlocks: currentExpendable,
        });
        this.currentGoal = 'build_shelter';
        this._scheduleTick(0, runId);
        return;
      }
    }

    // If in failed_unsafe state: halt construction and safety claims, maintain observation, and schedule next tick
    if (this.status === 'failed_unsafe') {
      this.shelterSafetyClaim = false;
      this.telemetry?.emit({
        event: 'controller_observation_tick',
        controllerRunId: runId,
        generation: this.generation,
        status: 'failed_unsafe',
        safetyClaim: false,
        health: snap.health,
        food: snap.food,
        timeOfDay,
      });
      this._scheduleTick(1000, runId);
      return;
    }

    // Optional legacy halt behavior
    if (this.options.haltOnDusk && (timeOfDay !== null && timeOfDay >= 12500 && timeOfDay < 23500)) {
      this.telemetry?.emit({
        event: 'controller_preemption',
        controllerRunId: runId,
        generation: this.generation,
        reason: 'night_fell',
        timeOfDay,
      });
      await this.stop('night_fell');
      return;
    }

    // 2. Arbitration: Active Shelter Completion / Dusk Preemption (10000 <= timeOfDay < 23000)
    if (timeOfDay !== null && timeOfDay >= SHELTER_PREP_TIME && timeOfDay < DAWN_TIME && !isShelterGoal) {
      const suspendedGoal = (this.currentGoal === 'observe_daylight') ? (this.primaryGoal || 'stone_pickaxe') : this.currentGoal;
      const frame = {
        goal: suspendedGoal,
        args: [],
        trigger: 'dusk_preemption',
        completionPredicate: { type: 'daylight' },
        controllerRunId: runId,
      };
      this.goalStack.push(frame);

      this.telemetry?.emit({
        event: 'controller_goal_suspended',
        controllerRunId: runId,
        generation: this.generation,
        goal: frame.goal,
        trigger: 'dusk_preemption',
        newGoal: 'build_shelter',
        timeOfDay,
        stackDepth: this.goalStack.length,
      });

      this.currentGoal = 'build_shelter';
      this._scheduleTick(0, runId);
      return;
    }

    // 3. Arbitration: Reserve Preemption at latestSafeStart (daylight: timeOfDay < 10000)
    const targetReserve = this.options.targetReserve || 30;
    const latestSafeStart = getLatestSafeGatherStart(items, targetReserve);

    if (timeOfDay !== null && timeOfDay < SHELTER_PREP_TIME && !isShelterGoal) {
      if (currentExpendable < targetReserve && timeOfDay >= latestSafeStart && this.currentGoal !== 'maintain_building_reserve') {
        const frame = {
          goal: this.currentGoal,
          args: [],
          trigger: 'reserve_preemption',
          completionPredicate: { type: 'has_expendable_blocks', count: targetReserve },
          controllerRunId: runId,
        };
        this.goalStack.push(frame);

        this.telemetry?.emit({
          event: 'controller_goal_suspended',
          controllerRunId: runId,
          generation: this.generation,
          goal: frame.goal,
          trigger: 'reserve_preemption',
          newGoal: 'maintain_building_reserve',
          expendable: currentExpendable,
          targetReserve,
          timeOfDay,
          latestSafeStart,
          stackDepth: this.goalStack.length,
        });

        this.currentGoal = 'maintain_building_reserve';
        this._scheduleTick(0, runId);
        return;
      }
    }

    // 4. Arbitration: Bounded Food Acquisition
    // Food acquisition must stop when reserve preemption or shelter deadline takes precedence!
    if (this.currentGoal === 'acquire_food') {
      if (timeOfDay !== null && (timeOfDay >= latestSafeStart || timeOfDay >= SHELTER_PREP_TIME)) {
        this.telemetry?.emit({
          event: 'controller_preemption',
          controllerRunId: runId,
          generation: this.generation,
          reason: 'food_acquisition_yields_to_reserve_or_shelter',
          timeOfDay,
          latestSafeStart,
        });
        if (timeOfDay >= SHELTER_PREP_TIME) {
          this.currentGoal = 'build_shelter';
        } else {
          this.currentGoal = 'maintain_building_reserve';
        }
        this._scheduleTick(0, runId);
        return;
      }
    } else if (timeOfDay !== null && timeOfDay < SHELTER_PREP_TIME && timeOfDay < latestSafeStart && !isShelterGoal && this.currentGoal !== 'maintain_building_reserve') {
      const targetNutrition = this.options.foodReserveNutrition || 10;
      if (currentNutrition < targetNutrition) {
        const hasFoodSource =
          findHarvestableCrop(this.bot, this.failureTracker, 24) ||
          findFoodAnimal(this.bot, this.failureTracker, 16);

        if (hasFoodSource) {
          const frame = {
            goal: this.currentGoal,
            args: [],
            trigger: 'food_reserve_preemption',
            completionPredicate: { type: 'nutrition_reserve', value: targetNutrition },
            controllerRunId: runId,
          };
          this.goalStack.push(frame);

          this.telemetry?.emit({
            event: 'controller_goal_suspended',
            controllerRunId: runId,
            generation: this.generation,
            goal: frame.goal,
            trigger: 'food_reserve_preemption',
            newGoal: 'acquire_food',
            heldNutrition: currentNutrition,
            targetNutrition,
            timeOfDay,
            stackDepth: this.goalStack.length,
          });

          this.currentGoal = 'acquire_food';
          this._scheduleTick(0, runId);
          return;
        }
      }
    }

    // Starvation without held food or food sources
    if (snap.food !== null && snap.food <= this.options.criticalFood) {
      const hasFood = items.some(i => this.primitives?.eater?.isFood?.(i.name));
      if (!hasFood) {
        const isFoodGoalActive = this.currentGoal === 'acquire_food' ||
          (this.goalStack.length > 0 && this.goalStack[this.goalStack.length - 1].goal === 'acquire_food');

        if (!isFoodGoalActive) {
          const hasFoodSource =
            findHarvestableCrop(this.bot, this.failureTracker, 24) ||
            findFoodAnimal(this.bot, this.failureTracker, 16);

          if (hasFoodSource) {
            const frame = {
              goal: this.currentGoal,
              args: [],
              trigger: 'starvation',
              completionPredicate: { type: 'food_at_least', value: 18 },
              controllerRunId: runId,
            };
            this.goalStack.push(frame);

            this.telemetry?.emit({
              event: 'controller_goal_suspended',
              controllerRunId: runId,
              generation: this.generation,
              goal: frame.goal,
              trigger: 'starvation',
              newGoal: 'acquire_food',
              stackDepth: this.goalStack.length,
            });

            this.currentGoal = 'acquire_food';
            this._scheduleTick(0, runId);
            return;
          }

          this.telemetry?.emit({
            event: 'controller_preemption',
            controllerRunId: runId,
            generation: this.generation,
            reason: 'starving_no_food',
            food: snap.food,
          });
          await this.stop('starving_no_food');
          return;
        }
      }
    }


    // 6. Budget Check: Only actual dispatched actions count against budget
    if (this.failureTracker.isBudgetExceeded(this.currentGoal)) {
      this.telemetry?.emit({
        event: 'controller_stop',
        controllerRunId: runId,
        generation: this.generation,
        reason: 'budget_exceeded',
        dispatchedActions: this.failureTracker.getDispatchedActions(),
        goalDispatched: this.failureTracker.getDispatchedActionsForGoal(this.currentGoal),
      });
      await this.stop('budget_exceeded');
      return;
    }

    // Generation check before planning
    if (!this.active || this.currentRunId !== runId) return;

    // Check if any suspended goal's completion predicate is now satisfied
    if (this.goalStack.length > 0) {
      const isShelterGoal = ['build_shelter', 'wait_out_night', 'leave_shelter'].includes(this.currentGoal);
      if (!isShelterGoal) {
        const topFrame = this.goalStack[this.goalStack.length - 1];
        if (evaluatePredicate(topFrame.completionPredicate, this.bot)) {
          const restored = this.goalStack.pop();
          this.telemetry?.emit({
            event: 'controller_goal_resumed',
            controllerRunId: runId,
            generation: this.generation,
            goal: restored.goal,
            predicate: restored.completionPredicate,
            stackDepth: this.goalStack.length,
          });
          this.currentGoal = restored.goal;
          this._scheduleTick(0, runId);
          return;
        }
      }
    }

    const activeFoodTrigger = this.goalStack.find(f => f.trigger === 'food_reserve_preemption');
    const targetNutrition = (this.currentGoal === 'acquire_food' && activeFoodTrigger)
      ? (activeFoodTrigger.completionPredicate?.value || this.options.foodReserveNutrition || 10)
      : null;

    // 7. Plan Next Action
    const plan = GoalPlanner.planNextAction({
      bot: this.bot,
      goal: this.currentGoal,
      failureTracker: this.failureTracker,
      targetReserve: this.options.targetReserve || 30,
      targetNutrition,
    });

    // 7A. Terminal: Goal Completed
    if (plan.status === 'completed') {
      if (this.currentGoal === 'build_shelter') {
        this.shelterSafetyClaim = true;
        this._recordMilestone('shelter_enclosed', runId);
        this.currentGoal = 'wait_out_night';
        const bp = loadBlueprint();
        if (bp) {
          bp.buildState = 'waiting';
          saveBlueprint(bp);
        }
        this.telemetry?.emit({
          event: 'controller_state_transition',
          controllerRunId: runId,
          generation: this.generation,
          from: 'build_shelter',
          to: 'wait_out_night',
          sheltered: true,
        });
        this._scheduleTick(0, runId);
        return;
      }

      if (this.currentGoal === 'wait_out_night') {
        const timeOfDay = snap.timeOfDay !== null ? snap.timeOfDay : (bot?.time?.timeOfDay ?? 13000);
        this.shelterSafetyClaim = false;
        if (timeOfDay >= DAWN_TIME || timeOfDay < 1000) {
          this._recordMilestone('night_survived', runId);
        }
        this.currentGoal = 'leave_shelter';
        const bp = loadBlueprint();
        if (bp) {
          bp.buildState = 'exiting';
          saveBlueprint(bp);
        }
        this.telemetry?.emit({
          event: 'controller_state_transition',
          controllerRunId: runId,
          generation: this.generation,
          from: 'wait_out_night',
          to: 'leave_shelter',
        });
        this._scheduleTick(0, runId);
        return;
      }

      if (this.currentGoal === 'leave_shelter') {
        const timeOfDay = snap.timeOfDay !== null ? snap.timeOfDay : (bot?.time?.timeOfDay ?? 13000);
        this.shelterSafetyClaim = false;
        if (timeOfDay >= DAWN_TIME || timeOfDay < 1000) {
          this._recordMilestone('dawn_exit_completed', runId);
        }
        const bp = loadBlueprint();
        if (bp) {
          bp.buildState = 'completed';
          saveBlueprint(bp);
        }

        // Resume daytime progression goal
        let nextGoal = this.primaryGoal || 'stone_pickaxe';
        let predicate = { type: 'daylight' };
        if (this.goalStack.length > 0) {
          const restored = this.goalStack.pop();
          if (restored.goal && restored.goal !== 'observe_daylight') {
            nextGoal = restored.goal;
          }
          if (restored.completionPredicate) {
            predicate = restored.completionPredicate;
          }
        }

        this.telemetry?.emit({
          event: 'controller_goal_resumed',
          controllerRunId: runId,
          generation: this.generation,
          goal: nextGoal,
          predicate,
          stackDepth: this.goalStack.length,
        });
        this.currentGoal = nextGoal;
        this._scheduleTick(0, runId);
        return;
      }

      // Check if suspended goals exist on the stack
      if (this.goalStack.length > 0) {
        const topFrame = this.goalStack[this.goalStack.length - 1];
        const predicateMet = evaluatePredicate(topFrame.completionPredicate, this.bot);
        if (predicateMet || this.currentGoal === 'acquire_food' || this.currentGoal === 'maintain_building_reserve') {
          const restored = this.goalStack.pop();
          this.telemetry?.emit({
            event: 'controller_goal_resumed',
            controllerRunId: runId,
            generation: this.generation,
            goal: restored.goal,
            predicate: restored.completionPredicate,
            stackDepth: this.goalStack.length,
          });
          this.currentGoal = restored.goal;
          this._scheduleTick(0, runId);
          return;
        }
      }

      this.telemetry?.emit({
        event: 'controller_goal_completed',
        controllerRunId: runId,
        generation: this.generation,
        goal: this.currentGoal,
        dispatchedActions: this.failureTracker.getDispatchedActions(),
      });

      // If progression or reserve goals complete during daylight before night is survived,
      // continue autonomous survival preparation rather than terminating:
      if (!this.milestones.nightSurvived) {
        if (currentExpendable < (this.options.targetReserve || 30)) {
          this.currentGoal = 'maintain_building_reserve';
          this._scheduleTick(0, runId);
          return;
        }
        if (currentNutrition < (this.options.foodReserveNutrition || 10)) {
          const hasFoodSource =
            findHarvestableCrop(this.bot, this.failureTracker, 24) ||
            findFoodAnimal(this.bot, this.failureTracker, 16);
          if (hasFoodSource) {
            this.currentGoal = 'acquire_food';
            this._scheduleTick(0, runId);
            return;
          }
        }
        if (timeOfDay !== null && timeOfDay < SHELTER_PREP_TIME) {
          this.currentGoal = 'observe_daylight';
          this._scheduleTick(1000, runId);
          return;
        }
      }

      await this.stop('completed');
      return;
    }

    // 7B. Waiting State (e.g. inside shelter waiting for dawn)
    if (plan.status === 'waiting') {
      if (this.currentGoal === 'wait_out_night') {
        this._shelteredTickCount = (this._shelteredTickCount || 0) + 1;
        if (this._shelteredTickCount % 10 === 0) {
          const bp = loadBlueprint();
          if (bp) {
            const audit = auditEnclosure(this.bot, bp);
            if (!audit.enclosed) {
              this.telemetry?.emit({
                event: 'shelter_breached',
                controllerRunId: runId,
                generation: this.generation,
                reason: 'periodic_audit_failed',
                audit,
              });
              this._handleShelterBreach(audit.missingCoordinates?.[0], 'periodic_audit_failed', runId);
              return;
            }
          }
        }
        this.telemetry?.emit({
          event: 'controller_sheltered_tick',
          controllerRunId: runId,
          generation: this.generation,
          goal: this.currentGoal,
          timeOfDay,
          health: snap.health,
          food: snap.food,
        });
        this._scheduleTick(500, runId);
        return;
      }

      if (this.currentGoal === 'leave_shelter') {
        const bp = loadBlueprint();
        if (bp) {
          this._dawnWaitStartTime = this._dawnWaitStartTime || Date.now();
          const elapsed = Date.now() - this._dawnWaitStartTime;

          // Attempt alternate exit if primary remains unsafe past dawnWaitTimeoutMs
          if (elapsed >= (this.options.dawnWaitTimeoutMs || 10000)) {
            const alt = findAlternativeSafeExit(this.bot, bp);
            if (alt) {
              bp.exitDirection = alt.direction;
              bp.exitCoordinates = alt.exitCoordinates;
              saveBlueprint(bp);
              this.telemetry?.emit({
                event: 'alternate_exit_selected',
                controllerRunId: runId,
                generation: this.generation,
                direction: alt.name,
                exitCoordinates: alt.exitCoordinates,
              });
              this._dawnWaitStartTime = Date.now();
              this._scheduleTick(0, runId);
              return;
            }
          }

          // If every direction remains unsafe past overall exitTimeoutMs, stay enclosed
          if (elapsed >= (this.options.exitTimeoutMs || 60000)) {
            this.telemetry?.emit({
              event: 'controller_stop',
              controllerRunId: runId,
              generation: this.generation,
              reason: 'exit_blocked',
              message: 'All shelter exits are unsafe; staying safely enclosed.',
            });
            this.status = 'failed_unsafe';
            this.currentGoal = 'failed_unsafe';
            this.shelterSafetyClaim = false;
            this._scheduleTick(1000, runId);
            return;
          }
        }
      }

      this.telemetry?.emit({
        event: 'controller_intent',
        controllerRunId: runId,
        generation: this.generation,
        status: 'waiting',
        reason: plan.reason,
        message: plan.message,
      });
      this._scheduleTick(1000, runId);
      return;
    }


    // 7C. Blocked State
    if (plan.status === 'blocked') {
      if (this.currentGoal === 'acquire_food' && plan.reason === 'no_food_source_available') {
        if (this.goalStack.length > 0) {
          const restored = this.goalStack.pop();
          this.telemetry?.emit({
            event: 'controller_goal_resumed',
            controllerRunId: runId,
            generation: this.generation,
            goal: restored.goal,
            reason: 'food_acquisition_unachievable_yielding_to_progression',
            stackDepth: this.goalStack.length,
          });
          this.currentGoal = restored.goal;
          this._scheduleTick(0, runId);
          return;
        } else {
          const expendable = getExpendableBuildingBlocks(items);
          if (expendable < (this.options.targetReserve || 30)) {
            this.currentGoal = 'maintain_building_reserve';
          } else if (timeOfDay !== null && timeOfDay >= SHELTER_PREP_TIME) {
            this.currentGoal = 'build_shelter';
          } else {
            this.currentGoal = 'observe_daylight';
          }
          this.telemetry?.emit({
            event: 'controller_goal_switched',
            controllerRunId: runId,
            generation: this.generation,
            from: 'acquire_food',
            to: this.currentGoal,
            reason: 'food_acquisition_unachievable_fallback',
          });
          this._scheduleTick(0, runId);
          return;
        }
      }

      if ((this.currentGoal === 'stone_pickaxe' || this.currentGoal === 'wooden_pickaxe') &&
          (plan.reason === 'no_exposed_stone_found' || plan.reason === 'no_accessible_log_found')) {
        const expendable = getExpendableBuildingBlocks(items);
        if (expendable < (this.options.targetReserve || 30)) {
          const fromGoal = this.currentGoal;
          this.currentGoal = 'maintain_building_reserve';
          this.telemetry?.emit({
            event: 'controller_goal_switched',
            controllerRunId: runId,
            generation: this.generation,
            from: fromGoal,
            to: 'maintain_building_reserve',
            reason: `${plan.reason}_gathering_building_reserve`,
          });
          this._scheduleTick(0, runId);
          return;
        } else {
          this.currentGoal = 'build_shelter';
          this.telemetry?.emit({
            event: 'controller_goal_switched',
            controllerRunId: runId,
            generation: this.generation,
            from: 'stone_pickaxe',
            to: 'build_shelter',
            reason: 'stone_blocked_reserve_met_building_shelter',
          });
          this._scheduleTick(0, runId);
          return;
        }
      }

      this.telemetry?.emit({
        event: 'controller_intent',
        controllerRunId: runId,
        generation: this.generation,
        status: 'blocked',
        reason: plan.reason,
        message: plan.message,
      });
      this._scheduleTick(1000, runId);
      return;
    }

    // 7D. Deadline Failure / Unsafe State (Clarification 5 & Request 6)
    if (plan.status === 'failed') {
      this.status = 'failed_unsafe';
      this.currentGoal = 'failed_unsafe';
      this.shelterSafetyClaim = false;
      const bp = loadBlueprint();
      if (bp && bp.buildState !== 'completed') {
        bp.buildState = 'abandoned';
        saveBlueprint(bp);
      }
      this.telemetry?.emit({
        event: 'controller_failure',
        controllerRunId: runId,
        generation: this.generation,
        status: 'failed_unsafe',
        reason: plan.reason,
        message: plan.message,
        safetyClaim: false,
        sheltered: false,
        details: plan.details,
      });
      // Preserve emergency survival behavior: do not permanently kill the process; keep observation & emergency eating active
      this._scheduleTick(1000, runId);
      return;
    }

    // 7E. Action Required
    if (plan.status === 'action_required') {
      this.telemetry?.emit({
        event: 'controller_intent',
        controllerRunId: runId,
        generation: this.generation,
        action: plan.action,
        args: plan.args,
        reason: plan.reason,
        details: plan.details,
        dispatchedActions: this.failureTracker.getDispatchedActions() + 1,
      });

      // Increment actual dispatched action count
      this.failureTracker.incrementDispatchedActions(this.currentGoal);

      let result;
      try {
        switch (plan.action) {
          case 'equip':
            result = await this.primitives.equipper.equip(...plan.args);
            break;
          case 'gather':
            result = await this.primitives.gatherer.gather(...plan.args);
            break;
          case 'craft':
            result = await this.primitives.crafter.craft(...plan.args);
            break;
          case 'place':
            result = await this.primitives.placer.place(...plan.args);
            break;
          case 'eat':
            result = await this.primitives.eater.eat(...plan.args);
            break;
          case 'attack':
            result = await this.primitives.attacker.attack(...plan.args);
            break;
          case 'navigate':
          case 'goto': {
            let target;
            if (typeof plan.args[0] === 'object' && plan.args[0] !== null) {
              target = plan.args[0];
            } else {
              const [x, y, z, range] = plan.args;
              target = { x, y, z, range: range ?? 1 };
            }
            result = await this.primitives.navigator.goto(target, plan.args[4] || 20000);
            break;
          }
          default:
            result = { outcome: 'failed', reason: 'unknown_action' };
        }
      } catch (err) {
        result = { outcome: 'failed', reason: err.message };
      }

      // Invalidate if controller was stopped or restarted while action was running
      if (!this.active || this.currentRunId !== runId) {
        return;
      }

      // Record result in failure tracker for fine-grained cooldowns
      if (result.outcome === 'success') {
        this.failureTracker.recordSuccess(plan.targetKey);

        if (plan.action === 'place' && plan.args[3] === 'crafting_table') {
          this.failureTracker.recordSuccess(FailureTracker.makeKey('craft', 'wooden_pickaxe'));
          this.failureTracker.recordSuccess(FailureTracker.makeKey('craft', 'stone_pickaxe'));
        }

        // If this was a successful shelter placement, update verified coordinates & materials consumed atomically
        if (plan.action === 'place') {
          const bp = loadBlueprint();
          if (bp && (bp.buildState === 'building' || bp.buildState === 'positioning' || bp.buildState === 'planning')) {
            bp.buildState = 'building';
            const [px, py, pz, pmat] = plan.args;
            const coordKey = `${px},${py},${pz}`;
            if (!bp.verifiedCoordinates.includes(coordKey)) {
              bp.verifiedCoordinates.push(coordKey);
            }
            const matchedCoord = bp.requiredCoordinates.find(c => c.x === px && c.y === py && c.z === pz);
            if (matchedCoord) {
              matchedCoord.verified = true;
            }
            bp.materialsConsumed.push({ x: px, y: py, z: pz, material: pmat, timestamp: Date.now() });
            saveBlueprint(bp);
          }
        }
      } else {
        this.failureTracker.recordFailure(plan.targetKey, result.reason || result.outcome);
        if ((result.reason === 'could_not_reach_block' || result.outcome === 'timed_out' || result.reason === 'unreachable') && plan.args?.[0]?.x !== undefined) {
          const { x, z } = plan.args[0];
          const colKey = `gather:col:${Math.floor(x)},${Math.floor(z)}`;
          this.failureTracker.recordFailure(colKey, 'column_unreachable', 30000);
        }
      }

      // Schedule next observation and planning tick
      this._scheduleTick(this.options.tickIntervalMs, runId);
    }
  }

  /**
   * Cleans up bot listeners.
   */
  destroy() {
    this.stop('destroyed');
    if (this.bot) {
      this.bot.removeListener('death', this._onDeath);
      this.bot.removeListener('end', this._onEnd);
      this.bot.removeListener('blockUpdate', this._onBlockUpdate);
      this.bot.removeListener('entityHurt', this._onEntityHurt);
    }
  }
}

module.exports = { SurvivalController, findSafeFleeDestination, HEALTH_THRESHOLDS };
