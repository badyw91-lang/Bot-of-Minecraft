/**
 * index.js
 * Minecraft keep-alive bot — Render-ready
 * - Express HTTP endpoint to keep service awake on Render
 * - Mineflayer bot with pathfinder
 * - Respawn handling on death (if supported)
 * - Coded chat commands in parentheses: (الحقني) to follow, (توقف) to stop
 * - Random semi-human actions to avoid AFK detection
 */

const mineflayer = require('mineflayer');
const express = require('express');
const { pathfinder, Movements, goals: { GoalFollow } } = require('mineflayer-pathfinder');
const mcDataLib = require('minecraft-data');

// ---- CONFIG (from environment variables) ----
const CONFIG = {
  // Minecraft connection
  MC_HOST: process.env.MC_HOST || '127.0.0.1',
  MC_PORT: parseInt(process.env.MC_PORT || '25565', 10),
  MC_USERNAME: process.env.MC_USERNAME || 'KeepAliveBot',
  MC_PASSWORD: process.env.MC_PASSWORD || undefined,
  MC_VERSION: process.env.MC_VERSION || false, // false = auto

  // Behavior timing (ms)
  MIN_ACTION_DELAY: parseInt(process.env.MIN_ACTION_DELAY || '5000', 10),
  MAX_ACTION_DELAY: parseInt(process.env.MAX_ACTION_DELAY || '20000', 10),
  RECONNECT_DELAY: parseInt(process.env.RECONNECT_DELAY || '8000', 10),

  // Chat & follow
  CHAT_PROBABILITY: parseFloat(process.env.CHAT_PROBABILITY || '0.08'),
  GREETINGS: (process.env.GREETINGS && process.env.GREETINGS.split('|')) || ['hi', 'hello', 'anyone here?', 'keeping server alive'],
  FOLLOW_START_DISTANCE: parseFloat(process.env.FOLLOW_START_DISTANCE || '30'), // blocks to allow start
  FOLLOW_STOP_DISTANCE: parseFloat(process.env.FOLLOW_STOP_DISTANCE || '35'),   // blocks to stop following
  FOLLOW_TIMEOUT_MS: parseInt(process.env.FOLLOW_TIMEOUT_MS || String(30 * 1000), 10) // follow max time
};

// ---- Global state ----
let bot = null;
let actionTimer = null;
let reconnectTimer = null;
let followTimeout = null;
let followCheckInterval = null;

// ---- Small HTTP server for Render keep-alive ----
const app = express();
app.get('/', (req, res) => res.send('MC KeepAlive Bot is UP ✅'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[http] server listening on ${PORT}`));

// ---- Bot creation ----
function createBot() {
  console.log('[bot] connecting to', `${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`, 'as', CONFIG.MC_USERNAME);

  bot = mineflayer.createBot({
    host: CONFIG.MC_HOST,
    port: CONFIG.MC_PORT,
    username: CONFIG.MC_USERNAME,
    password: CONFIG.MC_PASSWORD || undefined,
    version: CONFIG.MC_VERSION || false,
  });

  // load pathfinder plugin early
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('[bot] spawned into world.');
    try {
      const mcData = mcDataLib(bot.version);
      const movements = new Movements(bot, mcData);
      bot.pathfinder.setMovements(movements);
    } catch (e) {
      console.log('[bot] warning: failed to init movements:', e && e.message ? e.message : e);
    }
    startActionLoop();
  });

  // Death -> try respawn or reconnect
  bot.on('death', () => {
    console.log('[bot] died. attempting respawn or reconnect...');
    // some versions have bot.respawn()
    if (typeof bot.respawn === 'function') {
      try {
        setTimeout(() => {
          try { bot.respawn(); console.log('[bot] respawn called'); } catch (e) { console.log('[bot] respawn error:', e && e.message ? e.message : e); }
        }, 800);
      } catch (e) {
        console.log('[bot] respawn exception:', e && e.message ? e.message : e);
      }
    } else {
      // fallback: quit and let reconnect logic handle it
      try { bot.quit(); } catch (e) {}
    }
  });

  bot.on('end', (reason) => {
    console.log('[bot] connection ended:', reason);
    stopActionLoop();
    scheduleReconnect();
  });

  bot.on('kicked', (reason) => {
    console.log('[bot] kicked:', reason);
  });

  bot.on('error', (err) => {
    console.log('[bot] error:', err && err.message ? err.message : err);
  });

  // Chat handler: look for coded commands inside parentheses ( ... )
  bot.on('chat', (username, message) => {
    try {
      if (!bot || !bot.username) return;
      if (username === bot.username) return;
      const trimmed = String(message).trim();
      const match = trimmed.match(/^\((.+)\)$/);
      if (!match) return;

      const cmd = match[1].trim();
      console.log('[bot] coded command from', username, ':', cmd);

      if (cmd === 'الحقني' || cmd.toLowerCase() === 'follow me') {
        tryFollowPlayer(username);
      } else if (cmd === 'توقف' || cmd.toLowerCase() === 'stop') {
        stopFollowing();
        safeChat(`تم إيقاف المتابعة.`);
      } else {
        // يمكن إضافة أوامر جديدة هنا بسهولة
        console.log('[bot] unknown coded command:', cmd);
      }
    } catch (e) {
      console.log('[bot] chat handler error:', e && e.message ? e.message : e);
    }
  });
}

// ---- Follow logic ----
function tryFollowPlayer(username) {
  if (!bot) return;
  const player = bot.players[username];
  if (!player || !player.entity) {
    console.log('[follow] player entity not found for', username);
    safeChat(`ما لقيتك ${username}.`);
    return;
  }
  if (!bot.entity || !bot.entity.position) {
    console.log('[follow] bot position unknown');
    return;
  }

  const dist = bot.entity.position.distanceTo(player.entity.position);
  console.log(`[follow] distance to ${username}: ${dist.toFixed(2)} blocks`);

  if (dist <= CONFIG.FOLLOW_START_DISTANCE) {
    console.log('[follow] starting follow:', username);
    try {
      // start following
      const goal = new GoalFollow(player.entity, 1);
      bot.pathfinder.setGoal(goal, true);
      safeChat(`جاي وراك يا ${username} 🐾`);

      // clear previous timers/intervals
      if (followTimeout) clearTimeout(followTimeout);
      if (followCheckInterval) clearInterval(followCheckInterval);

      // timeout to stop following after configured ms
      followTimeout = setTimeout(() => {
        console.log('[follow] follow timeout reached, stopping.');
        stopFollowing();
      }, CONFIG.FOLLOW_TIMEOUT_MS);

      // check distance periodically — stop if player too far or disconnected
      followCheckInterval = setInterval(() => {
        if (!bot || !bot.entity) {
          clearInterval(followCheckInterval);
          followCheckInterval = null;
          return;
        }
        const p = bot.players[username];
        if (!p || !p.entity) {
          console.log('[follow] player lost or disconnected — stopping follow.');
          stopFollowing();
          return;
        }
        const d = bot.entity.position.distanceTo(p.entity.position);
        if (d > CONFIG.FOLLOW_STOP_DISTANCE) {
          console.log('[follow] player too far (', d.toFixed(1), ') — stopping follow.');
          stopFollowing();
        }
      }, 2000);
    } catch (e) {
      console.log('[follow] error starting follow:', e && e.message ? e.message : e);
    }
  } else {
    console.log('[follow] player too far to start follow:', dist.toFixed(1));
    safeChat(`معليش ${username} بعيد (${Math.round(dist)} بلوك)`);
  }
}

function stopFollowing() {
  try {
    if (!bot) return;
    bot.pathfinder.setGoal(null);
    console.log('[follow] stopped following.');
    if (followTimeout) { clearTimeout(followTimeout); followTimeout = null; }
    if (followCheckInterval) { clearInterval(followCheckInterval); followCheckInterval = null; }
  } catch (e) {
    console.log('[follow] error stopping follow:', e && e.message ? e.message : e);
  }
}

// ---- Random action loop (anti-AFK) ----
function startActionLoop() {
  if (actionTimer) clearTimeout(actionTimer);
  scheduleNextAction();
}

function scheduleNextAction() {
  const delay = CONFIG.MIN_ACTION_DELAY + Math.floor(Math.random() * (CONFIG.MAX_ACTION_DELAY - CONFIG.MIN_ACTION_DELAY + 1));
  actionTimer = setTimeout(() => {
    doRandomAction();
    scheduleNextAction();
  }, delay);
}

function doRandomAction() {
  if (!bot || !bot.entity) return;

  const actions = ['look', 'walk', 'jump', 'sneak'];
  const choice = actions[Math.floor(Math.random() * actions.length)];

  try {
    if (choice === 'look') {
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI * 0.6;
      bot.look(yaw, pitch, true);
    } else if (choice === 'walk') {
      // short forward step with a small random yaw
      const duration = 500 + Math.floor(Math.random() * 1600);
      const turnYaw = (Math.random() - 0.5) * 0.9;
      try { bot.look((bot.entity.yaw || 0) + turnYaw, bot.entity.pitch || 0, true); } catch (e) {}
      bot.setControlState('forward', true);
      setTimeout(() => bot.setControlState('forward', false), duration);
    } else if (choice === 'jump') {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
    } else if (choice === 'sneak') {
      bot.setControlState('sneak', true);
      const dur = 600 + Math.floor(Math.random() * 1200);
      setTimeout(() => bot.setControlState('sneak', false), dur);
    }

    // small chance to chat
    if (Math.random() < CONFIG.CHAT_PROBABILITY) {
      const msg = CONFIG.GREETINGS[Math.floor(Math.random() * CONFIG.GREETINGS.length)];
      safeChat(msg);
    }

    console.log('[action] did action:', choice);
  } catch (e) {
    console.log('[action] error:', e && e.message ? e.message : e);
  }
}

function stopActionLoop() {
  if (actionTimer) { clearTimeout(actionTimer); actionTimer = null; }
  stopFollowing();
}

// ---- Utilities ----
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[bot] reconnecting...');
    try { createBot(); } catch (e) { console.log('[bot] reconnect createBot error:', e && e.message ? e.message : e); }
  }, CONFIG.RECONNECT_DELAY);
}

function safeChat(text) {
  try {
    if (bot && typeof bot.chat === 'function') bot.chat(String(text).slice(0, 256));
  } catch (e) {
    // ignore chat errors
  }
}

// ---- Start everything ----
createBot();

