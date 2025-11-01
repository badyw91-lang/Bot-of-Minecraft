// index.js
// بوت يبقى متصل + ي respawn عند الموت + ينفذ أوامر بين قوسين (مثال: (الحقني))
// ويدعم متابعة اللاعب باستخدام mineflayer-pathfinder إذا كان داخل 30 بلوك.

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalFollow } } = require('mineflayer-pathfinder');
const mcDataLib = require('minecraft-data');

const CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'KeepAliveBot',
  password: process.env.MC_PASSWORD || undefined,
  version: process.env.MC_VERSION || false,
  minActionDelay: parseInt(process.env.MIN_ACTION_DELAY || '5000', 10),
  maxActionDelay: parseInt(process.env.MAX_ACTION_DELAY || '20000', 10),
  reconnectDelay: parseInt(process.env.RECONNECT_DELAY || '8000', 10),
  chatProbability: parseFloat(process.env.CHAT_PROBABILITY || '0.08'),
  greetings: (process.env.GREETINGS && process.env.GREETINGS.split('|')) || ['hi', 'hello', 'anyone here?', 'keeping server alive'],
  followMaxStartDistance: parseFloat(process.env.FOLLOW_START_DISTANCE || '30'), // بلوك
  followStopDistance: parseFloat(process.env.FOLLOW_STOP_DISTANCE || '35'), // لو بعد كذا يوقف
  followTimeoutMs: parseInt(process.env.FOLLOW_TIMEOUT_MS || String(30 * 1000), 10) // مدة المتابعة الافتراضية
};

let bot = null;
let actionTimer = null;
let reconnectTimer = null;
let followTimeout = null;

function createBot() {
  console.log('[keepalive] connecting to', CONFIG.host + ':' + CONFIG.port, 'as', CONFIG.username);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    password: CONFIG.password || undefined,
    version: CONFIG.version || false,
  });

  // load pathfinder plugin
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('[keepalive] spawned. setting up movements & behavior loop.');

    // setup movements (required for pathfinder)
    try {
      const mcData = mcDataLib(bot.version);
      const defaultMove = new Movements(bot, mcData);
      bot.pathfinder.setMovements(defaultMove);
    } catch (e) {
      console.log('[keepalive] warning: failed to init mcData/movements:', e && e.message ? e.message : e);
    }

    startBehaviorLoop();
  });

  // respawn on death (if server allows it)
  bot.on('death', () => {
    console.log('[keepalive] I died! trying to respawn...');
    // بعض إصدارات mineflayer توفر bot.respawn()
    if (typeof bot.respawn === 'function') {
      try {
        setTimeout(() => {
          try { bot.respawn(); console.log('[keepalive] called bot.respawn()'); } catch (e) { console.log('[keepalive] respawn error:', e && e.message ? e.message : e); }
        }, 1000);
      } catch (e) {
        console.log('[keepalive] respawn exception:', e && e.message ? e.message : e);
      }
    } else {
      console.log('[keepalive] bot.respawn() not available in this version — reconnecting instead.');
      // طريقة بديلة: نغلق ونعاود الاتصال
      try { bot.quit(); } catch (e) {}
    }
  });

  bot.on('end', (reason) => {
    console.log('[keepalive] disconnected:', reason);
    stopBehaviorLoop();
    scheduleReconnect();
  });

  bot.on('kicked', (reason, loggedIn) => {
    console.log('[keepalive] kicked:', reason, 'loggedIn:', loggedIn);
  });

  bot.on('error', (err) => {
    console.log('[keepalive] error:', err && err.message ? err.message : err);
  });

  // chat handler: يبحث عن أوامر داخل قوسين: (command)
  bot.on('chat', (username, message) => {
    if (!bot || !bot.username) return;
    if (username === bot.username) return;

    const trimmed = message.trim();
    const match = trimmed.match(/^\((.+)\)$/); // يأخذ كل ما بين القوسين
    if (!match) return;

    const cmd = match[1].trim();
    console.log(`[keepalive] received coded chat command from ${username}: (${cmd})`);

    // دعم أمر (الحقني)
    if (cmd === 'الحقني' || cmd.toLowerCase() === 'follow me') {
      tryFollowPlayer(username);
    } else {
      // هنا تقدر تضيف أوامر جديدة بسهولة
      console.log('[keepalive] unknown coded command:', cmd);
    }
  });
}

// يحاول متابعة اللاعب إذا كان ضمن مسافة بداية محددة (مثلاً 30 بلوك)
function tryFollowPlayer(username) {
  if (!bot) return;
  const player = bot.players[username];
  if (!player || !player.entity) {
    console.log('[keepalive] player entity not found for', username);
    return;
  }

  if (!bot.entity || !bot.entity.position) {
    console.log('[keepalive] bot position unknown, cannot follow yet.');
    return;
  }

  const playerPos = player.entity.position;
  const botPos = bot.entity.position;
  const dist = botPos.distanceTo(playerPos);
  console.log(`[keepalive] distance to ${username} is ${dist.toFixed(2)} blocks.`);

  if (dist <= CONFIG.followMaxStartDistance) {
    // نبدأ متابعة باستخدام goal GoalFollow
    console.log(`[keepalive] starting follow ${username} (distance ${dist.toFixed(1)} <= ${CONFIG.followMaxStartDistance})`);
    try {
      const followGoal = new GoalFollow(player.entity, 1); // الهدف: قريب جداً من اللاعب (1)
      bot.pathfinder.setGoal(followGoal, true);

      // مسح أي Timeout سابق
      if (followTimeout) clearTimeout(followTimeout);
      // ضبط Timeout لإيقاف المتابعة بعد مدة محددة
      followTimeout = setTimeout(() => {
        stopFollowing();
      }, CONFIG.followTimeoutMs);

      // مراقبة المسافة: إذا صار أبعد من followStopDistance نوقف المتابعة
      const checkInterval = setInterval(() => {
        if (!bot || !bot.entity) { clearInterval(checkInterval); return; }
        const p = bot.players[username];
        if (!p || !p.entity) {
          console.log('[keepalive] player disconnected or entity gone — stopping follow.');
          clearInterval(checkInterval);
          stopFollowing();
          return;
        }
        const d = bot.entity.position.distanceTo(p.entity.position);
        if (d > CONFIG.followStopDistance) {
          console.log('[keepalive] player too far (', d.toFixed(1), '>) stopping follow.');
          clearInterval(checkInterval);
          stopFollowing();
        }
      }, 2000);

    } catch (e) {
      console.log('[keepalive] follow error:', e && e.message ? e.message : e);
    }
  } else {
    console.log(`[keepalive] player too far to start follow (${dist.toFixed(1)} > ${CONFIG.followMaxStartDistance})`);
    // اختيار: نرد بعلامة شات لو نبي
    try { bot.chat(`معليش ${username} بعيد (${Math.round(dist)} بلوك)`); } catch (e) {}
  }
}

function stopFollowing() {
  try {
    bot.pathfinder.setGoal(null);
    console.log('[keepalive] stopped following.');
    if (followTimeout) { clearTimeout(followTimeout); followTimeout = null; }
  } catch (e) {
    console.log('[keepalive] error stopping follow:', e && e.message ? e.message : e);
  }
}

// السلوك العشوائي لتجنب AFK
let actionTimerRef = null;
function startBehaviorLoop() {
  if (actionTimerRef) clearTimeout(actionTimerRef);
  scheduleNextAction();
}

function scheduleNextAction() {
  const delay = CONFIG.minActionDelay + Math.floor(Math.random() * (CONFIG.maxActionDelay - CONFIG.minActionDelay + 1));
  actionTimerRef = setTimeout(() => {
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
      const pitch = (Math.random() - 0.5) * Math.PI * 0.7;
      bot.look(yaw, pitch, true);
    } else if (choice === 'walk') {
      const duration = 500 + Math.floor(Math.random() * 1800);
      const turnYaw = (Math.random() - 0.5) * 0.9;
      try { bot.look(bot.entity.yaw + turnYaw, bot.entity.pitch, true); } catch (e) {}
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

    if (Math.random() < CONFIG.chatProbability) {
      const msg = CONFIG.greetings[Math.floor(Math.random() * CONFIG.greetings.length)];
      try { bot.chat(msg); } catch (e) {}
    }
    console.log('[keepalive] did action:', choice);
  } catch (e) {
    console.log('[keepalive] action error:', e && e.message ? e.message : e);
  }
}

function stopBehaviorLoop() {
  if (actionTimerRef) { clearTimeout(actionTimerRef); actionTimerRef = null; }
  stopFollowing();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[keepalive] reconnecting...');
    createBot();
  }, CONFIG.reconnectDelay);
}

process.on('SIGINT', () => {
  console.log('[keepalive] SIGINT, shutting down');
  stopBehaviorLoop();
  if (bot) try { bot.quit(); } catch (e) {}
  process.exit(0);
});

// start
createBot();
