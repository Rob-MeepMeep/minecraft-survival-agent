'use strict';

/**
 * Focused in-game live verification test suite for Phase 2E (Controlled Block Placement):
 * 1. Pre-flight bounding box intersection rejection (reason=obstructed_by_player).
 * 2. Pre-flight floating block rejection (no reference block -> reason=no_supporting_block).
 * 3. Pre-flight occupied block rejection (reason=target_occupied).
 * 4. Controlled block placement execution with postconditions and occupied-hand restoration.
 * 5. Automatic block selection placement.
 * 6. Mid-placement cancellation boundary (0 items consumed, target unchanged, hand restored).
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createPlacer } = require('../src/actions/place');
const { getInventoryCounts } = require('../src/actions/gather');
const { Vec3 } = require('vec3');

const config = loadConfig();
const runId = `place-test-${Date.now()}`;
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

const placer = createPlacer(bot, actionManager);

bot.once('spawn', async () => {
  console.log('\n🤖 Agent spawned. Waiting 2s for world chunks and player positioning...');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('Beginning Phase 2E focused verification suite...\n');

  try {
    // -----------------------------------------------------------------------
    // Pre-test setup: Clear inventory
    // -----------------------------------------------------------------------
    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 600));

    // -----------------------------------------------------------------------
    // Test 1: Pre-flight bounding box intersection rejection
    // -----------------------------------------------------------------------
    console.log('--- Test 1: Bounding box intersection rejection ---');
    bot.chat('/give SurvivalAgent dirt 1');
    await new Promise((r) => setTimeout(r, 500));

    const pPos = bot.entity.position;
    const feetTarget = new Vec3(Math.floor(pPos.x), Math.floor(pPos.y), Math.floor(pPos.z));

    console.log(`Attempting to place block directly at player feet: (${feetTarget.x}, ${feetTarget.y}, ${feetTarget.z})...`);
    const t1Res = await placer.place(feetTarget.x, feetTarget.y, feetTarget.z, 'dirt');
    console.log('Test 1 result:', JSON.stringify(t1Res, null, 2));

    const invAfterT1 = getInventoryCounts(bot);
    if (
      t1Res.outcome === 'failed' &&
      t1Res.reason === 'obstructed_by_player' &&
      invAfterT1['dirt'] === 1
    ) {
      console.log('✅ PASS: Correctly refused to place block intersecting player bounding box (reason=obstructed_by_player).');
    } else {
      console.error('❌ FAIL: Bounding box intersection rejection failed:', t1Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 2: Pre-flight floating block rejection (no reference block)
    // -----------------------------------------------------------------------
    console.log('\n--- Test 2: Floating block rejection (no reference block) ---');
    // Ensure sky block has only air around it
    const skyPos = new Vec3(18, 98, 1);
    bot.chat(`/fill ${skyPos.x - 1} ${skyPos.y - 1} ${skyPos.z - 1} ${skyPos.x + 1} ${skyPos.y + 1} ${skyPos.z + 1} air`);
    await new Promise((r) => setTimeout(r, 500));

    console.log(`Attempting to place floating block at (${skyPos.x}, ${skyPos.y}, ${skyPos.z})...`);
    const t2Res = await placer.place(skyPos.x, skyPos.y, skyPos.z, 'dirt');
    console.log('Test 2 result:', JSON.stringify(t2Res, null, 2));

    const invAfterT2 = getInventoryCounts(bot);
    if (
      t2Res.outcome === 'failed' &&
      t2Res.reason === 'no_supporting_block' &&
      invAfterT2['dirt'] === 1
    ) {
      console.log('✅ PASS: Correctly refused to place floating block with no supporting block (reason=no_supporting_block).');
    } else {
      console.error('❌ FAIL: Floating block rejection failed:', t2Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 3: Pre-flight occupied block rejection
    // -----------------------------------------------------------------------
    console.log('\n--- Test 3: Occupied block rejection ---');
    const occupiedPos = new Vec3(20, 87, 1);
    bot.chat(`/setblock ${occupiedPos.x} ${occupiedPos.y} ${occupiedPos.z} stone`);
    await new Promise((r) => setTimeout(r, 500));

    console.log(`Attempting to place block inside solid stone at (${occupiedPos.x}, ${occupiedPos.y}, ${occupiedPos.z})...`);
    const t3Res = await placer.place(occupiedPos.x, occupiedPos.y, occupiedPos.z, 'dirt');
    console.log('Test 3 result:', JSON.stringify(t3Res, null, 2));

    const invAfterT3 = getInventoryCounts(bot);
    if (
      t3Res.outcome === 'failed' &&
      t3Res.reason === 'target_occupied' &&
      invAfterT3['dirt'] === 1
    ) {
      console.log('✅ PASS: Correctly refused to place into occupied solid block (reason=target_occupied).');
    } else {
      console.error('❌ FAIL: Occupied block rejection failed:', t3Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 4: Controlled block placement & Hand restoration
    // -----------------------------------------------------------------------
    console.log('\n--- Test 4: Controlled block placement & Hand restoration ---');
    const fixtureBase = new Vec3(20, 87, 3);
    const targetPlace = new Vec3(20, 88, 3);

    bot.chat(`/setblock ${fixtureBase.x} ${fixtureBase.y} ${fixtureBase.z} stone`);
    bot.chat(`/setblock ${targetPlace.x} ${targetPlace.y} ${targetPlace.z} air`);
    await new Promise((r) => setTimeout(r, 500));

    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 400));
    bot.chat('/give SurvivalAgent oak_planks 2');
    bot.chat('/give SurvivalAgent wooden_pickaxe 1');
    await new Promise((r) => setTimeout(r, 500));

    // Equip pickaxe
    const pickaxeItem = bot.inventory.items().find((i) => i.name === 'wooden_pickaxe');
    if (pickaxeItem) {
      await bot.equip(pickaxeItem, 'hand');
    }
    console.log(`Pre-place held item: ${bot.heldItem ? bot.heldItem.name : 'none'}`);

    console.log(`Placing oak_planks at (${targetPlace.x}, ${targetPlace.y}, ${targetPlace.z})...`);
    const t4Res = await placer.place(targetPlace.x, targetPlace.y, targetPlace.z, 'oak_planks');
    console.log('Test 4 result:', JSON.stringify(t4Res, null, 2));

    const placedBlock = bot.blockAt(targetPlace);
    const invAfterT4 = getInventoryCounts(bot);
    const postPlaceHeld = bot.heldItem ? bot.heldItem.name : 'none';

    console.log(`Placed block at target: ${placedBlock ? placedBlock.name : 'null'}`);
    console.log(`Remaining oak_planks: ${invAfterT4['oak_planks']}`);
    console.log(`Post-place held item: ${postPlaceHeld}`);

    if (
      t4Res.outcome === 'success' &&
      t4Res.reason === 'block_placed' &&
      placedBlock &&
      placedBlock.name === 'oak_planks' &&
      invAfterT4['oak_planks'] === 1 &&
      postPlaceHeld === 'wooden_pickaxe'
    ) {
      console.log('✅ PASS: Placed oak_planks, verified block state, decremented exactly 1 item, and restored wooden_pickaxe to hand.');
    } else {
      console.error('❌ FAIL: Placement execution failed:', t4Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 5: Automatic block selection restricted to safe full building blocks
    // -----------------------------------------------------------------------
    console.log('\n--- Test 5: Safe automatic block selection ---');
    const autoTarget = new Vec3(20, 89, 3);
    bot.chat(`/setblock ${autoTarget.x} ${autoTarget.y} ${autoTarget.z} air`);
    await new Promise((r) => setTimeout(r, 500));

    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 400));
    // Give crafting_table (workstation), sand (gravity), and cobblestone (safe building block)
    bot.chat('/give SurvivalAgent crafting_table 1');
    bot.chat('/give SurvivalAgent sand 5');
    bot.chat('/give SurvivalAgent cobblestone 1');
    await new Promise((r) => setTimeout(r, 500));

    console.log(`Inventory contains crafting_table, sand, and cobblestone. Calling placer.place(${autoTarget.x}, ${autoTarget.y}, ${autoTarget.z}) with no block specified...`);
    const t5Res = await placer.place(autoTarget.x, autoTarget.y, autoTarget.z);
    console.log('Test 5 result:', JSON.stringify(t5Res, null, 2));

    const autoPlacedBlock = bot.blockAt(autoTarget);
    const invAfterT5 = getInventoryCounts(bot);

    if (
      t5Res.outcome === 'success' &&
      t5Res.details?.block === 'cobblestone' &&
      autoPlacedBlock &&
      autoPlacedBlock.name === 'cobblestone' &&
      invAfterT5['crafting_table'] === 1 &&
      invAfterT5['sand'] === 5 &&
      !invAfterT5['cobblestone']
    ) {
      console.log('✅ PASS: Auto-selected safe cobblestone; safely avoided crafting_table and gravity sand.');
    } else {
      console.error('❌ FAIL: Safe auto-selection placement failed:', t5Res);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 6: Mid-placement cancellation boundary with telemetry audit details
    // -----------------------------------------------------------------------
    console.log('\n--- Test 6: Mid-placement cancellation boundary & audit details ---');
    const cancelTarget = new Vec3(21, 88, 3);
    bot.chat(`/setblock ${cancelTarget.x} ${cancelTarget.y} ${cancelTarget.z} air`);
    await new Promise((r) => setTimeout(r, 500));

    bot.chat('/give SurvivalAgent dirt 2');
    bot.chat('/give SurvivalAgent wooden_pickaxe 1');
    await new Promise((r) => setTimeout(r, 500));

    const pickaxeItem2 = bot.inventory.items().find((i) => i.name === 'wooden_pickaxe');
    if (pickaxeItem2) {
      await bot.equip(pickaxeItem2, 'hand');
    }
    console.log(`Pre-cancel held item: ${bot.heldItem ? bot.heldItem.name : 'none'}`);

    const dirtBeforeCancel = getInventoryCounts(bot)['dirt'] || 0;
    console.log(`Dirt count before attempt: ${dirtBeforeCancel}`);

    const placePromise = placer.place(cancelTarget.x, cancelTarget.y, cancelTarget.z, 'dirt');
    setTimeout(() => {
      console.log('Issuing actionManager.cancel("user_interrupted")...');
      actionManager.cancel('user_interrupted');
    }, 50);

    const t6Res = await placePromise;
    console.log('Test 6 cancel result:', JSON.stringify(t6Res, null, 2));

    await new Promise((r) => setTimeout(r, 500));
    const dirtAfterCancel = getInventoryCounts(bot)['dirt'] || 0;
    const postCancelHeld = bot.heldItem ? bot.heldItem.name : 'none';
    const targetBlockAfterCancel = bot.blockAt(cancelTarget);

    console.log(`Dirt count after cancel: ${dirtAfterCancel} (consumed: ${dirtBeforeCancel - dirtAfterCancel})`);
    console.log(`Target block state: ${targetBlockAfterCancel ? targetBlockAfterCancel.name : 'null'}`);
    console.log(`Post-cancel held item: ${postCancelHeld}`);
    console.log(`Cancellation audit: finalBlockState=${t6Res.finalBlockState}, itemsConsumed=${t6Res.itemsConsumed}, worldChanged=${t6Res.worldChanged}`);

    if (
      t6Res.outcome === 'cancelled' &&
      t6Res.reason === 'user_interrupted' &&
      dirtBeforeCancel === dirtAfterCancel &&
      targetBlockAfterCancel &&
      targetBlockAfterCancel.name === 'air' &&
      postCancelHeld === 'wooden_pickaxe' &&
      t6Res.finalBlockState === 'air' &&
      t6Res.itemsConsumed === 0 &&
      t6Res.worldChanged === false
    ) {
      console.log('✅ PASS: Cancelled mid-placement with non-empty audit telemetry (finalBlockState=air, itemsConsumed=0, worldChanged=false), target block remained air, and restored wooden_pickaxe to hand.');
    } else {
      console.error('❌ FAIL: Cancellation boundary failed:', {
        t6Res,
        dirtBefore: dirtBeforeCancel,
        dirtAfter: dirtAfterCancel,
        targetBlock: targetBlockAfterCancel?.name,
        postCancelHeld,
      });
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 7: Gravity block rejection when placed over air
    // -----------------------------------------------------------------------
    console.log('\n--- Test 7: Gravity block rejection when placed over air ---');
    const gravTarget = new Vec3(20, 90, 3);
    // Ensure block below gravTarget is air:
    bot.chat(`/setblock ${gravTarget.x} ${gravTarget.y - 1} ${gravTarget.z} air`);
    bot.chat(`/setblock ${gravTarget.x} ${gravTarget.y} ${gravTarget.z} air`);
    await new Promise((r) => setTimeout(r, 500));

    bot.chat('/give SurvivalAgent sand 2');
    await new Promise((r) => setTimeout(r, 400));
    const sandBeforeT7 = getInventoryCounts(bot)['sand'] || 0;

    console.log(`Attempting to place falling block "sand" at (${gravTarget.x}, ${gravTarget.y}, ${gravTarget.z}) with air beneath...`);
    const t7Res = await placer.place(gravTarget.x, gravTarget.y, gravTarget.z, 'sand');
    console.log('Test 7 result:', JSON.stringify(t7Res, null, 2));

    const invAfterT7 = getInventoryCounts(bot);
    if (
      t7Res.outcome === 'failed' &&
      t7Res.reason === 'gravity_block_unsupported_below' &&
      invAfterT7['sand'] === sandBeforeT7
    ) {
      console.log('✅ PASS: Correctly refused to place falling sand over air (reason=gravity_block_unsupported_below, inventory unchanged).');
    } else {
      console.error('❌ FAIL: Gravity block rejection failed:', t7Res, 'sandBefore:', sandBeforeT7, 'sandAfter:', invAfterT7['sand']);
      process.exit(1);
    }

    // Cleanup placed test blocks
    bot.chat(`/setblock ${fixtureBase.x} ${fixtureBase.y} ${fixtureBase.z} air`);
    bot.chat(`/setblock ${targetPlace.x} ${targetPlace.y} ${targetPlace.z} air`);
    bot.chat(`/setblock ${autoTarget.x} ${autoTarget.y} ${autoTarget.z} air`);
    bot.chat('/clear SurvivalAgent');

    console.log('\n🎉 ALL 7 LIVE IN-GAME BLOCK PLACEMENT TESTS PASSED WITH CLEAN CONTRACT VERIFICATION!\n');
    await new Promise((r) => setTimeout(r, 1000));
    bot.quit();
    process.exit(0);
  } catch (err) {
    console.error('❌ Unhandled error in live placement test:', err);
    bot.quit();
    process.exit(1);
  }
});
