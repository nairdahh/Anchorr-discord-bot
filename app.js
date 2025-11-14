import "dotenv/config";
import { getConfig, setConfig, prepareDatabase } from "./db.js";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import express from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as DiscordStrategy } from "passport-discord";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import bodyParser from "body-parser";

// --- INITIAL SETUP ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
prepareDatabase();

// --- ENV VARIABLES ---
const {
  DISCORD_TOKEN,
  BOT_ID,
  DISCORD_CLIENT_SECRET,
  PUBLIC_BOT_URL,
  SESSION_SECRET,
  WEBHOOK_PORT,
  TMDB_API_KEY,
  OMDB_API_KEY,
} = process.env;

// --- DISCORD BOT CLIENT ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- EXPRESS WEB SERVER ---
const app = express();
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "web")));

app.use(
  session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false })
);
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(
  new DiscordStrategy(
    {
      clientID: BOT_ID,
      clientSecret: DISCORD_CLIENT_SECRET,
      callbackURL: `${PUBLIC_BOT_URL}/auth/callback`,
      scope: ["identify", "guilds"],
      passReqToCallback: true,
    },
    (req, accessToken, refreshToken, profile, done) => {      
      return done(null, profile);
    }
  )
);
function ensureAuthenticated(req, res, next) {
  // Redirect to login page if not authenticated
  if (req.isAuthenticated()) return next();
  res.redirect("/discord-bot.html");
}
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "web", "index.html"))
);
app.get("/discord-bot", (req, res) =>
  res.sendFile(path.join(__dirname, "web", "discord-bot.html"))
);

// Generic login route
app.get("/login", passport.authenticate("discord"));

// Specific login route from Discord /setup command
app.get("/auth/discord", (req, res, next) => {
  const guildId = req.query.guild_id;
  if (!guildId)
    return res.status(400).send("Error: Missing guild_id parameter.");

  // Check if the bot is actually in the guild before attempting to auth for it.
  if (!client.guilds.cache.has(guildId)) {
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${BOT_ID}&permissions=3264&scope=bot%20applications.commands&guild_id=${guildId}`;
    // Redirect the user to invite the bot to that specific server.
    return res.redirect(inviteUrl);
  }

  // Store guildId in session to redirect after login
  req.session.guildId = guildId;
  passport.authenticate("discord")(req, res, next);
});

app.get(
  "/auth/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => {
    // If we have a specific guildId from the /setup command, pass it along
    if (req.session.guildId) {
      const guildId = req.session.guildId;
      req.session.guildId_to_redirect = guildId; // Store it temporarily
      delete req.session.guildId;
      req.session.save(() => {
        res.redirect(`/dashboard.html?guild_id=${req.session.guildId_to_redirect}`);
      });
    } else {
      // Otherwise, just go to the generic dashboard
      req.session.save(() => {
        res.redirect("/dashboard.html");
      });
    }
  }
);

app.get("/logout", (req, res) => {
  req.logout(() => {
    res.redirect("/discord-bot.html");
  });
});

app.get("/dashboard.html", ensureAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, "web", "dashboard.html"))
);

app.get("/api/config", ensureAuthenticated, (req, res) => {
  const { guild_id: guildId } = req.query;
  if (!guildId)
    return res.status(400).json({ error: "Guild ID is missing from request." });
  const guild = req.user.guilds.find((g) => g.id === guildId);
  if (
    !guild ||
    !new PermissionsBitField(BigInt(guild.permissions)).has("Administrator")
  ) {
    return res
      .status(403)
      .json({ error: "You are not an administrator of this server." });
  }
  const config = getConfig(guildId) || {};
  res.json({ guildName: guild.name, config });
});
app.post("/api/config", ensureAuthenticated, (req, res) => {
  const { guild_id: guildId } = req.body;
  if (!guildId)
    return res.status(400).json({ error: "Guild ID not found in submission." });
  const guild = req.user.guilds.find((g) => g.id === guildId);
  if (
    !guild ||
    !new PermissionsBitField(BigInt(guild.permissions)).has("Administrator")
  )
    return res.status(403).json({ error: "Forbidden" });
  const newConfig = {
    guild_id: guildId,
    jellyseer_url: req.body.jellyseer_url,
    jellyseer_api_key: req.body.jellyseer_api_key,
    notification_channel_id: req.body.notification_channel_id,
    jellyfin_server_url: req.body.jellyfin_server_url,
    color_search: req.body.color_search,
    color_success: req.body.color_success,
    color_notification: req.body.color_notification,
    ephemeral_responses: req.body.ephemeral_responses ? 1 : 0,
  };
  setConfig(newConfig);
  res.json({ success: true, message: "Configuration saved!" });
});

// API endpoint to get session info and manageable guilds
app.get("/api/session", ensureAuthenticated, (req, res) => {
  const manageableGuilds = req.user.guilds.filter(g => 
    new PermissionsBitField(BigInt(g.permissions)).has("Administrator")
  ).map(g => ({
    id: g.id,
    name: g.name,
    icon_url: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png',
    bot_in_server: client.guilds.cache.has(g.id)
  }));

  res.json({
    user: req.user,
    guilds: manageableGuilds,
    bot_id: BOT_ID
  });
});

// API endpoint to test service connections
app.post("/api/test-connection", ensureAuthenticated, async (req, res) => {
  const { type, url, apiKey } = req.body;

  if (!url) {
    return res.status(400).json({ message: "URL is required." });
  }

  try {
    if (type === 'jellyseerr') {
      if (!apiKey) {
        return res.status(400).json({ message: "API Key is required for Jellyseerr." });
      }
      // Test Jellyseerr by fetching its status
      const authTestUrl = new URL('/api/v1/settings/main', url).href;
      await axios.get(authTestUrl, {
        headers: { "X-Api-Key": apiKey },
        timeout: 5000,
      });

      // If the auth test passes, get the public status to find the version
      const statusUrl = new URL('/api/v1/status', url).href;
      const statusResponse = await axios.get(statusUrl, { timeout: 5000 });
      const version = statusResponse.data?.version;

      const message = version ? `Successfully connected to Jellyseerr v${version}!` : "Successfully connected to Jellyseerr!";
      return res.json({ message });

      throw new Error("Invalid response from Jellyseerr.");
    } else if (type === 'jellyfin') {
      // Test Jellyfin by fetching its system info
      const response = await axios.get(`${url.replace(/\/$/, "")}/System/Info/Public`, { timeout: 5000 });
      const version = response.data?.Version;
      if (version) {
        return res.json({ message: `Connected to Jellyfin v${version}` });
      }
      throw new Error("Invalid response from Jellyfin.");
    }
    return res.status(400).json({ message: "Invalid connection type." });
  } catch (error) {
    const errorMessage = error.response?.data?.message || error.message || "Could not connect. Check URL and CORS settings.";
    return res.status(500).json({ message: errorMessage });
  }
});

// --- BOT HELPER FUNCTIONS ---
const tmdbSearch = async (query) => {
  const { data } = await axios.get(
    "https://api.themoviedb.org/3/search/multi",
    { params: { api_key: TMDB_API_KEY, query, include_adult: false } }
  );
  return data.results || [];
};
const tmdbGetDetails = async (id, mediaType) => {
  const { data } = await axios.get(
    `https://api.themoviedb.org/3/${mediaType}/${id}`,
    {
      params: {
        api_key: TMDB_API_KEY,
        append_to_response: "external_ids,images",
      },
    }
  );
  return data;
};
const sendRequestToJellyseerr = async (tmdbId, mediaType, config) => {
  const payload = { mediaId: parseInt(tmdbId, 10), mediaType };
  if (mediaType === "tv") payload.seasons = "all";
  await axios.post(
    `${config.jellyseer_url.replace(/\/$/, "")}/request`,
    payload,
    { headers: { "X-Api-Key": config.jellyseer_api_key } }
  );
};
const fetchOMDbData = async (imdbId) => {
  if (!imdbId || !OMDB_API_KEY) return null;
  try {
    const { data } = await axios.get(
      `http://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`
    );
    return data.Response === "True" ? data : null;
  } catch (error) {
    console.warn("OMDb fetch failed:", error.message);
    return null;
  }
};
const minutesToHhMm = (minutes) => {
  if (isNaN(minutes) || minutes <= 0) return "N/A";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
};
const findBestBackdrop = (details) => {
  if (details.images?.backdrops?.length > 0) {
    const englishBackdrop = details.images.backdrops.find(
      (b) => b.iso_639_1 === "en"
    );
    if (englishBackdrop) return englishBackdrop.file_path;
  }
  return details.backdrop_path;
};

// --- EMBED & BUTTON BUILDERS ---
const buildMediaEmbed = (
  details,
  mediaType,
  status,
  config,
  omdbData,
  backdropPath
) => {
  const title = details.title || details.name;
  const year = (details.release_date || details.first_air_date)?.slice(0, 4);
  const fullTitle = year ? `${title} (${year})` : title;
  let authorName, color;
  switch (status) {
    case "success":
      authorName = "✅ Successfully Requested!";
      color = config.color_success || "#a6d189";
      break;
    case "search":
      authorName =
        mediaType === "movie" ? "🎬 Movie Found" : "📺 TV Show Found";
      color = config.color_search || "#ef9f76";
      break;
    default:
      authorName = "Item Details";
      color = config.color_search || "#ef9f76";
  }
  const overview = details.overview || "No description available.";
  const imdbId = details.external_ids?.imdb_id;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: authorName })
    .setTitle(fullTitle)
    .setURL(imdbId ? `https://www.imdb.com/title/${imdbId}/` : null)
    .setImage(
      backdropPath ? `https://image.tmdb.org/t/p/w780${backdropPath}` : null
    );
  const headerLine =
    mediaType === "movie" && omdbData?.Director && omdbData.Director !== "N/A"
      ? `Directed by ${omdbData.Director}`
      : "Summary";
  embed.addFields({
    name: headerLine,
    value:
      overview.length > 1024 ? overview.substring(0, 1021) + "..." : overview,
  });
  const genres = details.genres?.map((g) => g.name).join(", ") || "N/A";
  const runtime =
    mediaType === "movie"
      ? minutesToHhMm(details.runtime)
      : `${details.number_of_seasons} seasons`;
  const rating =
    omdbData?.imdbRating && omdbData.imdbRating !== "N/A"
      ? `${omdbData.imdbRating}/10`
      : "N/A";
  embed.addFields(
    { name: "Genre", value: genres, inline: true },
    { name: "Runtime", value: runtime, inline: true },
    { name: "Rating", value: rating, inline: true }
  );
  return embed;
};
const buildActionButtons = (tmdbId, mediaType, imdbId, requested = false) => {
  const row = new ActionRowBuilder();
  if (imdbId) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Letterboxd")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://letterboxd.com/imdb/${imdbId}`),
      new ButtonBuilder()
        .setLabel("IMDb")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://www.imdb.com/title/${imdbId}`)
    );
  }
  if (requested) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("requested")
        .setLabel("Requested")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`request|${tmdbId}|${mediaType}`)
        .setLabel("Request")
        .setStyle(ButtonStyle.Primary)
    );
  }
  return [row];
};

// --- DISCORD COMMANDS DEFINITION ---
const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Get a link to configure the bot on the web dashboard."),
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search for a movie or TV show.")
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("The title to search for")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("Request a movie or TV show directly.")
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("The title to request")
        .setRequired(true)
        .setAutocomplete(true)
    ),
];

// --- DISCORD EVENTS ---
const handleInteraction = async (interaction, tmdbId, mediaType, isRequest) => {
  const config = getConfig(interaction.guildId);
  try {
    if (isRequest) await sendRequestToJellyseerr(tmdbId, mediaType, config);
    const details = await tmdbGetDetails(tmdbId, mediaType);
    const imdbId = details.external_ids?.imdb_id;
    const omdbData = await fetchOMDbData(imdbId);
    const bestBackdropPath = findBestBackdrop(details);
    const embed = buildMediaEmbed(
      details,
      mediaType,
      isRequest ? "success" : "search",
      config,
      omdbData,
      bestBackdropPath
    );
    const components = buildActionButtons(tmdbId, mediaType, imdbId, isRequest);
    await interaction.editReply({ embeds: [embed], components });
  } catch (error) {
    console.error(
      "Error during interaction:",
      error.response?.data || error.message
    );
    const errorMessage =
      "❌ An error occurred. The item might already be requested.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: errorMessage,
        embeds: [],
        components: [],
      });
    }
  }
};

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focusedValue = interaction.options.getFocused();
      if (focusedValue.length < 2) return await interaction.respond([]);
      const results = await tmdbSearch(focusedValue);
      const choices = results
        .filter((r) => ["movie", "tv"].includes(r.media_type) && r.poster_path)
        .slice(0, 10)
        .map((item) => {
          const year = (item.release_date || item.first_air_date)?.slice(0, 4);
          const label = `${item.media_type === "movie" ? "🎬" : "📺"} ${
            item.title || item.name
          }${year ? ` (${year})` : ""}`;
          return { name: label, value: `${item.id}|${item.media_type}` };
        });
      await interaction.respond(choices);
      return;
    }

    if (interaction.isCommand()) {
      const { commandName } = interaction;
      const config = getConfig(interaction.guildId);
      if (commandName === "setup") {
        if (
          !interaction.member.permissions.has(
            PermissionsBitField.Flags.Administrator
          )
        ) {
          return interaction.reply({
            content: "Only administrators can use this command.",
            ephemeral: true,
          });
        }
        const dashboardUrl = `${PUBLIC_BOT_URL}/auth/discord?guild_id=${interaction.guildId}`;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Configure Bot').setStyle(ButtonStyle.Link).setURL(dashboardUrl));        return interaction.reply({
          content: `Click the button below to configure Anchorr for this server.\n[Configure Bot](${dashboardUrl})`,
          ephemeral: true,
        });
      }
      if (!config?.jellyseer_url) {
        return interaction.reply({
          content:
            "⚠️ Anchorr is not configured. An admin needs to run `/setup`.",
          ephemeral: true,
        });
      }
      await interaction.deferReply({ ephemeral: !!config.ephemeral_responses });
      const rawValue = interaction.options.getString("title");
      const [tmdbId, mediaType] = rawValue.split("|");
      if (!tmdbId || !mediaType)
        return interaction.editReply({
          content: "⚠️ Please select a valid title from the list.",
        });
      await handleInteraction(
        interaction,
        tmdbId,
        mediaType,
        commandName === "request"
      );
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("request|")) {
        await interaction.deferUpdate();
        const [_, tmdbId, mediaType] = interaction.customId.split("|");
        await handleInteraction(interaction, tmdbId, mediaType, true);
      }
    }
  } catch (error) {
    console.error("An unhandled error occurred in interactionCreate:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
  }
});

// --- JELLYFIN WEBHOOK HANDLER ---
const webhookDebounce = new Map();
app.post("/jellyfin-webhook/:guildId", async (req, res) => {
  try {
    const { guildId } = req.params;
    const data = req.body;
    if (data.NotificationType !== "ItemAdded") {
      return res.status(200).send("OK: Notification type ignored.");
    }
    const config = getConfig(guildId);
    if (
      !config ||
      !config.notification_channel_id ||
      !config.jellyfin_server_url
    ) {
      console.warn(
        `Webhook received for guild ${guildId}, but it's not fully configured for notifications.`
      );
      return res
        .status(404)
        .send("Error: Guild configuration incomplete for notifications.");
    }
    if (data.ItemType !== "Movie" && data.ItemType !== "Episode") {
      return res.status(200).send("OK: ItemType ignored.");
    }

    const debounceKey = data.SeriesId || data.ItemId;
    if (webhookDebounce.has(debounceKey)) {
      clearTimeout(webhookDebounce.get(debounceKey));
    }

    const timer = setTimeout(async () => {
      try {
        const {
          ItemType,
          Name,
          SeriesName,
          IndexNumber,
          ParentIndexNumber,
          Year,
          Overview,
          RunTimeTicks,
          Genres,
          Provider_imdb: imdbId,
          ItemId,
          ServerId,
          ServerUrl,
        } = data;
        let title, authorName;
        switch (ItemType) {
          case "Movie":
            authorName = "🎬 New Movie Added";
            title = `${Name} (${Year})`;
            break;
          case "Episode":
            authorName = "📺 New Episode Added";
            title = `${SeriesName} - S${String(ParentIndexNumber).padStart(
              2,
              "0"
            )}E${String(IndexNumber).padStart(2, "0")} - ${Name}`;
            break;
        }

        const omdb = await fetchOMDbData(imdbId);
        const watchUrl = `${ServerUrl.replace(
          /\/$/,
          ""
        )}/web/index.html#!/details?id=${ItemId}&serverId=${ServerId}`;

        const imageUrl = `${ServerUrl.replace(
          /\/$/,
          ""
        )}/Items/${ItemId}/Images/Thumb`;

        const headerLine =
          ItemType === "Movie" && omdb?.Director && omdb.Director !== "N/A"
            ? `Directed by ${omdb.Director}`
            : "Summary";

        const embed = new EmbedBuilder()
          .setColor(config.color_notification || "#cba6f7")
          .setAuthor({ name: authorName })
          .setTitle(title)
          .setURL(watchUrl)
          .setImage(imageUrl)
          .addFields({
            name: headerLine,
            value: Overview || omdb?.Plot || "No description available.",
          })
          .addFields(
            {
              name: "Genre",
              value: Genres || omdb?.Genre || "N/A",
              inline: true,
            },
            {
              name: "Runtime",
              value: minutesToHhMm(Math.round(RunTimeTicks / 10000000 / 60)),
              inline: true,
            },
            {
              name: "Rating",
              value: omdb?.imdbRating ? `${omdb.imdbRating}/10` : "N/A",
              inline: true,
            }
          );

        const row = new ActionRowBuilder();
        if (imdbId) {
          row.addComponents(
            new ButtonBuilder()
              .setLabel("Letterboxd")
              .setStyle(ButtonStyle.Link)
              .setURL(`https://letterboxd.com/imdb/${imdbId}`),
            new ButtonBuilder()
              .setLabel("IMDb")
              .setStyle(ButtonStyle.Link)
              .setURL(`https://www.imdb.com/title/${imdbId}`)
          );
        }
        row.addComponents(
          new ButtonBuilder()
            .setLabel("▶ Watch Now")
            .setStyle(ButtonStyle.Link)
            .setURL(watchUrl)
        );

        const channel = await client.channels.fetch(
          config.notification_channel_id
        );
        if (channel) {
          await channel.send({ embeds: [embed], components: [row] });
          console.log(`Sent notification for "${title}" to guild ${guildId}`);
        }
      } catch (innerError) {
        console.error("Error processing debounced webhook:", innerError);
      } finally {
        webhookDebounce.delete(debounceKey);
      }
    }, 10000);

    webhookDebounce.set(debounceKey, timer);
    res.status(200).send("OK: Notification received and debounced.");
  } catch (error) {
    console.error("Error handling Jellyfin webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

// --- STARTUP ---
(async () => {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(BOT_ID), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("Successfully reloaded application (/) commands.");
    await client.login(DISCORD_TOKEN);
    client.once("ready", () => {
      console.log(`✅ Discord Bot logged in as ${client.user.tag}`);
      app.listen(WEBHOOK_PORT, () => {
        console.log(
          `🌐 Web server and webhook listener started on port ${WEBHOOK_PORT}`
        );
      });
    });
  } catch (error) {
    console.error("Fatal startup error:", error);
  }
})();
