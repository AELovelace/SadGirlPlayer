const { config } = require('./config');
const { logger } = require('./logger');
const { evaluateIncomingMessage, evaluateOutgoingMessage } = require('./moderation');
const { loadChatbotState, scheduleStateSave, flushStateSave } = require('./chatbotStateStore');
const { requestLlmCompletion } = require('./llmClient');

const channelState = new Map();
let initialized = false;
const runtimeSettings = {
  enabled: config.chatbotEnabled,
  channelIds: [...config.chatbotChannelIds],
  replyChance: config.chatbotReplyChance,
  contextMessages: config.chatbotContextMessages,
  cooldownMs: config.chatbotCooldownMs,
  maxResponseChars: config.chatbotMaxResponseChars,
};

function sanitizeReplyChance(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return runtimeSettings.replyChance;
  }

  return Math.max(0, Math.min(1, numeric));
}

function sanitizePositive(value, fallback) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return numeric;
}

function snapshotState() {
  const channels = {};
  channelState.forEach((value, key) => {
    channels[key] = {
      history: value.history,
      lastReplyAt: value.lastReplyAt,
    };
  });

  return {
    channels,
    settings: {
      enabled: runtimeSettings.enabled,
      channelIds: runtimeSettings.channelIds,
      replyChance: runtimeSettings.replyChance,
      contextMessages: runtimeSettings.contextMessages,
      cooldownMs: runtimeSettings.cooldownMs,
      maxResponseChars: runtimeSettings.maxResponseChars,
    },
  };
}

async function initializeChatbot() {
  if (initialized) {
    return;
  }

  const loaded = await loadChatbotState();
  Object.entries(loaded.channels).forEach(([channelId, value]) => {
    channelState.set(channelId, {
      history: Array.isArray(value.history) ? value.history : [],
      lastReplyAt: Number.isFinite(value.lastReplyAt) ? value.lastReplyAt : 0,
    });
  });

  if (loaded.settings && typeof loaded.settings === 'object') {
    runtimeSettings.enabled = typeof loaded.settings.enabled === 'boolean'
      ? loaded.settings.enabled
      : runtimeSettings.enabled;
    runtimeSettings.channelIds = Array.isArray(loaded.settings.channelIds)
      ? loaded.settings.channelIds.filter(Boolean)
      : runtimeSettings.channelIds;
    runtimeSettings.replyChance = sanitizeReplyChance(loaded.settings.replyChance);
    runtimeSettings.contextMessages = sanitizePositive(loaded.settings.contextMessages, runtimeSettings.contextMessages);
    runtimeSettings.cooldownMs = sanitizePositive(loaded.settings.cooldownMs, runtimeSettings.cooldownMs);
    runtimeSettings.maxResponseChars = sanitizePositive(
      loaded.settings.maxResponseChars,
      runtimeSettings.maxResponseChars,
    );
  }

  initialized = true;
  logger.info(
    `Loaded chatbot memory: channels=${channelState.size}, enabled=${runtimeSettings.enabled}, replyChance=${runtimeSettings.replyChance}`,
  );
}

function persistState() {
  scheduleStateSave(snapshotState);
}

async function flushChatbotState() {
  await flushStateSave(snapshotState);
}

function getRuntimeSettings() {
  return {
    enabled: runtimeSettings.enabled,
    channelIds: [...runtimeSettings.channelIds],
    replyChance: runtimeSettings.replyChance,
    contextMessages: runtimeSettings.contextMessages,
    cooldownMs: runtimeSettings.cooldownMs,
    maxResponseChars: runtimeSettings.maxResponseChars,
  };
}

function updateRuntimeSettings(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    runtimeSettings.enabled = Boolean(patch.enabled);
  }

  if (Array.isArray(patch.channelIds)) {
    runtimeSettings.channelIds = patch.channelIds.map((id) => String(id).trim()).filter(Boolean);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'replyChance')) {
    runtimeSettings.replyChance = sanitizeReplyChance(patch.replyChance);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'contextMessages')) {
    runtimeSettings.contextMessages = sanitizePositive(patch.contextMessages, runtimeSettings.contextMessages);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'cooldownMs')) {
    runtimeSettings.cooldownMs = sanitizePositive(patch.cooldownMs, runtimeSettings.cooldownMs);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'maxResponseChars')) {
    runtimeSettings.maxResponseChars = sanitizePositive(patch.maxResponseChars, runtimeSettings.maxResponseChars);
  }

  persistState();
  return getRuntimeSettings();
}

function getChannelState(channelId) {
  const existing = channelState.get(channelId);
  if (existing) {
    return existing;
  }

  const created = {
    history: [],
    lastReplyAt: 0,
  };
  channelState.set(channelId, created);
  return created;
}

function pushHistoryEntry(state, entry) {
  state.history.push(entry);
  const maxHistory = Math.max(1, runtimeSettings.contextMessages);
  if (state.history.length > maxHistory) {
    state.history.splice(0, state.history.length - maxHistory);
  }

  persistState();
}

function isDirectlyAddressed(message) {
  const botUserId = message.client.user?.id;
  if (!botUserId) {
    return false;
  }

  if (message.mentions?.users?.has(botUserId)) {
    return true;
  }

  return message.mentions?.repliedUser?.id === botUserId;
}

function computeInterestScore(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }

  let score = 0;
  if (normalized.includes('?')) {
    score += 2;
  }
  if (/\b(how|why|what|when|where|who)\b/iu.test(normalized)) {
    score += 2;
  }
  if (/\b(lumi|thoughts|opinion|help|explain|idea|advice)\b/iu.test(normalized)) {
    score += 2;
  }
  if (normalized.length >= 24) {
    score += 1;
  }

  return score;
}

function shouldHandleInChannel(message) {
  if (!runtimeSettings.enabled) {
    return false;
  }

  if (runtimeSettings.channelIds.length === 0) {
    return false;
  }

  return runtimeSettings.channelIds.includes(message.channelId);
}

function shouldAttemptReply(message, state) {
  const direct = isDirectlyAddressed(message);
  const interest = computeInterestScore(message.content) >= 3;
  const probabilistic = Math.random() < runtimeSettings.replyChance;
  const now = Date.now();
  const inCooldown = now - state.lastReplyAt < runtimeSettings.cooldownMs;

  if (inCooldown) {
    return {
      shouldReply: false,
      reason: 'cooldown',
    };
  }

  if (direct || interest || probabilistic) {
    return {
      shouldReply: true,
      reason: direct ? 'direct' : interest ? 'interest' : 'random',
    };
  }

  return {
    shouldReply: false,
    reason: 'no-trigger',
  };
}

async function handleAutonomousMessage(message) {
  if (!initialized) {
    await initializeChatbot();
  }

  if (!shouldHandleInChannel(message)) {
    return;
  }

  if (message.content.startsWith(config.commandPrefix)) {
    return;
  }

  const text = message.content?.trim();
  if (!text) {
    return;
  }

  const inboundModeration = evaluateIncomingMessage(text);
  if (!inboundModeration.allowed) {
    logger.debug(`Chatbot skipped message due to moderation (${inboundModeration.reason}).`);
    return;
  }

  const state = getChannelState(message.channelId);
  pushHistoryEntry(state, {
    role: 'user',
    author: message.author.username,
    content: text,
  });

  const decision = shouldAttemptReply(message, state);
  if (!decision.shouldReply) {
    logger.debug(`Chatbot skipped message (${decision.reason}) in channel ${message.channelId}.`);
    return;
  }

  try {
    await message.channel.sendTyping();
    const response = await requestLlmCompletion({
      latestContent: text,
      history: state.history,
      maxResponseChars: runtimeSettings.maxResponseChars,
    });

    if (!response) {
      return;
    }

    const outboundModeration = evaluateOutgoingMessage(response);
    if (!outboundModeration.allowed) {
      logger.warn(`Chatbot response blocked by moderation (${outboundModeration.reason}).`);
      return;
    }

    await message.reply(outboundModeration.text);
    state.lastReplyAt = Date.now();
    persistState();
    pushHistoryEntry(state, {
      role: 'assistant',
      author: 'Lumi',
      content: outboundModeration.text,
    });

    logger.info(`Chatbot replied in channel ${message.channelId} (${decision.reason}).`);
  } catch (error) {
    logger.warn(`Chatbot response failed in channel ${message.channelId}.`, error.message);
  }
}

module.exports = {
  flushChatbotState,
  getRuntimeSettings,
  handleAutonomousMessage,
  initializeChatbot,
  updateRuntimeSettings,
};
