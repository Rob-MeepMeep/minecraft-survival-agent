// REFERENCE ONLY — Original prototype from handoff appendix.
// Not used in Stage 1. Preserved for later stages.

const edible = new Set(['apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'baked_potato', 'carrot', 'melon_slice', 'sweet_berries'])
function choose({food, night, sheltered, logs, planks, sticks, pickaxe, dirt, hasFood}) {
  if (food < 18 && hasFood) return 'eat'
  if (sheltered) return night ? 'wait' : 'leave'
  if (night && dirt >= 25) return 'shelter'
  if (logs < 4 && planks < 16) return 'wood'
  if (planks < 16) return 'planks'
  if (sticks < 2 && !pickaxe) return 'sticks'
  if (!pickaxe) return 'pickaxe'
  if (dirt < 25) return 'dirt'
  return 'forage'
}
module.exports = {choose, edible}
