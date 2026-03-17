const fs = require('node:fs/promises');
const path = require('node:path');

const { config } = require('./config');
const { logger } = require('./logger');

let pendingTimer = null;
let pendingWrite = Promise.resolve();

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      author: typeof item.author === 'string' ? item.author : 'unknown',
      content: typeof item.content === 'string' ? item.content : '',
    }))
    .filter((item) => item.content.trim().length > 0)
    .slice(-Math.max(1, config.chatbotContextMessages));
}

function normalizeState(raw) {
  const channels = {};
  if (raw && typeof raw === 'object' && raw.channels && typeof raw.channels === 'object') {
    Object.entries(raw.channels).forEach(([channelId, value]) => {
      if (!value || typeof value !== 'object') {
        return;
      }

      channels[channelId] = {
        history: normalizeHistory(value.history),
        lastReplyAt: Number.isFinite(value.lastReplyAt) ? Number(value.lastReplyAt) : 0,
      };
    });
  }

  return {
    channels,
    settings: raw && typeof raw === 'object' && raw.settings && typeof raw.settings === 'object'
      ? raw.settings
      : {},
  };
}

async function ensureMemoryDirectory() {
  const targetDir = path.dirname(config.chatbotMemoryFile);
  await fs.mkdir(targetDir, { recursive: true });
}

async function loadChatbotState() {
  try {
    const content = await fs.readFile(config.chatbotMemoryFile, 'utf8');
    const parsed = JSON.parse(content);
    return normalizeState(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { channels: {}, settings: {} };
    }

    logger.warn('Could not read chatbot memory file. Starting fresh.', error.message);
    return { channels: {}, settings: {} };
  }
}

async function writeSnapshot(snapshot) {
  await ensureMemoryDirectory();
  const rendered = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(config.chatbotMemoryFile, rendered, 'utf8');
}

function scheduleStateSave(snapshotBuilder) {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const snapshot = snapshotBuilder();
    pendingWrite = pendingWrite
      .then(() => writeSnapshot(snapshot))
      .catch((error) => {
        logger.warn('Failed to persist chatbot state.', error.message);
      });
  }, config.chatbotMemoryFlushMs);
}

async function flushStateSave(snapshotBuilder) {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  const snapshot = snapshotBuilder();
  pendingWrite = pendingWrite
    .then(() => writeSnapshot(snapshot))
    .catch((error) => {
      logger.warn('Failed to flush chatbot state.', error.message);
    });

  await pendingWrite;
}

module.exports = {
  loadChatbotState,
  scheduleStateSave,
  flushStateSave,
};
