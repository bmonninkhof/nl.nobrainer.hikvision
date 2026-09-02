'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { parseStringPromise } = require('xml2js');
const { normalizeAuthMethod } = require('./settings');

const ALERT_CLOSE_TAG = '</EventNotificationAlert>';
const DEFAULT_STREAM_IDLE_TIMEOUT = 90000;
const DEFAULT_EVENT_IDLE_TIMEOUT = 10000;
const MAX_SNAPSHOT_SIZE = 5 * 1024 * 1024;
const MAX_AUTH_DIAGNOSTICS = 12;
const MAX_SESSION_ITERATIONS = 10000;
const SESSION_RETRY_DELAY = 60000;
const ALERT_RECONNECT_BASE_DELAY = 30000;
const ALERT_RECONNECT_MAX_DELAY = 5 * 60 * 1000;
const EVENT_NAMES = {
  io: 'AlarmLocal',
  vmd: 'VideoMotion',
  linedetection: 'LineDetection',
  fielddetection: 'IntrusionDetection',
  regionentrance: 'RegionEntranceDetection',
  regionexiting: 'RegionExitingDetection',
  videoloss: 'VideoLoss',
  shelteralarm: 'VideoBlind',
  callbuttonpress: 'Doorbell',
};
const MOMENTARY_EVENTS = new Set(['Doorbell']);

function digestHash(algorithm, value) {
  const normalized = String(algorithm || 'MD5').toUpperCase();
  const hashName = normalized.startsWith('SHA-256') ? 'sha256' : 'md5';
  return crypto.createHash(hashName).update(value).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function getXmlAttribute(value, name) {
  if (!value || typeof value !== 'object') return undefined;
  return value.$?.[name];
}

function createSessionPassword({ username, password, salt, challenge, iterations, irreversible }) {
  const count = Number(iterations);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SESSION_ITERATIONS) {
    throw new Error('Invalid Hikvision session iteration count');
  }

  let hash;
  if (irreversible) {
    if (!salt) throw new Error('Hikvision session login did not provide a salt');
    hash = sha256(`${username}${salt}${password}`);
    hash = sha256(`${hash}${challenge}`);
    for (let index = 2; index < count; index += 1) hash = sha256(hash);
  } else {
    hash = `${sha256(password)}${challenge}`;
    for (let index = 1; index < count; index += 1) hash = sha256(hash);
  }
  return hash;
}

function extractCookies(headers = {}) {
  const setCookie = headers['set-cookie'];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean);
  return values
    .map(value => String(value).split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookies(...cookieHeaders) {
  const cookies = new Map();
  for (const header of cookieHeaders.filter(Boolean)) {
    for (const pair of String(header).split(';')) {
      const value = pair.trim();
      const separator = value.indexOf('=');
      if (separator > 0) cookies.set(value.slice(0, separator), value.slice(separator + 1));
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function getDiagnosticErrorCode(error) {
  const statusCode = Number(error?.statusCode);
  if (Number.isInteger(statusCode) && statusCode > 0) return `HTTP_${statusCode}`;
  const code = String(error?.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return code || 'UNAVAILABLE';
}

function parseDigestChallenge(header = '') {
  const headerValue = Array.isArray(header) ? header.join(', ') : String(header || '');
  const match = headerValue.match(
    /(?:^|,\s*)Digest\s+([\s\S]*?)(?=,\s*(?:Basic|Bearer|Negotiate|NTLM)\b|$)/i,
  );
  if (!match) return null;

  const values = {};
  const input = match[1];
  const expression = /([a-z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/gi;
  let parameter;
  while ((parameter = expression.exec(input)) !== null) {
    const key = parameter[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = parameter[2] ?? parameter[3];
    }
  }
  return values.realm && values.nonce ? values : null;
}

function parseBasicChallenge(header = '') {
  const headerValue = Array.isArray(header) ? header.join(', ') : String(header || '');
  const match = headerValue.match(/(?:^|,\s*)Basic\s+realm=(?:"([^"]*)"|([^,\s]+))/i);
  return match ? { realm: match[1] ?? match[2] } : null;
}

function summarizeAuthenticationChallenge(header = '') {
  const headerValue = Array.isArray(header) ? header.join(', ') : String(header || '');
  const digest = parseDigestChallenge(headerValue);
  const basic = parseBasicChallenge(headerValue);
  return {
    headerPresent: headerValue.trim().length > 0,
    schemes: [digest && 'digest', basic && 'basic'].filter(Boolean),
    digest: digest ? {
      algorithm: String(digest.algorithm || 'MD5').toUpperCase(),
      qop: String(digest.qop || '').split(',').map(value => value.trim()).filter(Boolean),
      stale: String(digest.stale || '').toLowerCase() === 'true',
    } : null,
  };
}

function findValue(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  for (const value of Object.values(object)) {
    const result = findValue(value, key);
    if (result !== undefined) return result;
  }
  return undefined;
}

function getIsapiResponseError(xml) {
  if (!xml || typeof xml !== 'object') return null;
  const responseEntry = Object.entries(xml).find(([key]) => (
    String(key).split(':').pop().toLowerCase() === 'responsestatus'
  ));
  if (!responseEntry) return null;
  const statusCode = Number(findValue(responseEntry[1], 'statusCode'));
  if (!Number.isFinite(statusCode) || statusCode === 1) return null;
  return {
    statusCode,
    statusString: String(findValue(responseEntry[1], 'statusString') || 'Device Error'),
    subStatusCode: String(findValue(responseEntry[1], 'subStatusCode') || ''),
  };
}

class HikvisionClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = { timeout: 10000, eventIdleTimeout: DEFAULT_EVENT_IDLE_TIMEOUT, ...options };
    this.authPreference = normalizeAuthMethod(options.authMethod);
    this.challenge = null;
    this.authMode = this.authPreference === 'basic' ? 'basic' : null;
    this.basicAvailable = this.authPreference === 'basic';
    this.authenticationDiagnostics = [];
    this.sessionCookie = null;
    this.sessionLoginPromise = null;
    this.sessionRetryAfter = 0;
    this.sessionDiagnostics = {
      attempted: false,
      active: false,
      result: 'not-attempted',
      capabilitiesStatus: null,
      loginStatus: null,
    };
    this.nonceCount = 0;
    this.clientStopped = false;
    this.alertStreamEnabled = false;
    this.alertStreamOpening = false;
    this.alertReconnectAttempt = 0;
    this.alertRequest = null;
    this.reconnectTimer = null;
    this.alertBuffer = '';
    this.activeEvents = new Map();
    this.activeRequests = new Set();
    this.snapshotPaths = new Map();
  }

  get baseUrl() {
    const protocol = this.options.ssl ? 'https' : 'http';
    return `${protocol}://${this.options.host}:${this.options.port}`;
  }

  _message(key, tokens = {}, fallback = key) {
    if (typeof this.options.translate === 'function') {
      const translated = this.options.translate(key, tokens);
      if (translated && translated !== key) return translated;
    }
    return Object.entries(tokens).reduce(
      (message, [name, value]) => message.replaceAll(`__${name}__`, String(value)),
      fallback,
    );
  }

  _authorization(method, path) {
    if (this.authMode === 'session') return null;
    if (this.authMode === 'basic') {
      const credentials = Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64');
      return `Basic ${credentials}`;
    }
    if (!this.challenge) return null;
    const { username, password } = this.options;
    const challenge = this.challenge;
    const qop = (challenge.qop || '').split(',').map(value => value.trim()).includes('auth')
      ? 'auth'
      : null;
    const algorithm = String(challenge.algorithm || 'MD5').toUpperCase();
    if (!['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm)) {
      throw new Error(this._message(
        'errors.unsupported_digest',
        { algorithm },
        'Unsupported Digest algorithm: __algorithm__',
      ));
    }
    const nc = String(++this.nonceCount).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const baseHa1 = digestHash(algorithm, `${username}:${challenge.realm}:${password}`);
    const ha1 = algorithm.endsWith('-SESS')
      ? digestHash(algorithm, `${baseHa1}:${challenge.nonce}:${cnonce}`)
      : baseHa1;
    const ha2 = digestHash(algorithm, `${method}:${path}`);
    const response = qop
      ? digestHash(algorithm, `${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : digestHash(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);
    const fields = [
      `username="${username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${path}"`,
      `response="${response}"`,
      `algorithm=${algorithm}`,
    ];
    if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
    if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    return `Digest ${fields.join(', ')}`;
  }

  _applyAuthenticationChallenge(header) {
    const digest = parseDigestChallenge(header);
    const basic = parseBasicChallenge(header);
    if (basic) this.basicAvailable = true;
    if (this.authPreference === 'basic') {
      this.authMode = 'basic';
      this.challenge = null;
      this.nonceCount = 0;
      return true;
    }
    if (digest) {
      this.authMode = 'digest';
      this.challenge = digest;
      this.nonceCount = 0;
      return true;
    }
    if (basic && this.authPreference !== 'digest') {
      this.authMode = 'basic';
      this.challenge = null;
      this.nonceCount = 0;
      return true;
    }
    return false;
  }

  _recordAuthenticationTrace(trace) {
    this.authenticationDiagnostics.push(trace);
    this.authenticationDiagnostics = this.authenticationDiagnostics.slice(-MAX_AUTH_DIAGNOSTICS);
  }

  getAuthenticationDiagnostics() {
    return {
      preference: this.authPreference,
      activeMode: this.authMode || 'none',
      session: { ...this.sessionDiagnostics },
      recentRequests: this.authenticationDiagnostics.map(trace => ({
        ...trace,
        attempts: trace.attempts.map(attempt => ({
          ...attempt,
          challenge: {
            ...attempt.challenge,
            schemes: [...attempt.challenge.schemes],
            digest: attempt.challenge.digest ? {
              ...attempt.challenge.digest,
              qop: [...attempt.challenge.digest.qop],
            } : null,
          },
        })),
      })),
    };
  }

  _requestOnce(path, options = {}) {
    const method = options.method || 'GET';
    const body = options.body || null;
    const transport = this.options.ssl ? https : http;
    const headers = { Accept: '*/*', ...(options.headers || {}) };
    const authorization = options.skipAuthentication ? null : this._authorization(method, path);
    if (authorization) headers.Authorization = authorization;
    if (!options.skipSession && this.sessionCookie) headers.Cookie = this.sessionCookie;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    return new Promise((resolve, reject) => {
      const request = transport.request({
        hostname: this.options.host,
        port: this.options.port,
        path,
        method,
        headers,
        rejectUnauthorized: this.options.strict !== false,
        timeout: options.timeout || this.options.timeout,
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          this.activeRequests.delete(request);
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      });
      this.activeRequests.add(request);
      request.on('timeout', () => request.destroy(new Error(this._message(
        'errors.connection_timeout', {}, 'Connection timed out',
      ))));
      request.on('error', error => {
        this.activeRequests.delete(request);
        reject(error);
      });
      if (body) request.write(body);
      request.end();
    });
  }

  async _establishSession() {
    this.sessionDiagnostics = {
      attempted: true,
      active: false,
      result: 'failed',
      capabilitiesStatus: null,
      loginStatus: null,
    };
    this.sessionCookie = null;

    const random = crypto.randomInt(10000000, 99999999);
    const capabilityPath = `/ISAPI/Security/sessionLogin/capabilities?username=${encodeURIComponent(this.options.username)}&random=${random}`;
    const capabilityResponse = await this._requestOnce(capabilityPath, {
      skipAuthentication: true,
      skipSession: true,
      headers: {
        Accept: 'application/xml',
        'Cache-Control': 'no-cache',
        'If-Modified-Since': '0',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    this.sessionDiagnostics.capabilitiesStatus = Number(capabilityResponse.statusCode) || 0;
    if (capabilityResponse.statusCode !== 200) {
      this.sessionDiagnostics.result = capabilityResponse.statusCode === 404 ? 'unsupported' : 'capabilities-failed';
      return false;
    }

    let capabilities;
    try {
      capabilities = await parseStringPromise(capabilityResponse.body.toString('utf8'), { explicitArray: false });
    } catch {
      this.sessionDiagnostics.result = 'invalid-capabilities';
      return false;
    }
    const sessionId = String(findValue(capabilities, 'sessionID') || '');
    const challenge = String(findValue(capabilities, 'challenge') || '');
    const salt = String(findValue(capabilities, 'salt') || '');
    const iterations = Number(findValue(capabilities, 'iterations'));
    const irreversible = String(findValue(capabilities, 'isIrreversible') || '').toLowerCase() === 'true';
    const sessionIdVersion = Number(findValue(capabilities, 'sessionIDVersion')) || 2;
    if (!sessionId || !challenge) {
      this.sessionDiagnostics.result = 'incomplete-capabilities';
      return false;
    }

    let sessionPassword;
    try {
      sessionPassword = createSessionPassword({
        username: this.options.username,
        password: this.options.password,
        salt,
        challenge,
        iterations,
        irreversible,
      });
    } catch {
      this.sessionDiagnostics.result = 'unsupported-capabilities';
      return false;
    }
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<SessionLogin>'
      + `<userName>${escapeXml(this.options.username)}</userName>`
      + `<password>${sessionPassword}</password>`
      + `<sessionID>${escapeXml(sessionId)}</sessionID>`
      + '<isNeedSessionTag>false</isNeedSessionTag>'
      + '<isSessionIDValidLongTerm>false</isSessionIDValidLongTerm>'
      + `<sessionIDVersion>${sessionIdVersion}</sessionIDVersion>`
      + '</SessionLogin>';
    const capabilityCookies = extractCookies(capabilityResponse.headers);
    const loginResponse = await this._requestOnce(`/ISAPI/Security/sessionLogin?timeStamp=${Math.floor(Date.now() / 1000)}`, {
      method: 'POST',
      body,
      skipAuthentication: true,
      skipSession: true,
      headers: {
        Accept: 'application/xml',
        'Content-Type': 'application/xml',
        'If-Modified-Since': '0',
        'X-Requested-With': 'XMLHttpRequest',
        ...(capabilityCookies ? { Cookie: capabilityCookies } : {}),
      },
    });
    this.sessionDiagnostics.loginStatus = Number(loginResponse.statusCode) || 0;
    const cookie = mergeCookies(capabilityCookies, extractCookies(loginResponse.headers));
    const loginBody = loginResponse.body.toString('utf8');
    const successfulBody = /<statusValue>\s*200\s*<\/statusValue>/i.test(loginBody)
      || /<statusCode>\s*1\s*<\/statusCode>/i.test(loginBody);
    if (loginResponse.statusCode !== 200 || !successfulBody || !cookie) {
      this.sessionDiagnostics.result = loginResponse.statusCode === 401 ? 'credentials-rejected' : 'login-failed';
      return false;
    }

    this.sessionCookie = cookie;
    this.challenge = null;
    this.nonceCount = 0;
    this.authMode = 'session';
    this.sessionDiagnostics.active = true;
    this.sessionDiagnostics.result = 'success';
    return true;
  }

  async _ensureSession() {
    if (this.sessionCookie && this.authMode === 'session') return true;
    if (Date.now() < this.sessionRetryAfter) return false;
    if (!this.sessionLoginPromise) {
      this.sessionLoginPromise = this._establishSession()
        .catch(() => {
          this.sessionCookie = null;
          this.sessionDiagnostics.active = false;
          this.sessionDiagnostics.result = 'connection-failed';
          return false;
        })
        .then(success => {
          this.sessionRetryAfter = success ? 0 : Date.now() + SESSION_RETRY_DELAY;
          return success;
        })
        .finally(() => {
          this.sessionLoginPromise = null;
        });
    }
    return this.sessionLoginPromise;
  }

  async request(path, options = {}) {
    const method = options.method || 'GET';
    const trace = {
      endpoint: path,
      method,
      preference: this.authPreference,
      attempts: [],
    };
    const recordResponse = response => {
      const challenge = summarizeAuthenticationChallenge(response.headers?.['www-authenticate']);
      if (challenge.schemes.includes('basic')) this.basicAvailable = true;
      trace.attempts.push({
        mode: this.authMode || 'none',
        statusCode: Number(response.statusCode) || 0,
        challenge,
      });
    };

    let response = await this._requestOnce(path, options);
    recordResponse(response);
    let digestAttempts = this.authMode === 'digest' ? 1 : 0;
    let basicAttempts = this.authMode === 'basic' ? 1 : 0;
    let basicOffered = this.basicAvailable;

    while (response.statusCode === 401 && digestAttempts + basicAttempts < 3) {
      const header = response.headers?.['www-authenticate'];
      const digest = parseDigestChallenge(header);
      basicOffered = basicOffered || Boolean(parseBasicChallenge(header));
      const staleDigest = digest
        && String(digest.stale || '').toLowerCase() === 'true';
      const renewedDigest = digest
        && this.challenge
        && digest.nonce !== this.challenge.nonce;

      if (this.authPreference !== 'basic' && digest && (digestAttempts === 0
        || (digestAttempts < 2 && (staleDigest || renewedDigest)))) {
        this.authMode = 'digest';
        this.challenge = digest;
        this.nonceCount = 0;
        digestAttempts += 1;
        response = await this._requestOnce(path, options);
        recordResponse(response);
        continue;
      }

      // Some Hikvision firmwares advertise both schemes but reject Digest for
      // ISAPI. Remember the original Basic offer because the second 401 may
      // omit WWW-Authenticate entirely.
      if (this.authPreference !== 'digest' && basicOffered && basicAttempts === 0) {
        this.authMode = 'basic';
        this.challenge = null;
        this.nonceCount = 0;
        basicAttempts += 1;
        response = await this._requestOnce(path, options);
        recordResponse(response);
        continue;
      }

      break;
    }

    if (response.statusCode === 401 && this.authPreference === 'automatic') {
      const wasSession = this.authMode === 'session';
      if (wasSession) {
        this.sessionCookie = null;
        this.authMode = null;
        this.sessionDiagnostics.active = false;
      }
      if (await this._ensureSession()) {
        response = await this._requestOnce(path, options);
        recordResponse(response);
      }
    }
    this._recordAuthenticationTrace(trace);
    if (response.statusCode === 401) {
      const error = new Error(this._message(
        'errors.invalid_credentials', {}, 'Invalid username or password',
      ));
      error.statusCode = 401;
      throw error;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = new Error(this._message(
        'errors.isapi_http',
        { status: response.statusCode },
        'Hikvision ISAPI responded with HTTP __status__',
      ));
      error.statusCode = response.statusCode;
      throw error;
    }
    return response;
  }

  async getXml(path) {
    const response = await this.request(path, {
      headers: { Accept: 'application/xml' },
    });
    const xml = await parseStringPromise(response.body.toString('utf8'), { explicitArray: false });
    const responseError = getIsapiResponseError(xml);
    if (responseError) {
      const error = new Error(this._message(
        'errors.isapi_response_status',
        { status: responseError.statusCode, description: responseError.statusString },
        'Hikvision ISAPI returned status __status__: __description__',
      ));
      error.code = 'EISAPIRESPONSE';
      error.isapiStatusCode = responseError.statusCode;
      error.isapiSubStatusCode = responseError.subStatusCode;
      throw error;
    }
    return xml;
  }

  async getJson(path) {
    const response = await this.request(path, {
      headers: { Accept: 'application/json' },
    });
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Error(this._message(
        'errors.invalid_json', {}, 'Hikvision ISAPI returned invalid JSON',
      ));
    }
  }

  async getVideoIntercomCapabilities() {
    const xml = await this.getXml('/ISAPI/VideoIntercom/capabilities');
    const value = String(findValue(xml, 'isSupportCallStatus') || '').trim().toLowerCase();
    return {
      callStatusSupported: ['true', '1', 'yes'].includes(value),
    };
  }

  async getCallStatus() {
    const json = await this.getJson('/ISAPI/VideoIntercom/callStatus?format=json');
    const status = String(findValue(json, 'status') || '').trim();
    if (!status) {
      throw new Error(this._message(
        'errors.call_status_missing', {}, 'The Hikvision call-status response has no status',
      ));
    }
    return status;
  }

  async getCallSignalCapabilities() {
    const json = await this.getJson('/ISAPI/VideoIntercom/callSignal/capabilities?format=json');
    const commandDefinition = findValue(json, 'cmdType');
    const optionValue = commandDefinition && typeof commandDefinition === 'object'
      ? (commandDefinition['@opt'] ?? commandDefinition.opt)
      : commandDefinition;
    const commands = (Array.isArray(optionValue) ? optionValue : String(optionValue || '').split(','))
      .map(value => String(value).trim())
      .filter(Boolean);
    return { commands };
  }

  async hangUpIntercomCall({ capabilitiesChecked = false } = {}) {
    let command = 'hangUp';
    if (!capabilitiesChecked) {
      const capabilities = await this.getCallSignalCapabilities();
      command = capabilities.commands.find(value => value.toLowerCase() === 'hangup');
    }
    if (!command) {
      const error = new Error(this._message(
        'errors.call_control_not_supported', {}, 'Ending an intercom call is not supported by this device',
      ));
      error.code = 'ECALLCONTROLUNSUPPORTED';
      throw error;
    }

    const path = '/ISAPI/VideoIntercom/callSignal?format=json';
    const response = await this.request(path, {
      method: 'PUT',
      body: JSON.stringify({ CallSignal: { cmdType: command } }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const body = response.body.toString('utf8').trim();
    if (body) {
      try {
        const responseJson = JSON.parse(body);
        const responseError = getIsapiResponseError(responseJson);
        if (responseError) {
          const error = new Error(this._message(
            'errors.isapi_response_status',
            { status: responseError.statusCode, description: responseError.statusString },
            'Hikvision ISAPI returned status __status__: __description__',
          ));
          error.code = 'EISAPIRESPONSE';
          error.isapiStatusCode = responseError.statusCode;
          error.isapiSubStatusCode = responseError.subStatusCode;
          throw error;
        }
      } catch (error) {
        if (error.code === 'EISAPIRESPONSE') throw error;
        if (this.options.log) this.options.log(`Hikvision callSignal returned non-JSON content: ${error.message}`);
      }
    }
    return true;
  }

  async detectCallStatusSupport() {
    let capabilityError = null;
    try {
      const capabilities = await this.getVideoIntercomCapabilities();
      if (capabilities.callStatusSupported) {
        return {
          supported: true,
          source: 'capabilities',
          status: null,
          error: null,
          errorCode: null,
        };
      }
    } catch (error) {
      capabilityError = error;
    }

    try {
      const status = String(await this.getCallStatus()).trim().toLowerCase();
      return {
        supported: true,
        source: 'direct-probe',
        status,
        error: capabilityError ? capabilityError.message : null,
        errorCode: capabilityError ? getDiagnosticErrorCode(capabilityError) : null,
      };
    } catch (error) {
      return {
        supported: false,
        source: 'unavailable',
        status: null,
        error: error.message || capabilityError?.message || null,
        errorCode: getDiagnosticErrorCode(error || capabilityError),
      };
    }
  }

  async getDeviceInfo() {
    const xml = await this.getXml('/ISAPI/System/deviceInfo');
    const hardwareId = findValue(xml, 'deviceID') || findValue(xml, 'serialNumber');
    const deviceType = findValue(xml, 'deviceType');
    const firmwareVersion = findValue(xml, 'firmwareVersion');
    if (!hardwareId && !deviceType && !firmwareVersion) {
      const error = new Error(this._message(
        'errors.isapi_device_info_missing', {}, 'Hikvision ISAPI returned no device information',
      ));
      error.code = 'EISAPIDEVICEINFO';
      throw error;
    }
    const localId = `local-${crypto.createHash('sha256').update(String(this.options.host)).digest('hex').slice(0, 16)}`;
    return {
      name: String(findValue(xml, 'deviceName') || 'Hikvision'),
      id: String(hardwareId || localId),
      type: String(deviceType || 'Unknown'),
      firmwareVersion: String(firmwareVersion || 'Unknown'),
    };
  }

  async getChannels() {
    const channels = new Map();
    let channelsDiscovered = false;
    try {
      const xml = await this.getXml('/ISAPI/ContentMgmt/InputProxy/channels');
      const list = findValue(xml, 'InputProxyChannel');
      for (const channel of Array.isArray(list) ? list : [list].filter(Boolean)) {
        const id = Number(findValue(channel, 'id'));
        if (Number.isFinite(id)) channels.set(id, String(findValue(channel, 'name') || `Camera ${id}`));
      }
      channelsDiscovered = channels.size > 0;
    } catch (error) {
      if (this.options.log) this.options.log(`Kan NVR-kanalen niet ophalen: ${error.message}`);
    }
    if (channels.size === 0) channels.set(1, 'Camera');
    if (!channelsDiscovered) return channels;

    try {
      const xml = await this.getXml('/ISAPI/ContentMgmt/InputProxy/channels/status');
      const list = findValue(xml, 'InputProxyChannelStatus');
      const online = new Set((Array.isArray(list) ? list : [list].filter(Boolean))
        .filter(channel => String(findValue(channel, 'online')) === 'true')
        .map(channel => Number(findValue(channel, 'id'))));
      for (const id of [...channels.keys()]) if (!online.has(id)) channels.delete(id);
    } catch (error) {
      if (this.options.log) this.options.log(`Kan kanaalstatus niet ophalen: ${error.message}`);
    }
    return channels;
  }

  async getPtzChannels({ channelIds = [1], isNvr = false } = {}) {
    const channels = new Set();
    if (!isNvr) {
      try {
        const xml = await this.getXml('/ISAPI/PTZCtrl/channels');
        const list = findValue(xml, 'PTZChannel');
        for (const channel of Array.isArray(list) ? list : [list].filter(Boolean)) {
          const id = Number(findValue(channel, 'id'));
          const enabled = String(findValue(channel, 'enabled') ?? 'true').toLowerCase() !== 'false';
          const supportValues = ['panSupport', 'tiltSupport', 'zoomSupport']
            .map(name => findValue(channel, name));
          const supportsMovement = supportValues.every(value => value === undefined)
            || supportValues.some(value => String(value).toLowerCase() === 'true');
          if (Number.isInteger(id) && enabled && supportsMovement) channels.add(id);
        }
      } catch (error) {
        if (this.options.log) this.options.log(`Kan PTZ-kanalen niet ophalen: ${error.message}`);
      }
      return channels;
    }

    for (const channelId of channelIds) {
      try {
        await this.getXml(`/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${channelId}/capabilities`);
        channels.add(Number(channelId));
      } catch (error) {
        try {
          await this.getXml(`/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${channelId}/presets`);
          channels.add(Number(channelId));
        } catch {
          if (this.options.log) this.options.log(`PTZ is niet beschikbaar voor NVR-kanaal ${channelId}: ${error.message}`);
        }
      }
    }
    return channels;
  }

  async getPtzPresets({ channel, isNvr = false }) {
    const path = isNvr
      ? `/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${channel}/presets`
      : `/ISAPI/PTZCtrl/channels/${channel}/presets`;
    const xml = await this.getXml(path);
    const list = findValue(xml, 'PTZPreset');
    const presets = new Map();
    for (const preset of Array.isArray(list) ? list : [list].filter(Boolean)) {
      const id = Number(findValue(preset, 'id'));
      const enabled = String(findValue(preset, 'enabled') ?? 'true').toLowerCase() !== 'false';
      if (Number.isInteger(id) && enabled) {
        presets.set(id, String(findValue(preset, 'presetName') || `Preset ${id}`));
      }
    }
    return presets;
  }

  async getDoorRelays() {
    const xml = await this.getXml('/ISAPI/AccessControl/RemoteControl/door/capabilities');
    const doorNo = findValue(xml, 'doorNo');
    const command = findValue(xml, 'cmd');
    const commands = String(getXmlAttribute(command, 'opt') || command || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    if (!commands.includes('open')) return new Set();

    const minimum = Number(getXmlAttribute(doorNo, 'min') || 1);
    const maximum = Number(getXmlAttribute(doorNo, 'max') || doorNo || 0);
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum)
      || minimum < 1 || minimum > 32 || maximum < minimum) {
      return new Set();
    }
    return new Set(Array.from({ length: Math.min(maximum, 32) - minimum + 1 }, (_, index) => minimum + index));
  }

  async getStreamingProfile(channelId, streamIndex = 1) {
    const streamId = Number(`${channelId}0${streamIndex}`);
    const xml = await this.getXml(`/ISAPI/Streaming/channels/${streamId}`);
    const codec = String(findValue(xml, 'videoCodecType') || 'H.264').toUpperCase();
    return {
      streamId,
      codec,
      demuxer: codec.includes('265') ? 'h265' : 'h264',
      width: Number(findValue(xml, 'videoResolutionWidth')) || null,
      height: Number(findValue(xml, 'videoResolutionHeight')) || null,
    };
  }

  async getPreferredStreamingProfile(channelId, preference = 'automatic') {
    const normalized = ['main', 'substream'].includes(preference) ? preference : 'automatic';
    const streamIndexes = normalized === 'main' ? [1] : (normalized === 'substream' ? [2] : [2, 1]);
    let firstProfile = null;
    let firstError = null;
    for (const streamIndex of streamIndexes) {
      try {
        const profile = await this.getStreamingProfile(channelId, streamIndex);
        if (!firstProfile) firstProfile = profile;
        if (normalized !== 'automatic' || profile.demuxer === 'h264') return profile;
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    if (firstProfile) return firstProfile;
    throw firstError || new Error(this._message(
      'errors.streaming_profile_missing', {}, 'No Hikvision streaming profile is available',
    ));
  }

  async getSnapshot(channelId) {
    const preferredPath = this.snapshotPaths.get(channelId);
    const paths = [
      preferredPath,
      `/ISAPI/Streaming/channels/${channelId}01/picture`,
      `/ISAPI/Streaming/channels/${channelId}/picture`,
      `/ISAPI/Streaming/channels/${channelId}02/picture`,
    ].filter((path, index, values) => path && values.indexOf(path) === index);
    let lastError;

    for (const path of paths) {
      try {
        const response = await this.request(path, {
          timeout: 15000,
          headers: { Accept: 'image/jpeg' },
        });
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (contentType && !contentType.startsWith('image/')) {
          throw new Error(this._message(
            'errors.snapshot_unexpected_format',
            { format: contentType },
            'Unexpected snapshot format: __format__',
          ));
        }
        if (response.body.length > MAX_SNAPSHOT_SIZE) {
          throw new Error(this._message(
            'errors.snapshot_too_large', {}, 'Snapshot exceeds the Homey limit of 5 MB',
          ));
        }
        if (response.body.length < 4 || response.body[0] !== 0xff || response.body[1] !== 0xd8) {
          throw new Error(this._message(
            'errors.snapshot_invalid_jpeg', {}, 'The Hikvision snapshot is not a valid JPEG image',
          ));
        }
        this.snapshotPaths.set(channelId, path);
        return response.body;
      } catch (error) {
        lastError = error;
        if (error.statusCode === 401 || error.statusCode === 403) throw error;
        if (this.options.log) this.options.log(`Snapshotpad ${path} mislukt: ${error.message}`);
      }
    }

    throw lastError;
  }

  async pipeSnapshot(channelId, destination) {
    const path = `/ISAPI/Streaming/channels/${channelId}01/picture`;
    let response = await this._openResponse(path, {
      headers: { Accept: 'image/jpeg' },
      timeout: 15000,
    });
    if (response.statusCode === 401) {
      response.resume();
      if (!this._applyAuthenticationChallenge(response.headers['www-authenticate'])) throw Object.assign(new Error(this._message(
        'errors.invalid_credentials', {}, 'Invalid username or password',
      )), { statusCode: 401 });
      response = await this._openResponse(path, {
        headers: { Accept: 'image/jpeg' },
        timeout: 15000,
      });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw Object.assign(new Error(this._message(
        'errors.snapshot_http',
        { status: response.statusCode },
        'Hikvision snapshot responded with HTTP __status__',
      )), {
        statusCode: response.statusCode,
      });
    }
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      response.resume();
      throw new Error(this._message(
        'errors.snapshot_unexpected_format',
        { format: contentType },
        'Unexpected snapshot format: __format__',
      ));
    }
    const contentLength = Number(response.headers['content-length'] || 0);
    if (contentLength > MAX_SNAPSHOT_SIZE) {
      response.resume();
      throw new Error(this._message(
        'errors.snapshot_too_large', {}, 'Snapshot exceeds the Homey limit of 5 MB',
      ));
    }

    let received = 0;
    const snapshotTooLargeMessage = this._message(
      'errors.snapshot_too_large', {}, 'Snapshot exceeds the Homey limit of 5 MB',
    );
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > MAX_SNAPSHOT_SIZE) {
          callback(new Error(snapshotTooLargeMessage));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(response, limiter, destination);
  }

  _openResponse(path, options = {}) {
    const method = options.method || 'GET';
    const transport = this.options.ssl ? https : http;
    const headers = { Accept: '*/*', ...(options.headers || {}) };
    const authorization = this._authorization(method, path);
    if (authorization) headers.Authorization = authorization;
    if (this.sessionCookie) headers.Cookie = this.sessionCookie;

    return new Promise((resolve, reject) => {
      const request = transport.request({
        hostname: this.options.host,
        port: this.options.port,
        path,
        method,
        headers,
        rejectUnauthorized: this.options.strict !== false,
        timeout: options.timeout || this.options.timeout,
      }, response => {
        response.once('close', () => this.activeRequests.delete(request));
        resolve(response);
      });
      this.activeRequests.add(request);
      request.on('timeout', () => request.destroy(new Error(this._message(
        'errors.connection_timeout', {}, 'Connection timed out',
      ))));
      request.on('error', error => {
        this.activeRequests.delete(request);
        reject(error);
      });
      request.end();
    });
  }

  async movePtz({ pan, tilt, zoom, channel, isNvr }) {
    const path = isNvr
      ? `/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${channel}/continuous`
      : `/ISAPI/PTZCtrl/channels/${channel}/continuous`;
    const body = `<?xml version="1.0" encoding="UTF-8"?><PTZData><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`;
    await this.request(path, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/xml' },
    });
    return true;
  }

  async gotoPtzPreset({ channel, preset, isNvr }) {
    const path = isNvr
      ? `/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${channel}/presets/${preset}/goto`
      : `/ISAPI/PTZCtrl/channels/${channel}/presets/${preset}/goto`;
    await this.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
    });
    return true;
  }

  async triggerRelay(relay) {
    const path = `/ISAPI/AccessControl/RemoteControl/door/${relay}`;
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>';
    await this.request(path, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/xml' },
    });
    return true;
  }

  startAlertStream() {
    if (this.clientStopped) return false;
    this.alertStreamEnabled = true;
    if (this.alertRequest || this.alertStreamOpening || this.reconnectTimer) return false;
    this._openAlertStream().catch(error => this._handleStreamError(error));
    return true;
  }

  stopAlertStream() {
    this.alertStreamEnabled = false;
    this.alertReconnectAttempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.alertRequest) this.alertRequest.destroy();
    this.alertRequest = null;
    for (const event of this.activeEvents.values()) clearTimeout(event.timer);
    this.activeEvents.clear();
  }

  stop() {
    this.clientStopped = true;
    this.stopAlertStream();
    for (const request of this.activeRequests) request.destroy(new Error(this._message(
      'errors.client_stopped', {}, 'Hikvision client stopped',
    )));
    this.activeRequests.clear();
    this.sessionCookie = null;
    this.sessionRetryAfter = 0;
    this.sessionDiagnostics.active = false;
    for (const event of this.activeEvents.values()) clearTimeout(event.timer);
    this.activeEvents.clear();
  }

  _clearActiveEvent(key, emitStop = true) {
    const event = this.activeEvents.get(key);
    if (!event) return false;
    clearTimeout(event.timer);
    this.activeEvents.delete(key);
    if (emitStop) this.emit('alarm', event.code, 'Stop', event.channel);
    return true;
  }

  _touchActiveEvent(key, code, channel) {
    const existing = this.activeEvents.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this._clearActiveEvent(key), this.options.eventIdleTimeout);
    if (typeof timer.unref === 'function') timer.unref();
    this.activeEvents.set(key, { code, channel, timer });
    if (!existing) this.emit('alarm', code, 'Start', channel);
  }

  async _openAlertStream() {
    if (this.clientStopped || !this.alertStreamEnabled || this.alertRequest || this.alertStreamOpening) return;
    this.alertStreamOpening = true;
    try {
      if (!this.challenge) {
        await this.request('/ISAPI/System/deviceInfo');
      }
      if (this.clientStopped || !this.alertStreamEnabled) return;
      const path = '/ISAPI/Event/notification/alertStream';
      const transport = this.options.ssl ? https : http;
      const headers = { Accept: 'multipart/x-mixed-replace' };
      const authorization = this._authorization('GET', path);
      if (authorization) headers.Authorization = authorization;
      if (this.sessionCookie) headers.Cookie = this.sessionCookie;

      await new Promise((resolve, reject) => {
        const request = transport.request({
          hostname: this.options.host,
          port: this.options.port,
          path,
          method: 'GET',
          headers,
          rejectUnauthorized: this.options.strict !== false,
        }, response => {
          if (response.statusCode === 401) {
            const challenge = parseDigestChallenge(response.headers['www-authenticate']);
            const sessionExpired = this.authMode === 'session';
            response.resume();
            reject(Object.assign(new Error(this._message(
              'errors.alert_auth_expired', {}, 'Authentication for the alarm stream expired',
            )), { challenge, sessionExpired, statusCode: 401 }));
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            reject(Object.assign(new Error(this._message(
              'errors.alert_http',
              { status: response.statusCode },
              'Alarm stream responded with HTTP __status__',
            )), {
              statusCode: response.statusCode,
            }));
            return;
          }
          this.alertReconnectAttempt = 0;
          this.emit('connect');
          response.on('data', chunk => this._consumeAlertData(chunk));
          response.on('end', () => reject(new Error(this._message(
            'errors.alert_closed', {}, 'Alarm stream was closed',
          ))));
          response.on('error', reject);
        });
        this.alertRequest = request;
        request.setTimeout(this.options.streamIdleTimeout || DEFAULT_STREAM_IDLE_TIMEOUT, () => {
          request.destroy(new Error(this._message(
            'errors.alert_idle_timeout', {}, 'Alarm stream did not receive data in time',
          )));
        });
        request.on('error', reject);
        request.end();
      });
    } finally {
      this.alertStreamOpening = false;
      this.alertRequest = null;
    }
  }

  _handleStreamError(error) {
    if (this.clientStopped || !this.alertStreamEnabled) return;
    if (error.challenge) {
      this.authMode = 'digest';
      this.challenge = error.challenge;
      this.nonceCount = 0;
    }
    if (error.sessionExpired) {
      this.sessionCookie = null;
      this.sessionRetryAfter = 0;
      this.authMode = null;
      this.sessionDiagnostics.active = false;
      this.sessionDiagnostics.result = 'expired';
    }
    this.emit('alarm-error', error);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const authorizationDelay = error.challenge || error.sessionExpired
      ? 0
      : ([401, 403].includes(error.statusCode) ? ALERT_RECONNECT_MAX_DELAY : null);
    const backoffDelay = Math.min(
      ALERT_RECONNECT_MAX_DELAY,
      ALERT_RECONNECT_BASE_DELAY * (2 ** this.alertReconnectAttempt),
    );
    const delay = authorizationDelay ?? Math.round(backoffDelay * (0.8 + Math.random() * 0.4));
    this.alertReconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._openAlertStream().catch(nextError => this._handleStreamError(nextError));
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  _consumeAlertData(chunk) {
    this.alertBuffer += chunk.toString('utf8');
    let closeIndex = this.alertBuffer.indexOf(ALERT_CLOSE_TAG);
    while (closeIndex !== -1) {
      const openIndex = this.alertBuffer.lastIndexOf('<EventNotificationAlert', closeIndex);
      const endIndex = closeIndex + ALERT_CLOSE_TAG.length;
      if (openIndex !== -1) {
        const xml = this.alertBuffer.slice(openIndex, endIndex);
        this._handleAlertXml(xml).catch(error => {
          if (this.options.log) this.options.log(`Ongeldige alarmmelding: ${error.message}`);
        });
      }
      this.alertBuffer = this.alertBuffer.slice(endIndex);
      closeIndex = this.alertBuffer.indexOf(ALERT_CLOSE_TAG);
    }
    if (this.alertBuffer.length > 1024 * 1024) this.alertBuffer = this.alertBuffer.slice(-65536);
  }

  async _handleAlertXml(xml) {
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const codeValue = String(findValue(parsed, 'eventType') || '');
    const mappedCode = EVENT_NAMES[codeValue.toLowerCase()];
    const code = mappedCode || codeValue;
    const state = String(findValue(parsed, 'eventState') || '');
    const channel = Number(findValue(parsed, 'dynChannelID') || findValue(parsed, 'channelID') || 0);
    const countValue = findValue(parsed, 'activePostCount');
    const hasCount = countValue !== undefined && countValue !== null && countValue !== '';
    const count = Number(countValue || 0);
    const key = `${code}:${channel}`;

    if (!mappedCode && codeValue) {
      this.emit('unhandled-event', {
        eventType: codeValue,
        eventState: state,
        channel,
      });
    }

    if (MOMENTARY_EVENTS.has(code)) {
      if (state === 'active') this.emit('alarm', code, 'Start', channel);
      return;
    }

    if (state === 'inactive') {
      this._clearActiveEvent(key);
      return;
    }
    if (hasCount && count === 0) {
      for (const activeKey of [...this.activeEvents.keys()]) this._clearActiveEvent(activeKey);
      return;
    }
    this._touchActiveEvent(key, code, channel);
  }
}

module.exports = {
  HikvisionClient,
  createSessionPassword,
  extractCookies,
  getDiagnosticErrorCode,
  findValue,
  getIsapiResponseError,
  parseBasicChallenge,
  parseDigestChallenge,
  summarizeAuthenticationChallenge,
};
