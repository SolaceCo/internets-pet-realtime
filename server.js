import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const STATE_FILE = path.join(__dirname, 'gerald-state.json');

const DEFAULT_STATE = {
  health: 100,
  hunger: 20,
  happiness: 80,
  status: 'ALIVE',
  generation: 1,
  diedAt: null,
  resurrectsAt: null,
  stats: { feeds: 0, plays: 0, deaths: 0 }
};

let gerald = JSON.parse(JSON.stringify(DEFAULT_STATE));
let tickCount = 0;

// ─── Persistence ───
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    
    // If Gerald was dead when we shut down, check if he should resurrect
    if (saved.status === 'DEAD' && saved.diedAt) {
      const DEAD_FOR = Date.now() - saved.diedAt;
      const RESURRECTION_TIME = 30 * 60 * 1000; // 30 min
      
      if (DEAD_FOR >= RESURRECTION_TIME) {
        // Resurrect immediately
        gerald = JSON.parse(JSON.stringify(DEFAULT_STATE));
        gerald.generation = (saved.generation || 1) + 1;
        gerald.stats = { ...(saved.stats || {}), deaths: (saved.stats?.deaths || 0) + 1 };
        console.log(`Gerald auto-resurrected! Gen ${gerald.generation}`);
      } else {
        // Still dead, schedule resurrection
        gerald = { ...DEFAULT_STATE, ...saved, resurrectsAt: saved.diedAt + RESURRECTION_TIME };
        setTimeout(resurrectGerald, RESURRECTION_TIME - DEAD_FOR);
      }
    } else {
      gerald = { ...DEFAULT_STATE, ...saved };
    }
  } catch {
    gerald = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(gerald, null, 2));
  } catch (err) {
    console.error('Save failed:', err);
  }
}

function resurrectGerald() {
  if (gerald.status !== 'DEAD') return;
  
  const prevGen = gerald.generation;
  gerald = JSON.parse(JSON.stringify(DEFAULT_STATE));
  gerald.generation = prevGen + 1;
  gerald.stats = { ...gerald.stats, deaths: (gerald.stats?.deaths || 0) + 1 };
  
  io.emit('stateUpdate', gerald);
  io.emit('log', `Gerald has been resurrected! Welcome to Generation ${gerald.generation}!`);
  saveState();
}

// ─── Cooldowns (with cleanup) ───
const cooldowns = new Map();

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function isOnCooldown(ip) {
  const last = cooldowns.get(ip);
  if (!last) return false;
  if (Date.now() - last > 3600000) {
    cooldowns.delete(ip);
    return false;
  }
  return true;
}

// Clean stale cooldowns every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, time] of cooldowns) {
    if (now - time > 3600000) cooldowns.delete(ip);
  }
}, 600000);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Loop ───
setInterval(() => {
  if (gerald.status === 'ALIVE') {
    gerald.hunger = Math.min(100, gerald.hunger + 1);
    gerald.happiness = Math.max(0, gerald.happiness - 1);

    if (gerald.hunger >= 100 || gerald.happiness <= 0) {
      gerald.health = Math.max(0, gerald.health - 5);
    }

    if (gerald.health <= 0 && gerald.status !== 'DEAD') {
      gerald.status = 'DEAD';
      gerald.diedAt = Date.now();
      gerald.resurrectsAt = gerald.diedAt + (30 * 60 * 1000);
      gerald.stats = { ...gerald.stats, deaths: (gerald.stats?.deaths || 0) + 1 };
      
      io.emit('log', `Gerald has died! Generation ${gerald.generation} has fallen...`);
      io.emit('stateUpdate', gerald);
      saveState();
      
      // Auto-resurrect in 30 minutes
      setTimeout(resurrectGerald, 30 * 60 * 1000);
      return;
    }

    io.emit('stateUpdate', gerald);
    
    // Save to disk every 30 seconds (not every tick)
    tickCount++;
    if (tickCount % 6 === 0) saveState();
  }
}, 5000);

// ─── WebSocket ───
io.on('connection', (socket) => {
  socket.emit('stateUpdate', gerald);

  socket.on('action', ({ type }) => {
    if (gerald.status === 'DEAD') {
      return socket.emit('errorMsg', 'Gerald is dead. A new egg will hatch soon...');
    }

    if (type !== 'feed' && type !== 'play') {
      return socket.emit('errorMsg', 'Invalid action.');
    }

    const clientIp = getClientIp(socket);
    if (isOnCooldown(clientIp)) {
      const last = cooldowns.get(clientIp);
      const mins = Math.ceil((3600000 - (Date.now() - last)) / 60000);
      return socket.emit('errorMsg', `Cooldown: ${mins} minutes remaining.`);
    }

    if (type === 'feed') {
      gerald.hunger = Math.max(0, gerald.hunger - 20);
      gerald.health = Math.min(100, gerald.health + 5);
      gerald.stats = { ...gerald.stats, feeds: (gerald.stats?.feeds || 0) + 1 };
    } else if (type === 'play') {
      gerald.happiness = Math.min(100, gerald.happiness + 25);
      gerald.stats = { ...gerald.stats, plays: (gerald.stats?.plays || 0) + 1 };
    }

    cooldowns.set(clientIp, Date.now());
    saveState();

    io.emit('stateUpdate', gerald);
    io.emit('log', `A stranger ${type === 'feed' ? 'fed' : 'played with'} Gerald!`);
  });
});

// ─── Graceful Shutdown ───
async function shutdown() {
  console.log('Saving Gerald...');
  await saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start ───
const PORT = process.env.PORT || 3000;
await loadState();
httpServer.listen(PORT, () => {
  console.log(`Gerald is alive on port ${PORT} (Gen ${gerald.generation})`);
});
