import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = "data";
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const db = new Database(path.resolve(dataDir, "database.db"));

const MIGRATIONS = [
  `CREATE TABLE configs (
      guild_id TEXT PRIMARY KEY,
      jellyseer_url TEXT NOT NULL,
      jellyseer_api_key TEXT NOT NULL,
      notification_channel_id TEXT,
      jellyfin_server_url TEXT,
      embed_color TEXT DEFAULT '#ef9f76'
    );`,

  `ALTER TABLE configs ADD COLUMN ephemeral_responses INTEGER DEFAULT 0;`,
  `ALTER TABLE configs ADD COLUMN color_success TEXT DEFAULT '#a6d189';`,
  `ALTER TABLE configs ADD COLUMN color_notification TEXT DEFAULT '#cba6f7';`,
  `ALTER TABLE configs RENAME COLUMN embed_color TO color_search;`,
];

export function prepareDatabase() {
  let currentVersion = db.pragma("user_version", { simple: true });
  console.log(`Database version: ${currentVersion}`);

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    try {
      console.log(`Running migration for version ${i + 1}...`);

      const migrate = db.transaction(() => {
        db.exec(MIGRATIONS[i]);

        db.pragma(`user_version = ${i + 1}`);
      });
      migrate();
      console.log(`Successfully migrated to version ${i + 1}.`);
    } catch (error) {
      console.error(`Failed to migrate to version ${i + 1}:`, error);

      process.exit(1);
    }
  }

  currentVersion = db.pragma("user_version", { simple: true });
  if (currentVersion === MIGRATIONS.length) {
    console.log("✅ Database is up to date.");
  }
}

export function getConfig(guildId) {
  const stmt = db.prepare("SELECT * FROM configs WHERE guild_id = ?");
  return stmt.get(guildId);
}

export function setConfig(config) {
  const {
    guild_id,
    jellyseer_url,
    jellyseer_api_key,
    notification_channel_id,
    jellyfin_server_url,
    color_search,
    ephemeral_responses,
    color_success,
    color_notification,
  } = config;
  const stmt = db.prepare(`
    INSERT INTO configs (guild_id, jellyseer_url, jellyseer_api_key, notification_channel_id, jellyfin_server_url, color_search, ephemeral_responses, color_success, color_notification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      jellyseer_url = excluded.jellyseer_url,
      jellyseer_api_key = excluded.jellyseer_api_key,
      notification_channel_id = excluded.notification_channel_id,
      jellyfin_server_url = excluded.jellyfin_server_url,
      color_search = excluded.color_search,
      ephemeral_responses = excluded.ephemeral_responses,
      color_success = excluded.color_success,
      color_notification = excluded.color_notification;
  `);
  stmt.run(
    guild_id,
    jellyseer_url,
    jellyseer_api_key,
    notification_channel_id,
    jellyfin_server_url,
    color_search,
    ephemeral_responses,
    color_success,
    color_notification
  );
}
