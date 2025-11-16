const socket = io();

let myId = null;
const otherPlayers = {};
const pickups = {};
const bullets = {};

const BASE_HALF_BLADE_HEIGHT = 0.025; // 0.05 height / 2

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true, // enabled for better visuals
  powerPreference: "high-performance", // prefer dedicated GPU
  stencil: false, // disable stencil buffer if not needed
  depth: true,
  alpha: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
// enable shadow maps for realistic lighting
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft shadows for better quality
renderer.toneMapping = THREE.ACESFilmicToneMapping; // better color grading
renderer.toneMappingExposure = 1.3; // brighter for better visibility
// ensure frustum culling is enabled (default, but explicit)
renderer.sortObjects = true;
// production optimization: reduce precision for better performance on mobile
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2x for performance
// handle window resize efficiently
let needsResize = false;
window.addEventListener('resize', () => {
  needsResize = true;
});

const scene = new THREE.Scene();
// realistic sky gradient with better color
// Enhanced sky colors for better aesthetics
// const skyColor = new THREE.Color(0x9dd3ff); // brighter, more vibrant sky blue
// const horizonColor = new THREE.Color(0xe8f4ff); // lighter horizon
// scene.background = skyColor;
// scene.fog = new THREE.FogExp2(horizonColor, 0.01); // slightly less dense fog for clarity

// Add this after scene creation:
const skyShader = {
  uniforms: {
    topColor: { value: new THREE.Color(0xabaaff) },
    bottomColor: { value: new THREE.Color(0xffffff) },
    offset: { value: 400 },
    exponent: { value: 0.6 }
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float offset;
    uniform float exponent;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize( vWorldPosition + offset ).y;
      gl_FragColor = vec4( mix( bottomColor, topColor, max( pow( max( h , 0.0), exponent ), 0.0 ) ), 1.0 );
    }
  `
};

const skyGeo = new THREE.SphereGeometry(400, 32, 15);
const skyMat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.clone(skyShader.uniforms),
  vertexShader: skyShader.vertexShader,
  fragmentShader: skyShader.fragmentShader,
  side: THREE.BackSide
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);

scene.fog = new THREE.FogExp2(skyShader.uniforms.bottomColor.value, 0.01);

// Terrain parameters - optimized for performance
const TERRAIN_SIZE = 200;
const TERRAIN_SEGMENTS = 100; // reduced from 200 for better performance

// Simple deterministic noise (matches server) for height
function hash(i) { i = (i << 13) ^ i; return (1.0 - ((i * (i * i * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0); }
function noise2(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const v00 = hash(xi + zi * 57);
  const v10 = hash(xi + 1 + zi * 57);
  const v01 = hash(xi + (zi + 1) * 57);
  const v11 = hash(xi + 1 + (zi + 1) * 57);
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = v00 * (1 - u) + v10 * u;
  const b = v01 * (1 - u) + v11 * u;
  return a * (1 - v) + b * v;
}
function getHeightAt(x, z) {
  // match server: stronger frequencies and amplitude for steeper slopes
  const h = (noise2(x * 0.06, z * 0.06) * 1.0 + noise2(x * 0.18, z * 0.18) * 0.5 + noise2(x * 0.5, z * 0.5) * 0.25);
  return h * 5;
}

function getNormalAt(x, z) {
  const eps = 0.1;
  const dx = getHeightAt(x + eps, z) - getHeightAt(x - eps, z);
  const dz = getHeightAt(x, z + eps) - getHeightAt(x, z - eps);
  const normal = new THREE.Vector3(-dx, 2 * eps, -dz).normalize();
  return normal;
}

// build terrain mesh
const terrainGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
terrainGeo.rotateX(-Math.PI / 2);
const pos = terrainGeo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const vx = pos.getX(i);
  const vz = pos.getZ(i);
  const y = getHeightAt(vx, vz);
  pos.setY(i, y);
}
terrainGeo.computeVertexNormals();
// attempt to load a genuine grass texture from three.js examples; fall back to generated canvas
const texUrl = 'https://cdn.polyhaven.com/asset_img/primary/rocky_terrain_02.png?height=760&quality=95';
let grassTex = null;
const loader = new THREE.TextureLoader();
loader.load(texUrl, (t) => {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  grassTex = t;
  terrain.material.map = grassTex;
  terrain.material.needsUpdate = true;
}, undefined, (err) => {
  // fallback generated texture - optimized with ImageData for better performance
  const texSize = 512;
  const canvasTex = document.createElement('canvas');
  canvasTex.width = texSize; canvasTex.height = texSize;
  const ctx = canvasTex.getContext('2d');
  const imageData = ctx.createImageData(texSize, texSize);
  const data = imageData.data;

  // use ImageData for faster pixel manipulation - create more realistic grass texture
  for (let y = 0; y < texSize; y++) {
    for (let x = 0; x < texSize; x++) {
      const nx = x / texSize * 6 - 3;
      const ny = y / texSize * 6 - 3;
      const v = noise2(nx, ny) * 0.5 + 0.5;
      // more realistic grass color variation
      const baseG = 80 + v * 60;
      const g = Math.floor(baseG + (Math.random() * 15 - 7));
      const r = Math.floor(g * 0.65); // more red for natural look
      const b = Math.floor(g * 0.7);
      const idx = (y * texSize + x) * 4;
      data[idx] = r;     // R
      data[idx + 1] = g;   // G
      data[idx + 2] = b;   // B
      data[idx + 3] = 255; // A
    }
  }
  ctx.putImageData(imageData, 0, 0);
  grassTex = new THREE.CanvasTexture(canvasTex);
  grassTex.wrapS = THREE.RepeatWrapping;
  grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(64, 64);
  terrain.material.map = grassTex;
  terrain.material.needsUpdate = true;
});
// realistic terrain material with PBR properties
const terrainMat = new THREE.MeshStandardMaterial({
  map: null,
  color: 0x6b8e23, // richer, more natural olive green
  roughness: 0.85, // slightly smoother for better light reflection
  metalness: 0.0, // no metal
  emissive: 0x000000,
  emissiveIntensity: 0
});
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.receiveShadow = true; // enable shadow receiving
scene.add(terrain);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 2, 5);

// Enhanced lighting setup with better aesthetics
const ambientLight = new THREE.AmbientLight(0xffffff, 0.65); // slightly brighter ambient
scene.add(ambientLight);

// main sun light with optimized shadows
const directionalLight = new THREE.DirectionalLight(0xfff8e1, 1.2); // warmer, brighter sunlight
directionalLight.position.set(15, 25, 8);
directionalLight.castShadow = true;
// Optimized shadow quality - balance between quality and performance
directionalLight.shadow.mapSize.width = 512; // further reduced for optimization
directionalLight.shadow.mapSize.height = 512;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 100;
directionalLight.shadow.camera.left = -50;
directionalLight.shadow.camera.right = 50;
directionalLight.shadow.camera.top = 50;
directionalLight.shadow.camera.bottom = -50;
directionalLight.shadow.bias = -0.0001;
directionalLight.shadow.normalBias = 0.02;
directionalLight.shadow.radius = 4; // softer shadow edges
scene.add(directionalLight);

// fill light for better contrast (no shadows for performance)
const fillLight = new THREE.DirectionalLight(0xaaccff, 0.35); // cooler blue fill
fillLight.position.set(-8, 12, -6);
scene.add(fillLight);

// hemisphere light for natural sky lighting - enhanced colors
const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x5a7a3a, 0.4); // brighter sky, darker ground
scene.add(hemiLight);

// create volumetric grass tufts - optimized for performance
// configure density as tufts per square meter (terrain is `TERRAIN_SIZE` x `TERRAIN_SIZE`)
const GRASS_PER_SQM = 0.5; // further reduced for better performance

const grassCount = 0; Math.min(100000, Math.max(100, Math.floor(GRASS_PER_SQM * TERRAIN_SIZE * TERRAIN_SIZE * 15))); // 5x more grass, max 100k instances
console.log(`Grass count calculated: ${grassCount} tufts (terrain: ${TERRAIN_SIZE}x${TERRAIN_SIZE}, density: ${GRASS_PER_SQM}/sqm)`);
// optimized blade geometry - 5x shorter grass
const bladeGeom = new THREE.BoxGeometry(0.08, 0.05, 0.05); // height reduced from 1.2 to 0.24 (5x shorter)
// generate a procedural blade texture (improves silhouette without external fetch)
function makeBladeCanvas() {
  const w = 128, h = 384;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.clearRect(0, 0, w, h);
  // draw several layered blade shapes
  for (let i = 0; i < 4; i++) {
    const grd = cx.createLinearGradient(w / 2, 0, w / 2, h);
    // lighter green palette
    const g1 = Math.floor(140 + Math.random() * 60);
    grd.addColorStop(0, `rgba(${Math.floor(g1 * 0.6)},${g1},${Math.floor(g1 * 0.5)},1)`);
    grd.addColorStop(1, `rgba(${Math.floor(g1 * 0.5)},${Math.floor(g1 * 0.85)},${Math.floor(g1 * 0.45)},0.95)`);
    cx.fillStyle = grd;
    cx.beginPath();
    const offset = (i - 1.5) * 6;
    cx.moveTo(w / 2 + offset, 0);
    cx.quadraticCurveTo(w * 0.1 + offset, h * 0.4, w / 2 + offset, h * 0.9);
    cx.quadraticCurveTo(w * 0.9 + offset, h * 0.4, w / 2 + offset, 0);
    cx.closePath();
    cx.fill();
  }
  return c;
}
const bladeCanvas = makeBladeCanvas();
const bladeTex = new THREE.CanvasTexture(bladeCanvas);
bladeTex.repeat.set(1, 1);

// improved grass shader with better visuals and performance
const bladeMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: bladeTex },
    time: { value: 0 },
    fogColor: { value: new THREE.Color(0xe0f6ff) },
    fogDensity: { value: 0.012 },
    underwaterIntensity: { value: 0.0 }
  },
  vertexShader: `
    #include <common>
    uniform float time;
    varying vec2 vUv;
    varying float vFogDepth;
    void main() {
      vUv = uv;
      vec3 pos = position;
      
      // apply instance matrix transformation
      vec4 mvPosition = vec4( pos, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      
      // wind sway: optimized calculation
      float sway = sin(time * 0.8) * 0.05;
      float bend = sin(time * 0.6) * 0.02;
      
      // apply sway to local position (stronger at blade tip)
      pos.x += sway * (pos.y + 0.5);
      pos.y += bend * (pos.y + 0.5);
      
      mvPosition = vec4( pos, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      
      vec4 worldPos = modelMatrix * mvPosition;
      vFogDepth = length(worldPos.xyz - cameraPosition);
      
      gl_Position = projectionMatrix * modelViewMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    #include <common>
    uniform sampler2D map;
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform float underwaterIntensity;
    varying vec2 vUv;
    varying float vFogDepth;
    out vec4 FragColor;
    void main() {
      vec4 texColor = texture(map, vUv);
      if (texColor.a < 0.45) discard;
      
      // Apply underwater blue tint to grass
      vec3 underwaterTint = vec3(0.2, 0.4, 0.7); // blue tint
      texColor.rgb = mix(texColor.rgb, underwaterTint, underwaterIntensity * 0.7);
      
      // apply fog for depth
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      texColor.rgb = mix(texColor.rgb, fogColor, fogFactor);
      
      FragColor = texColor;
    }
  `,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: true,
  glslVersion: THREE.GLSL3,
});
// reduced to 2 meshes for better performance (was 3)
const INST_COUNT = 2;
const grassInst = [];
console.log(`Creating ${INST_COUNT} instanced meshes with ${grassCount} instances each...`);
for (let k = 0; k < INST_COUNT; k++) {
  const m = new THREE.InstancedMesh(bladeGeom, bladeMat, grassCount);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = true; // enable frustum culling for grass meshes
  grassInst.push(m);
  scene.add(m);
  console.log(`  Mesh ${k}: instanceCount=${m.instanceMatrix.array.length / 16} (should be ${grassCount})`);
}

// initialize grass positions and matrices
// each blade is distributed randomly (no tufts)
const grassPositions = new Array(grassCount);
const tempMatrix = new THREE.Matrix4();
const tempQuat = new THREE.Quaternion();
const tempVec = new THREE.Vector3();

console.log(`Initializing ${grassCount} individual blades (no tufts)...`);
let initCount = 0;
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

// distribute all blades randomly across terrain
for (let i = 0; i < grassCount; i++) {
  const gx = (Math.random() - 0.5) * TERRAIN_SIZE;
  const gz = (Math.random() - 0.5) * TERRAIN_SIZE;
  const gy = getHeightAt(gx, gz);
  const normal = getNormalAt(gx, gz);
  const rot = Math.random() * Math.PI * 2; // random rotation around the normal
  const scale = 0.6 + Math.random() * 0.9;
  grassPositions[i] = { x: gx, y: gy - 1000, z: gz, rot: rot, s: scale, normal: normal };

  // track bounds
  minX = Math.min(minX, gx);
  maxX = Math.max(maxX, gx);
  minZ = Math.min(minZ, gz);
  maxZ = Math.max(maxZ, gz);

  // assign this blade to a random mesh
  const meshIdx = i % INST_COUNT;
  const bladeIdx = Math.floor(i / INST_COUNT);

  // Align blade's Y to terrain normal
  const from = new THREE.Vector3(0, 1, 0); // default blade up
  tempQuat.setFromUnitVectors(from, normal);
  // Apply random rotation around the new up (normal)
  const randomQuat = new THREE.Quaternion().setFromAxisAngle(normal, rot);
  tempQuat.multiply(randomQuat);

  tempVec.set(gx, gy, gz);
  const offsetAmount = BASE_HALF_BLADE_HEIGHT * scale;
  tempVec.addScaledVector(normal, offsetAmount);
  tempMatrix.compose(tempVec, tempQuat, new THREE.Vector3(scale, scale, scale));
  grassInst[meshIdx].setMatrixAt(bladeIdx, tempMatrix);
  initCount++;
}

// mark all instances as needing update
for (let k = 0; k < INST_COUNT; k++) {
  grassInst[k].instanceMatrix.needsUpdate = true;
}
console.log(`Grass initialization complete: ${initCount} individual blades distributed randomly`);
console.log(`Position bounds: X=[${minX.toFixed(1)}, ${maxX.toFixed(1)}], Z=[${minZ.toFixed(1)}, ${maxZ.toFixed(1)}]`);
const GRASS_RENDER_RADIUS = 10; // max render distance in meters (reduced from 50 to 10)
const GRASS_RENDER_RADIUS_SQ = GRASS_RENDER_RADIUS * GRASS_RENDER_RADIUS; // squared for distance comparison
const grassDummy = new THREE.Object3D();
// track last camera position for optimization - only update grass visibility when camera moves significantly
let lastCameraPos = new THREE.Vector3(Infinity, Infinity, Infinity);
const CAMERA_MOVE_THRESHOLD = 8.0; // only update grass visibility if camera moved more than 8m (optimized)
const CAMERA_MOVE_THRESHOLD_SQ = CAMERA_MOVE_THRESHOLD * CAMERA_MOVE_THRESHOLD;
let grassUpdateCounter = 0;
const GRASS_UPDATE_INTERVAL = 5; // only update grass visibility every 5 frames (optimized)

// local player (we won't render the local player's mesh to avoid blocking the view)
const playerGeo = new THREE.BoxGeometry(1, 3, 1);
const playerMat = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
const playerMesh = new THREE.Mesh(playerGeo, playerMat);
// intentionally not adding `playerMesh` to scene for first-person view

// HUD
const scoreEl = document.getElementById('score');
const sustEl = document.getElementById('sust');
const ammoEl = document.getElementById('ammo');
const fpsEl = document.getElementById('fps');
const healthEl = document.getElementById('health');
const waterEl = document.getElementById('water');
const energyEl = document.getElementById('energy');
const mineralsEl = document.getElementById('minerals');
const seedsEl = document.getElementById('seeds');
const scannerIndicatorEl = document.getElementById('scannerIndicator');

// FPS tracking - use frame time averaging for accuracy
let frameCount = 0;
let lastFpsUpdate = 0;
let lastFrameTime = performance.now();
let frameTimeSum = 0;
const FPS_UPDATE_INTERVAL = 500; // update FPS display every 500ms

let state = { players: {}, pickups: {}, bullets: [], solarPanels: {}, plantedTrees: {}, waterGrid: {}, isRaining: false };
let rainParticles = [];
let lastWaterGridHash = ''; // track water grid changes to avoid unnecessary updates

// controls (pointer lock + basic physics)
const movement = { fwd: false, back: false, left: false, right: false };
let yaw = 0;
let pitch = 0; // allow vertical look
let velocity = new THREE.Vector3();

document.addEventListener('keydown', (e) => {
  if (e.key === 'w') movement.fwd = true;
  if (e.key === 's') movement.back = true;
  if (e.key === 'a') movement.left = true;
  if (e.key === 'd') movement.right = true;
  if (e.code === 'Space') {
    // jump if grounded
    if (started && localPlayer.alive && localPlayer.grounded) {
      localPlayer.velY = 8; // jump impulse
      localPlayer.grounded = false;
    }
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'w') movement.fwd = false;
  if (e.key === 's') movement.back = false;
  if (e.key === 'a') movement.left = false;
  if (e.key === 'd') movement.right = false;
});

// New controls for abilities and actions
document.addEventListener('keydown', (e) => {
  if (!started || !localPlayer.alive) return;

  // Plant tree (E)
  if (e.key === 'e' || e.key === 'E') {
    const enhanced = e.shiftKey; // Shift+E for enhanced planting
    socket.emit('plantTree', {
      x: localPlayer.x,
      y: localPlayer.y,
      z: localPlayer.z,
      enhanced: enhanced
    });
    console.log(`[CLIENT] Attempting to plant tree ${enhanced ? '(enhanced)' : ''} at (${localPlayer.x.toFixed(1)}, ${localPlayer.z.toFixed(1)})`);
  }

  // Build solar panel (R)
  if (e.key === 'r' || e.key === 'R') {
    socket.emit('buildSolarPanel', {
      x: localPlayer.x,
      y: localPlayer.y,
      z: localPlayer.z
    });
    // console.log(`[CLIENT] Attempting to build solar panel at (${localPlayer.x.toFixed(1)}, ${localPlayer.z.toFixed(1)})`);
  }

  // Abilities
  if (e.key === 'q' || e.key === 'Q') {
    socket.emit('useAbility', { ability: 'speedBoost' });
    console.log('[CLIENT] Attempting to use speed boost');
  }
  if (e.key === 'f' || e.key === 'F') {
    socket.emit('useAbility', { ability: 'shield' });
    console.log('[CLIENT] Attempting to use shield');
  }
  if (e.key === 'g' || e.key === 'G') {
    socket.emit('useAbility', { ability: 'resourceScanner' });
    console.log('[CLIENT] Attempting to use resource scanner');
  }
  if (e.key === 't' || e.key === 'T') {
    // Teleport in movement direction
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const teleDir = new THREE.Vector3();
    if (movement.fwd) teleDir.add(forward);
    if (movement.back) teleDir.addScaledVector(forward, -1);
    if (movement.left) teleDir.addScaledVector(right, -1);
    if (movement.right) teleDir.add(right);
    if (teleDir.lengthSq() > 0) {
      teleDir.normalize().multiplyScalar(5); // 5 unit teleport
      socket.emit('useAbility', {
        ability: 'teleport',
        dx: teleDir.x,
        dz: teleDir.z
      });
      console.log(`[CLIENT] Attempting to teleport in direction (${teleDir.x.toFixed(1)}, ${teleDir.z.toFixed(1)})`);
    }
  }
});

// Socket event handlers for new systems
socket.on('buildSuccess', (data) => {
  if (data.score !== undefined) {
    showScoreGain(3, 'Solar Panel Built');
  }
  // Update client-side minerals immediately
  if (data.minerals !== undefined) {
    localPlayer.minerals = data.minerals;
  }
  console.log('[CLIENT] Build success:', data);
  playPickup();
});

socket.on('buildError', (data) => {
  console.warn('[CLIENT] Build error:', data.reason);
});

socket.on('abilitySuccess', (data) => {
  console.log('[CLIENT] Ability activated:', data.ability, 'Energy remaining:', data.energy);
  playPickup();
});

socket.on('abilityError', (data) => {
  console.warn('[CLIENT] Ability error:', data.reason);
});

socket.on('scannerActive', (data) => {
  scannerActive = true;
  scannerEndTime = Date.now() + data.duration;
  // Update scanner indicator visibility
  if (scannerIndicatorEl) {
    scannerIndicatorEl.style.display = 'block';
  }
  console.log('[CLIENT] Resource scanner activated! Resources will glow for', (data.duration / 1000).toFixed(1), 'seconds');
});

// Score notification system
let scoreNotificationEl = null;
function showScoreGain(amount, reason = '') {
  if (!scoreNotificationEl) {
    scoreNotificationEl = document.getElementById('scoreNotification');
  }
  if (scoreNotificationEl) {
    scoreNotificationEl.textContent = `+${amount} Score${reason ? ' (' + reason + ')' : ''}`;
    scoreNotificationEl.style.display = 'block';
    scoreNotificationEl.style.opacity = '1';
    scoreNotificationEl.style.transform = 'translate(-50%, -50%) scale(1.2)';

    // Animate out
    setTimeout(() => {
      scoreNotificationEl.style.transition = 'all 0.5s ease-out';
      scoreNotificationEl.style.opacity = '0';
      scoreNotificationEl.style.transform = 'translate(-50%, -70%) scale(0.8)';
      setTimeout(() => {
        scoreNotificationEl.style.display = 'none';
        scoreNotificationEl.style.transition = '';
      }, 500);
    }, 1000);
  }
}

socket.on('plantSuccess', (data) => {
  if (data.score !== undefined) {
    showScoreGain(2, 'Tree Planted');
  }
  console.log('[CLIENT] Tree planted:', data.treeId, data.enhanced ? '(enhanced)' : '');
  playPickup();
});

socket.on('plantError', (data) => {
  if (data.reason === 'in_water') {
    console.warn('[CLIENT] Cannot plant tree in water!');
    // Could show a UI message here if desired
  } else {
    console.warn('[CLIENT] Plant error:', data.reason);
  }
});

socket.on('harvestSuccess', (data) => {
  if (data.scoreGain) {
    showScoreGain(data.scoreGain, 'Tree Harvested');
  }
  // console.log('[CLIENT] Tree harvested, sustainability:', data.sustainability, 'seeds:', data.seeds);
  playPickup();
});

socket.on('harvestError', (data) => {
  console.warn('[CLIENT] Harvest error:', data.reason);
});

socket.on('rainStarted', (data) => {
  console.log('[CLIENT] Rain started! Duration:', data.duration / 1000, 'seconds');
});

socket.on('rainStopped', () => {
  console.log('[CLIENT] Rain stopped');
});

// pointer lock
canvas.addEventListener('click', () => { canvas.requestPointerLock?.(); });
document.addEventListener('pointerlockchange', () => { });
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    yaw -= e.movementX * 0.002;
    pitch -= e.movementY * 0.002;
    pitch = Math.max(-1.3, Math.min(1.3, pitch));
  }
});

// start overlay handling
const startOverlay = document.getElementById('startOverlay');
let started = false;
function startGame() {
  started = true;
  if (startOverlay) startOverlay.style.display = 'none';
  canvas.requestPointerLock?.();
}
if (startOverlay) startOverlay.addEventListener('click', startGame);

// shoot
window.addEventListener('mousedown', (e) => {
  if (!started) return;
  if (myId && document.pointerLockElement === canvas && localPlayer.alive) {
    // create bullet in camera direction
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.normalize();
    // optimistic ammo decrement for immediate feedback; server is authoritative
    if (localPlayer.ammo > 0) {
      // enforce client-side cooldown
      const now = Date.now();
      if (!localPlayer.lastShot || now - localPlayer.lastShot >= 100) {
        localPlayer.lastShot = now;
        localPlayer.ammo = Math.max(0, localPlayer.ammo - 1);
        if (ammoEl) ammoEl.textContent = Math.floor(localPlayer.ammo);
        playShoot();
        socket.emit('shoot', {
          x: localPlayer.x, y: localPlayer.y + 1, z: localPlayer.z,
          vx: dir.x * 40, vy: dir.y * 40, vz: dir.z * 40
        });
      }
    }
  }
});

let localPlayer = {
  x: 0, y: 1, z: 0, rotY: 0, score: 0, sustainability: 0, alive: true, ammo: 0,
  health: 100, water: 100, energy: 0, minerals: 0, seeds: 0,
  speedMultiplier: 1.0, activeAbilities: {}
};

// Resource scanner state
let scannerActive = false;
let scannerEndTime = 0;
// Cache raycaster and color objects for performance
const scannerRaycaster = new THREE.Raycaster();
const scannerCameraPos = new THREE.Vector3();
const scannerResourcePos = new THREE.Vector3();
const scannerDirection = new THREE.Vector3();
const scannerGlowColorRed = new THREE.Color(0xff0000);
const scannerGlowColorGreen = new THREE.Color(0x00ff00);
const scannerColorRed = new THREE.Color(0xff0000);
const scannerColorWhite = new THREE.Color(0xffffff);
let scannerFrameCounter = 0;
const SCANNER_RAYCAST_INTERVAL = 10; // Only raycast every 10 frames for performance (was 3, increased to reduce FPS drop)

const deathEl = document.getElementById('death');
// audio: simple WebAudio synth for SFX
let audioCtx = null;
function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
function playShoot() { ensureAudio(); const c = audioCtx.createOscillator(); const g = audioCtx.createGain(); c.type = 'square'; c.frequency.value = 1100; g.gain.value = 0.06; c.connect(g); g.connect(audioCtx.destination); c.start(); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12); c.stop(audioCtx.currentTime + 0.12); }
function playPickup() { ensureAudio(); const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = 600; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25); o.stop(audioCtx.currentTime + 0.25); }
function playDeath() { ensureAudio(); const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = 120; g.gain.value = 0.15; o.connect(g); g.connect(audioCtx.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6); o.stop(audioCtx.currentTime + 0.6); }

socket.on('init', (d) => {
  myId = d.id;
  console.log('[CLIENT] Initialized with ID:', myId);
});

socket.on('state', (s) => {
  state = s;
  // Verbose logging for debugging
  if (s.players && s.players[myId]) {
    const p = s.players[myId];
    const waterCells = s.waterGrid ? Object.keys(s.waterGrid).length : 0;
    if (Math.random() < 0.01) { // Log 1% of state updates to avoid spam
      console.log('[CLIENT] State update - Health:', p.health, 'Water:', p.water, 'Energy:', p.energy, 'Minerals:', p.minerals, 'Seeds:', p.seeds, 'WaterGrid:', waterCells, 'cells');
    }
  }

  // Debug water grid on first receive
  if (s.waterGrid && Object.keys(s.waterGrid).length > 0 && !lastWaterGridHash) {
    const sampleKey = Object.keys(s.waterGrid)[0];
    const sampleLevel = s.waterGrid[sampleKey];
    console.log('[WATER] Received water grid with', Object.keys(s.waterGrid).length, 'cells. Sample:', sampleKey, '=', sampleLevel);
  }
});
// server notified when we collect a pickup
socket.on('collected', (info) => {
  if (!info) return;
  // console.log('[CLIENT] Collected resource:', info.type);
  playPickup();
});

// Listen for score gains
socket.on('scoreGain', (data) => {
  if (data.amount) {
    const reasonText = data.reason === 'kill' ? 'Player Killed' :
      data.reason === 'collect_tree' ? 'Tree Collected' :
        data.reason || '';
    showScoreGain(data.amount, reasonText);
  }
});

// play death SFX when server marks us dead
let lastAliveState = true;

// object pooling: reuse geometries and materials for better performance
// realistic tree visuals with PBR materials
// Object pooling: reuse geometries and materials for better performance
// Realistic tree visuals with PBR materials
const treeTrunkGeo = new THREE.CylinderGeometry(0.15, 0.25, 4, 32, 8); // More radial and height segments for smoothness
const treeLeavesMat = new THREE.MeshStandardMaterial({
  color: 0x2d5016, // Deeper green
  roughness: 0.9,
  metalness: 0.0,
  emissive: 0x001100,
  side: THREE.DoubleSide, // For plane leaves
  transparent: true,
  alphaTest: 0.1 // Softer alpha cutoff for organic edges
});
treeLeavesMat.castShadow = true;
treeLeavesMat.receiveShadow = true;

const treeTrunkMat = new THREE.MeshStandardMaterial({
  color: 0x5c4033, // Richer brown
  roughness: 0.85,
  metalness: 0.1,
  emissive: 0x000000
});
treeTrunkMat.castShadow = true;
treeTrunkMat.receiveShadow = true;

// Procedural bark texture (unchanged, but add normal map below)
const barkCanvas = document.createElement('canvas');
barkCanvas.width = 256;
barkCanvas.height = 512;
const barkCtx = barkCanvas.getContext('2d');
const barkImageData = barkCtx.createImageData(256, 512);
const barkData = barkImageData.data;
for (let y = 0; y < 512; y++) {
  for (let x = 0; x < 256; x++) {
    const nx = x / 256 * 4;
    const ny = y / 512 * 20;
    const v = noise2(nx, ny) * 0.5 + 0.5;
    const baseR = 90 + v * 40;
    const r = Math.floor(baseR + (Math.random() * 20 - 10));
    const g = Math.floor(r * 0.8);
    const b = Math.floor(r * 0.7);
    const idx = (y * 256 + x) * 4;
    barkData[idx] = r;
    barkData[idx + 1] = g;
    barkData[idx + 2] = b;
    barkData[idx + 3] = 255;
  }
}
barkCtx.putImageData(barkImageData, 0, 0);
const barkTex = new THREE.CanvasTexture(barkCanvas);
barkTex.wrapS = THREE.RepeatWrapping;
barkTex.wrapT = THREE.RepeatWrapping;
barkTex.repeat.set(1, 2);
treeTrunkMat.map = barkTex;

// Add bark normal map for bumpy surface
const barkNormalCanvas = document.createElement('canvas');
barkNormalCanvas.width = 256;
barkNormalCanvas.height = 512;
const barkNormalCtx = barkNormalCanvas.getContext('2d');
const barkNormalImageData = barkNormalCtx.createImageData(256, 512);
const barkNormalData = barkNormalImageData.data;
for (let y = 0; y < 512; y++) {
  for (let x = 0; x < 256; x++) {
    const v = noise2(x / 256 * 4, y / 512 * 20) * 0.5 + 0.5;
    const bumpX = (noise2((x + 1) / 32, y / 32) - noise2((x - 1) / 32, y / 32)) * 128;
    const bumpY = (noise2(x / 32, (y + 1) / 32) - noise2(x / 32, (y - 1) / 32)) * 128;
    const idx = (y * 256 + x) * 4;
    barkNormalData[idx] = 128 + bumpX;
    barkNormalData[idx + 1] = 128 + bumpY;
    barkNormalData[idx + 2] = 255;
    barkNormalData[idx + 3] = 255;
  }
}
barkNormalCtx.putImageData(barkNormalImageData, 0, 0);
const barkNormalTex = new THREE.CanvasTexture(barkNormalCanvas);
barkNormalTex.wrapS = THREE.RepeatWrapping;
barkNormalTex.wrapT = THREE.RepeatWrapping;
barkNormalTex.repeat.set(1, 2);
treeTrunkMat.normalMap = barkNormalTex;
treeTrunkMat.normalScale.set(0.8, 0.8);
treeTrunkMat.needsUpdate = true;

// Procedural leaf texture (improve for planes: make it a simple leaf with alpha)
const leafCanvas = document.createElement('canvas');
leafCanvas.width = 128;
leafCanvas.height = 128;
const leafCtx = leafCanvas.getContext('2d');
// Draw oval leaf shape with gradient
const gradient = leafCtx.createLinearGradient(0, 0, 0, 128);
gradient.addColorStop(0, '#2d5016');
gradient.addColorStop(1, '#1a3a0d');
leafCtx.fillStyle = gradient;
leafCtx.beginPath();
leafCtx.ellipse(64, 64, 40, 60, 0, 0, Math.PI * 2);
leafCtx.fill();
// Add central vein
leafCtx.strokeStyle = '#14300a';
leafCtx.lineWidth = 4;
leafCtx.beginPath();
leafCtx.moveTo(64, 4);
leafCtx.lineTo(64, 124);
leafCtx.stroke();
// Side veins
for (let i = 1; i <= 4; i++) {
  leafCtx.lineWidth = 2;
  leafCtx.beginPath();
  leafCtx.moveTo(64, 32 * i);
  leafCtx.quadraticCurveTo(64 - 20 * i / 4, 32 * i + 20, 24, 32 * i + 30);
  leafCtx.stroke();
  leafCtx.beginPath();
  leafCtx.moveTo(64, 32 * i);
  leafCtx.quadraticCurveTo(64 + 20 * i / 4, 32 * i + 20, 104, 32 * i + 30);
  leafCtx.stroke();
}
// Alpha mask for edges (fade out)
const leafImageData = leafCtx.getImageData(0, 0, 128, 128);
const leafData = leafImageData.data;
for (let i = 0; i < leafData.length; i += 4) {
  const x = (i / 4) % 128 - 64;
  const y = Math.floor((i / 4) / 128) - 64;
  const dist = Math.sqrt(x * x + y * y);
  if (dist > 60) leafData[i + 3] = 0; // Transparent outside
  else if (dist > 50) leafData[i + 3] = (60 - dist) * 25.5; // Fade
}
leafCtx.putImageData(leafImageData, 0, 0);
const leafTex = new THREE.CanvasTexture(leafCanvas);
leafTex.wrapS = THREE.ClampToEdgeWrapping;
leafTex.wrapT = THREE.ClampToEdgeWrapping;
treeLeavesMat.map = leafTex;
treeLeavesMat.needsUpdate = true;

// Leaf normal map for vein depth
const leafNormalCanvas = document.createElement('canvas');
leafNormalCanvas.width = 128;
leafNormalCanvas.height = 128;
const leafNormalCtx = leafNormalCanvas.getContext('2d');
const leafNormalImageData = leafNormalCtx.createImageData(128, 128);
const leafNormalData = leafNormalImageData.data;
for (let y = 0; y < 128; y++) {
  for (let x = 0; x < 128; x++) {
    const idx = (y * 128 + x) * 4;
    leafNormalData[idx] = 128; // Neutral X
    leafNormalData[idx + 1] = 128; // Neutral Y
    leafNormalData[idx + 2] = 255; // Z up
    leafNormalData[idx + 3] = 255;
    // Simulate veins as bumps
    if (Math.abs(x - 64) < 2 && y > 4 && y < 124) { // Central vein
      leafNormalData[idx] = 160;
      leafNormalData[idx + 1] = 128;
    }
  }
}
leafNormalCtx.putImageData(leafNormalImageData, 0, 0);
const leafNormalTex = new THREE.CanvasTexture(leafNormalCanvas);
treeLeavesMat.normalMap = leafNormalTex;
treeLeavesMat.normalScale.set(0.3, 0.3);

// Realistic bullet visuals (unchanged)
const bulletGeo = new THREE.SphereGeometry(0.15, 12, 12);
const bulletMat = new THREE.MeshStandardMaterial({
  color: 0xffaa00,
  emissive: 0xff4400,
  emissiveIntensity: 0.8,
  metalness: 0.5,
  roughness: 0.3
});
bulletMat.castShadow = true;

// Object pools for trees and bullets
const treePool = [];
const activeTrees = new Set();
const bulletPool = [];

function makeTreeMesh() {
  let group;
  if (treePool.length > 0) {
    group = treePool.pop();
    group.visible = true;
    group.children.forEach(child => {
      child.visible = true;
      if (child instanceof THREE.InstancedMesh) {
        child.instanceMatrix.needsUpdate = true;
      }
    });
  } else {
    group = new THREE.Group();

    // Trunk with vertex displacement for organic shape
    const trunkGeoClone = treeTrunkGeo.clone();
    const positions = trunkGeoClone.attributes.position.array;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1] / 2; // Normalize y [0,1]
      const z = positions[i + 2];
      const angle = Math.atan2(z, x);
      const radius = Math.sqrt(x * x + z * z);
      const disp = (noise2(angle * 4, y * 5) * 0.5 + 0.5) * 0.08 * (1 - y); // More displacement at base
      positions[i] += Math.cos(angle) * disp;
      positions[i + 2] += Math.sin(angle) * disp;
    }
    trunkGeoClone.computeVertexNormals();
    trunkGeoClone.attributes.position.needsUpdate = true;

    const trunk = new THREE.Mesh(trunkGeoClone, treeTrunkMat);
    trunk.position.y = 1;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);

    // Add 4-6 branches with variation
    const numBranches = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < numBranches; i++) {
      const branchHeight = 1.2 + (i / numBranches) * 1.2;
      const branchLength = 0.6 + Math.random() * 0.4 - (i / numBranches) * 0.3; // Shorter higher up
      const branchGeo = new THREE.CylinderGeometry(0.04, 0.02, branchLength, 16, 1);
      // Displace branch for curve
      const branchPositions = branchGeo.attributes.position.array;
      for (let j = 0; j < branchPositions.length; j += 3) {
        const by = branchPositions[j + 1] / branchLength;
        branchPositions[j + 2] += Math.sin(by * Math.PI) * 0.1; // Slight curve
      }
      branchGeo.computeVertexNormals();
      branchGeo.attributes.position.needsUpdate = true;

      const branch = new THREE.Mesh(branchGeo, treeTrunkMat);
      branch.position.set(0, branchHeight, 0);
      branch.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2 + Math.random() * 0.4 - 0.2); // Outward tilt
      branch.castShadow = true;
      branch.receiveShadow = true;
      group.add(branch);
    }

    // Foliage: Use instanced planes for leaf clusters (200-400 leaves)
    const leafGeo = new THREE.PlaneGeometry(0.15, 0.2); // Small leaf size
    const numLeaves = 3000 + Math.floor(Math.random() * 500);
    const instancedLeaves = new THREE.InstancedMesh(leafGeo, treeLeavesMat, numLeaves);
    instancedLeaves.castShadow = true;
    instancedLeaves.receiveShadow = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < numLeaves; i++) {
      const layer = Math.floor(i / (numLeaves / 4)); // 4 layers
      const radius = (1.2 - layer * 0.25) * (0.7 + Math.random() * 0.3);
      const height = 1.8 + layer * 0.6 + Math.random() * 0.3 - 0.15;
      const angle = Math.random() * Math.PI * 2;
      dummy.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
      dummy.rotation.set(Math.random() * Math.PI / 2, Math.random() * Math.PI * 2, Math.random() * Math.PI / 4);
      dummy.scale.set(0.8 + Math.random() * 0.4, 0.8 + Math.random() * 0.4, 1);
      dummy.updateMatrix();
      instancedLeaves.setMatrixAt(i, dummy.matrix);
    }
    instancedLeaves.instanceMatrix.needsUpdate = true;
    group.add(instancedLeaves);
  }
  // Per-tree color variation
  group.traverse(child => {
    if (child.material === treeTrunkMat) {
      child.material = treeTrunkMat.clone();
      child.material.color.offsetHSL(0, 0, Math.random() * 0.1 - 0.05);
    } else if (child.material === treeLeavesMat) {
      child.material = treeLeavesMat.clone();
      child.material.color.offsetHSL(0.05 + Math.random() * 0.05, 0, Math.random() * 0.1 - 0.05);
    }
  });
  return group;
}

function recycleTreeMesh(tree) {
  if (tree && tree.parent) {
    tree.parent.remove(tree);
  }
  tree.visible = false;
  treePool.push(tree);
}

// Resource rendering - create meshes for different resource types
const resourceMeshes = {
  mineral: null,
  seed: null,
  solarPanel: null,
  plantedTree: null
};

// Create realistic resource geometries and materials with PBR
const mineralGeo = new THREE.OctahedronGeometry(0.3, 0);
const mineralMat = new THREE.MeshStandardMaterial({
  color: 0xffaa00, // Orange/gold color to distinguish from water
  metalness: 0.9,
  roughness: 0.1,
  emissive: 0xff6600,
  emissiveIntensity: 0.5
});
mineralMat.castShadow = true;
mineralMat.receiveShadow = true;

const waterGeo = new THREE.SphereGeometry(0.25, 16, 16);
const waterPickupMat = new THREE.MeshStandardMaterial({
  color: 0x4488ff,
  transparent: true,
  opacity: 0.8,
  metalness: 0.3,
  roughness: 0.1, // water is smooth
  emissive: 0x2244aa,
  emissiveIntensity: 0.2
});
waterPickupMat.castShadow = true;

const seedGeo = new THREE.SphereGeometry(0.15, 12, 12);
const seedMat = new THREE.MeshStandardMaterial({
  color: 0x8b4513,
  roughness: 0.8,
  metalness: 0.0,
  emissive: 0x000000,
  emissiveIntensity: 0
});
seedMat.castShadow = true;
seedMat.receiveShadow = true;

// Simple realistic water - single unified surface with waves
const WATER_GRID_CELL_SIZE = 4; // meters per cell - must be defined before render function

// Store water mesh
let waterMesh = null;

// Store water surface heights for underwater detection
let waterSurfaceHeights = new Map(); // key -> waterSurfaceY

// Simple water shader material with just waves
const waterMat = new THREE.ShaderMaterial({
  uniforms: {
    time: { value: 0 },
    fogColor: { value: new THREE.Color(0xe0f6ff) },
    fogDensity: { value: 0.012 },
    cameraPosition: { value: new THREE.Vector3() }
  },
  vertexShader: `
    #include <common>
    uniform float time;
    varying vec2 vUv;
    varying float vFogDepth;
    varying vec3 vWorldPos;
    
    void main() {
      vUv = uv;
      
      vec3 pos = position;
      
      // Simple up/down waves - multiple wave frequencies for realism
      float wave1 = sin(time * 1.5 + pos.x * 0.3 + pos.z * 0.3) * 0.08;
      float wave2 = sin(time * 2.0 + pos.x * 0.5 + pos.z * 0.4) * 0.05;
      float wave3 = sin(time * 1.2 + pos.x * 0.2 + pos.z * 0.6) * 0.03;
      pos.y += wave1 + wave2 + wave3;
      
      vec4 worldPos = modelMatrix * vec4(pos, 1.0);
      vWorldPos = worldPos.xyz;
      vFogDepth = length(worldPos.xyz - cameraPosition);
      
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `,
  fragmentShader: `
    #include <common>
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform float time;
    varying vec2 vUv;
    varying float vFogDepth;
    varying vec3 vWorldPos;
    
    out vec4 FragColor;
    
    void main() {
      // Simple, consistent water color - medium blue
      vec3 waterColor = vec3(0.3, 0.6, 0.9); // nice blue water color
      
      // Subtle ripples for surface detail
      float ripple = sin(vUv.x * 20.0 + time * 2.0) * sin(vUv.y * 20.0 + time * 2.0) * 0.02;
      waterColor += vec3(ripple * 0.1);
      
      // Fresnel effect for realistic water edges
      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      float fresnel = pow(1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0), 2.0);
      
      // Less transparent water - higher opacity
      float opacity = 0.95 + fresnel * 0.03;
      opacity = clamp(opacity, 0.92, 0.98);
      
      vec4 color = vec4(waterColor, opacity);
      
      // Apply fog
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      color.rgb = mix(color.rgb, fogColor, fogFactor);
      
      FragColor = color;
    }
  `,
  transparent: true,
  side: THREE.DoubleSide,
  depthWrite: false,
  depthTest: true,
  blending: THREE.NormalBlending,
  glslVersion: THREE.GLSL3
});

// Create realistic solar panel texture with grid pattern
const solarPanelCanvas = document.createElement('canvas');
solarPanelCanvas.width = 512;
solarPanelCanvas.height = 512;
const solarPanelCtx = solarPanelCanvas.getContext('2d');

// Base dark blue/black color for solar cells
solarPanelCtx.fillStyle = '#0a1a2a'; // Very dark blue-black
solarPanelCtx.fillRect(0, 0, 512, 512);

// Draw grid of solar cells (6x6 grid for 3m panel)
const cellSize = 512 / 6;
for (let row = 0; row < 6; row++) {
  for (let col = 0; col < 6; col++) {
    const x = col * cellSize;
    const y = row * cellSize;

    // Each cell has a slight gradient to look like a solar cell
    const gradient = solarPanelCtx.createLinearGradient(x, y, x + cellSize, y + cellSize);
    gradient.addColorStop(0, '#1a2a3a'); // Slightly lighter at top
    gradient.addColorStop(0.5, '#0a1a2a'); // Darker in middle
    gradient.addColorStop(1, '#152535'); // Slightly lighter at bottom

    solarPanelCtx.fillStyle = gradient;
    solarPanelCtx.fillRect(x + 2, y + 2, cellSize - 4, cellSize - 4);

    // Add subtle border between cells
    solarPanelCtx.strokeStyle = '#000000';
    solarPanelCtx.lineWidth = 1;
    solarPanelCtx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
  }
}

// Add metallic frame around edges
solarPanelCtx.strokeStyle = '#3a4a5a';
solarPanelCtx.lineWidth = 8;
solarPanelCtx.strokeRect(4, 4, 504, 504);

const solarPanelTex = new THREE.CanvasTexture(solarPanelCanvas);
solarPanelTex.wrapS = THREE.RepeatWrapping;
solarPanelTex.wrapT = THREE.RepeatWrapping;
solarPanelTex.repeat.set(1, 1);

const solarPanelGeo = new THREE.BoxGeometry(3.0, 0.1, 3.0);
const solarPanelMat = new THREE.MeshStandardMaterial({
  map: solarPanelTex,
  color: 0xffffff, // White to show texture properly
  metalness: 0.8,
  roughness: 0.2,
  emissive: 0x222200, // Subtle yellow glow
  emissiveIntensity: 0.1
});
solarPanelMat.castShadow = true;
solarPanelMat.receiveShadow = true;

// Resource pools
const resourcePools = {
  mineral: [],
  seed: [],
  solarPanel: []
};

function createResourceMesh(type) {
  let mesh;
  const pool = resourcePools[type];

  if (pool && pool.length > 0) {
    mesh = pool.pop();
    mesh.visible = true;
  } else {
    switch (type) {
      case 'mineral':
        mesh = new THREE.Mesh(mineralGeo, mineralMat);
        break;
      case 'seed':
        mesh = new THREE.Mesh(seedGeo, seedMat);
        break;
      case 'solarPanel':
        mesh = new THREE.Mesh(solarPanelGeo, solarPanelMat);
        break;
      default:
        console.warn('[CLIENT] Unknown resource type:', type);
        return null;
    }
  }
  return mesh;
}

function recycleResourceMesh(mesh, type) {
  if (mesh && mesh.parent) {
    mesh.parent.remove(mesh);
  }
  mesh.visible = false;
  if (resourcePools[type]) {
    resourcePools[type].push(mesh);
  }
}

// realistic player visuals with PBR
const playerBoxGeo = new THREE.BoxGeometry(1, 3, 1);
const otherPlayerMat = new THREE.MeshStandardMaterial({
  color: 0xff0000,
  metalness: 0.3,
  roughness: 0.7
});
otherPlayerMat.castShadow = true;
otherPlayerMat.receiveShadow = true;

function ensureOther(id) {
  if (otherPlayers[id]) return otherPlayers[id];
  const g = new THREE.Mesh(playerBoxGeo, otherPlayerMat.clone()); // clone material for per-player colors
  g.castShadow = true;
  g.receiveShadow = true;
  scene.add(g);
  otherPlayers[id] = { mesh: g };
  return otherPlayers[id];
}

function render() {
  const dt = 1 / 60;
  // show/hide death overlay
  if (!localPlayer.alive) {
    if (deathEl) {
      deathEl.style.display = 'block';
      // show countdown if respawn time is provided
      if (localPlayer.respawnAt) {
        const remaining = Math.max(0, Math.ceil((localPlayer.respawnAt - Date.now()) / 1000));
        deathEl.textContent = `YOU DIED — Respawning in ${remaining}s`;
      } else {
        deathEl.textContent = 'YOU DIED — Respawning...';
      }
    }
  } else {
    if (deathEl) deathEl.style.display = 'none';
  }

  // simple movement (only when alive AND after start)
  if (started && localPlayer.alive) {
    const speed = 8 * (localPlayer.speedMultiplier || 1.0);
    // fix W/S inversion: forward should point along the camera -Z direction
    // optimize: reuse vectors to avoid allocations
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const move = new THREE.Vector3();
    if (movement.fwd) move.add(forward);
    if (movement.back) move.addScaledVector(forward, -1); // avoid clone
    if (movement.left) move.addScaledVector(right, -1); // avoid clone
    if (movement.right) move.add(right);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);

    localPlayer.x += move.x; localPlayer.z += move.z;
    // physics for vertical movement (gravity + jump)
    if (typeof localPlayer.velY === 'undefined') localPlayer.velY = 0;
    const groundH = getHeightAt(localPlayer.x, localPlayer.z);
    const GROUND_TOLERANCE = 0.1; // tolerance to prevent bouncing

    // apply gravity if not grounded
    if (!localPlayer.grounded) {
      localPlayer.velY += -30 * dt; // gravity
      localPlayer.y += localPlayer.velY * dt;
    }

    // check ground contact with tolerance to prevent rapid bouncing
    if (localPlayer.y <= groundH + GROUND_TOLERANCE) {
      // Only snap to ground if we're close enough and moving down or stationary
      if (localPlayer.velY <= 0.1) {
        localPlayer.y = groundH;
        localPlayer.velY = 0;
        localPlayer.grounded = true;
      }
    } else if (localPlayer.y > groundH + GROUND_TOLERANCE * 2) {
      // Only mark as not grounded if clearly above ground
      localPlayer.grounded = false;
    }
    localPlayer.rotY = yaw;

    // send update
    socket.emit('update', { x: localPlayer.x, y: localPlayer.y, z: localPlayer.z, rotY: localPlayer.rotY });
  }

  // camera: first-person at player's head with full mouse look (yaw + pitch)
  // Camera altitude is 2x less - if feet are at y, camera is at y + 0.8 (was y + 1.6)
  camera.position.set(localPlayer.x, localPlayer.y + 1, localPlayer.z);
  camera.rotation.order = 'YXZ'; // yaw first, then pitch (important for correct FPS look)
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  // Update camera position in water shader
  if (waterMat) {
    waterMat.uniforms.cameraPosition.value.copy(camera.position);
  }

  // Underwater detection and fog
  let isUnderwater = false;
  let underwaterDepth = 0;
  const cameraY = camera.position.y;
  const cameraX = camera.position.x;
  const cameraZ = camera.position.z;

  // Calculate grid coordinates for camera position
  const gx = Math.floor((cameraX + 200) / WATER_GRID_CELL_SIZE);
  const gz = Math.floor((cameraZ + 200) / WATER_GRID_CELL_SIZE);
  const waterKey = `${gx},${gz}`;

  // Check if camera is below water surface at current grid cell
  if (waterSurfaceHeights.has(waterKey)) {
    const waterSurfaceY = waterSurfaceHeights.get(waterKey);
    if (cameraY < waterSurfaceY) {
      isUnderwater = true;
      underwaterDepth = waterSurfaceY - cameraY;
    }
  }

  // Also check neighboring cells in case camera is near edge
  if (!isUnderwater) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const neighborKey = `${gx + dx},${gz + dz}`;
        if (waterSurfaceHeights.has(neighborKey)) {
          const waterSurfaceY = waterSurfaceHeights.get(neighborKey);
          if (cameraY < waterSurfaceY) {
            // Check if camera is actually within this cell
            const cellX = ((gx + dx) * WATER_GRID_CELL_SIZE) - 200;
            const cellZ = ((gz + dz) * WATER_GRID_CELL_SIZE) - 200;
            const distX = Math.abs(cameraX - cellX);
            const distZ = Math.abs(cameraZ - cellZ);
            if (distX < WATER_GRID_CELL_SIZE * 0.6 && distZ < WATER_GRID_CELL_SIZE * 0.6) {
              isUnderwater = true;
              underwaterDepth = waterSurfaceY - cameraY;
              break;
            }
          }
        }
        if (isUnderwater) break;
      }
      if (isUnderwater) break;
    }
  }

  // Apply underwater fog - blue tinted fog when underwater (100x stronger)
  // Smooth transition using lerp
  if (!localPlayer.smoothFogIntensity) localPlayer.smoothFogIntensity = 0;
  if (!localPlayer.smoothFogDensity) localPlayer.smoothFogDensity = 0.01;
  if (!localPlayer.smoothFogColor) localPlayer.smoothFogColor = new THREE.Color(0xe8f4ff);

  let targetFogIntensity = 0;
  let targetFogDensity = 0.01;
  const targetFogColor = new THREE.Color(0xe8f4ff);

  if (isUnderwater) {
    // Stronger blue fog the deeper you go
    const fogIntensity = Math.min(underwaterDepth / 2.0, 1.0); // max at 2m depth
    targetFogIntensity = fogIntensity;
    const underwaterFogColor = new THREE.Color(0.05, 0.15, 0.4); // darker blue for underwater
    targetFogColor.lerpColors(new THREE.Color(0xe8f4ff), underwaterFogColor, Math.min(fogIntensity * 0.95, 1.0));
    targetFogDensity = 1.0 + (fogIntensity * 5.0); // 100x stronger fog
  }

  // Smooth interpolation (lerp factor of 0.1 for smooth transition)
  const lerpFactor = 0.1;
  localPlayer.smoothFogIntensity = THREE.MathUtils.lerp(localPlayer.smoothFogIntensity, targetFogIntensity, lerpFactor);
  localPlayer.smoothFogDensity = THREE.MathUtils.lerp(localPlayer.smoothFogDensity, targetFogDensity, lerpFactor);
  localPlayer.smoothFogColor.lerp(targetFogColor, lerpFactor);

  // Apply smoothed values
  scene.fog.color.copy(localPlayer.smoothFogColor);
  scene.fog.density = localPlayer.smoothFogDensity;

  // Tint terrain blue when underwater (also smoothed)
  const underwaterTint = new THREE.Color(0.2, 0.4, 0.7); // blue tint
  const normalColor = new THREE.Color(0x6b8e23); // richer olive green
  terrainMat.color.lerpColors(normalColor, underwaterTint, localPlayer.smoothFogIntensity * 0.6);

  const underwaterIntensity = localPlayer.smoothFogIntensity;

  // Update grass shader with underwater state
  if (bladeMat) {
    bladeMat.uniforms.underwaterIntensity = { value: underwaterIntensity };
  }

  // apply server state
  const players = state.players || {};
  for (const id in players) {
    const p = players[id];
    if (id === myId) {
      // sync important state from server (including respawn position)
      localPlayer.score = p.score;
      localPlayer.sustainability = p.sustainability;
      localPlayer.alive = p.alive;
      localPlayer.ammo = (typeof p.ammo === 'number') ? p.ammo : localPlayer.ammo;
      // respawn timing: server may include respawnAt timestamp (ms) when dead
      if (!p.alive && p.respawnAt) {
        localPlayer.respawnAt = p.respawnAt;
      } else {
        delete localPlayer.respawnAt;
      }
      // if server moved us (respawn), adopt server position when alive
      if (p.alive) {
        localPlayer.x = p.x;
        localPlayer.z = p.z;
        localPlayer.y = p.y !== undefined ? p.y : getHeightAt(p.x, p.z);
      }
      // play death SFX on transition
      if (lastAliveState && !localPlayer.alive) playDeath();
      lastAliveState = localPlayer.alive;

      // Update all player stats
      localPlayer.health = p.health || localPlayer.health;
      localPlayer.water = p.water || localPlayer.water;
      localPlayer.energy = p.energy || localPlayer.energy;
      localPlayer.minerals = p.minerals || localPlayer.minerals;
      localPlayer.seeds = p.seeds || localPlayer.seeds;
      localPlayer.speedMultiplier = p.speedMultiplier || 1.0;
      localPlayer.activeAbilities = p.activeAbilities || {};

      // Update scanner state from server - check if scanner ability is active
      if (p.activeAbilities && p.activeAbilities.resourceScanner) {
        const scannerEndTime = p.activeAbilities.resourceScanner;
        scannerActive = Date.now() < scannerEndTime;
        if (scannerActive && Math.random() < 0.05) { // Log 5% of active scans
          console.log('[CLIENT] Scanner active, time remaining:', ((scannerEndTime - Date.now()) / 1000).toFixed(1), 's');
        }
      } else {
        scannerActive = false;
      }

      // Update scanner indicator visibility
      if (scannerIndicatorEl) {
        scannerIndicatorEl.style.display = scannerActive ? 'block' : 'none';
      }

      // optimize DOM updates: only update when values change
      const newScore = Math.floor(localPlayer.score);
      const newSust = Math.floor(localPlayer.sustainability);
      const newAmmo = Math.floor(localPlayer.ammo);
      const newHealth = Math.floor(localPlayer.health);
      const newWater = Math.floor(localPlayer.water);
      const newEnergy = Math.floor(localPlayer.energy);
      const newMinerals = Math.floor(localPlayer.minerals);
      const newSeeds = Math.floor(localPlayer.seeds);

      if (scoreEl.textContent !== String(newScore)) scoreEl.textContent = newScore;
      if (sustEl.textContent !== String(newSust)) sustEl.textContent = newSust;
      if (ammoEl && ammoEl.textContent !== String(newAmmo)) ammoEl.textContent = newAmmo;
      if (healthEl && healthEl.textContent !== String(newHealth)) healthEl.textContent = newHealth;
      if (waterEl && waterEl.textContent !== String(newWater)) waterEl.textContent = newWater;
      if (energyEl && energyEl.textContent !== String(newEnergy)) energyEl.textContent = newEnergy;
      if (mineralsEl && mineralsEl.textContent !== String(newMinerals)) mineralsEl.textContent = newMinerals;
      if (seedsEl && seedsEl.textContent !== String(newSeeds)) seedsEl.textContent = newSeeds;
      continue;
    }
    const o = ensureOther(id);
    o.mesh.position.set(p.x, p.y, p.z);
    o.mesh.visible = p.alive;
    // color
    if (p.color) o.mesh.material.color.setStyle(p.color);
  }

  // pickups
  for (const pid in pickups) {
    // remove stale
    const obj = pickups[pid];
    if (obj && obj.mesh) {
      // keep
    }
  }

  // rebuild pickups from state - handle all resource types
  const pickupIds = new Set();
  if (state.pickups) {
    for (const k in state.pickups) {
      pickupIds.add(k);
      const pk = state.pickups[k];

      if (!pickups[k]) {
        let mesh;
        if (pk.type === 'tree') {
          mesh = makeTreeMesh();
          mesh.scale.setScalar(0.9 + Math.random() * 0.4);
          mesh.rotation.y = Math.random() * Math.PI * 2;
          activeTrees.add(mesh);
        } else {
          mesh = createResourceMesh(pk.type);
          if (!mesh) {
            console.warn('[CLIENT] Failed to create mesh for pickup type:', pk.type);
            continue;
          }
        }

        // Lower trees so trunk bottom is at ground level (trunk starts at y=0.5 in mesh)
        const groundY = pk.y || getHeightAt(pk.x, pk.z);
        const baseY = pk.type === 'tree' ? groundY - 0.5 : groundY + 0.6;
        mesh.position.set(pk.x, baseY, pk.z);
        // Enable shadows for all pickups
        if (mesh.children) {
          mesh.children.forEach(child => {
            child.castShadow = true;
            child.receiveShadow = true;
          });
        } else {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
        scene.add(mesh);
        pickups[k] = { mesh: mesh, type: pk.type };
      } else {
        // Update position - trees stay fixed, other resources float
        const groundY = pk.y || getHeightAt(pk.x, pk.z);
        const isTree = pk.type === 'tree' || pk.type === 'plantedTree';

        if (isTree) {
          // Trees stay fixed on ground - trunk bottom at ground level (trunk starts at y=0.5 in mesh)
          const baseY = groundY - 1.5;
          pickups[k].mesh.position.set(pk.x, baseY, pk.z);

          // Check if wild tree is in water and apply underwater visual effects
          // Use 3 meter buffer zone - if water is within 3m of ground, tree is considered in water
          const WATER_BUFFER_ZONE = 3.0;
          let treeInWater = false;
          if (state.waterGrid && waterSurfaceHeights.size > 0) {
            const gx = Math.floor((pk.x + 200) / WATER_GRID_CELL_SIZE);
            const gz = Math.floor((pk.z + 200) / WATER_GRID_CELL_SIZE);
            const waterKey = `${gx},${gz}`;
            if (waterSurfaceHeights.has(waterKey)) {
              const waterSurfaceY = waterSurfaceHeights.get(waterKey);
              // Tree is in water if water surface is within 1 meter of ground (buffer zone) or above
              const waterDistanceFromGround = waterSurfaceY - groundY;
              if (waterDistanceFromGround >= -WATER_BUFFER_ZONE) {
                treeInWater = true;
              }
            }
          }

          // Apply underwater visual effects to wild trees
          if (treeInWater && pickups[k].mesh && pickups[k].mesh.children) {
            const underwaterTint = new THREE.Color(0.2, 0.4, 0.7);
            const normalTrunkColor = new THREE.Color(0x5c4033);
            const normalLeavesColor = new THREE.Color(0x2d5016);

            pickups[k].mesh.children.forEach((child, idx) => {
              if (child.material) {
                if (idx === 0) {
                  child.material.color.lerpColors(normalTrunkColor, underwaterTint, 0.4);
                } else {
                  child.material.color.lerpColors(normalLeavesColor, underwaterTint, 0.5);
                  if (child.material.emissive) {
                    child.material.emissiveIntensity = Math.max(0, (child.material.emissiveIntensity || 0) - 0.1);
                  }
                }
              }
            });
          } else if (pickups[k].mesh && pickups[k].mesh.children) {
            // Reset to normal colors when not in water
            const normalTrunkColor = new THREE.Color(0x5c4033);
            const normalLeavesColor = new THREE.Color(0x2d5016);
            pickups[k].mesh.children.forEach((child, idx) => {
              if (child.material) {
                if (idx === 0) {
                  child.material.color.copy(normalTrunkColor);
                } else {
                  child.material.color.copy(normalLeavesColor);
                  if (child.material.emissive) {
                    child.material.emissiveIntensity = 0.001;
                  }
                }
              }
            });
          }
        } else {
          // Floating animation for resources only
          const baseY = groundY + 0.6;
          const time = performance.now() * 0.001;
          const floatOffset = Math.sin(time * 2 + pk.x * 0.1 + pk.z * 0.1) * 0.15; // gentle floating
          const rotationSpeed = 0.5;
          pickups[k].mesh.position.set(pk.x, baseY + floatOffset, pk.z);
          // Add gentle rotation for visual appeal
          if (pk.type !== 'solarPanel') {
            pickups[k].mesh.rotation.y += rotationSpeed * 0.01;
          }
        }
      }

      // Apply scanner visual effect - make resources glow when scanner is active
      // Show minerals and harvestable trees even if blocked, with indicator
      if (scannerActive && pickups[k].mesh && (pk.type === 'mineral' || pk.type === 'tree' || pk.type === 'plantedTree')) {
        const distance = Math.sqrt(
          Math.pow(pk.x - localPlayer.x, 2) +
          Math.pow(pk.z - localPlayer.z, 2)
        );
        const maxRange = 200; // scanner range in meters

        if (distance <= maxRange) {
          // Check line of sight using raycasting (optimized - only every few frames)
          let isBlocked = false;
          scannerFrameCounter++;
          if (scannerFrameCounter % SCANNER_RAYCAST_INTERVAL === 0) {
            scannerCameraPos.set(localPlayer.x, localPlayer.y + 0.4, localPlayer.z);
            scannerResourcePos.set(pk.x, pk.y || (getHeightAt(pk.x, pk.z) + 0.4), pk.z);
            scannerDirection.subVectors(scannerResourcePos, scannerCameraPos).normalize();

            scannerRaycaster.set(scannerCameraPos, scannerDirection);
            // Only check terrain and trees for occlusion (not grass, water, etc.) - much faster
            const objectsToCheck = [terrain];
            // Add trees to check list
            for (const k in pickups) {
              if (pickups[k].mesh && (pickups[k].type === 'tree' || pickups[k].type === 'plantedTree')) {
                if (pickups[k].mesh.children) {
                  pickups[k].mesh.children.forEach(child => objectsToCheck.push(child));
                } else {
                  objectsToCheck.push(pickups[k].mesh);
                }
              }
            }
            const intersects = scannerRaycaster.intersectObjects(objectsToCheck, false);

            // Check if resource is blocked (something is between camera and resource)
            if (intersects.length > 0) {
              const firstHit = intersects[0];
              const hitDistance = firstHit.distance;
              const resourceDistance = scannerCameraPos.distanceTo(scannerResourcePos);
              // If first hit is closer than the resource, it's blocked
              if (hitDistance < resourceDistance - 0.5) {
                isBlocked = true;
              }
            }
            // Cache blocked state in pickup object
            if (!pickups[k].scannerBlocked) pickups[k].scannerBlocked = false;
            pickups[k].scannerBlocked = isBlocked;
          } else {
            // Use cached blocked state
            isBlocked = pickups[k].scannerBlocked || false;
          }

          // Make resource glow by increasing emissive intensity (subtle glow)
          const time = performance.now() * 0.003;
          const pulse = (Math.sin(time) + 1) * 0.5; // 0 to 1 pulse

          // Use different colors for blocked vs visible resources (reuse cached colors)
          const glowColor = isBlocked ? scannerGlowColorRed : scannerGlowColorGreen;
          // Reduced glow intensity for more subtle effect
          const glowIntensity = isBlocked ? 0.1 + pulse * 0.2 : 0.1 + pulse * 0.15;

          // Handle tree groups (they have children with materials)
          if (pickups[k].mesh.children && pickups[k].mesh.children.length > 0) {
            // It's a tree group
            pickups[k].mesh.children.forEach(child => {
              if (child.material) {
                if (!child.material.emissive) {
                  child.material.emissive = new THREE.Color();
                }
                child.material.emissive.copy(glowColor);
                child.material.emissiveIntensity = glowIntensity;
                // Add red tint to base color if blocked (reuse cached colors)
                if (isBlocked) {
                  child.material.color.lerp(scannerColorRed, 0.3);
                } else {
                  child.material.color.lerp(scannerColorWhite, 0.0); // reset to original
                }
              }
            });
          } else if (pickups[k].mesh.material) {
            // Single mesh resource (minerals, seeds)
            // Ensure material supports emissive
            if (!pickups[k].mesh.material.emissive) {
              pickups[k].mesh.material.emissive = new THREE.Color();
            }
            pickups[k].mesh.material.emissive.copy(glowColor);
            pickups[k].mesh.material.emissiveIntensity = glowIntensity;
            // Add red tint to base color if blocked (reuse cached colors)
            if (isBlocked) {
              pickups[k].mesh.material.color.lerp(scannerColorRed, 0.3);
            } else {
              pickups[k].mesh.material.color.lerp(scannerColorWhite, 0.0); // reset to original
            }
          }
        } else {
          // Reset emissive when out of range
          if (pickups[k].mesh.children && pickups[k].mesh.children.length > 0) {
            pickups[k].mesh.children.forEach(child => {
              if (child.material && child.material.emissiveIntensity > 0.1) {
                child.material.emissiveIntensity = 0.1;
                child.material.color.lerp(scannerColorWhite, 0.0); // reset color
              }
            });
          } else if (pickups[k].mesh.material && pickups[k].mesh.material.emissiveIntensity > 0.1) {
            pickups[k].mesh.material.emissiveIntensity = 0.1;
            pickups[k].mesh.material.color.lerp(scannerColorWhite, 0.0); // reset color
          }
        }
      } else {
        // Reset emissive when scanner is not active
        if (pickups[k].mesh) {
          if (pickups[k].mesh.children && pickups[k].mesh.children.length > 0) {
            pickups[k].mesh.children.forEach(child => {
              if (child.material && child.material.emissiveIntensity > 0.1) {
                child.material.emissiveIntensity = 0.1;
              }
            });
          } else if (pickups[k].mesh.material && pickups[k].mesh.material.emissiveIntensity > 0.1) {
            pickups[k].mesh.material.emissiveIntensity = 0.1;
          }
        }
      }
    }
  }

  // remove old pickups and recycle meshes
  for (const k in pickups) {
    if (!pickupIds.has(k)) {
      if (pickups[k].mesh) {
        if (pickups[k].type === 'tree') {
          activeTrees.delete(pickups[k].mesh);
          recycleTreeMesh(pickups[k].mesh);
        } else {
          recycleResourceMesh(pickups[k].mesh, pickups[k].type);
        }
      }
      delete pickups[k];
    }
  }

  // Render solar panels
  const solarPanelIds = new Set();
  if (state.solarPanels) {
    for (const playerId in state.solarPanels) {
      const panels = state.solarPanels[playerId];
      for (const panel of panels) {
        solarPanelIds.add(panel.id);
        if (!pickups['panel_' + panel.id]) {
          const mesh = createResourceMesh('solarPanel');
          if (mesh) {
            const height = panel.y || getHeightAt(panel.x, panel.z);
            mesh.position.set(panel.x, height + 0.5, panel.z); // Raise 0.5m off ground
            mesh.rotation.y = 0; // No rotation - keep panels flat and natural
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);
            pickups['panel_' + panel.id] = { mesh: mesh, type: 'solarPanel' };
          }
        } else {
          const height = panel.y || getHeightAt(panel.x, panel.z);
          pickups['panel_' + panel.id].mesh.position.set(panel.x, height + 0.5, panel.z);
          pickups['panel_' + panel.id].mesh.rotation.y = 0; // Keep rotation at 0
        }

        // Apply scanner effect to solar panels
        if (scannerActive && pickups['panel_' + panel.id] && pickups['panel_' + panel.id].mesh) {
          const distance = Math.sqrt(
            Math.pow(panel.x - localPlayer.x, 2) +
            Math.pow(panel.z - localPlayer.z, 2)
          );
          if (distance <= 200 && pickups['panel_' + panel.id].mesh.material) {
            const time = performance.now() * 0.003;
            const pulse = (Math.sin(time) + 1) * 0.5;
            if (!pickups['panel_' + panel.id].mesh.material.emissive) {
              pickups['panel_' + panel.id].mesh.material.emissive = new THREE.Color(0xffffff);
            }
            // Reduced glow intensity for more subtle effect
            pickups['panel_' + panel.id].mesh.material.emissiveIntensity = 0.1 + pulse * 0.15;
          } else if (pickups['panel_' + panel.id].mesh.material && pickups['panel_' + panel.id].mesh.material.emissiveIntensity > 0.1) {
            pickups['panel_' + panel.id].mesh.material.emissiveIntensity = 0.1;
          }
        } else if (pickups['panel_' + panel.id] && pickups['panel_' + panel.id].mesh && pickups['panel_' + panel.id].mesh.material) {
          // Reset when scanner not active
          if (pickups['panel_' + panel.id].mesh.material.emissiveIntensity > 0.1) {
            pickups['panel_' + panel.id].mesh.material.emissiveIntensity = 0.1;
          }
        }
      }
    }
  }

  // Remove old solar panels
  for (const k in pickups) {
    if (k.startsWith('panel_') && !solarPanelIds.has(k.replace('panel_', ''))) {
      if (pickups[k].mesh) {
        recycleResourceMesh(pickups[k].mesh, 'solarPanel');
      }
      delete pickups[k];
    }
  }

  // Render planted trees with growth stages
  const plantedTreeIds = new Set();
  if (state.plantedTrees) {
    for (const treeId in state.plantedTrees) {
      plantedTreeIds.add(treeId);
      const tree = state.plantedTrees[treeId];

      if (!pickups['tree_' + treeId]) {
        const mesh = makeTreeMesh();
        const growthScale = 0.3 + (tree.growthStage / 3) * 0.7; // scale from 0.3 to 1.0
        mesh.scale.setScalar(growthScale);
        // Lower trees so trunk bottom is at ground level (trunk starts at y=0.5 in mesh)
        const groundY = tree.y || getHeightAt(tree.x, tree.z);
        const baseY = groundY - 0.5;
        mesh.position.set(tree.x, baseY, tree.z);
        // Enable shadows
        mesh.children.forEach(child => {
          child.castShadow = true;
          child.receiveShadow = true;
        });
        scene.add(mesh);
        pickups['tree_' + treeId] = { mesh: mesh, type: 'plantedTree', treeId: treeId };
      } else {
        const growthScale = 0.3 + (tree.growthStage / 3) * 0.7;
        pickups['tree_' + treeId].mesh.scale.setScalar(growthScale);
        // Lower trees so trunk bottom is at ground level
        const groundY = tree.y || getHeightAt(tree.x, tree.z);
        const baseY = groundY - 0.5;
        pickups['tree_' + treeId].mesh.position.set(tree.x, baseY, tree.z);
      }

      // Check if tree is in water and apply underwater visual effects
      // Use 3 meter buffer zone - if water is within 3m of ground, tree is considered in water
      const WATER_BUFFER_ZONE = 3.0;
      let treeInWater = false;
      if (state.waterGrid && waterSurfaceHeights.size > 0) {
        const gx = Math.floor((tree.x + 200) / WATER_GRID_CELL_SIZE);
        const gz = Math.floor((tree.z + 200) / WATER_GRID_CELL_SIZE);
        const waterKey = `${gx},${gz}`;
        if (waterSurfaceHeights.has(waterKey)) {
          const waterSurfaceY = waterSurfaceHeights.get(waterKey);
          const treeGroundY = tree.y || getHeightAt(tree.x, tree.z);
          // Tree is in water if water surface is within 1 meter of ground (buffer zone) or above
          const waterDistanceFromGround = waterSurfaceY - treeGroundY;
          if (waterDistanceFromGround >= -WATER_BUFFER_ZONE) {
            treeInWater = true;
          }
        }
      }

      // Apply underwater visual effects to trees (blue tint, darker appearance)
      if (treeInWater && pickups['tree_' + treeId] && pickups['tree_' + treeId].mesh) {
        const underwaterTint = new THREE.Color(0.2, 0.4, 0.7); // blue tint
        const normalTrunkColor = new THREE.Color(0x5c4033);
        const normalLeavesColor = new THREE.Color(0x2d5016);

        if (pickups['tree_' + treeId].mesh.children) {
          pickups['tree_' + treeId].mesh.children.forEach((child, idx) => {
            if (child.material) {
              // Apply stronger blue tint to underwater trees
              if (idx === 0) {
                // Trunk - darker and bluer
                child.material.color.lerpColors(normalTrunkColor, underwaterTint, 0.4);
              } else {
                // Leaves - darker and bluer, look more submerged
                child.material.color.lerpColors(normalLeavesColor, underwaterTint, 0.5);
                // Reduce emissive to make it look darker underwater
                if (child.material.emissive) {
                  child.material.emissiveIntensity = Math.max(0, (child.material.emissiveIntensity || 0) - 0.1);
                }
              }
            }
          });
        }
      } else if (pickups['tree_' + treeId] && pickups['tree_' + treeId].mesh) {
        // Reset to normal colors when not in water
        const normalTrunkColor = new THREE.Color(0x5c4033);
        const normalLeavesColor = new THREE.Color(0x2d5016);
        if (pickups['tree_' + treeId].mesh.children) {
          pickups['tree_' + treeId].mesh.children.forEach((child, idx) => {
            if (child.material) {
              if (idx === 0) {
                child.material.color.copy(normalTrunkColor);
              } else {
                child.material.color.copy(normalLeavesColor);
                // Restore emissive
                if (child.material.emissive) {
                  child.material.emissiveIntensity = 0.001; // subtle green glow
                }
              }
            }
          });
        }
      }

      // Apply scanner effect to planted trees (only if harvestable)
      if (scannerActive && tree.harvestable && pickups['tree_' + treeId] && pickups['tree_' + treeId].mesh) {
        const distance = Math.sqrt(
          Math.pow(tree.x - localPlayer.x, 2) +
          Math.pow(tree.z - localPlayer.z, 2)
        );
        if (distance <= 200) {
          // Check line of sight using raycasting (optimized - reuse cached raycaster)
          let isBlocked = false;
          if (scannerFrameCounter % SCANNER_RAYCAST_INTERVAL === 0) {
            scannerCameraPos.set(localPlayer.x, localPlayer.y + 0.8, localPlayer.z);
            scannerResourcePos.set(tree.x, tree.y || getHeightAt(tree.x, tree.z), tree.z);
            scannerDirection.subVectors(scannerResourcePos, scannerCameraPos).normalize();

            scannerRaycaster.set(scannerCameraPos, scannerDirection);
            // Only check terrain and trees for occlusion (not grass, water, etc.) - much faster
            const objectsToCheck = [terrain];
            // Add trees to check list
            for (const k in pickups) {
              if (pickups[k].mesh && (pickups[k].type === 'tree' || pickups[k].type === 'plantedTree')) {
                if (pickups[k].mesh.children) {
                  pickups[k].mesh.children.forEach(child => objectsToCheck.push(child));
                } else {
                  objectsToCheck.push(pickups[k].mesh);
                }
              }
            }
            const intersects = scannerRaycaster.intersectObjects(objectsToCheck, false);

            // Check if tree is blocked
            if (intersects.length > 0) {
              const firstHit = intersects[0];
              const hitDistance = firstHit.distance;
              const treeDistance = scannerCameraPos.distanceTo(scannerResourcePos);
              if (hitDistance < treeDistance - 0.5) {
                isBlocked = true;
              }
            }
            // Cache blocked state
            if (!pickups['tree_' + treeId].scannerBlocked) pickups['tree_' + treeId].scannerBlocked = false;
            pickups['tree_' + treeId].scannerBlocked = isBlocked;
          } else {
            // Use cached blocked state
            isBlocked = pickups['tree_' + treeId].scannerBlocked || false;
          }

          const time = performance.now() * 0.003;
          const pulse = (Math.sin(time) + 1) * 0.5;
          const glowColor = isBlocked ? scannerGlowColorRed : scannerGlowColorGreen;
          // Reduced glow intensity for more subtle effect
          const glowIntensity = isBlocked ? 0.1 + pulse * 0.2 : 0.1 + pulse * 0.15;

          if (pickups['tree_' + treeId].mesh.children) {
            pickups['tree_' + treeId].mesh.children.forEach(child => {
              if (child.material) {
                if (!child.material.emissive) child.material.emissive = new THREE.Color();
                child.material.emissive.copy(glowColor);
                child.material.emissiveIntensity = glowIntensity;
                // Add red tint if blocked (reuse cached colors)
                if (isBlocked) {
                  child.material.color.lerp(scannerColorRed, 0.3);
                } else {
                  child.material.color.lerp(scannerColorWhite, 0.0);
                }
              }
            });
          }
        } else {
          // Reset when out of range
          if (pickups['tree_' + treeId].mesh.children) {
            pickups['tree_' + treeId].mesh.children.forEach(child => {
              if (child.material && child.material.emissiveIntensity > 0.1) {
                child.material.emissiveIntensity = 0.1;
                child.material.color.lerp(scannerColorWhite, 0.0);
              }
            });
          }
        }
      } else if (pickups['tree_' + treeId] && pickups['tree_' + treeId].mesh) {
        // Reset when scanner not active
        if (pickups['tree_' + treeId].mesh.children) {
          pickups['tree_' + treeId].mesh.children.forEach(child => {
            if (child.material && child.material.emissiveIntensity > 0.1) {
              child.material.emissiveIntensity = 0.1;
              child.material.color.lerp(new THREE.Color(0xffffff), 0.0);
            }
          });
        }
      }
    }
  }

  // Remove old planted trees
  for (const k in pickups) {
    if (k.startsWith('tree_') && !plantedTreeIds.has(k.replace('tree_', ''))) {
      if (pickups[k].mesh) {
        recycleTreeMesh(pickups[k].mesh);
      }
      delete pickups[k];
    }
  }

  // bullets - optimized: reuse meshes with object pooling
  const bulletIds = new Set();
  if (state.bullets) {
    for (const b of state.bullets) {
      bulletIds.add(b.id);
      if (!bullets[b.id]) {
        // get from pool or create new
        let m;
        if (bulletPool.length > 0) {
          m = bulletPool.pop();
          m.visible = true;
        } else {
          m = new THREE.Mesh(bulletGeo, bulletMat);
          scene.add(m);
        }
        bullets[b.id] = { mesh: m };
      }
      // update position of existing bullet with trail effect
      bullets[b.id].mesh.position.set(b.x, b.y, b.z);
      // Add subtle rotation for visual appeal
      bullets[b.id].mesh.rotation.x += 0.1;
      bullets[b.id].mesh.rotation.y += 0.1;
    }
  }
  // remove bullets that no longer exist and recycle to pool
  for (const id in bullets) {
    if (!bulletIds.has(id)) {
      if (bullets[id].mesh) {
        bullets[id].mesh.visible = false;
        bulletPool.push(bullets[id].mesh);
      }
      delete bullets[id];
    }
  }

  // update grass wind time uniform
  bladeMat.uniforms.time.value = performance.now() * 0.001;

  // CRITICAL OPTIMIZATION: only update grass visibility when camera moves significantly
  // and use batch updates to minimize matrix operations
  // Also throttle updates to every N frames to prevent stuttering
  grassUpdateCounter++;
  const cameraPos = camera.position;
  const cameraMoved = lastCameraPos.distanceToSquared(cameraPos) > CAMERA_MOVE_THRESHOLD_SQ;

  if (cameraMoved && (grassUpdateCounter % GRASS_UPDATE_INTERVAL === 0)) {
    // OPTIMIZED: only update instances that changed visibility state
    // Use a more efficient approach - batch updates and limit per frame
    const needsUpdate = new Array(INST_COUNT).fill(false);
    let visibleCount = 0;
    const MAX_UPDATES_PER_FRAME = 2000; // further reduced for optimization
    let updateCount = 0;

    for (let i = 0; i < grassCount && updateCount < MAX_UPDATES_PER_FRAME; i++) {
      const pos = grassPositions[i];
      const dx = pos.x - cameraPos.x;
      const dz = pos.z - cameraPos.z;
      const distSq = dx * dx + dz * dz;

      const meshIdx = i % INST_COUNT;
      const bladeIdx = Math.floor(i / INST_COUNT);

      // check if visibility state changed
      const shouldBeVisible = distSq <= GRASS_RENDER_RADIUS_SQ;

      // Check if grass is underwater - kill grass in water
      let isUnderwater = false;
      if (state.waterGrid && waterSurfaceHeights.size > 0) {
        const gx = Math.floor((pos.x + 200) / WATER_GRID_CELL_SIZE);
        const gz = Math.floor((pos.z + 200) / WATER_GRID_CELL_SIZE);
        const waterKey = `${gx},${gz}`;
        if (waterSurfaceHeights.has(waterKey)) {
          const waterSurfaceY = waterSurfaceHeights.get(waterKey);
          // Grass blade is at pos.y, if water surface is above it, grass is underwater
          if (waterSurfaceY > pos.y) {
            isUnderwater = true;
          }
        }
      }

      // Check if grass is near a solar panel - kill grass near panels (2m radius)
      let isNearSolarPanel = false;
      if (state.solarPanels) {
        const SOLAR_PANEL_GRASS_RADIUS = 2.0; // 2 meter radius
        const SOLAR_PANEL_GRASS_RADIUS_SQ = SOLAR_PANEL_GRASS_RADIUS * SOLAR_PANEL_GRASS_RADIUS;
        for (const playerId in state.solarPanels) {
          const panels = state.solarPanels[playerId];
          for (const panel of panels) {
            const panelDx = pos.x - panel.x;
            const panelDz = pos.z - panel.z;
            const panelDistSq = panelDx * panelDx + panelDz * panelDz;
            if (panelDistSq < SOLAR_PANEL_GRASS_RADIUS_SQ) {
              isNearSolarPanel = true;
              break;
            }
          }
          if (isNearSolarPanel) break;
        }
      }

      // Only update if visibility changed - use a simple distance check
      // We'll update all visible ones, but limit the total updates per frame
      if (shouldBeVisible && !isUnderwater && !isNearSolarPanel && updateCount < MAX_UPDATES_PER_FRAME) {
        updateCount++;
        // within range and not underwater - restore original scale with aligned rotation
        const from = new THREE.Vector3(0, 1, 0); // default blade up
        tempQuat.setFromUnitVectors(from, pos.normal);
        // Apply random rotation around the new up (normal)
        const randomQuat = new THREE.Quaternion().setFromAxisAngle(pos.normal, pos.rot);
        tempQuat.multiply(randomQuat);

        // FIXED: Position center at surface + offset along normal
        tempVec.set(pos.x, pos.y, pos.z);
        const offsetAmount = BASE_HALF_BLADE_HEIGHT * pos.s;
        tempVec.addScaledVector(pos.normal, offsetAmount);
        tempMatrix.compose(tempVec, tempQuat, new THREE.Vector3(pos.s, pos.s, pos.s));
        grassInst[meshIdx].setMatrixAt(bladeIdx, tempMatrix);
        needsUpdate[meshIdx] = true;
        visibleCount++;
      } else if ((!shouldBeVisible || isUnderwater || isNearSolarPanel) && updateCount < MAX_UPDATES_PER_FRAME) {
        // beyond range, underwater, or near solar panel - scale to 0 to hide (rotation irrelevant)
        updateCount++;
        tempQuat.setFromEuler(new THREE.Euler(0, pos.rot, 0)); // simple, since scaled out
        tempVec.set(pos.x, pos.y, pos.z);
        tempMatrix.compose(tempVec, tempQuat, new THREE.Vector3(0, 0, 0));
        grassInst[meshIdx].setMatrixAt(bladeIdx, tempMatrix);
        needsUpdate[meshIdx] = true;
      }
    }

    // only mark meshes that were updated
    for (let k = 0; k < INST_COUNT; k++) {
      if (needsUpdate[k]) {
        grassInst[k].instanceMatrix.needsUpdate = true;
      }
    }

    lastCameraPos.copy(cameraPos);
  }

  // handle window resize efficiently (only when needed)
  if (needsResize) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    needsResize = false;
  }

  // FPS tracking and display - average frame time over interval
  frameCount++;
  const now = performance.now();
  const deltaTime = now - lastFrameTime;
  lastFrameTime = now;
  frameTimeSum += deltaTime;

  if (now - lastFpsUpdate >= FPS_UPDATE_INTERVAL) {
    const avgFrameTime = frameTimeSum / frameCount;
    const fps = Math.round(1000 / (avgFrameTime || 16.67)); // avoid division by zero
    if (fpsEl) fpsEl.textContent = `FPS: ${fps}`;
    lastFpsUpdate = now;
    frameCount = 0;
    frameTimeSum = 0;
  }

  // Render flowing water - optimized with instancing and terrain following
  const WATER_MAX_LEVEL = 1000;

  // Check if water grid changed
  if (state.waterGrid) {
    const waterKeys = Object.keys(state.waterGrid);
    const waterCount = waterKeys.length;

    // Debug: log water grid status occasionally (disabled for performance)
    // if (waterCount > 0 && Math.random() < 0.01) {
    //   console.log('[WATER] Water grid has', waterCount, 'cells, isRaining:', state.isRaining);
    // }

    const currentHash = JSON.stringify(waterKeys.sort());
    const waterGridChanged = currentHash !== lastWaterGridHash || !waterMesh;

    if (waterGridChanged && waterCount > 0) {
      lastWaterGridHash = currentHash;

      const waterCells = [];

      // Collect all water cells with their heights
      let totalWater = 0;
      for (const key in state.waterGrid) {
        const waterLevel = state.waterGrid[key];
        totalWater += waterLevel;
        if (waterLevel > 10) { // threshold: 1% of max (10/1000)
          const [gx, gz] = key.split(',').map(Number);
          const x = (gx * WATER_GRID_CELL_SIZE) - 200;
          const z = (gz * WATER_GRID_CELL_SIZE) - 200;
          const height = Math.max(0.2, (waterLevel / WATER_MAX_LEVEL) * 2.0);

          waterCells.push({ x, z, height, gx, gz, level: waterLevel });
        }
      }

      // console.log('[WATER] Found', waterCells.length, 'visible water cells (total water:', totalWater.toFixed(1), ')');

      if (waterCells.length > 0) {
        // Clean up old mesh
        if (waterMesh) {
          scene.remove(waterMesh);
          waterMesh.geometry.dispose();
          waterMesh = null;
        }

        // Calculate bounds of water area
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let totalSurfaceY = 0;
        waterSurfaceHeights.clear();

        for (const cell of waterCells) {
          const terrainY = getHeightAt(cell.x, cell.z);
          const actualWaterDepth = (cell.level / WATER_MAX_LEVEL) * 2.0;
          const waterSurfaceY = terrainY + actualWaterDepth;

          minX = Math.min(minX, cell.x - WATER_GRID_CELL_SIZE);
          maxX = Math.max(maxX, cell.x + WATER_GRID_CELL_SIZE);
          minZ = Math.min(minZ, cell.z - WATER_GRID_CELL_SIZE);
          maxZ = Math.max(maxZ, cell.z + WATER_GRID_CELL_SIZE);

          totalSurfaceY += waterSurfaceY;

          // Store for underwater detection
          const waterKey = `${cell.gx},${cell.gz}`;
          waterSurfaceHeights.set(waterKey, waterSurfaceY);
        }

        // Create single large water plane covering all water areas
        const waterWidth = maxX - minX;
        const waterDepth = maxZ - minZ;
        const avgSurfaceY = totalSurfaceY / waterCells.length;

        // Optimized subdivision - balance between smooth waves and performance
        const segments = Math.min(64, Math.max(16, Math.floor(Math.max(waterWidth, waterDepth) / 3)));
        const waterGeo = new THREE.PlaneGeometry(waterWidth, waterDepth, segments, segments);
        waterGeo.rotateX(-Math.PI / 2); // lay flat

        // Create mesh
        waterMesh = new THREE.Mesh(waterGeo, waterMat);
        waterMesh.position.set((minX + maxX) / 2, avgSurfaceY, (minZ + maxZ) / 2);
        waterMesh.renderOrder = 1;
        scene.add(waterMesh);

        // console.log('[WATER] Created single unified water surface covering', waterCells.length, 'cells');
      } else {
        // Remove water mesh if no water
        if (waterMesh) {
          scene.remove(waterMesh);
          waterMesh.geometry.dispose();
          waterMesh = null;
        }
        // console.warn('[WATER] No water cells above threshold (10) found! Total water cells:', Object.keys(state.waterGrid).length);
      }
    }

    // Always update shader time for wave animation
    if (waterMat) {
      waterMat.uniforms.time.value = performance.now() * 0.001;
      waterMat.uniforms.cameraPosition.value.copy(camera.position);
    }
  } else {
    // No water grid in state
    if (waterMesh) {
      scene.remove(waterMesh);
      waterMesh.geometry.dispose();
      waterMesh = null;
      lastWaterGridHash = '';
      // console.log('[WATER] Removed water mesh - no water grid in state');
    }
  }

  // Render rain particles
  if (state.isRaining) {
    const time = performance.now() * 0.001;
    // Create rain particles (simple vertical lines) - reduced for performance
    if (rainParticles.length < 100) {
      for (let i = rainParticles.length; i < 100; i++) {
        const particle = new THREE.Mesh(
          new THREE.BoxGeometry(0.02, 0.5, 0.02),
          new THREE.MeshStandardMaterial({ color: 0x88aaff, transparent: true, opacity: 0.6 })
        );
        particle.position.set(
          (Math.random() - 0.5) * 200,
          30 + Math.random() * 20,
          (Math.random() - 0.5) * 200
        );
        scene.add(particle);
        rainParticles.push(particle);
      }
    }

    // Animate rain
    for (const particle of rainParticles) {
      particle.position.y -= 20 * dt;
      if (particle.position.y < -10) {
        particle.position.y = 30 + Math.random() * 20;
        particle.position.x = (Math.random() - 0.5) * 200;
        particle.position.z = (Math.random() - 0.5) * 200;
      }
    }
  } else {
    // Remove rain particles when not raining
    for (const particle of rainParticles) {
      scene.remove(particle);
    }
    rainParticles = [];
  }

  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

render();