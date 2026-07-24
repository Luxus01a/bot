require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Partials,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  generateDependencyReport,
} = require("@discordjs/voice");
const playdl = require("play-dl");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || "!";

if (!TOKEN) {
  console.error(
    "❌ Aucun token trouvé. Crée un fichier .env avec DISCORD_TOKEN=ton_token (voir .env.example)."
  );
  process.exit(1);
}

console.log("===== Rapport de dépendances voix =====");
console.log(generateDependencyReport());
console.log("========================================");

const YT_COOKIE = process.env.YOUTUBE_COOKIE;
if (YT_COOKIE) {
  playdl
    .setToken({ youtube: { cookie: YT_COOKIE } })
    .then(() => console.log("✅ Cookie YouTube chargé (play-dl authentifié)."))
    .catch((err) => console.error("⚠️ Impossible de charger le cookie YouTube :", err.message));
} else {
  console.log(
    "ℹ️ Aucun YOUTUBE_COOKIE défini. Si YouTube bloque avec 'Sign in to confirm you're not a bot', ajoute cette variable (voir README)."
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------------------------------------------------------------------
// État de la file d'attente par serveur
// ---------------------------------------------------------------------

/** @typedef {{title:string,url:string,duration:string,thumbnail:string|null,requesterTag:string}} Song */

class GuildQueue {
  constructor(guildId, textChannel) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.connection = null;
    this.player = createAudioPlayer();
    /** @type {Song[]} */
    this.songs = [];
    this.current = null;
    this.loop = false;
    this.volume = 0.5;

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.loop && this.current) {
        this.playSong(this.current);
        return;
      }
      this.current = null;
      this.playNext();
    });

    this.player.on("error", (error) => {
      console.error(`[ERREUR PLAYER] ${error.message}`);
      this.textChannel?.send(
        `⚠️ Erreur pendant la lecture : ${error.message}`
      );
      this.current = null;
      this.playNext();
    });
  }

  async playNext() {
    if (this.songs.length === 0) {
      return;
    }
    const song = this.songs.shift();
    await this.playSong(song);
  }

  async playSong(song) {
    try {
      const streamInfo = await playdl.stream(song.url);
      const resource = createAudioResource(streamInfo.stream, {
        inputType: streamInfo.type,
        inlineVolume: true,
      });
      resource.volume?.setVolume(this.volume);
      this.current = song;
      this.player.play(resource);

      const embed = new EmbedBuilder()
        .setTitle("🎶 Lecture en cours")
        .setDescription(`[${song.title}](${song.url})`)
        .addFields(
          { name: "Durée", value: song.duration || "?", inline: true },
          { name: "Demandé par", value: song.requesterTag, inline: true }
        )
        .setColor(0x5865f2);
      if (song.thumbnail) embed.setThumbnail(song.thumbnail);

      this.textChannel?.send({ embeds: [embed] });
    } catch (err) {
      console.error(`[ERREUR] Impossible de lire '${song.title}':`, err);
      this.textChannel?.send(
        `⚠️ Impossible de lire \`${song.title}\` : ${err.message}`
      );
      this.current = null;
      this.playNext();
    }
  }

  stop() {
    this.songs = [];
    this.current = null;
    this.loop = false;
    this.player.stop(true);
  }

  destroy() {
    this.stop();
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch (e) {
        // déjà détruit
      }
      this.connection = null;
    }
  }
}

/** @type {Map<string, GuildQueue>} */
const queues = new Map();

function getQueue(guildId, textChannel) {
  let queue = queues.get(guildId);
  if (!queue) {
    queue = new GuildQueue(guildId, textChannel);
    queues.set(guildId, queue);
  } else if (textChannel) {
    queue.textChannel = textChannel;
  }
  return queue;
}

// ---------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function resolveSongs(query, requesterTag) {
  const type = await playdl.validate(query);

  if (type === "yt_video") {
    const info = await playdl.video_basic_info(query);
    const v = info.video_details;
    return [
      {
        title: v.title,
        url: v.url,
        duration: formatDuration(v.durationInSec),
        thumbnail: v.thumbnails?.[0]?.url || null,
        requesterTag,
      },
    ];
  }

  if (type === "yt_playlist") {
    const playlist = await playdl.playlist_info(query, { incomplete: true });
    const videos = await playlist.all_videos();
    return videos.map((v) => ({
      title: v.title,
      url: v.url,
      duration: formatDuration(v.durationInSec),
      thumbnail: v.thumbnails?.[0]?.url || null,
      requesterTag,
    }));
  }

  // Sinon : recherche texte
  const results = await playdl.search(query, {
    limit: 1,
    source: { youtube: "video" },
  });
  if (!results.length) {
    throw new Error("Aucun résultat trouvé.");
  }
  const v = results[0];
  return [
    {
      title: v.title,
      url: v.url,
      duration: formatDuration(v.durationInSec),
      thumbnail: v.thumbnails?.[0]?.url || null,
      requesterTag,
    },
  ];
}

async function ensureVoiceConnection(message, queue) {
  const memberVoiceChannel = message.member?.voice?.channel;
  if (!memberVoiceChannel) {
    throw new Error("Tu dois être dans un salon vocal pour utiliser cette commande.");
  }

  if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
    const connection = joinVoiceChannel({
      channelId: memberVoiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    connection.on("stateChange", (oldState, newState) => {
      console.log(`[VOIX] ${oldState.status} -> ${newState.status}`);
      if (newState.status === "ready" || newState.status === "connecting") {
        console.log(`[VOIX][networking] ${newState.networking?.state?.code ?? "n/a"}`);
      }
    });

    connection.on("debug", (message) => {
      console.log(`[VOIX][debug] ${message}`);
    });

    connection.on("error", (err) => {
      console.error("[ERREUR connexion vocale]", err);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      connection.destroy();
      throw new Error(
        "⏱️ Timeout en rejoignant le vocal. Vérifie que le trafic UDP n'est pas bloqué par ton réseau/pare-feu."
      );
    }

    connection.subscribe(queue.player);
    queue.connection = connection;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        queue.destroy();
        queues.delete(message.guild.id);
      }
    });
  }

  return queue.connection;
}

// ---------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------

const commands = {
  async play(message, args) {
    const query = args.join(" ");
    if (!query) return message.reply("❌ Indique un lien YouTube ou un titre à rechercher.");

    const queue = getQueue(message.guild.id, message.channel);

    try {
      await ensureVoiceConnection(message, queue);
    } catch (err) {
      return message.reply(`❌ ${err.message}`);
    }

    const loadingMsg = await message.reply("🔎 Recherche en cours...");

    let songs;
    try {
      songs = await resolveSongs(query, message.author.tag);
    } catch (err) {
      console.error("[ERREUR resolveSongs]", err);
      return loadingMsg.edit(`❌ Impossible de trouver/charger cette musique : ${err.message}`);
    }

    queue.songs.push(...songs);

    if (!queue.current) {
      await loadingMsg.delete().catch(() => {});
      queue.playNext();
    } else {
      const label =
        songs.length > 1
          ? `➕ **${songs.length}** musiques ajoutées à la file d'attente.`
          : `➕ **${songs[0].title}** ajoutée à la file d'attente (position ${queue.songs.length}).`;
      await loadingMsg.edit(label);
    }
  },

  async skip(message) {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.current) return message.reply("❌ Rien n'est en cours de lecture.");
    queue.loop = false;
    queue.player.stop(true);
    message.reply("⏭️ Musique passée.");
  },

  async pause(message) {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.current) return message.reply("❌ Rien n'est en cours de lecture.");
    queue.player.pause();
    message.reply("⏸️ Pause.");
  },

  async resume(message) {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply("❌ Rien n'est en cours de lecture.");
    queue.player.unpause();
    message.reply("▶️ Reprise de la lecture.");
  },

  async stop(message) {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply("❌ Rien n'est en cours de lecture.");
    queue.stop();
    message.reply("⏹️ Lecture arrêtée et file d'attente vidée.");
  },

  async leave(message) {
    const queue = queues.get(message.guild.id);
    if (queue) {
      queue.destroy();
      queues.delete(message.guild.id);
    }
    message.reply("👋 Déconnecté du salon vocal.");
  },

  async queue(message) {
    const queue = queues.get(message.guild.id);
    if (!queue || (!queue.current && queue.songs.length === 0)) {
      return message.reply("📭 La file d'attente est vide.");
    }

    const embed = new EmbedBuilder().setTitle("📃 File d'attente").setColor(0x5865f2);

    if (queue.current) {
      embed.addFields({
        name: "🎶 En cours",
        value: `[${queue.current.title}](${queue.current.url}) — ${queue.current.duration}`,
      });
    }

    if (queue.songs.length > 0) {
      const lines = queue.songs
        .slice(0, 10)
        .map((s, i) => `**${i + 1}.** [${s.title}](${s.url}) — ${s.duration}`);
      embed.addFields({ name: "À suivre", value: lines.join("\n") });
      if (queue.songs.length > 10) {
        embed.setFooter({ text: `... et ${queue.songs.length - 10} autre(s) musique(s).` });
      }
    }

    message.reply({ embeds: [embed] });
  },

  async nowplaying(message) {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.current) return message.reply("❌ Rien n'est en cours de lecture.");
    const song = queue.current;
    const embed = new EmbedBuilder()
      .setTitle("🎶 En cours de lecture")
      .setDescription(`[${song.title}](${song.url})`)
      .addFields(
        { name: "Durée", value: song.duration, inline: true },
        { name: "Demandé par", value: song.requesterTag, inline: true }
      )
      .setColor(0x5865f2);
    if (song.thumbnail) embed.setThumbnail(song.thumbnail);
    message.reply({ embeds: [embed] });
  },

  async volume(message, args) {
    const vol = parseInt(args[0], 10);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      return message.reply("❌ Le volume doit être un nombre entre 0 et 100.");
    }
    const queue = getQueue(message.guild.id, message.channel);
    queue.volume = vol / 100;
    message.reply(`🔊 Volume réglé à ${vol}%.`);
  },

  async loop(message) {
    const queue = getQueue(message.guild.id, message.channel);
    queue.loop = !queue.loop;
    message.reply(`🔁 Répétition ${queue.loop ? "activée" : "désactivée"}.`);
  },

  async clear(message) {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply("📭 La file d'attente est déjà vide.");
    queue.songs = [];
    message.reply("🗑️ File d'attente vidée.");
  },

  async remove(message, args) {
    const index = parseInt(args[0], 10);
    const queue = queues.get(message.guild.id);
    if (!queue || isNaN(index) || index < 1 || index > queue.songs.length) {
      return message.reply("❌ Numéro invalide.");
    }
    const [removed] = queue.songs.splice(index - 1, 1);
    message.reply(`🗑️ **${removed.title}** retirée de la file d'attente.`);
  },
};

commands.p = commands.play;
commands.s = commands.skip;
commands.next = commands.skip;
commands.unpause = commands.resume;
commands.dc = commands.leave;
commands.disconnect = commands.leave;
commands.q = commands.queue;
commands.np = commands.nowplaying;
commands.vol = commands.volume;

// ---------------------------------------------------------------------
// Événements du client
// ---------------------------------------------------------------------

client.once("clientReady", () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  console.log(`Préfixe des commandes : ${PREFIX}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const commandName = args.shift().toLowerCase();
  const handler = commands[commandName];

  if (!handler) return;

  try {
    await handler(message, args);
  } catch (err) {
    console.error(`[ERREUR commande ${commandName}]`, err);
    message.reply(`❌ Erreur : ${err.message}`);
  }
});

client.login(TOKEN);