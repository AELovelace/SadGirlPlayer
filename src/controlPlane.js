const {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const { config } = require('./config');
const { getRuntimeSettings, updateRuntimeSettings } = require('./chatbot');
const { logger } = require('./logger');

function isAdminUser(interaction) {
  if (!interaction.inGuild()) {
    return false;
  }

  if (config.adminUserIds.includes(interaction.user.id)) {
    return true;
  }

  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || false;
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('lumi-status')
      .setDescription('Show Lumi chatbot runtime settings.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('lumi-toggle')
      .setDescription('Enable or disable Lumi chatbot replies.')
      .addBooleanOption((option) => option
        .setName('enabled')
        .setDescription('Whether autonomous chat is enabled')
        .setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('lumi-set')
      .setDescription('Update Lumi runtime controls.')
      .addNumberOption((option) => option
        .setName('reply_chance')
        .setDescription('Reply chance from 0 to 1')
        .setMinValue(0)
        .setMaxValue(1)
        .setRequired(false))
      .addIntegerOption((option) => option
        .setName('cooldown_ms')
        .setDescription('Minimum milliseconds between autonomous replies per channel')
        .setMinValue(1)
        .setRequired(false))
      .addIntegerOption((option) => option
        .setName('context_messages')
        .setDescription('Sliding memory window length')
        .setMinValue(1)
        .setRequired(false))
      .addIntegerOption((option) => option
        .setName('max_response_chars')
        .setDescription('Maximum response length')
        .setMinValue(1)
        .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('lumi-channel')
      .setDescription('Manage Lumi channel whitelist.')
      .addStringOption((option) => option
        .setName('action')
        .setDescription('Add, remove, or list channel whitelist entries')
        .addChoices(
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' },
          { name: 'list', value: 'list' },
        )
        .setRequired(true))
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('Channel to add/remove')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((command) => command.toJSON());
}

function formatSettings(settings) {
  return [
    `enabled=${settings.enabled}`,
    `replyChance=${settings.replyChance}`,
    `cooldownMs=${settings.cooldownMs}`,
    `contextMessages=${settings.contextMessages}`,
    `maxResponseChars=${settings.maxResponseChars}`,
    `channels=${settings.channelIds.length > 0 ? settings.channelIds.join(', ') : 'none'}`,
  ].join('\n');
}

async function registerControlPlane(client) {
  if (!config.controlPlaneEnabled) {
    logger.info('Slash control plane disabled via config.');
    return;
  }

  try {
    const commands = buildCommands();
    if (config.slashGuildId) {
      const guild = await client.guilds.fetch(config.slashGuildId);
      await guild.commands.set(commands);
      logger.info(`Registered ${commands.length} slash commands for guild ${config.slashGuildId}.`);
      return;
    }

    await client.application.commands.set(commands);
    logger.info(`Registered ${commands.length} global slash commands.`);
  } catch (error) {
    logger.error('Failed to register slash control plane commands.', error.message);
  }
}

async function handleControlPlaneInteraction(interaction) {
  if (!config.controlPlaneEnabled) {
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!interaction.commandName.startsWith('lumi-')) {
    return;
  }

  if (!isAdminUser(interaction)) {
    await interaction.reply({
      content: 'You need Manage Server permission (or ADMIN_USER_IDS override) to use Lumi control commands.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'lumi-status') {
    await interaction.reply({
      content: `Lumi runtime settings:\n${formatSettings(getRuntimeSettings())}`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'lumi-toggle') {
    const enabled = interaction.options.getBoolean('enabled', true);
    const settings = updateRuntimeSettings({ enabled });
    await interaction.reply({
      content: `Lumi is now ${settings.enabled ? 'enabled' : 'disabled'}.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'lumi-set') {
    const patch = {};
    const replyChance = interaction.options.getNumber('reply_chance', false);
    const cooldownMs = interaction.options.getInteger('cooldown_ms', false);
    const contextMessages = interaction.options.getInteger('context_messages', false);
    const maxResponseChars = interaction.options.getInteger('max_response_chars', false);

    if (replyChance !== null) {
      patch.replyChance = replyChance;
    }
    if (cooldownMs !== null) {
      patch.cooldownMs = cooldownMs;
    }
    if (contextMessages !== null) {
      patch.contextMessages = contextMessages;
    }
    if (maxResponseChars !== null) {
      patch.maxResponseChars = maxResponseChars;
    }

    const settings = updateRuntimeSettings(patch);
    await interaction.reply({
      content: `Updated Lumi settings:\n${formatSettings(settings)}`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'lumi-channel') {
    const action = interaction.options.getString('action', true);
    const channel = interaction.options.getChannel('channel', false);
    const current = getRuntimeSettings();

    if (action === 'list') {
      await interaction.reply({
        content: `Whitelisted channels: ${current.channelIds.length > 0 ? current.channelIds.join(', ') : 'none'}`,
        ephemeral: true,
      });
      return;
    }

    if (!channel) {
      await interaction.reply({
        content: 'You must provide a channel for add/remove actions.',
        ephemeral: true,
      });
      return;
    }

    const next = new Set(current.channelIds);
    if (action === 'add') {
      next.add(channel.id);
    } else if (action === 'remove') {
      next.delete(channel.id);
    }

    const settings = updateRuntimeSettings({ channelIds: Array.from(next) });
    await interaction.reply({
      content: `Updated channel whitelist: ${settings.channelIds.length > 0 ? settings.channelIds.join(', ') : 'none'}`,
      ephemeral: true,
    });
  }
}

module.exports = {
  handleControlPlaneInteraction,
  registerControlPlane,
};
