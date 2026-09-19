'use strict';

const crypto = require('crypto');
const net = require('net');

const DEFAULT_TIMEOUT = 6500;
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

function h264Profile(profileLevelId = '') {
  const normalized = String(profileLevelId).trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) return null;
  const profileIdc = Number.parseInt(normalized.slice(0, 2), 16);
  const constraintFlags = Number.parseInt(normalized.slice(2, 4), 16);
  const levelIdc = Number.parseInt(normalized.slice(4, 6), 16);
  const names = {
    66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High',
    110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4',
  };
  return {
    profileLevelId: normalized,
    profileIdc,
    profile: names[profileIdc] || 'Unknown',
    constraintFlags,
    levelIdc,
    level: Number((levelIdc / 10).toFixed(1)),
  };
}

function safeControlSummary(value = '') {
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized === '*') return { present: true, type: 'aggregate' };
  const trackMatch = normalized.match(/(?:track(?:id)?[=/]?|streamid=)(\d+)/i);
  return {
    present: true,
    type: /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? 'absolute' : 'relative',
    ...(trackMatch ? { trackId: Number(trackMatch[1]) } : {}),
  };
}

function parseFmtp(value = '') {
  const parameters = {};
  for (const item of String(value).split(';')) {
    const equals = item.indexOf('=');
    if (equals < 0) continue;
    parameters[item.slice(0, equals).trim().toLowerCase()] = item.slice(equals + 1).trim();
  }
  const profile = h264Profile(parameters['profile-level-id']);
  const parameterSets = String(parameters['sprop-parameter-sets'] || '').split(',').filter(Boolean);
  return {
    ...(parameters['packetization-mode'] !== undefined
      ? { packetizationMode: Number(parameters['packetization-mode']) } : {}),
    ...(parameters['level-asymmetry-allowed'] !== undefined
      ? { levelAsymmetryAllowed: parameters['level-asymmetry-allowed'] === '1' } : {}),
    ...(profile ? { h264Profile: profile } : {}),
    parameterSets: {
      advertised: parameterSets.length > 0,
      count: parameterSets.length,
      spsPresent: parameterSets.length >= 1,
      ppsPresent: parameterSets.length >= 2,
    },
  };
}

function summarizeSdp(sdp = '') {
  const result = {
    codecs: [], videoPayloads: [], audioPayloads: [], mediaSections: [],
    sessionControl: null, hikvisionMediaHeaderPresent: false,
  };
  let media = null;
  for (const line of String(sdp).split(/\r?\n/)) {
    const mediaMatch = line.match(/^m=(video|audio|application)\s+(\d+)\s+(\S+)\s+(.+)$/i);
    if (mediaMatch) {
      const type = mediaMatch[1].toLowerCase();
      const payloads = mediaMatch[4].trim().split(/\s+/).map(Number).filter(Number.isFinite);
      media = {
        type, port: Number(mediaMatch[2]), protocol: mediaMatch[3].toUpperCase(), payloads,
        direction: null, control: null, frameRate: null, frameSize: null, bandwidth: {},
      };
      result.mediaSections.push(media);
      if (type === 'video' || type === 'audio') result[`${type}Payloads`] = payloads;
      continue;
    }
    const codecMatch = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)(?:\/(\d+))?(?:\/(\d+))?/i);
    if (codecMatch) {
      result.codecs.push({
        media: media?.type || 'unknown', payload: Number(codecMatch[1]),
        codec: codecMatch[2].toUpperCase(),
        ...(codecMatch[3] ? { clockRate: Number(codecMatch[3]) } : {}),
        ...(codecMatch[4] ? { channels: Number(codecMatch[4]) } : {}),
      });
      continue;
    }
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.+)$/i);
    if (fmtpMatch) {
      const codec = result.codecs.find(item => item.payload === Number(fmtpMatch[1])
        && item.media === (media?.type || 'unknown'));
      if (codec?.codec === 'H264') Object.assign(codec, parseFmtp(fmtpMatch[2]));
      continue;
    }
    const controlMatch = line.match(/^a=control:(.+)$/i);
    if (controlMatch) {
      const summary = safeControlSummary(controlMatch[1]);
      if (media) media.control = summary;
      else result.sessionControl = summary;
      continue;
    }
    const directionMatch = line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/i);
    if (directionMatch && media) {
      media.direction = directionMatch[1].toLowerCase();
      continue;
    }
    const frameRateMatch = line.match(/^a=(?:x-)?framerate:(\d+(?:\.\d+)?)$/i);
    if (frameRateMatch && media?.type === 'video') {
      media.frameRate = Number(frameRateMatch[1]);
      continue;
    }
    const frameSizeMatch = line.match(/^a=framesize:(\d+)\s+(\d+)[-x](\d+)$/i);
    if (frameSizeMatch && media?.type === 'video') {
      media.frameSize = {
        payload: Number(frameSizeMatch[1]), width: Number(frameSizeMatch[2]),
        height: Number(frameSizeMatch[3]),
      };
      continue;
    }
    const bandwidthMatch = line.match(/^b=(AS|TIAS):(\d+)$/i);
    if (bandwidthMatch && media) media.bandwidth[bandwidthMatch[1].toUpperCase()] = Number(bandwidthMatch[2]);
    if (/^a=Media_header:/i.test(line)) result.hikvisionMediaHeaderPresent = true;
  }
  result.keyframeInterval = { advertised: false, reason: 'not-available-in-sdp' };
  return result;
}

function requestRtsp({
  host, port, requestUri, authorization, timeout = DEFAULT_TIMEOUT,
  socket: existingSocket, keepAlive = false, cseq = 1, method = 'DESCRIBE',
  headers: extraHeaders = [],
}) {
  return new Promise((resolve, reject) => {
    const reusableSocket = existingSocket && !existingSocket.destroyed ? existingSocket : null;
    const socket = reusableSocket || net.createConnection({ host, port });
    let data = Buffer.alloc(0);
    let connected = Boolean(reusableSocket);
    let settled = false;
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', finishError);
      socket.removeListener('connect', sendRequest);
      socket.setTimeout(0);
    };
    const finishError = error => {
      if (settled) return;
      settled = true;
      error.tcpConnected = connected;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const sendRequest = () => {
      connected = true;
      const headers = [
        `${method} ${requestUri} RTSP/1.0`,
        `CSeq: ${cseq}`,
        'User-Agent: Homey-Hikvision-Diagnostics',
      ];
      if (method === 'DESCRIBE') headers.push('Accept: application/sdp');
      headers.push(...extraHeaders);
      if (authorization) headers.push(`Authorization: ${authorization}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    };
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_RESPONSE_BYTES) {
        finishError(Object.assign(new Error('RTSP response too large'), { code: 'RESPONSE_TOO_LARGE' }));
        return;
      }
      try {
        const response = parseRtspResponse(data);
        if (!response) return;
        settled = true;
        cleanup();
        if (!keepAlive) socket.destroy();
        resolve({ ...response, tcpConnected: connected, socket: keepAlive ? socket : undefined });
      } catch (error) {
        finishError(error);
      }
    };
    socket.setTimeout(timeout, () => finishError(Object.assign(new Error('RTSP timeout'), { code: 'ETIMEDOUT' })));
    socket.on('data', onData);
    socket.once('error', finishError);
    if (connected) sendRequest();
    else socket.once('connect', sendRequest);
  });
}

function resolveRtspControl(baseUri, sdp = '') {
  let inVideo = false;
  for (const line of String(sdp).split(/\r?\n/)) {
    if (/^m=/i.test(line)) inVideo = /^m=video\s/i.test(line);
    const match = inVideo && line.match(/^a=control:(.+)$/i);
    if (!match) continue;
    const control = match[1].trim();
    if (/^rtsp:\/\//i.test(control)) return control;
    return `${baseUri.replace(/\/$/, '')}/${control.replace(/^\//, '')}`;
  }
  return null;
}

function inspectH264Payload(payload) {
  if (!payload?.length) return [];
  const type = payload[0] & 0x1f;
  if (type === 24) {
    const types = [];
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const length = payload.readUInt16BE(offset);
      offset += 2;
      if (length < 1 || offset + length > payload.length) break;
      types.push(payload[offset] & 0x1f);
      offset += length;
    }
    return types;
  }
  if (type === 28 && payload.length >= 2) return [payload[1] & 0x1f];
  return [type];
}

function observeInterleavedRtp(socket, { timeout = 5000, channel = 0 } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let packets = 0;
    let bytes = 0;
    let previousSequence = null;
    let sequenceGaps = 0;
    let markerPackets = 0;
    let firstIdrMs = null;
    const timestamps = new Set();
    const nalTypes = {};
    let buffer = Buffer.alloc(0);
    const finish = status => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      const durationMs = Date.now() - startedAt;
      resolve({
        status,
        durationMs,
        packets,
        bytes,
        bitrateKbps: durationMs > 0 ? Number(((bytes * 8) / durationMs).toFixed(1)) : 0,
        sequenceGaps,
        markerPackets,
        distinctTimestamps: timestamps.size,
        nalTypes,
        spsPresent: Boolean(nalTypes['7']),
        ppsPresent: Boolean(nalTypes['8']),
        idrPresent: Boolean(nalTypes['5']),
        firstIdrMs,
        decodableStartObserved: Boolean(nalTypes['5'])
          && Boolean(nalTypes['7']) && Boolean(nalTypes['8']),
      });
    };
    const onError = () => finish('connection-error');
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const marker = buffer.indexOf(0x24);
        if (marker < 0) { buffer = Buffer.alloc(0); return; }
        if (marker > 0) buffer = buffer.subarray(marker);
        if (buffer.length < 4) return;
        const length = buffer.readUInt16BE(2);
        if (buffer.length < 4 + length) return;
        if (buffer[1] === channel && length >= 12) {
          const packet = buffer.subarray(4, 4 + length);
          const csrcBytes = (packet[0] & 0x0f) * 4;
          let payloadOffset = 12 + csrcBytes;
          if ((packet[0] & 0x10) && payloadOffset + 4 <= packet.length) {
            payloadOffset += 4 + (packet.readUInt16BE(payloadOffset + 2) * 4);
          }
          const sequence = packet.readUInt16BE(2);
          if (previousSequence !== null) {
            const expected = (previousSequence + 1) & 0xffff;
            if (sequence !== expected) sequenceGaps += (sequence - expected + 0x10000) & 0xffff;
          }
          previousSequence = sequence;
          timestamps.add(packet.readUInt32BE(4));
          if (packet[1] & 0x80) markerPackets += 1;
          for (const nalType of inspectH264Payload(packet.subarray(Math.min(payloadOffset, packet.length)))) {
            nalTypes[nalType] = (nalTypes[nalType] || 0) + 1;
            if (nalType === 5 && firstIdrMs === null) firstIdrMs = Date.now() - startedAt;
          }
          packets += 1;
          bytes += length;
        }
        buffer = buffer.subarray(4 + length);
      }
    };
    const timer = setTimeout(() => finish(packets > 0 ? 'media-received' : 'no-media'), timeout);
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function probeRtspPlayback({
  socket, host, port, requestUri, requestPath, sdp, challenge, username, password,
  timeout = DEFAULT_TIMEOUT, requester = requestRtsp, observer = observeInterleavedRtp, cseq = 3,
  digestUriMode = 'absolute',
}) {
  const result = {
    readOnly: true,
    transport: 'rtp-over-rtsp-tcp',
    setup: { status: 'unavailable' },
    play: { status: 'not-attempted' },
    media: { status: 'not-observed', packets: 0, bytes: 0 },
  };
  const controlUri = resolveRtspControl(requestUri, sdp);
  if (!socket || !controlUri) {
    result.setup = { status: 'skipped', reason: !socket ? 'connection-not-reusable' : 'video-control-unavailable' };
    return result;
  }
  try {
    const controlPath = new URL(controlUri).pathname;
    const setupAuthUri = digestUriMode === 'path' ? controlPath : controlUri;
    const playAuthUri = digestUriMode === 'path' ? requestPath : requestUri;
    const setupAuthorization = buildAuthorization(challenge, {
      username, password, method: 'SETUP', uri: setupAuthUri,
    });
    const setup = await requester({
      host, port, requestUri: controlUri, authorization: setupAuthorization, timeout,
      socket, keepAlive: true, cseq, method: 'SETUP',
      headers: ['Transport: RTP/AVP/TCP;unicast;interleaved=0-1'],
    });
    socket = setup.socket || socket;
    result.setup = { status: setup.statusCode === 200 ? 'available' : 'rejected', rtspStatus: setup.statusCode };
    const session = String(setup.headers.session || '').split(';')[0].trim();
    if (setup.statusCode !== 200 || !session) return result;

    const playAuthorization = buildAuthorization(challenge, {
      username, password, method: 'PLAY', uri: playAuthUri,
    });
    const play = await requester({
      host, port, requestUri, authorization: playAuthorization, timeout,
      socket, keepAlive: true, cseq: cseq + 1, method: 'PLAY', headers: [`Session: ${session}`],
    });
    socket = play.socket || socket;
    result.play = { status: play.statusCode === 200 ? 'available' : 'rejected', rtspStatus: play.statusCode };
    if (play.statusCode === 200) result.media = await observer(socket, { timeout: Math.min(5000, timeout), channel: 0 });
  } catch (error) {
    result.errorCode = String(error.code || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 64);
  }
  return result;
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
  let sessionSocket;
  let authChallenge = null;
  let digestUriMode = 'absolute';
  let nextCseq = 2;
  try {
    let response = await requester({
      host, port: safeResult.target.port, requestUri, timeout, keepAlive: true, cseq: 1,
    });
    sessionSocket = response.socket;
    safeResult.tcp = { status: response.tcpConnected ? 'connected' : 'unavailable' };
    let authScheme = 'none';
    if (response.statusCode === 401) {
      const challenge = parseAuthenticateHeader(response.headers['www-authenticate']);
      authChallenge = challenge;
      authScheme = challenge?.scheme || 'unsupported';
      const authorization = buildAuthorization(challenge, {
        username, password, method: 'DESCRIBE', uri: requestUri,
      });
      if (authorization) {
        response = await requester({
          host, port: safeResult.target.port, requestUri, authorization, timeout,
          socket: sessionSocket, keepAlive: true, cseq: 2,
        });
        sessionSocket = response.socket || sessionSocket;
        nextCseq = 3;
        // Some Hikvision NVR firmware expects the Digest uri field to contain
        // only the RTSP path, while the DESCRIBE request line remains absolute.
        if (response.statusCode === 401 && challenge?.scheme === 'digest') {
          const pathAuthorization = buildAuthorization(challenge, {
            username, password, method: 'DESCRIBE', uri: requestPath,
          });
          response = await requester({
            host, port: safeResult.target.port, requestUri, authorization: pathAuthorization, timeout,
            socket: sessionSocket, keepAlive: true, cseq: 3,
          });
          sessionSocket = response.socket || sessionSocket;
          nextCseq = 4;
          digestUriMode = 'path';
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
    if (response.statusCode === 200) {
      safeResult.playback = await probeRtspPlayback({
        socket: sessionSocket, host, port: safeResult.target.port, requestUri, requestPath,
        sdp: response.body, challenge: authChallenge, username, password, timeout,
        requester, cseq: nextCseq,
        digestUriMode,
      });
    }
  } catch (error) {
    safeResult.tcp = { status: error.tcpConnected ? 'connected' : 'unavailable' };
    safeResult.describe = {
      status: 'unavailable',
      errorCode: String(error.code || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 64),
    };
  } finally {
    sessionSocket?.destroy?.();
  }
  return safeResult;
}

module.exports = {
  buildAuthorization,
  getRtspDiagnostics,
  inspectH264Payload,
  parseAuthenticateHeader,
  parseRtspResponse,
  probeRtspPlayback,
  resolveRtspControl,
  summarizeSdp,
};
