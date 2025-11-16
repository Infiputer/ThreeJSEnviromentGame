const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 1155;
const HOST = '0.0.0.0';

app.use(express.static('public'));

const players = {};
const pickups = {};
const bullets = [];
const solarPanels = {}; // playerId -> array of panels
const plantedTrees = {}; // treeId -> tree data
const waterGrid = {}; // grid cell key -> water level
let isRaining = false;
let rainEndTime = 0;

// Game constants
const START_AMMO = 5;
const AMMO_PER_TREE = 3;
const MAX_AMMO = 15;
const SHOT_COOLDOWN_MS = 100;
const MAX_HEALTH = 100;
const MAX_WATER = 100;
const MAX_ENERGY = 100;
const MAX_MINERALS = 50;
const MAX_SEEDS = 10;

// Resource spawn rates - increased minerals and seeds (no water pickups)
const MINERAL_SPAWN_RATE = 0.5; // 50% chance
const SEED_SPAWN_RATE = 0.3; // 30% chance (increased since no water)
const TREE_SPAWN_RATE = 0.2; // 20% chance

// Energy system
const ENERGY_GEN_PER_PANEL = 0.5; // energy per second per panel
const ENERGY_UPDATE_INTERVAL = 1000; // update energy every second

// Ability costs
const ABILITY_COSTS = {
  speedBoost: 20,
  shield: 30,
  resourceScanner: 15,
  teleport: 25,
  enhancedPlant: 10
};

// Ability durations (ms)
const ABILITY_DURATIONS = {
  speedBoost: 5000,
  shield: 10000,
  resourceScanner: 10000
};

// Tree growth
const TREE_GROWTH_TIME = 30000; // 30 seconds to fully grow
const TREE_GROWTH_STAGES = 3; // stages of growth

// Water system constants
const WATER_DECAY_RATE = 0.1; // per second when no water
const WATER_DECAY_DAMAGE = 0.2; // health damage per second when water = 0
const WATER_DRINK_RATE = 0.5; // water per second when drinking from flowing water
const WATER_DRINK_RANGE = 3; // distance to drink from water
const WATER_GRID_SIZE = 100; // water grid resolution (100x100)
const WATER_GRID_CELL_SIZE = 4; // meters per cell (400m x 400m total)
const WATER_FLOW_RATE = 0.02; // water flow speed per update
const WATER_MAX_LEVEL = 1000; // maximum water level in a cell (100x increase)
const RAIN_THRESHOLD = 0.3; // rain when average water < 30%
const RAIN_AMOUNT = 50; // water added per rain drop (100x increase)
const RAIN_DURATION = 10000; // rain lasts 10 seconds

// Mineral cost for solar panel
const MINERALS_PER_SOLAR_PANEL = 5;

// Simple value noise for terrain (deterministic)
function hash(i) {
  i = (i<<13) ^ i;
  return (1.0 - ((i * (i * i * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0);
}
function noise2(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const v00 = hash(xi + zi*57);
  const v10 = hash(xi+1 + zi*57);
  const v01 = hash(xi + (zi+1)*57);
  const v11 = hash(xi+1 + (zi+1)*57);
  const u = xf*xf*(3-2*xf);
  const v = zf*zf*(3-2*zf);
  const a = v00*(1-u) + v10*u;
  const b = v01*(1-u) + v11*u;
  return a*(1-v) + b*v;
}
function getHeightAt(x,z){
  const h = (noise2(x*0.06,z*0.06)*1.0 + noise2(x*0.18,z*0.18)*0.5 + noise2(x*0.5,z*0.5)*0.25);
  return h * 5;
}

function rand(min, max) { return Math.random() * (max - min) + min; }

// Water grid helper functions
function getGridKey(x, z) {
  const gx = Math.floor((x + 200) / WATER_GRID_CELL_SIZE);
  const gz = Math.floor((z + 200) / WATER_GRID_CELL_SIZE);
  return `${gx},${gz}`;
}

function getGridCoords(key) {
  const [gx, gz] = key.split(',').map(Number);
  return { gx, gz };
}

function getWaterLevel(x, z) {
  const key = getGridKey(x, z);
  return waterGrid[key] || 0;
}

function setWaterLevel(x, z, amount) {
  const key = getGridKey(x, z);
  waterGrid[key] = Math.max(0, Math.min(WATER_MAX_LEVEL, amount));
}

function addWaterLevel(x, z, amount) {
  const key = getGridKey(x, z);
  const current = waterGrid[key] || 0;
  waterGrid[key] = Math.max(0, Math.min(WATER_MAX_LEVEL, current + amount));
}

// Find local minimum (lowest height in 3x3 area)
function findLocalMinimum(x, z) {
  let minHeight = getHeightAt(x, z);
  let minX = x;
  let minZ = z;
  
  for (let dx = -WATER_GRID_CELL_SIZE; dx <= WATER_GRID_CELL_SIZE; dx += WATER_GRID_CELL_SIZE) {
    for (let dz = -WATER_GRID_CELL_SIZE; dz <= WATER_GRID_CELL_SIZE; dz += WATER_GRID_CELL_SIZE) {
      const h = getHeightAt(x + dx, z + dz);
      if (h < minHeight) {
        minHeight = h;
        minX = x + dx;
        minZ = z + dz;
      }
    }
  }
  
  return { x: minX, z: minZ };
}

function spawnPickup() {
  const id = Math.random().toString(36).slice(2, 9);
  const x = rand(-40,40);
  const z = rand(-40,40);
  const randType = Math.random();
  
  let type = 'tree';
  if (randType < MINERAL_SPAWN_RATE) {
    type = 'mineral';
  } else if (randType < MINERAL_SPAWN_RATE + SEED_SPAWN_RATE) {
    type = 'seed';
  } else if (randType < MINERAL_SPAWN_RATE + SEED_SPAWN_RATE + TREE_SPAWN_RATE) {
    type = 'tree';
  }
  
  pickups[id] = {
    id,
    x,
    z,
    y: getHeightAt(x,z) + 0.6,
    type,
    respawnTime: null
  };
  
  // Verbose logging for minerals and seeds to help debug spawn rates (only log occasionally)
  if ((type === 'mineral' || type === 'seed') && Math.random() < 0.2) {
    console.log(`[SPAWN] Created ${type} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  }
}

// Initialize water grid with some initial water in low areas
function initializeWaterGrid() {
  // Add initial water to local minimums (100x more water)
  for (let i = 0; i < 50; i++) {
    const x = rand(-80, 80);
    const z = rand(-80, 80);
    const min = findLocalMinimum(x, z);
    addWaterLevel(min.x, min.z, WATER_MAX_LEVEL * 0.8); // start with 80% max water
  }
  console.log('[WATER] Water grid initialized with 100x more water');
}
initializeWaterGrid();

// Keep pickups limited - increased target for more minerals and seeds
setInterval(() => {
  const currentPickups = Object.keys(pickups).length;
  const targetPickups = 20; // increased from 15 to spawn more resources
  if (currentPickups < targetPickups) {
    spawnPickup();
    if (Math.random() < 0.1) { // Log 10% of spawns to avoid spam
      console.log(`[SPAWN] Current pickups: ${currentPickups}/${targetPickups}`);
    }
  }
}, 2000); // Spawn more frequently (every 2s instead of 3s)

// Update energy generation from solar panels
setInterval(() => {
  const now = Date.now();
  for (const pid in players) {
    const p = players[pid];
    if (!p || !p.alive) continue;
    
    const panels = solarPanels[pid] || [];
    if (panels.length > 0) {
      const energyGen = panels.length * ENERGY_GEN_PER_PANEL;
      p.energy = Math.min(MAX_ENERGY, (p.energy || 0) + energyGen);
      if (panels.length > 0 && p.energy >= MAX_ENERGY) {
        console.log(`[ENERGY] Player ${pid.substring(0,6)} energy full: ${p.energy.toFixed(1)}/${MAX_ENERGY}`);
      }
    }
  }
}, ENERGY_UPDATE_INTERVAL);

// Water flow simulation - water flows to local minimums with improved algorithm
setInterval(() => {
  const newWaterGrid = {};
  
  // Copy current water levels
  for (const key in waterGrid) {
    newWaterGrid[key] = waterGrid[key];
  }
  
  // Flow water to lower areas - improved algorithm
  for (const key in waterGrid) {
    if (waterGrid[key] <= 0) continue;
    
    const { gx, gz } = getGridCoords(key);
    const x = (gx * WATER_GRID_CELL_SIZE) - 200;
    const z = (gz * WATER_GRID_CELL_SIZE) - 200;
    const currentHeight = getHeightAt(x, z);
    const waterAmount = waterGrid[key];
    
    // Find lowest neighbor in wider radius (check up to 3 cells away)
    let lowestNeighbor = null;
    let lowestHeight = currentHeight;
    let maxSearchRadius = WATER_GRID_CELL_SIZE * 3; // search up to 12m away
    
    // First check immediate neighbors
    for (let dx = -WATER_GRID_CELL_SIZE; dx <= WATER_GRID_CELL_SIZE; dx += WATER_GRID_CELL_SIZE) {
      for (let dz = -WATER_GRID_CELL_SIZE; dz <= WATER_GRID_CELL_SIZE; dz += WATER_GRID_CELL_SIZE) {
        if (dx === 0 && dz === 0) continue;
        const nx = x + dx;
        const nz = z + dz;
        const nh = getHeightAt(nx, nz);
        if (nh < lowestHeight) {
          lowestHeight = nh;
          lowestNeighbor = { x: nx, z: nz };
        }
      }
    }
    
    // If no immediate lower neighbor, search wider area
    if (!lowestNeighbor || lowestHeight >= currentHeight) {
      for (let dx = -maxSearchRadius; dx <= maxSearchRadius; dx += WATER_GRID_CELL_SIZE) {
        for (let dz = -maxSearchRadius; dz <= maxSearchRadius; dz += WATER_GRID_CELL_SIZE) {
          if (dx === 0 && dz === 0) continue;
          const dist = Math.sqrt(dx*dx + dz*dz);
          if (dist > maxSearchRadius) continue;
          
          const nx = x + dx;
          const nz = z + dz;
          const nh = getHeightAt(nx, nz);
          
          // Only consider significantly lower areas
          if (nh < lowestHeight - 0.5) { // must be at least 0.5m lower
            lowestHeight = nh;
            lowestNeighbor = { x: nx, z: nz };
          }
        }
      }
    }
    
    // Flow water to lower neighbor
    if (lowestNeighbor && lowestHeight < currentHeight && waterAmount > 0) {
      const flowAmount = Math.min(waterAmount * WATER_FLOW_RATE * 2, waterAmount); // faster flow
      if (!newWaterGrid[key]) newWaterGrid[key] = waterAmount;
      const neighborKey = getGridKey(lowestNeighbor.x, lowestNeighbor.z);
      if (!newWaterGrid[neighborKey]) {
        newWaterGrid[neighborKey] = 0;
      }
      newWaterGrid[key] -= flowAmount;
      newWaterGrid[neighborKey] += flowAmount;
    } else if (lowestHeight >= currentHeight && waterAmount > 0) {
      // Water is on high ground with no lower neighbor - remove it (evaporation or it shouldn't be there)
      // Only remove if it's clearly on a peak (all neighbors are higher)
      let allHigher = true;
      for (let dx = -WATER_GRID_CELL_SIZE; dx <= WATER_GRID_CELL_SIZE; dx += WATER_GRID_CELL_SIZE) {
        for (let dz = -WATER_GRID_CELL_SIZE; dz <= WATER_GRID_CELL_SIZE; dz += WATER_GRID_CELL_SIZE) {
          if (dx === 0 && dz === 0) continue;
          const nh = getHeightAt(x + dx, z + dz);
          if (nh <= currentHeight) {
            allHigher = false;
            break;
          }
        }
        if (!allHigher) break;
      }
      
      // If all neighbors are higher, gradually remove water (evaporation)
      if (allHigher) {
        if (!newWaterGrid[key]) newWaterGrid[key] = waterAmount;
        newWaterGrid[key] = Math.max(0, newWaterGrid[key] - 0.1); // evaporate slowly
      }
    }
  }
  
  // Update water grid
  Object.assign(waterGrid, newWaterGrid);
  
  // Clean up empty cells
  for (const key in waterGrid) {
    if (waterGrid[key] <= 0.01) {
      delete waterGrid[key];
    }
  }
}, 500); // Update every 500ms

// Update player water (drinking from flowing water and decay)
setInterval(() => {
  const now = Date.now();
  for (const pid in players) {
    const p = players[pid];
    if (!p || !p.alive) continue;
    
    // Check if near flowing water
    const nearbyWater = getWaterLevel(p.x, p.z);
    if (nearbyWater > 10 && p.water < MAX_WATER) { // threshold matches rendering (10)
      // Drink from water - drains water from grid (slower drain for realism)
      const drinkAmount = Math.min(WATER_DRINK_RATE, MAX_WATER - p.water, nearbyWater * 0.05); // reduced from 0.1 to 0.05
      p.water = Math.min(MAX_WATER, (p.water || 0) + drinkAmount);
      addWaterLevel(p.x, p.z, -drinkAmount); // Drain water from grid
      
      // Regenerate health when drinking
      if (p.health < MAX_HEALTH) {
        p.health = Math.min(MAX_HEALTH, (p.health || MAX_HEALTH) + 0.3);
      }
    } else {
      // Water decay when not near water
      p.water = Math.max(0, (p.water || MAX_WATER) - WATER_DECAY_RATE);
      if (p.water <= 0 && p.health > 0) {
        p.health = Math.max(0, (p.health || MAX_HEALTH) - WATER_DECAY_DAMAGE);
        if (p.health <= 0) {
          p.alive = false;
          p.respawnAt = Date.now() + 10000;
          console.log(`[DEATH] Player ${pid.substring(0,6)} died from dehydration`);
          setTimeout(() => {
            if (players[pid]) {
              players[pid].x = rand(-10,10);
              players[pid].z = rand(-10,10);
              players[pid].alive = true;
              players[pid].health = MAX_HEALTH;
              players[pid].water = MAX_WATER;
              delete players[pid].respawnAt;
            }
          }, 10000);
        }
      }
    }
  }
  // Check trees for prolonged water contact
  const treesToRemove = [];
  for (const treeId in plantedTrees) {
    const tree = plantedTrees[treeId];
    const waterLevel = getWaterLevel(tree.x, tree.z);
    if (waterLevel > 10) {
      if (!tree.waterContactStart) {
        tree.waterContactStart = now;
      } else if (now - tree.waterContactStart >= 10000) {
        treesToRemove.push(treeId);
      }
    } else {
      delete tree.waterContactStart;
    }
  }
  for (const id of treesToRemove) {
    console.log(`[TREE] Removed tree ${id.substring(0,6)} due to prolonged water contact`);
    delete plantedTrees[id];
  }
}, 1000);

// Rain system - rain when global water levels are low
setInterval(() => {
  const now = Date.now();
  
  // Check if rain should end
  if (isRaining && now >= rainEndTime) {
    isRaining = false;
    console.log('[RAIN] Rain stopped');
    io.emit('rainStopped');
  }
  
  // Calculate average water level
  const waterKeys = Object.keys(waterGrid);
  if (waterKeys.length === 0) {
    // No water at all - start rain
    if (!isRaining) {
      isRaining = true;
      rainEndTime = now + RAIN_DURATION;
      console.log('[RAIN] Starting rain - no water detected');
      io.emit('rainStarted', { duration: RAIN_DURATION });
    }
  } else {
    let totalWater = 0;
    for (const key of waterKeys) {
      totalWater += waterGrid[key];
    }
    const avgWater = totalWater / (waterKeys.length * WATER_MAX_LEVEL);
    
    // Start rain if average is below threshold
    if (avgWater < RAIN_THRESHOLD && !isRaining) {
      isRaining = true;
      rainEndTime = now + RAIN_DURATION;
      console.log(`[RAIN] Starting rain - average water: ${(avgWater*100).toFixed(1)}%`);
      io.emit('rainStarted', { duration: RAIN_DURATION });
    }
  }
  
  // Add rain water (100x more)
  if (isRaining) {
    // Rain adds water randomly across the map - much more water
    for (let i = 0; i < 20; i++) { // more rain drops
      const x = rand(-80, 80);
      const z = rand(-80, 80);
      addWaterLevel(x, z, RAIN_AMOUNT);
    }
  }
}, 2000);

// Update tree growth
setInterval(() => {
  const now = Date.now();
  for (const treeId in plantedTrees) {
    const tree = plantedTrees[treeId];
    if (!tree) continue;
    
    const age = now - tree.plantedAt;
    const growthStage = Math.min(TREE_GROWTH_STAGES - 1, Math.floor(age / (TREE_GROWTH_TIME / TREE_GROWTH_STAGES)));
    
    if (growthStage !== tree.growthStage) {
      tree.growthStage = growthStage;
      console.log(`[TREE] Tree ${treeId.substring(0,6)} grew to stage ${growthStage + 1}/${TREE_GROWTH_STAGES}`);
    }
    
    // Fully grown trees can be harvested
    if (growthStage >= TREE_GROWTH_STAGES - 1 && !tree.harvestable) {
      tree.harvestable = true;
      console.log(`[TREE] Tree ${treeId.substring(0,6)} is now harvestable`);
    }
  }
}, 2000);

// Update ability timers
setInterval(() => {
  const now = Date.now();
  for (const pid in players) {
    const p = players[pid];
    if (!p || !p.alive) continue;
    
    // Check ability expiration
    if (p.activeAbilities) {
      for (const ability in p.activeAbilities) {
        if (p.activeAbilities[ability] < now) {
          delete p.activeAbilities[ability];
          console.log(`[ABILITY] Player ${pid.substring(0,6)} ability ${ability} expired`);
        }
      }
    }
  }
}, 100);

io.on('connection', (socket) => {
  console.log(`[CONNECT] Player connected: ${socket.id}`);
  players[socket.id] = {
    id: socket.id,
    x: rand(-10, 10),
    y: 1,
    z: rand(-10, 10),
    rotY: 0,
    color: `hsl(${Math.floor(rand(0,360))},60%,50%)`,
    score: 0,
    sustainability: 0,
    ammo: START_AMMO,
    alive: true,
    health: MAX_HEALTH,
    water: MAX_WATER,
    energy: 0,
    minerals: 0,
    seeds: 0,
    activeAbilities: {},
    speedMultiplier: 1.0
  };
  
  solarPanels[socket.id] = [];
  
  socket.emit('init', { id: socket.id });
  console.log(`[INIT] Sent init to player ${socket.id}`);

  socket.on('update', (data) => {
    if (!players[socket.id]) {
      console.log(`[ERROR] Update received for non-existent player: ${socket.id}`);
      return;
    }
    const p = players[socket.id];
    p.x = data.x; 
    p.y = data.y; 
    p.z = data.z; 
    p.rotY = data.rotY;
  });

  socket.on('shoot', (data) => {
    const owner = players[socket.id];
    if (!owner || !owner.alive) {
      console.log(`[SHOOT] Player ${socket.id.substring(0,6)} tried to shoot but is dead`);
      return;
    }
    
    // Check shield
    if (owner.activeAbilities && owner.activeAbilities.shield) {
      console.log(`[SHOOT] Player ${socket.id.substring(0,6)} blocked with shield`);
      delete owner.activeAbilities.shield;
      return;
    }
    
    const now = Date.now();
    if (owner.lastShot && now - owner.lastShot < SHOT_COOLDOWN_MS) {
      console.log(`[SHOOT] Player ${socket.id.substring(0,6)} on cooldown`);
      return;
    }
    if (!owner.ammo || owner.ammo <= 0) {
      console.log(`[SHOOT] Player ${socket.id.substring(0,6)} out of ammo`);
      return;
    }
    
    owner.ammo = Math.max(0, owner.ammo - 1);
    owner.lastShot = now;
    bullets.push({
      id: Math.random().toString(36).slice(2,9),
      owner: socket.id,
      x: data.x, y: data.y, z: data.z,
      vx: data.vx, vy: data.vy, vz: data.vz,
      life: 2000
    });
    console.log(`[SHOOT] Player ${socket.id.substring(0,6)} fired bullet, ammo: ${owner.ammo}`);
  });

  socket.on('buildSolarPanel', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) {
      console.log(`[BUILD] Player ${socket.id.substring(0,6)} tried to build but is dead`);
      return;
    }
    
    if (player.minerals < MINERALS_PER_SOLAR_PANEL) {
      console.log(`[BUILD] Player ${socket.id.substring(0,6)} insufficient minerals: ${player.minerals}/${MINERALS_PER_SOLAR_PANEL}`);
      socket.emit('buildError', { reason: 'insufficient_minerals' });
      return;
    }
    
    player.minerals -= MINERALS_PER_SOLAR_PANEL;
    const panelId = Math.random().toString(36).slice(2, 9);
    const panels = solarPanels[socket.id] || [];
    panels.push({
      id: panelId,
      x: data.x,
      y: data.y || getHeightAt(data.x, data.z),
      z: data.z,
      owner: socket.id
    });
    solarPanels[socket.id] = panels;
    
    console.log(`[BUILD] Player ${socket.id.substring(0,6)} built solar panel at (${data.x.toFixed(1)}, ${data.z.toFixed(1)}), minerals: ${player.minerals}`);
    socket.emit('buildSuccess', { type: 'solarPanel', id: panelId });
  });

  socket.on('useAbility', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) {
      console.log(`[ABILITY] Player ${socket.id.substring(0,6)} tried to use ability but is dead`);
      return;
    }
    
    const ability = data.ability;
    const cost = ABILITY_COSTS[ability];
    
    if (!cost) {
      console.log(`[ABILITY] Invalid ability: ${ability}`);
      socket.emit('abilityError', { reason: 'invalid_ability' });
      return;
    }
    
    if (player.energy < cost) {
      console.log(`[ABILITY] Player ${socket.id.substring(0,6)} insufficient energy for ${ability}: ${player.energy}/${cost}`);
      socket.emit('abilityError', { reason: 'insufficient_energy' });
      return;
    }
    
    // Check if already active (for some abilities)
    if (ability === 'speedBoost' || ability === 'shield' || ability === 'resourceScanner') {
      if (player.activeAbilities && player.activeAbilities[ability]) {
        console.log(`[ABILITY] Player ${socket.id.substring(0,6)} ability ${ability} already active`);
        socket.emit('abilityError', { reason: 'already_active' });
        return;
      }
    }
    
    player.energy -= cost;
    
    if (!player.activeAbilities) player.activeAbilities = {};
    
    if (ability === 'speedBoost') {
      player.activeAbilities.speedBoost = Date.now() + ABILITY_DURATIONS.speedBoost;
      player.speedMultiplier = 1.5;
      console.log(`[ABILITY] Player ${socket.id.substring(0,6)} activated speed boost, energy: ${player.energy}`);
    } else if (ability === 'shield') {
      player.activeAbilities.shield = Date.now() + ABILITY_DURATIONS.shield;
      console.log(`[ABILITY] Player ${socket.id.substring(0,6)} activated shield, energy: ${player.energy}`);
    } else if (ability === 'resourceScanner') {
      player.activeAbilities.resourceScanner = Date.now() + ABILITY_DURATIONS.resourceScanner;
      console.log(`[ABILITY] Player ${socket.id.substring(0,6)} activated resource scanner, energy: ${player.energy}`);
      socket.emit('scannerActive', { duration: ABILITY_DURATIONS.resourceScanner });
    } else if (ability === 'teleport') {
      const distance = Math.sqrt(data.dx*data.dx + data.dz*data.dz);
      if (distance > 10) {
        console.log(`[ABILITY] Player ${socket.id.substring(0,6)} teleport distance too far: ${distance.toFixed(1)}`);
        socket.emit('abilityError', { reason: 'teleport_too_far' });
        player.energy += cost; // refund
        return;
      }
      player.x += data.dx || 0;
      player.z += data.dz || 0;
      player.y = getHeightAt(player.x, player.z);
      console.log(`[ABILITY] Player ${socket.id.substring(0,6)} teleported, energy: ${player.energy}`);
    }
    
    socket.emit('abilitySuccess', { ability, energy: player.energy });
  });

  socket.on('plantTree', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) {
      console.log(`[PLANT] Player ${socket.id.substring(0,6)} tried to plant but is dead`);
      return;
    }
    
    const enhanced = data.enhanced || false;
    
    if (enhanced) {
      if (player.energy < ABILITY_COSTS.enhancedPlant) {
        console.log(`[PLANT] Player ${socket.id.substring(0,6)} insufficient energy for enhanced plant`);
        socket.emit('plantError', { reason: 'insufficient_energy' });
        return;
      }
      player.energy -= ABILITY_COSTS.enhancedPlant;
    } else {
      if (player.seeds < 1) {
        console.log(`[PLANT] Player ${socket.id.substring(0,6)} no seeds available: ${player.seeds}`);
        socket.emit('plantError', { reason: 'no_seeds' });
        return;
      }
      player.seeds -= 1;
    }
    
    const treeId = Math.random().toString(36).slice(2, 9);
    plantedTrees[treeId] = {
      id: treeId,
      x: data.x,
      y: data.y || getHeightAt(data.x, data.z),
      z: data.z,
      owner: socket.id,
      plantedAt: Date.now(),
      growthStage: enhanced ? TREE_GROWTH_STAGES - 1 : 0,
      harvestable: enhanced,
      enhanced
    };
    
    console.log(`[PLANT] Player ${socket.id.substring(0,6)} planted tree ${enhanced ? '(enhanced)' : ''} at (${data.x.toFixed(1)}, ${data.z.toFixed(1)}), seeds: ${player.seeds}, energy: ${player.energy}`);
    socket.emit('plantSuccess', { treeId, enhanced });
  });

  socket.on('harvestTree', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) {
      console.log(`[HARVEST] Player ${socket.id.substring(0,6)} tried to harvest but is dead`);
      return;
    }
    
    const tree = plantedTrees[data.treeId];
    if (!tree) {
      console.log(`[HARVEST] Tree ${data.treeId} not found`);
      socket.emit('harvestError', { reason: 'tree_not_found' });
      return;
    }
    
    if (!tree.harvestable) {
      console.log(`[HARVEST] Tree ${data.treeId} not harvestable yet`);
      socket.emit('harvestError', { reason: 'not_harvestable' });
      return;
    }
    
    // Check distance
    const dx = player.x - tree.x;
    const dz = player.z - tree.z;
    if (dx*dx + dz*dz > 9) {
      console.log(`[HARVEST] Player ${socket.id.substring(0,6)} too far from tree`);
      socket.emit('harvestError', { reason: 'too_far' });
      return;
    }
    
    // Only owner can harvest
    if (tree.owner !== socket.id) {
      console.log(`[HARVEST] Player ${socket.id.substring(0,6)} tried to harvest someone else's tree`);
      socket.emit('harvestError', { reason: 'not_owner' });
      return;
    }
    
    player.sustainability += 2;
    player.score += 1;
    player.seeds += 1; // get seed back
    delete plantedTrees[data.treeId];
    
    console.log(`[HARVEST] Player ${socket.id.substring(0,6)} harvested tree, sustainability: ${player.sustainability}, seeds: ${player.seeds}`);
    socket.emit('harvestSuccess', { sustainability: player.sustainability, seeds: player.seeds });
  });

  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] Player disconnected: ${socket.id}`);
    delete players[socket.id];
    delete solarPanels[socket.id];
    // Remove player's trees
    for (const treeId in plantedTrees) {
      if (plantedTrees[treeId].owner === socket.id) {
        delete plantedTrees[treeId];
      }
    }
  });
});

// Game loop: move bullets, collisions with players & pickups
const TICK = 50;
setInterval(() => {
  const now = Date.now();
  
  // Update speed multipliers from abilities
  for (const pid in players) {
    const p = players[pid];
    if (p.activeAbilities && p.activeAbilities.speedBoost) {
      p.speedMultiplier = 1.5;
    } else {
      p.speedMultiplier = 1.0;
    }
  }
  
  // Update bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * (TICK/1000);
    b.y += b.vy * (TICK/1000);
    b.z += b.vz * (TICK/1000);
    b.life -= TICK;
    if (b.life <= 0) { 
      bullets.splice(i,1); 
      continue; 
    }

    // Check collision with players
    for (const pid in players) {
      if (pid === b.owner) continue;
      const p = players[pid];
      if (!p.alive) continue;
      
      // Check shield
      if (p.activeAbilities && p.activeAbilities.shield) {
        continue; // shield blocks bullets
      }
      
      const dx = p.x - b.x; const dy = p.y - b.y; const dz = p.z - b.z;
      const dist2 = dx*dx + dy*dy + dz*dz;
      if (dist2 < 4.0) {
        // hit
        p.alive = false;
        p.health = 0;
        const attacker = players[b.owner];
        if (attacker) attacker.score += 1;
        const respawnDelay = 10000;
        p.respawnAt = Date.now() + respawnDelay;
        console.log(`[HIT] Player ${pid.substring(0,6)} hit by ${b.owner.substring(0,6)}`);
        setTimeout(() => {
          if (!players[pid]) return;
          players[pid].x = rand(-10,10);
          players[pid].z = rand(-10,10);
          players[pid].alive = true;
          players[pid].health = MAX_HEALTH;
          players[pid].water = MAX_WATER;
          delete players[pid].respawnAt;
          console.log(`[RESPAWN] Player ${pid.substring(0,6)} respawned`);
        }, respawnDelay);
        bullets.splice(i,1);
        break;
      }
    }
  }

  // Pickups collision
  for (const pid in players) {
    const p = players[pid];
    if (!p.alive) continue;
    for (const pickId in pickups) {
      const pk = pickups[pickId];
      const dx = p.x - pk.x; const dz = p.z - pk.z;
      if (dx*dx + dz*dz < 4) {
        // collect
        if (pk.type === 'tree') {
          p.sustainability += 1;
          p.score += 0.5;
          p.ammo = Math.min(MAX_AMMO, (p.ammo || 0) + AMMO_PER_TREE);
          console.log(`[COLLECT] Player ${pid.substring(0,6)} collected tree, sustainability: ${p.sustainability}`);
        } else if (pk.type === 'mineral') {
          p.minerals = Math.min(MAX_MINERALS, (p.minerals || 0) + 1);
          console.log(`[COLLECT] Player ${pid.substring(0,6)} collected mineral, minerals: ${p.minerals}`);
        // Water is now collected from flowing water, not pickups
        } else if (pk.type === 'seed') {
          p.seeds = Math.min(MAX_SEEDS, (p.seeds || 0) + 1);
          console.log(`[COLLECT] Player ${pid.substring(0,6)} collected seed, seeds: ${p.seeds}`);
        }
        
        io.to(pid).emit('collected', { id: pickId, type: pk.type });
        
        // Delete pickup
        delete pickups[pickId];
      }
    }
  }
  
  // Broadcast state
  const waterGridSize = Object.keys(waterGrid).length;
  if (waterGridSize > 0 && Math.random() < 0.01) { // log 1% of updates
    console.log(`[STATE] Broadcasting state with ${waterGridSize} water cells`);
  }
  io.emit('state', {
    players,
    pickups,
    bullets,
    solarPanels,
    plantedTrees,
    waterGrid,
    isRaining
  });

}, TICK);

server.listen(PORT, HOST, () => {
  console.log(`[SERVER] Server running at http://${HOST}:${PORT}/`);
  console.log(`[SERVER] Game systems initialized:`);
  console.log(`[SERVER]   - Resource spawning active`);
  console.log(`[SERVER]   - Energy generation active`);
  console.log(`[SERVER]   - Water regeneration active`);
  console.log(`[SERVER]   - Tree growth system active`);
  console.log(`[SERVER]   - Abilities system active`);
});