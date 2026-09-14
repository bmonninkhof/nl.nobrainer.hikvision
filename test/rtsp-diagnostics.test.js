'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAuthorization,
  getRtspDiagnostics,
  parseAuthenticateHeader,
  parseRtspResponse,
  summarizeSdp,
} = require('../lib/rtsp-diagnostics');

test('RTSP response and SDP are summarized without exposing raw data', () => {
  const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\nm=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
  const wire = Buffer.from(`RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`);
  const parsed = parseRtspResponse(wire);
  assert.equal(parsed.statusCode, 200);
  assert.deepEqual(summarizeSdp(parsed.body).codecs, [
    { media: 'video', payload: 96, codec: 'H264' },
    { media: 'audio', payload: 0, codec: 'PCMU' },
  ]);
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
  assert.deepEqual(result.describe.codecs, [{ media: 'video', payload: 96, codec: 'H264' }]);
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
