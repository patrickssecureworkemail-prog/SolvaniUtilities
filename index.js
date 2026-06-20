require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');
const { Pool } = require('pg');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  TICKET_SUPPORT_ROLE: process.env.TICKET_SUPPORT_ROLE,
  HR_SUPPORT_ROLE: process.env.HR_SUPPORT_ROLE,
  COMMS_SUPPORT_ROLE: process.env.COMMS_SUPPORT_ROLE,
  SUPPORT_ADMIN_ROLE: process.env.SUPPORT_ADMIN_ROLE,
  SUPPORT_CATEGORY: process.env.SUPPORT_CATEGORY,
  TRANSCRIPT_CHANNEL: process.env.TRANSCRIPT_CHANNEL,
  COLOR: 0xF4C542,
};

// ─── LEVELING CONFIG ─────────────────────────────────────────────────────────
const LEVEL_CONFIG = {
  LEVELS_CHANNEL: process.env.LEVELS_CHANNEL,
  ADD_MESSAGES_ROLE: process.env.ADD_MESSAGES_ROLE,
  COOLDOWN_MS: 3000,
};

// Tiers in ascending order — threshold = messages needed to REACH this tier
const TIERS = [
  {
    key: 'newbie',
    roleId: process.env.ROLE_NEWBIE,
    threshold: 0,
    title: '🌱 Level Up — Newbie In The House',
    message: (mention) => `Congrats ${mention} on **Newbie**! You're getting there!`,
  },
  {
    key: 'regular',
    roleId: process.env.ROLE_REGULAR,
    threshold: 51,
    title: '🌿 Level Up — Regular In The House',
    message: (mention) => `Congrats ${mention} on **Regular**! Welcome to the club!`,
  },
  {
    key: 'experienced_regular',
    roleId: process.env.ROLE_EXPERIENCED_REGULAR,
    threshold: 201,
    title: '🌺 Level Up — Experienced Regular In The House',
    message: (mention) => `Congrats ${mention} on **Experienced Regular**! Thanks for the activity!`,
  },
  {
    key: 'solvani_veteran',
    roleId: process.env.ROLE_SOLVANI_VETERAN,
    threshold: 501,
    title: '🏆 Level Up — Solvani Veteran In The House',
    message: (mention) => `Congrats ${mention} on **Solvani Veteran**! Thank you for service yapping.`,
  },
  {
    key: 'solvani_legend',
    roleId: process.env.ROLE_SOLVANI_LEGEND,
    threshold: 1001,
    title: '👑 Level Up',
    message: (mention) => `Congrats ${mention} on **Solvani Legend**! Someone likes to talk… 👀`,
  },
];

function getTierForCount(count) {
  let result = TIERS[0];
  for (const tier of TIERS) {
    if (count >= tier.threshold) result = tier;
  }
  return result;
}

function getTierIndex(key) {
  return TIERS.findIndex(t => t.key === key);
}

// ─── DATABASE (Postgres) ─────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_messages (
      user_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL DEFAULT 0,
      current_tier TEXT NOT NULL DEFAULT 'newbie'
    );
  `);
  console.log('✅ Database ready.');
}

async function getUserData(userId) {
  const res = await db.query('SELECT * FROM user_messages WHERE user_id = $1', [userId]);
  if (res.rows.length === 0) {
    await db.query('INSERT INTO user_messages (user_id) VALUES ($1)', [userId]);
    return { user_id: userId, message_count: 0, current_tier: 'newbie' };
  }
  return res.rows[0];
}

async function incrementMessageCount(userId, amount = 1) {
  const res = await db.query(
    `INSERT INTO user_messages (user_id, message_count, current_tier)
     VALUES ($1, $2, 'newbie')
     ON CONFLICT (user_id) DO UPDATE SET message_count = user_messages.message_count + $2
     RETURNING *`,
    [userId, amount]
  );
  return res.rows[0];
}

async function setUserTier(userId, tierKey) {
  await db.query('UPDATE user_messages SET current_tier = $1 WHERE user_id = $2', [tierKey, userId]);
}

// Per-user cooldown tracker (in-memory, resets on restart — fine since it's just a spam guard)
const messageCooldowns = new Map();

// Handles role swap + announcement when a user crosses into a new tier
async function checkAndApplyTierUp(member, userData) {
  const newTier = getTierForCount(userData.message_count);
  const oldTierIndex = getTierIndex(userData.current_tier);
  const newTierIndex = getTierIndex(newTier.key);

  if (newTierIndex <= oldTierIndex) return; // no tier change

  // Remove old tier role (if any), add new tier role
  const oldTier = TIERS[oldTierIndex];
  if (oldTier?.roleId && member.roles.cache.has(oldTier.roleId)) {
    await member.roles.remove(oldTier.roleId).catch(() => {});
  }
  if (newTier.roleId) {
    await member.roles.add(newTier.roleId).catch(() => {});
  }

  await setUserTier(member.id, newTier.key);

  // Announce in #levels
  const levelsChannel = member.guild.channels.cache.get(LEVEL_CONFIG.LEVELS_CHANNEL)
    ?? await member.client.channels.fetch(LEVEL_CONFIG.LEVELS_CHANNEL).catch(() => null);

  if (levelsChannel) {
    const embed = new EmbedBuilder()
      .setColor(0xF4C542)
      .setTitle(newTier.title)
      .setDescription(newTier.message(`<@${member.id}>`))
      .setTimestamp();
    await levelsChannel.send({ content: `<@${member.id}>`, embeds: [embed] }).catch(() => {});
  }
}

// Silently reassigns a user's earned tier role on rejoin (no announcement)
async function reassignTierOnRejoin(member) {
  const userData = await getUserData(member.id);
  const tier = getTierForCount(userData.message_count);
  if (tier.roleId && !member.roles.cache.has(tier.roleId)) {
    await member.roles.add(tier.roleId).catch(() => {});
  }
  if (userData.current_tier !== tier.key) {
    await setUserTier(member.id, tier.key);
  }
}

// ─── TICKET TYPES ─────────────────────────────────────────────────────────────
const TICKET_TYPES = {
  general: {
    label: 'General Support',
    ping: () => `<@&${CONFIG.TICKET_SUPPORT_ROLE}>`,
    color: 0xF4C542,
    description: '*🌺 Aloha!*\nWelcome to **Solvani Support.**\nYou\'ve reached our General Support team. A support representative will be with you shortly.\n*Thank you for your patience!*',
  },
  report: {
    label: 'Report',
    ping: () => `<@&${CONFIG.HR_SUPPORT_ROLE}>`,
    color: 0xE74C3C,
    description: '*🌺 Aloha!*\nWelcome to **Solvani HR.**\nYou\'ve reached our HR Department. An HR representative will be with you shortly.\n*Thank you for your patience!*',
  },
  communications: {
    label: 'Communications',
    ping: () => `<@&${CONFIG.COMMS_SUPPORT_ROLE}> <@&${CONFIG.TICKET_SUPPORT_ROLE}>`,
    color: 0x3498DB,
    description: '*🌺 Aloha!*\nWelcome to **Solvani Communications.**\nYou\'ve reached our Communications Team. A communications representative will be with you shortly.\n*Thank you for your patience!*',
  },
};

// ─── TICKET STATUS EMOJIS ───────────────────────────────────────────────────
const STATUS_EMOJI = {
  open: '🟢',
  claimed: '🟡',
  priority: '🔴',
  inactive: '🟣',
  needs_admin: '⚫',
  hold: '⚪',
};

// Strips any existing status emoji prefix off a channel name
function stripStatusPrefix(name) {
  const emojis = Object.values(STATUS_EMOJI);
  for (const e of emojis) {
    if (name.startsWith(e + '-')) return name.slice(e.length + 1);
  }
  return name;
}

async function setTicketStatus(channel, statusKey) {
  const emoji = STATUS_EMOJI[statusKey];
  if (!emoji) return;
  const ticket = activeTickets.get(channel.id);
  if (ticket) ticket.status = statusKey;
  const baseName = stripStatusPrefix(channel.name);
  const newName = `${emoji}-${baseName}`;
  if (channel.name !== newName) {
    await channel.setName(newName).catch(() => {});
  }
}
const TAGS = {
  greet:    (name) => `*🌺 Aloha!*\n\nHello, my name is **${name}**. I will be assisting you today.`,
  escalate: ()     => `*⬆️ Escalation Notice*\n\nWe are calling in a higher rank to assist with your ticket. Please hold tight while we get someone to help you.`,
  warning:  ()     => `*⚠️ Reminder*\n\nPlease remember to abide by server rules within this ticket, or it will be closed.`,
  hold:     ()     => `*⏳ On Hold*\n\nWe appreciate your patience! This ticket is currently on hold. We\'ll be right with you.`,
  resolve:  ()     => `*✅ Check-In*\n\nIt looks like your issue may have been resolved! Let us know if there\'s anything else we can help with.`,
  missing:  ()     => `*📎 Information Needed*\n\nWe\'re still waiting on some information from you. Please provide the requested details so we can continue.`,
  thanks:   ()     => `*🌺 Thank You*\n\nThank you for reaching out to Solvani support. We\'re happy to help!`,
  follow:   ()     => `*🔔 Follow Up*\n\nJust following up — are you still in need of assistance with this ticket?`,
};

// ─── ACTIVE TICKETS ───────────────────────────────────────────────────────────
const activeTickets = new Map();

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Post the Solvani support panel in this channel'),
  new SlashCommandBuilder().setName('close').setDescription('Close this support ticket'),
  new SlashCommandBuilder().setName('closerequest').setDescription('Request to close this ticket'),
  new SlashCommandBuilder().setName('claim').setDescription('Claim this support ticket'),
  new SlashCommandBuilder().setName('priority').setDescription('Toggle priority/urgent status on this ticket'),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user to this ticket')
    .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a user from this ticket')
    .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Send a pre-written support message')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Tag name').setRequired(true)
        .addChoices(
          { name: 'greet', value: 'greet' },
          { name: 'escalate', value: 'escalate' },
          { name: 'warning', value: 'warning' },
          { name: 'hold', value: 'hold' },
          { name: 'resolve', value: 'resolve' },
          { name: 'missing', value: 'missing' },
          { name: 'thanks', value: 'thanks' },
          { name: 'follow', value: 'follow' },
        )),
  new SlashCommandBuilder()
    .setName('checkmessages')
    .setDescription('Check a user\'s message count and rank')
    .addUserOption(opt => opt.setName('user').setDescription('User to check (defaults to you)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('addmessages')
    .setDescription('Manually add to a user\'s message count (restricted)')
    .addUserOption(opt => opt.setName('user').setDescription('User to update').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of messages to add').setRequired(true)),
].map(cmd => cmd.toJSON());

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Solvani Utilities is online as ${client.user.tag}`);
  try {
    await initDb();
  } catch (err) {
    console.error('❌ Failed to initialize database:', err);
  }
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered globally.');
  } catch (err) {
    console.error('❌ Failed to register global commands:', err);
  }

  // Also register per-guild for instant updates (bypasses global propagation delay)
  try {
    const guilds = await client.guilds.fetch();
    for (const [guildId] of guilds) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    }
    console.log(`✅ Slash commands registered instantly to ${guilds.size} guild(s).`);
  } catch (err) {
    console.error('❌ Failed to register guild commands:', err);
  }
});

// ─── MESSAGE LEVELING ─────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const now = Date.now();
    const last = messageCooldowns.get(message.author.id) ?? 0;
    if (now - last < LEVEL_CONFIG.COOLDOWN_MS) return;
    messageCooldowns.set(message.author.id, now);

    const userData = await incrementMessageCount(message.author.id, 1);
    await checkAndApplyTierUp(message.member, userData);
  } catch (err) {
    console.error('❌ messageCreate leveling error:', err);
  }
});

// ─── REJOIN ROLE REASSIGNMENT ─────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  try {
    await reassignTierOnRejoin(member);
  } catch (err) {
    console.error('❌ guildMemberAdd reassignment error:', err);
  }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isTicketChannel(channel) { return activeTickets.has(channel.id); }
function hasAdminRole(member) { return member.roles.cache.has(CONFIG.SUPPORT_ADMIN_ROLE); }
function hasSupportRole(member) {
  return (
    member.roles.cache.has(CONFIG.TICKET_SUPPORT_ROLE) ||
    member.roles.cache.has(CONFIG.HR_SUPPORT_ROLE) ||
    member.roles.cache.has(CONFIG.COMMS_SUPPORT_ROLE) ||
    hasAdminRole(member)
  );
}

async function closeTicket(channel, closedBy, guild) {
  const ticket = activeTickets.get(channel.id);
  if (!ticket) return;

  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].reverse();
  const transcript = sorted
    .map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content}`)
    .join('\n');

  const transcriptChannel = guild.channels.cache.get(CONFIG.TRANSCRIPT_CHANNEL);
  if (transcriptChannel) {
    const logEmbed = new EmbedBuilder()
      .setTitle('📋 Ticket Closed')
      .setColor(CONFIG.COLOR)
      .addFields(
        { name: '🎫 Ticket', value: channel.name, inline: true },
        { name: '📂 Type', value: ticket.type, inline: true },
        { name: '👤 Opened By', value: `<@${ticket.userId}>`, inline: true },
        { name: '🔒 Closed By', value: `<@${closedBy.id}>`, inline: true },
        { name: '🙋 Claimed By', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Unclaimed', inline: true },
        { name: '🕐 Opened At', value: `<t:${Math.floor(ticket.openedAt / 1000)}:F>`, inline: true },
      )
      .setTimestamp();

    await transcriptChannel.send({ embeds: [logEmbed] });
    const buffer = Buffer.from(transcript, 'utf-8');
    await transcriptChannel.send({
      content: `📄 **Transcript for** \`${channel.name}\``,
      files: [{ attachment: buffer, name: `${channel.name}-transcript.txt` }],
    });
  }

  try {
    const user = await guild.members.fetch(ticket.userId);
    const dmEmbed = new EmbedBuilder()
      .setTitle('🌺 Ticket Closed — Solvani Support')
      .setColor(CONFIG.COLOR)
      .setDescription(`Your ticket **${channel.name}** has been closed.\n\nIf you need further assistance, feel free to open a new ticket. *Thank you for reaching out to Solvani!*`)
      .setTimestamp();
    await user.send({ embeds: [dmEmbed] }).catch(() => {});
  } catch {}

  activeTickets.delete(channel.id);
  await channel.delete().catch(() => {});
}

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
 try {

  // /setup
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels))
      return interaction.reply({ content: '❌ You need Manage Channels permission.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('🌺 Solvani Support')
      .setColor(CONFIG.COLOR)
      .setDescription(
        '*🌺 Aloha!*\n' +
        '**Our team** is here to assist you with **any** questions or concerns!\n' +
        'Please select the **type of support** you need below.\n\n' +
        '❓ **General Support:** Questions, support, and general assistance.\n' +
        '📋 **Report:** Report a player, staff member, or rule violation.\n' +
        '🎉 **Communications:** Partnerships, Events, and Social Media questions.\n\n' +
        '**Thank you** for making our **community** better. 🌺'
      )
      .setFooter({ text: 'Solvani Utilities • Support System' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_ticket').setLabel('📩 Open a Ticket').setStyle(ButtonStyle.Primary)
    );

    const setupChannel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    if (!setupChannel) {
      return interaction.reply({ content: '❌ I could not access this channel. Please check my permissions (View Channel, Send Messages) here.', ephemeral: true });
    }
    await setupChannel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Support panel posted!', ephemeral: true });
  }

  // Open ticket button
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('select_ticket_type')
        .setPlaceholder('Select support type...')
        .addOptions([
          { label: 'General Support', value: 'general', emoji: '🌿' },
          { label: 'Report', value: 'report', emoji: '📋' },
          { label: 'Communications', value: 'communications', emoji: '📡' },
        ])
    );
    await interaction.reply({ content: '🌺 *Aloha!* Please select the type of support you need:', components: [row], ephemeral: true });
  }

  // Select ticket type
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_ticket_type') {
    const type = interaction.values[0];
    const ticketType = TICKET_TYPES[type];

    const guild = interaction.guild ?? await interaction.client.guilds.fetch(interaction.guildId).catch(() => null);
    const member = interaction.member ?? (guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null);

    if (!guild || !member) {
      return interaction.reply({ content: '❌ Something went wrong reading your account info. Please try again.', ephemeral: true });
    }

    for (const [, t] of activeTickets) {
      if (t.userId === member.id)
        return interaction.reply({ content: '❌ You already have an open ticket!', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const channelName = `${STATUS_EMOJI.open}-${member.user.username}-${type}`.toLowerCase().replace(/[^a-z0-9-🟢]/g, '-');

    const permOverwrites = [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: CONFIG.TICKET_SUPPORT_ROLE, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: CONFIG.SUPPORT_ADMIN_ROLE, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    ];
    if (type === 'report') permOverwrites.push({ id: CONFIG.HR_SUPPORT_ROLE, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
    if (type === 'communications') permOverwrites.push({ id: CONFIG.COMMS_SUPPORT_ROLE, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });

    const channel = await guild.channels.create({
      name: channelName,
      parent: CONFIG.SUPPORT_CATEGORY,
      permissionOverwrites: permOverwrites,
    });

    activeTickets.set(channel.id, { userId: member.id, type: ticketType.label, claimedBy: null, openedAt: Date.now(), status: 'open' });

    const openEmbed = new EmbedBuilder()
      .setColor(ticketType.color)
      .setDescription(ticketType.description)
      .addFields(
        { name: '👤 Opened By', value: `<@${member.id}>`, inline: true },
        { name: '🎫 Ticket Type', value: ticketType.label, inline: true },
        { name: '📅 Date Opened', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      )
      .setFooter({ text: 'Solvani Utilities • Support System' })
      .setTimestamp();

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('claim_ticket').setLabel('✋ Claim Ticket').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger),
    );

    const openMsg = await channel.send({
      content: `${ticketType.ping()} <@${member.id}>`,
      embeds: [openEmbed],
      components: [claimRow],
    });

    await openMsg.pin().catch(() => {});
    await interaction.editReply({ content: `✅ Your ticket has been opened! ${channel}` });
  }

  // Claim button
  if (interaction.isButton() && interaction.customId === 'claim_ticket') {
    const ticketChannel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (!ticketChannel) return interaction.reply({ content: '❌ Could not access this channel.', ephemeral: true });
    const ticket = activeTickets.get(ticketChannel.id);
    if (!ticket) return interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
    if (!hasSupportRole(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });

    ticket.claimedBy = interaction.member.id;
    await setTicketStatus(ticketChannel, 'claimed');
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(CONFIG.COLOR).setDescription(`✋ This ticket has been claimed by **${interaction.member.displayName}**.`).setTimestamp()]
    });
  }

  // Close button
  if (interaction.isButton() && interaction.customId === 'close_ticket_btn') {
    if (!hasSupportRole(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    await interaction.reply({ content: '🔒 Closing ticket...', ephemeral: true });
    await closeTicket(interaction.channel, interaction.member, interaction.guild);
  }

  // Close request yes/no
  if (interaction.isButton() && interaction.customId === 'closerequest_yes') {
    await interaction.reply({ content: '✅ Closing your ticket now. Thank you for reaching out!' });
    await closeTicket(interaction.channel, interaction.member, interaction.guild);
  }
  if (interaction.isButton() && interaction.customId === 'closerequest_no') {
    await interaction.reply({ content: '👍 No problem! We\'ll continue assisting you. Please let us know how we can help.' });
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, member, channel, guild } = interaction;

  // /close
  if (commandName === 'close') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    await interaction.reply({ content: '🔒 Closing ticket...', ephemeral: true });
    await closeTicket(channel, member, guild);
  }

  // /closerequest
  if (commandName === 'closerequest') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor(CONFIG.COLOR)
      .setTitle('🔒 Close Request')
      .setDescription('A support member has requested to close this ticket.\n\n*Is there anything else we can assist you with before we close?*')
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('closerequest_yes').setLabel('No, you can close it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('closerequest_no').setLabel('Yes, I need more help').setStyle(ButtonStyle.Success),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  // /claim
  if (commandName === 'claim') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    const ticket = activeTickets.get(channel.id);
    ticket.claimedBy = member.id;
    await setTicketStatus(channel, 'claimed');
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(CONFIG.COLOR).setDescription(`✋ This ticket has been claimed by **${member.displayName}**.`).setTimestamp()]
    });
  }

  // /priority
  if (commandName === 'priority') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    const ticket = activeTickets.get(channel.id);
    const isPriority = ticket.status === 'priority';
    await setTicketStatus(channel, isPriority ? (ticket.claimedBy ? 'claimed' : 'open') : 'priority');
    const embed = new EmbedBuilder()
      .setColor(isPriority ? CONFIG.COLOR : 0xE74C3C)
      .setDescription(isPriority
        ? `🟢 Priority removed by **${member.displayName}**.`
        : `🔴 **This ticket has been marked as priority/urgent** by **${member.displayName}**.`)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  // /add
  if (commandName === 'add') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    const user = interaction.options.getMember('user');
    await channel.permissionOverwrites.create(user, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await interaction.reply({ content: `✅ **${user.displayName}** has been added to this ticket.` });
  }

  // /remove
  if (commandName === 'remove') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    const user = interaction.options.getMember('user');
    await channel.permissionOverwrites.delete(user);
    await interaction.reply({ content: `✅ **${user.displayName}** has been removed from this ticket.` });
  }

  // /tag
  if (commandName === 'tag') {
    if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ This command can only be used in a ticket.', ephemeral: true });
    if (!hasSupportRole(member)) return interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
    const tagName = interaction.options.getString('name');
    const tagFn = TAGS[tagName];
    if (!tagFn) return interaction.reply({ content: '❌ Unknown tag.', ephemeral: true });
    const embed = new EmbedBuilder()
      .setColor(CONFIG.COLOR)
      .setDescription(tagFn(member.displayName))
      .setFooter({ text: `${member.displayName} • Solvani Support` })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  // /checkmessages
  if (commandName === 'checkmessages') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const userData = await getUserData(target.id);
    const tier = getTierForCount(userData.message_count);
    const nextTier = TIERS[getTierIndex(tier.key) + 1];

    const embed = new EmbedBuilder()
      .setColor(0xF4C542)
      .setTitle(`📊 ${target.username}'s Stats`)
      .addFields(
        { name: '💬 Messages', value: `${userData.message_count}`, inline: true },
        { name: '🏅 Current Tier', value: tier.title.replace(/^.*— /, '').replace(' In The House', ''), inline: true },
        { name: '⬆️ Next Tier', value: nextTier ? `${nextTier.threshold - userData.message_count} messages until **${nextTier.title.replace(/^.*— /, '').replace(' In The House', '')}**` : '🎉 Max tier reached!', inline: false },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  // /addmessages
  if (commandName === 'addmessages') {
    if (!member.roles.cache.has(LEVEL_CONFIG.ADD_MESSAGES_ROLE) && !hasAdminRole(member)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const targetMember = await guild.members.fetch(target.id).catch(() => null);

    const userData = await incrementMessageCount(target.id, amount);
    if (targetMember) await checkAndApplyTierUp(targetMember, userData);

    await interaction.reply({ content: `✅ Added **${amount}** messages to **${target.username}**. New total: **${userData.message_count}**.` });
  }

 } catch (err) {
  console.error('❌ Interaction error:', err);
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Something went wrong processing that. Please try again or contact an admin.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Something went wrong processing that. Please try again or contact an admin.', ephemeral: true }).catch(() => {});
    }
  } catch {}
 }
});

client.login(process.env.TOKEN);