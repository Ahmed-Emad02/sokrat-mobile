import JsSIP from 'jssip';

/** JsSIP Socket adapter: refresh authentication without replacing the UA/dialogs.
 * The initial URL is consumed once; every subsequent connect obtains a new URL.
 * Never log URL/error objects here: they may carry one-use gateway tickets.
 */
export class HandoverSocket {
  private socket: JsSIP.WebSocketInterface | null = null;
  private initialUrl: string | null;
  private generation = 0;
  private connecting = false;
  private metadata: JsSIP.WebSocketInterface;

  onconnect: () => void = () => {};
  ondisconnect: (error: boolean, code?: number, reason?: string) => void = () => {};
  ondata: <T>(data: T) => void = () => {};

  constructor(url: string, private nextUrl: () => Promise<string>) {
    this.initialUrl = url;
    this.metadata = new JsSIP.WebSocketInterface(url);
  }

  get url(): string { return this.metadata.url; }
  get sip_uri(): string { return this.metadata.sip_uri; }
  get via_transport(): string { return this.metadata.via_transport; }
  set via_transport(value: string) { this.metadata.via_transport = value; }

  connect(): void {
    if (this.isConnected() || this.connecting) return;
    const generation = ++this.generation;
    this.connecting = true;
    const open = (url: string) => {
      if (generation !== this.generation) return;
      const socket = new JsSIP.WebSocketInterface(url);
      this.socket = socket;
      socket.onconnect = () => {
        if (generation !== this.generation) return;
        this.connecting = false;
        this.onconnect();
      };
      socket.ondisconnect = (error, code) => {
        if (generation !== this.generation) return;
        this.connecting = false;
        this.ondisconnect(error, code, 'Signaling socket closed');
      };
      socket.ondata = data => { if (generation === this.generation) this.ondata(data); };
      socket.connect();
    };
    if (this.initialUrl) {
      const url = this.initialUrl;
      this.initialUrl = null;
      open(url);
    } else {
      void this.nextUrl().then(open).catch(() => {
        if (generation !== this.generation) return;
        this.connecting = false;
        this.ondisconnect(true, 1006, 'Signaling authorization unavailable');
      });
    }
  }

  disconnect(): void {
    this.generation++;
    this.connecting = false;
    this.initialUrl = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  /** Mark the old path dead. JsSIP's transport recovery opens the new one. */
  reconnect(): void {
    this.disconnect();
    this.ondisconnect(false, 1001, 'Network handover');
  }

  send(message: Parameters<JsSIP.WebSocketInterface['send']>[0]): boolean {
    return this.socket?.send(message) ?? false;
  }
  isConnected(): boolean { return this.socket?.isConnected() ?? false; }
  isConnecting(): boolean { return this.connecting; }
}
