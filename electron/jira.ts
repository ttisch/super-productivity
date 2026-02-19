import { getWin } from './main-window';
import { IPC } from './shared-with-frontend/ipc-events.const';
import { session } from 'electron';
import { JiraCfg } from '../src/app/features/issue/providers/jira/jira.model';
import fetch, { RequestInit } from 'node-fetch';
import { Agent } from 'https';
import { error, log } from 'electron-log/main';
import { URL } from 'url';
import * as net from 'net';
import * as tls from 'tls';
import { Duplex } from 'stream';

// Custom Agent that supports HTTP CONNECT proxy for HTTPS requests
class HttpsProxyAgent extends Agent {
  private proxyHost: string;
  private proxyPort: number;
  private rejectUnauthorized: boolean;

  constructor(proxyUrl: URL, rejectUnauthorized: boolean) {
    super({ rejectUnauthorized });
    this.proxyHost = proxyUrl.hostname;
    this.proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : 8080;
    this.rejectUnauthorized = rejectUnauthorized;
  }

  createConnection(
    options: any,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;

    // Create connection to proxy
    const socket = net.connect(this.proxyPort, this.proxyHost, () => {
      // Send HTTP CONNECT request to proxy
      const connectReq =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(connectReq);
    });

    let responseData = '';
    socket.on('data', (data: Buffer) => {
      responseData += data.toString();

      // Check if we received the complete HTTP response headers
      if (responseData.includes('\r\n\r\n')) {
        const statusLine = responseData.split('\r\n')[0];
        const statusCode = parseInt(statusLine.split(' ')[1], 10);

        if (statusCode === 200) {
          // CONNECT successful, upgrade to TLS
          const secureSocket = tls.connect(
            {
              socket: socket,
              servername: targetHost,
              rejectUnauthorized: this.rejectUnauthorized,
            },
            () => {
              if (callback) callback(null, secureSocket as Duplex);
            },
          );

          secureSocket.on('error', (err: Error) => {
            if (callback) callback(err, secureSocket as Duplex);
          });
        } else {
          socket.destroy();
          if (callback)
            callback(
              new Error(`Proxy CONNECT failed with status ${statusCode}`),
              socket as Duplex,
            );
        }
      }
    });

    socket.on('error', (err: Error) => {
      if (callback) callback(err, socket as Duplex);
    });

    return socket as Duplex;
  }
}

const getProxyAgent = (
  targetUrl: string,
  rejectUnauthorized: boolean,
): Agent | undefined => {
  // Check proxy environment variables (case-insensitive)
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;

  if (!proxyUrl) {
    return undefined;
  }

  try {
    const proxy = new URL(proxyUrl);
    const target = new URL(targetUrl);
    log(`Using proxy: ${proxy.host} for Jira request to ${target.host}`);

    // Only support HTTPS targets with proxy (Jira is typically HTTPS)
    if (target.protocol === 'https:') {
      return new HttpsProxyAgent(proxy, rejectUnauthorized);
    } else {
      log('HTTP proxy support for non-HTTPS targets not implemented');
      return undefined;
    }
  } catch (e) {
    error('Failed to configure proxy:', proxyUrl, e);
    return undefined;
  }
};

export const sendJiraRequest = ({
  requestId,
  requestInit,
  url,
  jiraCfg,
}: {
  requestId: string;
  requestInit: RequestInit;
  url: string;
  jiraCfg: JiraCfg;
}): void => {
  const mainWin = getWin();
  // log('--------------------------------------------------------------------');
  // log(url);
  // log('--------------------------------------------------------------------');

  const rejectUnauthorized = !(jiraCfg && jiraCfg.isAllowSelfSignedCertificate);
  const proxyAgent = getProxyAgent(url, rejectUnauthorized);

  // Use proxy agent if available, otherwise use custom agent only if self-signed certs are allowed
  const agent =
    proxyAgent ||
    (!rejectUnauthorized
      ? new Agent({
          rejectUnauthorized: false, // lgtm[js/disabling-certificate-validation]
        })
      : undefined);

  fetch(url, {
    ...requestInit,
    // Allow self-signed certificates for self-hosted Jira instances.
    // This is an intentional user-configurable setting (isAllowSelfSignedCertificate).
    // CodeQL alert js/disabling-certificate-validation is expected here.
    ...(agent ? { agent } : {}),
  } as RequestInit)
    .then(async (response) => {
      // log('JIRA_RAW_RESPONSE', response);
      if (!response.ok) {
        error('Jira Error Error Response ELECTRON: ', response);
        try {
          log(JSON.stringify(response));
        } catch (e) {}

        let errText;
        try {
          errText = await response.text();
        } catch (e2) {
          throw Error(response.statusText);
        }
        throw Error(errText || response.statusText);
      }
      return response;
    })
    .then((res) => res.text())
    .then((text) => {
      try {
        return text ? JSON.parse(text) : {};
      } catch (e) {
        console.error('Error: Cannot parse json');
        console.log('Error: text response', text);
        // throw new Error(e);
        return text;
      }
    })
    .then((response) => {
      mainWin.webContents.send(IPC.JIRA_CB_EVENT, {
        response,
        requestId,
      });
    })
    .catch((err: unknown) => {
      mainWin.webContents.send(IPC.JIRA_CB_EVENT, {
        error: err,
        requestId,
      });
    });
};

// TODO simplify and do encoding in frontend service
export const setupRequestHeadersForImages = (jiraCfg: JiraCfg): void => {
  const { host, protocol } = parseHostAndPort(jiraCfg);

  // TODO export to util fn
  const _b64EncodeUnicode = (str: string): string => {
    return Buffer.from(str || '').toString('base64');
  };
  const encoded = _b64EncodeUnicode(`${jiraCfg.userName}:${jiraCfg.password}`);
  const filter = {
    urls: [`${protocol}://${host}/*`],
  };

  // thankfully only the last attached listener will be used
  // @see: https://electronjs.org/docs/api/web-request
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (jiraCfg.usePAT) {
      details.requestHeaders.authorization = `Bearer ${jiraCfg.password}`;
    } else {
      details.requestHeaders.authorization = `Basic ${encoded}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
};

const MATCH_PROTOCOL_REG_EX = /(^[^:]+):\/\//;
const MATCH_PORT_REG_EX = /:\d{2,4}/;

const parseHostAndPort = (
  config: JiraCfg,
): { host: string; protocol: string; port: number | undefined } => {
  let host: string = config.host as string;
  let protocol;
  let port;

  if (!host) {
    throw new Error('No host given');
  }

  // parse port from host and remove it
  if (host.match(MATCH_PORT_REG_EX)) {
    const match = MATCH_PORT_REG_EX.exec(host) as RegExpExecArray;
    host = host.replace(MATCH_PORT_REG_EX, '');
    port = parseInt(match[0].replace(':', ''), 10);
  }

  // parse protocol from host and remove it
  if (host.match(MATCH_PROTOCOL_REG_EX)) {
    const match = MATCH_PROTOCOL_REG_EX.exec(host);
    host = host
      .replace(MATCH_PROTOCOL_REG_EX, '')
      // remove trailing slash just in case
      .replace(/\/$/, '');

    protocol = (match as any)[1];
  } else {
    protocol = 'https';
  }

  // log({host, protocol, port});
  return { host, protocol, port };
};
