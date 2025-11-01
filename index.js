/**
 * index.js — Fixed & enhanced
 * - Delay require/load of mineflayer-pathfinder until after bot.spawn (prevents mcData null)
 * - Self-ping for Render, /health & /status endpoints
 * - Natural movement loop, follow command, respawn, reconnect/backoff, error counter
 */

'use strict';

// ----- Hard defaults (you gave) -----
const DEFAULT_HOST = 'ThunderSmp-DPsF.aternos.me';
const DEFAULT_PORT = 62687;
const DEFAULT_USERNAME = 'King_of_bot';
const DEFAULT_VERSION = '1.20.4';

// Ensure MC_VERSION exists early (helps some modules that read env)
process.env.MC_VERSION = process.env.MC_VERSION || DEFAULT_VERSION;

// ----- Requires -----
const mineflayer = require('mineflayer');
const express = require('express');
const mcDataLib = require('minecraft-data'); // used after spawn

// NOTE: do NOT require('mineflayer-pathfinder') at top-level — require it dynamically after spawn
// to avoid the mcData null issue that happens when pathfinder expects mcData early.

// ----- Config (override via env variables) -----
const CONFIG = {
  MC_HOST: process.env.MC_HOST || DEFAULT_HOST,
  MC_PORT: parseInt(process.env.MC_PORT || String(DEFAULT_PORT), 10),
  MC_USERNAME: process.env.MC_USERNAME || DEFAULT_USERNAME,
  MC_PASSWORD: process.env.MC_PASSWORD || undefined,
  MC_VERSION: process.env.MC_VERSION || DEFAULT_VERSION,

  MIN_ACTION_DELAY: parseInt(process.env.MIN_ACTION_DELAY || '3000', 10),
  MAX_ACTION_DELAY: parseInt(process.env.MAX_ACTION_DELAY || '12000', 10),
  RECONNECT_DELAY: parseInt(process.env.RECONNECT_DELAY || '8000', 10),

  CHAT_PROBABILITY: parseFloat(process.env.CHAT_PROBABILITY || '0.05'),
  GREETINGS: (process.env.GREETINGS && process.env.GREETINGS.split('|')) || ['hi', 'hello', 'anyone here?', 'keeping server alive'],

  FOLLOW_START_DISTANCE: parseFloat(process.env.FOLLOW_START_DISTANCE || '30'),
  FOLLOW_STOP_DISTANCE: parseFloat(process.env.FOLLOW_STOP_DISTANCE || '35'),
  FOLLOW_TIMEOUT_MS: parseInt(process.env.FOLLOW_TIMEOUT_MS || '30000', 10),

  MAX_CONSECUTIVE_ERRORS: parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '6', 10)
};

// ----- State -----
let bot = null;
let actionTimer = null;
let reconnectTimer = null;
let followTimeout = null;
let followCheckInterval = null;
let lastActionTime = Date.now();
let consecutiveErrors = 0;
let isStopping = false;

// pathfinder references (will be set after spawn if available)
let pfModule = null;      // the required module
let GoalFollow = null;    // pfModule.goals.GoalFollow
let Movements = null;     // pfModule.Movements

// ----- HTTP server for Render (keep-alive & health) -----
const app = express();
app.get('/', (req, res) => {
  res.send(`<h3>MC KeepAlive Bot</h3><p>Username: ${CONFIG.MC_USERNAME}</p>
    <p>Server: ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}</p>
    <p><a href="/health">/health</a> | <a href="/status">/status</a></p>`);
});
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    connected: !!(bot && bot.entity),
    uptime_s: Math.floor(process.uptime())
  });
});
app.get('/status', (req, res) => {
  if (!bot || !bot.entity) return res.json({ status: 'disconnected', username: CONFIG.MC_USERNAME });
  res.json({
    status: 'connected',
    username: bot.username,
    pos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    health: bot.health,
    food: bot.food
  });
});
const HTTP_PORT = process.env.PORT || 3000;
app.listen(HTTP_PORT, () => console.log(`[http] server listening on ${HTTP_PORT}`));

// Self-ping to keep Render awake (optional). Set RENDER_SERVICE_URL in env to enable.
if (process.env.RENDER_SERVICE_URL) {
  const pingUrl = `${process.env.RENDER_SERVICE_URL.replace(/\/$/, '')}/health`;
  console.log('[render] self-ping enabled ->', pingUrl);
  setInterval(() => {
    fetch(pingUrl)
      .then(() => console.log('[render] self-ping OK'))
      .catch(err => console.log('[render] self-ping failed:', err && err.message ? err.message : err));
  }, 13 * 60 * 1000); // every 13 minutes
}

// ----- Create bot -----
// Note: dynamic require & plugin load deferred until spawn to avoid mcData null issues.
function createBot() {
  if (isStopping) return;
  console.log('[bot] creating ->', CONFIG.MC_USERNAME, '@', `${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`, 'version', CONFIG.MC_VERSION);

  try {
    bot = mineflayer.createBot({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,
      password: CONFIG.MC_PASSWORD || undefined,
      version: CONFIG.MC_VERSION || false,
      hideErrors: false
    });
  } catch (e) {
    console.log('[bot] createBot exception:', e && e.message ? e.message : e);
    scheduleReconnect();
    return;
  }

  // IMPORTANT: require pathfinder only after bot exists and we can wait for spawn.
  bot.once('spawn', async () => {
    console.log('[bot] spawned into world — now initializing optional pathfinder & movements.');

    // dynamic require of mineflayer-pathfinder (safe now)
    try {
      pfModule = require('mineflayer-pathfinder');
      // prefer direct references if available
      Movements = pfModule.Movements || pfModule.default?.Movements || null;
      GoalFollow = (pfModule.goals && pfModule.goals.GoalFollow) || pfModule.default?.goals?.GoalFollow || null;

      // load plugin into bot after require
      if (pfModule.pathfinder || pfModule) {
        try {
          bot.loadPlugin(pfModule.pathfinder || pfModule);
          console.log('[bot] pathfinder plugin loaded after spawn');
        } catch (e) {
          console.log('[bot] failed to load pathfinder plugin:', e && e.message ? e.message : e);
          // keep going without follow features
        }
      }
      // init Movements if available and bot.pathfinder exists
      try {
        if (Movements && bot.pathfinder) {
          const mcData = mcDataLib(bot.version);
          const movements = new Movements(bot, mcData);
          if (bot.pathfinder && typeof bot.pathfinder.setMovements === 'function') {
            bot.pathfinder.setMovements(movements);
            console.log('[bot] pathfinder movements initialized');
          }
        } else {
          console.log('[bot] Movements not available; follow features limited.');
        }
      } catch (e) {
        console.log('[bot] warning: cannot init Movements:', e && e.message ? e.message : e);
      }
    } catch (e) {
      console.log('[startup] mineflayer-pathfinder not available or require failed:', e && e.message ? e.message : e);
      // Not fatal — bot will still act (without follow)
    }

    // reset errors & start action loop
    consecutiveErrors = 0;
    startActionLoop();
  });

  setupBotEvents();
}

// ----- Bot events -----
function setupBotEvents() {
  if (!bot) return;

  bot.on('end', (reason) => {
    console.log('[bot] connection ended:', reason);
    stopActionLoop();
    scheduleReconnect();
  });

  bot.on('kicked', (reason) => {
    console.log('[bot] kicked:', reason);
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    console.log('[bot] error:', err && err.message ? err.message : err);
    consecutiveErrors++;
    if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
      console.log('[bot] too many consecutive errors -> restarting');
      try { bot.quit(); } catch (e) {}
    }
  });

  bot.on('death', () => {
    console.log('[bot] died -> attempting respawn');
    stopActionLoop();
    // try respawn if available
    if (typeof bot.respawn === 'function') {
      setTimeout(() => {
        try { bot.respawn(); console.log('[bot] respawn called'); } catch (e) { console.log('[bot] respawn error:', e && e.message ? e.message : e); }
      }, 800);
    } else {
      try { bot.quit(); } catch (e) {}
    }
  });

  bot.on('chat', (username, message) => {
    try {
      if (!bot || !bot.username) return;
      if (username === bot.username) return;
      handleChat(username, message);
    } catch (e) {
      console.log('[chat] handler error:', e && e.message ? e.message : e);
    }
  });
}

// ----- Chat commands -----
function handleChat(username, message) {
  const trimmed = String(message).trim();
  const match = trimmed.match(/^\((.+)\)$/);
  if (!match) return;
  const cmd = match[1].trim();
  console.log('[chat] coded command from', username, ':', cmd);

  if (cmd === 'الحقني' || cmd.toLowerCase() === 'follow me') {
    tryFollowPlayer(username);
  } else if (cmd === 'توقف' || cmd.toLowerCase() === 'stop') {
    stopFollowing();
    safeChat('تم إيقاف المتابعة.');
  } else {
    // ignore unknown coded commands
    console.log('[chat] unknown coded command:', cmd);
  }
}

// ----- Follow logic (requires pathfinder module loaded at spawn) -----
function tryFollowPlayer(username) {
  if (!bot) return;
  if (!(pfModule && pfModule.goals && bot.pathfinder)) {
    safeChat('ميزة المتابعة غير متاحة الآن.');
    return;
  }
  const player = bot.players[username];
  if (!player || !player.entity) {
    safeChat(`ما لقيتك ${username}.`);
    return;
  }
  if (!bot.entity || !bot.entity.position) return;

  const dist = bot.entity.position.distanceTo(player.entity.position);
  console.log(`[follow] distance to ${username}: ${dist.toFixed(2)} blocks`);
  if (dist <= CONFIG.FOLLOW_START_DISTANCE) {
    try {
      const GoalFollowLocal = pfModule.goals.GoalFollow || pfModule.default?.goals?.GoalFollow;
      const goal = new GoalFollowLocal(player.entity, 1);
      bot.pathfinder.setGoal(goal, true);
      safeChat(`جاي وراك يا ${username} 🐾`);

      if (followTimeout) clearTimeout(followTimeout);
      if (followCheckInterval) clearInterval(followCheckInterval);

      followTimeout = setTimeout(() => { stopFollowing(); }, CONFIG.FOLLOW_TIMEOUT_MS);
      followCheckInterval = setInterval(() => {
        if (!bot || !bot.entity) { clearInterval(followCheckInterval); followCheckInterval = null; return; }
        const p = bot.players[username];
        if (!p || !p.entity) { stopFollowing(); return; }
        const d = bot.entity.position.distanceTo(p.entity.position);
        if (d > CONFIG.FOLLOW_STOP_DISTANCE) stopFollowing();
      }, 2000);
    } catch (e) {
      console.log('[follow] error:', e && e.message ? e.message : e);
      safeChat('حدث خطأ بمحاولة المتابعة.');
    }
  } else {
    safeChat(`معليش ${username} بعيد (${Math.round(dist)} بلوك)`);
  }
}

function stopFollowing() {
  try {
    if (bot && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
    if (followTimeout) { clearTimeout(followTimeout); followTimeout = null; }
    if (followCheckInterval) { clearInterval(followCheckInterval); followCheckInterval = null; }
    console.log('[follow] stopped following');
  } catch (e) {
    console.log('[follow] stop error:', e && e.message ? e.message : e);
  }
}

// ----- Natural movement (anti-AFK) -----
function startActionLoop() {
  if (actionTimer) clearTimeout(actionTimer);
  scheduleNextAction();
  console.log('[action] action loop started');
}

function scheduleNextAction() {
  const delay = CONFIG.MIN_ACTION_DELAY + Math.floor(Math.random() * (CONFIG.MAX_ACTION_DELAY - CONFIG.MIN_ACTION_DELAY + 1));
  actionTimer = setTimeout(() => {
    doNaturalAction();
    scheduleNextAction();
  }, delay);
}

function doNaturalAction() {
  if (!bot || !bot.entity) return;
  lastActionTime = Date.now();

  const actions = [
    { type: 'look', weight: 30 },
    { type: 'walk', weight: 25 },
    { type: 'jump', weight: 12 },
    { type: 'sneak', weight: 10 },
    { type: 'sprint', weight: 10 },
    { type: 'idle', weight: 13 }
  ];
  const choice = weightedPick(actions);

  try {
    switch (choice) {
      case 'look': performLook(); break;
      case 'walk': performWalk(); break;
      case 'jump': performJump(); break;
      case 'sneak': performSneak(); break;
      case 'sprint': performSprint(); break;
      case 'idle': performIdle(); break;
    }

    if (Math.random() < CONFIG.CHAT_PROBABILITY) {
      const msg = CONFIG.GREETINGS[Math.floor(Math.random() * CONFIG.GREETINGS.length)];
      setTimeout(() => safeChat(msg), Math.random() * 1500);
    }
    console.log('[action] did', choice);
  } catch (e) {
    console.log('[action] error:', e && e.message ? e.message : e);
  }
}

// movement implementations
function performLook() {
  try {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * Math.PI * 0.5;
    bot.look(yaw, pitch, true);
  } catch {}
}
function performWalk() {
  try {
    const dur = 800 + Math.floor(Math.random() * 2200);
    const turn = (Math.random() - 0.5) * 1.5;
    try { bot.look((bot.entity.yaw || 0) + turn, bot.entity.pitch || 0, true); } catch (e) {}
    bot.setControlState('forward', true);
    if (Math.random() < 0.3) {
      const dir = Math.random() < 0.5 ? 'left' : 'right';
      bot.setControlState(dir, true);
      setTimeout(() => bot.setControlState(dir, false), dur / 2);
    }
    setTimeout(() => bot.setControlState('forward', false), dur);
  } catch {}
}
function performJump() {
  try { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 300 + Math.random() * 300); } catch {}
}
function performSneak() {
  try { const dur = 700 + Math.floor(Math.random() * 1800); bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), dur); } catch {}
}
function performSprint() {
  try {
    const dur = 1200 + Math.floor(Math.random() * 2500);
    bot.setControlState('forward', true);
    try { bot.setControlState('sprint', true); } catch {}
    setTimeout(() => { try { bot.setControlState('sprint', false); } catch {} bot.setControlState('forward', false); }, dur);
  } catch {}
}
function performIdle() {
  try {
    const changes = 1 + Math.floor(Math.random() * 3);
    let delay = 0;
    for (let i = 0; i < changes; i++) {
      delay += 400 + Math.random() * 1000;
      setTimeout(() => {
        if (bot && bot.entity) {
          try {
            const yaw = (bot.entity.yaw || 0) + (Math.random() - 0.5) * 0.5;
            const pitch = (bot.entity.pitch || 0) + (Math.random() - 0.5) * 0.3;
            bot.look(yaw, pitch, true);
          } catch {}
        }
      }, delay);
    }
  } catch {}
}

function stopActionLoop() {
  if (actionTimer) { clearTimeout(actionTimer); actionTimer = null; }
  stopFollowing();
  console.log('[action] stopped');
}

// ----- Utilities -----
function weightedPick(items) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.type;
  }
  return items[0].type;
}

function scheduleReconnect() {
  if (reconnectTimer || isStopping) return;
  console.log(`[bot] reconnect scheduled in ${CONFIG.RECONNECT_DELAY}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[bot] attempting reconnect...');
    try {
      createBot();
    } catch (e) {
      console.log('[bot] reconnect failed:', e && e.message ? e.message : e);
      scheduleReconnect();
    }
  }, CONFIG.RECONNECT_DELAY);
}

function safeChat(text) {
  try { if (bot && typeof bot.chat === 'function') bot.chat(String(text).slice(0, 256)); } catch {}
}

// ----- Start -----
console.log('='.repeat(40));
console.log('🤖 MC KeepAlive Bot — Fixed Enhanced');
console.log('Starting with:', CONFIG.MC_USERNAME, CONFIG.MC_HOST + ':' + CONFIG.MC_PORT, 'version', CONFIG.MC_VERSION);
console.log('='.repeat(40));
createBot();

// graceful shutdown
process.on('SIGINT', () => { console.log('[proc] SIGINT — shutting down'); isStopping = true; stopActionLoop(); if (bot) try { bot.quit(); } catch (e) {}; process.exit(0); });
process.on('SIGTERM', () => { console.log('[proc] SIGTERM — shutting down'); isStopping = true; stopActionLoop(); if (bot) try { bot.quit(); } catch (e) {}; process.exit(0); });

