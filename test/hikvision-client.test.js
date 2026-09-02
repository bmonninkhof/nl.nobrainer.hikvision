'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HikvisionClient,
  createSessionPassword,
  extractCookies,
  findValue,
  getIsapiResponseError,
  parseBasicChallenge,
  parseDigestChallenge,
  summarizeAuthenticationChallenge,
} = require('../lib/hikvision-client');

test('parseDigestChallenge leest een Hikvision Digest-challenge', () => {
  assert.deepEqual(
    parseDigestChallenge('Digest realm="IP Camera", nonce="abc123", qop="auth", opaque="xyz"'),
    { realm: 'IP Camera', nonce: 'abc123', qop: 'auth', opaque: 'xyz' },
  );
  assert.equal(parseDigestChallenge('Basic realm="camera"'), null);
});

test('Digest gebruikt niet per ongeluk de Basic-realm uit een gecombineerde Hikvision-challenge', () => {
  const header = 'Digest realm="IP Camera(12345)", nonce="abc123", qop="auth", algorithm="MD5", Basic realm="ISAPI"';
  assert.deepEqual(parseDigestChallenge(header), {
    realm: 'IP Camera(12345)',
    nonce: 'abc123',
    qop: 'auth',
    algorithm: 'MD5',
  });
  assert.deepEqual(parseBasicChallenge(header), { realm: 'ISAPI' });
});

test('client gebruikt Basic alleen wanneer een Hikvision-apparaat uitsluitend Basic aanbiedt', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  let requests = 0;
  client._requestOnce = async () => {
    requests += 1;
    if (requests === 1) {
      return {
        statusCode: 401,
        headers: { 'www-authenticate': 'Basic realm="ISAPI"' },
        body: Buffer.alloc(0),
      };
    }
    assert.equal(
      client._authorization('GET', '/ISAPI/System/deviceInfo'),
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<DeviceInfo><deviceID>ABC</deviceID><deviceType>VIS</deviceType><firmwareVersion>V2.2.77</firmwareVersion></DeviceInfo>'),
    };
  };
  assert.equal((await client.getDeviceInfo()).type, 'VIS');
  assert.equal(requests, 2);
});

test('client valt terug op Basic wanneer gecombineerde Digest-authenticatie wordt geweigerd', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  const modes = [];
  client._requestOnce = async () => {
    modes.push(client.authMode);
    if (modes.length === 1) {
      return {
        statusCode: 401,
        headers: {
          'www-authenticate': 'Digest realm="doorbell", nonce="one", qop="auth", Basic realm="ISAPI"',
        },
        body: Buffer.alloc(0),
      };
    }
    if (modes.length === 2) {
      assert.equal(client.authMode, 'digest');
      return { statusCode: 401, headers: {}, body: Buffer.alloc(0) };
    }
    assert.equal(
      client._authorization('GET', '/ISAPI/System/deviceInfo'),
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<DeviceInfo><deviceID>ABC</deviceID><deviceType>VIS</deviceType></DeviceInfo>'),
    };
  };

  assert.equal((await client.getDeviceInfo()).type, 'VIS');
  assert.deepEqual(modes, [null, 'digest', 'basic']);
});

test('client herhaalt Digest eenmalig met een vernieuwde stale nonce', async () => {
  const client = new HikvisionClient({
    host: 'camera',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  const nonces = [];
  client._requestOnce = async () => {
    nonces.push(client.challenge?.nonce || null);
    if (nonces.length === 1) {
      return {
        statusCode: 401,
        headers: { 'www-authenticate': 'Digest realm="camera", nonce="one", qop="auth"' },
        body: Buffer.alloc(0),
      };
    }
    if (nonces.length === 2) {
      return {
        statusCode: 401,
        headers: { 'www-authenticate': 'Digest realm="camera", nonce="two", qop="auth", stale=true' },
        body: Buffer.alloc(0),
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<DeviceInfo><deviceID>ABC</deviceID><deviceType>IPCamera</deviceType></DeviceInfo>'),
    };
  };

  assert.equal((await client.getDeviceInfo()).type, 'IPCamera');
  assert.deepEqual(nonces, [null, 'one', 'two']);
});

test('geforceerd Basic stuurt de autorisatie direct zonder challenge', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
    authMethod: 'basic',
  });
  let requests = 0;
  client._requestOnce = async () => {
    requests += 1;
    assert.equal(
      client._authorization('GET', '/ISAPI/System/deviceInfo'),
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<DeviceInfo><deviceID>ABC</deviceID><deviceType>VIS</deviceType></DeviceInfo>'),
    };
  };

  assert.equal((await client.getDeviceInfo()).type, 'VIS');
  assert.equal(requests, 1);
  assert.deepEqual(client.getAuthenticationDiagnostics().recentRequests[0].attempts[0], {
    mode: 'basic',
    statusCode: 200,
    challenge: { headerPresent: false, schemes: [], digest: null },
  });
});

test('geforceerd Digest weigert een uitsluitend Basic challenge', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
    authMethod: 'digest',
  });
  let requests = 0;
  client._requestOnce = async () => {
    requests += 1;
    return {
      statusCode: 401,
      headers: { 'www-authenticate': 'Basic realm="private-camera-name"' },
      body: Buffer.alloc(0),
    };
  };

  await assert.rejects(client.getDeviceInfo(), { statusCode: 401 });
  assert.equal(requests, 1);
});

test('authenticatiediagnostiek bevat geen realm, nonce of ruwe header', async () => {
  const summary = summarizeAuthenticationChallenge(
    'Digest realm="private-camera", nonce="private-nonce", qop="auth", algorithm="SHA-256", stale=true, Basic realm="private-basic"',
  );
  assert.deepEqual(summary, {
    headerPresent: true,
    schemes: ['digest', 'basic'],
    digest: { algorithm: 'SHA-256', qop: ['auth'], stale: true },
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /private-camera|private-nonce|private-basic|www-authenticate/i);
});

test('automatische authenticatie begrenst Digest-herhalingen en Basic-fallback', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  let requests = 0;
  client._requestOnce = async () => {
    requests += 1;
    return {
      statusCode: 401,
      headers: {
        'www-authenticate': `Digest realm="camera", nonce="nonce-${requests}", qop="auth", stale=true, Basic realm="ISAPI"`,
      },
      body: Buffer.alloc(0),
    };
  };

  await assert.rejects(client.getDeviceInfo(), { statusCode: 401 });
  assert.equal(requests, 5);
  assert.deepEqual(
    client.getAuthenticationDiagnostics().recentRequests[0].attempts.map(attempt => attempt.mode),
    ['none', 'digest', 'digest', 'basic'],
  );
  assert.equal(client.getAuthenticationDiagnostics().session.result, 'capabilities-failed');
});

test('Hikvision sessionLogin gebruikt de begrensde iteratieve SHA-256-procedure', () => {
  assert.equal(createSessionPassword({
    username: 'admin',
    password: 'secret',
    salt: 'salt',
    challenge: 'challenge',
    iterations: 4,
    irreversible: true,
  }), 'fddb9c798de0f72a5b6e45014abbab8f423c9ce01d3569b0d8d1352cd17f0e29');
  assert.throws(() => createSessionPassword({
    username: 'admin',
    password: 'secret',
    salt: 'salt',
    challenge: 'challenge',
    iterations: 10001,
    irreversible: true,
  }), /iteration count/);
});

test('sessiecookies bewaren uitsluitend cookieparen', () => {
  assert.equal(extractCookies({
    'set-cookie': [
      'WebSession=private-value; Path=/; HttpOnly',
      'language=en; Path=/',
    ],
  }), 'WebSession=private-value; language=en');
});

test('PTZ-preset gebruikt het directe camera-eindpunt', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: 'secret' });
  let request;
  client.request = async (path, options) => {
    request = { path, options };
    return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
  };

  assert.equal(await client.gotoPtzPreset({ channel: 1, preset: 12, isNvr: false }), true);
  assert.equal(request.path, '/ISAPI/PTZCtrl/channels/1/presets/12/goto');
  assert.equal(request.options.method, 'PUT');
});

test('PTZ-preset gebruikt de proxy van een NVR-kanaal', async () => {
  const client = new HikvisionClient({ host: 'nvr', port: 80, username: 'admin', password: 'secret' });
  let path;
  client.request = async requestPath => {
    path = requestPath;
    return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
  };

  await client.gotoPtzPreset({ channel: 4, preset: 3, isNvr: true });
  assert.equal(path, '/ISAPI/ContentMgmt/PTZCtrlProxy/channels/4/presets/3/goto');
});

test('deurrelais gebruikt de Hikvision AccessControl-opdracht', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: 'secret' });
  let request;
  client.request = async (path, options) => {
    request = { path, options };
    return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
  };

  assert.equal(await client.triggerRelay(2), true);
  assert.equal(request.path, '/ISAPI/AccessControl/RemoteControl/door/2');
  assert.equal(request.options.method, 'PUT');
  assert.match(request.options.body, /<cmd>open<\/cmd>/);
});

test('beschikbare deurrelais worden uitsluitend uit de ISAPI-capability afgeleid', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getXml = async path => {
    assert.equal(path, '/ISAPI/AccessControl/RemoteControl/door/capabilities');
    return {
      RemoteControlDoor: {
        doorNo: { $: { min: '1', max: '2' } },
        cmd: { $: { opt: 'open,alwaysOpen,resume' } },
      },
    };
  };

  assert.deepEqual([...await client.getDoorRelays()], [1, 2]);
});

test('deurrelais zijn niet beschikbaar wanneer de capability open niet aanbiedt', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getXml = async () => ({
    RemoteControlDoor: {
      doorNo: { $: { min: '1', max: '2' } },
      cmd: { $: { opt: 'close,resume' } },
    },
  });

  assert.equal((await client.getDoorRelays()).size, 0);
});

test('PTZ-kanalen en opgeslagen presets worden uit ISAPI-lijsten gelezen', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  client.getXml = async path => {
    if (path === '/ISAPI/PTZCtrl/channels') {
      return {
        PTZChannelList: {
          PTZChannel: [
            { id: '1', enabled: 'true', panSupport: 'true', tiltSupport: 'true' },
            { id: '2', enabled: 'false', panSupport: 'true' },
          ],
        },
      };
    }
    assert.equal(path, '/ISAPI/PTZCtrl/channels/1/presets');
    return {
      PTZPresetList: {
        PTZPreset: [
          { id: '3', enabled: 'true', presetName: 'Gate' },
          { id: '4', enabled: 'false', presetName: 'Unused' },
        ],
      },
    };
  };

  assert.deepEqual([...await client.getPtzChannels()], [1]);
  assert.deepEqual([...await client.getPtzPresets({ channel: 1 })], [[3, 'Gate']]);
});

test('automatische authenticatie gebruikt sessionLogin na een 401 zonder challenge', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  const calls = [];
  client._requestOnce = async (path, options = {}) => {
    calls.push(path);
    if (path === '/ISAPI/System/deviceInfo' && calls.length === 1) {
      return { statusCode: 401, headers: {}, body: Buffer.alloc(0) };
    }
    if (path.startsWith('/ISAPI/Security/sessionLogin/capabilities?')) {
      assert.equal(options.skipAuthentication, true);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/xml' },
        body: Buffer.from('<SessionLoginCap><sessionID>session-id</sessionID><challenge>challenge</challenge><iterations>4</iterations><isIrreversible>true</isIrreversible><salt>salt</salt><sessionIDVersion>2</sessionIDVersion></SessionLoginCap>'),
      };
    }
    if (path.startsWith('/ISAPI/Security/sessionLogin?timeStamp=')) {
      assert.equal(options.method, 'POST');
      assert.match(options.body, /<userName>admin<\/userName>/);
      assert.match(options.body, /fddb9c798de0f72a5b6e45014abbab8f423c9ce01d3569b0d8d1352cd17f0e29/);
      assert.doesNotMatch(options.body, />secret</);
      return {
        statusCode: 200,
        headers: { 'set-cookie': ['WebSession=private-cookie; Path=/; HttpOnly'] },
        body: Buffer.from('<SessionLogin><statusValue>200</statusValue><statusString>OK</statusString></SessionLogin>'),
      };
    }
    assert.equal(path, '/ISAPI/System/deviceInfo');
    assert.equal(client.authMode, 'session');
    assert.equal(client.sessionCookie, 'WebSession=private-cookie');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<DeviceInfo><deviceID>ABC</deviceID><deviceType>VIS</deviceType><firmwareVersion>V2.2.77</firmwareVersion></DeviceInfo>'),
    };
  };

  assert.equal((await client.getDeviceInfo()).type, 'VIS');
  assert.deepEqual(calls.map(path => path.split('?')[0]), [
    '/ISAPI/System/deviceInfo',
    '/ISAPI/Security/sessionLogin/capabilities',
    '/ISAPI/Security/sessionLogin',
    '/ISAPI/System/deviceInfo',
  ]);
  const diagnostics = client.getAuthenticationDiagnostics();
  assert.deepEqual(diagnostics.session, {
    attempted: true,
    active: true,
    result: 'success',
    capabilitiesStatus: 200,
    loginStatus: 200,
  });
  assert.deepEqual(diagnostics.recentRequests[0].attempts.map(attempt => attempt.mode), ['none', 'session']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-cookie|secret|session-id/);
});

test('geforceerde authenticatiemethoden starten geen websessie-fallback', async () => {
  for (const authMethod of ['basic', 'digest']) {
    const client = new HikvisionClient({
      host: 'doorbell',
      port: 80,
      username: 'admin',
      password: 'secret',
      authMethod,
    });
    let requests = 0;
    client._requestOnce = async () => {
      requests += 1;
      return { statusCode: 401, headers: {}, body: Buffer.alloc(0) };
    };
    await assert.rejects(client.getDeviceInfo(), { statusCode: 401 });
    assert.equal(requests, 1);
    assert.equal(client.getAuthenticationDiagnostics().session.attempted, false);
  }
});

test('mislukte sessionLogin wordt tijdelijk niet opnieuw geprobeerd', async () => {
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  let capabilityRequests = 0;
  let deviceRequests = 0;
  client._requestOnce = async path => {
    if (path.startsWith('/ISAPI/Security/sessionLogin/capabilities?')) {
      capabilityRequests += 1;
      return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    }
    deviceRequests += 1;
    return { statusCode: 401, headers: {}, body: Buffer.alloc(0) };
  };

  await assert.rejects(client.getDeviceInfo(), { statusCode: 401 });
  await assert.rejects(client.getDeviceInfo(), { statusCode: 401 });
  assert.equal(deviceRequests, 2);
  assert.equal(capabilityRequests, 1);
});

test('Digest ondersteunt SHA-256 en sessie-algoritmen', () => {
  for (const algorithm of ['SHA-256', 'SHA-256-sess', 'MD5-sess']) {
    const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: 'secret' });
    client.challenge = {
      realm: 'camera',
      nonce: 'nonce',
      qop: 'auth',
      algorithm,
    };
    const authorization = client._authorization('GET', '/ISAPI/System/deviceInfo');
    assert.match(authorization, new RegExp(`algorithm=${algorithm.toUpperCase()}`));
    assert.match(authorization, /qop=auth/);
  }
});

test('findValue vindt geneste ISAPI-velden', () => {
  assert.equal(findValue({ DeviceInfo: { firmwareVersion: 'V5.8.0' } }, 'firmwareVersion'), 'V5.8.0');
});

test('Hikvision ResponseStatus met foutcode wordt niet als geldige XML geaccepteerd', async () => {
  assert.deepEqual(getIsapiResponseError({
    ResponseStatus: {
      statusCode: '3',
      statusString: 'Device Error',
      subStatusCode: 'deviceError',
    },
  }), {
    statusCode: 3,
    statusString: 'Device Error',
    subStatusCode: 'deviceError',
  });

  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.request = async () => ({
    headers: { 'content-type': 'application/xml' },
    body: Buffer.from('<ResponseStatus><statusCode>3</statusCode><statusString>Device Error</statusString></ResponseStatus>'),
  });
  await assert.rejects(client.getDeviceInfo(), error => (
    error.code === 'EISAPIRESPONSE'
      && error.isapiStatusCode === 3
      && /Device Error/.test(error.message)
  ));
});

test('deviceInfo zonder identiteitsvelden wordt geweigerd', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getXml = async () => ({ DeviceInfo: {} });
  await assert.rejects(client.getDeviceInfo(), { code: 'EISAPIDEVICEINFO' });
});

test('client voert de Digest-handshake uit en leest deviceInfo', async () => {
  const client = new HikvisionClient({
    host: '127.0.0.1',
    port: 80,
    username: 'admin',
    password: 'secret',
  });
  let requests = 0;
  client._requestOnce = async () => {
    requests += 1;
    if (requests === 1) {
      return {
        statusCode: 401,
        headers: { 'www-authenticate': 'Digest realm="camera", nonce="nonce", qop="auth"' },
        body: Buffer.alloc(0),
      };
    }
    assert.match(client._authorization('GET', '/ISAPI/System/deviceInfo'), /^Digest /);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<?xml version="1.0"?><DeviceInfo><deviceName>Voordeur</deviceName><deviceID>ABC</deviceID><deviceType>IPCamera</deviceType><firmwareVersion>V5.8.0</firmwareVersion></DeviceInfo>'),
    };
  };
  const info = await client.getDeviceInfo();
  assert.deepEqual(info, {
    name: 'Voordeur',
    id: 'ABC',
    type: 'IPCamera',
    firmwareVersion: 'V5.8.0',
  });
  assert.equal(requests, 2);
});

test('deviceInfo gebruikt zonder serienummer een niet-herleidbare lokale id', async () => {
  const client = new HikvisionClient({ host: '192.168.0.25', port: 80, username: 'admin', password: '' });
  client.getXml = async () => ({ DeviceInfo: { deviceName: 'Camera', deviceType: 'IPCamera' } });
  const info = await client.getDeviceInfo();
  assert.match(info.id, /^local-[a-f0-9]{16}$/);
  assert.doesNotMatch(info.id, /192|168|25/);
});

test('snapshot gebruikt een alternatief Hikvision-pad na HTTP 503', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const paths = [];
  client.request = async path => {
    paths.push(path);
    if (path.endsWith('/101/picture')) {
      throw Object.assign(new Error('Service unavailable'), { statusCode: 503 });
    }
    return {
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    };
  };

  assert.deepEqual(await client.getSnapshot(1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.deepEqual(paths, [
    '/ISAPI/Streaming/channels/101/picture',
    '/ISAPI/Streaming/channels/1/picture',
  ]);

  paths.length = 0;
  await client.getSnapshot(1);
  assert.deepEqual(paths, ['/ISAPI/Streaming/channels/1/picture']);
});

test('snapshotfouten gebruiken de ingestelde Homey-taal', async () => {
  const translations = {
    'errors.snapshot_unexpected_format': 'Unexpected snapshot format: __format__.',
  };
  const client = new HikvisionClient({
    host: 'doorbell',
    port: 80,
    username: 'admin',
    password: '',
    translate: (key, tokens) => Object.entries(tokens).reduce(
      (message, [name, value]) => message.replaceAll(`__${name}__`, String(value)),
      translations[key] || key,
    ),
  });
  client.request = async () => ({
    headers: { 'content-type': 'application/xml' },
    body: Buffer.from('<ResponseStatus/>'),
  });

  await assert.rejects(
    client.getSnapshot(1),
    { message: 'Unexpected snapshot format: application/xml.' },
  );
});

test('streamingprofiel kiest de juiste H.265-demuxer', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  client.getXml = async path => {
    assert.equal(path, '/ISAPI/Streaming/channels/101');
    return {
      StreamingChannel: {
        Video: {
          videoCodecType: 'H.265',
          videoResolutionWidth: '2688',
          videoResolutionHeight: '1520',
        },
      },
    };
  };
  assert.deepEqual(await client.getStreamingProfile(1), {
    streamId: 101,
    codec: 'H.265',
    demuxer: 'h265',
    width: 2688,
    height: 1520,
  });
});

test('streamingprofiel kan Hikvision-substream 102 uitlezen', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  client.getXml = async path => {
    assert.equal(path, '/ISAPI/Streaming/channels/102');
    return { StreamingChannel: { Video: { videoCodecType: 'H.264' } } };
  };
  assert.deepEqual(await client.getStreamingProfile(1, 2), {
    streamId: 102,
    codec: 'H.264',
    demuxer: 'h264',
    width: null,
    height: null,
  });
});

test('automatische Live-video kiest eerst de H.264-substream', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const requested = [];
  client.getStreamingProfile = async (channelId, streamIndex) => {
    requested.push([channelId, streamIndex]);
    return { streamId: 102, codec: 'H.264', demuxer: 'h264', width: 640, height: 480 };
  };
  assert.deepEqual(await client.getPreferredStreamingProfile(1), {
    streamId: 102,
    codec: 'H.264',
    demuxer: 'h264',
    width: 640,
    height: 480,
  });
  assert.deepEqual(requested, [[1, 2]]);
});

test('automatische Live-video gebruikt H.264-hoofdstream als substream H.265 is', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const requested = [];
  client.getStreamingProfile = async (channelId, streamIndex) => {
    requested.push([channelId, streamIndex]);
    return streamIndex === 2
      ? { streamId: 102, codec: 'H.265', demuxer: 'h265', width: 640, height: 480 }
      : { streamId: 101, codec: 'H.264', demuxer: 'h264', width: 2560, height: 1440 };
  };
  assert.equal((await client.getPreferredStreamingProfile(1)).streamId, 101);
  assert.deepEqual(requested, [[1, 2], [1, 1]]);
});

test('handmatige Live-streamkeuze vraagt uitsluitend het geselecteerde profiel op', async () => {
  for (const [preference, streamIndex] of [['main', 1], ['substream', 2]]) {
    const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
    const requested = [];
    client.getStreamingProfile = async (channelId, selectedIndex) => {
      requested.push([channelId, selectedIndex]);
      return { streamId: Number(`${channelId}0${selectedIndex}`), codec: 'H.264', demuxer: 'h264' };
    };
    await client.getPreferredStreamingProfile(3, preference);
    assert.deepEqual(requested, [[3, streamIndex]]);
  }
});

test('video-intercomcapaciteiten schakelen oproepstatus alleen expliciet in', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getXml = async path => {
    assert.equal(path, '/ISAPI/VideoIntercom/capabilities');
    return { VideoIntercomCap: { isSupportCallStatus: 'true' } };
  };
  assert.deepEqual(await client.getVideoIntercomCapabilities(), { callStatusSupported: true });

  client.getXml = async () => ({ VideoIntercomCap: { isSupportCallStatus: 'false' } });
  assert.deepEqual(await client.getVideoIntercomCapabilities(), { callStatusSupported: false });
});

test('oproepstatus wordt uit het officiële JSON-antwoord gelezen', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getJson = async path => {
    assert.equal(path, '/ISAPI/VideoIntercom/callStatus?format=json');
    return { CallStatus: { status: 'ring' } };
  };
  assert.equal(await client.getCallStatus(), 'ring');
});

test('oproepstatus wordt rechtstreeks gedetecteerd als het capability-endpoint ontbreekt', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getVideoIntercomCapabilities = async () => {
    throw Object.assign(new Error('Not Found'), { statusCode: 404 });
  };
  client.getCallStatus = async () => 'idle';

  assert.deepEqual(await client.detectCallStatusSupport(), {
    supported: true,
    source: 'direct-probe',
    status: 'idle',
    error: 'Not Found',
    errorCode: 'HTTP_404',
  });
});

test('expliciet ontbrekende oproepstatuscapaciteit wordt met een directe probe geverifieerd', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  client.getVideoIntercomCapabilities = async () => ({ callStatusSupported: false });
  client.getCallStatus = async () => 'ring';

  assert.deepEqual(await client.detectCallStatusSupport(), {
    supported: true,
    source: 'direct-probe',
    status: 'ring',
    error: null,
    errorCode: null,
  });
});

test('alarm-XML mag over meerdere netwerkchunks verdeeld zijn', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const alarms = [];
  client.on('alarm', (...args) => alarms.push(args));
  const start = '<EventNotificationAlert><eventType>VMD</eventType><eventState>active</eventState><channelID>3</channelID><activePostCount>1</activePostCount></EventNotificationAlert>';
  client._consumeAlertData(Buffer.from(start.slice(0, 60)));
  client._consumeAlertData(Buffer.from(start.slice(60)));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(alarms, [['VideoMotion', 'Start', 3]]);

  const stop = '<EventNotificationAlert><eventType>VMD</eventType><eventState>inactive</eventState><channelID>3</channelID><activePostCount>0</activePostCount></EventNotificationAlert>';
  client._consumeAlertData(Buffer.from(stop));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(alarms[1], ['VideoMotion', 'Stop', 3]);
});

test('deurbelknop zonder activePostCount wordt als pulsgebeurtenis verwerkt', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  const alarms = [];
  client.on('alarm', (...args) => alarms.push(args));
  const press = '<EventNotificationAlert><eventType>CallButtonPress</eventType><eventState>active</eventState><channelID>1</channelID></EventNotificationAlert>';

  client._consumeAlertData(Buffer.from(press));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(alarms, [['Doorbell', 'Start', 1]]);
  assert.equal(client.activeEvents.size, 0);
});

test('onbekende firmware-events worden zonder ruwe XML voor diagnose gemeld', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  const events = [];
  client.on('unhandled-event', event => events.push(event));
  await client._handleAlertXml('<EventNotificationAlert><eventType>vendorCallEvent</eventType><eventState>active</eventState><channelID>2</channelID><privateData>secret</privateData></EventNotificationAlert>');
  assert.deepEqual(events, [{ eventType: 'vendorCallEvent', eventState: 'active', channel: 2 }]);
  client.stop();
});

test('gewone actieve gebeurtenis zonder activePostCount wordt niet als heartbeat gewist', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const alarms = [];
  client.on('alarm', (...args) => alarms.push(args));
  const event = '<EventNotificationAlert><eventType>linedetection</eventType><eventState>active</eventState><channelID>2</channelID></EventNotificationAlert>';

  await client._handleAlertXml(event);

  assert.deepEqual(alarms, [['LineDetection', 'Start', 2]]);
});

test('regionEntrance wordt als Region Entrance Detection verwerkt', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const alarms = [];
  client.on('alarm', (...args) => alarms.push(args));

  await client._handleAlertXml('<EventNotificationAlert><eventType>regionEntrance</eventType><eventState>active</eventState><channelID>3</channelID><activePostCount>1</activePostCount></EventNotificationAlert>');
  await client._handleAlertXml('<EventNotificationAlert><eventType>regionEntrance</eventType><eventState>inactive</eventState><channelID>3</channelID><activePostCount>0</activePostCount></EventNotificationAlert>');

  assert.deepEqual(alarms, [
    ['RegionEntranceDetection', 'Start', 3],
    ['RegionEntranceDetection', 'Stop', 3],
  ]);
});

test('regionExiting wordt als Region Exiting Detection verwerkt', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const alarms = [];
  client.on('alarm', (...args) => alarms.push(args));

  await client._handleAlertXml('<EventNotificationAlert><eventType>regionExiting</eventType><eventState>active</eventState><channelID>4</channelID><activePostCount>1</activePostCount></EventNotificationAlert>');
  await client._handleAlertXml('<EventNotificationAlert><eventType>regionExiting</eventType><eventState>inactive</eventState><channelID>4</channelID><activePostCount>0</activePostCount></EventNotificationAlert>');

  assert.deepEqual(alarms, [
    ['RegionExitingDetection', 'Start', 4],
    ['RegionExitingDetection', 'Stop', 4],
  ]);
});

test('NVR-gebeurtenis zonder stopmelding wordt automatisch beëindigd', async () => {
  const client = new HikvisionClient({
    host: 'nvr',
    port: 80,
    username: 'admin',
    password: '',
    eventIdleTimeout: 15,
  });
  const alarms = [];
  client.on('alarm', (...args) => alarms.push(args));
  const event = '<EventNotificationAlert><eventType>VMD</eventType><eventState>active</eventState><channelID>4</channelID><activePostCount>1</activePostCount></EventNotificationAlert>';

  await client._handleAlertXml(event);
  await new Promise(resolve => setTimeout(resolve, 5));
  await client._handleAlertXml(event);
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.deepEqual(alarms, [
    ['VideoMotion', 'Start', 4],
    ['VideoMotion', 'Stop', 4],
  ]);
  assert.equal(client.activeEvents.size, 0);
});

test('een NVR met uitsluitend offline kanalen levert geen camerabeelden op', async () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  client.getXml = async path => {
    if (path.endsWith('/status')) {
      return {
        InputProxyChannelStatusList: {
          InputProxyChannelStatus: [
            { id: '1', online: 'false' },
            { id: '2', online: 'false' },
          ],
        },
      };
    }
    return {
      InputProxyChannelList: {
        InputProxyChannel: [
          { id: '1', name: 'Voordeur' },
          { id: '2', name: 'Tuin' },
        ],
      },
    };
  };
  assert.deepEqual([...await client.getChannels()], []);
});

test('een alarmstreamfout verbreekt de gewone cameraverbinding niet', () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  const events = [];
  client.on('alarm-error', error => events.push(['alarm-error', error.statusCode]));
  client.on('disconnect', () => events.push(['disconnect']));
  client.alertStreamEnabled = true;
  client._handleStreamError(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
  client.stop();
  assert.deepEqual(events, [['alarm-error', 403]]);
});

test('alarmstream start niet dubbel en kan afzonderlijk worden gepauzeerd', () => {
  const client = new HikvisionClient({ host: 'camera', port: 80, username: 'admin', password: '' });
  let opens = 0;
  client._openAlertStream = async () => { opens += 1; };

  assert.equal(client.startAlertStream(), true);
  client.alertStreamOpening = true;
  assert.equal(client.startAlertStream(), false);
  assert.equal(opens, 1);

  client.stopAlertStream();
  assert.equal(client.alertStreamEnabled, false);
  assert.equal(client.clientStopped, false);
  client.stop();
  assert.equal(client.clientStopped, true);
});

test('intercomoproep wordt alleen beëindigd als hangUp als capability is gemeld', async () => {
  const client = new HikvisionClient({ host: 'doorbell', port: 80, username: 'admin', password: '' });
  let request;
  client.getJson = async () => ({ CallSignal: { cmdType: { '@opt': ['request', 'hangUp'] } } });
  client.request = async (path, options) => {
    request = { path, options };
    return { body: Buffer.from('{"ResponseStatus":{"statusCode":1,"statusString":"OK"}}') };
  };

  assert.deepEqual(await client.getCallSignalCapabilities(), { commands: ['request', 'hangUp'] });
  assert.equal(await client.hangUpIntercomCall(), true);
  assert.equal(request.path, '/ISAPI/VideoIntercom/callSignal?format=json');
  assert.equal(request.options.method, 'PUT');
  assert.deepEqual(JSON.parse(request.options.body), { CallSignal: { cmdType: 'hangUp' } });

  client.getJson = async () => ({ CallSignal: { cmdType: { '@opt': ['request', 'reject'] } } });
  await assert.rejects(client.hangUpIntercomCall(), error => error.code === 'ECALLCONTROLUNSUPPORTED');
});
