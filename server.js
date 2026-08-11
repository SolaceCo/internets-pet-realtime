import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// In-Memory Game State
let gerald = {
  health: 100,
  hunger: 20,
  happiness: 80,
  status: 'ALIVE',
  generation: 1
};

// Track action cooldowns by IP (1 action per 1 hour)
const cooldowns = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// Real-time 24/7 Game Loop (Ticks every 5 seconds)
setInterval(() => {
  if (gerald.status === 'ALIVE') {
    gerald.hunger = Math.min(100, gerald.hunger + 1);
    gerald.happiness = Math.max(0, gerald.happiness - 1);

    if (gerald.hunger >= 100 || gerald.happiness <= 0) {
      gerald.health = Math.max(0, gerald.health - 5);
    }

    if (gerald.health <= 0) {
      gerald.status = 'DEAD';
    }

    // Broadcast updated state to all connected users
    io.emit('stateUpdate', gerald);
  }
}, 5000);

// WebSocket Connections
io.on('connection', (socket) => {
  // Send current state instantly on connect
  socket.emit('stateUpdate', gerald);

  // Handle user action (feed / play)
  socket.on('action', ({ type }) => {
    if (gerald.status === 'DEAD') {
      return socket.emit('errorMsg', 'Gerald is dead. Wait for resurrection.');
    }

    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const now = Date.now();
    const lastAction = cooldowns.get(clientIp);

    if (lastAction && now - lastAction < 3600000) { // 1 hour = 3,600,000 ms
      const remainingMins = Math.ceil((3600000 - (now - lastAction)) / 60000);
      return socket.emit('errorMsg', `You are on cooldown! Try again in ${remainingMins} minutes.`);
    }

    if (type === 'feed') {
      gerald.hunger = Math.max(0, gerald.hunger - 20);
      gerald.health = Math.min(100, gerald.health + 5);
    } else if (type === 'play') {
      gerald.happiness = Math.min(100, gerald.happiness + 25);
    }

    cooldowns.set(clientIp, now);

    // Broadcast update to EVERYONE immediately
    io.emit('stateUpdate', gerald);
    io.emit('log', `A stranger ${type === 'feed' ? 'fed' : 'played with'} Gerald!`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
