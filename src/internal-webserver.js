import WebServer from '@deepseek-ai/dsh-host-webserver';

/** No externally supplied host/port can expose this raw listener. */
export default class InternalWebServer extends WebServer {
  constructor(ctx, config) {
    super(ctx, { ...config, host: '127.0.0.1', port: 0 });
    this.totpInternal = true;
  }
}
