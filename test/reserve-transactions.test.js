import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const makeDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE platform_reserve_balances(asset_symbol TEXT PRIMARY KEY,balance_minor INTEGER NOT NULL CHECK(balance_minor>=0),reserved_minor INTEGER NOT NULL CHECK(reserved_minor>=0 AND reserved_minor<=balance_minor),required_minor INTEGER NOT NULL DEFAULT 0,deficit_minor INTEGER NOT NULL DEFAULT 0,updated_at TEXT); CREATE TABLE wallets(id TEXT PRIMARY KEY,balance_minor INTEGER NOT NULL,updated_at TEXT); CREATE TABLE paper_trades(id TEXT PRIMARY KEY,user_id TEXT,direction TEXT,status TEXT,margin_cents INTEGER); CREATE TABLE ledger_entries(id TEXT PRIMARY KEY,wallet_id TEXT,entry_type TEXT,amount_minor INTEGER,idempotency_key TEXT UNIQUE); CREATE TABLE platform_reserve_ledger(id TEXT PRIMARY KEY,asset_symbol TEXT,event_type TEXT,amount_minor INTEGER,reference_id TEXT,note TEXT,created_at TEXT,UNIQUE(event_type,reference_id)); INSERT INTO platform_reserve_balances VALUES('SYP',500,0,0,0,'now'),('USD',500,0,0,0,'now'); INSERT INTO wallets VALUES('wallet',1000,'now');");
  return db;
};

const runOpen = (db, lock) => {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE platform_reserve_balances SET required_minor=required_minor+?,reserved_minor=reserved_minor+? WHERE asset_symbol='SYP' AND balance_minor-reserved_minor>=?").run(lock,lock,lock);
    db.prepare("UPDATE wallets SET balance_minor=balance_minor-? WHERE id='wallet' AND balance_minor>=? AND changes()=1").run(100,100);
    db.prepare("INSERT INTO paper_trades(id,user_id,direction,status,margin_cents) SELECT 'trade','member','long','open',100 WHERE changes()=1").run();
    db.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key) SELECT 'debit','wallet','debit',100,'trade:margin' WHERE changes()=1").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
};

const closeStatements = (db, { pnl, release, lock }) => {
  const gain = pnl < 0 ? -pnl : 0, payout = pnl > 0 ? pnl : 0;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE wallets SET balance_minor=balance_minor+? WHERE id='wallet' AND EXISTS(SELECT 1 FROM paper_trades WHERE id='trade' AND status='open')").run(release);
    db.prepare("UPDATE platform_reserve_balances SET balance_minor=CASE WHEN ?>0 THEN balance_minor+MAX(0,?-deficit_minor) WHEN balance_minor>=? THEN balance_minor-? ELSE 0 END,deficit_minor=CASE WHEN ?>0 THEN MAX(0,deficit_minor-?) ELSE deficit_minor+MAX(0,?-balance_minor) END,reserved_minor=MIN(CASE WHEN ?>0 THEN balance_minor+MAX(0,?-deficit_minor) WHEN balance_minor>=? THEN balance_minor-? ELSE 0 END,MAX(0,reserved_minor-MIN(reserved_minor,?))),required_minor=MAX(0,required_minor-?),updated_at='now' WHERE asset_symbol='SYP' AND changes()=1 AND EXISTS(SELECT 1 FROM paper_trades WHERE id='trade' AND status='open')")
      .run(gain,gain,payout,payout,gain,gain,payout,gain,gain,payout,payout,lock,lock);
    db.prepare("UPDATE paper_trades SET status='closed' WHERE id='trade' AND status='open' AND changes()=1").run();
    db.prepare("INSERT INTO platform_reserve_ledger(id,asset_symbol,event_type,amount_minor,reference_id,note,created_at) SELECT 'reserve-event','SYP','trade_payout',?,'trade','settlement','now' WHERE changes()=1").run(gain-payout);
    db.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key) SELECT 'credit','wallet','credit',?,'trade:settlement' WHERE EXISTS(SELECT 1 FROM paper_trades WHERE id='trade' AND status='closed') AND ?>0").run(release,release);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
};

test("opening requires funded reserve before debiting the member wallet", () => {
  const db = makeDb();
  runOpen(db, 600);
  assert.equal(db.prepare("SELECT balance_minor FROM wallets WHERE id='wallet'").get().balance_minor, 1000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get().n, 0);
  assert.equal(db.prepare("SELECT reserved_minor FROM platform_reserve_balances WHERE asset_symbol='SYP'").get().reserved_minor, 0);
  runOpen(db, 400);
  assert.equal(db.prepare("SELECT balance_minor FROM wallets WHERE id='wallet'").get().balance_minor, 900);
  assert.equal(db.prepare("SELECT status FROM paper_trades WHERE id='trade'").get().status, "open");
  assert.equal(db.prepare("SELECT reserved_minor FROM platform_reserve_balances WHERE asset_symbol='SYP'").get().reserved_minor, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE idempotency_key='trade:margin'").get().n, 1);
  db.close();
});

test("closing pays profit once and keeps reserve reserved below its new balance", () => {
  const db = makeDb();
  db.prepare("UPDATE platform_reserve_balances SET balance_minor=1000,reserved_minor=1000,required_minor=1000 WHERE asset_symbol='SYP'").run();
  db.prepare("INSERT INTO paper_trades VALUES('trade','member','long','open',100)").run();
  closeStatements(db, { pnl: 50, release: 150, lock: 100 });
  assert.equal(db.prepare("SELECT balance_minor FROM wallets WHERE id='wallet'").get().balance_minor, 1150);
  const reserve = db.prepare("SELECT balance_minor,reserved_minor,required_minor,deficit_minor FROM platform_reserve_balances WHERE asset_symbol='SYP'").get();
  assert.deepEqual({...reserve}, {balance_minor:950,reserved_minor:900,required_minor:900,deficit_minor:0});
  assert.equal(db.prepare("SELECT amount_minor FROM platform_reserve_ledger WHERE reference_id='trade'").get().amount_minor, -50);
  db.close();
});

test("legacy uncovered payout records a deficit without making reserve balance negative", () => {
  const db = makeDb();
  db.prepare("UPDATE platform_reserve_balances SET balance_minor=20,reserved_minor=20,required_minor=20 WHERE asset_symbol='SYP'").run();
  db.prepare("INSERT INTO paper_trades VALUES('trade','member','long','open',100)").run();
  closeStatements(db, { pnl: 50, release: 150, lock: 20 });
  const reserve = db.prepare("SELECT balance_minor,reserved_minor,required_minor,deficit_minor FROM platform_reserve_balances WHERE asset_symbol='SYP'").get();
  assert.deepEqual({...reserve}, {balance_minor:0,reserved_minor:0,required_minor:0,deficit_minor:30});
  db.prepare("UPDATE platform_reserve_balances SET balance_minor=balance_minor+MAX(0,40-deficit_minor),deficit_minor=MAX(0,deficit_minor-40) WHERE asset_symbol='SYP'").run();
  assert.deepEqual({...db.prepare("SELECT balance_minor,deficit_minor FROM platform_reserve_balances WHERE asset_symbol='SYP'").get()}, {balance_minor:10,deficit_minor:0});
  db.close();
});

test("failed reference-price coverage check cannot update the market target or rate", () => {
  const db = makeDb();
  db.exec("CREATE TABLE market_price_targets(instrument_id TEXT PRIMARY KEY,target_price_micro INTEGER,from_price_micro INTEGER,transition_started_at TEXT,transition_seconds INTEGER,updated_by TEXT,updated_at TEXT); CREATE TABLE market_bots(instrument_id TEXT PRIMARY KEY,enabled INTEGER,volatility_bps INTEGER,drift_bps INTEGER,updated_by TEXT,updated_at TEXT); CREATE TABLE exchange_rates(id TEXT PRIMARY KEY,base_symbol TEXT,quote_symbol TEXT,rate REAL,updated_by TEXT,updated_at TEXT,UNIQUE(base_symbol,quote_symbol)); INSERT INTO market_price_targets VALUES('syr-usd-syp',1000,1000,'old',60,'admin','old'); INSERT INTO exchange_rates VALUES('usd-syp','USD','SYP',1000,'admin','old'); UPDATE platform_reserve_balances SET balance_minor=10 WHERE asset_symbol='SYP';");
  const updateReserve = db.prepare("UPDATE platform_reserve_balances SET required_minor=CASE asset_symbol WHEN 'SYP' THEN 100 ELSE 0 END,reserved_minor=CASE asset_symbol WHEN 'SYP' THEN 100 ELSE 0 END WHERE asset_symbol IN ('SYP','USD') AND (SELECT COUNT(*) FROM platform_reserve_balances WHERE deficit_minor=0 AND ((asset_symbol='SYP' AND balance_minor>=100) OR (asset_symbol='USD' AND balance_minor>=0)))=2");
  const updateTarget = db.prepare("INSERT INTO market_price_targets(instrument_id,target_price_micro,from_price_micro,transition_started_at,transition_seconds,updated_by,updated_at) SELECT 'syr-usd-syp',2000,1000,'new',900,'admin','new' WHERE changes()=2 ON CONFLICT(instrument_id) DO UPDATE SET target_price_micro=excluded.target_price_micro,from_price_micro=excluded.from_price_micro,transition_started_at=excluded.transition_started_at,transition_seconds=excluded.transition_seconds,updated_by=excluded.updated_by,updated_at=excluded.updated_at");
  const updateBot = db.prepare("INSERT INTO market_bots(instrument_id,enabled,volatility_bps,drift_bps,updated_by,updated_at) SELECT 'syr-usd-syp',1,80,0,'admin','new' WHERE changes()=1 ON CONFLICT(instrument_id) DO UPDATE SET enabled=1,updated_by=excluded.updated_by,updated_at=excluded.updated_at");
  const updateRate = db.prepare("INSERT INTO exchange_rates(id,base_symbol,quote_symbol,rate,updated_by,updated_at) SELECT 'usd-syp','USD','SYP',2000,'admin','new' WHERE changes()=1 ON CONFLICT(base_symbol,quote_symbol) DO UPDATE SET rate=excluded.rate,updated_by=excluded.updated_by,updated_at=excluded.updated_at");
  db.exec("BEGIN"); updateReserve.run(); updateTarget.run(); updateBot.run(); updateRate.run(); db.exec("COMMIT");
  assert.equal(db.prepare("SELECT target_price_micro FROM market_price_targets").get().target_price_micro, 1000);
  assert.equal(db.prepare("SELECT rate FROM exchange_rates").get().rate, 1000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_bots").get().n, 0);
  db.close();
});
