import type { ConnectionStatus, WsEvent } from "../types";

interface Handlers {
  onEvent(event: WsEvent): void;
  onStatus(status: ConnectionStatus): void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
/** On resume, a socket that doesn't answer a ping this fast is dead. */
const WAKE_PING_TIMEOUT_MS = 3000;

/** One websocket per open board, with exponential-backoff reconnect.
 * sync.hello (sent by the server on every connect) is forwarded like any
 * other event — BoardPage uses it to decide whether to re-fetch the
 * snapshot, which makes reconnects self-healing. */
export class BoardSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closed = false;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private listening = false;

  constructor(
    private boardId: string,
    private handlers: Handlers,
  ) {}

  open() {
    if (this.closed) return;
    this.listenForWake();
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${window.location.host}/ws/boards/${this.boardId}/`);

    this.ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus("open");
    };

    this.ws.onmessage = (message) => {
      this.clearPing(); // any frame proves the socket is alive
      try {
        this.handlers.onEvent(JSON.parse(message.data));
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.handlers.onStatus("reconnecting");
      const delay = Math.min(BASE_DELAY_MS * 2 ** this.attempts, MAX_DELAY_MS);
      this.attempts += 1;
      this.timer = window.setTimeout(() => this.open(), delay);
    };
  }

  /** Coming back to the page (app switch, unlock, network back): iOS
   * suspends sockets in the background and may hand back one that still
   * says OPEN but is dead. Reconnect at once if it's gone; otherwise ping
   * it and reconnect if it doesn't answer. The server's sync.hello on
   * reconnect then triggers a snapshot if anything was missed. */
  private onWake = () => {
    if (this.closed || document.visibilityState !== "visible") return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      this.reconnectNow();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || this.pingTimer !== null) return;
    this.pingTimer = window.setTimeout(() => {
      this.pingTimer = null;
      this.reconnectNow();
    }, WAKE_PING_TIMEOUT_MS);
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      this.clearPing();
      this.reconnectNow();
    }
  };

  private reconnectNow() {
    if (this.closed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.attempts = 0;
    const ws = this.ws;
    if (ws) {
      // Retire the old socket first: its late onclose must not clobber the
      // new one or schedule a second reconnect.
      ws.onclose = null;
      ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    this.ws = null;
    this.open();
  }

  private clearPing() {
    if (this.pingTimer !== null) window.clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private listenForWake() {
    if (this.listening) return;
    this.listening = true;
    document.addEventListener("visibilitychange", this.onWake);
    window.addEventListener("pageshow", this.onWake);
    window.addEventListener("online", this.onWake);
  }

  close() {
    this.closed = true;
    this.clearPing();
    document.removeEventListener("visibilitychange", this.onWake);
    window.removeEventListener("pageshow", this.onWake);
    window.removeEventListener("online", this.onWake);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
