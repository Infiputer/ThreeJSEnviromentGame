# ThreeJS Ecology — A Sustainable World (Competitive)

This is a small competitive multiplayer demo built for a hackathon theme "A Sustainable World".

Overview
- Browser-based 3D using Three.js
- Node + Express + Socket.io server for real-time multiplayer
- Players collect "trees" (pickups) to gain sustainability points and can shoot other players to gain score

Run locally

1. Install dependencies

```bash
npm install
```

2. Start server (binds to 0.0.0.0:1155)

```bash
npm start
```

3. Open a browser to `http://localhost:1155/` (or use your machine IP to let others connect).

Controls
- Click on the canvas to lock pointer
- WASD to move
- Left-click to shoot

Notes
- This is a minimal prototype to demonstrate competitive gameplay with sustainability pickups. Improve physics, visuals, security, and authoritative movement for production use.
