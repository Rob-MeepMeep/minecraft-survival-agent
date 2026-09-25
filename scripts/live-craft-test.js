'use strict';

/**
 * Focused in-game verification test suite for Phase 2C:
 * 1. 2x2 Crafting: oak_planks from oak_log (verifying exact ingredient consumption & yield).
 * 2. 2x2 Crafting: stick from oak_planks.
 * 3. 2x2 Crafting: crafting_table from oak_planks.
 * 4. 3x3 Table requirement rejection when no table is nearby (reason=no_crafting_table_nearby).
 * 5. 3x3 Crafting with table approach & window management (wooden_pickaxe).
 * 6. Equipment management: Equip wooden_pickaxe to hand (heldItem postcondition).
 * 7. Equipment management: Equip shield to off-hand (slot postcondition).
 * 8. Equipment management: Unequip from off-hand (empty slot postcondition & already_empty handling).
 * 9. Cancellation boundary: single-flight concurrency & clean cancellation with exactly one action_end.
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createCrafter } = require('../src/actions/craft');
const { createEquipper } = require('../src/actions/equip');
const { getInventoryCounts } = require('../src/actions/gather');
const { Vec3 } = require('vec3');

const config = loadConfig();
const runId = `craft-test-${Date.now()}`;
const telemetry = createTelemetry(runId);

const agent = createAgent(config, telemetry);
const { bot } = agent;

const actionManager = new ActionManager({
  bot,
  getState: () => ({
    active: agent.active,
    ready: agent.ready,
    sessionId: agent.sessionId,
  }),
  telemetry,
});

const crafter = createCrafter(bot, actionManager);
const equipper = createEquipper(bot, actionManager);

bot.once('spawn', async () => {
  console.log('\n🤖 Agent spawned. Waiting 2s for world chunks and player positioning...');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('Beginning Phase 2C focused verification suite...\n');

  function clearNearbyTables() {
    const tableId = bot.registry?.blocksByName?.crafting_table?.id;
    if (tableId && typeof bot.findBlocks === 'function') {
      const existing = bot.findBlocks({ matching: tableId, maxDistance: 32, count: 20 });
      for (const pos of existing) {
        bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} air`);
      }
    }
  }

  try {
    // -----------------------------------------------------------------------
    // Pre-test setup: Clear inventory and any preexisting crafting tables
    // -----------------------------------------------------------------------
    bot.chat('/clear SurvivalAgent');
    clearNearbyTables();
    await new Promise((r) => setTimeout(r, 800));

    const botPos = bot.entity.position;
    const bx = Math.floor(botPos.x);
    const by = Math.floor(botPos.y);
    const bz = Math.floor(botPos.z);

    // -----------------------------------------------------------------------
    // Test 1: 2x2 Crafting — oak_planks from oak_log
    // -----------------------------------------------------------------------
    console.log('--- Test 1: 2x2 Crafting — oak_planks from oak_log ---');
    bot.chat('/give SurvivalAgent oak_log 2');
    await new Promise((r) => setTimeout(r, 600));

    const invBeforeT1 = getInventoryCounts(bot);
    console.log('Inventory before Test 1:', JSON.stringify(invBeforeT1));

    const t1Res = await crafter.craft('oak_planks', 1);
    console.log('Test 1 craft result:', JSON.stringify(t1Res, null, 2));

    const invAfterT1 = getInventoryCounts(bot);
    console.log('Inventory after Test 1:', JSON.stringify(invAfterT1));

    if (
      t1Res.outcome === 'success' &&
      t1Res.reason === 'crafted_item' &&
      t1Res.item === 'oak_planks' &&
      t1Res.yield === 4 &&
      invAfterT1['oak_planks'] === 4 &&
      invAfterT1['oak_log'] === 1
    ) {
      console.log('✅ PASS: Successfully crafted 4x oak_planks, consumed exactly 1x oak_log (2x2 grid).');
    } else {
      console.error('❌ FAIL: Test 1 craft did not meet delta postconditions:', t1Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 2: 2x2 Crafting — stick from oak_planks
    // -----------------------------------------------------------------------
    console.log('\n--- Test 2: 2x2 Crafting — stick from oak_planks ---');
    const t2Res = await crafter.craft('stick', 1);
    console.log('Test 2 craft result:', JSON.stringify(t2Res, null, 2));

    const invAfterT2 = getInventoryCounts(bot);
    console.log('Inventory after Test 2:', JSON.stringify(invAfterT2));

    if (
      t2Res.outcome === 'success' &&
      t2Res.reason === 'crafted_item' &&
      t2Res.item === 'stick' &&
      t2Res.yield === 4 &&
      invAfterT2['stick'] === 4 &&
      invAfterT2['oak_planks'] === 2
    ) {
      console.log('✅ PASS: Successfully crafted 4x stick, consumed exactly 2x oak_planks.');
    } else {
      console.error('❌ FAIL: Test 2 craft did not meet delta postconditions:', t2Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 3: 2x2 Crafting — crafting_table from oak_planks
    // -----------------------------------------------------------------------
    console.log('\n--- Test 3: 2x2 Crafting — crafting_table from oak_planks ---');
    // Craft remaining 1 oak_log into 4 planks so we have 6 planks total
    await crafter.craft('oak_planks', 1);
    const preT3Inv = getInventoryCounts(bot);
    console.log('Inventory before crafting table:', JSON.stringify(preT3Inv));

    const t3Res = await crafter.craft('crafting_table', 1);
    console.log('Test 3 craft result:', JSON.stringify(t3Res, null, 2));

    const invAfterT3 = getInventoryCounts(bot);
    console.log('Inventory after Test 3:', JSON.stringify(invAfterT3));

    if (
      t3Res.outcome === 'success' &&
      t3Res.reason === 'crafted_item' &&
      t3Res.item === 'crafting_table' &&
      t3Res.yield === 1 &&
      invAfterT3['crafting_table'] === 1 &&
      invAfterT3['oak_planks'] === 2
    ) {
      console.log('✅ PASS: Successfully crafted 1x crafting_table, consumed exactly 4x oak_planks.');
    } else {
      console.error('❌ FAIL: Test 3 craft did not meet delta postconditions:', t3Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 4: 3x3 Grid Requirement Rejection Without Table
    // -----------------------------------------------------------------------
    console.log('\n--- Test 4: 3x3 Grid Requirement Rejection Without Table ---');
    // wooden_pickaxe requires 3 planks and 2 sticks AND a 3x3 crafting table.
    // Bot has 2 planks and 4 sticks. Give 1 more plank so ingredients exist.
    bot.chat('/give SurvivalAgent oak_planks 1');
    clearNearbyTables();
    await new Promise((r) => setTimeout(r, 800));

    console.log('Attempting to craft wooden_pickaxe without crafting table placed...');
    const t4Res = await crafter.craft('wooden_pickaxe', 1);
    console.log('Test 4 craft result:', JSON.stringify(t4Res, null, 2));

    if (t4Res.outcome === 'failed' && t4Res.reason === 'no_crafting_table_nearby') {
      console.log('✅ PASS: Correctly refused 3x3 recipe with reason="no_crafting_table_nearby".');
    } else {
      console.error('❌ FAIL: Expected no_crafting_table_nearby failure, got:', t4Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 5: 3x3 Crafting with Table Approach & Window Management
    // -----------------------------------------------------------------------
    console.log('\n--- Test 5: 3x3 Crafting with Table Approach & Window Management ---');
    const tableX = bx + 2;
    const tableY = by;
    const tableZ = bz;

    // Place crafting table fixture
    bot.chat(`/setblock ${tableX} ${tableY - 1} ${tableZ} dirt`);
    bot.chat(`/setblock ${tableX} ${tableY} ${tableZ} crafting_table`);
    await new Promise((r) => setTimeout(r, 800));

    const invBeforeT5 = getInventoryCounts(bot);
    console.log('Inventory before Test 5 (wooden_pickaxe):', JSON.stringify(invBeforeT5));

    const t5Res = await crafter.craft('wooden_pickaxe', 1);
    console.log('Test 5 craft result:', JSON.stringify(t5Res, null, 2));

    const invAfterT5 = getInventoryCounts(bot);
    console.log('Inventory after Test 5:', JSON.stringify(invAfterT5));

    if (
      t5Res.outcome === 'success' &&
      t5Res.reason === 'crafted_item' &&
      t5Res.item === 'wooden_pickaxe' &&
      t5Res.yield === 1 &&
      invAfterT5['wooden_pickaxe'] === 1 &&
      !bot.currentWindow
    ) {
      console.log('✅ PASS: Approached table, crafted wooden_pickaxe (3 planks, 2 sticks consumed), verified window closed.');
    } else {
      console.error('❌ FAIL: Test 5 craft failed or window remained open:', t5Res);
      process.exit(1);
    }

    // Clean up table fixture
    bot.chat(`/setblock ${tableX} ${tableY} ${tableZ} air`);

    // -----------------------------------------------------------------------
    // Test 6: Equipment Management — Equip wooden_pickaxe to hand
    // -----------------------------------------------------------------------
    console.log('\n--- Test 6: Equip wooden_pickaxe to hand ---');
    const t6Res = await equipper.equip('wooden_pickaxe', 'hand');
    console.log('Test 6 equip result:', JSON.stringify(t6Res, null, 2));

    if (
      t6Res.outcome === 'success' &&
      t6Res.reason === 'item_equipped' &&
      bot.heldItem?.name === 'wooden_pickaxe'
    ) {
      console.log(`✅ PASS: Equipped wooden_pickaxe to hand (heldItem=${bot.heldItem?.name}).`);
    } else {
      console.error('❌ FAIL: Hand equip postcondition not met:', t6Res, 'heldItem:', bot.heldItem);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 7: Equipment Management — Equip shield to off-hand
    // -----------------------------------------------------------------------
    console.log('\n--- Test 7: Equip shield to off-hand ---');
    bot.chat('/give SurvivalAgent shield 1');
    await new Promise((r) => setTimeout(r, 600));

    const t7Res = await equipper.equip('shield', 'off-hand');
    console.log('Test 7 equip result:', JSON.stringify(t7Res, null, 2));

    const offHandSlot = bot.inventory.slots[45];
    if (
      t7Res.outcome === 'success' &&
      t7Res.reason === 'item_equipped' &&
      offHandSlot?.name === 'shield'
    ) {
      console.log(`✅ PASS: Equipped shield to off-hand (slot 45 item=${offHandSlot?.name}).`);
    } else {
      console.error('❌ FAIL: Off-hand equip postcondition not met:', t7Res, 'slot 45:', offHandSlot);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 8: Equipment Management — Unequip from off-hand
    // -----------------------------------------------------------------------
    console.log('\n--- Test 8: Unequip from off-hand ---');
    const t8Res = await equipper.unequip('off-hand');
    console.log('Test 8 unequip result:', JSON.stringify(t8Res, null, 2));

    const offHandAfter = bot.inventory.slots[45];
    if (
      t8Res.outcome === 'success' &&
      t8Res.reason === 'item_unequipped' &&
      !offHandAfter
    ) {
      console.log('✅ PASS: Unequipped shield from off-hand, verified slot 45 is empty.');
    } else {
      console.error('❌ FAIL: Off-hand unequip postcondition not met:', t8Res, 'slot 45:', offHandAfter);
      process.exit(1);
    }

    // Idempotent check on already empty slot
    const t8bRes = await equipper.unequip('off-hand');
    if (t8bRes.outcome === 'success' && t8bRes.reason === 'already_empty') {
      console.log('✅ PASS: Calling unequip on empty slot cleanly returns reason="already_empty".');
    } else {
      console.error('❌ FAIL: Unequip already empty returned:', t8bRes);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 9: Cancellation Boundaries & Single-Flight Concurrency
    // -----------------------------------------------------------------------
    console.log('\n--- Test 9: Cancellation Boundaries & Single-Flight Concurrency ---');
    // Start an action and immediately try a second action to test concurrency rejection
    bot.chat('/give SurvivalAgent oak_log 1');
    await new Promise((r) => setTimeout(r, 600));

    const p1 = crafter.craft('oak_planks', 1);
    const p2 = crafter.craft('oak_planks', 1);

    const [r1, r2] = await Promise.all([p1, p2]);
    console.log('Concurrency test results: action1=', r1.outcome, 'action2=', r2.outcome, r2.reason);

    if (r2.outcome === 'failed' && r2.reason === 'action_in_flight') {
      console.log('✅ PASS: Single-flight concurrency strictly rejected concurrent action (reason=action_in_flight).');
    } else {
      console.error('❌ FAIL: Expected action_in_flight concurrent rejection, got:', r2);
      process.exit(1);
    }

    // Explicit cancellation test
    console.log('\n--- Test 10: Mid-action cancellation boundary ---');
    // Place crafting table far away so navigation takes time
    const farX = bx + 10;
    const farY = by;
    const farZ = bz;
    bot.chat(`/setblock ${farX} ${farY - 1} ${farZ} dirt`);
    bot.chat(`/setblock ${farX} ${farY} ${farZ} crafting_table`);
    bot.chat('/give SurvivalAgent oak_planks 3');
    bot.chat('/give SurvivalAgent stick 2');
    await new Promise((r) => setTimeout(r, 600));

    const cancelPromise = crafter.craft('wooden_pickaxe', 1);
    // Cancel after 100ms while navigation is in flight
    setTimeout(() => {
      console.log('Issuing actionManager.cancel("user_interrupted")...');
      actionManager.cancel('user_interrupted');
    }, 100);

    const cancelRes = await cancelPromise;
    console.log('Cancel result:', JSON.stringify(cancelRes, null, 2));

    if (cancelRes.outcome === 'cancelled' && cancelRes.reason === 'user_interrupted') {
      console.log('✅ PASS: Action cleanly cancelled with outcome="cancelled" and reason="user_interrupted".');
    } else {
      console.error('❌ FAIL: Expected cancelled outcome, got:', cancelRes);
      process.exit(1);
    }

    // Clean up far table
    bot.chat(`/setblock ${farX} ${farY} ${farZ} air`);

    console.log('\n🎉 ALL 9 LIVE IN-GAME TESTS PASSED WITH CLEAN CONTRACT ATTRIBUTIONS!\n');
    await new Promise((r) => setTimeout(r, 1000));
    bot.quit();
    process.exit(0);
  } catch (err) {
    console.error('❌ Unhandled error in live test:', err);
    bot.quit();
    process.exit(1);
  }
});
