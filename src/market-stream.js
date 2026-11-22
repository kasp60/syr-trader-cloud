import { DurableObject } from "cloudflare:workers";
import { marketQuote } from "./reserve-risk.js";

export class MarketStream extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      let update;
      try { update = await request.json(); } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const instrumentId = String(update?.instrumentId || "");
      const priceMicro = Number(update?.priceMicro);
      const updatedAt = String(update?.updatedAt || "");
      if (!instrumentId || instrumentId.length > 80 || !Number.isSafeInteger(priceMicro) ||
          priceMicro <= 0 || !Number.isFinite(Date.parse(updatedAt))) {
        return new Response("Invalid market update", { status: 400 });
      }
      const message = JSON.stringify({
        type: "market_price", instrumentId, priceMicro, updatedAt,
        bidPriceMicro: Number(marketQuote(priceMicro, "bid")),
        askPriceMicro: Number(marketQuote(priceMicro, "ask"))
      });
      let sent = 0;
      for (const socket of this.ctx.getWebSockets()) {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(message);
            sent++;
          }
        } catch {
          try { socket.close(1011, "Broadcast failed"); } catch {}
        }
      }
      return Response.json({ ok: true, sent });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(socket, message) {
    if (message === "ping") socket.send("pong");
    else socket.close(1008, "Unsupported message");
  }

  webSocketClose(socket, code, reason) {
    if (code === 1006) return;
    if (code >= 1000 && code < 5000 && ![1004, 1005, 1015].includes(code)) {
      socket.close(code, reason);
    } else {
      socket.close();
    }
  }

  webSocketError(socket) {
    try { socket.close(1011, "WebSocket error"); } catch {}
  }
}
