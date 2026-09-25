'use strict';

/**
 * Focused in-game live verification test suite for Phase 2D:
 * 1. Full-hunger rejection (bot.food == 20 refuses regular food with reason=already_full).
 * 2. Unsafe food policy rejection (refuses rotten_flesh with reason=unsafe_food).
 * 3. Controlled safe food consumption (eats bread when hungry, verifies 1 consumed, food/sat increase).
 * 4. Automatic best food selection (chooses cooked_beef over apple).
 * 5. Full-hunger exemption (allows eating golden_apple even at 20 hunger).
 * 6. Cancellation boundary (cancelling mid-eating stops consumption and deactivates item).
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createEater } = require('../src/actions/eat');
const { getInventoryCounts } = require('../src/actions/gather');

const config = loadConfig();
const runId = `eat-test-${Date.now()}`;
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

const eater = createEater(bot, actionManager);

bot.once('spawn', async () => {
  console.log('\n🤖 Agent spawned. Waiting 2s for world chunks and player positioning...');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('Beginning Phase 2D focused verification suite...\n');

  try {
    // -----------------------------------------------------------------------
    // Pre-test setup: Clear inventory and any active effects
    // -----------------------------------------------------------------------
    bot.chat('/clear SurvivalAgent');
    bot.chat('/effect clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 600));

    // -----------------------------------------------------------------------
    // Test 1: Full-hunger rejection
    // -----------------------------------------------------------------------
    console.log('--- Test 1: Full-hunger rejection ---');
    // Ensure hunger is 20
    bot.chat('/effect give SurvivalAgent saturation 1 255');
    await new Promise((r) => setTimeout(r, 800));

    bot.chat('/give SurvivalAgent bread 2');
    await new Promise((r) => setTimeout(r, 600));

    console.log(`Current hunger: ${bot.food}/20. Attempting to eat bread...`);
    const t1Res = await eater.eat('bread');
    console.log('Test 1 eat result:', JSON.stringify(t1Res, null, 2));

    const invAfterT1 = getInventoryCounts(bot);
    if (
      t1Res.outcome === 'failed' &&
      t1Res.reason === 'already_full' &&
      invAfterT1['bread'] === 2
    ) {
      console.log('✅ PASS: Correctly refused to eat when full (reason=already_full, inventory unchanged).');
    } else {
      console.error('❌ FAIL: Full-hunger rejection test failed:', t1Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 2: Unsafe food policy rejection
    // -----------------------------------------------------------------------
    console.log('\n--- Test 2: Unsafe food policy rejection ---');
    bot.chat('/give SurvivalAgent rotten_flesh 2');
    await new Promise((r) => setTimeout(r, 600));

    console.log('Attempting to eat rotten_flesh with default safety policy...');
    const t2Res = await eater.eat('rotten_flesh');
    console.log('Test 2 eat result:', JSON.stringify(t2Res, null, 2));

    const invAfterT2 = getInventoryCounts(bot);
    if (
      t2Res.outcome === 'failed' &&
      t2Res.reason === 'unsafe_food' &&
      invAfterT2['rotten_flesh'] === 2
    ) {
      console.log('✅ PASS: Correctly refused harmful food (reason=unsafe_food, inventory unchanged).');
    } else {
      console.error('❌ FAIL: Unsafe food rejection test failed:', t2Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 3: Controlled safe food consumption & Hand Restoration
    // -----------------------------------------------------------------------
    console.log('\n--- Test 3: Controlled safe food consumption & Hand Restoration ---');
    console.log('Equipping wooden_pickaxe to hand prior to eating...');
    bot.chat('/give SurvivalAgent wooden_pickaxe 1');
    await new Promise((r) => setTimeout(r, 500));
    const pickaxeItem = bot.inventory.items().find((i) => i.name === 'wooden_pickaxe');
    if (pickaxeItem) {
      await bot.equip(pickaxeItem, 'hand');
    }
    console.log(`Pre-eat held item: ${bot.heldItem ? bot.heldItem.name : 'none'}`);

    console.log('Inducing hunger via hunger effect to lower food level...');
    bot.chat('/effect give SurvivalAgent hunger 6 255');

    // Wait until hunger drops below 20
    const startWait = Date.now();
    while (bot.food >= 20 && Date.now() - startWait < 8000) {
      await new Promise((r) => setTimeout(r, 300));
    }
    bot.chat('/effect clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 500));

    console.log(`Hunger level reduced to ${bot.food}/20.`);
    const foodBeforeT3 = bot.food;
    const satBeforeT3 = bot.foodSaturation;

    console.log('Eating 1x bread...');
    const t3Res = await eater.eat('bread');
    console.log('Test 3 eat result:', JSON.stringify(t3Res, null, 2));

    const invAfterT3 = getInventoryCounts(bot);
    const postEatHeldItem = bot.heldItem ? bot.heldItem.name : 'none';
    console.log(`Post-eat held item: ${postEatHeldItem}`);

    if (
      t3Res.outcome === 'success' &&
      t3Res.reason === 'consumed' &&
      t3Res.itemsConsumed === 1 &&
      invAfterT3['bread'] === 1 &&
      (t3Res.foodAfter > foodBeforeT3 || t3Res.satAfter > satBeforeT3) &&
      postEatHeldItem === 'wooden_pickaxe'
    ) {
      console.log(`✅ PASS: Consumed 1x bread and restored occupied hand to wooden_pickaxe (hunger: ${foodBeforeT3} -> ${t3Res.foodAfter}, saturation: ${satBeforeT3} -> ${t3Res.satAfter}).`);
    } else {
      console.error('❌ FAIL: Safe food consumption or hand restoration failed:', t3Res, 'heldItem:', postEatHeldItem);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 4: Automatic best food selection
    // -----------------------------------------------------------------------
    console.log('\n--- Test 4: Automatic best food selection ---');
    // Clear and give both apple (points 4) and cooked_beef (points 8)
    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 400));
    bot.chat('/give SurvivalAgent apple 1');
    bot.chat('/give SurvivalAgent cooked_beef 1');
    bot.chat('/effect give SurvivalAgent hunger 5 255');

    const startWait2 = Date.now();
    while (bot.food >= 20 && Date.now() - startWait2 < 8000) {
      await new Promise((r) => setTimeout(r, 300));
    }
    bot.chat('/effect clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 500));

    console.log(`Current hunger: ${bot.food}/20. Calling eater.eat() without arguments...`);
    const t4Res = await eater.eat();
    console.log('Test 4 auto-select result:', JSON.stringify(t4Res, null, 2));

    const invAfterT4 = getInventoryCounts(bot);
    if (
      t4Res.outcome === 'success' &&
      t4Res.item === 'cooked_beef' &&
      invAfterT4['apple'] === 1 &&
      !invAfterT4['cooked_beef']
    ) {
      console.log('✅ PASS: Optimal food selection chose cooked_beef over apple.');
    } else {
      console.error('❌ FAIL: Best food selection failed:', t4Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 5: Full-hunger exemption & special effect logging (golden_apple)
    // -----------------------------------------------------------------------
    console.log('\n--- Test 5: Full-hunger exemption & special effect logging ---');
    bot.chat('/effect give SurvivalAgent saturation 1 255');
    await new Promise((r) => setTimeout(r, 800));

    bot.chat('/give SurvivalAgent golden_apple 1');
    await new Promise((r) => setTimeout(r, 500));

    console.log(`Current hunger: ${bot.food}/20. Attempting to eat golden_apple...`);
    const t5Res = await eater.eat('golden_apple');
    console.log('Test 5 golden_apple result:', JSON.stringify(t5Res, null, 2));

    const invAfterT5 = getInventoryCounts(bot);
    if (
      t5Res.outcome === 'success' &&
      t5Res.item === 'golden_apple' &&
      !invAfterT5['golden_apple'] &&
      t5Res.details?.specialEffects
    ) {
      console.log('✅ PASS: Consumed golden_apple at full hunger with logged special effects:', JSON.stringify(t5Res.details.specialEffects));
    } else {
      console.error('❌ FAIL: Golden apple full-hunger exemption failed:', t5Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 6: Mid-eating cancellation boundary, 0 items consumed & hand restoration
    // -----------------------------------------------------------------------
    console.log('\n--- Test 6: Mid-eating cancellation boundary, 0 items consumed & hand restoration ---');
    bot.chat('/give SurvivalAgent bread 2');
    bot.chat('/give SurvivalAgent wooden_pickaxe 1');
    await new Promise((r) => setTimeout(r, 500));

    const pickaxeItem2 = bot.inventory.items().find((i) => i.name === 'wooden_pickaxe');
    if (pickaxeItem2) {
      await bot.equip(pickaxeItem2, 'hand');
    }
    console.log(`Pre-cancel held item: ${bot.heldItem ? bot.heldItem.name : 'none'}`);

    bot.chat('/effect give SurvivalAgent hunger 4 255');
    const startWait3 = Date.now();
    while (bot.food >= 20 && Date.now() - startWait3 < 8000) {
      await new Promise((r) => setTimeout(r, 300));
    }
    bot.chat('/effect clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 500));

    const breadBeforeCancel = getInventoryCounts(bot)['bread'] || 0;
    console.log(`Bread count before eat attempt: ${breadBeforeCancel}`);

    const eatPromise = eater.eat('bread');
    setTimeout(() => {
      console.log('Issuing actionManager.cancel("user_interrupted")...');
      actionManager.cancel('user_interrupted');
    }, 100);

    const t6Res = await eatPromise;
    console.log('Test 6 cancel result:', JSON.stringify(t6Res, null, 2));

    await new Promise((r) => setTimeout(r, 500));
    const breadAfterCancel = getInventoryCounts(bot)['bread'] || 0;
    const postCancelHeldItem = bot.heldItem ? bot.heldItem.name : 'none';
    const isUsingItem = Boolean(bot.usingHeldItem);

    console.log(`Bread count after cancel: ${breadAfterCancel} (consumed: ${breadBeforeCancel - breadAfterCancel})`);
    console.log(`Post-cancel held item: ${postCancelHeldItem}`);
    console.log(`Active-use state remaining: ${isUsingItem}`);

    if (
      t6Res.outcome === 'cancelled' &&
      t6Res.reason === 'user_interrupted' &&
      breadBeforeCancel === breadAfterCancel &&
      !isUsingItem &&
      postCancelHeldItem === 'wooden_pickaxe'
    ) {
      console.log('✅ PASS: Cancelled mid-eating with exactly 0 items consumed, no active-use state, and restored wooden_pickaxe to hand.');
    } else {
      console.error('❌ FAIL: Cancellation postconditions failed:', {
        breadBefore: breadBeforeCancel,
        breadAfter: breadAfterCancel,
        isUsingItem,
        heldItem: postCancelHeldItem,
        t6Res,
      });
      process.exit(1);
    }

    console.log('\n🎉 ALL 6 LIVE IN-GAME FOOD TESTS PASSED WITH CLEAN CONTRACT VERIFICATION!\n');
    await new Promise((r) => setTimeout(r, 1000));
    bot.quit();
    process.exit(0);
  } catch (err) {
    console.error('❌ Unhandled error in live test:', err);
    bot.quit();
    process.exit(1);
  }
});
