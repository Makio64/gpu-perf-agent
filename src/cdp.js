import { createRequire } from "node:module";

// node:net, node:tls and node:crypto through createRequire: never the global WebSocket,
// which loads undici and tls (see http-client.js). tls is loaded only for wss:// URLs.
const require = createRequire(import.meta.url);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;

export class CDPConnection {
  /** Browser WebSocket endpoint (`--cdp`). ws:// uses node:net; wss:// loads node:tls lazily. */
  static async connect(url, { timeoutMs = 10000 } = {}) {
    return new CDPConnection(await WebSocketTransport.connect(url, timeoutMs));
  }

  /** `--remote-debugging-pipe`: write to Chrome's fd 3, read its fd 4; NUL-delimited JSON. */
  static fromPipe(writable, readable) {
    return new CDPConnection(new PipeTransport(writable, readable));
  }

  constructor(socket) {
    this.id = 1;
    this.listeners = new Map();
    this.pending = new Map();
    this.sessions = new Map();
    this.closeHandlers = new Set();
    this.socket = socket;
    this.closed = false;

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => this.dispose());
  }

  /** Called once when the transport closes (Chrome exited, pipe or socket closed, or close()). */
  onClose(handler) {
    if (this.closed) {
      queueMicrotask(handler);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  dispose() {
    const wasClosed = this.closed;
    this.closed = true;
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error("Chrome DevTools connection closed."));
    }
    this.pending.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.listeners.clear();
    if (wasClosed) return;
    const handlers = Array.from(this.closeHandlers);
    this.closeHandlers.clear();
    for (const handler of handlers) {
      try { handler(); } catch { /* A close observer must not break disposal. */ }
    }
  }

  close() {
    this.dispose();
    if (this.socket.readyState === 1 || this.socket.readyState === 0) this.socket.close();
  }

  session(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new CDPSession(this, sessionId));
    return this.sessions.get(sessionId);
  }

  disposeSession(sessionId) {
    this.sessions.delete(sessionId);
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(new Error(`Chrome DevTools session closed during ${pending.method}.`));
    }
  }

  send(method, params, timeoutMs = 30000) {
    return this.sendRaw(method, params, undefined, timeoutMs);
  }

  sendRaw(method, params, sessionId, timeoutMs = 30000) {
    if (this.closed || this.socket.readyState !== 1) return Promise.reject(new Error("Chrome DevTools connection closed."));
    const id = this.id;
    this.id += 1;
    const message = {
      id,
      method,
      params
    };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        sessionId,
        reject,
        resolve,
        timeout
      });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(handler);
    return () => {
      const handlers = this.listeners.get(method);
      handlers?.delete(handler);
      if (handlers?.size === 0) this.listeners.delete(method);
    };
  }

  once(method, handler) {
    const off = this.on(method, (params, sessionId) => {
      off();
      handler(params, sessionId);
    });
    return off;
  }

  handleMessage(data) {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const message = JSON.parse(text);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      if (message.method === "Target.detachedFromTarget") this.sessions.get(message.params?.sessionId)?.dispose();
      const handlers = this.listeners.get(message.method);
      if (!handlers) {
        return;
      }
      for (const handler of Array.from(handlers)) {
        handler(message.params || {}, message.sessionId);
      }
    }
  }
}

class CDPSession {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.subscriptions = new Set();
    this.closed = false;
  }

  send(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("Chrome DevTools session closed."));
    return this.connection.sendRaw(method, params, this.sessionId, timeoutMs);
  }

  on(method, handler) {
    if (this.closed) throw new Error("Chrome DevTools session closed.");
    const unsubscribe = this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) {
        handler(params);
      }
    });
    const off = () => {
      unsubscribe();
      this.subscriptions.delete(off);
    };
    this.subscriptions.add(off);
    return off;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.subscriptions) off();
    this.connection.disposeSession(this.sessionId);
  }

  once(method, handler) {
    const off = this.on(method, (params) => {
      off();
      handler(params);
    });
    return off;
  }
}

/** Minimal event-target surface shared by both transports (and the unit-test socket). */
class Transport {
  constructor() {
    this.readyState = 1;
    this.handlers = { message: new Set(), close: new Set() };
  }

  addEventListener(type, handler) {
    this.handlers[type]?.add(handler);
  }

  emitMessage(data) {
    for (const handler of this.handlers.message) handler({ data });
  }

  emitClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const handler of this.handlers.close) handler({});
  }
}

class PipeTransport extends Transport {
  constructor(writable, readable) {
    super();
    this.writable = writable;
    let pending = [];
    readable.on("data", (chunk) => {
      let start = 0;
      let index;
      while ((index = chunk.indexOf(0, start)) !== -1) {
        pending.push(chunk.subarray(start, index));
        const message = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];
        start = index + 1;
        this.emitMessage(message.toString("utf8"));
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    const onClose = () => this.emitClose();
    readable.on("end", onClose);
    readable.on("close", onClose);
    readable.on("error", onClose);
    writable.on("error", onClose);
    writable.on("close", onClose);
  }

  send(text) {
    this.writable.write(text);
    this.writable.write("\0");
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 2;
    this.writable.end();
  }
}

/** RFC 6455 client: masked frames, 16/64-bit lengths, fragmentation, ping/pong/close. */
export class WebSocketTransport extends Transport {
  static connect(url, timeoutMs = 10000) {
    let target;
    try { target = new URL(url); } catch { target = null; }
    if (!target || !["ws:", "wss:"].includes(target.protocol)) {
      return Promise.reject(Object.assign(new TypeError(`Expected a ws:// or wss:// URL, received ${url}.`), { code: "invalid-options" }));
    }
    const secure = target.protocol === "wss:";
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port) || (secure ? 443 : 80);
    const { createHash, randomBytes } = require("node:crypto");
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");

    return new Promise((resolve, reject) => {
      const socket = secure
        ? require("node:tls").connect({ host, port, servername: require("node:net").isIP(host) ? undefined : host })
        : require("node:net").connect({ host, port });
      let head = Buffer.alloc(0);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(Object.assign(new Error(`Could not open Chrome DevTools WebSocket ${target.host}: ${error.message || error}.`, { cause: error }), {
          code: "server-unreachable",
          hint: "Start Chrome with --remote-debugging-port and pass that port or its browser WebSocket URL to --cdp."
        }));
      };
      const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      socket.once("error", fail);
      socket.once("close", () => fail(new Error("connection closed during handshake")));
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.write([
          `GET ${target.pathname || "/"}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "", ""
        ].join("\r\n"));
      });
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
          if (head.length > 16384) fail(new Error("oversized handshake response"));
          return;
        }
        socket.off("data", onData);
        const lines = head.subarray(0, end).toString("latin1").split("\r\n");
        const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0])?.[1];
        const headers = Object.fromEntries(lines.slice(1).map(line => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        }));
        if (status !== "101") return fail(new Error(`handshake returned ${lines[0]}`));
        if (headers["sec-websocket-accept"] !== expectedAccept) return fail(new Error("invalid Sec-WebSocket-Accept"));
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        resolve(new WebSocketTransport(socket, head.subarray(end + 4)));
      };
      socket.on("data", onData);
    });
  }

  constructor(socket, initial = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.chunks = [];
    this.length = 0;
    this.fragments = null;
    socket.setNoDelay?.(true);
    socket.on("data", chunk => this.receive(chunk));
    socket.on("error", () => this.emitClose());
    socket.on("close", () => this.emitClose());
    if (initial.length) queueMicrotask(() => this.receive(initial));
  }

  receive(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    try { this.parse(); }
    catch { this.socket.destroy(); this.emitClose(); }
  }

  // Merge only the leading chunks needed to read `bytes`, so a large frame is copied once.
  coalesce(bytes) {
    if (this.chunks[0].length >= bytes) return this.chunks[0];
    let count = 0;
    let total = 0;
    while (total < bytes && count < this.chunks.length) total += this.chunks[count++].length;
    this.chunks.splice(0, count, Buffer.concat(this.chunks.slice(0, count), total));
    return this.chunks[0];
  }

  take(bytes) {
    const first = this.coalesce(bytes);
    const value = first.subarray(0, bytes);
    if (first.length === bytes) this.chunks.shift();
    else this.chunks[0] = first.subarray(bytes);
    this.length -= bytes;
    return value;
  }

  parse() {
    while (this.length >= 2) {
      const head = this.coalesce(Math.min(this.length, 14));
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      const masked = (head[1] & 0x80) !== 0;
      let size = head[1] & 0x7f;
      let offset = 2;
      if (size === 126) {
        if (head.length < 4) return;
        size = head.readUInt16BE(2);
        offset = 4;
      } else if (size === 127) {
        if (head.length < 10) return;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error("WebSocket frame too large.");
        size = Number(big);
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (head.length < offset + 4) return;
        mask = Buffer.from(head.subarray(offset, offset + 4));
        offset += 4;
      }
      if (this.length < offset + size) return;
      const frame = this.take(offset + size).subarray(offset);
      if (mask) for (let index = 0; index < frame.length; index += 1) frame[index] ^= mask[index & 3];
      this.frame(fin, opcode, frame);
    }
  }

  frame(fin, opcode, payload) {
    if (opcode === 0x8) {
      if (this.readyState === 1) this.write(0x8, payload.subarray(0, 2));
      this.readyState = 2;
      this.socket.end();
      return;
    }
    if (opcode === 0x9) return this.write(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      if (!this.fragments) throw new Error("Unexpected continuation frame.");
      this.fragments.push(Buffer.from(payload));
    } else if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [Buffer.from(payload)];
    } else throw new Error(`Unsupported WebSocket opcode ${opcode}.`);
    if (!fin) return;
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = null;
    this.emitMessage(message.toString("utf8"));
  }

  write(opcode, payload) {
    if (this.socket.destroyed) return;
    const { randomBytes } = require("node:crypto");
    const length = payload.length;
    const header = Buffer.alloc(length < 126 ? 6 : length < 65536 ? 8 : 14);
    header[0] = 0x80 | opcode;
    let offset = 2;
    if (length < 126) header[1] = 0x80 | length;
    else if (length < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
      offset = 4;
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
      offset = 10;
    }
    const mask = randomBytes(4);
    mask.copy(header, offset);
    const masked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index & 3];
    this.socket.write(Buffer.concat([header, masked]));
  }

  send(text) {
    if (this.readyState !== 1) throw new Error("Chrome DevTools WebSocket closed.");
    this.write(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    if (this.readyState !== 1) return;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000, 0);
    this.write(0x8, code);
    this.readyState = 2;
    this.socket.end();
    // Chrome answers the close frame; do not keep the process alive if it does not.
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}
