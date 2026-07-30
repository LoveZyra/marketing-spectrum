import { backupDatabase, getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let backupTimer: NodeJS.Timeout | null = null;

/**
 * Starts the rolling database backup.
 *
 * Runs once shortly after boot and then daily, keeping the N most recent
 * snapshots. Disabled with PRISM_DB_BACKUP=0; retention is PRISM_DB_BACKUP_KEEP
 * (default 7) and the interval is PRISM_DB_BACKUP_INTERVAL_MS.
 *
 * The timer is unref'd so it never holds the process open during shutdown.
 */
export const startDatabaseBackups = (): void => {
    if (process.env.PRISM_DB_BACKUP === '0') return;
    if (backupTimer) return;

    const keep = Number.parseInt(process.env.PRISM_DB_BACKUP_KEEP ?? '', 10) || 7;
    const intervalMs =
        Number.parseInt(process.env.PRISM_DB_BACKUP_INTERVAL_MS ?? '', 10) || DAY_MS;

    // Delay the first run so it never competes with startup work (schema,
    // migrations, project scan) for the same write lock.
    const initial = setTimeout(() => backupDatabase(keep), 60_000);
    initial.unref();

    backupTimer = setInterval(() => backupDatabase(keep), intervalMs);
    backupTimer.unref();
};

/** Stops the backup timer. Used by the shutdown path and by tests. */
export const stopDatabaseBackups = (): void => {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
    }
};

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);
        startDatabaseBackups();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
