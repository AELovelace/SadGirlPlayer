const { config } = require('./config');

function countMentions(text) {
  const matches = text.match(/<@!?\d+>|@everyone|@here/gu);
  return matches ? matches.length : 0;
}

function containsInviteLink(text) {
  return /(discord\.gg|discord\.com\/invite)\//iu.test(text);
}

function buildBlocklistRegex() {
  if (!Array.isArray(config.moderationBlocklist) || config.moderationBlocklist.length === 0) {
    return null;
  }

  const escaped = config.moderationBlocklist
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));

  if (escaped.length === 0) {
    return null;
  }

  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'iu');
}

const blocklistRegex = buildBlocklistRegex();

function evaluateIncomingMessage(text) {
  if (!config.moderationEnabled) {
    return { allowed: true, reason: 'disabled' };
  }

  const normalized = String(text || '').trim();
  if (!normalized) {
    return { allowed: false, reason: 'empty' };
  }

  if (normalized.length > config.moderationMaxInputChars) {
    return { allowed: false, reason: 'too-long' };
  }

  if (blocklistRegex && blocklistRegex.test(normalized)) {
    return { allowed: false, reason: 'blocklist' };
  }

  if (config.moderationBlockInviteLinks && containsInviteLink(normalized)) {
    return { allowed: false, reason: 'invite-link' };
  }

  return { allowed: true, reason: 'ok' };
}

function evaluateOutgoingMessage(text) {
  if (!config.moderationEnabled) {
    return { allowed: true, reason: 'disabled', text: String(text || '').trim() };
  }

  let normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return { allowed: false, reason: 'empty', text: '' };
  }

  if (normalized.length > config.moderationMaxOutputChars) {
    normalized = `${normalized.slice(0, Math.max(1, config.moderationMaxOutputChars - 3)).trim()}...`;
  }

  if (countMentions(normalized) > config.moderationMaxMentions) {
    return { allowed: false, reason: 'too-many-mentions', text: '' };
  }

  if (blocklistRegex && blocklistRegex.test(normalized)) {
    return { allowed: false, reason: 'blocklist', text: '' };
  }

  return { allowed: true, reason: 'ok', text: normalized };
}

module.exports = {
  evaluateIncomingMessage,
  evaluateOutgoingMessage,
};
