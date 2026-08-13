#!/usr/bin/env node
/**
 * Prism CLI
 *
 * Provides command-line utilities for managing Prism
 *
 * Commands:
 *   (no args)     - Start the server (default)
 *   start         - Start the server
 *   browser-use-mcp - Run Browser MCP stdio server
 *   status        - Show configuration and data locations
 *   help          - Show help information
 *   version       - Show version information
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { findAppRoot, getModuleDir, getDataDir } from './utils/runtime-paths.js';

const __dirname = getModuleDir(import.meta.url);
// The CLI is compiled into dist-server/server, but it still needs to read the top-level
// package.json and .env file. Resolving the app root once keeps those lookups stable.
const APP_ROOT = findAppRoot(__dirname);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
};

// Helper to colorize text
const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text) => `${colors.green}${text}${colors.reset}`,
    warn: (text) => `${colors.yellow}${text}${colors.reset}`,
    error: (text) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text) => `${colors.blue}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Load package.json for version info
const packageJsonPath = path.join(APP_ROOT, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
// Match the runtime fallback in load-env.js so "prism status" reports the same default
// database location that the backend will actually use when no DATABASE_PATH is configured.
// Resolved lazily (see getDatabasePath) so a PRISM_DATA_DIR value from .env is honored.
const getDefaultDatabasePath = () => path.join(getDataDir(), 'auth.db');

// Load environment variables from .env file if it exists
function loadEnvFile() {
    try {
        const envPath = path.join(APP_ROOT, '.env');
        const envFile = fs.readFileSync(envPath, 'utf8');
        envFile.split('\n').forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('#')) {
                const [key, ...valueParts] = trimmedLine.split('=');
                if (key && valueParts.length > 0 && !process.env[key]) {
                    process.env[key] = valueParts.join('=').trim();
                }
            }
        });
    } catch (e) {
        // .env file is optional
    }
}

// Get the database path (same logic as db.js)
function getDatabasePath() {
    loadEnvFile();
    return process.env.DATABASE_PATH || getDefaultDatabasePath();
}

// Get the installation directory
function getInstallDir() {
    return APP_ROOT;
}

// Show status command
function showStatus() {
    console.log(`\n${c.bright('Prism - Status')}\n`);
    console.log(c.dim('═'.repeat(60)));

    // Version info
    console.log(`\n${c.info('[INFO]')} Version: ${c.bright(packageJson.version)}`);

    // Installation location
    const installDir = getInstallDir();
    console.log(`\n${c.info('[INFO]')} Installation Directory:`);
    console.log(`       ${c.dim(installDir)}`);

    // Database location
    const dbPath = getDatabasePath();
    const dbExists = fs.existsSync(dbPath);
    console.log(`\n${c.info('[INFO]')} Database Location:`);
    console.log(`       ${c.dim(dbPath)}`);
    console.log(`       Status: ${dbExists ? c.ok('[OK] Exists') : c.warn('[WARN] Not created yet (will be created on first run)')}`);

    if (dbExists) {
        const stats = fs.statSync(dbPath);
        console.log(`       Size: ${c.dim((stats.size / 1024).toFixed(2) + ' KB')}`);
        console.log(`       Modified: ${c.dim(stats.mtime.toLocaleString())}`);
    }

    // Environment variables
    console.log(`\n${c.info('[INFO]')} Configuration:`);
    console.log(`       SERVER_PORT: ${c.bright(process.env.SERVER_PORT || process.env.PORT || '8080')} ${c.dim(process.env.SERVER_PORT || process.env.PORT ? '' : '(default)')}`);
    console.log(`       DATABASE_PATH: ${c.dim(process.env.DATABASE_PATH || '(using default location)')}`);
    console.log(`       CLAUDE_CLI_PATH: ${c.dim(process.env.CLAUDE_CLI_PATH || 'claude (default)')}`);
    console.log(`       CONTEXT_WINDOW: ${c.dim(process.env.CONTEXT_WINDOW || '160000 (default)')}`);

    // Claude projects folder
    const claudeProjectsPath = path.join(os.homedir(), '.claude', 'projects');
    const projectsExists = fs.existsSync(claudeProjectsPath);
    console.log(`\n${c.info('[INFO]')} Claude Projects Folder:`);
    console.log(`       ${c.dim(claudeProjectsPath)}`);
    console.log(`       Status: ${projectsExists ? c.ok('[OK] Exists') : c.warn('[WARN] Not found')}`);

    // Config file location
    const envFilePath = path.join(APP_ROOT, '.env');
    const envExists = fs.existsSync(envFilePath);
    console.log(`\n${c.info('[INFO]')} Configuration File:`);
    console.log(`       ${c.dim(envFilePath)}`);
    console.log(`       Status: ${envExists ? c.ok('[OK] Exists') : c.warn('[WARN] Not found (using defaults)')}`);

    console.log('\n' + c.dim('═'.repeat(60)));
    console.log(`\n${c.tip('[TIP]')} Hints:`);
    console.log(`      ${c.dim('>')} Use ${c.bright('prism --port 8080')} to run on a custom port`);
    console.log(`      ${c.dim('>')} Use ${c.bright('prism --database-path /path/to/db')} for custom database`);
    console.log(`      ${c.dim('>')} Run ${c.bright('prism help')} for all options`);
    console.log(`      ${c.dim('>')} Access the UI at http://localhost:${process.env.SERVER_PORT || process.env.PORT || '8080'}\n`);
}

// Show help
function showHelp() {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Prism - Command Line Tool                    ║
╚═══════════════════════════════════════════════════════════════╝

Usage:
  prism [command] [options]

Commands:
  start            Start the Prism server (default)
  browser-use-mcp  Run the Browser MCP stdio server
  status           Show configuration and data locations
  help             Show this help information
  version          Show version information

Options:
  -p, --port <port>           Set server port (default: 8080)
  --database-path <path>      Set custom database location
  -h, --help                  Show this help information
  -v, --version               Show version information

Examples:
  $ prism                        # Start with defaults
  $ prism --port 8080            # Start on port 8080
  $ prism status                 # Show configuration

Environment Variables:
  SERVER_PORT         Set server port (default: 8080)
  PORT                Set server port (default: 8080) (LEGACY)
  DATABASE_PATH       Set custom database location
  CLAUDE_CLI_PATH     Set custom Claude CLI path
  CONTEXT_WINDOW      Set context window size (default: 160000)
${packageJson.homepage ? `\nDocumentation:\n  ${packageJson.homepage}\n` : ''}${packageJson.bugs?.url ? `\nReport Issues:\n  ${packageJson.bugs.url}\n` : ''}`);
}

// Show version
function showVersion() {
    console.log(`${packageJson.version}`);
}

// ── Server ──────────────────────────────────────────────────

// Start the server
async function startServer() {
    // Import and run the server
    await import('./index.js');
}

async function startBrowserUseMcp() {
    await import('./browser-use-mcp.js');
}

// Parse CLI arguments
function parseArgs(args) {
    const parsed = { command: 'start', options: {} };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--port' || arg === '-p') {
            parsed.options.serverPort = args[++i];
        } else if (arg.startsWith('--port=')) {
            parsed.options.serverPort = arg.split('=')[1];
        } else if (arg === '--database-path') {
            parsed.options.databasePath = args[++i];
        } else if (arg.startsWith('--database-path=')) {
            parsed.options.databasePath = arg.split('=')[1];
        } else if (arg === '--help' || arg === '-h') {
            parsed.command = 'help';
        } else if (arg === '--version' || arg === '-v') {
            parsed.command = 'version';
        } else if (!arg.startsWith('-')) {
            parsed.command = arg;
        }
    }

    return parsed;
}

// Main CLI handler
async function main() {
    const args = process.argv.slice(2);
    const { command, options } = parseArgs(args);

    // Apply CLI options to environment variables
    if (options.serverPort) {
        process.env.SERVER_PORT = options.serverPort;
    } else if (!process.env.SERVER_PORT && process.env.PORT) {
        process.env.SERVER_PORT = process.env.PORT;
    }
    if (options.databasePath) {
        process.env.DATABASE_PATH = options.databasePath;
    }

    switch (command) {
        case 'start':
            await startServer();
            break;
        case 'browser-use-mcp':
            await startBrowserUseMcp();
            break;
        case 'status':
        case 'info':
            showStatus();
            break;
        case 'help':
        case '-h':
        case '--help':
            showHelp();
            break;
        case 'version':
        case '-v':
        case '--version':
            showVersion();
            break;
        default:
            console.error(`\n❌ Unknown command: ${command}`);
            console.log('   Run "prism help" for usage information.\n');
            process.exit(1);
    }
}

// Run the CLI
main().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});
