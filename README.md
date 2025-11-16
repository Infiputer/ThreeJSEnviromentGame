# ThreeJS Ecology — A Sustainable World (Competitive)

## Overview

This project is a small competitive multiplayer demo built for a hackathon with the theme "A Sustainable World". It uses Three.js for browser-based 3D rendering and a Node.js server with Express and Socket.io for real-time multiplayer functionality. Players navigate a 3D environment, collecting "trees" as pickups to earn sustainability points, while also engaging in combat by shooting other players to steal or gain scores.

The game serves as a minimal prototype to demonstrate competitive gameplay mechanics tied to sustainability elements. It is not production-ready and requires enhancements in areas like physics, visuals, security, and authoritative server-side movement.

## Technologies Used

- **Client-side**: Three.js for 3D graphics and rendering in the browser.
- **Server-side**: Node.js, Express.js for the web server, and Socket.io for real-time communication and multiplayer synchronization.
- **Other**: JavaScript for both client and server logic.

## Setup Instructions

1. Clone the repository:
   ```
   git clone https://github.com/Infiputer/ThreeJSEnviromentGame.git
   ```
2. Navigate to the project directory:
   ```
   cd ThreeJSEnviromentGame
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. Start the server (it binds to 0.0.0.0:1155):
   ```
   npm start
   ```
5. Open a web browser and navigate to `http://localhost:1155/` (or replace `localhost` with your machine's IP address to allow other players to connect over the network).

Multiple players can join by accessing the same URL from different browsers or devices on the same network.

## Gameplay Mechanics

- **Objective**: Compete against other players in a shared 3D environment to achieve the highest score by collecting sustainability points and eliminating opponents.
- **Collecting Pickups**: "Trees" appear as collectible items in the environment. When a player collects a tree, they gain sustainability points, which contribute to their overall score.
- **Combat**: Players can shoot at each other using projectiles. Successfully hitting another player allows you to gain points, possibly by stealing from their score or earning a bonus.
- **Winning**: The game is competitive, so the player with the highest score at the end (or after a set time/condition) wins. (Note: The prototype may not have a defined end condition; it's demo-focused.)
- **Multiplayer**: All players share the same world in real-time. Actions like movement, collecting, and shooting are synchronized across clients via the server.

## Controls

- **Pointer Lock**: Click on the canvas to lock the mouse pointer for first-person controls.
- **Movement**: Use WASD keys to move the player character (forward, left, backward, right).
- **Shooting**: Left-click the mouse to fire a projectile at other players.

## How Everything Works (Game Logic)

### Architecture
- **Client-Server Model**: The server (Node.js + Express + Socket.io) handles game state, player connections, and synchronization. Clients connect via WebSockets for low-latency updates.
- **3D Rendering**: Each client uses Three.js to render the 3D scene, including the environment, player models, trees (pickups), and projectiles.
- **State Synchronization**: When a player moves, collects a tree, or shoots, the action is sent to the server via Socket.io. The server validates and broadcasts updates to all connected clients to keep the game world consistent.

### Key Components and Logic
- **Environment**: A 3D world likely generated with Three.js primitives (e.g., planes for ground, boxes or models for obstacles). Trees are spawned at random or fixed positions as Mesh objects with collision detection.
- **Player Entity**: Each player is represented as a 3D object (e.g., a simple avatar). Movement is handled via keyboard input, updating position and rotation. The camera is typically first-person, attached to the player.
- **Collection Mechanic**:
  - Trees are pickups with positions in the 3D space.
  - Collision detection (using Three.js Raycaster or bounding boxes) checks if a player intersects with a tree.
  - Upon collection, the client's score updates, the tree is removed or respawned, and the server notifies all players.
- **Shooting Mechanic**:
  - Left-click spawns a projectile (e.g., a sphere or arrow) from the player's position in the direction they're facing.
  - Projectiles move forward each frame, with physics simulation (gravity optional in prototype).
  - Raycasting or intersection checks detect hits on other players.
  - On hit, the target player's health/score decreases, and the shooter gains points. Server authorizes to prevent cheating.
- **Scoring System**: Points from collections and kills. Displayed on-screen, possibly with a leaderboard updated in real-time.
- **Update Loop**: Three.js uses a requestAnimationFrame loop for rendering and updating local state. Socket.io events handle remote updates (e.g., other players' positions).

### Potential Code Structure (Inferred)
- `server.js` or `app.js`: Sets up Express server, Socket.io, handles player connections, game loop, and broadcasts.
- `index.html`: Entry point for the client, loads Three.js and client scripts.
- `client.js` or `main.js`: Initializes Three.js scene, camera, renderer; handles input, updates, and Socket.io communication.
- Other files: Possibly models, textures, or utility scripts for specific features.

## Future Improvements

- Enhance physics with a library like Cannon.js or Ammo.js for realistic collisions and movement.
- Improve visuals: Add better models, lighting, textures, and particle effects.
- Add security: Implement anti-cheat measures, input validation on server.
- Authoritative server: Move all critical logic (e.g., movement validation) to the server to prevent hacks.
- Expand gameplay: Add more pickup types, power-ups, maps, or win conditions.
- UI/UX: Add menus, scoreboards, chat, and mobile support.

## License

This project is open-source. Do whatever.
