import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BANK_SLOTS, INVENTORY_SLOTS, START_ZONE } from '../shared/constants';
import { statsForLevel } from '../shared/gamedata';
import { EQUIP_SLOTS, type ChatChannel, type ClassId, type EquipSlot, type Item, type ZoneId } from '../shared/types';

export interface QuestProgress { progress: number; status: 'active' | 'complete' | 'done' }

export interface CharacterRecord {
  id: number;
  userId: number;
  name: string;
  cls: ClassId;
  level: number;
  xp: number;
  hp: number;
  mp: number;
  gold: number;
  zone: ZoneId;
  x: number;
  y: number;
  bag: (Item | null)[];
  equip: Record<EquipSlot, Item | null>;
  bank: (Item | null)[];
  quests: Record<string, QuestProgress>;
}

export interface UserRow { id: number; name: string; salt: Buffer; hash: Buffer }

export interface DropRow {
  id: number;
  zone: ZoneId;
  x: number;
  y: number;
  gold: number;
  item: Item | null;
  expiresAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salt BLOB NOT NULL,
  hash BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cls TEXT NOT NULL,
  level INTEGER NOT NULL,
  xp INTEGER NOT NULL,
  hp INTEGER NOT NULL,
  mp INTEGER NOT NULL,
  gold INTEGER NOT NULL,
  zone TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  char_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  container TEXT NOT NULL CHECK (container IN ('bag', 'equip', 'bank')),
  slot INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  UNIQUE (char_id, container, slot)
);
CREATE TABLE IF NOT EXISTS character_quests (
  char_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  quest_id TEXT NOT NULL,
  progress INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (char_id, quest_id)
);
CREATE TABLE IF NOT EXISTS world_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  gold INTEGER NOT NULL DEFAULT 0,
  item_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  target TEXT,
  zone TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_log(ts);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

export class GameDb {
  readonly db: Database.Database;

  private readonly stmts;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.stmts = {
      userByName: this.db.prepare('SELECT id, name, salt, hash FROM users WHERE name = ?'),
      insertUser: this.db.prepare('INSERT INTO users (name, salt, hash, created_at) VALUES (?, ?, ?, ?)'),
      touchLogin: this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
      insertChar: this.db.prepare(
        `INSERT INTO characters (user_id, name, cls, level, xp, hp, mp, gold, zone, x, y, updated_at)
         VALUES (@userId, @name, @cls, @level, @xp, @hp, @mp, @gold, @zone, @x, @y, @now)`),
      charByUser: this.db.prepare('SELECT * FROM characters WHERE user_id = ?'),
      saveChar: this.db.prepare(
        `UPDATE characters SET level=@level, xp=@xp, hp=@hp, mp=@mp, gold=@gold, zone=@zone, x=@x, y=@y, updated_at=@now
         WHERE id=@id`),
      delInv: this.db.prepare('DELETE FROM inventory WHERE char_id = ?'),
      insInv: this.db.prepare('INSERT INTO inventory (char_id, container, slot, item_json) VALUES (?, ?, ?, ?)'),
      invByChar: this.db.prepare('SELECT container, slot, item_json FROM inventory WHERE char_id = ?'),
      delQuests: this.db.prepare('DELETE FROM character_quests WHERE char_id = ?'),
      insQuest: this.db.prepare('INSERT INTO character_quests (char_id, quest_id, progress, status) VALUES (?, ?, ?, ?)'),
      questsByChar: this.db.prepare('SELECT quest_id, progress, status FROM character_quests WHERE char_id = ?'),
      insDrop: this.db.prepare('INSERT INTO world_drops (zone, x, y, gold, item_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      delDrop: this.db.prepare('DELETE FROM world_drops WHERE id = ?'),
      allDrops: this.db.prepare('SELECT * FROM world_drops WHERE expires_at > ?'),
      pruneDrops: this.db.prepare('DELETE FROM world_drops WHERE expires_at <= ?'),
      insChat: this.db.prepare('INSERT INTO chat_log (ts, channel, sender, target, zone, text) VALUES (?, ?, ?, ?, ?, ?)'),
      recentChat: this.db.prepare('SELECT ts, channel, sender, text FROM chat_log WHERE channel IN (\'global\') ORDER BY id DESC LIMIT ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- Accounts ------------------------------------------------------------------------------
  findUser(name: string): UserRow | null {
    return (this.stmts.userByName.get(name) as UserRow | undefined) ?? null;
  }

  /** Creates the account and its starter character atomically. Returns null if the name is taken. */
  createAccount(name: string, salt: Buffer, hash: Buffer, cls: ClassId): CharacterRecord | null {
    const create = this.db.transaction((): CharacterRecord | null => {
      if (this.findUser(name)) return null;
      const now = Date.now();
      const userId = Number(this.stmts.insertUser.run(name, salt, hash, now).lastInsertRowid);
      const s = statsForLevel(cls, 1);
      const rec: Omit<CharacterRecord, 'id'> = {
        userId, name, cls, level: 1, xp: 0, hp: s.maxHp, mp: s.maxMp, gold: 25,
        zone: START_ZONE, x: 40, y: 42,
        bag: new Array<Item | null>(INVENTORY_SLOTS).fill(null),
        equip: { weapon: null, armor: null, ring: null, amulet: null },
        bank: new Array<Item | null>(BANK_SLOTS).fill(null),
        quests: {},
      };
      const id = Number(this.stmts.insertChar.run({ ...rec, now }).lastInsertRowid);
      return { ...rec, id };
    });
    return create();
  }

  markLogin(userId: number): void {
    this.stmts.touchLogin.run(Date.now(), userId);
  }

  // ---- Characters ----------------------------------------------------------------------------
  loadCharacter(userId: number): CharacterRecord | null {
    const row = this.stmts.charByUser.get(userId) as Row | undefined;
    if (!row) return null;
    const id = row.id as number;
    const bag = new Array<Item | null>(INVENTORY_SLOTS).fill(null);
    const bank = new Array<Item | null>(BANK_SLOTS).fill(null);
    const equip: Record<EquipSlot, Item | null> = { weapon: null, armor: null, ring: null, amulet: null };
    for (const r of this.stmts.invByChar.all(id) as { container: string; slot: number; item_json: string }[]) {
      const item = JSON.parse(r.item_json) as Item;
      if (r.container === 'bag' && r.slot < bag.length) bag[r.slot] = item;
      else if (r.container === 'bank' && r.slot < bank.length) bank[r.slot] = item;
      else if (r.container === 'equip') {
        const slot = EQUIP_SLOTS[r.slot];
        if (slot) equip[slot] = item;
      }
    }
    const quests: Record<string, QuestProgress> = {};
    for (const q of this.stmts.questsByChar.all(id) as { quest_id: string; progress: number; status: QuestProgress['status'] }[]) {
      quests[q.quest_id] = { progress: q.progress, status: q.status };
    }
    return {
      id, userId, name: row.name as string, cls: row.cls as ClassId,
      level: row.level as number, xp: row.xp as number, hp: row.hp as number, mp: row.mp as number,
      gold: row.gold as number, zone: row.zone as ZoneId, x: row.x as number, y: row.y as number,
      bag, equip, bank, quests,
    };
  }

  /** Persist everything about a character in a single transaction. */
  saveCharacter(c: CharacterRecord): void {
    this.db.transaction(() => {
      this.stmts.saveChar.run({ ...c, now: Date.now() });
      this.stmts.delInv.run(c.id);
      c.bag.forEach((it, i) => { if (it) this.stmts.insInv.run(c.id, 'bag', i, JSON.stringify(it)); });
      c.bank.forEach((it, i) => { if (it) this.stmts.insInv.run(c.id, 'bank', i, JSON.stringify(it)); });
      EQUIP_SLOTS.forEach((slot, i) => { const it = c.equip[slot]; if (it) this.stmts.insInv.run(c.id, 'equip', i, JSON.stringify(it)); });
      this.stmts.delQuests.run(c.id);
      for (const [qid, q] of Object.entries(c.quests)) this.stmts.insQuest.run(c.id, qid, q.progress, q.status);
    })();
  }

  // ---- World drops ---------------------------------------------------------------------------
  addDrop(zone: ZoneId, x: number, y: number, gold: number, item: Item | null, ttlMs: number): number {
    const now = Date.now();
    return Number(this.stmts.insDrop.run(zone, x, y, gold, item ? JSON.stringify(item) : null, now, now + ttlMs).lastInsertRowid);
  }
  removeDrop(id: number): void {
    this.stmts.delDrop.run(id);
  }
  loadDrops(): DropRow[] {
    this.stmts.pruneDrops.run(Date.now());
    return (this.stmts.allDrops.all(Date.now()) as Row[]).map((r) => ({
      id: r.id as number, zone: r.zone as ZoneId, x: r.x as number, y: r.y as number, gold: r.gold as number,
      item: r.item_json ? (JSON.parse(r.item_json as string) as Item) : null, expiresAt: r.expires_at as number,
    }));
  }

  // ---- Chat / meta ---------------------------------------------------------------------------
  logChat(channel: ChatChannel, sender: string, text: string, zone?: ZoneId, target?: string): void {
    this.stmts.insChat.run(Date.now(), channel, sender, target ?? null, zone ?? null, text);
  }
  recentGlobalChat(limit: number): { ts: number; channel: string; sender: string; text: string }[] {
    return (this.stmts.recentChat.all(limit) as { ts: number; channel: string; sender: string; text: string }[]).reverse();
  }
  getMeta(key: string): string | null {
    return (this.stmts.getMeta.get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }
}
