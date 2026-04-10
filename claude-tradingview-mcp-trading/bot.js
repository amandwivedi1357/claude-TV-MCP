/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import path from "path";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const hasVault = existsSync(SECRETS_VAULT_FILE);
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env") && !hasVault) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "ALLOWED_IP_ADDRESSES=",
        "SECRET_ROTATION_ALERT_DAYS=30",
        "SECRET_ROTATION_CRITICAL_DAYS=60",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_ENTRY_PRICE_DEVIATION_PERCENT=5",
        "MAX_CLAUDE_PRICE_RANGE_PERCENT=10",
        "MIN_CONFIDENCE_THRESHOLD=0.3",
        "ALLOW_CLAUDE_RETRY_ON_INVALID=true",
        "MAX_VALIDATION_RETRIES=2",
        "CLAUDE_SIGNAL_FILE=",
        "CLAUDE_RAW_RESPONSE=",
        "BACKTEST_LOOKBACK_CANDLES=1000",
        "BACKTEST_SLIPPAGE_PERCENT=0.05",
        "BACKTEST_COMMISSION_PERCENT=0.075",
        "DIVERGENCE_ALERT_THRESHOLD=20",
        "BACKTEST_INTERVAL_TRADES=10",
        "AUTO_PAUSE_IF_DIVERGENCE=false",
        "LOG_LEVEL=INFO",
        "LOG_TO_FILE=true",
        "LOG_TO_CONSOLE=true",
        "LOG_DIR=./logs",
        "GENERATE_DAILY_SUMMARY=true",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (!hasVault && missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxEntryPriceDeviationPercent: parseFloat(
    process.env.MAX_ENTRY_PRICE_DEVIATION_PERCENT || "5",
  ),
  maxClaudePriceRangePercent: parseFloat(
    process.env.MAX_CLAUDE_PRICE_RANGE_PERCENT || "10",
  ),
  minConfidenceThreshold: parseFloat(
    process.env.MIN_CONFIDENCE_THRESHOLD || "0.3",
  ),
  allowClaudeRetryOnInvalid:
    process.env.ALLOW_CLAUDE_RETRY_ON_INVALID !== "false",
  maxValidationRetries: parseInt(
    process.env.MAX_VALIDATION_RETRIES || "2",
  ),
  claudeSignalFile: process.env.CLAUDE_SIGNAL_FILE || "",
  claudeRawResponse: process.env.CLAUDE_RAW_RESPONSE || "",
  backtestLookbackCandles: parseInt(
    process.env.BACKTEST_LOOKBACK_CANDLES || "1000",
  ),
  backtestSlippagePercent: parseFloat(
    process.env.BACKTEST_SLIPPAGE_PERCENT || "0.05",
  ),
  backtestCommissionPercent: parseFloat(
    process.env.BACKTEST_COMMISSION_PERCENT || "0.075",
  ),
  divergenceAlertThreshold: parseFloat(
    process.env.DIVERGENCE_ALERT_THRESHOLD || "20",
  ),
  backtestIntervalTrades: parseInt(
    process.env.BACKTEST_INTERVAL_TRADES || "10",
  ),
  autoPauseIfDivergence: process.env.AUTO_PAUSE_IF_DIVERGENCE === "true",
  logLevel: String(process.env.LOG_LEVEL || "INFO").toUpperCase(),
  logToFile: process.env.LOG_TO_FILE !== "false",
  logToConsole: process.env.LOG_TO_CONSOLE !== "false",
  logDir: process.env.LOG_DIR || "./logs",
  generateDailySummary: process.env.GENERATE_DAILY_SUMMARY !== "false",
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  maxSlippagePercent: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || "2"),
  slippageWarningPercent: parseFloat(
    process.env.SLIPPAGE_WARNING_PERCENT || "1",
  ),
  maxExecutionTimeMs: parseInt(process.env.MAX_EXECUTION_TIME_MS || "5000"),
  maxApiRetries: parseInt(process.env.MAX_API_RETRIES || "3"),
  minRequestSpacingMs: parseInt(process.env.MIN_REQUEST_SPACING_MS || "500"),
  rateLimitBackoffBaseMs: parseInt(
    process.env.RATE_LIMIT_BACKOFF_BASE || "1000",
  ),
  healthCheckIntervalMs: parseInt(
    process.env.HEALTH_CHECK_INTERVAL_MS || "30000",
  ),
  healthCheckTimeoutMs: parseInt(
    process.env.HEALTH_CHECK_TIMEOUT_MS || "10000",
  ),
  healthCheckMaxRetries: parseInt(
    process.env.HEALTH_CHECK_MAX_RETRIES || "3",
  ),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  enableAutoRecovery: process.env.ENABLE_AUTO_RECOVERY !== "false",
  healthRequiredComponents: (process.env.HEALTH_REQUIRED_COMPONENTS || "exchange")
    .split(",")
    .map((component) => component.trim().toLowerCase())
    .filter(Boolean),
  tradingViewHealthCommand: process.env.TRADINGVIEW_HEALTH_CHECK_COMMAND || "",
  mcpHealthcheckUrl: process.env.MCP_HEALTHCHECK_URL || "",
  claudeHealthcheckUrl: process.env.CLAUDE_HEALTHCHECK_URL || "",
  tradingViewRecoveryCommand: process.env.TRADINGVIEW_RECOVERY_COMMAND || "",
  mcpRecoveryCommand: process.env.MCP_RECOVERY_COMMAND || "",
  claudeRecoveryCommand: process.env.CLAUDE_RECOVERY_COMMAND || "",
  orderConfirmationTimeoutMs: parseInt(
    process.env.ORDER_CONFIRMATION_TIMEOUT_MS || "10000",
  ),
  orderPollIntervalMs: parseInt(process.env.ORDER_POLL_INTERVAL_MS || "500"),
  reconcileOnStartup: process.env.RECONCILE_ON_STARTUP !== "false",
  openOrdersCacheDurationMs: parseInt(
    process.env.OPEN_ORDERS_CACHE_DURATION_MS || "5000",
  ),
  allowedIpAddresses: (process.env.ALLOWED_IP_ADDRESSES || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean),
  secretRotationAlertDays: parseInt(
    process.env.SECRET_ROTATION_ALERT_DAYS || "30",
  ),
  secretRotationCriticalDays: parseInt(
    process.env.SECRET_ROTATION_CRITICAL_DAYS || "60",
  ),
  staleOrderTimeoutMs: parseInt(
    process.env.STALE_ORDER_TIMEOUT_MS || "1800000",
  ),
  preventDuplicateEntries: process.env.PREVENT_DUPLICATE_ENTRIES !== "false",
  duplicatePreventionLookbackMinutes: parseInt(
    process.env.DUPLICATE_PREVENTION_LOOKBACK_MINUTES || "5",
  ),
  ntpServers: (process.env.NTP_SERVERS || "pool.ntp.org,time.nist.gov")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean),
  maxAllowedClockSkewMs: parseInt(
    process.env.MAX_ALLOWED_CLOCK_SKEW_MS || "5000",
  ),
  clockCheckIntervalHours: parseInt(
    process.env.CLOCK_CHECK_INTERVAL_HOURS || "1",
  ),
  pauseTradingIfSkew: process.env.PAUSE_TRADING_IF_SKEW !== "false",
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY || "",
    secretKey: process.env.BITGET_SECRET_KEY || "",
    passphrase: process.env.BITGET_PASSPHRASE || "",
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const RATE_LIMIT_LOG_FILE = "rate_limit_events.json";
const HEALTH_CHECK_LOG_FILE = "health-check-log.json";
const HEALTH_CHECK_SUMMARY_FILE = "health-check-summary.json";
const TRADE_STATE_MACHINE_FILE = "trade-state-machine.json";
const TRADE_CONFIRMATIONS_FILE = "trade-confirmations.json";
const SECRETS_VAULT_FILE = "secrets_vault.json";
const SECURITY_AUDIT_FILE = "security-audit.json";
const PENDING_ORDERS_FILE = "pending-orders.json";
const ORDER_STATE_SUMMARY_FILE = "order-state-summary.json";
const TIME_SYNC_LOG_FILE = "time-sync-log.json";
const CLAUDE_RESPONSE_LOG_FILE = "claude-response-log.json";
const BACKTEST_BASELINE_FILE = "backtest-baseline.json";
const FORWARD_TEST_LOG_FILE = "forward-test-log.json";
const TRADING_STATISTICS_FILE = "trading-statistics.json";

function parseEnvFile(path = ".env") {
  if (!existsSync(path)) return {};
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.trim().startsWith("#") && line.includes("="))
    .reduce((acc, line) => {
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

function loadSecurityAudit() {
  if (!existsSync(SECURITY_AUDIT_FILE)) {
    return { events: [] };
  }
  const parsed = JSON.parse(readFileSync(SECURITY_AUDIT_FILE, "utf8"));
  return { events: Array.isArray(parsed.events) ? parsed.events : [] };
}

function saveSecurityAudit(data) {
  writeFileSync(SECURITY_AUDIT_FILE, JSON.stringify(data, null, 2));
}

function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));
  renameSync(tempPath, filePath);
}

function nowMs() {
  return Date.now();
}

function ensureDirectoryExists(directoryPath) {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

class Logger {
  constructor(config) {
    this.config = config;
    this.levelOrder = {
      DEBUG: 10,
      INFO: 20,
      WARN: 30,
      ERROR: 40,
    };
    this.sensitivePatterns = [
      /api[_-]?key/i,
      /secret/i,
      /passphrase/i,
      /token/i,
      /password/i,
      /authorization/i,
    ];
  }

  shouldLog(level) {
    const configured = this.levelOrder[this.config.logLevel] || this.levelOrder.INFO;
    const requested = this.levelOrder[level] || this.levelOrder.INFO;
    return requested >= configured;
  }

  sanitizeValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }
    if (value && typeof value === "object") {
      return this.sanitizeContext(value);
    }
    if (typeof value === "string" && value.length > 4000) {
      return `${value.slice(0, 4000)}...[truncated]`;
    }
    return value;
  }

  sanitizeContext(context = {}) {
    return Object.entries(context).reduce((acc, [key, value]) => {
      if (this.sensitivePatterns.some((pattern) => pattern.test(key))) {
        acc[key] = "[REDACTED]";
      } else {
        acc[key] = this.sanitizeValue(value);
      }
      return acc;
    }, {});
  }

  getLogFilePath(timestamp) {
    const date = timestamp.slice(0, 10);
    return path.join(this.config.logDir, `${date}.json`);
  }

  readLogFile(filePath) {
    if (!existsSync(filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  write(level, category, message, context = {}) {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      category,
      message,
      context: this.sanitizeContext(context),
    };

    if (this.config.logToFile) {
      ensureDirectoryExists(this.config.logDir);
      const filePath = this.getLogFilePath(timestamp);
      const entries = this.readLogFile(filePath);
      entries.push(entry);
      writeJsonAtomic(filePath, entries);
    }

    if (this.config.logToConsole) {
      const printer =
        level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
      printer(`[${level}] [${category}] ${message}`);
    }
  }

  debug(category, message, context = {}) {
    this.write("DEBUG", category, message, context);
  }

  info(category, message, context = {}) {
    this.write("INFO", category, message, context);
  }

  warn(category, message, context = {}) {
    this.write("WARN", category, message, context);
  }

  error(category, message, context = {}) {
    this.write("ERROR", category, message, context);
  }
}

const logger = new Logger(CONFIG);

function recordSecurityAudit(action, success, reason = null, context = {}) {
  const data = loadSecurityAudit();
  data.events.push({
    timestamp: new Date(nowMs()).toISOString(),
    action,
    success,
    reason,
    context,
  });
  saveSecurityAudit(data);
}

function dpapiProtect(value) {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const command = `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${encoded}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return execSync(`powershell -NoProfile -Command "${command}"`, {
    encoding: "utf8",
  }).trim();
}

function dpapiUnprotect(value) {
  const command = `[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${value}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return execSync(`powershell -NoProfile -Command "${command}"`, {
    encoding: "utf8",
  }).trim();
}

function getProtectedMasterKey() {
  if (process.platform === "win32") {
    return {
      protect: dpapiProtect,
      unprotect: dpapiUnprotect,
      provider: "windows-dpapi",
    };
  }

  return {
    protect: (value) => {
      const fallbackSecret = process.env.SECRET_MASTER_KEY;
      if (!fallbackSecret) {
        throw new Error(
          "SECRET_MASTER_KEY is required on non-Windows platforms for vault encryption",
        );
      }
      return value;
    },
    unprotect: (value) => {
      const fallbackSecret = process.env.SECRET_MASTER_KEY;
      if (!fallbackSecret) {
        throw new Error(
          "SECRET_MASTER_KEY is required on non-Windows platforms for vault decryption",
        );
      }
      return value;
    },
    provider: "env-secret-master-key",
  };
}

function sanitizeEnvFile() {
  if (!existsSync(".env")) return;

  const envValues = parseEnvFile(".env");
  delete envValues.BITGET_API_KEY;
  delete envValues.BITGET_SECRET_KEY;
  delete envValues.BITGET_PASSPHRASE;

  const lines = Object.entries(envValues).map(([key, value]) => `${key}=${value}`);
  const sanitized = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const overwrite = (text) => writeFileSync(".env", text);
  overwrite("0".repeat(Math.max(32, sanitized.length || 32)));
  overwrite("1".repeat(Math.max(32, sanitized.length || 32)));
  overwrite("2".repeat(Math.max(32, sanitized.length || 32)));

  if (sanitized.length > 0) {
    writeFileSync(".env", sanitized);
  } else {
    unlinkSync(".env");
  }
}

function setBitgetCredentials(secrets) {
  CONFIG.bitget.apiKey = secrets.apiKey || "";
  CONFIG.bitget.secretKey = secrets.secretKey || "";
  CONFIG.bitget.passphrase = secrets.passphrase || "";
}

class SecretsManager {
  constructor(vaultFile = SECRETS_VAULT_FILE) {
    this.vaultFile = vaultFile;
    this.masterKeyProvider = getProtectedMasterKey();
  }

  createVaultFromEnv() {
    const envValues = parseEnvFile(".env");
    const secrets = {
      apiKey: envValues.BITGET_API_KEY || "",
      secretKey: envValues.BITGET_SECRET_KEY || "",
      passphrase: envValues.BITGET_PASSPHRASE || "",
    };

    if (!secrets.apiKey || !secrets.secretKey || !secrets.passphrase) {
      throw new Error("Missing BitGet credentials in .env for vault creation");
    }

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(secrets), "utf8"),
      cipher.final(),
    ]).toString("base64");

    const protectedKey = this.masterKeyProvider.protect(aesKey.toString("base64"));
    const now = new Date().toISOString().slice(0, 10);
    const vault = {
      encrypted_data: encrypted,
      key_encryption: protectedKey,
      iv: iv.toString("base64"),
      metadata: {
        created_date: now,
        last_rotated: now,
        exchange: "bitget",
        algorithm: "AES-256-CBC",
        protection: this.masterKeyProvider.provider,
      },
    };

    writeFileSync(this.vaultFile, JSON.stringify(vault, null, 2));
    sanitizeEnvFile();
    recordSecurityAudit("CREATE_VAULT", true, null, {
      vaultFile: this.vaultFile,
    });
    return { ...secrets, metadata: vault.metadata };
  }

  loadSecrets() {
    try {
      if (!existsSync(this.vaultFile)) {
        if (!existsSync(".env")) {
          throw new Error("No secrets vault or .env file found");
        }
        const created = this.createVaultFromEnv();
        recordSecurityAudit("LOAD_SECRETS", true, "migrated_from_env");
        return created;
      }

      const vault = JSON.parse(readFileSync(this.vaultFile, "utf8"));
      const aesKey = Buffer.from(
        this.masterKeyProvider.unprotect(vault.key_encryption),
        "base64",
      );
      const decipher = crypto.createDecipheriv(
        "aes-256-cbc",
        aesKey,
        Buffer.from(vault.iv, "base64"),
      );
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(vault.encrypted_data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const secrets = JSON.parse(decrypted);
      recordSecurityAudit("LOAD_SECRETS", true);
      return { ...secrets, metadata: vault.metadata };
    } catch (error) {
      recordSecurityAudit("LOAD_SECRETS", false, error.message);
      throw error;
    }
  }
}

class SecretRotationManager {
  constructor(metadata) {
    this.metadata = metadata || {};
  }

  checkRotationStatus() {
    const lastRotated = this.metadata.last_rotated || this.metadata.created_date;
    if (!lastRotated) {
      return {
        status: "unknown",
        daysOld: null,
        message: "Secret rotation date unavailable",
      };
    }

    const daysOld = Math.floor(
      (Date.now() - new Date(lastRotated).getTime()) / (24 * 60 * 60 * 1000),
    );
    if (daysOld >= CONFIG.secretRotationCriticalDays) {
      return {
        status: "critical",
        daysOld,
        message: `API key is ${daysOld} days old, MUST rotate immediately. Go to BitGet -> API Management -> Create new key.`,
      };
    }
    if (daysOld >= CONFIG.secretRotationAlertDays) {
      return {
        status: "warning",
        daysOld,
        message: `API key is ${daysOld} days old, rotate for security. Go to BitGet -> API Management -> Create new key.`,
      };
    }

    return {
      status: "ok",
      daysOld,
      message: `Secrets loaded (rotated ${daysOld} day${daysOld === 1 ? "" : "s"} ago)`,
    };
  }
}

class SecretValidator {
  async validateCredentials() {
    try {
      const path =
        CONFIG.tradeMode === "spot"
          ? "/api/v2/spot/account/assets"
          : "/api/v2/mix/account/accounts";
      const query =
        CONFIG.tradeMode === "spot"
          ? { coin: "USDT" }
          : { productType: "USDT-FUTURES" };
      await bitgetRequest("GET", path, {
        query,
        context: "validateCredentials",
      });
      recordSecurityAudit("VALIDATE_CREDENTIALS", true, null, {
        symbol: CONFIG.symbol,
      });
      return {
        valid: true,
        message: "API credentials validated, read access confirmed",
      };
    } catch (error) {
      recordSecurityAudit("VALIDATE_CREDENTIALS", false, error.message);
      return {
        valid: false,
        message: `INVALID_CREDENTIALS_OR_EXCHANGE_UNREACHABLE: ${error.message}`,
      };
    }
  }
}

async function checkIpWhitelist() {
  if (CONFIG.allowedIpAddresses.length === 0) {
    return {
      valid: true,
      currentIp: null,
      message: "IP whitelist not configured",
    };
  }

  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const data = await response.json();
    const currentIp = data.ip;
    const valid = CONFIG.allowedIpAddresses.includes(currentIp);
    recordSecurityAudit("CHECK_IP_WHITELIST", valid, valid ? null : "IP_MISMATCH", {
      currentIp,
    });
    return {
      valid,
      currentIp,
      message: valid
        ? `IP whitelist verified (${currentIp})`
        : `IP whitelist mismatch: Current IP ${currentIp} NOT in whitelist. Add to BitGet settings.`,
    };
  } catch (error) {
    recordSecurityAudit("CHECK_IP_WHITELIST", false, error.message);
    return {
      valid: false,
      currentIp: null,
      message: `Unable to verify current IP: ${error.message}`,
    };
  }
}

function getWithdrawalRestrictionsChecklist() {
  const checklist = [
    "NO withdrawal permissions",
    "NO account transfer permissions",
    "ONLY spot trading and margin trading if needed",
    "IP whitelist enabled",
  ];
  recordSecurityAudit("CHECK_WITHDRAWAL_RESTRICTIONS", true, null, {
    checklistItems: checklist.length,
  });
  return checklist;
}

async function initializeSecurity() {
  const secretsManager = new SecretsManager();
  const secrets = secretsManager.loadSecrets();
  setBitgetCredentials(secrets);

  const rotationManager = new SecretRotationManager(secrets.metadata);
  const rotationStatus = rotationManager.checkRotationStatus();
  const ipStatus = await checkIpWhitelist();
  const credentialStatus = await new SecretValidator().validateCredentials();
  const restrictionsChecklist = getWithdrawalRestrictionsChecklist();

  console.log("\nSecurity Checklist");
  console.log(
    `  ${rotationStatus.status === "critical" ? "✗" : rotationStatus.status === "warning" ? "⚠" : "✓"} ${rotationStatus.message}`,
  );
  console.log(`  ${ipStatus.valid ? "✓" : "✗"} ${ipStatus.message}`);
  console.log(
    `  ${credentialStatus.valid ? "✓" : "✗"} ${credentialStatus.message}`,
  );
  console.log("  ✓ API restriction checklist:");
  restrictionsChecklist.forEach((item) => console.log(`    - ${item}`));

  const valid = ipStatus.valid && credentialStatus.valid;
  if (!valid) {
    recordSecurityAudit("SECURITY_STARTUP_BLOCKED", false, "Startup security checks failed", {
      ipValid: ipStatus.valid,
      credentialsValid: credentialStatus.valid,
    });
  }

  return {
    valid,
    rotationStatus,
    ipStatus,
    credentialStatus,
    restrictionsChecklist,
  };
}

async function initializeWithTimeValidation() {
  const timeStatus = await checkTimeSync();
  console.log("\nTime Validation");
  console.log(`  ${timeStatus.valid ? "✓" : "✗"} ${timeStatus.message}`);
  if (!timeStatus.valid) {
    return { valid: false, timeStatus };
  }

  startClockDriftMonitor();
  return { valid: true, timeStatus };
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) {
    return {
      trades: [],
      safetyChecks: [],
      counters: {
        slippage_rejections: 0,
        rate_limit_abandoned: 0,
        health_check_pauses: 0,
        claude_validation_rejections: 0,
      },
      summaries: {},
    };
  }

  const parsed = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  return {
    trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    safetyChecks: Array.isArray(parsed.safetyChecks) ? parsed.safetyChecks : [],
    counters: {
      slippage_rejections:
        parsed?.counters?.slippage_rejections &&
        Number.isFinite(parsed.counters.slippage_rejections)
          ? parsed.counters.slippage_rejections
          : 0,
      rate_limit_abandoned:
        parsed?.counters?.rate_limit_abandoned &&
        Number.isFinite(parsed.counters.rate_limit_abandoned)
          ? parsed.counters.rate_limit_abandoned
          : 0,
      health_check_pauses:
        parsed?.counters?.health_check_pauses &&
        Number.isFinite(parsed.counters.health_check_pauses)
          ? parsed.counters.health_check_pauses
          : 0,
      claude_validation_rejections:
        parsed?.counters?.claude_validation_rejections &&
        Number.isFinite(parsed.counters.claude_validation_rejections)
          ? parsed.counters.claude_validation_rejections
          : 0,
    },
    summaries: parsed.summaries || {},
  };
}

function saveLog(log) {
  const today = new Date().toISOString().slice(0, 10);
  const healthSummary = loadHealthSummary();
  const claudeSummary = getClaudeResponseSummary(today);
  const baseline = loadBacktestBaseline();
  const executedTrades = log.trades.filter(
    (trade) =>
      trade.orderPlaced &&
      typeof trade.slippagePercent === "number" &&
      Number.isFinite(trade.slippagePercent),
  );
  const avgSlippage =
    executedTrades.length === 0
      ? 0
      : executedTrades.reduce(
          (sum, trade) => sum + Math.abs(trade.slippagePercent),
          0,
        ) / executedTrades.length;
  const totalLostToSlippage = executedTrades.reduce((sum, trade) => {
    if (
      !Number.isFinite(trade.tradeSize) ||
      !Number.isFinite(trade.slippagePercent)
    ) {
      return sum;
    }
    return sum + trade.tradeSize * (Math.abs(trade.slippagePercent) / 100);
  }, 0);

  log.summaries = {
    ...(log.summaries || {}),
    slippage: {
      trades: executedTrades.length,
      avgSlippagePercent: Number(avgSlippage.toFixed(4)),
      totalLostToSlippageUSD: Number(totalLostToSlippage.toFixed(4)),
      slippageRejections: log.counters.slippage_rejections,
      text: `Trades: ${executedTrades.length}, Avg Slippage: ${avgSlippage.toFixed(2)}%, Total Lost to Slippage: $${totalLostToSlippage.toFixed(2)}`,
    },
    rateLimit: getRateLimitSummary(),
    claudeResponses: claudeSummary,
    backtest:
      baseline?.stats
        ? {
            baselineTrades: baseline.stats.total_trades,
            baselineWinRate: roundMetric(baseline.stats.win_rate, 4),
            baselineTotalReturn: roundMetric(baseline.stats.total_return, 4),
            text: baseline.summary_text,
          }
        : {
            baselineTrades: 0,
            baselineWinRate: 0,
            baselineTotalReturn: 0,
            text: "Backtest baseline not available yet.",
          },
    health:
      healthSummary.daily[today] || {
        totalHealthChecks: 0,
        healthyChecks: 0,
        failedChecks: 0,
        tradingPauses: 0,
      },
  };

  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  updateTradingStatistics(log);

  if (CONFIG.generateDailySummary) {
    const summary = generateDailySummary(log, today);
    logger.info("DAILY_SUMMARY", summary.text, summary);
  }
}

function countTodaysTrades(log) {
  const today = new Date(getAccurateTimeMs()).toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

function recordSafetyCheck(log, type, details) {
  log.safetyChecks.push({
    timestamp: getAccurateTime(),
    type,
    ...details,
  });
  logger.info(
    inferLogCategory(type),
    type,
    {
      type,
      ...details,
    },
  );
}

function inferLogCategory(type) {
  if (/HEALTH|CLOCK|RECOVERY/i.test(type)) return "HEALTH_CHECK";
  if (/SLIPPAGE/i.test(type)) return "SLIPPAGE";
  if (/RATE_LIMIT/i.test(type)) return "RATE_LIMIT";
  if (/CLAUDE|VALIDATION/i.test(type)) return "VALIDATION";
  if (/TRADE|ORDER|POSITION/i.test(type)) return "TRADE_EXECUTION";
  if (/SECURITY|SECRET/i.test(type)) return "SECURITY";
  if (/BACKTEST|OVERFITTING|FORWARD_TEST/i.test(type)) return "STRATEGY";
  return "RISK_MANAGEMENT";
}

function loadTradingStatistics() {
  if (!existsSync(TRADING_STATISTICS_FILE)) {
    return {
      total_runs: 0,
      total_trades: 0,
      total_wins: 0,
      total_losses: 0,
      all_time_win_rate: 0,
      all_time_pnl: 0,
      best_day: "",
      worst_day: "",
      api_errors: 0,
      validation_failures: 0,
      rate_limits_hit: 0,
      last_updated_at: null,
    };
  }
  return JSON.parse(readFileSync(TRADING_STATISTICS_FILE, "utf8"));
}

function saveTradingStatistics(data) {
  writeJsonAtomic(TRADING_STATISTICS_FILE, data);
}

function getTradesForDay(log, date) {
  return log.trades.filter((trade) => String(trade.timestamp || "").startsWith(date));
}

function getErrorsForDay(log, date) {
  return getTradesForDay(log, date).filter((trade) => Boolean(trade.error));
}

function getLowestPerformingSymbol(log, date) {
  const tradeMap = new Map();
  for (const trade of getTradesForDay(log, date)) {
    const symbol = trade.symbol || "UNKNOWN";
    const penalty = Number(trade.tradeSize || 0) *
      (((Math.abs(Number(trade.slippagePercent || 0)) || 0) / 100) + 0.001);
    tradeMap.set(symbol, (tradeMap.get(symbol) || 0) - penalty);
  }
  let lowest = { symbol: "", pnl: 0 };
  for (const [symbol, pnl] of tradeMap.entries()) {
    if (lowest.symbol === "" || pnl < lowest.pnl) {
      lowest = { symbol, pnl: roundMetric(pnl, 4) };
    }
  }
  return lowest;
}

function getAverageExecutionLatency(log, date) {
  const trades = getTradesForDay(log, date).filter((trade) =>
    Number.isFinite(Number(trade.executionTimeMs)),
  );
  if (trades.length === 0) return 0;
  return roundMetric(
    trades.reduce((sum, trade) => sum + Number(trade.executionTimeMs || 0), 0) /
      trades.length,
    2,
  );
}

function getPeakHealthCheckFailures(log, date) {
  const failures = (log.safetyChecks || []).filter(
    (entry) =>
      String(entry.timestamp || "").startsWith(date) &&
      /HEALTH_CHECK_FAILED|SYSTEM_CLOCK_SKEW_DETECTED/i.test(entry.type || ""),
  );
  if (failures.length === 0) {
    return { hour: null, count: 0 };
  }
  const byHour = new Map();
  for (const failure of failures) {
    const hour = String(failure.timestamp).slice(0, 13);
    byHour.set(hour, (byHour.get(hour) || 0) + 1);
  }
  let peak = { hour: null, count: 0 };
  for (const [hour, count] of byHour.entries()) {
    if (count > peak.count) {
      peak = { hour, count };
    }
  }
  return peak;
}

function generateDailySummary(log, date = new Date().toISOString().slice(0, 10)) {
  const trades = getTradesForDay(log, date);
  const executedTrades = trades.filter((trade) => trade.orderPlaced);
  const blockedTrades = trades.filter((trade) => !trade.orderPlaced);
  const winningTrades = 0;
  const losingTrades = executedTrades.length;
  const healthSummary = loadHealthSummary().daily[date] || {};
  const rateLimitSummary = getRateLimitSummary();
  const claudeSummary = getClaudeResponseSummary(date);
  const avgExecutionLatency = getAverageExecutionLatency(log, date);
  const totalPnL = executedTrades.reduce((sum, trade) => {
    const cost = Number(trade.tradeSize || 0) *
      (((Math.abs(Number(trade.slippagePercent || 0)) || 0) / 100) + 0.001);
    return sum - cost;
  }, 0);
  const lowestSymbol = getLowestPerformingSymbol(log, date);
  const peakHealthFailures = getPeakHealthCheckFailures(log, date);

  return {
    date,
    signals_generated: trades.length,
    trades_executed: executedTrades.length,
    trades_validation_failed: blockedTrades.length,
    winning_trades: winningTrades,
    losing_trades: losingTrades,
    win_rate: executedTrades.length === 0 ? 0 : winningTrades / executedTrades.length,
    total_pnl: roundMetric(totalPnL, 4),
    avg_execution_latency_ms: avgExecutionLatency,
    health_checks_passed: healthSummary.healthyChecks || 0,
    health_checks_total: healthSummary.totalHealthChecks || 0,
    rate_limit_events: rateLimitSummary.totalEvents || 0,
    claude_invalid_responses: claudeSummary.rejectedResponses || 0,
    lowest_performing_symbol: lowestSymbol,
    peak_health_failures: peakHealthFailures,
    text:
      `Daily Summary ${date}: signals=${trades.length}, executed=${executedTrades.length}, ` +
      `blocked=${blockedTrades.length}, pnl=$${roundMetric(totalPnL, 2)}, ` +
      `avg latency=${avgExecutionLatency}ms, rate limits=${rateLimitSummary.totalEvents || 0}`,
  };
}

function updateTradingStatistics(log) {
  const stats = loadTradingStatistics();
  const liveStats = LiveStats.fromLog(log).stats;
  const allDates = [...new Set(log.trades.map((trade) => String(trade.timestamp || "").slice(0, 10)).filter(Boolean))];
  const dayPnls = allDates.map((date) => ({
    date,
    pnl: generateDailySummary(log, date).total_pnl,
  }));
  dayPnls.sort((a, b) => b.pnl - a.pnl);

  stats.total_runs += 1;
  stats.total_trades = liveStats.total_trades;
  stats.total_wins = liveStats.winning_trades;
  stats.total_losses = liveStats.losing_trades;
  stats.all_time_win_rate = roundMetric(liveStats.win_rate, 4);
  stats.all_time_pnl = roundMetric(liveStats.total_return, 4);
  stats.best_day = dayPnls.length > 0 ? `${dayPnls[0].date} (${dayPnls[0].pnl.toFixed(2)})` : "";
  stats.worst_day =
    dayPnls.length > 0
      ? `${dayPnls[dayPnls.length - 1].date} (${dayPnls[dayPnls.length - 1].pnl.toFixed(2)})`
      : "";
  stats.api_errors = (log.trades || []).filter((trade) => /api|network/i.test(trade.error || "")).length;
  stats.validation_failures = log.counters?.claude_validation_rejections || 0;
  stats.rate_limits_hit = getRateLimitSummary().totalEvents || 0;
  stats.last_updated_at = getAccurateTime();

  saveTradingStatistics(stats);
}

function loadClaudeResponseLog() {
  if (!existsSync(CLAUDE_RESPONSE_LOG_FILE)) {
    return { responses: [], dailySummary: {} };
  }

  const parsed = JSON.parse(readFileSync(CLAUDE_RESPONSE_LOG_FILE, "utf8"));
  return {
    responses: Array.isArray(parsed.responses) ? parsed.responses : [],
    dailySummary: parsed.dailySummary || {},
  };
}

function saveClaudeResponseLog(data) {
  writeJsonAtomic(CLAUDE_RESPONSE_LOG_FILE, data);
}

function updateClaudeResponseDailySummary(responseLog) {
  const today = new Date().toISOString().slice(0, 10);
  const todaysResponses = responseLog.responses.filter((entry) =>
    entry.timestamp.startsWith(today),
  );
  const validCount = todaysResponses.filter((entry) => entry.parsed_success).length;
  const rejectedCount = todaysResponses.filter(
    (entry) => entry.final_decision === "REJECTED",
  ).length;
  const retrySucceeded = todaysResponses.filter(
    (entry) => entry.final_decision === "RETRIED_SUCCESS",
  ).length;
  const retryFailed = todaysResponses.filter(
    (entry) => entry.final_decision === "RETRIED_FAILED",
  ).length;
  const invalidRate =
    todaysResponses.length === 0 ? 0 : rejectedCount / todaysResponses.length;

  responseLog.dailySummary[today] = {
    date: today,
    totalResponses: todaysResponses.length,
    validResponses: validCount,
    rejectedResponses: rejectedCount,
    retrySucceeded,
    retryFailed,
    invalidRate: Number((invalidRate * 100).toFixed(2)),
    alert:
      invalidRate > 0.1
        ? "Claude invalid response rate exceeded 10% today."
        : "",
    text: `Claude responses: ${todaysResponses.length}, Valid: ${validCount}, Invalid/rejected: ${rejectedCount}, Retry succeeded: ${retrySucceeded}, Retry failed: ${retryFailed}`,
  };
}

function recordClaudeResponseLog(entry) {
  const responseLog = loadClaudeResponseLog();
  responseLog.responses.push({
    timestamp: getAccurateTime(),
    ...entry,
  });
  updateClaudeResponseDailySummary(responseLog);
  saveClaudeResponseLog(responseLog);
}

function getClaudeResponseSummary(date = new Date().toISOString().slice(0, 10)) {
  const responseLog = loadClaudeResponseLog();
  return (
    responseLog.dailySummary[date] || {
      date,
      totalResponses: 0,
      validResponses: 0,
      rejectedResponses: 0,
      retrySucceeded: 0,
      retryFailed: 0,
      invalidRate: 0,
      alert: "",
      text: "Claude responses: 0, Valid: 0, Invalid/rejected: 0, Retry succeeded: 0, Retry failed: 0",
    }
  );
}

function loadBacktestBaseline() {
  if (!existsSync(BACKTEST_BASELINE_FILE)) {
    return null;
  }
  return JSON.parse(readFileSync(BACKTEST_BASELINE_FILE, "utf8"));
}

function saveBacktestBaseline(data) {
  writeJsonAtomic(BACKTEST_BASELINE_FILE, data);
}

function loadForwardTestLog() {
  if (!existsSync(FORWARD_TEST_LOG_FILE)) {
    return { trades: [], reports: [], alerts: [] };
  }
  const parsed = JSON.parse(readFileSync(FORWARD_TEST_LOG_FILE, "utf8"));
  return {
    trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    reports: Array.isArray(parsed.reports) ? parsed.reports : [],
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
  };
}

function saveForwardTestLog(data) {
  writeJsonAtomic(FORWARD_TEST_LOG_FILE, data);
}

function roundMetric(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function calculatePerformanceStats(trades) {
  const normalizedTrades = trades.filter(
    (trade) => Number.isFinite(trade.pnl) && Number.isFinite(trade.entry_price),
  );
  const winningTrades = normalizedTrades.filter((trade) => trade.pnl > 0);
  const losingTrades = normalizedTrades.filter((trade) => trade.pnl < 0);
  const grossProfit = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLossMagnitude = Math.abs(
    losingTrades.reduce((sum, trade) => sum + trade.pnl, 0),
  );
  const totalReturn = normalizedTrades.reduce((sum, trade) => sum + trade.pnl, 0);

  let equity = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  const returns = [];
  for (const trade of normalizedTrades) {
    equity += trade.pnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peakEquity);
    if (trade.trade_size_usd > 0) {
      returns.push(trade.pnl / trade.trade_size_usd);
    }
  }

  const avgReturn =
    returns.length === 0
      ? 0
      : returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.length === 0
      ? 0
      : returns.reduce((sum, value) => sum + (value - avgReturn) ** 2, 0) /
        returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev === 0 ? 0 : (avgReturn / stdDev) * Math.sqrt(returns.length);

  return {
    total_trades: normalizedTrades.length,
    winning_trades: winningTrades.length,
    losing_trades: losingTrades.length,
    win_rate:
      normalizedTrades.length === 0
        ? 0
        : winningTrades.length / normalizedTrades.length,
    avg_win:
      winningTrades.length === 0
        ? 0
        : grossProfit / winningTrades.length,
    avg_loss:
      losingTrades.length === 0
        ? 0
        : losingTrades.reduce((sum, trade) => sum + trade.pnl, 0) /
          losingTrades.length,
    profit_factor:
      grossLossMagnitude === 0
        ? grossProfit > 0
          ? grossProfit
          : 0
        : grossProfit / grossLossMagnitude,
    total_return: totalReturn,
    max_drawdown: maxDrawdown,
    sharpe_ratio: sharpeRatio,
  };
}

class BacktestRunner {
  constructor(rules, candles, exchangeName = "Binance") {
    this.rules = rules;
    this.candles = candles;
    this.exchangeName = exchangeName;
  }

  run() {
    const trades = [];
    const warmup = 20;
    const tradeSizeUsd = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

    for (let i = warmup; i < this.candles.length - 2; i++) {
      const history = this.candles.slice(0, i + 1);
      const closes = history.map((candle) => candle.close);
      const price = closes[closes.length - 1];
      const ema8 = calcEMA(closes, 8);
      const vwap = calcVWAP(history, history[history.length - 1].time);
      const rsi3 = calcRSI(closes, 3);

      if (!Number.isFinite(ema8) || !Number.isFinite(vwap) || !Number.isFinite(rsi3)) {
        continue;
      }

      const { allPass } = runSafetyCheck(price, ema8, vwap, rsi3, this.rules, {
        silent: true,
      });
      if (!allPass) {
        continue;
      }

      const entryCandle = this.candles[i + 1];
      const exitCandle = this.candles[Math.min(i + 2, this.candles.length - 1)];
      const entryPrice =
        entryCandle.open * (1 + CONFIG.backtestSlippagePercent / 100);
      const exitPrice =
        exitCandle.close * (1 - CONFIG.backtestSlippagePercent / 100);
      const quantity = tradeSizeUsd / entryPrice;
      const grossPnl = (exitPrice - entryPrice) * quantity;
      const commission = tradeSizeUsd * (CONFIG.backtestCommissionPercent / 100) * 2;
      const pnl = grossPnl - commission;
      const pnlPercent = tradeSizeUsd === 0 ? 0 : (pnl / tradeSizeUsd) * 100;

      trades.push({
        trade_number: trades.length + 1,
        timestamp: new Date(entryCandle.time).toISOString(),
        symbol: CONFIG.symbol,
        side: "BUY",
        entry_price: roundMetric(entryPrice, 6),
        exit_price: roundMetric(exitPrice, 6),
        pnl: roundMetric(pnl, 6),
        pnl_percent: roundMetric(pnlPercent, 4),
        trade_size_usd: roundMetric(tradeSizeUsd, 4),
        holding_candles: 1,
        exchange: this.exchangeName,
      });
    }

    return {
      trades,
      stats: calculatePerformanceStats(trades),
    };
  }
}

class LiveStats {
  constructor(trades = []) {
    this.trades = trades;
    this.stats = calculatePerformanceStats(trades);
  }

  static fromLog(log) {
    const trades = log.trades
      .filter(
        (trade) =>
          trade.orderPlaced &&
          Number.isFinite(trade.tradeSize) &&
          Number.isFinite(trade.actualPrice || trade.price),
      )
      .map((trade, index) => {
        const executionPenalty =
          trade.tradeSize * ((Math.abs(trade.slippagePercent || 0) / 100) + 0.001);
        const pnl = -executionPenalty;
        return {
          trade_number: index + 1,
          timestamp: trade.timestamp,
          symbol: trade.symbol,
          side: trade.side || "BUY",
          entry_price: Number(trade.actualPrice || trade.price || 0),
          exit_price: Number(trade.actualPrice || trade.price || 0),
          pnl: roundMetric(pnl, 6),
          pnl_percent:
            trade.tradeSize > 0 ? roundMetric((pnl / trade.tradeSize) * 100, 4) : 0,
          trade_size_usd: roundMetric(trade.tradeSize, 4),
          order_id: trade.orderId || "",
          source: "live_execution_log",
        };
      });

    return new LiveStats(trades);
  }
}

function calculateDivergencePercent(liveValue, baselineValue) {
  if (!Number.isFinite(baselineValue) || baselineValue === 0) {
    return null;
  }
  return ((liveValue - baselineValue) / Math.abs(baselineValue)) * 100;
}

function classifyDivergence(divergences) {
  const exceeded = Object.values(divergences)
    .filter((value) => value !== null)
    .map((value) => Math.abs(value));
  if (exceeded.some((value) => value >= CONFIG.divergenceAlertThreshold * 2)) {
    return "RED";
  }
  if (exceeded.some((value) => value >= CONFIG.divergenceAlertThreshold)) {
    return "YELLOW";
  }
  return "GREEN";
}

function checkForOverfitting(liveStats, baselineStats) {
  const findings = [];
  if (baselineStats.win_rate - liveStats.win_rate >= 0.15) {
    findings.push("Win rate in live trading is 15%+ below backtest.");
  }
  if (
    Math.abs(baselineStats.max_drawdown) > 0 &&
    Math.abs(liveStats.max_drawdown) >= Math.abs(baselineStats.max_drawdown) * 2
  ) {
    findings.push("Live max drawdown is at least 2x the backtest drawdown.");
  }
  if (
    liveStats.total_trades >= CONFIG.backtestIntervalTrades &&
    liveStats.total_return < baselineStats.total_return * 0.5
  ) {
    findings.push("Live total return is materially worse than backtest expectation.");
  }

  return {
    detected: findings.length > 0,
    findings,
    recommendation: findings.length
      ? "Consider pausing trading and reviewing parameter robustness."
      : "No strong overfitting signal detected from available live data.",
  };
}

function generateBacktestVsLiveReport(baseline, liveStats, analysis) {
  const baselineStats = baseline.stats;
  const lines = [
    "BACKTEST VS LIVE REPORT",
    "=======================",
    `Backtest Trades: ${baselineStats.total_trades} | Live Trades: ${liveStats.total_trades}`,
    "",
    "METRIC | BACKTEST | LIVE | DIVERGENCE",
    "Win Rate | " +
      `${(baselineStats.win_rate * 100).toFixed(2)}% | ${(liveStats.win_rate * 100).toFixed(2)}% | ` +
      `${analysis.divergences.win_rate === null ? "N/A" : `${analysis.divergences.win_rate.toFixed(2)}%`}`,
    "Avg Loss | " +
      `${baselineStats.avg_loss.toFixed(2)} | ${liveStats.avg_loss.toFixed(2)} | ` +
      `${analysis.divergences.avg_loss === null ? "N/A" : `${analysis.divergences.avg_loss.toFixed(2)}%`}`,
    "Profit Factor | " +
      `${baselineStats.profit_factor.toFixed(2)} | ${liveStats.profit_factor.toFixed(2)} | ` +
      `${analysis.divergences.profit_factor === null ? "N/A" : `${analysis.divergences.profit_factor.toFixed(2)}%`}`,
    "Max Drawdown | " +
      `${baselineStats.max_drawdown.toFixed(2)} | ${liveStats.max_drawdown.toFixed(2)} | ` +
      `${analysis.divergences.max_drawdown === null ? "N/A" : `${analysis.divergences.max_drawdown.toFixed(2)}%`}`,
    "Total Return | " +
      `${baselineStats.total_return.toFixed(2)} | ${liveStats.total_return.toFixed(2)} | ` +
      `${analysis.divergences.total_return === null ? "N/A" : `${analysis.divergences.total_return.toFixed(2)}%`}`,
    "",
    `ASSESSMENT: ${analysis.overall_health}`,
    `RECOMMENDATION: ${analysis.recommendation}`,
  ];
  return lines.join("\n");
}

function analyzeLiveVsBacktest(log, baseline) {
  const liveStatsInstance = LiveStats.fromLog(log);
  const liveStats = liveStatsInstance.stats;
  const baselineStats = baseline.stats;
  const divergences = {
    win_rate: calculateDivergencePercent(liveStats.win_rate, baselineStats.win_rate),
    avg_loss: calculateDivergencePercent(liveStats.avg_loss, baselineStats.avg_loss),
    profit_factor: calculateDivergencePercent(
      liveStats.profit_factor,
      baselineStats.profit_factor,
    ),
    max_drawdown: calculateDivergencePercent(
      Math.abs(liveStats.max_drawdown),
      Math.abs(baselineStats.max_drawdown),
    ),
    total_return: calculateDivergencePercent(
      liveStats.total_return,
      baselineStats.total_return,
    ),
  };
  const overall_health = classifyDivergence(divergences);
  const overfitting = checkForOverfitting(liveStats, baselineStats);
  const recommendation =
    overall_health === "RED" || overfitting.detected
      ? "PAUSE trading and review assumptions."
      : overall_health === "YELLOW"
        ? "Monitor closely; live execution is diverging from baseline."
        : "Live performance is within the current tolerance band.";

  return {
    metrics: {
      backtest: baselineStats,
      live: liveStats,
    },
    divergences,
    overall_health,
    overfitting,
    recommendation,
    report: generateBacktestVsLiveReport(baseline, liveStats, {
      divergences,
      overall_health,
      recommendation,
    }),
    liveTradeCount: liveStats.total_trades,
  };
}

function recordForwardTestTrade(logEntry, baseline) {
  if (!logEntry.orderPlaced || !Number.isFinite(logEntry.tradeSize)) {
    return;
  }

  const forwardLog = loadForwardTestLog();
  const entryPrice = Number(logEntry.actualPrice || logEntry.price || 0);
  const pnl = -(
    logEntry.tradeSize * ((Math.abs(logEntry.slippagePercent || 0) / 100) + 0.001)
  );
  const baselineEdge =
    baseline?.stats?.avg_win && baseline?.stats?.avg_loss
      ? roundMetric(
          baseline.stats.avg_win /
            Math.max(Math.abs(baseline.stats.avg_loss), 0.0001),
          4,
        )
      : 0;

  forwardLog.trades.push({
    trade_number: forwardLog.trades.length + 1,
    timestamp: logEntry.timestamp,
    symbol: logEntry.symbol,
    side: logEntry.side || "BUY",
    entry_price: entryPrice,
    exit_price: entryPrice,
    pnl: roundMetric(pnl, 6),
    pnl_percent:
      logEntry.tradeSize > 0 ? roundMetric((pnl / logEntry.tradeSize) * 100, 4) : 0,
    backtest_edge: baselineEdge,
    live_result_vs_prediction: pnl >= 0 ? "BETTER" : "WORSE",
    order_id: logEntry.orderId || "",
  });

  saveForwardTestLog(forwardLog);
}

async function runInitialBacktest(rules) {
  const candles = await fetchCandles(
    CONFIG.symbol,
    CONFIG.timeframe,
    CONFIG.backtestLookbackCandles,
  );
  const runner = new BacktestRunner(rules, candles, "Binance");
  const result = runner.run();
  const baseline = {
    timestamp: getAccurateTime(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    lookback_candles: CONFIG.backtestLookbackCandles,
    exchange: "Binance",
    trades: result.trades,
    stats: result.stats,
    assumptions: {
      slippage_percent: CONFIG.backtestSlippagePercent,
      commission_percent: CONFIG.backtestCommissionPercent,
      live_stats_note:
        "Live reconciliation currently uses realized execution-cost outcomes from entry logs because full exit/PnL tracking is not yet implemented in the bot.",
    },
    summary_text:
      `Backtest: ${result.stats.total_trades} trades, ` +
      `${(result.stats.win_rate * 100).toFixed(2)}% win rate, ` +
      `$${result.stats.total_return.toFixed(2)} total return`,
  };
  saveBacktestBaseline(baseline);
  return baseline;
}

class ResponseValidator {
  validateSchema(response) {
    const errors = [];
    const requiredFields = {
      should_enter: "boolean",
      entry_price: "number",
      side: "string",
      confidence: "number",
      reason: "string",
      stop_loss: "number",
      take_profit: "number",
    };

    for (const [field, type] of Object.entries(requiredFields)) {
      if (!(field in response)) {
        errors.push(`Missing required field: ${field}`);
        continue;
      }

      if (typeof response[field] !== type || Number.isNaN(response[field])) {
        errors.push(`Invalid type for ${field}: expected ${type}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  validateRanges(response, currentPrice) {
    const errors = [];
    const side = String(response.side || "").toUpperCase();

    if (response.confidence < 0 || response.confidence > 1) {
      errors.push("confidence must be between 0 and 1");
    }

    if (response.should_enter) {
      const entryDeviationPercent =
        (Math.abs(response.entry_price - currentPrice) / currentPrice) * 100;
      if (entryDeviationPercent > CONFIG.maxClaudePriceRangePercent) {
        errors.push(
          `entry_price deviates ${entryDeviationPercent.toFixed(2)}% from current price`,
        );
      }
    }

    if (!["BUY", "SELL"].includes(side)) {
      errors.push("side must be BUY or SELL");
    }

    const stopDistancePercent =
      response.entry_price === 0
        ? 0
        : (Math.abs(response.stop_loss - response.entry_price) /
            response.entry_price) *
          100;
    const takeProfitDistancePercent =
      response.entry_price === 0
        ? 0
        : (Math.abs(response.take_profit - response.entry_price) /
            response.entry_price) *
          100;

    if (side === "BUY") {
      if (response.stop_loss >= response.entry_price) {
        errors.push("stop_loss must be below entry_price for BUY");
      }
      if (response.take_profit <= response.entry_price) {
        errors.push("take_profit must be above entry_price for BUY");
      }
    }

    if (side === "SELL") {
      if (response.stop_loss <= response.entry_price) {
        errors.push("stop_loss must be above entry_price for SELL");
      }
      if (response.take_profit >= response.entry_price) {
        errors.push("take_profit must be below entry_price for SELL");
      }
    }

    if (stopDistancePercent < 0.1) {
      errors.push("stop_loss must be at least 0.1% away from entry_price");
    }
    if (takeProfitDistancePercent < 0.5) {
      errors.push("take_profit must be at least 0.5% away from entry_price");
    }

    return { valid: errors.length === 0, errors };
  }

  validateLogic(response) {
    const errors = [];
    const warnings = [];

    if (!response.should_enter && response.entry_price > 0) {
      warnings.push("should_enter is false but entry_price is populated");
    }

    if (response.should_enter && response.confidence < CONFIG.minConfidenceThreshold) {
      warnings.push("low confidence entry");
    }

    const stopDistancePercent =
      response.entry_price === 0
        ? 0
        : (Math.abs(response.stop_loss - response.entry_price) /
            response.entry_price) *
          100;
    if (response.confidence > 0.9 && stopDistancePercent < 0.2) {
      warnings.push("unrealistic confidence with very tight stop loss");
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}

function extractJsonCandidate(rawText) {
  if (typeof rawText !== "string") return "";

  const direct = rawText.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) {
    return direct;
  }

  const codeBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return rawText.slice(firstBrace, lastBrace + 1).trim();
  }

  return "";
}

function parseClaudeResponse(rawText, currentPrice) {
  const validator = new ResponseValidator();
  const errors = [];
  const warnings = [];
  const jsonCandidate = extractJsonCandidate(rawText);

  if (!jsonCandidate) {
    return {
      success: false,
      data: null,
      errors: ["INVALID_JSON"],
      warnings,
      raw: rawText,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (error) {
    return {
      success: false,
      data: null,
      errors: ["INVALID_JSON", error.message],
      warnings,
      raw: rawText,
    };
  }

  const schema = validator.validateSchema(parsed);
  errors.push(...schema.errors);

  if (schema.valid) {
    const ranges = validator.validateRanges(parsed, currentPrice);
    errors.push(...ranges.errors);

    const logic = validator.validateLogic(parsed);
    errors.push(...logic.errors);
    warnings.push(...logic.warnings);

    if (parsed.should_enter) {
      const staleDeviationPercent =
        (Math.abs(parsed.entry_price - currentPrice) / currentPrice) * 100;
      if (staleDeviationPercent > CONFIG.maxEntryPriceDeviationPercent) {
        warnings.push(
          `STALE_PRICE entry deviates ${staleDeviationPercent.toFixed(2)}% from current price`,
        );
      }
      if (staleDeviationPercent > 10) {
        errors.push(
          `STALE_PRICE_HARD_REJECT entry deviates ${staleDeviationPercent.toFixed(2)}% from current price`,
        );
      }
    }
  }

  return {
    success: errors.length === 0,
    data: parsed,
    errors,
    warnings,
    raw: rawText,
  };
}

function validateTradeSize(suggestedSize, log, context = {}) {
  const size = Number(suggestedSize);
  if (!Number.isFinite(size) || size <= 0) {
    return {
      size: Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD),
      wasCapped: true,
      reason: "Invalid Claude trade size; defaulted to conservative size",
    };
  }

  const cappedByTradeLimit = Math.min(size, CONFIG.maxTradeSizeUSD);
  const tradesToday = countTodaysTrades(log);
  if (tradesToday >= CONFIG.maxTradesPerDay) {
    return {
      size: 0,
      wasCapped: true,
      reason: "Daily trade cap reached",
      ...context,
    };
  }

  return {
    size: cappedByTradeLimit,
    wasCapped: cappedByTradeLimit !== size,
    reason:
      cappedByTradeLimit !== size
        ? "Claude trade size capped at MAX_TRADE_SIZE_USD"
        : "Claude trade size accepted",
  };
}

function compareClaudeVsStrategy(strategyDecision, claudeDecision, log) {
  const strategySide = strategyDecision.allPass ? "BUY" : "NO_TRADE";
  const claudeSide =
    claudeDecision?.should_enter === true
      ? String(claudeDecision.side || "").toUpperCase()
      : "NO_TRADE";
  const aligned =
    strategySide === claudeSide ||
    (!strategyDecision.allPass && claudeDecision?.should_enter === false);

  const result = {
    aligned,
    strategyDecision: strategySide,
    claudeDecision: claudeSide,
    finalDecision:
      strategyDecision.allPass &&
      claudeDecision?.should_enter === true &&
      claudeSide === "BUY"
        ? "BUY"
        : "NO_TRADE",
    reason: aligned
      ? "Claude and strategy agree"
      : `Strategy says ${strategySide} while Claude says ${claudeSide}`,
  };

  recordSafetyCheck(log, "CLAUDE_STRATEGY_COMPARISON", result);
  return result;
}

function loadClaudeSignalInput() {
  if (CONFIG.claudeRawResponse) {
    return CONFIG.claudeRawResponse;
  }

  if (CONFIG.claudeSignalFile && existsSync(CONFIG.claudeSignalFile)) {
    return readFileSync(CONFIG.claudeSignalFile, "utf8");
  }

  return "";
}

async function getSaneResponse(rawText, currentPrice, log, options = {}) {
  if (!rawText) {
    return {
      success: false,
      data: null,
      errors: ["NO_CLAUDE_RESPONSE_PROVIDED"],
      warnings: [],
      finalDecision: "SKIPPED",
    };
  }

  const maxAttempts = CONFIG.allowClaudeRetryOnInvalid
    ? Math.max(0, CONFIG.maxValidationRetries)
    : 0;
  let attempt = 0;
  let lastResult = null;

  while (attempt <= maxAttempts) {
    const parseResult = parseClaudeResponse(rawText, currentPrice);
    lastResult = parseResult;

    if (parseResult.success) {
      recordClaudeResponseLog({
        raw_response: rawText,
        parsed_success: true,
        validation_errors: [],
        validation_warnings: parseResult.warnings,
        final_decision: attempt === 0 ? "ACCEPTED" : "RETRIED_SUCCESS",
        reason: "Claude response passed validation",
      });
      return {
        ...parseResult,
        finalDecision: attempt === 0 ? "ACCEPTED" : "RETRIED_SUCCESS",
      };
    }

    recordClaudeResponseLog({
      raw_response: rawText,
      parsed_success: false,
      validation_errors: parseResult.errors,
      validation_warnings: parseResult.warnings,
      final_decision:
        attempt < maxAttempts ? "RETRIED" : "RETRIED_FAILED",
      reason: parseResult.errors.join("; "),
    });

    recordSafetyCheck(log, "CLAUDE_RESPONSE_REJECTED", {
      attempt: attempt + 1,
      errors: parseResult.errors,
      warnings: parseResult.warnings,
    });

    if (attempt >= maxAttempts || typeof options.retryProvider !== "function") {
      break;
    }

    rawText = await options.retryProvider({
      rawText,
      errors: parseResult.errors,
      warnings: parseResult.warnings,
      attempt: attempt + 1,
    });
    attempt += 1;
  }

  return {
    ...lastResult,
    success: false,
    data: null,
    finalDecision: "REJECTED",
  };
}

function loadRateLimitEvents() {
  if (!existsSync(RATE_LIMIT_LOG_FILE)) {
    return { events: [], dailySummary: {} };
  }

  const parsed = JSON.parse(readFileSync(RATE_LIMIT_LOG_FILE, "utf8"));
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    dailySummary: parsed.dailySummary || {},
  };
}

function saveRateLimitEvents(data) {
  writeFileSync(RATE_LIMIT_LOG_FILE, JSON.stringify(data, null, 2));
}

function updateRateLimitDailySummary(rateLimitLog) {
  const today = new Date().toISOString().slice(0, 10);
  const todaysEvents = rateLimitLog.events.filter((event) =>
    event.timestamp.startsWith(today),
  );
  const successCount = todaysEvents.filter(
    (event) => event.status === "RATE_LIMITED_RETRY_SUCCESS",
  ).length;
  const abandonedCount = todaysEvents.filter(
    (event) => event.status === "RATE_LIMITED_ABANDONED",
  ).length;
  const avgWaitSeconds =
    todaysEvents.length === 0
      ? 0
      : todaysEvents.reduce((sum, event) => sum + (event.waitTimeMs || 0), 0) /
        todaysEvents.length /
        1000;

  rateLimitLog.dailySummary[today] = {
    date: today,
    totalEvents: todaysEvents.length,
    successfulRetries: successCount,
    abandonedRequests: abandonedCount,
    avgWaitSeconds: Number(avgWaitSeconds.toFixed(3)),
    text: `Rate limited ${todaysEvents.length} times today, avg wait ${avgWaitSeconds.toFixed(1)}s, ${abandonedCount} abandoned trade${abandonedCount === 1 ? "" : "s"}`,
  };
}

function recordRateLimitEvent(event) {
  const rateLimitLog = loadRateLimitEvents();
  rateLimitLog.events.push({
    timestamp: new Date().toISOString(),
    ...event,
  });
  updateRateLimitDailySummary(rateLimitLog);
  saveRateLimitEvents(rateLimitLog);
}

function getRateLimitSummary() {
  const rateLimitLog = loadRateLimitEvents();
  const today = new Date().toISOString().slice(0, 10);
  return (
    rateLimitLog.dailySummary[today] || {
      date: today,
      totalEvents: 0,
      successfulRetries: 0,
      abandonedRequests: 0,
      avgWaitSeconds: 0,
      text: "Rate limited 0 times today, avg wait 0.0s, 0 abandoned trades",
    }
  );
}

function loadHealthLog() {
  if (!existsSync(HEALTH_CHECK_LOG_FILE)) {
    return { checks: [] };
  }

  const parsed = JSON.parse(readFileSync(HEALTH_CHECK_LOG_FILE, "utf8"));
  return {
    checks: Array.isArray(parsed.checks) ? parsed.checks : [],
  };
}

function saveHealthLog(data) {
  writeFileSync(HEALTH_CHECK_LOG_FILE, JSON.stringify(data, null, 2));
}

function loadHealthSummary() {
  if (!existsSync(HEALTH_CHECK_SUMMARY_FILE)) {
    return {
      daily: {},
      state: {
        lastOverallStatus: "healthy",
        lastAlertedStatus: "healthy",
        lastCheckAt: null,
        lastHealthyAt: null,
        latest: null,
      },
    };
  }

  const parsed = JSON.parse(readFileSync(HEALTH_CHECK_SUMMARY_FILE, "utf8"));
  return {
    daily: parsed.daily || {},
    state: parsed.state || {
      lastOverallStatus: "healthy",
      lastAlertedStatus: "healthy",
      lastCheckAt: null,
      lastHealthyAt: null,
      latest: null,
    },
  };
}

function saveHealthSummary(data) {
  writeFileSync(HEALTH_CHECK_SUMMARY_FILE, JSON.stringify(data, null, 2));
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

function loadTradeStateMachine() {
  if (!existsSync(TRADE_STATE_MACHINE_FILE)) {
    return { trades: [] };
  }
  const parsed = JSON.parse(readFileSync(TRADE_STATE_MACHINE_FILE, "utf8"));
  return { trades: Array.isArray(parsed.trades) ? parsed.trades : [] };
}

function saveTradeStateMachine(data) {
  writeFileSync(TRADE_STATE_MACHINE_FILE, JSON.stringify(data, null, 2));
}

function recordTradeState(stateEntry) {
  const machine = loadTradeStateMachine();
  machine.trades.push({
    timestamp: new Date().toISOString(),
    ...stateEntry,
  });
  saveTradeStateMachine(machine);
}

function loadTradeConfirmations() {
  if (!existsSync(TRADE_CONFIRMATIONS_FILE)) {
    return { confirmations: [], summary: {} };
  }
  const parsed = JSON.parse(readFileSync(TRADE_CONFIRMATIONS_FILE, "utf8"));
  return {
    confirmations: Array.isArray(parsed.confirmations)
      ? parsed.confirmations
      : [],
    summary: parsed.summary || {},
  };
}

function saveTradeConfirmations(data) {
  writeFileSync(TRADE_CONFIRMATIONS_FILE, JSON.stringify(data, null, 2));
}

function recordTradeConfirmation(entry) {
  const data = loadTradeConfirmations();
  data.confirmations.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });

  const today = new Date().toISOString().slice(0, 10);
  const todays = data.confirmations.filter((item) =>
    item.timestamp.startsWith(today),
  );
  const confirmed = todays.filter((item) => item.filled).length;
  const avgLatency =
    todays.length === 0
      ? 0
      : todays.reduce(
          (sum, item) => sum + (item.confirmation_latency_ms || 0),
          0,
        ) / todays.length;

  data.summary[today] = {
    tradesSubmitted: todays.length,
    tradesConfirmed: confirmed,
    avgConfirmationLatencyMs: Number(avgLatency.toFixed(2)),
    text: `Trades submitted: ${todays.length}, Trades confirmed: ${confirmed}, Avg confirmation latency: ${(avgLatency / 1000).toFixed(2)}s`,
  };

  saveTradeConfirmations(data);
}

function loadPendingOrders() {
  if (!existsSync(PENDING_ORDERS_FILE)) {
    return { orders: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(PENDING_ORDERS_FILE, "utf8"));
    return { orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
  } catch (error) {
    recordSecurityAudit("LOAD_PENDING_ORDERS", false, error.message);
    return { orders: [] };
  }
}

function savePendingOrders(data) {
  writeJsonAtomic(PENDING_ORDERS_FILE, data);
}

function loadOrderStateSummary() {
  if (!existsSync(ORDER_STATE_SUMMARY_FILE)) {
    return { daily: {} };
  }
  const parsed = JSON.parse(readFileSync(ORDER_STATE_SUMMARY_FILE, "utf8"));
  return { daily: parsed.daily || {} };
}

function saveOrderStateSummary(data) {
  writeJsonAtomic(ORDER_STATE_SUMMARY_FILE, data);
}

class PersistentOrderTracker {
  load() {
    return loadPendingOrders();
  }

  save(data) {
    savePendingOrders(data);
  }

  upsert(order) {
    const data = this.load();
    const index = data.orders.findIndex((item) => item.order_id === order.order_id);
    const nextOrder = {
      ...order,
      status_updated_timestamp: new Date().toISOString(),
    };

    if (index >= 0) {
      data.orders[index] = { ...data.orders[index], ...nextOrder };
    } else {
      data.orders.push(nextOrder);
    }

    this.save(data);
    return nextOrder;
  }

  remove(orderId) {
    const data = this.load();
    data.orders = data.orders.filter((item) => item.order_id !== orderId);
    this.save(data);
  }
}

const persistentOrderTracker = new PersistentOrderTracker();
let timeSyncState = {
  offsetMs: 0,
  lastCheckAt: null,
  source: "system",
  interval: null,
};

function getAccurateTimeMs() {
  return nowMs() + (timeSyncState.offsetMs || 0);
}

function getAccurateTime() {
  return new Date(getAccurateTimeMs()).toISOString();
}

function loadTimeSyncLog() {
  if (!existsSync(TIME_SYNC_LOG_FILE)) {
    return { checks: [], dailySummary: {} };
  }
  const parsed = JSON.parse(readFileSync(TIME_SYNC_LOG_FILE, "utf8"));
  return {
    checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    dailySummary: parsed.dailySummary || {},
  };
}

function saveTimeSyncLog(data) {
  writeJsonAtomic(TIME_SYNC_LOG_FILE, data);
}

function recordTimeSync(entry) {
  const data = loadTimeSyncLog();
  data.checks.push(entry);
  const today = entry.timestamp.slice(0, 10);
  const todays = data.checks.filter((item) => item.timestamp.startsWith(today));
  const avgOffset =
    todays.length === 0
      ? 0
      : todays.reduce((sum, item) => sum + item.offset_ms, 0) / todays.length;
  const maxDrift =
    todays.length === 0
      ? 0
      : Math.max(...todays.map((item) => Math.abs(item.offset_ms)));

  data.dailySummary[today] = {
    checks: todays.length,
    averageOffsetMs: Number(avgOffset.toFixed(2)),
    maxDriftMs: maxDrift,
    text: `Time syncs: ${todays.length}, Average offset: ${avgOffset.toFixed(0)}ms, Max drift: ${(maxDrift / 1000).toFixed(2)} seconds`,
  };
  saveTimeSyncLog(data);
}

class TimeSync {
  async fetchExchangeServerTime() {
    const response = await fetch("https://api.binance.com/api/v3/time");
    if (!response.ok) {
      throw new Error(`Exchange server time fetch failed: ${response.status}`);
    }
    const data = await response.json();
    return data.serverTime;
  }

  async fetchNtpTime() {
    const server = CONFIG.ntpServers[0] || "pool.ntp.org";
    const started = nowMs();
    const response = await fetch(`https://worldtimeapi.org/api/timezone/Etc/UTC`);
    if (!response.ok) {
      throw new Error(`NTP fallback fetch failed for ${server}: ${response.status}`);
    }
    const data = await response.json();
    const ntpTime = new Date(data.utc_datetime).getTime();
    return {
      ntpTime,
      source: "NTP",
      latency: nowMs() - started,
    };
  }

  async getSystemClockOffset() {
    const systemTime = nowMs();
    try {
      const exchangeTime = await this.fetchExchangeServerTime();
      return {
        offset_ms: exchangeTime - systemTime,
        system_time_ms: systemTime,
        ntp_time_ms: exchangeTime,
        source: "EXCHANGE",
      };
    } catch (exchangeError) {
      const ntp = await this.fetchNtpTime();
      return {
        offset_ms: ntp.ntpTime - systemTime,
        system_time_ms: systemTime,
        ntp_time_ms: ntp.ntpTime,
        source: ntp.source,
      };
    }
  }

  async validateTimestamp() {
    const data = await this.getSystemClockOffset();
    const absoluteOffset = Math.abs(data.offset_ms);
    return {
      ...data,
      is_valid: absoluteOffset <= CONFIG.maxAllowedClockSkewMs,
      drift_detected: absoluteOffset > 2000,
    };
  }
}

async function checkTimeSync() {
  const timeSync = new TimeSync();
  const result = await timeSync.validateTimestamp();
  timeSyncState.offsetMs = result.offset_ms;
  timeSyncState.lastCheckAt = getAccurateTime();
  timeSyncState.source = result.source;

  recordTimeSync({
    timestamp: new Date(nowMs()).toISOString(),
    system_time_ms: result.system_time_ms,
    ntp_time_ms: result.ntp_time_ms,
    offset_ms: result.offset_ms,
    is_valid: result.is_valid,
    source: result.source,
  });

  if (!result.is_valid) {
    const direction = result.offset_ms > 0 ? "behind" : "ahead";
    const message = `System clock is ${Math.abs(result.offset_ms)}ms ${direction}.`;
    recordSafetyCheck(loadLog(), "SYSTEM_CLOCK_SKEW_DETECTED", {
      offset_ms: result.offset_ms,
      direction,
      source: result.source,
    });
    if (CONFIG.pauseTradingIfSkew) {
      return { valid: false, message };
    }
    return { valid: true, message };
  }

  return {
    valid: true,
    message: `Time sync valid (offset ${result.offset_ms}ms via ${result.source})`,
  };
}

function startClockDriftMonitor() {
  if (timeSyncState.interval) {
    clearInterval(timeSyncState.interval);
  }
  timeSyncState.interval = setInterval(() => {
    checkTimeSync().catch((error) => {
      console.log(`⚠️ Clock drift check failed — ${error.message}`);
    });
  }, CONFIG.clockCheckIntervalHours * 60 * 60 * 1000);
  timeSyncState.interval.unref?.();
}

function stopClockDriftMonitor() {
  if (timeSyncState.interval) {
    clearInterval(timeSyncState.interval);
    timeSyncState.interval = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ApiRequestQueue {
  constructor(minSpacingMs = CONFIG.minRequestSpacingMs) {
    this.minSpacingMs = minSpacingMs;
    this.queue = [];
    this.processing = false;
    this.lastRunAt = 0;
  }

  enqueue(requestFactory, context = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFactory, context, resolve, reject });
      this.process().catch((error) => {
        console.error("API queue processing failed:", error);
      });
    });
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const next = this.queue.shift();
      const waitMs = Math.max(
        0,
        this.minSpacingMs - (Date.now() - this.lastRunAt),
      );

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      try {
        const result = await next.requestFactory(next.context);
        this.lastRunAt = Date.now();
        next.resolve(result);
      } catch (error) {
        this.lastRunAt = Date.now();
        next.reject(error);
      }
    }

    this.processing = false;
  }
}

const apiRequestQueue = new ApiRequestQueue();
let openPositionsCache = {
  timestamp: 0,
  symbol: null,
  data: [],
};

async function executeWithRetry(
  apiFunction,
  maxRetries = CONFIG.maxApiRetries,
  context = {},
) {
  let totalWaitMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await apiFunction();
      if (attempt > 0) {
        recordRateLimitEvent({
          endpoint: context.endpoint || "unknown",
          context: context.description || "exchange_call",
          attempt,
          waitTimeMs: totalWaitMs,
          success: true,
          status: "RATE_LIMITED_RETRY_SUCCESS",
        });
      }

      return {
        success: true,
        data,
        retriesUsed: attempt,
        totalWaitMs,
      };
    } catch (error) {
      const isRateLimited =
        error?.isRateLimitError ||
        error?.status === 429 ||
        /429|rate limit/i.test(error?.message || "");

      if (!isRateLimited) {
        throw error;
      }

      if (attempt >= maxRetries) {
        recordRateLimitEvent({
          endpoint: context.endpoint || "unknown",
          context: context.description || "exchange_call",
          attempt,
          waitTimeMs: totalWaitMs,
          success: false,
          status: "RATE_LIMITED_ABANDONED",
        });
        return {
          success: false,
          data: null,
          retriesUsed: attempt,
          totalWaitMs,
        };
      }

      const waitMs =
        CONFIG.rateLimitBackoffBaseMs * Math.pow(2, attempt) +
        Math.floor(Math.random() * 1000);
      totalWaitMs += waitMs;

      recordRateLimitEvent({
        endpoint: context.endpoint || "unknown",
        context: context.description || "exchange_call",
        attempt,
        waitTimeMs: waitMs,
        success: false,
        status: "RATE_LIMITED_RETRYING",
      });

      await sleep(waitMs);
    }
  }

  return {
    success: false,
    data: null,
    retriesUsed: maxRetries,
    totalWaitMs,
  };
}

let latestHealthCheck = null;
let healthMonitorInterval = null;

class HealthCheck {
  constructor(config = CONFIG) {
    this.config = config;
  }

  isComponentRequired(component) {
    return this.config.healthRequiredComponents.includes(component);
  }

  async checkTradingViewConnection() {
    const lastChecked = new Date().toISOString();
    const start = Date.now();

    if (!this.config.tradingViewHealthCommand) {
      return {
        component: "tradingview",
        status: this.isComponentRequired("tradingview") ? "unhealthy" : "healthy",
        lastChecked,
        latency: 0,
        reason: this.isComponentRequired("tradingview")
          ? "TRADINGVIEW_HEALTH_CHECK_COMMAND_NOT_CONFIGURED"
          : "TradingView health check not configured for this mode",
      };
    }

    try {
      const output = execSync(this.config.tradingViewHealthCommand, {
        encoding: "utf8",
        timeout: Math.min(5000, this.config.healthCheckTimeoutMs),
      });
      const healthy =
        /cdp_connected["\s:=]+true/i.test(output) ||
        /"cdp_connected"\s*:\s*true/i.test(output);

      return {
        component: "tradingview",
        status: healthy ? "healthy" : "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        reason: healthy ? "OK" : "TradingView reported disconnected",
        raw: output.trim().slice(0, 200),
      };
    } catch (error) {
      return {
        component: "tradingview",
        status: "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        reason: error.message,
      };
    }
  }

  async checkMcpServerConnection() {
    const lastChecked = new Date().toISOString();
    const start = Date.now();

    if (!this.config.mcpHealthcheckUrl) {
      return {
        component: "mcp",
        status: this.isComponentRequired("mcp") ? "unhealthy" : "healthy",
        lastChecked,
        latency: 0,
        reason: this.isComponentRequired("mcp")
          ? "MCP_HEALTHCHECK_URL_NOT_CONFIGURED"
          : "MCP health check not configured for this mode",
      };
    }

    try {
      const response = await withTimeout(
        fetch(this.config.mcpHealthcheckUrl),
        Math.min(1000, this.config.healthCheckTimeoutMs),
        "MCP health check",
      );
      return {
        component: "mcp",
        status: response.ok ? "healthy" : "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        reason: response.ok ? "OK" : `HTTP_${response.status}`,
      };
    } catch (error) {
      return {
        component: "mcp",
        status: "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        reason: error.message,
      };
    }
  }

  async checkExchangeConnection() {
    const lastChecked = new Date().toISOString();
    const start = Date.now();

    try {
      const currentPrice = await withTimeout(
        fetchCurrentPrice(this.config.symbol),
        Math.min(2000, this.config.healthCheckTimeoutMs),
        "Exchange health check",
      );
      return {
        component: "exchange",
        status: "healthy",
        lastChecked,
        latency: Date.now() - start,
        currentBalance: null,
        currentPrice,
        reason: "OK",
      };
    } catch (error) {
      return {
        component: "exchange",
        status: "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        currentBalance: null,
        reason: error.message,
      };
    }
  }

  async checkClaudeConnection() {
    const lastChecked = new Date().toISOString();
    const start = Date.now();

    if (!this.config.claudeHealthcheckUrl) {
      return {
        component: "claude",
        status: this.isComponentRequired("claude") ? "unhealthy" : "healthy",
        lastChecked,
        latency: 0,
        reason: this.isComponentRequired("claude")
          ? "CLAUDE_HEALTHCHECK_URL_NOT_CONFIGURED"
          : "Claude health check not configured for this mode",
      };
    }

    try {
      const response = await withTimeout(
        fetch(this.config.claudeHealthcheckUrl),
        Math.min(3000, this.config.healthCheckTimeoutMs),
        "Claude health check",
      );
      return {
        component: "claude",
        status: response.ok ? "healthy" : "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        reason: response.ok ? "OK" : `HTTP_${response.status}`,
      };
    } catch (error) {
      return {
        component: "claude",
        status: "unhealthy",
        lastChecked,
        latency: Date.now() - start,
        reason: error.message,
      };
    }
  }
}

async function sendHealthAlert(payload) {
  if (!CONFIG.slackWebhookUrl) return;

  try {
    await fetch(CONFIG.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: payload.text,
      }),
    });
  } catch (error) {
    console.log(`⚠️ Failed to send Slack health alert — ${error.message}`);
  }
}

async function attemptComponentRecovery(componentStatus) {
  const component = componentStatus.component;
  const recoveryStart = new Date().toISOString();
  let action = "NO_ACTION";

  try {
    if (component === "tradingview" && CONFIG.tradingViewRecoveryCommand) {
      action = CONFIG.tradingViewRecoveryCommand;
      execSync(action, { stdio: "ignore", timeout: 10000 });
    } else if (component === "mcp" && CONFIG.mcpRecoveryCommand) {
      action = CONFIG.mcpRecoveryCommand;
      execSync(action, { stdio: "ignore", timeout: 10000 });
    } else if (component === "exchange") {
      action = "WAIT_5_MINUTES";
      await sleep(5 * 60 * 1000);
    } else if (component === "claude") {
      if (CONFIG.claudeRecoveryCommand) {
        action = CONFIG.claudeRecoveryCommand;
        execSync(action, { stdio: "ignore", timeout: 10000 });
      } else {
        action = "WAIT_10_MINUTES";
        await sleep(10 * 60 * 1000);
      }
    }

    return {
      component,
      success: true,
      action,
      recoveryStart,
      recoveryEnd: new Date().toISOString(),
    };
  } catch (error) {
    return {
      component,
      success: false,
      action,
      recoveryStart,
      recoveryEnd: new Date().toISOString(),
      reason: error.message,
    };
  }
}

function updateHealthSummary(result) {
  const healthSummary = loadHealthSummary();
  const date = result.timestamp.slice(0, 10);
  const daily = healthSummary.daily[date] || {
    totalHealthChecks: 0,
    healthyChecks: 0,
    failedChecks: 0,
    failedComponents: {},
    tradingPauses: 0,
    pausedDurationMs: 0,
    componentLatencyTotals: {},
    componentCheckCounts: {},
    mostCommonFailingComponent: null,
    averageComponentLatencyMs: 0,
  };

  daily.totalHealthChecks += 1;
  if (result.allHealthy) {
    daily.healthyChecks += 1;
  } else {
    daily.failedChecks += 1;
  }

  for (const [component, status] of Object.entries(result.componentStatus)) {
    daily.componentLatencyTotals[component] =
      (daily.componentLatencyTotals[component] || 0) + (status.latency || 0);
    daily.componentCheckCounts[component] =
      (daily.componentCheckCounts[component] || 0) + 1;

    if (status.status !== "healthy") {
      daily.failedComponents[component] =
        (daily.failedComponents[component] || 0) + 1;
    }
  }

  if (result.pauseDurationMs) {
    daily.tradingPauses += 1;
    daily.pausedDurationMs += result.pauseDurationMs;
  }

  const failingComponents = Object.entries(daily.failedComponents).sort(
    (a, b) => b[1] - a[1],
  );
  daily.mostCommonFailingComponent = failingComponents[0]?.[0] || null;

  const latencyAverages = Object.keys(daily.componentLatencyTotals).map(
    (component) =>
      daily.componentLatencyTotals[component] /
      Math.max(1, daily.componentCheckCounts[component]),
  );
  daily.averageComponentLatencyMs =
    latencyAverages.length === 0
      ? 0
      : Number(
          (
            latencyAverages.reduce((sum, latency) => sum + latency, 0) /
            latencyAverages.length
          ).toFixed(2),
        );

  healthSummary.daily[date] = daily;
  healthSummary.state = {
    lastOverallStatus: result.allHealthy ? "healthy" : "unhealthy",
    lastAlertedStatus: healthSummary.state.lastAlertedStatus || "healthy",
    lastCheckAt: result.timestamp,
    lastHealthyAt: result.allHealthy
      ? result.timestamp
      : healthSummary.state.lastHealthyAt,
    latest: result,
  };

  saveHealthSummary(healthSummary);
}

async function runHealthChecks(options = {}) {
  const healthChecker = new HealthCheck();
  const startedAt = Date.now();
  const checks = await Promise.all([
    healthChecker.checkTradingViewConnection(),
    healthChecker.checkMcpServerConnection(),
    healthChecker.checkExchangeConnection(),
    healthChecker.checkClaudeConnection(),
  ]);

  const componentStatus = Object.fromEntries(
    checks.map((check) => [check.component, check]),
  );
  const requiredComponents = CONFIG.healthRequiredComponents;
  const unhealthyRequired = requiredComponents.filter(
    (component) => componentStatus[component]?.status !== "healthy",
  );

  const result = {
    timestamp: new Date().toISOString(),
    allHealthy: unhealthyRequired.length === 0,
    componentStatus,
    overallLatency: Date.now() - startedAt,
    unhealthyRequired,
    context: options.context || "general",
    recoveryAttempts: options.recoveryAttempts || [],
    pauseDurationMs: options.pauseDurationMs || 0,
  };

  const healthLog = loadHealthLog();
  healthLog.checks.push(result);
  saveHealthLog(healthLog);
  updateHealthSummary(result);
  latestHealthCheck = result;

  const summary = loadHealthSummary();
  const previousStatus = summary.state.lastAlertedStatus || "healthy";
  if (previousStatus !== (result.allHealthy ? "healthy" : "unhealthy")) {
    await sendHealthAlert({
      text: result.allHealthy
        ? `Trading bot health restored at ${result.timestamp}`
        : `Trading bot health check failed at ${result.timestamp}. Failing components: ${unhealthyRequired.join(", ")}`,
    });
    summary.state.lastAlertedStatus = result.allHealthy ? "healthy" : "unhealthy";
    saveHealthSummary(summary);
  }

  return result;
}

function isRecentHealthyCheckAvailable() {
  if (!latestHealthCheck) return false;
  return (
    Date.now() - new Date(latestHealthCheck.timestamp).getTime() <
      CONFIG.healthCheckIntervalMs && latestHealthCheck.allHealthy
  );
}

async function executeTradeWithHealthCheck(logEntry, log) {
  let healthResult = isRecentHealthyCheckAvailable()
    ? latestHealthCheck
    : await runHealthChecks({ context: "pre_trade" });

  if (healthResult.allHealthy) {
    return executeTrade(logEntry, log);
  }

  const pauseStartedAt = Date.now();
  let recoveryAttempts = [];
  let retries = 0;
  log.counters.health_check_pauses =
    (log.counters.health_check_pauses || 0) + 1;

  recordSafetyCheck(log, "HEALTH_CHECK_FAILED", {
    symbol: logEntry.symbol,
    unhealthyRequired: healthResult.unhealthyRequired,
    componentStatus: healthResult.componentStatus,
  });

  if (CONFIG.enableAutoRecovery) {
    for (const component of healthResult.unhealthyRequired) {
      recoveryAttempts.push(
        await attemptComponentRecovery(healthResult.componentStatus[component]),
      );
    }
  }

  while (!healthResult.allHealthy && retries < CONFIG.healthCheckMaxRetries) {
    await sleep(CONFIG.healthCheckIntervalMs);
    retries += 1;
    healthResult = await runHealthChecks({
      context: "pre_trade_retry",
      recoveryAttempts,
      pauseDurationMs: Date.now() - pauseStartedAt,
    });
  }

  if (!healthResult.allHealthy) {
    logEntry.error = `HEALTH_CHECK_FAILED: ${healthResult.unhealthyRequired.join(", ")}`;
    logEntry.healthCheckBlocked = true;
    return;
  }

  logEntry.healthCheckPauseMs = Date.now() - pauseStartedAt;
  return executeTrade(logEntry, log);
}

function startHealthMonitor() {
  if (healthMonitorInterval) {
    clearInterval(healthMonitorInterval);
  }

  healthMonitorInterval = setInterval(() => {
    runHealthChecks({ context: "background" }).catch((error) => {
      console.log(`⚠️ Background health check failed — ${error.message}`);
    });
  }, CONFIG.healthCheckIntervalMs);
  healthMonitorInterval.unref?.();
}

function stopHealthMonitor() {
  if (healthMonitorInterval) {
    clearInterval(healthMonitorInterval);
    healthMonitorInterval = null;
  }
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchCurrentPrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ticker error: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles, referenceTime = Date.now()) {
  const midnightUTC = new Date(referenceTime);
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules, options = {}) {
  const silent = options.silent === true;
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    if (!silent) {
      const icon = pass ? "OK" : "BLOCK";
      console.log(`  ${icon} ${label}`);
      console.log(`     Required: ${required} | Actual: ${actual}`);
    }
  };

  if (!silent) {
    console.log("\n-- Safety Check -----------------------------------------\n");
  }

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    if (!silent) {
      console.log("  Bias: BULLISH - checking long entry conditions\n");
    }

    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    if (!silent) {
      console.log("  Bias: BEARISH - checking short entry conditions\n");
    }

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );
    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );
    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    if (!silent) {
      console.log("  Bias: NEUTRAL - no clear direction. No trade.\n");
    }
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((result) => result.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

function buildQueryString(params = {}) {
  const entries = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (entries.length === 0) return "";

  return entries
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
}

async function bitgetRequest(method, path, { query = {}, body = null, context } = {}) {
  if (
    !CONFIG.bitget.apiKey ||
    !CONFIG.bitget.secretKey ||
    !CONFIG.bitget.passphrase
  ) {
    throw new Error("BitGet credentials are not loaded");
  }

  const queryString = buildQueryString(query);
  const requestPath = queryString ? `${path}?${queryString}` : path;
  const bodyString = body ? JSON.stringify(body) : "";

  const request = () =>
    apiRequestQueue.enqueue(async () => {
      recordSecurityAudit("USE_CREDENTIALS", true, null, {
        method,
        path,
        context: context || `${method}:${path}`,
      });
      const timestamp = getAccurateTimeMs().toString();
      const signature = signBitGet(timestamp, method, requestPath, bodyString);
      const res = await fetch(`${CONFIG.bitget.baseUrl}${requestPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "ACCESS-KEY": CONFIG.bitget.apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
        },
        ...(bodyString ? { body: bodyString } : {}),
      });

      const data = await res.json();
      if (
        res.status === 429 ||
        data?.code === "429" ||
        /rate limit/i.test(data?.msg || "")
      ) {
        const error = new Error(`BitGet rate limited: ${data?.msg || res.status}`);
        error.status = 429;
        error.isRateLimitError = true;
        throw error;
      }

      if (!res.ok || data.code !== "00000") {
        throw new Error(`BitGet request failed: ${data?.msg || res.statusText}`);
      }

      return data.data;
    });

  const result = await executeWithRetry(request, CONFIG.maxApiRetries, {
    endpoint: path,
    description: context || `${method}:${path}`,
  });

  if (!result.success) {
    throw new Error(
      `BitGet request abandoned after rate limiting (${result.retriesUsed + 1} attempts, waited ${result.totalWaitMs}ms)`,
    );
  }

  return result.data;
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = {
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  };

  return bitgetRequest("POST", path, {
    body,
    context: `submitOrder:${symbol}:${side}`,
  });
}

async function getOrderStatus(orderId, symbol) {
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/orderInfo"
      : "/api/v2/mix/order/detail";
  const query =
    CONFIG.tradeMode === "spot"
      ? { symbol, orderId }
      : { symbol, orderId, productType: "USDT-FUTURES" };

  return bitgetRequest("GET", path, {
    query,
    context: `getOrderStatus:${symbol}:${orderId}`,
  });
}

async function fetchOpenOrders(symbol) {
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/unfilled-orders"
      : "/api/v2/mix/order/orders-pending";
  const query =
    CONFIG.tradeMode === "spot"
      ? { symbol }
      : { symbol, productType: "USDT-FUTURES" };

  const data = await bitgetRequest("GET", path, {
    query,
    context: `getOpenOrders:${symbol}`,
  });
  return Array.isArray(data) ? data : data?.entrustedList || data?.orders || [];
}

async function fetchRecentClosedOrders(symbol) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/history-orders"
      : "/api/v2/mix/order/orders-history";
  const query =
    CONFIG.tradeMode === "spot"
      ? { symbol, startTime: since, endTime: Date.now(), limit: 100 }
      : {
          symbol,
          productType: "USDT-FUTURES",
          startTime: since,
          endTime: Date.now(),
          limit: 100,
        };

  const data = await bitgetRequest("GET", path, {
    query,
    context: `getRecentClosedOrders:${symbol}`,
  });
  return Array.isArray(data) ? data : data?.entrustedList || data?.orders || [];
}

function normalizeExchangeOrder(order) {
  return {
    orderId: order.orderId || order.ordId || order.id || "",
    symbol: order.symbol || "",
    side: String(order.side || "").toUpperCase(),
    entryPrice: parseFloat(
      order.priceAvg ||
        order.price ||
        order.avgPrice ||
        order.fillPrice ||
        "0",
    ),
    quantity: parseFloat(order.baseVolume || order.size || order.quantity || "0"),
    entryTime: order.cTime || order.uTime || order.createdTime || order.fillTime,
    status: String(order.status || order.state || "").toUpperCase(),
    raw: order,
  };
}

async function getOpenPositions(symbol = CONFIG.symbol, { forceRefresh = false } = {}) {
  const cacheAge = Date.now() - openPositionsCache.timestamp;
  if (
    !forceRefresh &&
    openPositionsCache.symbol === symbol &&
    cacheAge < CONFIG.openOrdersCacheDurationMs
  ) {
    return openPositionsCache.data;
  }

  const orders = await fetchOpenOrders(symbol);
  const normalized = orders.map(normalizeExchangeOrder);
  openPositionsCache = {
    timestamp: Date.now(),
    symbol,
    data: normalized,
  };
  return normalized;
}

async function confirmOrderFilled(orderId, symbol, log) {
  const maxAttempts = Math.max(
    1,
    Math.floor(CONFIG.orderConfirmationTimeoutMs / CONFIG.orderPollIntervalMs),
  );
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const statusData = normalizeExchangeOrder(await getOrderStatus(orderId, symbol));
    recordTradeState({
      symbol,
      orderId,
      state: "ORDER_PENDING",
      attempt,
      status: statusData.status,
    });

    if (["FILLED", "FULLY_FILLED", "CLOSED"].includes(statusData.status)) {
      const confirmation = {
        orderId,
        filled: true,
        fillPrice: statusData.entryPrice,
        fillQuantity: statusData.quantity,
        fillTime: statusData.entryTime || new Date().toISOString(),
        status: statusData.status,
      };
      recordTradeConfirmation({
        orderId,
        submitted_time: new Date(startedAt).toISOString(),
        confirmed_time: new Date().toISOString(),
        confirmation_latency_ms: Date.now() - startedAt,
        filled: true,
        fillPrice: confirmation.fillPrice,
        fillQuantity: confirmation.fillQuantity,
        reason: statusData.status,
      });
      recordTradeState({
        symbol,
        orderId,
        state: "ORDER_FILLED",
        status: statusData.status,
      });
      return confirmation;
    }

    if (["PARTIALLY_FILLED", "PARTIAL_FILLED"].includes(statusData.status)) {
      recordSafetyCheck(log, "PARTIALLY_FILLED_WARNING", {
        symbol,
        orderId,
        status: statusData.status,
      });
    }

    await sleep(CONFIG.orderPollIntervalMs);
  }

  recordTradeConfirmation({
    orderId,
    submitted_time: new Date(startedAt).toISOString(),
    confirmed_time: new Date().toISOString(),
    confirmation_latency_ms: Date.now() - startedAt,
    filled: false,
    fillPrice: null,
    reason: "TIMEOUT",
  });
  return {
    orderId,
    filled: false,
    reason: "TIMEOUT",
    status: "PENDING",
  };
}

function matchTrackedTrade(order, trades) {
  return trades.find((trade) => {
    const tradePrice = parseFloat(trade.actualPrice || trade.price || "0");
    const tradeQty =
      trade.actualPrice && trade.tradeSize
        ? trade.tradeSize / trade.actualPrice
        : trade.tradeSize && trade.price
          ? trade.tradeSize / trade.price
          : 0;
    const priceDiff =
      tradePrice === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.abs(order.entryPrice - tradePrice) / tradePrice;
    const qtyDiff =
      tradeQty === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.abs(order.quantity - tradeQty) / tradeQty;

    return (
      trade.symbol === order.symbol &&
      String(trade.side || "BUY").toUpperCase() === order.side &&
      priceDiff <= 0.001 &&
      qtyDiff <= 0.01
    );
  });
}

async function reconcileWithExchange(log) {
  const openOrders = await getOpenPositions(CONFIG.symbol, { forceRefresh: true });
  const recentClosedOrders = (await fetchRecentClosedOrders(CONFIG.symbol)).map(
    normalizeExchangeOrder,
  );
  const recentOrders = [...openOrders, ...recentClosedOrders];
  const untracked = [];
  const reconciled = [];
  const conflicts = [];

  for (const order of recentOrders) {
    const tracked = matchTrackedTrade(order, log.trades);
    if (!tracked) {
      untracked.push(order);
      recordSafetyCheck(log, "UNTRACKED_POSITION_FOUND", order);
      log.trades.push({
        timestamp: new Date().toISOString(),
        signalGeneratedAt: new Date().toISOString(),
        symbol: order.symbol,
        timeframe: CONFIG.timeframe,
        price: order.entryPrice || 0,
        plannedPrice: order.entryPrice || 0,
        actualPrice: order.entryPrice || 0,
        slippagePercent: 0,
        executionTimeMs: 0,
        indicators: {},
        conditions: [],
        allPass: true,
        tradeSize: (order.entryPrice || 0) * (order.quantity || 0),
        orderPlaced: true,
        orderId: order.orderId,
        paperTrading: false,
        side: order.side,
        orderStatus: order.status,
        fillTime: order.entryTime || "",
        confirmationMethod: "MANUAL",
        untrackedRecovery: true,
      });
    } else if (tracked.orderId && tracked.orderId !== order.orderId) {
      conflicts.push({ trackedOrderId: tracked.orderId, exchangeOrderId: order.orderId });
    } else {
      reconciled.push(order.orderId);
    }
  }

  return { untracked, reconciled, conflicts };
}

function getRecentFilledTrades(log, symbol) {
  const lookbackMs = CONFIG.duplicatePreventionLookbackMinutes * 60 * 1000;
  return log.trades.filter((trade) => {
    if (trade.symbol !== symbol) return false;
    if (!["FILLED", "FULLY_FILLED", "CLOSED"].includes(String(trade.orderStatus || "").toUpperCase())) {
      return false;
    }
    const fillTime = trade.fillTime || trade.timestamp;
    return Date.now() - new Date(fillTime).getTime() <= lookbackMs;
  });
}

function preventDuplicateEntries(log, symbol) {
  if (!CONFIG.preventDuplicateEntries) {
    return { allowed: true, reason: null };
  }

  const pending = persistentOrderTracker
    .load()
    .orders.filter(
      (order) =>
        order.symbol === symbol &&
        !["FILLED", "CANCELLED"].includes(String(order.status || "").toUpperCase()),
    );
  if (pending.length > 0) {
    return {
      allowed: false,
      reason: `Pending order exists for ${symbol}: ${pending[0].order_id}`,
    };
  }

  const recentFills = getRecentFilledTrades(log, symbol);
  if (recentFills.length > 0) {
    return {
      allowed: false,
      reason: `Recent fill exists for ${symbol} within ${CONFIG.duplicatePreventionLookbackMinutes} minutes`,
    };
  }

  return { allowed: true, reason: null };
}

async function cancelOrder(orderId, symbol) {
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/cancel-order"
      : "/api/v2/mix/order/cancel-order";
  const body =
    CONFIG.tradeMode === "spot"
      ? { symbol, orderId }
      : { symbol, orderId, productType: "USDT-FUTURES" };

  return bitgetRequest("POST", path, {
    body,
    context: `cancelOrder:${symbol}:${orderId}`,
  });
}

async function checkForStalePendingOrders(log) {
  const stale = [];
  const trackerData = persistentOrderTracker.load();

  for (const order of trackerData.orders) {
    const pendingSince = new Date(
      order.submitted_timestamp || order.status_updated_timestamp || Date.now(),
    ).getTime();
    const pendingDuration = Date.now() - pendingSince;
    if (pendingDuration <= CONFIG.staleOrderTimeoutMs) {
      continue;
    }

    recordSafetyCheck(log, "STALE_ORDER_DETECTED", {
      orderId: order.order_id,
      symbol: order.symbol,
      pending_since: order.submitted_timestamp,
      pending_duration: pendingDuration,
    });

    try {
      await cancelOrder(order.order_id, order.symbol);
      persistentOrderTracker.upsert({
        ...order,
        status: "CANCELLED",
      });
      persistentOrderTracker.remove(order.order_id);
      stale.push({
        ...order,
        status: "CANCELLED",
        pendingDuration,
      });
    } catch (error) {
      stale.push({
        ...order,
        status: "STALE",
        pendingDuration,
        reason: error.message,
      });
    }
  }

  return stale;
}

async function reconcilePendingWithTrades(log) {
  const trackerData = persistentOrderTracker.load();
  const conflicts = [];

  for (const order of trackerData.orders) {
    const tracked = log.trades.find((trade) => trade.orderId === order.order_id);
    if (
      tracked &&
      ["FILLED", "FULLY_FILLED", "CLOSED"].includes(
        String(tracked.orderStatus || "").toUpperCase(),
      )
    ) {
      persistentOrderTracker.remove(order.order_id);
      continue;
    }

    if (tracked && tracked.orderStatus && tracked.orderStatus !== order.status) {
      conflicts.push({
        orderId: order.order_id,
        pendingStatus: order.status,
        tradeStatus: tracked.orderStatus,
      });
    }
  }

  return conflicts;
}

async function loadPendingOrdersFromDisk(log) {
  const trackerData = persistentOrderTracker.load();
  const resolved = [];
  const stillPending = [];
  const cancelled = [];

  for (const order of trackerData.orders) {
    if (["FILLED", "CANCELLED"].includes(String(order.status || "").toUpperCase())) {
      continue;
    }

    const exchangeStatus = normalizeExchangeOrder(
      await getOrderStatus(order.order_id, order.symbol),
    );
    const nextStatus = exchangeStatus.status || order.status;

    if (["FILLED", "FULLY_FILLED", "CLOSED"].includes(nextStatus)) {
      persistentOrderTracker.remove(order.order_id);
      resolved.push({
        ...order,
        status: nextStatus,
        fillPrice: exchangeStatus.entryPrice,
        fillQuantity: exchangeStatus.quantity,
        fillTime: exchangeStatus.entryTime,
      });
      log.trades.push({
        timestamp: new Date().toISOString(),
        signalGeneratedAt: order.submitted_timestamp,
        symbol: order.symbol,
        timeframe: CONFIG.timeframe,
        price: order.submitted_price,
        plannedPrice: order.submitted_price,
        actualPrice: exchangeStatus.entryPrice || order.submitted_price,
        slippagePercent: 0,
        executionTimeMs: 0,
        indicators: {},
        conditions: [],
        allPass: true,
        tradeSize: (exchangeStatus.entryPrice || order.submitted_price) * order.quantity,
        orderPlaced: true,
        orderSubmitted: true,
        orderId: order.order_id,
        orderStatus: nextStatus,
        fillTime: exchangeStatus.entryTime || new Date().toISOString(),
        confirmationMethod: "POLLING",
        untrackedRecovery: false,
        side: order.side,
        paperTrading: false,
      });
    } else if (["CANCELLED", "CANCELED"].includes(nextStatus)) {
      persistentOrderTracker.remove(order.order_id);
      cancelled.push({ ...order, status: "CANCELLED" });
    } else {
      const updated = persistentOrderTracker.upsert({
        ...order,
        status: nextStatus,
      });
      stillPending.push(updated);
    }
  }

  return { resolved, stillPending, cancelled };
}

function saveOrderStateRunSummary(summary) {
  const data = loadOrderStateSummary();
  const date = new Date().toISOString().slice(0, 10);
  data.daily[date] = summary;
  saveOrderStateSummary(data);
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Planned Price",
  "Actual Price",
  "Slippage Percent",
  "Execution Time Ms",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Order Status",
  "Fill Time",
  "Confirmation Method",
  "Untracked Recovery",
  "Mode",
  "Notes",
].join(",");

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
    return;
  }

  const existing = readFileSync(CSV_FILE, "utf8");
  const [header, ...rest] = existing.split("\n");
  if (header !== CSV_HEADERS) {
    writeFileSync(CSV_FILE, [CSV_HEADERS, ...rest].join("\n"));
    console.log(`📄 Updated ${CSV_FILE} headers with slippage tracking columns.`);
  }
}

function validateSlippage(
  plannedEntryPrice,
  currentPrice,
  maxSlippagePercent = CONFIG.maxSlippagePercent,
  log,
) {
  const slippageAmount =
    (Math.abs(currentPrice - plannedEntryPrice) / plannedEntryPrice) * 100;
  const slippagePercent = Number(slippageAmount.toFixed(4));
  const isAcceptable = slippagePercent <= maxSlippagePercent;

  let reason = "SLIPPAGE_OK";
  if (!isAcceptable) {
    reason = `SLIPPAGE_TOO_HIGH_${slippagePercent.toFixed(2)}%`;
  } else if (slippagePercent > CONFIG.slippageWarningPercent) {
    reason = `SLIPPAGE_WARNING_${slippagePercent.toFixed(2)}%`;
  }

  recordSafetyCheck(log, "SLIPPAGE_CHECK", {
    plannedEntryPrice,
    currentPrice,
    maxSlippagePercent,
    slippagePercent,
    isAcceptable,
    reason,
  });

  return { isAcceptable, slippagePercent, reason };
}

function trackExecutionTime(signalGeneratedAt, orderSubmittedAt, log, context = {}) {
  const startTime = new Date(signalGeneratedAt).getTime();
  const endTime = new Date(orderSubmittedAt).getTime();
  const totalTime = endTime - startTime;
  const latencyFlag =
    totalTime > CONFIG.maxExecutionTimeMs ? "HIGH_LATENCY_TRADE" : "OK";

  recordSafetyCheck(log, "EXECUTION_TIME", {
    ...context,
    signalGeneratedAt,
    orderSubmittedAt,
    totalTime,
    latencyFlag,
  });

  return {
    signalGeneratedAt,
    orderSubmittedAt,
    executionTimeMs: totalTime,
    latencyFlag,
  };
}

async function executeTrade(logEntry, log) {
  recordTradeState({
    symbol: logEntry.symbol,
    state: "SIGNAL_GENERATED",
    signalGeneratedAt: logEntry.signalGeneratedAt,
  });

  const currentPrice = await fetchCurrentPrice(logEntry.symbol);
  logEntry.actualPrice = currentPrice;
  logger.info("TRADE_EXECUTION", "Signal moved into execution", {
    symbol: logEntry.symbol,
    plannedPrice: logEntry.plannedPrice,
    currentPrice,
    tradeSize: logEntry.tradeSize,
    paperTrading: CONFIG.paperTrading,
  });

  const slippage = validateSlippage(
    logEntry.plannedPrice,
    currentPrice,
    CONFIG.maxSlippagePercent,
    log,
  );
  logEntry.slippagePercent = slippage.slippagePercent;
  logEntry.slippageReason = slippage.reason;

  if (!slippage.isAcceptable) {
    log.counters.slippage_rejections += 1;
    logEntry.error = `Trade rejected: ${slippage.reason}`;
    logEntry.rejectedBySlippage = true;
    recordSafetyCheck(log, "TRADE_REJECTED", {
      symbol: logEntry.symbol,
      plannedPrice: logEntry.plannedPrice,
      actualPrice: currentPrice,
      percentDifference: slippage.slippagePercent,
      reason: slippage.reason,
    });
    console.log(
      `🚫 Trade rejected — planned $${logEntry.plannedPrice.toFixed(2)}, actual $${currentPrice.toFixed(2)}, slippage ${slippage.slippagePercent.toFixed(2)}%`,
    );
    logger.warn("SLIPPAGE", "Trade rejected due to slippage", {
      symbol: logEntry.symbol,
      plannedPrice: logEntry.plannedPrice,
      actualPrice: currentPrice,
      slippagePercent: slippage.slippagePercent,
    });
    return;
  }

  if (slippage.slippagePercent > CONFIG.slippageWarningPercent) {
    console.log(
      `⚠️ Slippage warning — ${slippage.slippagePercent.toFixed(2)}% but still within the ${CONFIG.maxSlippagePercent.toFixed(2)}% max.`,
    );
  }

  const preExecutionLatency = Date.now() - new Date(logEntry.signalGeneratedAt).getTime();
  if (preExecutionLatency > CONFIG.maxExecutionTimeMs) {
    logEntry.error = `Trade rejected: HIGH_LATENCY_TRADE (${preExecutionLatency}ms)`;
    logEntry.rejectedByLatency = true;
    recordSafetyCheck(log, "HIGH_LATENCY_TRADE", {
      symbol: logEntry.symbol,
      plannedPrice: logEntry.plannedPrice,
      actualPrice: currentPrice,
      totalTime: preExecutionLatency,
    });
    console.log(
      `🚫 Trade rejected — execution pipeline already took ${preExecutionLatency}ms.`,
    );
    logger.warn("TRADE_EXECUTION", "Trade rejected due to high latency", {
      symbol: logEntry.symbol,
      preExecutionLatency,
      maxExecutionTimeMs: CONFIG.maxExecutionTimeMs,
    });
    return;
  }

  const openPositions = await getOpenPositions(logEntry.symbol);
  const duplicatePosition = openPositions.find(
    (position) =>
      position.symbol === logEntry.symbol &&
      ["LIVE", "NEW", "PARTIALLY_FILLED", "PENDING"].includes(position.status),
  );
  if (duplicatePosition) {
    logEntry.error = `DUPLICATE_ENTRY_PREVENTED: ${duplicatePosition.orderId}`;
    logEntry.orderStatus = duplicatePosition.status;
    recordSafetyCheck(log, "DUPLICATE_ENTRY_PREVENTED", {
      symbol: logEntry.symbol,
      existingOrderId: duplicatePosition.orderId,
      status: duplicatePosition.status,
    });
    return;
  }

  const duplicateProtection = preventDuplicateEntries(log, logEntry.symbol);
  if (!duplicateProtection.allowed) {
    logEntry.error = `DUPLICATE_ENTRY_PREVENTED: ${duplicateProtection.reason}`;
    recordSafetyCheck(log, "DUPLICATE_ENTRY_PREVENTED", {
      symbol: logEntry.symbol,
      reason: duplicateProtection.reason,
    });
    return;
  }

  if (CONFIG.paperTrading) {
    console.log(
      `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${logEntry.tradeSize.toFixed(2)} at market`,
    );
    console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
    logger.info("TRADE_EXECUTION", "Paper trade recorded", {
      symbol: logEntry.symbol,
      tradeSize: logEntry.tradeSize,
      price: currentPrice,
    });
    logEntry.orderPlaced = true;
    logEntry.orderId = `PAPER-${Date.now()}`;
    logEntry.orderStatus = "FILLED";
    logEntry.fillTime = new Date().toISOString();
    logEntry.confirmationMethod = "POLLING";
    recordTradeState({
      symbol: logEntry.symbol,
      orderId: logEntry.orderId,
      state: "ORDER_FILLED",
      status: logEntry.orderStatus,
    });
    const submittedAt = new Date().toISOString();
    Object.assign(
      logEntry,
      trackExecutionTime(logEntry.signalGeneratedAt, submittedAt, log, {
        symbol: logEntry.symbol,
        orderId: logEntry.orderId,
      }),
    );
    return;
  }

  console.log(
    `\n🔴 PLACING LIVE ORDER — $${logEntry.tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
  );
  logger.info("TRADE_EXECUTION", "Submitting live order", {
    symbol: CONFIG.symbol,
    tradeSize: logEntry.tradeSize,
    side: "BUY",
    price: currentPrice,
  });
  try {
    recordTradeState({
      symbol: logEntry.symbol,
      state: "ORDER_ABOUT_TO_SUBMIT",
      submittedPrice: currentPrice,
      tradeSize: logEntry.tradeSize,
    });
    const order = await placeBitGetOrder(
      CONFIG.symbol,
      "buy",
      logEntry.tradeSize,
      currentPrice,
    );
    logEntry.orderSubmitted = true;
    logEntry.orderId = order.orderId;
    logEntry.orderStatus = "SUBMITTED";
    persistentOrderTracker.upsert({
      order_id: logEntry.orderId,
      symbol: logEntry.symbol,
      side: logEntry.side || "BUY",
      submitted_timestamp: new Date().toISOString(),
      submitted_price: currentPrice,
      quantity: Number((logEntry.tradeSize / currentPrice).toFixed(6)),
      status: "SUBMITTED",
    });
    logEntry.rateLimitSummary = getRateLimitSummary();
    recordTradeState({
      symbol: logEntry.symbol,
      orderId: logEntry.orderId,
      state: "ORDER_SUBMITTED",
      status: logEntry.orderStatus,
    });
    logger.info("TRADE_EXECUTION", "Order submitted successfully", {
      orderId: logEntry.orderId,
      symbol: logEntry.symbol,
      side: logEntry.side || "BUY",
      price: currentPrice,
      quantity: Number((logEntry.tradeSize / currentPrice).toFixed(6)),
    });

    const confirmation = await confirmOrderFilled(
      logEntry.orderId,
      logEntry.symbol,
      log,
    );
    if (!confirmation.filled) {
      logEntry.orderStatus = confirmation.status || "PENDING";
      persistentOrderTracker.upsert({
        order_id: logEntry.orderId,
        symbol: logEntry.symbol,
        side: logEntry.side || "BUY",
        submitted_timestamp: logEntry.signalGeneratedAt,
        submitted_price: currentPrice,
        quantity: Number((logEntry.tradeSize / currentPrice).toFixed(6)),
        status: logEntry.orderStatus,
      });
      logEntry.error = `Order not confirmed: ${confirmation.reason}`;
      logger.warn("TRADE_EXECUTION", "Order not confirmed within polling window", {
        orderId: logEntry.orderId,
        symbol: logEntry.symbol,
        status: logEntry.orderStatus,
        reason: confirmation.reason,
      });
      return;
    }

    logEntry.orderStatus = confirmation.status || "FILLED";
    logEntry.orderPlaced = true;
    logEntry.actualPrice = confirmation.fillPrice || logEntry.actualPrice;
    logEntry.fillTime = confirmation.fillTime || new Date().toISOString();
    logEntry.confirmationMethod = "POLLING";
    persistentOrderTracker.remove(logEntry.orderId);
    openPositionsCache.timestamp = 0;
    const submittedAt = new Date().toISOString();
    Object.assign(
      logEntry,
      trackExecutionTime(logEntry.signalGeneratedAt, submittedAt, log, {
        symbol: logEntry.symbol,
        orderId: logEntry.orderId,
      }),
    );
    recordTradeState({
      symbol: logEntry.symbol,
      orderId: logEntry.orderId,
      state: "POSITION_TRACKED",
      status: logEntry.orderStatus,
    });
    console.log(`✅ ORDER PLACED — ${order.orderId}`);
    logger.info("TRADE_EXECUTION", "Order filled and tracked", {
      orderId: logEntry.orderId,
      symbol: logEntry.symbol,
      fillPrice: logEntry.actualPrice,
      fillTime: logEntry.fillTime,
      slippagePercent: logEntry.slippagePercent,
      executionTimeMs: logEntry.executionTimeMs,
    });
  } catch (err) {
    console.log(`❌ ORDER FAILED — ${err.message}`);
    logEntry.error = err.message;
    logger.error("ERROR", "Order placement failed", {
      symbol: logEntry.symbol,
      message: err.message,
      stack: err.stack,
    });
    if (/rate limit/i.test(err.message)) {
      log.counters.rate_limit_abandoned += 1;
      recordSafetyCheck(log, "RATE_LIMITED", {
        symbol: logEntry.symbol,
        reason: err.message,
        summary: getRateLimitSummary(),
      });
    }
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let plannedPrice = "";
  let actualPrice = "";
  let slippagePercent = "";
  let executionTimeMs = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let orderStatus = "";
  let fillTime = "";
  let confirmationMethod = "";
  let untrackedRecovery = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.healthCheckBlocked) {
    side = "BUY";
    plannedPrice = logEntry.plannedPrice ? logEntry.plannedPrice.toFixed(2) : "";
    actualPrice = logEntry.actualPrice ? logEntry.actualPrice.toFixed(2) : "";
    slippagePercent =
      typeof logEntry.slippagePercent === "number"
        ? logEntry.slippagePercent.toFixed(4)
        : "";
    orderId = "BLOCKED";
    orderStatus = "BLOCKED";
    mode = "BLOCKED";
    notes = logEntry.error || "Blocked by health check";
  } else if (logEntry.rejectedBySlippage || logEntry.rejectedByLatency) {
    side = "BUY";
    quantity = logEntry.actualPrice
      ? (logEntry.tradeSize / logEntry.actualPrice).toFixed(6)
      : "";
    plannedPrice = logEntry.plannedPrice ? logEntry.plannedPrice.toFixed(2) : "";
    actualPrice = logEntry.actualPrice ? logEntry.actualPrice.toFixed(2) : "";
    slippagePercent =
      typeof logEntry.slippagePercent === "number"
        ? logEntry.slippagePercent.toFixed(4)
        : "";
    executionTimeMs = logEntry.executionTimeMs || "";
    orderId = "BLOCKED";
    orderStatus = "BLOCKED";
    mode = "BLOCKED";
    notes = logEntry.error || "Trade rejected before execution";
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.actualPrice).toFixed(6);
    plannedPrice = logEntry.plannedPrice.toFixed(2);
    actualPrice = logEntry.actualPrice.toFixed(2);
    slippagePercent = logEntry.slippagePercent.toFixed(4);
    executionTimeMs = logEntry.executionTimeMs || "";
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    orderStatus = logEntry.orderStatus || "FILLED";
    fillTime = logEntry.fillTime || logEntry.timestamp;
    confirmationMethod = logEntry.confirmationMethod || "POLLING";
    untrackedRecovery = logEntry.untrackedRecovery ? "true" : "false";
    mode = "PAPER";
    notes =
      logEntry.error ||
      (logEntry.slippagePercent > CONFIG.slippageWarningPercent
        ? "Executed with slippage warning"
        : "All conditions met");
  } else {
    side = "BUY";
    quantity = logEntry.actualPrice
      ? (logEntry.tradeSize / logEntry.actualPrice).toFixed(6)
      : "";
    plannedPrice = logEntry.plannedPrice ? logEntry.plannedPrice.toFixed(2) : "";
    actualPrice = logEntry.actualPrice ? logEntry.actualPrice.toFixed(2) : "";
    slippagePercent =
      typeof logEntry.slippagePercent === "number"
        ? logEntry.slippagePercent.toFixed(4)
        : "";
    executionTimeMs = logEntry.executionTimeMs || "";
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    orderStatus = logEntry.orderStatus || "";
    fillTime = logEntry.fillTime || "";
    confirmationMethod = logEntry.confirmationMethod || "";
    untrackedRecovery = logEntry.untrackedRecovery ? "true" : "false";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    plannedPrice,
    actualPrice,
    slippagePercent,
    executionTimeMs,
    totalUSD,
    fee,
    netAmount,
    orderId,
    orderStatus,
    fillTime,
    confirmationMethod,
    untrackedRecovery,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  const modeIndex = headers.indexOf("Mode");
  const totalUsdIndex = headers.indexOf("Total USD");
  const feeIndex = headers.indexOf("Fee (est.)");

  const live = rows.filter((r) => r[modeIndex] === "LIVE");
  const paper = rows.filter((r) => r[modeIndex] === "PAPER");
  const blocked = rows.filter((r) => r[modeIndex] === "BLOCKED");

  const totalVolume = live.reduce(
    (sum, r) => sum + parseFloat(r[totalUsdIndex] || 0),
    0,
  );
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[feeIndex] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`  ${getRateLimitSummary().text}`);
  console.log(`  ${getClaudeResponseSummary().text}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  logger.info("STRATEGY", "Bot run started", {
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    paperTrading: CONFIG.paperTrading,
  });
  checkOnboarding();
  const timeValidation = await initializeWithTimeValidation();
  if (!timeValidation.valid) {
    console.log("\nBot stopping â€” time synchronization failed.");
    logger.error("HEALTH_CHECK", "Startup blocked by time synchronization", {
      message: timeValidation.message,
    });
    return;
  }
  const securityStatus = await initializeSecurity();
  if (!securityStatus.valid) {
    console.log("\nBot stopping â€” startup security checks failed.");
    logger.error("SECURITY", "Startup blocked by security checks", {
      message: securityStatus.message,
    });
    stopClockDriftMonitor();
    return;
  }
  initCsv();
  startHealthMonitor();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${getAccurateTime()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  let backtestBaseline = loadBacktestBaseline();
  if (
    !backtestBaseline ||
    backtestBaseline.symbol !== CONFIG.symbol ||
    backtestBaseline.timeframe !== CONFIG.timeframe ||
    backtestBaseline.lookback_candles !== CONFIG.backtestLookbackCandles
  ) {
    console.log("\nRunning initial backtest baseline...");
    backtestBaseline = await runInitialBacktest(rules);
    console.log(`  ${backtestBaseline.summary_text}`);
  } else {
    console.log(`\nBacktest baseline loaded: ${backtestBaseline.summary_text}`);
  }

  const startupAnalysis = analyzeLiveVsBacktest(log, backtestBaseline);
  if (startupAnalysis.liveTradeCount > 0) {
    console.log(
      `Live vs backtest health: ${startupAnalysis.overall_health} after ${startupAnalysis.liveTradeCount} executed trades.`,
    );
    if (startupAnalysis.overall_health !== "GREEN") {
      console.log(startupAnalysis.report);
      recordSafetyCheck(log, "BACKTEST_DIVERGENCE_ALERT", {
        phase: "startup",
        overall_health: startupAnalysis.overall_health,
        divergences: startupAnalysis.divergences,
        recommendation: startupAnalysis.recommendation,
      });
      if (CONFIG.autoPauseIfDivergence) {
        console.log("Auto-pause enabled: stopping before new trades.");
        saveLog(log);
        stopHealthMonitor();
        stopClockDriftMonitor();
        return;
      }
    }
  }
  const pendingLoadResult = await loadPendingOrdersFromDisk(log);
  const pendingConflicts = await reconcilePendingWithTrades(log);
  const stalePendingOrders = await checkForStalePendingOrders(log);
  saveOrderStateRunSummary({
    previousRunOrders: pendingLoadResult.resolved.length +
      pendingLoadResult.stillPending.length +
      pendingLoadResult.cancelled.length,
    resolved: pendingLoadResult.resolved.length,
    stillPending: pendingLoadResult.stillPending.map((order) => ({
      orderId: order.order_id,
      symbol: order.symbol,
      status: order.status,
    })),
    cancelled: pendingLoadResult.cancelled.length,
    staleDetected: stalePendingOrders.length,
    conflicts: pendingConflicts,
    text: `Orders from previous runs: ${pendingLoadResult.resolved.length + pendingLoadResult.stillPending.length + pendingLoadResult.cancelled.length}`,
  });
  if (
    pendingLoadResult.stillPending.length > 0 ||
    stalePendingOrders.some((order) => order.status === "STALE")
  ) {
    console.log("\nOrder state summary");
    console.log(
      `  Orders from previous runs: ${pendingLoadResult.resolved.length + pendingLoadResult.stillPending.length + pendingLoadResult.cancelled.length}`,
    );
    console.log(`  - Resolved and filled: ${pendingLoadResult.resolved.length}`);
    console.log(
      `  - Still pending: ${pendingLoadResult.stillPending.length}`,
    );
    console.log(`  - Cancelled: ${pendingLoadResult.cancelled.length}`);
    if (stalePendingOrders.some((order) => order.status === "STALE")) {
      console.log("  - Stale orders remain. Check BitGet manually before trading.");
      stopHealthMonitor();
      return;
    }
  }
  if (CONFIG.reconcileOnStartup && !CONFIG.paperTrading) {
    const reconciliation = await reconcileWithExchange(log);
    if (reconciliation.untracked.length > 0) {
      console.log(
        `⚠️ Untracked positions found on exchange: ${reconciliation.untracked.length}. Blocking new trades until reviewed.`,
      );
      saveLog(log);
      reconciliation.untracked.forEach((_, index) => {
        writeTradeCsv(log.trades[log.trades.length - reconciliation.untracked.length + index]);
      });
      stopHealthMonitor();
      return;
    }
  }
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    logger.warn("RISK_MANAGEMENT", "Run stopped by daily trade limits", {
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    });
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const signalGeneratedAt = getAccurateTime();
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    logger.warn("STRATEGY", "Insufficient data for indicator calculation", {
      candleCount: candles.length,
      hasVWAP: Boolean(vwap),
      hasRSI3: Boolean(rsi3),
    });
    return;
  }

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // Calculate position size
  let tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  const claudeSignalRaw = loadClaudeSignalInput();
  let claudeSignal = null;
  let claudeComparison = null;
  let claudeValidation = {
    enabled: Boolean(claudeSignalRaw),
    finalDecision: claudeSignalRaw ? "PENDING" : "SKIPPED",
    errors: [],
    warnings: [],
  };

  if (claudeSignalRaw) {
    const saneResponse = await getSaneResponse(claudeSignalRaw, price, log);
    claudeValidation = {
      enabled: true,
      finalDecision: saneResponse.finalDecision,
      errors: saneResponse.errors || [],
      warnings: saneResponse.warnings || [],
    };

    if (!saneResponse.success) {
      log.counters.claude_validation_rejections += 1;
      console.log("\n🚫 Claude response rejected by validation.");
      saneResponse.errors.forEach((error) => console.log(`   - ${error}`));
    } else {
      claudeSignal = saneResponse.data;
      const sizeValidation = validateTradeSize(
        claudeSignal.suggested_size || tradeSize,
        log,
        { symbol: CONFIG.symbol },
      );
      tradeSize = sizeValidation.size;
      claudeComparison = compareClaudeVsStrategy(
        { allPass },
        claudeSignal,
        log,
      );
      recordSafetyCheck(log, "CLAUDE_TRADE_SIZE_VALIDATED", {
        suggestedSize: claudeSignal.suggested_size || null,
        finalSize: tradeSize,
        wasCapped: sizeValidation.wasCapped,
        reason: sizeValidation.reason,
      });

      if (claudeValidation.warnings.length > 0) {
        console.log("\n⚠️ Claude response warnings:");
        claudeValidation.warnings.forEach((warning) =>
          console.log(`   - ${warning}`),
        );
      }

      if (claudeComparison.finalDecision !== "BUY") {
        console.log(`\n🚫 Claude/strategy divergence — ${claudeComparison.reason}`);
      }
    }
  }

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: getAccurateTime(),
    signalGeneratedAt,
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    plannedPrice: price,
    actualPrice: price,
    slippagePercent: 0,
    executionTimeMs: 0,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    claudeSignalProvided: Boolean(claudeSignalRaw),
    claudeSignal,
    claudeValidation,
    claudeComparison,
    orderPlaced: false,
    orderSubmitted: false,
    orderId: null,
    orderStatus: "",
    fillTime: "",
    confirmationMethod: "",
    untrackedRecovery: false,
    side: "BUY",
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else if (tradeSize <= 0) {
    logEntry.error = "Claude trade size validation blocked execution";
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   ${logEntry.error}`);
  } else if (
    claudeSignalRaw &&
    (!claudeSignal || claudeComparison?.finalDecision !== "BUY")
  ) {
    logEntry.error = claudeSignal
      ? claudeComparison?.reason || "Claude rejected the trade"
      : `Claude response validation failed: ${claudeValidation.errors.join("; ")}`;
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   ${logEntry.error}`);
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    logger.info("VALIDATION", "Trade passed all validations", {
      symbol: logEntry.symbol,
      tradeSize: logEntry.tradeSize,
      claudeSignalProvided: logEntry.claudeSignalProvided,
    });
    await executeTradeWithHealthCheck(logEntry, log);
  }

  // Save decision log
  log.trades.push(logEntry);
  if (logEntry.orderPlaced) {
    recordForwardTestTrade(logEntry, backtestBaseline);
  }

  const postTradeAnalysis = analyzeLiveVsBacktest(log, backtestBaseline);
  if (
    postTradeAnalysis.liveTradeCount > 0 &&
    postTradeAnalysis.liveTradeCount % CONFIG.backtestIntervalTrades === 0
  ) {
    const forwardLog = loadForwardTestLog();
    forwardLog.reports.push({
      timestamp: getAccurateTime(),
      live_trade_count: postTradeAnalysis.liveTradeCount,
      overall_health: postTradeAnalysis.overall_health,
      divergences: postTradeAnalysis.divergences,
      recommendation: postTradeAnalysis.recommendation,
      report: postTradeAnalysis.report,
    });
    if (
      postTradeAnalysis.overall_health !== "GREEN" ||
      postTradeAnalysis.overfitting.detected
    ) {
      forwardLog.alerts.push({
        timestamp: getAccurateTime(),
        type: postTradeAnalysis.overfitting.detected
          ? "POSSIBLE_OVERFITTING"
          : "BACKTEST_DIVERGENCE_ALERT",
        overall_health: postTradeAnalysis.overall_health,
        recommendation: postTradeAnalysis.recommendation,
        findings: postTradeAnalysis.overfitting.findings,
      });
      recordSafetyCheck(log, "BACKTEST_DIVERGENCE_ALERT", {
        phase: "post_trade",
        overall_health: postTradeAnalysis.overall_health,
        divergences: postTradeAnalysis.divergences,
        recommendation: postTradeAnalysis.recommendation,
      });
      if (postTradeAnalysis.overfitting.detected) {
        recordSafetyCheck(log, "POSSIBLE_OVERFITTING", {
          findings: postTradeAnalysis.overfitting.findings,
          recommendation: postTradeAnalysis.overfitting.recommendation,
        });
      }
    }
    saveForwardTestLog(forwardLog);
    console.log("\nBacktest vs live report");
    console.log(postTradeAnalysis.report);
  }
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  logger.info("TRADE_EXECUTION", "Decision log persisted", {
    file: LOG_FILE,
    orderPlaced: logEntry.orderPlaced,
    error: logEntry.error || null,
  });

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);
  stopHealthMonitor();
  stopClockDriftMonitor();
  logger.info("STRATEGY", "Bot run finished", {
    symbol: CONFIG.symbol,
    orderPlaced: logEntry.orderPlaced,
    blocked: !logEntry.orderPlaced,
    error: logEntry.error || null,
  });

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    stopHealthMonitor();
    stopClockDriftMonitor();
    logger.error("ERROR", "Unhandled bot error", {
      message: err.message,
      stack: err.stack,
    });
    console.error("Bot error:", err);
    process.exit(1);
  });
}
