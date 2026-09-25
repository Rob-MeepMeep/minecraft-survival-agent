'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Reads MC_* environment variables, validates them, and returns a frozen
 * configuration object. Throws with an actionable message on invalid input.
 */
function loadConfig() {
  const errors = [];

  // --- Host ---
  const host = process.env.MC_HOST || 'localhost';

  // --- Port ---
  const rawPort = process.env.MC_PORT || '25565';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`MC_PORT="${rawPort}" is not a valid port (1–65535).`);
  }

  // --- Username ---
  const username = process.env.MC_USERNAME || 'SurvivalAgent';
  if (username.length === 0) {
    errors.push('MC_USERNAME must not be empty.');
  }

  // --- Auth ---
  const auth = process.env.MC_AUTH || 'microsoft';
  if (!['microsoft', 'offline'].includes(auth)) {
    errors.push(
      `MC_AUTH="${auth}" is invalid. Use "microsoft" or "offline".`
    );
  }

  // --- Version ---
  // Empty string or unset → auto-detect (false for mineflayer).
  const versionRaw = (process.env.MC_VERSION || '').trim();
  const version = versionRaw.length > 0 ? versionRaw : false;

  // --- Profiles folder ---
  const profilesFolder = path.resolve('.auth');

  if (errors.length > 0) {
    throw new Error(
      'Configuration errors:\n  • ' + errors.join('\n  • ') +
      '\nSee .env.example for required settings.'
    );
  }

  const config = Object.freeze({
    host,
    port,
    username,
    auth,
    version,
    profilesFolder,
  });

  return config;
}

/**
 * Returns a sanitized copy of the config safe for logging.
 * Omits filesystem paths and anything that could leak credentials.
 */
function sanitizedConfig(config) {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version || '(auto-detect)',
  };
}

/**
 * Returns version/environment metadata for startup logging.
 */
function startupMeta(config) {
  let mineflayerVersion = 'unknown';
  try {
    mineflayerVersion = require('mineflayer/package.json').version;
  } catch { /* not critical */ }

  let pathfinderVersion = 'unknown';
  try {
    pathfinderVersion = require('mineflayer-pathfinder/package.json').version;
  } catch { /* not critical */ }

  return {
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    mineflayerVersion,
    pathfinderVersion,
    config: sanitizedConfig(config),
  };
}

module.exports = { loadConfig, sanitizedConfig, startupMeta };
