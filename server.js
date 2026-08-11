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

const DEFAULT_STATE = () => ({
  health: 100,
  fullness: 100,
  happiness: 100,
  status: 'ALIVE',
  generation: 1,
  bornAt: Date.now(),
  diedAt: null,
  resurrectsAt: null,
  stats: { feeds: 0, poisons: 0, plays: 0, deaths: 0, resurrections: 0 },
  lastAction: null,
  countryStats: {},
  deathHistory: [],
  userCount: 0
});

let gerald = DEFAULT_STATE();
let tickCount = 0;

// ─── Persistence ───
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    
    if (saved.status === 'DEAD' && saved.diedAt) {
      const DEAD_FOR = Date.now() - saved.diedAt;
      const RESURRECTION_TIME = 15 * 60 * 1000;
      
      if (DEAD_FOR >= RESURRECTION_TIME) {
        resurrectGerald(saved.generation, saved.stats, saved.countryStats, saved.deathHistory);
      } else {
        gerald = { ...DEFAULT_STATE(), ...saved, status: 'DEAD', resurrectsAt: saved.diedAt + RESURRECTION_TIME };
        setTimeout(() => resurrectGerald(saved.generation, saved.stats, saved.countryStats, saved.deathHistory), RESURRECTION_TIME - DEAD_FOR);
      }
    } else {
      gerald = { ...DEFAULT_STATE(), ...saved };
    }
  } catch {
    gerald = DEFAULT_STATE();
  }
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(gerald, null, 2));
  } catch (err) {
    console.error('💾 Save failed:', err);
  }
}

function resurrectGerald(prevGen, prevStats, prevCountries, prevDeaths) {
  if (gerald.status !== 'DEAD') return;
  
  gerald = DEFAULT_STATE();
  gerald.generation = (prevGen || 1) + 1;
  gerald.stats = { 
    ...(prevStats || {}), 
    deaths: (prevStats?.deaths || 0),
    resurrections: (prevStats?.resurrections || 0) + 1
  };
  gerald.countryStats = prevCountries || {};
  gerald.deathHistory = prevDeaths || [];
  
  io.emit('stateUpdate', gerald);
  io.emit('log', `🥚 A new egg hatched! Welcome to Generation ${gerald.generation}!`);
  saveState();
}

// ─── Cooldowns ───
const cooldowns = new Map();
const COOLDOWN_MS = 30 * 60 * 1000;

// ─── Abuse throttle store ───
const actionThrottles = new Map();

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function getCooldownRemaining(ip) {
  const last = cooldowns.get(ip);
  if (!last) return 0;
  const remaining = COOLDOWN_MS - (Date.now() - last);
  if (remaining <= 0) {
    cooldowns.delete(ip);
    return 0;
  }
  return remaining;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, time] of cooldowns) {
    if (now - time > COOLDOWN_MS) cooldowns.delete(ip);
  }
}, 300000);

app.use(express.static(path.join(__dirname, 'public')));

// ─── User Count ───
function broadcastUserCount() {
  const count = io.engine.clientsCount;
  gerald.userCount = count;
  io.emit('userCount', count);
}

// ─── Game Loop ───
setInterval(() => {
  if (gerald.status === 'ALIVE') {
    gerald.fullness = Math.max(0, gerald.fullness - 1.2);
    gerald.happiness = Math.max(0, gerald.happiness - 0.7);

    if (gerald.fullness <= 0 || gerald.happiness <= 0) {
      gerald.health = Math.max(0, gerald.health - 2.5);
    }

    if (gerald.health <= 0 && gerald.status !== 'DEAD') {
      gerald.status = 'DEAD';
      gerald.diedAt = Date.now();
      gerald.resurrectsAt = gerald.diedAt + (15 * 60 * 1000);
      gerald.stats = { ...gerald.stats, deaths: (gerald.stats?.deaths || 0) + 1 };
      
      const snapshot = {
        generation: gerald.generation,
        diedAt: gerald.diedAt,
        bornAt: gerald.bornAt,
        finalHealth: gerald.health,
        finalFullness: gerald.fullness,
        finalHappiness: gerald.happiness,
        genStats: { ...gerald.stats },
        countryStats: { ...gerald.countryStats }
      };
      gerald.deathHistory = [snapshot, ...(gerald.deathHistory || [])].slice(0, 20);
      
      const livedMins = Math.floor((gerald.diedAt - gerald.bornAt) / 60000);
      io.emit('stateUpdate', gerald);
      io.emit('deathSnapshot', snapshot);
      io.emit('log', `💀 Gerald has died! Generation ${gerald.generation} lasted ${livedMins} minutes.`);
      saveState();
      
      setTimeout(() => resurrectGerald(gerald.generation, gerald.stats, gerald.countryStats, gerald.deathHistory), 15 * 60 * 1000);
      return;
    }

    io.emit('stateUpdate', gerald);
    
    tickCount++;
    if (tickCount % 6 === 0) saveState();
  }
}, 5000);

// ─── WebSocket ───
io.on('connection', (socket) => {
  broadcastUserCount();
  socket.emit('stateUpdate', gerald);
  socket.emit('userCount', gerald.userCount);

  socket.on('disconnect', () => broadcastUserCount());

  socket.on('action', ({ type, country }) => {
    if (!['feed', 'poison', 'play'].includes(type)) {
      return socket.emit('errorMsg', 'Invalid action.');
    }

    if (gerald.status === 'DEAD') {
      return socket.emit('errorMsg', 'Gerald is dead. A new egg will hatch soon...');
    }

    const clientIp = getClientIp(socket);

    // ─── ABUSE THROTTLE: max 10 actions per minute per IP ───
    const now = Date.now();
    const windowStart = now - 60000;
    const throttleKey = `${clientIp}:${Math.floor(now / 60000)}`;
    
    // Clean old throttle entries
    for (const [k, v] of actionThrottles) {
      if (v.time < windowStart) actionThrottles.delete(k);
    }
    
    const throttleData = actionThrottles.get(throttleKey);
    const actionCount = (throttleData?.count || 0) + 1;
    if (actionCount > 10) {
      return socket.emit('errorMsg', 'Slow down, chaos agent.');
    }
    actionThrottles.set(throttleKey, { count: actionCount, time: now });
    // ─── END THROTTLE ───

    const remaining = getCooldownRemaining(clientIp);
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      return socket.emit('errorMsg', `Wait ${mins} minute${mins !== 1 ? 's' : ''}.`);
    }

    // ─── XSS FIX: Validate country code ───
    let cc = (country || 'Unknown').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) cc = 'Unknown';
    // ─── END XSS FIX ───
    
    if (!gerald.countryStats[cc]) gerald.countryStats[cc] = { feeds: 0, poisons: 0, plays: 0, score: 0 };
    gerald.countryStats[cc][type === 'feed' ? 'feeds' : type === 'poison' ? 'poisons' : 'plays']++;
    gerald.countryStats[cc].score = (gerald.countryStats[cc].feeds + gerald.countryStats[cc].plays) - gerald.countryStats[cc].poisons;

    let logMsg = '';
    let effectType = '';

    switch (type) {
      case 'feed':
        gerald.fullness = Math.min(100, gerald.fullness + 25);
        gerald.health = Math.min(100, gerald.health + 8);
        gerald.happiness = Math.min(100, gerald.happiness + 5);
        gerald.stats = { ...gerald.stats, feeds: (gerald.stats?.feeds || 0) + 1 };
        logMsg = gerald.health < 30 
          ? `A hero from ${cc} saved a dying Gerald! ❤️🐟` 
          : `Someone from ${cc} fed Gerald a tasty fish! 🐟`;
        effectType = 'feed';
        break;
        
      case 'poison':
        gerald.health = Math.max(0, gerald.health - 22);
        gerald.happiness = Math.max(0, gerald.happiness - 18);
        gerald.fullness = Math.max(0, gerald.fullness - 8);
        gerald.stats = { ...gerald.stats, poisons: (gerald.stats?.poisons || 0) + 1 };
        logMsg = gerald.health < 25 
          ? `Someone from ${cc} nearly killed Gerald! ☠️💀` 
          : `Someone from ${cc} tried to poison Gerald! ☠️`;
        effectType = 'poison';
        break;
        
      case 'play':
        gerald.happiness = Math.min(100, gerald.happiness + 28);
        gerald.fullness = Math.max(0, gerald.fullness - 4);
        gerald.stats = { ...gerald.stats, plays: (gerald.stats?.plays || 0) + 1 };
        logMsg = `Someone from ${cc} played with Gerald! 🧶`;
        effectType = 'play';
        break;
    }

    gerald.lastAction = { type, country: cc, time: Date.now() };
    cooldowns.set(clientIp, Date.now());
    saveState();

    io.emit('stateUpdate', gerald);
    io.emit('log', logMsg);
    io.emit('actionEffect', { type: effectType });
    io.emit('lastAction', gerald.lastAction);
  });
});

// ─── Shutdown ───
async function shutdown() {
  await saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3000;
await loadState();
httpServer.listen(PORT, () => {
  console.log(`🐱 Gerald is live on port ${PORT} (Gen ${gerald.generation})`);
});
