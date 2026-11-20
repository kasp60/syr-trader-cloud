const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      ...headers
    }
  });

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 7;
const COOKIE_NAME = "syr_session";

const base64url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

const fromBase64url = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const randomToken = (size = 32) => {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return base64url(bytes);
};

const sha256 = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
};

const passwordHash = async (password, salt = crypto.getRandomValues(new Uint8Array(16))) => {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
};

const verifyPassword = async (password, stored) => {
  const [algorithm, iterationsText, saltText, expectedText] = String(stored).split("$");
  if (algorithm !== "pbkdf2" || !iterationsText || !saltText || !expectedText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 100000) return false;
  const actual = await passwordHashWithParams(password, fromBase64url(saltText), iterations);
  const actualBytes = fromBase64url(actual.split("$")[3]);
  const expectedBytes = fromBase64url(expectedText);
  if (actualBytes.length !== expectedBytes.length) return false;
  let difference = 0;
  for (let i = 0; i < actualBytes.length; i++) difference |= actualBytes[i] ^ expectedBytes[i];
  return difference === 0;
};

const passwordHashWithParams = async (password, salt, iterations) => {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256
  );
  return `pbkdf2$${iterations}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
};

const getCookie = (request, name) => {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return entry ? entry.slice(name.length + 1) : null;
};

const sessionCookie = (token, maxAge) =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const readJson = async (request) => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("CONTENT_TYPE");
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 8192) throw new Error("TOO_LARGE");
  return request.json();
};

const createSession = async (db, userId) => {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.prepare("DELETE FROM sessions WHERE user_id=? AND expires_at<=?").bind(userId,new Date().toISOString()).run();
  await db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), userId, tokenHash, expiresAt).run();
  return token;
};

const currentUser = async (request, db) => {
  const token = getCookie(request, COOKIE_NAME);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const result = await db.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`
  ).bind(tokenHash, new Date().toISOString()).first();
  return result || null;
};


const requireSameOrigin = (request, url) => {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === url.origin);
};


const ensurePaperSchema = async (db) => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS market_instruments (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      quote_symbol TEXT NOT NULL DEFAULT 'USD', is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS market_prices (
      instrument_id TEXT PRIMARY KEY REFERENCES market_instruments(id) ON DELETE CASCADE,
      price_micro INTEGER NOT NULL CHECK(price_micro > 0),
      updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS market_price_targets (
      instrument_id TEXT PRIMARY KEY REFERENCES market_instruments(id) ON DELETE CASCADE,
      target_price_micro INTEGER NOT NULL CHECK(target_price_micro > 0),
      from_price_micro INTEGER NOT NULL CHECK(from_price_micro > 0),
      transition_started_at TEXT NOT NULL,
      transition_seconds INTEGER NOT NULL CHECK(transition_seconds BETWEEN 60 AND 86400),
      updated_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      cash_cents INTEGER NOT NULL DEFAULT 1000000 CHECK(cash_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_positions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      quantity_micro INTEGER NOT NULL DEFAULT 0 CHECK(quantity_micro >= 0),
      PRIMARY KEY(user_id,instrument_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      side TEXT NOT NULL CHECK(side IN ('buy','sell')), quantity_micro INTEGER NOT NULL CHECK(quantity_micro > 0),
      price_micro INTEGER NOT NULL CHECK(price_micro > 0), total_cents INTEGER NOT NULL CHECK(total_cents > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_orders_user_created ON paper_orders(user_id,created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL CHECK(direction IN ('long','short')),
      quantity_micro INTEGER NOT NULL CHECK(quantity_micro>0),
      entry_price_micro INTEGER NOT NULL CHECK(entry_price_micro>0),
      leverage INTEGER NOT NULL DEFAULT 1 CHECK(leverage BETWEEN 1 AND 20),
      margin_cents INTEGER NOT NULL CHECK(margin_cents>0),
      margin_asset_symbol TEXT NOT NULL DEFAULT 'SYP' CHECK(margin_asset_symbol IN ('SYP','USD')),
      liquidation_price_micro INTEGER NOT NULL DEFAULT 1 CHECK(liquidation_price_micro>0),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','liquidated')),
      opened_at TEXT NOT NULL, closed_at TEXT, exit_price_micro INTEGER, pnl_cents INTEGER
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_trades_user_status ON paper_trades(user_id,status,opened_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_limit_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL CHECK(direction IN ('long','short')),
      margin_minor INTEGER NOT NULL CHECK(margin_minor>0),
      margin_asset_symbol TEXT NOT NULL CHECK(margin_asset_symbol IN ('SYP','USD')),
      leverage INTEGER NOT NULL CHECK(leverage BETWEEN 1 AND 20),
      limit_price_micro INTEGER NOT NULL CHECK(limit_price_micro>0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','filled','cancelled')),
      trade_id TEXT, created_at TEXT NOT NULL, filled_at TEXT, cancelled_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_limit_orders_user_status ON paper_limit_orders(user_id,status,created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(id) ON DELETE RESTRICT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('buy','sell')),
      cash_delta_cents INTEGER NOT NULL, quantity_delta_micro INTEGER NOT NULL,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      price_micro INTEGER NOT NULL, created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_ledger_user_created ON paper_ledger(user_id,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS market_bots (instrument_id TEXT PRIMARY KEY REFERENCES market_instruments(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), volatility_bps INTEGER NOT NULL DEFAULT 80 CHECK(volatility_bps BETWEEN 1 AND 2000), drift_bps INTEGER NOT NULL DEFAULT 0 CHECK(drift_bps BETWEEN -500 AND 500), last_tick_at TEXT, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS market_price_history (id TEXT PRIMARY KEY, instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE CASCADE, price_micro INTEGER NOT NULL CHECK(price_micro > 0), source TEXT NOT NULL CHECK(source IN ('manual','bot')), created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_market_history_instrument_time ON market_price_history(instrument_id,created_at)")
  ]);
  const tradeTable=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='paper_trades'").first();
  if(String(tradeTable?.sql||"").includes("CHECK(leverage=20)")){
    await db.batch([
      db.prepare("ALTER TABLE paper_trades RENAME TO paper_trades_legacy"),
      db.prepare(`CREATE TABLE paper_trades (
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
        direction TEXT NOT NULL CHECK(direction IN ('long','short')),quantity_micro INTEGER NOT NULL CHECK(quantity_micro>0),
        entry_price_micro INTEGER NOT NULL CHECK(entry_price_micro>0),leverage INTEGER NOT NULL DEFAULT 1 CHECK(leverage BETWEEN 1 AND 20),
        margin_cents INTEGER NOT NULL CHECK(margin_cents>0),
        margin_asset_symbol TEXT NOT NULL DEFAULT 'SYP' CHECK(margin_asset_symbol IN ('SYP','USD')),
        liquidation_price_micro INTEGER NOT NULL DEFAULT 1 CHECK(liquidation_price_micro>0),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','liquidated')),
        opened_at TEXT NOT NULL,closed_at TEXT,exit_price_micro INTEGER,pnl_cents INTEGER
      )`),
      db.prepare("UPDATE paper_accounts SET cash_cents=cash_cents+COALESCE((SELECT SUM(margin_cents) FROM paper_trades_legacy WHERE user_id=paper_accounts.user_id AND status='open'),0) WHERE EXISTS(SELECT 1 FROM paper_trades_legacy WHERE user_id=paper_accounts.user_id AND status='open')"),
      db.prepare("INSERT INTO paper_trades(id,user_id,instrument_id,direction,quantity_micro,entry_price_micro,leverage,margin_cents,status,opened_at,closed_at,exit_price_micro,pnl_cents) SELECT id,user_id,instrument_id,direction,quantity_micro,entry_price_micro,CASE WHEN leverage BETWEEN 1 AND 20 THEN leverage ELSE 1 END,margin_cents,CASE WHEN status='open' THEN 'closed' ELSE status END,opened_at,CASE WHEN status='open' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE closed_at END,CASE WHEN status='open' THEN entry_price_micro ELSE exit_price_micro END,CASE WHEN status='open' THEN 0 ELSE pnl_cents END FROM paper_trades_legacy"),
      db.prepare("DROP TABLE paper_trades_legacy"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_trades_user_status ON paper_trades(user_id,status,opened_at)")
    ]);
  }
  const tradeColumns=await db.prepare("PRAGMA table_info(paper_trades)").all();
  if(!(tradeColumns.results||[]).some(c=>c.name==="margin_asset_symbol")){
    await db.prepare("UPDATE paper_accounts SET cash_cents=cash_cents+COALESCE((SELECT SUM(margin_cents) FROM paper_trades WHERE user_id=paper_accounts.user_id AND status='open'),0) WHERE EXISTS(SELECT 1 FROM paper_trades WHERE user_id=paper_accounts.user_id AND status='open')").run();
    await db.prepare("UPDATE paper_trades SET status='closed',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),exit_price_micro=entry_price_micro,pnl_cents=0 WHERE status='open'").run();
    await db.prepare("ALTER TABLE paper_trades ADD COLUMN margin_asset_symbol TEXT NOT NULL DEFAULT 'SYP'").run();
  }
  if(!(tradeColumns.results||[]).some(c=>c.name==="liquidation_price_micro"))await db.prepare("ALTER TABLE paper_trades ADD COLUMN liquidation_price_micro INTEGER NOT NULL DEFAULT 1").run();
};

const ensureFinanceSchema = async (db) => {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS member_codes (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"),
    db.prepare("CREATE TABLE IF NOT EXISTS deposit_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, amount_minor INTEGER NOT NULL CHECK(amount_minor>0), asset_symbol TEXT NOT NULL DEFAULT 'SYP' CHECK(asset_symbol IN ('SYP','USD')), proof_base64 TEXT NOT NULL, proof_mime TEXT NOT NULL, proof_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_deposit_requests_status_created ON deposit_requests(status,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS withdrawal_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, amount_minor INTEGER NOT NULL CHECK(amount_minor>0), payout_details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status_created ON withdrawal_requests(status,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS internal_transfers (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, amount_minor INTEGER NOT NULL CHECK(amount_minor>0), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), CHECK(sender_id<>recipient_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_internal_transfers_sender_created ON internal_transfers(sender_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_internal_transfers_recipient_created ON internal_transfers(recipient_id,created_at)")
  ]);
  const depositColumns=await db.prepare("PRAGMA table_info(deposit_requests)").all();
  if(!(depositColumns.results||[]).some(column=>column.name==="asset_symbol")){
    await db.prepare("ALTER TABLE deposit_requests ADD COLUMN asset_symbol TEXT NOT NULL DEFAULT 'SYP'").run();
  }
  const missing=await db.prepare("SELECT u.id FROM users u LEFT JOIN member_codes m ON m.user_id=u.id WHERE m.user_id IS NULL").all();
  for(const row of (missing.results||[])){
    for(let attempt=0;attempt<8;attempt++){
      const bytes=crypto.getRandomValues(new Uint32Array(1));
      const code=String(1000000000+(bytes[0]%9000000000)).slice(0,10);
      try{const result=await db.prepare("INSERT OR IGNORE INTO member_codes(user_id,code) VALUES(?,?)").bind(row.id,code).run();if(Number(result.meta?.changes||0)>0)break;}catch{}
    }
  }
};

const ensureSypMarket = async (db) => {
  await ensurePaperSchema(db);
  await db.prepare("INSERT OR IGNORE INTO market_instruments(id,symbol,name,quote_symbol,is_active) VALUES('syr-usd-syp','USD/SYP','الدولار مقابل الليرة','SYP',1)").run();
  const rate=await db.prepare("SELECT rate FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1").first();
  if(rate&&Number(rate.rate)>0){
    const priceMicro=Math.round(Number(rate.rate)*1000000);
    if(Number.isSafeInteger(priceMicro)&&priceMicro>0){
      const now=new Date().toISOString();
      const existing=await db.prepare("SELECT price_micro AS priceMicro FROM market_prices WHERE instrument_id='syr-usd-syp'").first();
      if(!existing)await db.batch([
        db.prepare("INSERT INTO market_prices(instrument_id,price_micro,updated_at) VALUES('syr-usd-syp',?,?)").bind(priceMicro,now),
        db.prepare("INSERT INTO market_price_history(id,instrument_id,price_micro,source,created_at) VALUES(?,'syr-usd-syp',?,'manual',?)").bind(crypto.randomUUID(),priceMicro,now)
      ]);
      await db.prepare("INSERT INTO market_bots(instrument_id,enabled,volatility_bps,drift_bps,updated_at) VALUES('syr-usd-syp',1,80,0,?) ON CONFLICT(instrument_id) DO UPDATE SET enabled=1,updated_at=excluded.updated_at").bind(now).run();
    }
  }
};

const bytesToBase64 = (bytes) => {
  let binary="";
  for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
  return btoa(binary);
};

const runScheduledMarketBots = async (db) => {
  await ensurePaperSchema(db);
  const result = await db.prepare(`SELECT b.instrument_id AS instrumentId,b.volatility_bps AS volatilityBps,
    b.drift_bps AS driftBps,p.price_micro AS priceMicro,t.target_price_micro AS targetPriceMicro,
    t.from_price_micro AS fromPriceMicro,t.transition_started_at AS transitionStartedAt,
    t.transition_seconds AS transitionSeconds
    FROM market_bots b JOIN market_prices p ON p.instrument_id=b.instrument_id
    JOIN market_instruments i ON i.id=b.instrument_id
    LEFT JOIN market_price_targets t ON t.instrument_id=b.instrument_id
    WHERE b.enabled=1 AND i.is_active=1 AND i.symbol='USD/SYP'`).all();
  let changed=0;
  for (const bot of (result.results || [])) {
    const previous=Number(bot.priceMicro),target=Number(bot.targetPriceMicro||0);
    const started=Date.parse(String(bot.transitionStartedAt||""));
    const durationMs=Number(bot.transitionSeconds||0)*1000;
    const elapsed=Date.now()-started;
    const transitioning=Number.isSafeInteger(target)&&target>0&&Number.isSafeInteger(Number(bot.fromPriceMicro))&&
      Number(bot.fromPriceMicro)>0&&Number.isFinite(started)&&durationMs>=60000&&elapsed>=0&&elapsed<durationMs;
    let next;
    if(transitioning){
      const from=BigInt(bot.fromPriceMicro),to=BigInt(target);
      next=Number(from+(to-from)*BigInt(Math.max(0,elapsed))/BigInt(durationMs));
    }else{
      const bytes=new Uint32Array(1); crypto.getRandomValues(bytes);
      const noise=(bytes[0]/4294967295)*2-1;
      const baseTarget=target>0?target:Number((await db.prepare("SELECT rate*1000000 AS price FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1").first())?.price||previous);
      const reversion=baseTarget>0?Math.max(-300,Math.min(300,Math.round(((baseTarget-previous)/baseTarget)*1200))):0;
      const boundedMove=Math.max(-120,Math.min(120,Math.round(Number(bot.driftBps)+noise*Number(bot.volatilityBps))));
      next=Math.max(1,Math.round(previous*(1+(reversion+boundedMove)/10000)));
    }
    if(!Number.isSafeInteger(next)||next<=0||next===previous)continue;
    const now=new Date().toISOString();
    const batch=await db.batch([
      db.prepare("UPDATE market_prices SET price_micro=?,updated_at=? WHERE instrument_id=? AND price_micro=? AND EXISTS (SELECT 1 FROM market_bots WHERE instrument_id=? AND enabled=1)").bind(next,now,bot.instrumentId,previous,bot.instrumentId),
      db.prepare("INSERT INTO market_price_history (id,instrument_id,price_micro,source,created_at) SELECT ?,?,?,'bot',? WHERE changes()=1").bind(crypto.randomUUID(),bot.instrumentId,next,now),
      db.prepare("UPDATE market_bots SET last_tick_at=? WHERE instrument_id=? AND enabled=1").bind(now,bot.instrumentId),
      db.prepare("UPDATE exchange_rates SET rate=?,updated_at=? WHERE base_symbol='USD' AND quote_symbol='SYP' AND EXISTS(SELECT 1 FROM market_prices WHERE instrument_id=? AND price_micro=?)").bind(next/1000000,now,bot.instrumentId,next)
    ]);
    if(Number(batch[0]?.meta?.changes||0)>0)changed++;
  }
  await processPendingLimitOrders(db);
  await settleLiquidatedTrades(db);
  return {checked:(result.results||[]).length,changed};
};


const MARKET_SPREAD_BPS = 10; // 0.10% per side; 0.20% round-trip spread
const marketQuote = (midPrice, side) => {
  const mid = BigInt(midPrice);
  const factor = side === "ask" ? 10000n + BigInt(MARKET_SPREAD_BPS) : 10000n - BigInt(MARKET_SPREAD_BPS);
  const scaled = mid * factor;
  return side === "ask" ? (scaled + 9999n) / 10000n : scaled / 10000n;
};

const processPendingLimitOrders = async (db) => {
  const pending = await db.prepare("SELECT o.id,o.user_id AS userId,o.instrument_id AS instrumentId,o.direction,o.margin_minor AS marginMinor,o.margin_asset_symbol AS marginAssetSymbol,o.leverage,o.limit_price_micro AS limitPriceMicro,p.price_micro AS currentPriceMicro FROM paper_limit_orders o JOIN market_prices p ON p.instrument_id=o.instrument_id WHERE o.status='pending'").all();
  let filled = 0;
  for (const order of (pending.results || [])) {
    const current = BigInt(order.currentPriceMicro), limit = BigInt(order.limitPriceMicro);
    const triggered = order.direction === "long" ? current <= limit : current >= limit;
    if (!triggered) continue;
    const entry = marketQuote(current, order.direction === "long" ? "ask" : "bid"), leverage = BigInt(order.leverage), margin = BigInt(order.marginMinor);
    const quantity = order.direction === "long" ? (margin * leverage * 1000000000000n + entry / 2n) / entry : margin * leverage * 10000n;
    if (quantity <= 0n || quantity > 9007199254740991n) continue;
    const liquidation = order.direction === "long" ? (entry * BigInt(order.leverage - 1) / leverage) || 1n : entry * BigInt(order.leverage + 1) / leverage;
    const tradeId = crypto.randomUUID(), now = new Date().toISOString();
    const result = await db.batch([
      db.prepare("INSERT INTO paper_trades(id,user_id,instrument_id,direction,quantity_micro,entry_price_micro,leverage,margin_cents,margin_asset_symbol,liquidation_price_micro,status,opened_at) SELECT ?,?,?,?,?,?,?,?,?,?,'open',? FROM paper_limit_orders o WHERE o.id=? AND o.status='pending' AND EXISTS(SELECT 1 FROM market_prices p WHERE p.instrument_id=o.instrument_id AND p.price_micro=? AND ((o.direction='long' AND p.price_micro<=o.limit_price_micro) OR (o.direction='short' AND p.price_micro>=o.limit_price_micro)))")
        .bind(tradeId,order.userId,order.instrumentId,order.direction,Number(quantity),Number(entry),order.leverage,Number(margin),order.marginAssetSymbol,Number(liquidation),now,order.id,Number(order.currentPriceMicro)),
      db.prepare("UPDATE paper_limit_orders SET status='filled',trade_id=?,filled_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM paper_trades WHERE id=?)").bind(tradeId,now,order.id,tradeId)
    ]);
    if (Number(result?.[0]?.meta?.changes || 0) > 0 && Number(result?.[1]?.meta?.changes || 0) > 0) filled++;
  }
  return filled;
};

const settleLiquidatedTrades = async (db) => {
  const rows=await db.prepare(`SELECT t.id,t.user_id AS userId,t.direction,t.liquidation_price_micro AS liquidationPriceMicro,
    p.price_micro AS currentPriceMicro FROM paper_trades t JOIN market_prices p ON p.instrument_id=t.instrument_id WHERE t.status='open'`).all();
  let liquidated=0;
  for(const t of (rows.results||[])){
    const executablePrice=Number(marketQuote(t.currentPriceMicro,t.direction==="long"?"bid":"ask")),triggered=t.direction==="long"?executablePrice<=Number(t.liquidationPriceMicro):executablePrice>=Number(t.liquidationPriceMicro);
    if(!triggered)continue;
    const result=await db.prepare("UPDATE paper_trades SET status='liquidated',closed_at=?,exit_price_micro=?,pnl_cents=-margin_cents WHERE id=? AND user_id=? AND status='open'").bind(new Date().toISOString(),executablePrice,t.id,t.userId).run();
    if(Number(result.meta?.changes||0)>0)liquidated++;
  }
  return liquidated;
};

const walletApi = async (request, env, url) => {
  const user = await currentUser(request, env.DB);
  if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
  await ensureFinanceSchema(env.DB);
  if (url.pathname.startsWith("/api/market/") || url.pathname.startsWith("/api/paper/") ||
      url.pathname.startsWith("/api/admin/market-")) {
    await ensureSypMarket(env.DB);
    await env.DB.prepare("INSERT OR IGNORE INTO paper_accounts (user_id,cash_cents) VALUES (?,1000000)").bind(user.id).run();
  }

  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    const rows = await env.DB.prepare(
      `SELECT u.id, u.email, u.display_name AS displayName, u.role, u.status, u.created_at AS createdAt, m.code AS memberCode
       FROM users u LEFT JOIN member_codes m ON m.user_id=u.id ORDER BY u.created_at DESC LIMIT 500`
    ).all();
    return json({ ok: true, users: rows.results || [] });
  }

  if (url.pathname === "/api/admin/user-status" && request.method === "POST") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const userId = String(body.userId || "");
    const status = String(body.status || "");
    if (!userId || userId.length > 80 || !["active", "suspended"].includes(status)) {
      return json({ ok: false, error: "بيانات المستخدم غير صحيحة" }, 400);
    }
    if (userId === user.id && status === "suspended") {
      return json({ ok: false, error: "لا يمكنك إيقاف حسابك الحالي" }, 400);
    }
    const target = await env.DB.prepare(
      "SELECT id, role, status FROM users WHERE id = ? LIMIT 1"
    ).bind(userId).first();
    if (!target) return json({ ok: false, error: "المستخدم غير موجود" }, 404);
    if (target.role === "admin" && target.status === "active" && status === "suspended") {
      const admins = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'"
      ).first();
      if (Number(admins?.count || 0) <= 1) {
        return json({ ok: false, error: "لا يمكن إيقاف المدير النشط الأخير" }, 409);
      }
    }
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, userId).run();
    if (status === "suspended") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    }
    return json({ ok: true, userId, status });
  }


  if (url.pathname === "/api/market/chart" && request.method === "GET") {
    const rows=await env.DB.prepare("SELECT price_micro AS priceMicro,created_at AS createdAt,source FROM market_price_history WHERE instrument_id='syr-usd-syp' ORDER BY created_at DESC LIMIT 1440").all();
    return json({ok:true,points:(rows.results||[]).reverse()});
  }
  if (url.pathname === "/api/market/board" && request.method === "GET") {
    await processPendingLimitOrders(env.DB);
    await settleLiquidatedTrades(env.DB);
    const [market, account, positions, orders, limitOrders] = await Promise.all([
      env.DB.prepare(`SELECT i.id,i.symbol,i.name,i.quote_symbol AS quoteSymbol,p.price_micro AS priceMicro,p.updated_at AS updatedAt,COALESCE(b.enabled,0) AS botEnabled
        FROM market_instruments i LEFT JOIN market_prices p ON p.instrument_id=i.id LEFT JOIN market_bots b ON b.instrument_id=i.id
        WHERE i.is_active=1 AND i.symbol='USD/SYP' ORDER BY i.symbol`).all(),
      env.DB.prepare("SELECT cash_cents AS cashCents FROM paper_accounts WHERE user_id=?").bind(user.id).first(),
      env.DB.prepare(`SELECT pp.instrument_id AS instrumentId,pp.quantity_micro AS quantityMicro,i.symbol
        FROM paper_positions pp JOIN market_instruments i ON i.id=pp.instrument_id
        WHERE pp.user_id=? AND pp.quantity_micro>0 AND i.symbol='USD/SYP'`).bind(user.id).all(),
      env.DB.prepare(`SELECT o.id,o.side,o.quantity_micro AS quantityMicro,o.price_micro AS priceMicro,
        o.total_cents AS totalCents,o.created_at AS createdAt,i.symbol
        FROM paper_orders o JOIN market_instruments i ON i.id=o.instrument_id
        WHERE o.user_id=? AND i.symbol='USD/SYP' ORDER BY o.created_at DESC LIMIT 50`).bind(user.id).all(),
      env.DB.prepare("SELECT o.id,o.direction,o.margin_minor AS marginMinor,o.margin_asset_symbol AS marginAssetSymbol,o.leverage,o.limit_price_micro AS limitPriceMicro,o.created_at AS createdAt,i.symbol FROM paper_limit_orders o JOIN market_instruments i ON i.id=o.instrument_id WHERE o.user_id=? AND o.status='pending' ORDER BY o.created_at DESC LIMIT 100").bind(user.id).all()
    ]);
    const [openTrades,closedTrades,walletRows]=await Promise.all([
      env.DB.prepare(`SELECT t.id,t.direction,t.quantity_micro AS quantityMicro,t.entry_price_micro AS entryPriceMicro,
        t.leverage,t.margin_cents AS marginCents,t.margin_asset_symbol AS marginAssetSymbol,
        t.liquidation_price_micro AS liquidationPriceMicro,t.opened_at AS openedAt,i.symbol,p.price_micro AS midPriceMicro
        FROM paper_trades t JOIN market_instruments i ON i.id=t.instrument_id JOIN market_prices p ON p.instrument_id=t.instrument_id
        WHERE t.user_id=? AND t.status='open' ORDER BY t.opened_at DESC LIMIT 100`).bind(user.id).all(),
      env.DB.prepare(`SELECT t.id,t.direction,t.quantity_micro AS quantityMicro,t.entry_price_micro AS entryPriceMicro,
        t.exit_price_micro AS exitPriceMicro,t.leverage,t.margin_cents AS marginCents,t.margin_asset_symbol AS marginAssetSymbol,
        t.liquidation_price_micro AS liquidationPriceMicro,t.pnl_cents AS pnlCents,t.status,t.opened_at AS openedAt,
        t.closed_at AS closedAt,i.symbol FROM paper_trades t JOIN market_instruments i ON i.id=t.instrument_id
        WHERE t.user_id=? AND t.status IN ('closed','liquidated') ORDER BY t.closed_at DESC LIMIT 50`).bind(user.id).all(),
      env.DB.prepare(`SELECT a.symbol,w.balance_minor AS balanceMinor FROM wallets w JOIN assets a ON a.id=w.asset_id
        WHERE w.user_id=? AND a.symbol IN ('SYP','USD')`).bind(user.id).all()
    ]);
    const pricedOpenTrades=(openTrades.results||[]).map(t=>({...t,currentPriceMicro:Number(marketQuote(t.midPriceMicro,t.direction==="long"?"bid":"ask"))}));
    return json({ok:true,market:market.results||[],cashCents:account?.cashCents??0,wallets:walletRows.results||[],
      positions:positions.results||[],orders:orders.results||[],limitOrders:limitOrders.results||[],openTrades:pricedOpenTrades,closedTrades:closedTrades.results||[]});
  }

  if (url.pathname === "/api/admin/market-bot" && request.method === "POST") {
    if(user.role!=="admin")return json({ok:false,error:"غير مصرح"},403);
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const id=String(body.instrumentId||""), enabled=body.enabled, volatility=Number(body.volatilityBps), drift=Number(body.driftBps||0);
    if(!id||id.length>80||typeof enabled!=="boolean"||!Number.isInteger(volatility)||volatility<1||volatility>2000||!Number.isInteger(drift)||drift< -500||drift>500)return json({ok:false,error:"إعدادات البوت غير صحيحة"},400);
    if(!enabled)return json({ok:false,error:"بوت السوق يعمل دائماً ولا يمكن إيقافه"},409);
    const instrument=await env.DB.prepare("SELECT id FROM market_instruments WHERE id=? AND is_active=1").bind(id).first();
    if(!instrument)return json({ok:false,error:"الأداة غير موجودة أو موقوفة"},404);
    await env.DB.prepare("INSERT INTO market_bots (instrument_id,enabled,volatility_bps,drift_bps,last_tick_at,updated_by,updated_at) VALUES (?,?,?,?,NULL,?,?) ON CONFLICT(instrument_id) DO UPDATE SET enabled=excluded.enabled,volatility_bps=excluded.volatility_bps,drift_bps=excluded.drift_bps,last_tick_at=NULL,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(id,enabled?1:0,volatility,drift,user.id,new Date().toISOString()).run();
    return json({ok:true,instrumentId:id,enabled,volatilityBps:volatility,driftBps:drift});
  }
  if (url.pathname === "/api/admin/market-instruments" && request.method === "GET") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    const rows=await env.DB.prepare(`SELECT i.id,i.symbol,i.name,i.is_active AS isActive,
      p.price_micro AS priceMicro,p.updated_at AS updatedAt,COALESCE(b.enabled,0) AS botEnabled,
      COALESCE(b.volatility_bps,80) AS volatilityBps,COALESCE(b.drift_bps,0) AS driftBps
      FROM market_instruments i LEFT JOIN market_prices p ON p.instrument_id=i.id
      LEFT JOIN market_bots b ON b.instrument_id=i.id ORDER BY i.symbol`).all();
    return json({ok:true,instruments:rows.results||[]});
  }

  if (url.pathname === "/api/admin/market-instrument-status" && request.method === "POST") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const instrumentId=String(body.instrumentId||"");
    const isActive=body.isActive;
    if(!instrumentId||instrumentId.length>80||typeof isActive!=="boolean")
      return json({ok:false,error:"بيانات الأداة غير صحيحة"},400);
    const result=await env.DB.prepare(`UPDATE market_instruments SET is_active=?
      WHERE id=? AND (?=1 OR NOT EXISTS(
        SELECT 1 FROM paper_positions p
        WHERE p.instrument_id=market_instruments.id AND p.quantity_micro>0
      ))`).bind(isActive?1:0,instrumentId,isActive?1:0).run();
    if(!result.meta?.changes){
      const instrument=await env.DB.prepare("SELECT id FROM market_instruments WHERE id=?").bind(instrumentId).first();
      if(!instrument)return json({ok:false,error:"الأداة غير موجودة"},404);
      if(!isActive)return json({ok:false,error:"لا يمكن إيقاف الأداة لأن هناك مستخدمين يملكون كميات مفتوحة منها؛ يجب إغلاق المراكز أولاً"},409);
      return json({ok:false,error:"تعذر تحديث حالة الأداة"},409);
    }
    return json({ok:true,instrumentId,isActive});
  }

  if (url.pathname === "/api/admin/market-instrument" && request.method === "POST") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const symbol=String(body.symbol||"").trim().toUpperCase();
    const name=String(body.name||"").trim();
    if (!/^[A-Z0-9._-]{2,20}$/.test(symbol)||name.length<2||name.length>60)
      return json({ok:false,error:"رمز السوق أو الاسم غير صحيح"},400);
    try {
      await env.DB.prepare("INSERT INTO market_instruments (id,symbol,name,quote_symbol) VALUES (?,?,?,'USD')")
        .bind(crypto.randomUUID(),symbol,name).run();
    } catch { return json({ok:false,error:"الرمز موجود مسبقاً أو تعذر إنشاء الأداة"},409); }
    return json({ok:true});
  }

  if (url.pathname === "/api/admin/market-price" && request.method === "POST") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const instrumentId=String(body.instrumentId||"");
    const price=Number(body.price);
    if (!instrumentId||instrumentId.length>80||!Number.isFinite(price)||price<=0||price>1000000000)
      return json({ok:false,error:"السعر غير صحيح"},400);
    const priceMicro=Math.round(price*1000000);
    if (!Number.isSafeInteger(priceMicro)||priceMicro<=0) return json({ok:false,error:"دقة السعر غير مقبولة"},400);
    const exists=await env.DB.prepare("SELECT id FROM market_instruments WHERE id=? AND is_active=1").bind(instrumentId).first();
    if(!exists)return json({ok:false,error:"الأداة غير موجودة"},404);
    await env.DB.prepare(`INSERT INTO market_prices (instrument_id,price_micro,updated_by,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET price_micro=excluded.price_micro,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(instrumentId,priceMicro,user.id,new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO market_price_history (id,instrument_id,price_micro,source,created_at) VALUES (?,?,?,'manual',?)").bind(crypto.randomUUID(),instrumentId,priceMicro,new Date().toISOString()).run();
    return json({ok:true,priceMicro});
  }


  if (url.pathname === "/api/paper/history" && request.method === "GET") {
    const rows=await env.DB.prepare(`SELECT l.id,l.order_id AS orderId,l.entry_type AS side,
      l.cash_delta_cents AS cashDeltaCents,l.quantity_delta_micro AS quantityDeltaMicro,
      l.price_micro AS priceMicro,l.created_at AS createdAt,i.symbol,i.name
      FROM paper_ledger l JOIN market_instruments i ON i.id=l.instrument_id
      WHERE l.user_id=? AND i.symbol='USD/SYP' ORDER BY l.created_at DESC LIMIT 100`).bind(user.id).all();
    return json({ok:true,entries:rows.results||[]});
  }


  if (url.pathname === "/api/paper/trade-open" && request.method === "POST") {
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const instrumentId=String(body.instrumentId||""),direction=String(body.direction||"");
    const marginAmount=Number(body.margin),leverage=Number(body.leverage);
    if(!instrumentId||instrumentId.length>80||!["long","short"].includes(direction)||!Number.isFinite(marginAmount)||marginAmount<=0||marginAmount>1000000000000||!Number.isInteger(leverage)||leverage<1||leverage>20)
      return json({ok:false,error:"أدخل مبلغ الهامش بشكل صحيح وحدد رافعة من 1x إلى 20x"},400);
    const hasValidPrecision=direction==="long"
      ? Number.isSafeInteger(marginAmount)
      : Math.abs(marginAmount*100-Math.round(marginAmount*100))<=1e-8;
    if(!hasValidPrecision)
      return json({ok:false,error:direction==="long"?"هامش الشراء بالليرة يجب أن يكون عدداً صحيحاً":"هامش البيع بالدولار يقبل منزلتين عشريتين كحد أقصى"},400);
    const instrument=await env.DB.prepare("SELECT i.id,p.price_micro AS priceMicro FROM market_instruments i JOIN market_prices p ON p.instrument_id=i.id WHERE i.id=? AND i.is_active=1 AND i.symbol='USD/SYP'").bind(instrumentId).first();
    if(!instrument)return json({ok:false,error:"السعر غير متاح حالياً"},409);
    const marginAssetSymbol=direction==="long"?"SYP":"USD";
    const marginMinor=BigInt(Math.round(marginAmount*(direction==="long"?1:100)));
    const entry=marketQuote(instrument.priceMicro,direction==="long"?"ask":"bid"),lev=BigInt(leverage);
    const quantityBig=direction==="long"
      ? (marginMinor*lev*1000000000000n+entry/2n)/entry
      : marginMinor*lev*10000n;
    if(marginMinor<=0n||marginMinor>9007199254740991n||quantityBig<=0n||quantityBig>9007199254740991n)
      return json({ok:false,error:"قيمة الهامش أو حجم الصفقة خارج النطاق"},400);
    const quantityMicro=Number(quantityBig),marginCents=Number(marginMinor);
    const liquidationPriceMicro=Number((direction==="long"?entry*BigInt(leverage-1)/BigInt(leverage):entry*BigInt(leverage+1)/BigInt(leverage))||1n);
    const now=new Date().toISOString(),tradeId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO assets(id,symbol,name,is_active) VALUES('syr-lira','SYP','ليرة',1),('usd-dollar','USD','دولار أمريكي',1)"),
      env.DB.prepare("INSERT OR IGNORE INTO wallets(id,user_id,asset_id,balance_minor) SELECT lower(hex(randomblob(16))),?,a.id,0 FROM assets a WHERE a.symbol IN ('SYP','USD') AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.user_id=? AND w.asset_id=a.id)").bind(user.id,user.id)
    ]);
    const wallet=await env.DB.prepare("SELECT w.id FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol=?").bind(user.id,marginAssetSymbol).first();
    if(!wallet)return json({ok:false,error:"محفظة العملة المطلوبة غير موجودة"},409);
    const results=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor-?,updated_at=? WHERE id=? AND balance_minor>=?").bind(marginCents,now,wallet.id,marginCents),
      env.DB.prepare("INSERT INTO paper_trades(id,user_id,instrument_id,direction,quantity_micro,entry_price_micro,leverage,margin_cents,margin_asset_symbol,liquidation_price_micro,status,opened_at) SELECT ?,?,?,?,?,?,?,?,?,?, 'open',? WHERE changes()=1").bind(tradeId,user.id,instrumentId,direction,quantityMicro,Number(entry),leverage,marginCents,marginAssetSymbol,liquidationPriceMicro,now),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'debit',?,?,?,? WHERE EXISTS(SELECT 1 FROM paper_trades WHERE id=?)").bind(crypto.randomUUID(),wallet.id,marginCents,"paper-trade:"+tradeId+":margin",user.id,"حجز هامش صفقة "+(direction==="long"?"شراء":"بيع")+" تجريبية",tradeId)
    ]);
    if(!results?.[1]?.meta?.changes)return json({ok:false,error:"رصيد "+(marginAssetSymbol==="SYP"?"الليرة":"الدولار")+" غير كافٍ للهامش"},409);
    return json({ok:true,tradeId,direction,marginAmount,quantity:Number(quantityMicro)/1000000,leverage,marginCents,marginAssetSymbol,entryPriceMicro:Number(entry),liquidationPriceMicro});
  }


  if (url.pathname === "/api/paper/limit-order" && request.method === "POST") {
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const instrumentId=String(body.instrumentId||""),direction=String(body.direction||"");
    const marginAmount=Number(body.margin),leverage=Number(body.leverage),limitPrice=Number(body.limitPrice);
    if(!instrumentId||instrumentId.length>80||!["long","short"].includes(direction)||!Number.isFinite(marginAmount)||marginAmount<=0||marginAmount>1000000000000||!Number.isInteger(leverage)||leverage<1||leverage>20||!Number.isFinite(limitPrice)||limitPrice<=0||limitPrice>1000000000000)
      return json({ok:false,error:"تحقق من مبلغ الهامش والرافعة والسعر المحدد"},400);
    const validPrecision=direction==="long"?Number.isSafeInteger(marginAmount):Math.abs(marginAmount*100-Math.round(marginAmount*100))<=1e-8;
    if(!validPrecision)return json({ok:false,error:direction==="long"?"هامش الشراء بالليرة يجب أن يكون عدداً صحيحاً":"هامش البيع بالدولار يقبل منزلتين عشريتين كحد أقصى"},400);
    const instrument=await env.DB.prepare("SELECT i.id FROM market_instruments i JOIN market_prices p ON p.instrument_id=i.id WHERE i.id=? AND i.is_active=1 AND i.symbol='USD/SYP'").bind(instrumentId).first();
    if(!instrument)return json({ok:false,error:"السعر غير متاح حالياً"},409);
    const limitPriceMicro=Math.round(limitPrice*1000000);
    if(!Number.isSafeInteger(limitPriceMicro)||limitPriceMicro<=0)return json({ok:false,error:"السعر المحدد خارج النطاق"},400);
    const marginAssetSymbol=direction==="long"?"SYP":"USD";
    const marginMinor=Math.round(marginAmount*(direction==="long"?1:100));
    if(!Number.isSafeInteger(marginMinor)||marginMinor<=0)return json({ok:false,error:"قيمة الهامش خارج النطاق"},400);
    const wallet=await env.DB.prepare("SELECT w.id FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol=?").bind(user.id,marginAssetSymbol).first();
    if(!wallet)return json({ok:false,error:"محفظة العملة المطلوبة غير موجودة"},409);
    const orderId=crypto.randomUUID(),now=new Date().toISOString();
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor-?,updated_at=? WHERE id=? AND balance_minor>=?").bind(marginMinor,now,wallet.id,marginMinor),
      env.DB.prepare("INSERT INTO paper_limit_orders(id,user_id,instrument_id,direction,margin_minor,margin_asset_symbol,leverage,limit_price_micro,status,created_at) SELECT ?,?,?,?,?,?,?,?,'pending',? WHERE changes()=1").bind(orderId,user.id,instrumentId,direction,marginMinor,marginAssetSymbol,leverage,limitPriceMicro,now),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'debit',?,?,?,? WHERE changes()=1").bind(crypto.randomUUID(),wallet.id,marginMinor,"paper-limit:"+orderId+":reserve",user.id,"حجز هامش أمر "+(direction==="long"?"شراء":"بيع")+" محدد")
    ]);
    if(!Number(result?.[1]?.meta?.changes||0))return json({ok:false,error:"رصيد "+(marginAssetSymbol==="SYP"?"الليرة":"الدولار")+" غير كافٍ للهامش"},409);
    await processPendingLimitOrders(env.DB);
    const saved=await env.DB.prepare("SELECT status,trade_id AS tradeId FROM paper_limit_orders WHERE id=? AND user_id=?").bind(orderId,user.id).first();
    return json({ok:true,orderId,status:saved?.status||"pending",tradeId:saved?.tradeId||null,limitPriceMicro,marginMinor,marginAssetSymbol});
  }

  if (url.pathname === "/api/paper/limit-order-cancel" && request.method === "POST") {
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const orderId=String(body.orderId||"");
    if(!orderId||orderId.length>80)return json({ok:false,error:"رقم الأمر غير صحيح"},400);
    const order=await env.DB.prepare("SELECT margin_minor AS marginMinor,margin_asset_symbol AS marginAssetSymbol FROM paper_limit_orders WHERE id=? AND user_id=? AND status='pending'").bind(orderId,user.id).first();
    if(!order)return json({ok:false,error:"الأمر لم يعد معلّقاً أو غير موجود"},409);
    const wallet=await env.DB.prepare("SELECT w.id FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol=?").bind(user.id,order.marginAssetSymbol).first();
    if(!wallet)return json({ok:false,error:"محفظة الأمر غير موجودة"},409);
    const now=new Date().toISOString(),amount=Number(order.marginMinor);
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE paper_limit_orders SET status='cancelled',cancelled_at=? WHERE id=? AND user_id=? AND status='pending' AND EXISTS(SELECT 1 FROM wallets WHERE id=? AND balance_minor<=9007199254740991-?)").bind(now,orderId,user.id,wallet.id,amount),
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor+?,updated_at=? WHERE id=? AND changes()=1").bind(amount,now,wallet.id,amount),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'credit',?,?,?,? WHERE changes()=1").bind(crypto.randomUUID(),wallet.id,amount,"paper-limit:"+orderId+":refund",user.id,"إعادة هامش أمر معلّق ملغى",orderId)
    ]);
    if(!Number(result?.[0]?.meta?.changes||0))return json({ok:false,error:"تم تنفيذ الأمر أو إلغاؤه مسبقاً"},409);
    if(!Number(result?.[1]?.meta?.changes||0))return json({ok:false,error:"تعذر إعادة الهامش تلقائياً؛ يرجى مراجعة المدير"},500);
    return json({ok:true,orderId,refundedMinor:amount,marginAssetSymbol:order.marginAssetSymbol});
  }

  if (url.pathname === "/api/paper/trade-close" && request.method === "POST") {
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const tradeId=String(body.tradeId||"");
    if(!tradeId||tradeId.length>80)return json({ok:false,error:"رقم الصفقة غير صحيح"},400);
    const trade=await env.DB.prepare("SELECT id,instrument_id,direction,quantity_micro AS quantityMicro,entry_price_micro AS entryPriceMicro,margin_cents AS marginCents,margin_asset_symbol AS marginAssetSymbol FROM paper_trades WHERE id=? AND user_id=? AND status='open'").bind(tradeId,user.id).first();
    if(!trade)return json({ok:false,error:"الصفقة مغلقة أو تمت تصفيتها أو غير موجودة"},404);
    const price=await env.DB.prepare("SELECT price_micro AS priceMicro FROM market_prices WHERE instrument_id=?").bind(trade.instrument_id).first();
    if(!price)return json({ok:false,error:"السعر الحالي غير متاح"},409);
    const exitPrice=marketQuote(price.priceMicro,trade.direction==="long"?"bid":"ask");
    const delta=exitPrice-BigInt(trade.entryPriceMicro);
    const rawPnl=trade.direction==="long"?delta*BigInt(trade.quantityMicro)/1000000000000n:BigInt(trade.quantityMicro)*(-delta)*100n/(BigInt(trade.entryPriceMicro)*1000000n);
    const margin=BigInt(trade.marginCents),pnl=rawPnl < -margin ? -margin : rawPnl;
    const safePnl=pnl>9007199254740991n-margin?9007199254740991n-margin:pnl;
    const pnlCents=Number(safePnl),releaseCents=Number(margin+safePnl),now=new Date().toISOString();
    const wallet=await env.DB.prepare("SELECT w.id FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol=?").bind(user.id,trade.marginAssetSymbol).first();
    if(!wallet)return json({ok:false,error:"محفظة الصفقة غير موجودة"},409);
    const results=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor+?,updated_at=? WHERE id=? AND balance_minor<=9007199254740991-? AND EXISTS(SELECT 1 FROM paper_trades WHERE id=? AND user_id=? AND status='open')").bind(releaseCents,now,wallet.id,releaseCents,tradeId,user.id),
      env.DB.prepare("UPDATE paper_trades SET status='closed',closed_at=?,exit_price_micro=?,pnl_cents=? WHERE id=? AND user_id=? AND status='open' AND changes()=1").bind(now,Number(exitPrice),pnlCents,tradeId,user.id),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'credit',?,?,?,? WHERE changes()=1 AND ?>0").bind(crypto.randomUUID(),wallet.id,releaseCents,"paper-trade:"+tradeId+":settlement",user.id,"تسوية صفقة مغلقة",releaseCents)
    ]);
    if(!results?.[1]?.meta?.changes)return json({ok:false,error:"تعذر إغلاق الصفقة؛ حدّث الصفحة وحاول مجدداً"},409);
    return json({ok:true,tradeId,pnlCents,releaseCents,marginAssetSymbol:trade.marginAssetSymbol,exitPriceMicro:Number(exitPrice)});
  }

  if (url.pathname === "/api/paper/order" && request.method === "POST") {
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const instrumentId=String(body.instrumentId||"");
    const side=String(body.side||"");
    const quantity=Number(body.quantity);
    if(!instrumentId||instrumentId.length>80||!["buy","sell"].includes(side)||
      !Number.isFinite(quantity)||quantity<=0||quantity>1000000)
      return json({ok:false,error:"تحقق من الأداة والاتجاه والكمية"},400);
    const quantityMicro=Math.round(quantity*1000000);
    if(!Number.isSafeInteger(quantityMicro)||quantityMicro<=0)
      return json({ok:false,error:"الكمية بدقة غير مقبولة"},400);
    const instrument=await env.DB.prepare(`SELECT i.id,i.symbol,p.price_micro AS priceMicro
      FROM market_instruments i JOIN market_prices p ON p.instrument_id=i.id
      WHERE i.id=? AND i.is_active=1 AND i.symbol='USD/SYP'`).bind(instrumentId).first();
    if(!instrument)return json({ok:false,error:"لا يوجد سعر معتمد لهذه الأداة حالياً"},409);
    const notional=BigInt(instrument.priceMicro)*BigInt(quantityMicro);
    const totalBig=side==="buy"?(notional+9999999999n)/10000000000n:notional/10000000000n;
    if(totalBig<=0n||totalBig>9007199254740991n)return json({ok:false,error:"قيمة الصفقة أقل من سنت أو خارج النطاق"},400);
    const totalCents=Number(totalBig);
    const account=await env.DB.prepare("SELECT cash_cents AS cashCents FROM paper_accounts WHERE user_id=?").bind(user.id).first();
    const position=await env.DB.prepare("SELECT quantity_micro AS quantityMicro FROM paper_positions WHERE user_id=? AND instrument_id=?")
      .bind(user.id,instrumentId).first();
    if(side==="buy"&&Number(account?.cashCents||0)<totalCents)
      return json({ok:false,error:"رصيد التداول التجريبي غير كافٍ"},409);
    if(side==="sell"&&Number(position?.quantityMicro||0)<quantityMicro)
      return json({ok:false,error:"الكمية المملوكة تجريبياً غير كافية للبيع"},409);
    const now=new Date().toISOString(),orderId=crypto.randomUUID();
    const orderInsert=env.DB.prepare(`INSERT INTO paper_orders (id,user_id,instrument_id,side,quantity_micro,price_micro,total_cents)
      SELECT ?,?,?,?,?,?,? WHERE changes()=1`).bind(orderId,user.id,instrumentId,side,quantityMicro,instrument.priceMicro,totalCents);
    const ledgerInsert=env.DB.prepare(`INSERT INTO paper_ledger
      (id,user_id,order_id,entry_type,cash_delta_cents,quantity_delta_micro,instrument_id,price_micro,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),user.id,orderId,side,
        side==="buy"?-totalCents:totalCents,side==="buy"?quantityMicro:-quantityMicro,
        instrumentId,instrument.priceMicro,now);
    const statements=side==="buy"?[
      env.DB.prepare(`UPDATE paper_accounts SET cash_cents=cash_cents-?,updated_at=?
        WHERE user_id=? AND cash_cents>=?
          AND EXISTS(SELECT 1 FROM market_instruments WHERE id=? AND is_active=1)
          AND NOT EXISTS(SELECT 1 FROM paper_positions
            WHERE user_id=? AND instrument_id=? AND quantity_micro>9007199254740991-?)`)
        .bind(totalCents,now,user.id,totalCents,instrumentId,user.id,instrumentId,quantityMicro),
      env.DB.prepare(`INSERT INTO paper_positions (user_id,instrument_id,quantity_micro)
        SELECT ?,?,? WHERE changes()=1
        ON CONFLICT(user_id,instrument_id) DO UPDATE SET quantity_micro=quantity_micro+excluded.quantity_micro
        WHERE quantity_micro<=9007199254740991-excluded.quantity_micro`)
        .bind(user.id,instrumentId,quantityMicro),
      orderInsert,
      ledgerInsert
    ]:[
      env.DB.prepare(`UPDATE paper_positions SET quantity_micro=quantity_micro-?
        WHERE user_id=? AND instrument_id=? AND quantity_micro>=?
          AND EXISTS(SELECT 1 FROM paper_accounts WHERE user_id=? AND cash_cents<=9007199254740991-?)
          AND EXISTS(SELECT 1 FROM market_instruments WHERE id=? AND is_active=1)`)
        .bind(quantityMicro,user.id,instrumentId,quantityMicro,user.id,totalCents,instrumentId),
      env.DB.prepare("UPDATE paper_accounts SET cash_cents=cash_cents+?,updated_at=? WHERE user_id=? AND cash_cents<=9007199254740991-? AND changes()=1")
        .bind(totalCents,now,user.id,totalCents),
      orderInsert,
      ledgerInsert
    ];
    let results;
    try { results=await env.DB.batch(statements); }
    catch { return json({ok:false,error:"تعذر تنفيذ الأمر التجريبي؛ لم يتم اعتماد العملية"},409); }
    if(!results?.[results.length-1]?.meta?.changes)
      return json({ok:false,error:side==="buy"?"رصيد التداول التجريبي غير كافٍ":"الكمية المملوكة تجريبياً غير كافية"},409);
    return json({ok:true,orderId,side,symbol:instrument.symbol,quantity,price:Number(instrument.priceMicro)/1000000,totalCents});
  }

  if (url.pathname === "/api/market/rate" && request.method === "GET") {
    const rate = await env.DB.prepare(
      "SELECT base_symbol AS baseSymbol, quote_symbol AS quoteSymbol, rate, updated_at AS updatedAt FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1"
    ).first();
    return json({ ok: true, rate: rate || null });
  }

  if (url.pathname === "/api/admin/exchange-rate" && request.method === "POST") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000000) {
      return json({ ok: false, error: "سعر الصرف غير صحيح" }, 400);
    }
    const now=new Date().toISOString(),priceMicro=Math.round(rate*1000000);
    const transitionMinutes=Number(body.transitionMinutes??15);
    if(!Number.isSafeInteger(priceMicro)||priceMicro<=0)return json({ok:false,error:"سعر الصرف خارج النطاق المقبول"},400);
    if(!Number.isInteger(transitionMinutes)||transitionMinutes<1||transitionMinutes>1440)
      return json({ok:false,error:"مدة الوصول يجب أن تكون بين دقيقة و24 ساعة"},400);
    await ensureSypMarket(env.DB);
    const current=await env.DB.prepare("SELECT price_micro AS priceMicro FROM market_prices WHERE instrument_id='syr-usd-syp'").first();
    const fromPriceMicro=Number(current?.priceMicro||priceMicro);
    if(!Number.isSafeInteger(fromPriceMicro)||fromPriceMicro<=0)return json({ok:false,error:"تعذر قراءة السعر الحالي"},409);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO market_prices(instrument_id,price_micro,updated_by,updated_at) VALUES('syr-usd-syp',?,?,?)").bind(fromPriceMicro,user.id,now),
      env.DB.prepare("INSERT OR IGNORE INTO exchange_rates(id,base_symbol,quote_symbol,rate,updated_by,updated_at) VALUES('usd-syp','USD','SYP',?,?,?)").bind(fromPriceMicro/1000000,user.id,now),
      env.DB.prepare("INSERT INTO market_price_targets(instrument_id,target_price_micro,from_price_micro,transition_started_at,transition_seconds,updated_by,updated_at) VALUES('syr-usd-syp',?,?,?,?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET target_price_micro=excluded.target_price_micro,from_price_micro=excluded.from_price_micro,transition_started_at=excluded.transition_started_at,transition_seconds=excluded.transition_seconds,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(priceMicro,fromPriceMicro,now,transitionMinutes*60,user.id,now),
      env.DB.prepare("INSERT INTO market_bots(instrument_id,enabled,volatility_bps,drift_bps,updated_by,updated_at) VALUES('syr-usd-syp',1,80,0,?,?) ON CONFLICT(instrument_id) DO UPDATE SET enabled=1,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(user.id,now)
    ]);
    const bot=await env.DB.prepare("SELECT enabled FROM market_bots WHERE instrument_id='syr-usd-syp'").first();
    return json({ok:true,targetRate:rate,fromPrice:Number(fromPriceMicro)/1000000,transitionMinutes,botEnabled:true});
  }

  if (url.pathname === "/api/wallet/member-code" && request.method === "GET") {
    const row=await env.DB.prepare("SELECT code FROM member_codes WHERE user_id=?").bind(user.id).first();
    return json({ok:true,memberCode:row?.code||null});
  }
  if (url.pathname === "/api/wallet/deposit" && request.method === "POST") {
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    if(Number(request.headers.get("content-length")||0)>1200000)return json({ok:false,error:"حجم الطلب أكبر من المسموح"},413);
    let form;try{form=await request.formData();}catch{return json({ok:false,error:"تعذر قراءة بيانات الإيداع"},400);}
    const amountText=String(form.get("amount")||"");
    const amount=Number(amountText),file=form.get("proof");
    const amountMinor=Math.round(amount*100);
    if(!/^\d+(\.\d{1,2})?$/.test(amountText)||!Number.isFinite(amount)||amount<=0||amount>10000000||!Number.isSafeInteger(amountMinor)||amountMinor<=0)return json({ok:false,error:"أدخل مبلغاً صحيحاً بالدولار حتى منزلتين عشريتين"},400);
    if(!file||typeof file.arrayBuffer!=="function"||file.size<1||file.size>850000)return json({ok:false,error:"أرفق صورة بحجم لا يتجاوز 850 كيلوبايت"},400);
    const mime=String(file.type||"").toLowerCase();
    if(!["image/jpeg","image/png","image/webp"].includes(mime))return json({ok:false,error:"الصورة يجب أن تكون JPG أو PNG أو WEBP"},400);
    const bytes=new Uint8Array(await file.arrayBuffer());
    const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71,webp=String.fromCharCode(...bytes.subarray(0,4))==="RIFF"&&String.fromCharCode(...bytes.subarray(8,12))==="WEBP";
    if(!(mime==="image/jpeg"&&jpeg)&&!(mime==="image/png"&&png)&&!(mime==="image/webp"&&webp))return json({ok:false,error:"محتوى الصورة لا يطابق نوع الملف"},400);
    const wallet=await env.DB.prepare("SELECT w.id FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol='USD'").bind(user.id).first();
    if(!wallet)return json({ok:false,error:"محفظة الدولار غير موجودة"},409);
    const id=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO deposit_requests(id,user_id,amount_minor,asset_symbol,proof_base64,proof_mime,proof_name) VALUES(?,?,?,'USD',?,?,?)").bind(id,user.id,amountMinor,bytesToBase64(bytes),mime,String(file.name||"proof").slice(0,120)).run();
    return json({ok:true,requestId:id,status:"pending"});
  }
  if (url.pathname === "/api/wallet/withdrawal" && request.method === "POST") {
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const amount=Number(body.amount),details=String(body.payoutDetails||"").trim();
    if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000||details.length<5||details.length>300)return json({ok:false,error:"تحقق من مبلغ السحب وبيانات الاستلام"},400);
    const wallet=await env.DB.prepare("SELECT w.id FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol='SYP'").bind(user.id).first();
    if(!wallet)return json({ok:false,error:"محفظة الليرة غير موجودة"},409);
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor-?,updated_at=? WHERE id=? AND balance_minor>=?").bind(amount,now,wallet.id,amount),
      env.DB.prepare("INSERT INTO withdrawal_requests(id,user_id,amount_minor,payout_details) SELECT ?,?,?,? WHERE changes()=1").bind(id,user.id,amount,details),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'debit',?,?,?,'حجز مبلغ طلب سحب بانتظار مراجعة المدير' WHERE EXISTS(SELECT 1 FROM withdrawal_requests WHERE id=?)").bind(crypto.randomUUID(),wallet.id,amount,"withdrawal:"+id,user.id,id)
    ]);
    if(!result?.[0]?.meta?.changes)return json({ok:false,error:"رصيد الليرة غير كافٍ"},409);
    return json({ok:true,requestId:id,status:"pending"});
  }
  if (url.pathname === "/api/wallet/exchange" && request.method === "POST") {
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const direction=String(body.direction||"");
    const amount=Number(body.amount);
    if(!["USD_TO_SYP","SYP_TO_USD"].includes(direction)||!Number.isFinite(amount)||amount<=0||amount>10000000000){
      return json({ok:false,error:"تحقق من اتجاه التحويل والمبلغ"},400);
    }
    const sourceSymbol=direction==="USD_TO_SYP"?"USD":"SYP";
    const targetSymbol=direction==="USD_TO_SYP"?"SYP":"USD";
    if((sourceSymbol==="SYP"&&!Number.isSafeInteger(amount))||(sourceSymbol==="USD"&&Math.abs(amount*100-Math.round(amount*100))>1e-8)){
      return json({ok:false,error:"مبلغ الدولار يجب أن يحتوي منزلتين عشريتين كحد أقصى، والليرة أعداد صحيحة"},400);
    }
    const sourceMinor=sourceSymbol==="USD"?Math.round(amount*100):amount;
    if(!Number.isSafeInteger(sourceMinor)||sourceMinor<=0)return json({ok:false,error:"المبلغ خارج النطاق المقبول"},400);
    const rateRow=await env.DB.prepare("SELECT rate FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1").first();
    const rate=Number(rateRow?.rate||0);
    if(!Number.isFinite(rate)||rate<=0)return json({ok:false,error:"سعر الصرف غير محدد من الإدارة بعد"},409);
    const targetMinor=direction==="USD_TO_SYP"?Math.round(sourceMinor*rate/100):Math.round(sourceMinor/rate*100);
    if(!Number.isSafeInteger(targetMinor)||targetMinor<=0||targetMinor>9007199254740991)return json({ok:false,error:"الناتج خارج النطاق المقبول"},400);
    const [source,target]=await Promise.all([
      env.DB.prepare("SELECT w.id AS id,w.balance_minor AS balanceMinor FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol=?").bind(user.id,sourceSymbol).first(),
      env.DB.prepare("SELECT w.id AS id,w.balance_minor AS balanceMinor FROM wallets w JOIN assets a ON a.id=w.asset_id WHERE w.user_id=? AND a.symbol=?").bind(user.id,targetSymbol).first()
    ]);
    if(!source||!target)return json({ok:false,error:"إحدى المحافظ غير موجودة"},409);
    if(Number(target.balanceMinor)>9007199254740991-targetMinor)return json({ok:false,error:"رصيد المحفظة المستقبلة تجاوز الحد المسموح"},409);
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const sourceLabel=sourceSymbol==="USD"?"دولار":"ليرة",targetLabel=targetSymbol==="USD"?"دولار":"ليرة";
    const rateNote="تحويل عملة بسعر 1 دولار = "+rate+" ليرة";
    const batch=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor-?,updated_at=? WHERE id=? AND balance_minor>=? AND EXISTS(SELECT 1 FROM wallets WHERE id=? AND balance_minor<=9007199254740991-?)").bind(sourceMinor,now,source.id,sourceMinor,target.id,targetMinor),
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor+?,updated_at=? WHERE id=? AND changes()=1 AND balance_minor<=9007199254740991-?").bind(targetMinor,now,target.id,targetMinor),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'debit',?,?,?,? WHERE changes()=1").bind(crypto.randomUUID(),source.id,sourceMinor,"exchange:"+id+":out",user.id,rateNote),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'credit',?,?,?,? WHERE changes()=1").bind(crypto.randomUUID(),target.id,targetMinor,"exchange:"+id+":in",user.id,rateNote)
    ]);
    if(!batch?.[0]?.meta?.changes)return json({ok:false,error:"رصيد "+sourceLabel+" غير كافٍ"},409);
    if(!batch?.[1]?.meta?.changes)return json({ok:false,error:"تعذر إضافة المبلغ إلى محفظة "+targetLabel},409);
    return json({ok:true,sourceSymbol,targetSymbol,sourceMinor,targetMinor,rate});
  }
  if (url.pathname === "/api/wallet/transfer" && request.method === "POST") {
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const code=String(body.memberCode||"").trim(),amount=Number(body.amount);
    if(!/^[0-9]{10}$/.test(code)||!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)return json({ok:false,error:"أدخل رقم العضو والمبلغ بشكل صحيح"},400);
    const recipient=await env.DB.prepare("SELECT u.id,u.display_name AS displayName FROM member_codes m JOIN users u ON u.id=m.user_id WHERE m.code=? AND u.status='active'").bind(code).first();
    if(!recipient)return json({ok:false,error:"رقم العضو غير موجود أو حسابه غير نشط"},404);
    if(recipient.id===user.id)return json({ok:false,error:"لا يمكنك التحويل إلى حسابك نفسه"},400);
    const [sw,rw]=await Promise.all([
      env.DB.prepare("SELECT id FROM wallets WHERE user_id=? AND asset_id='syr-lira'").bind(user.id).first(),
      env.DB.prepare("SELECT id FROM wallets WHERE user_id=? AND asset_id='syr-lira'").bind(recipient.id).first()
    ]);
    if(!sw||!rw)return json({ok:false,error:"محفظة أحد الطرفين غير موجودة"},409);
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor-?,updated_at=? WHERE id=? AND balance_minor>=? AND EXISTS(SELECT 1 FROM wallets WHERE id=? AND balance_minor<=9007199254740991-?)").bind(amount,now,sw.id,amount,rw.id,amount),
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor+?,updated_at=? WHERE id=? AND changes()=1 AND balance_minor<=9007199254740991-?").bind(amount,now,rw.id,amount),
      env.DB.prepare("INSERT INTO internal_transfers(id,sender_id,recipient_id,amount_minor) SELECT ?,?,?,? WHERE changes()=1").bind(id,user.id,recipient.id,amount),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'debit',?,?,?,'تحويل إلى عضو داخل المنصة' WHERE EXISTS(SELECT 1 FROM internal_transfers WHERE id=?)").bind(crypto.randomUUID(),sw.id,amount,"transfer:"+id+":out",user.id,id),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'credit',?,?,?,'تحويل مستلم من عضو داخل المنصة' WHERE EXISTS(SELECT 1 FROM internal_transfers WHERE id=?)").bind(crypto.randomUUID(),rw.id,amount,"transfer:"+id+":in",user.id,id)
    ]);
    if(!result?.[0]?.meta?.changes||!result?.[1]?.meta?.changes)return json({ok:false,error:"تعذر التحويل؛ تحقق من الرصيد"},409);
    return json({ok:true,transferId:id,recipientName:recipient.displayName,amount});
  }
  if (url.pathname === "/api/wallet/finance-requests" && request.method === "GET") {
    const [deposits,withdrawals,transfers]=await Promise.all([
      env.DB.prepare("SELECT id,amount_minor AS amount,asset_symbol AS assetSymbol,status,created_at AS createdAt FROM deposit_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 30").bind(user.id).all(),
      env.DB.prepare("SELECT id,amount_minor AS amount,status,payout_details AS payoutDetails,created_at AS createdAt FROM withdrawal_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 30").bind(user.id).all(),
      env.DB.prepare("SELECT t.id,t.amount_minor AS amount,t.created_at AS createdAt,CASE WHEN t.sender_id=? THEN 'out' ELSE 'in' END AS direction,CASE WHEN t.sender_id=? THEN ur.display_name ELSE us.display_name END AS otherName,CASE WHEN t.sender_id=? THEN mr.code ELSE ms.code END AS otherCode FROM internal_transfers t JOIN users us ON us.id=t.sender_id JOIN users ur ON ur.id=t.recipient_id JOIN member_codes ms ON ms.user_id=us.id JOIN member_codes mr ON mr.user_id=ur.id WHERE t.sender_id=? OR t.recipient_id=? ORDER BY t.created_at DESC LIMIT 30").bind(user.id,user.id,user.id,user.id,user.id).all()
    ]);
    return json({ok:true,deposits:deposits.results||[],withdrawals:withdrawals.results||[],transfers:transfers.results||[]});
  }
  if (url.pathname === "/api/admin/finance-requests" && request.method === "GET") {
    if(user.role!=="admin")return json({ok:false,error:"غير مصرح"},403);
    const [deposits,withdrawals]=await Promise.all([
      env.DB.prepare("SELECT d.id,d.amount_minor AS amount,d.asset_symbol AS assetSymbol,d.status,d.created_at AS createdAt,u.display_name AS displayName,u.email,m.code AS memberCode,d.proof_mime AS proofMime FROM deposit_requests d JOIN users u ON u.id=d.user_id JOIN member_codes m ON m.user_id=u.id ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END,d.created_at DESC LIMIT 100").all(),
      env.DB.prepare("SELECT w.id,w.amount_minor AS amount,w.status,w.payout_details AS payoutDetails,w.created_at AS createdAt,u.display_name AS displayName,u.email,m.code AS memberCode FROM withdrawal_requests w JOIN users u ON u.id=w.user_id JOIN member_codes m ON m.user_id=u.id ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END,w.created_at DESC LIMIT 100").all()
    ]);
    return json({ok:true,deposits:deposits.results||[],withdrawals:withdrawals.results||[]});
  }
  if (url.pathname === "/api/admin/deposit-proof" && request.method === "GET") {
    if(user.role!=="admin")return json({ok:false,error:"غير مصرح"},403);
    const proof=await env.DB.prepare("SELECT proof_base64 AS data,proof_mime AS mime FROM deposit_requests WHERE id=?").bind(String(url.searchParams.get("id")||"")).first();
    if(!proof)return json({ok:false,error:"إثبات الإيداع غير موجود"},404);
    const binary=atob(proof.data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return new Response(bytes,{headers:{"content-type":proof.mime,"cache-control":"private, no-store","x-content-type-options":"nosniff","content-disposition":"inline"}});
  }
  if (url.pathname === "/api/admin/deposit-review" && request.method === "POST") {
    if(user.role!=="admin")return json({ok:false,error:"غير مصرح"},403);
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const id=String(body.requestId||""),decision=String(body.decision||"");
    if(!id||!["approve","reject"].includes(decision))return json({ok:false,error:"بيانات المراجعة غير صحيحة"},400);
    const row=await env.DB.prepare("SELECT user_id AS userId,amount_minor AS amount,asset_symbol AS assetSymbol FROM deposit_requests WHERE id=? AND status='pending'").bind(id).first();
    if(!row)return json({ok:false,error:"طلب الإيداع غير موجود أو تمت مراجعته"},409);
    if(decision==="reject"){
      const r=await env.DB.prepare("UPDATE deposit_requests SET status='rejected',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'").bind(user.id,new Date().toISOString(),id).run();
      if(!r.meta?.changes)return json({ok:false,error:"تمت مراجعة الطلب مسبقاً"},409);
      return json({ok:true,status:"rejected"});
    }
    const assetId=row.assetSymbol==="USD"?"usd-dollar":"syr-lira";
    const wallet=await env.DB.prepare("SELECT id FROM wallets WHERE user_id=? AND asset_id=?").bind(row.userId,assetId).first();
    if(!wallet)return json({ok:false,error:"محفظة العضو غير موجودة"},409);
    const now=new Date().toISOString();
    const r=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor+?,updated_at=? WHERE id=? AND balance_minor<=9007199254740991-? AND EXISTS(SELECT 1 FROM deposit_requests WHERE id=? AND status='pending')").bind(row.amount,now,wallet.id,row.amount,id),
      env.DB.prepare("UPDATE deposit_requests SET status='approved',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending' AND changes()=1").bind(user.id,now,id),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'credit',?,?,?,'إيداع معتمد من المدير' WHERE changes()=1").bind(crypto.randomUUID(),wallet.id,row.amount,"deposit:"+id,user.id)
    ]);
    if(!r?.[0]?.meta?.changes||!r?.[1]?.meta?.changes)return json({ok:false,error:"تعذر اعتماد الإيداع؛ لم يتغير الرصيد"},409);
    return json({ok:true,status:"approved"});
  }
  if (url.pathname === "/api/admin/withdrawal-review" && request.method === "POST") {
    if(user.role!=="admin")return json({ok:false,error:"غير مصرح"},403);
    if(!requireSameOrigin(request,url))return json({ok:false,error:"طلب غير موثوق"},403);
    let body;try{body=await readJson(request);}catch{return json({ok:false,error:"بيانات الطلب غير صحيحة"},400);}
    const id=String(body.requestId||""),decision=String(body.decision||"");
    if(!id||!["approve","reject"].includes(decision))return json({ok:false,error:"بيانات المراجعة غير صحيحة"},400);
    const row=await env.DB.prepare("SELECT user_id AS userId,amount_minor AS amount FROM withdrawal_requests WHERE id=? AND status='pending'").bind(id).first();
    if(!row)return json({ok:false,error:"طلب السحب غير موجود أو تمت مراجعته"},409);
    if(decision==="approve"){
      const r=await env.DB.prepare("UPDATE withdrawal_requests SET status='approved',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'").bind(user.id,new Date().toISOString(),id).run();
      if(!r.meta?.changes)return json({ok:false,error:"تمت مراجعة الطلب مسبقاً"},409);
      return json({ok:true,status:"approved"});
    }
    const wallet=await env.DB.prepare("SELECT id FROM wallets WHERE user_id=? AND asset_id='syr-lira'").bind(row.userId).first();
    if(!wallet)return json({ok:false,error:"محفظة العضو غير موجودة"},409);
    const now=new Date().toISOString();
    const r=await env.DB.batch([
      env.DB.prepare("UPDATE wallets SET balance_minor=balance_minor+?,updated_at=? WHERE id=? AND balance_minor<=9007199254740991-? AND EXISTS(SELECT 1 FROM withdrawal_requests WHERE id=? AND status='pending')").bind(row.amount,now,wallet.id,row.amount,id),
      env.DB.prepare("UPDATE withdrawal_requests SET status='rejected',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending' AND changes()=1").bind(user.id,now,id),
      env.DB.prepare("INSERT INTO ledger_entries(id,wallet_id,entry_type,amount_minor,idempotency_key,created_by,note) SELECT ?,?,'credit',?,?,?,'إعادة مبلغ طلب السحب المرفوض' WHERE changes()=1").bind(crypto.randomUUID(),wallet.id,row.amount,"withdrawal-refund:"+id,user.id)
    ]);
    if(!r?.[0]?.meta?.changes||!r?.[1]?.meta?.changes)return json({ok:false,error:"تعذر رفض السحب وإعادة الرصيد"},409);
    return json({ok:true,status:"rejected"});
  }

  if (url.pathname === "/api/admin/wallets" && request.method === "GET") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('syr-lira','SYP','ليرة',1)"),
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('usd-dollar','USD','دولار أمريكي',1)"),
      env.DB.prepare("INSERT OR IGNORE INTO wallets (id,user_id,asset_id,balance_minor) SELECT lower(hex(randomblob(16))),u.id,a.id,0 FROM users u CROSS JOIN assets a WHERE a.symbol IN ('SYP','USD') AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id=u.id AND w.asset_id=a.id)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS exchange_rates (
        id TEXT PRIMARY KEY, base_symbol TEXT NOT NULL, quote_symbol TEXT NOT NULL,
        rate REAL NOT NULL CHECK(rate > 0), updated_by TEXT REFERENCES users(id),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(base_symbol, quote_symbol)
      )`),
    ]);
    const rows = await env.DB.prepare(
      `SELECT w.id AS walletId, u.email, u.display_name AS displayName,
              a.name AS assetName, a.symbol, w.balance_minor AS balanceMinor
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       JOIN assets a ON a.id = w.asset_id
       ORDER BY u.created_at DESC LIMIT 500`
    ).all();
    return json({ ok: true, wallets: rows.results || [] });
  }

  if (url.pathname === "/api/wallet/ledger" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT le.id, le.entry_type AS type, le.amount_minor AS amountMinor,
              le.reference, le.note, le.created_at AS createdAt, a.symbol
       FROM ledger_entries le
       JOIN wallets w ON w.id = le.wallet_id
       JOIN assets a ON a.id = w.asset_id
       WHERE w.user_id = ?
       ORDER BY le.created_at DESC, le.id DESC LIMIT 100`
    ).bind(user.id).all();
    return json({ ok: true, entries: rows.results || [] });
  }

  if (url.pathname === "/api/admin/wallet-adjust" && request.method === "POST") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const walletId = String(body.walletId || "");
    const type = String(body.type || "");
    const amountMinor = Number(body.amountMinor);
    const note = String(body.note || "").trim();
    const idempotencyKey = String(body.idempotencyKey || "");
    if (!walletId || walletId.length > 80 ||
        !["credit", "debit"].includes(type) ||
        !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
        amountMinor > 1000000000000 ||
        !/^[0-9a-f-]{36}$/i.test(idempotencyKey) ||
        note.length > 240) {
      return json({ ok: false, error: "تحقق من نوع الحركة والمبلغ والبيانات" }, 400);
    }

    const existing = await env.DB.prepare(
      "SELECT id FROM ledger_entries WHERE idempotency_key = ? LIMIT 1"
    ).bind(idempotencyKey).first();
    if (existing) return json({ ok: false, error: "هذه الحركة مسجلة مسبقاً" }, 409);

    const entryId = crypto.randomUUID();
    const updateSql = type === "credit"
      ? "UPDATE wallets SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ? AND balance_minor <= 9007199254740991 - ?"
      : "UPDATE wallets SET balance_minor = balance_minor - ?, updated_at = ? WHERE id = ? AND balance_minor >= ?";
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare(updateSql).bind(amountMinor, new Date().toISOString(), walletId, amountMinor),
        env.DB.prepare(
          `INSERT INTO ledger_entries
            (id, wallet_id, entry_type, amount_minor, idempotency_key, created_by, note)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1`
        ).bind(entryId, walletId, type, amountMinor, idempotencyKey, user.id, note || null)
      ]);
    } catch (error) {
      const duplicate = await env.DB.prepare(
        "SELECT id FROM ledger_entries WHERE idempotency_key = ? LIMIT 1"
      ).bind(idempotencyKey).first();
      if (duplicate) return json({ ok: false, error: "هذه الحركة مسجلة مسبقاً" }, 409);
      throw error;
    }
    if (!results?.[0]?.meta?.changes) {
      return json({ ok: false, error: "المحفظة غير موجودة أو الرصيد غير كافٍ" }, 409);
    }
    if (!results?.[1]?.meta?.changes) {
      return json({ ok: false, error: "تعذر تسجيل الحركة" }, 409);
    }
    const wallet = await env.DB.prepare(
      "SELECT balance_minor AS balanceMinor FROM wallets WHERE id = ?"
    ).bind(walletId).first();
    return json({ ok: true, balanceMinor: wallet?.balanceMinor ?? null, entryId });
  }

  return json({ ok: false, error: "API route not found" }, 404);
};

const authApi = async (request, env, url) => {
  if (!env.DB) return json({ ok: false, error: "Database is not configured" }, 503);

  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    // Reuse the existing authentication limits table: cap account creation attempts per IP.
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const registerKey = await sha256("register|" + clientIp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_login_limits (
      login_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL, blocked_until INTEGER
    )`).run();
    await env.DB.prepare("DELETE FROM auth_login_limits WHERE window_started_at<? AND COALESCE(blocked_until,0)<?")
      .bind(nowSeconds - 172800, nowSeconds).run();
    const registerLimit = await env.DB.prepare(`INSERT INTO auth_login_limits
      (login_key,attempts,window_started_at,blocked_until) VALUES (?,1,?,NULL)
      ON CONFLICT(login_key) DO UPDATE SET
        attempts=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.attempts
          WHEN auth_login_limits.window_started_at<=? THEN 1 ELSE auth_login_limits.attempts+1 END,
        window_started_at=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.window_started_at
          WHEN auth_login_limits.window_started_at<=? THEN excluded.window_started_at ELSE auth_login_limits.window_started_at END,
        blocked_until=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.blocked_until
          WHEN auth_login_limits.window_started_at<=? THEN NULL
          WHEN auth_login_limits.attempts+1>=10 THEN ? ELSE auth_login_limits.blocked_until END
      RETURNING attempts,blocked_until`).bind(
        registerKey, nowSeconds, nowSeconds, nowSeconds - 900, nowSeconds,
        nowSeconds - 900, nowSeconds, nowSeconds - 900, nowSeconds + 900
      ).first();
    if (Number(registerLimit?.blocked_until || 0) > nowSeconds) {
      const retryAfter = Math.max(1, Number(registerLimit.blocked_until) - nowSeconds);
      return json({ ok: false, error: "محاولات إنشاء حساب كثيرة؛ حاول بعد 15 دقيقة" }, 429,
        { "retry-after": String(retryAfter) });
    }
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "Invalid request body" }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const displayName = String(body.displayName || "").trim();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json({ ok: false, error: "يرجى إدخال بريد إلكتروني صحيح" }, 400);
    }
    if (displayName.length < 2 || displayName.length > 60) {
      return json({ ok: false, error: "الاسم يجب أن يكون بين حرفين و60 حرفاً" }, 400);
    }
    if (password.length < 10 || password.length > 128) {
      return json({ ok: false, error: "كلمة المرور يجب أن تكون 10 أحرف على الأقل" }, 400);
    }
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
    if (exists) return json({ ok: false, error: "البريد الإلكتروني مستخدم مسبقاً" }, 409);

    const userId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    const usdWalletId = crypto.randomUUID();
    const passwordDigest = await passwordHash(password);
    const token = randomToken();
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('syr-lira', 'SYP', 'ليرة', 1)"
        ),
        env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)"
        ).bind(userId, email, passwordDigest, displayName),
        env.DB.prepare(
          "INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('usd-dollar', 'USD', 'دولار أمريكي', 1)"
        ),
        env.DB.prepare(
          "INSERT INTO wallets (id, user_id, asset_id, balance_minor) SELECT ?, ?, id, 0 FROM assets WHERE symbol = 'SYP'"
        ).bind(walletId, userId),
        env.DB.prepare(
          "INSERT INTO wallets (id, user_id, asset_id, balance_minor) SELECT ?, ?, id, 0 FROM assets WHERE symbol = 'USD'"
        ).bind(usdWalletId, userId),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS exchange_rates (
            id TEXT PRIMARY KEY, base_symbol TEXT NOT NULL, quote_symbol TEXT NOT NULL,
            rate REAL NOT NULL CHECK(rate > 0), updated_by TEXT REFERENCES users(id),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(base_symbol, quote_symbol)
          )`
        ),
        env.DB.prepare(
          "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), userId, tokenHash, expiresAt)
      ]);
    } catch {
      return json({ ok: false, error: "تعذر إنشاء الحساب، تحقق من البيانات وحاول مجدداً" }, 409);
    }
    return json(
      { ok: true, user: { id: userId, email, displayName, role: "user" } },
      201,
      { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) }
    );
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "Invalid request body" }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || email.length > 254 || password.length > 128) {
      return json({ ok: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 400);
    }
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const loginKey = await sha256(clientIp + "|" + email);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_login_limits (
      login_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL, blocked_until INTEGER
    )`).run();
    await env.DB.prepare("DELETE FROM auth_login_limits WHERE window_started_at<? AND COALESCE(blocked_until,0)<?").bind(nowSeconds-172800,nowSeconds).run();
    const limit = await env.DB.prepare(`INSERT INTO auth_login_limits
      (login_key,attempts,window_started_at,blocked_until) VALUES (?,1,?,NULL)
      ON CONFLICT(login_key) DO UPDATE SET
        attempts=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.attempts
          WHEN auth_login_limits.window_started_at<=? THEN 1 ELSE auth_login_limits.attempts+1 END,
        window_started_at=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.window_started_at
          WHEN auth_login_limits.window_started_at<=? THEN excluded.window_started_at ELSE auth_login_limits.window_started_at END,
        blocked_until=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.blocked_until
          WHEN auth_login_limits.window_started_at<=? THEN NULL
          WHEN auth_login_limits.attempts+1>=10 THEN ? ELSE auth_login_limits.blocked_until END
      RETURNING attempts,blocked_until`).bind(loginKey,nowSeconds,nowSeconds,nowSeconds-900,nowSeconds,nowSeconds-900,nowSeconds,nowSeconds-900,nowSeconds+900).first();
    if (Number(limit?.blocked_until || 0) > nowSeconds) {
      const retryAfter=Math.max(1,Number(limit.blocked_until)-nowSeconds);
      return json({ ok: false, error: "محاولات دخول كثيرة؛ حاول بعد 15 دقيقة" }, 429, { "retry-after": String(retryAfter) });
    }
    const user = await env.DB.prepare(
      "SELECT id, email, password_hash, display_name, role, status FROM users WHERE email = ? LIMIT 1"
    ).bind(email).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return json({ ok: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 401);
    }
    if (user.status !== "active") return json({ ok: false, error: "الحساب غير نشط، يرجى مراجعة الإدارة" }, 403);
    await env.DB.prepare("DELETE FROM auth_login_limits WHERE login_key=?").bind(loginKey).run();
    const token = await createSession(env.DB, user.id);
    return json(
      { ok: true, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } },
      200,
      { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) }
    );
  }

  if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    const user = await currentUser(request, env.DB);
    if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (currentPassword.length > 128 || newPassword.length < 10 || newPassword.length > 128) {
      return json({ ok: false, error: "كلمة المرور الجديدة يجب أن تكون بين 10 و128 حرفاً" }, 400);
    }
    const record = await env.DB.prepare("SELECT password_hash FROM users WHERE id=? LIMIT 1").bind(user.id).first();
    if (!record || !(await verifyPassword(currentPassword, record.password_hash))) {
      return json({ ok: false, error: "كلمة المرور الحالية غير صحيحة" }, 401);
    }
    const digest = await passwordHash(newPassword);
    const updated = await env.DB.prepare("UPDATE users SET password_hash=? WHERE id=? AND password_hash=?")
      .bind(digest, user.id, record.password_hash).run();
    if (!updated.meta?.changes) return json({ ok: false, error: "تغيرت بيانات الحساب؛ أعد المحاولة" }, 409);
    const token = getCookie(request, COOKIE_NAME);
    if (token && token.length <= 128) {
      const tokenHash = await sha256(token);
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(user.id, tokenHash).run();
    } else {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();
    }
    return json({ ok: true });
  }

  if (url.pathname === "/api/auth/logout-others" && request.method === "POST") {
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    const user = await currentUser(request, env.DB);
    if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
    const token = getCookie(request, COOKIE_NAME);
    if (!token || token.length > 128) return json({ ok: false, error: "الجلسة غير صالحة" }, 401);
    const tokenHash = await sha256(token);
    const result = await env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND token_hash<>?"
    ).bind(user.id, tokenHash).run();
    return json({ ok: true, revoked: Number(result.meta?.changes || 0) });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    const token = getCookie(request, COOKIE_NAME);
    if (token && token.length <= 128) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env.DB);
    if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
    await ensurePaperSchema(env.DB);
    await ensureFinanceSchema(env.DB);
    await env.DB.prepare("INSERT OR IGNORE INTO paper_accounts (user_id,cash_cents) VALUES (?,1000000)").bind(user.id).run();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('syr-lira', 'SYP', 'ليرة', 1)"),
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('usd-dollar', 'USD', 'دولار أمريكي', 1)"),
      env.DB.prepare("INSERT OR IGNORE INTO wallets (id, user_id, asset_id, balance_minor) SELECT lower(hex(randomblob(16))), ?, id, 0 FROM assets WHERE symbol IN ('SYP','USD')").bind(user.id),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS exchange_rates (
        id TEXT PRIMARY KEY, base_symbol TEXT NOT NULL, quote_symbol TEXT NOT NULL,
        rate REAL NOT NULL CHECK(rate > 0), updated_by TEXT REFERENCES users(id),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(base_symbol, quote_symbol)
      )`),
    ]);
    const wallets = await env.DB.prepare(
      `SELECT a.name AS assetName, a.symbol, w.id AS walletId, w.balance_minor AS balanceMinor
       FROM wallets w JOIN assets a ON a.id = w.asset_id
       WHERE w.user_id = ? AND a.symbol IN ('SYP','USD') ORDER BY CASE a.symbol WHEN 'SYP' THEN 1 ELSE 2 END`
    ).bind(user.id).all();
    const rates = await env.DB.prepare(
      "SELECT base_symbol AS baseSymbol, quote_symbol AS quoteSymbol, rate, updated_at AS updatedAt FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1"
    ).first();
    const member=await env.DB.prepare("SELECT code FROM member_codes WHERE user_id=?").bind(user.id).first();
    return json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
      memberCode: member?.code || null,
      wallets: wallets.results || [],
      exchangeRate: rates || null
    });
  }

  return json({ ok: false, error: "API route not found" }, 404);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        if (!env.DB) throw new Error("D1 binding missing");
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json({
          ok: true,
          service: "SYR TRADER",
          environment: "cloudflare-workers",
          database: "connected",
          timestamp: new Date().toISOString()
        });
      } catch {
        return json({ ok: false, service: "SYR TRADER", database: "unavailable" }, 503);
      }
    }

    if (url.pathname.startsWith("/api/wallet/") || url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/api/market/") || url.pathname.startsWith("/api/paper/")) {
      try { return await walletApi(request, env, url); }
      catch (error) {
        console.error("SYR_TRADER_WALLET_ERROR", {
          path: url.pathname,
          method: request.method,
          message: error instanceof Error ? error.message : String(error)
        });
        return json({ ok: false, error: "حدث خطأ داخلي، حاول مجدداً" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/auth/")) {
      try { return await authApi(request, env, url); }
      catch (error) {
        console.error("SYR_TRADER_AUTH_ERROR", {
          path: url.pathname,
          method: request.method,
          message: error instanceof Error ? error.message : String(error)
        });
        return json({ ok: false, error: "حدث خطأ داخلي، حاول مجدداً" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "API route not found" }, 404);
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("x-frame-options", "DENY");
      headers.set("referrer-policy", "strict-origin-when-cross-origin");
      headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers
      });
    }
    return new Response("SYR TRADER assets are not configured.", { status: 503 });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async()=>{const stats=await runScheduledMarketBots(env.DB);console.log("SYR_TRADER_MARKET_CRON",{scheduledTime:controller.scheduledTime,...stats});})());
  }
};
