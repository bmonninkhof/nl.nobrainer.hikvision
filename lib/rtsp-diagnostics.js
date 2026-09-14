'use strict';

const crypto = require('crypto');
const net = require('net');

const DEFAULT_TIMEOUT = 4500;
const MAX_RESPONSE_BYTES = 64 * 1024;

function parseAuthenticateHeader(value = '') {
  const header = Array.isArray(value) ? value.join(', ') : String(value);
  const match = header.match(/(?:^|,\s*)(Digest|Basic)\s+([\s\S]*?)(?=,\s*(?:Digest|Basic|Bearer|Negotiate|NTLM)\b|$)/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const parameters = {};
  const pattern = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let item;
  while ((item = pattern.exec(match[2])) !== null) {
    parameters[item[1].toLowerCase()] = item[2] ?? item[3] ?? '';
  }
  return { scheme, parameters };
}

function digest(value, algorithm = 'MD5') {
  const normalized = String(algorithm || 'MD5').toLowerCase().replace('-sess', '');
  const hash = normalized === 'sha-256' ? 'sha256' : 'md5';
  return crypto.createHash(hash).update(value).digest('hex');
}

function buildAuthorization(challenge, { username, password, method, uri }) {
  if (!challenge) return null;
  if (challenge.scheme === 'basic') {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  if (challenge.scheme !== 'digest') return null;

  const { realm = '', nonce = '', opaque, algorithm = 'MD5' } = challenge.parameters;
  if (!nonce) return null;
  const qopOptions = String(challenge.parameters.qop || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const qop = qopOptions.includes('auth') ? 'auth' : null;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  let ha1 = digest(`${username}:${realm}:${password}`, algorithm);
  if (String(algorithm).toLowerCase().endsWith('-sess')) {
    ha1 = digest(`${ha1}:${nonce}:${cnonce}`, algorithm);
  }
  const ha2 = digest(`${method}:${uri}`, algorithm);
  const response = qop
    ? digest(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`, algorithm)
    : digest(`${ha1}:${nonce}:${ha2}`, algorithm);
  const parts = [
    `username="${String(username).replace(/["\\]/g, '')}"`,
    `realm="${realm.replace(/["\\]/g, '')}"`,
    `nonce="${nonce.replace(/["\\]/g, '')}"`,
    `uri="${uri.replace(/["\\]/g, '')}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (opaque) parts.push(`opaque="${opaque.replace(/["\\]/g, '')}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

function parseRtspResponse(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const lines = headerText.split('\r\n');
  const statusMatch = lines.shift()?.match(/^RTSP\/\d\.\d\s+(\d{3})/i);
  if (!statusMatch) throw Object.assign(new Error('Invalid RTSP response'), { code: 'INVALID_RTSP_RESPONSE' });
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const contentLength = Math.max(0, Number(headers['content-length']) || 0);
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + contentLength) return null;
  return {
    statusCode: Number(statusMatch[1]),
    headers,
    body: buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8'),
  };
}

function summarizeSdp(sdp = '') {
  const result = { codecs: [], videoPayloads: [], audioPayloads: [] };
  let media = null;
  for (const line of String(sdp).split(/\r?\n/)) {
    const mediaMatch = line.match(/^m=(video|audio)\s+\d+\s+\S+\s+(.+)$/i);
    if (mediaMatch) {
      media = mediaMatch[1].toLowerCase();
      const payloads = mediaMatch[2].trim().split(/\s+/).map(Number).filter(Number.isFinite);
      result[`${media}Payloads`] = payloads;
      continue;
    }
    const codecMatch = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/i);
    if (codecMatch) {
      result.codecs.push({
        media: media || 'unknown',
        payload: Number(codecMatch[1]),
        codec: codecMatch[2].toUpperCase(),
      });
    }
  }
  return result;
}

function requestRtsp({ host, port, requestUri, authorization, timeout = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = Buffer.alloc(0);
    let connected = false;
    const finishError = error => {
      error.tcpConnected = connected;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeout, () => finishError(Object.assign(new Error('RTSP timeout'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => {
      connected = true;
      const headers = [
        `DESCRIBE ${requestUri} RTSP/1.0`,
        'CSeq: 1',
        'Accept: application/sdp',
        'User-Agent: Homey-Hikvision-Diagnostics',
      ];
      if (authorization) headers.push(`Authorization: ${authorization}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_RESPONSE_BYTES) {
        finishError(Object.assign(new Error('RTSP response too large'), { code: 'RESPONSE_TOO_LARGE' }));
        return;
      }
      try {
        const response = parseRtspResponse(data);
        if (!response) return;
        socket.destroy();
        resolve({ ...response, tcpConnected: connected });
      } catch (error) {
        finishError(error);
      }
    });
    socket.once('error', finishError);
  });
}

async function getRtspDiagnostics({
  host, port = 554, username = '', password = '', channelId = 1, streamId,
  timeout = DEFAULT_TIMEOUT, requester = requestRtsp,
}) {
  const selectedStreamId = Number(streamId) || Number(`${Number(channelId) || 1}01`);
  const safeResult = {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    target: { port: Number(port) || 554, channelId: Number(channelId) || 1, streamId: selectedStreamId },
    tcp: { status: 'unavailable' },
    describe: { status: 'unavailable' },
  };
  const requestUri = `rtsp://${String(host).includes(':') ? `[${host}]` : host}:${safeResult.target.port}/Streaming/Channels/${selectedStreamId}`;
  const requestPath = `/Streaming/Channels/${selectedStreamId}`;
  try {
    let response = await requester({ host, port: safeResult.target.port, requestUri, timeout });
    safeResult.tcp = { status: response.tcpConnected ? 'connected' : 'unavailable' };
    let authScheme = 'none';
    if (response.statusCode === 401) {
      const challenge = parseAuthenticateHeader(response.headers['www-authenticate']);
      authScheme = challenge?.scheme || 'unsupported';
      const authorization = buildAuthorization(challenge, {
        username, password, method: 'DESCRIBE', uri: requestUri,
      });
      if (authorization) {
        response = await requester({
          host, port: safeResult.target.port, requestUri, authorization, timeout,
        });
        // Some Hikvision NVR firmware expects the Digest uri field to contain
        // only the RTSP path, while the DESCRIBE request line remains absolute.
        if (response.statusCode === 401 && challenge?.scheme === 'digest') {
          const pathAuthorization = buildAuthorization(challenge, {
            username, password, method: 'DESCRIBE', uri: requestPath,
          });
          response = await requester({
            host, port: safeResult.target.port, requestUri, authorization: pathAuthorization, timeout,
          });
        }
      }
    }
    const sdp = summarizeSdp(response.body);
    safeResult.describe = {
      status: response.statusCode === 200 ? 'available' : 'rejected',
      rtspStatus: response.statusCode,
      authentication: authScheme,
      contentType: response.headers['content-type'] || null,
      sdpBytes: Buffer.byteLength(response.body || ''),
      ...sdp,
    };
  } catch (error) {
    safeResult.tcp = { status: error.tcpConnected ? 'connected' : 'unavailable' };
    safeResult.describe = {
      status: 'unavailable',
      errorCode: String(error.code || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 64),
    };
  }
  return safeResult;
}

module.exports = {
  buildAuthorization,
  getRtspDiagnostics,
  parseAuthenticateHeader,
  parseRtspResponse,
  summarizeSdp,
};
