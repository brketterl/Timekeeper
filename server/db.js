import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, 'timekeeper.sqlite'));
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
  `);
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get()) {
    db.exec(`BEGIN;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE memberships (user_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), role TEXT NOT NULL CHECK(role IN ('owner','employee')),
        PRIMARY KEY(user_id, workspace_id));
      CREATE TABLE workspace_documents (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
        data TEXT NOT NULL CHECK(json_valid(data)), revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), expires_at INTEGER NOT NULL);
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      INSERT INTO schema_migrations VALUES (1);
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get()) {
    db.exec(`BEGIN;
      ALTER TABLE memberships RENAME TO memberships_v1;
      CREATE TABLE memberships (user_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        role TEXT NOT NULL CHECK(role IN ('admin','employee')), employee_id TEXT,
        PRIMARY KEY(user_id, workspace_id), UNIQUE(workspace_id, employee_id));
      INSERT INTO memberships
        SELECT m.user_id, m.workspace_id, CASE m.role WHEN 'owner' THEN 'admin' ELSE m.role END,
          CASE WHEN m.role = 'owner' THEN COALESCE(
            (SELECT json_extract(e.value, '$.id') FROM workspace_documents d, json_each(d.data, '$.employees') e
              WHERE d.workspace_id = m.workspace_id AND json_extract(e.value, '$.id') = m.user_id),
            (SELECT json_extract(data, '$.employees[0].id') FROM workspace_documents WHERE workspace_id = m.workspace_id))
          ELSE NULL END
        FROM memberships_v1 m;
      DROP TABLE memberships_v1;
      CREATE TABLE invitations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('admin','employee')),
        employee_id TEXT, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER);
      CREATE INDEX invitations_workspace ON invitations(workspace_id);
      `);
    try {
      const rows = db.prepare(`SELECT d.workspace_id, d.data, m.employee_id, u.email FROM workspace_documents d
        JOIN memberships m ON m.workspace_id = d.workspace_id JOIN users u ON u.id = m.user_id WHERE m.employee_id IS NOT NULL`).all();
      for (const row of rows) {
        const data = JSON.parse(row.data);
        const employee = data.employees.find(e => e.id === row.employee_id);
        if (employee) {
          employee.email = row.email;
          db.prepare('UPDATE workspace_documents SET data = ?, revision = revision + 1 WHERE workspace_id = ?').run(JSON.stringify(data), row.workspace_id);
        }
      }
      db.exec('INSERT INTO schema_migrations VALUES (2); COMMIT;');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get()) {
    db.exec(`BEGIN;
      CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        email TEXT NOT NULL, credential_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (3);
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get()) {
    db.exec(`BEGIN;
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL, actor_role TEXT NOT NULL CHECK(actor_role IN ('admin','employee')),
        event_type TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL,
        details TEXT NOT NULL CHECK(json_valid(details)), created_at INTEGER NOT NULL);
      CREATE INDEX audit_workspace ON audit_events(workspace_id,id DESC);
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit events cannot be updated'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit events cannot be deleted'); END;
      INSERT INTO schema_migrations VALUES(4);
      COMMIT;`);
  }
  return db;
}
