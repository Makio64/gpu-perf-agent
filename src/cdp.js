export class CDPConnection {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Chrome DevTools WebSocket."));
      }, 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", (event) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome DevTools WebSocket error: ${event.message || "unknown"}`));
      }, { once: true });
    });

    return new CDPConnection(socket);
  }

  constructor(socket) {
    this.id = 1;
    this.listeners = new Map();
    this.pending = new Map();
    this.sessions = new Map();
    this.socket = socket;
    this.closed = false;

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => this.dispose());
  }

  dispose() {
    this.closed = true;
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error("Chrome DevTools WebSocket closed."));
    }
    this.pending.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.listeners.clear();
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
    if (this.closed || this.socket.readyState !== 1) return Promise.reject(new Error("Chrome DevTools WebSocket closed."));
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
