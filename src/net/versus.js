// The online versus connection: one WebSocket to the room server.

export class Versus {
  constructor() {
    this.ws = null;
    this.id = null;
    this.room = null;
    this.on = () => {};
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(hello) {
    if (this.connected) {
      this.send({ t: 'hello', ...hello });
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws`));
      let opened = false;
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.t === 'welcome') {
          this.id = m.id;
          opened = true;
          this.send({ t: 'hello', ...hello });
          resolve();
          return;
        }
        if (m.t === 'room') this.room = m.room;
        this.on(m.t, m);
      };
      ws.onclose = () => {
        this.room = null;
        if (this.ws === ws) this.ws = null;
        if (!opened) reject(new Error('Could not reach the game server.'));
        else this.on('closed', {});
      };
      ws.onerror = () => {};
    });
  }

  send(m) {
    if (this.connected) this.ws.send(JSON.stringify(m));
  }

  get isHost() {
    return !!this.room && this.room.hostId === this.id;
  }

  leave() {
    this.send({ t: 'leave' });
    this.room = null;
  }
}
