'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAuthorization,
  getRtspDiagnostics,
  inspectH264Payload,
  parseAuthenticateHeader,
  parseRtspResponse,
  probeRtspPlayback,
  resolveRtspControl,
  summarizeSdp,
} = require('../lib/rtsp-diagnostics');

test('RTSP response and SDP are summarized without exposing raw data', () => {
  const sdp = [
    'v=0',
    'a=control:rtsp://192.168.1.25/Streaming/Channels/102',
    'm=video 0 RTP/AVP 96',
    'b=AS:2048',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1; profile-level-id=42e01f; sprop-parameter-sets=Z0LgHtoCgPaEAAAAwAQAAAMAeR4sXUA==,aM48gA==',
    'a=framesize:96 1280-720',
    'a=framerate:15',
    'a=control:trackID=1',
    'a=recvonly',
    'a=Media_header:MEDIAINFO=redacted;',
    'm=audio 0 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000/1',
    'a=control:trackID=2',
    '',
  ].join('\r\n');
  const wire = Buffer.from(`RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`);
  const parsed = parseRtspResponse(wire);
  assert.equal(parsed.statusCode, 200);
  const summary = summarizeSdp(parsed.body);
  assert.deepEqual(summary.codecs[0], {
    media: 'video', payload: 96, codec: 'H264', clockRate: 90000,
    packetizationMode: 1,
    h264Profile: {
      profileLevelId: '42e01f', profileIdc: 66, profile: 'Baseline',
      constraintFlags: 224, levelIdc: 31, level: 3.1,
    },
    parameterSets: { advertised: true, count: 2, spsPresent: true, ppsPresent: true },
  });
  assert.deepEqual(summary.codecs[1], {
    media: 'audio', payload: 0, codec: 'PCMU', clockRate: 8000, channels: 1,
  });
  assert.deepEqual(summary.mediaSections[0], {
    type: 'video', port: 0, protocol: 'RTP/AVP', payloads: [96], direction: 'recvonly',
    control: { present: true, type: 'relative', trackId: 1 }, frameRate: 15,
    frameSize: { payload: 96, width: 1280, height: 720 }, bandwidth: { AS: 2048 },
  });
  assert.deepEqual(summary.sessionControl, { present: true, type: 'absolute' });
  assert.equal(summary.hikvisionMediaHeaderPresent, true);
  assert.deepEqual(summary.keyframeInterval, { advertised: false, reason: 'not-available-in-sdp' });
  assert.doesNotMatch(JSON.stringify(summary), /192\.168|Z0Lg|aM48|MEDIAINFO/);
});

test('Digest and Basic challenges create an authorization header', () => {
  const digest = parseAuthenticateHeader('Digest realm="cam", nonce="abc", qop="auth"');
  assert.match(buildAuthorization(digest, {
    username: 'user', password: 'secret', method: 'DESCRIBE', uri: 'rtsp://camera/stream',
  }), /^Digest /);
  const basic = parseAuthenticateHeader('Basic realm="camera"');
  assert.equal(buildAuthorization(basic, {
    username: 'user', password: 'secret', method: 'DESCRIBE', uri: 'rtsp://camera/stream',
  }), 'Basic dXNlcjpzZWNyZXQ=');
});

test('diagnostics retry authenticated DESCRIBE and only return safe metadata', async () => {
  const calls = [];
  const requester = async options => {
    calls.push(options);
    if (!options.authorization) {
      return {
        tcpConnected: true,
        statusCode: 401,
        headers: { 'www-authenticate': 'Digest realm="cam", nonce="abc", qop="auth"' },
        body: '',
      };
    }
    return {
      tcpConnected: true,
      statusCode: 200,
      headers: { 'content-type': 'application/sdp' },
      body: 'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n',
    };
  };
  const result = await getRtspDiagnostics({
    host: '192.168.1.25', username: 'admin', password: 'very-secret',
    channelId: 1, streamId: 102, requester,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cseq, 1);
  assert.equal(calls[1].cseq, 2);
  assert.equal(result.describe.status, 'available');
  assert.equal(result.describe.authentication, 'digest');
  assert.deepEqual(result.describe.codecs, [{
    media: 'video', payload: 96, codec: 'H264', clockRate: 90000,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /192\.168|admin|very-secret|rtsp:\/\//);
});

test('diagnostics retry Digest with a path uri for Hikvision NVR compatibility', async () => {
  const calls = [];
  const requester = async options => {
    calls.push(options);
    if (!options.authorization) {
      return {
        tcpConnected: true,
        statusCode: 401,
        headers: { 'www-authenticate': 'Digest realm="cam", nonce="abc", qop="auth"' },
        body: '',
      };
    }
    if (/uri="\/Streaming\/Channels\/102"/.test(options.authorization)) {
      return {
        tcpConnected: true,
        statusCode: 200,
        headers: { 'content-type': 'application/sdp' },
        body: 'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n',
      };
    }
    return { tcpConnected: true, statusCode: 401, headers: {}, body: '' };
  };
  const result = await getRtspDiagnostics({
    host: '192.168.1.25', username: 'admin', password: 'very-secret',
    channelId: 1, streamId: 102, requester,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.cseq), [1, 2, 3]);
  assert.equal(result.describe.status, 'available');
  assert.doesNotMatch(JSON.stringify(result), /192\.168|admin|very-secret|rtsp:\/\//);
});

test('network errors are reduced to a safe error code', async () => {
  const error = Object.assign(new Error('connect failed to 192.168.1.25'), { code: 'ECONNREFUSED' });
  const result = await getRtspDiagnostics({ host: '192.168.1.25', requester: async () => { throw error; } });
  assert.deepEqual(result.describe, { status: 'unavailable', errorCode: 'ECONNREFUSED' });
  assert.doesNotMatch(JSON.stringify(result), /192\.168/);
});

test('video control URI is resolved without exposing it in diagnostics', () => {
  assert.equal(
    resolveRtspControl('rtsp://camera/Streaming/Channels/102', 'm=video 0 RTP/AVP 96\r\na=control:trackID=1\r\n'),
    'rtsp://camera/Streaming/Channels/102/trackID=1',
  );
});

test('playback probe performs SETUP and PLAY and reports observed media safely', async () => {
  const calls = [];
  const socket = { destroyed: false };
  const requester = async options => {
    calls.push(options);
    if (options.method === 'SETUP') {
      return { statusCode: 200, headers: { session: 'safe-session;timeout=60' }, socket };
    }
    return { statusCode: 200, headers: {}, socket };
  };
  const result = await probeRtspPlayback({
    socket, host: '192.168.1.25', port: 554,
    requestUri: 'rtsp://192.168.1.25/Streaming/Channels/102',
    requestPath: '/Streaming/Channels/102',
    sdp: 'm=video 0 RTP/AVP 96\r\na=control:trackID=1\r\n',
    challenge: parseAuthenticateHeader('Digest realm="cam", nonce="abc", qop="auth"'),
    username: 'admin', password: 'very-secret', requester,
    observer: async () => ({ status: 'media-received', packets: 4, bytes: 2048 }),
  });
  assert.deepEqual(calls.map(call => call.method), ['SETUP', 'PLAY']);
  assert.deepEqual(result, {
    readOnly: true,
    transport: 'rtp-over-rtsp-tcp',
    setup: { status: 'available', rtspStatus: 200 },
    play: { status: 'available', rtspStatus: 200 },
    media: { status: 'media-received', packets: 4, bytes: 2048 },
  });
  assert.doesNotMatch(JSON.stringify(result), /192\.168|admin|very-secret|safe-session|rtsp:\/\//);
});

test('H264 RTP payload inspection recognizes single NAL, STAP-A and FU-A', () => {
  assert.deepEqual(inspectH264Payload(Buffer.from([0x67, 0x01])), [7]);
  assert.deepEqual(inspectH264Payload(Buffer.from([0x78, 0x00, 0x02, 0x67, 0x01, 0x00, 0x02, 0x68, 0x01])), [7, 8]);
  assert.deepEqual(inspectH264Payload(Buffer.from([0x7c, 0x85, 0x01])), [5]);
});
