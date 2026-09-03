'use strict';

const Homey = require('homey');
const process = require('node:process');
const { HikvisionClient, getDiagnosticErrorCode } = require('../../lib/hikvision-client');
const { hashPrivateValue, sanitizeForBugReport } = require('../../lib/bug-report');
const { getUnsupportedAlarmCapabilities } = require('../../lib/device-capabilities');
const {
  isAnyAlarmActive,
  remainingAlarmHoldMs,
  resetAlarmState,
  updateAlarmState,
} = require('../../lib/alarm-state');
const {
  isSingleChannelDevice,
  isVideoIntercomDevice,
  supportsRtspOnlyFallback,
} = require('../../lib/device-type');
const { normalizeAuthMethod, parseBoolean } = require('../../lib/settings');
const { getUserErrorMessage } = require('../../lib/user-error');

const MAX_CAMERA_IMAGES = 16;
const CAMERA_IMAGE_UPDATE_INTERVAL = 30000;
const SNAPSHOT_CACHE_TTL = 10000;
const SNAPSHOT_ERROR_BACKOFF = 60000;
const MAX_SNAPSHOT_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_FLOW_SNAPSHOT_IMAGES = 8;
const FLOW_SNAPSHOT_LIFETIME = 2 * 60 * 1000;
const DOORBELL_DEBOUNCE = 2000;
const CALL_STATUS_POLL_INTERVAL = 1000;
const CALL_STATUS_MAX_BACKOFF = 30000;
const CONNECTION_HEALTH_INTERVAL = 60000;
const ISAPI_RECOVERY_INTERVAL = 30000;
const CONNECTION_RETRY_BASE = 30000;
const CONNECTION_RETRY_MAX = 5 * 60 * 1000;
const MAX_DIAGNOSTIC_EVENTS = 20;
const CONNECTION_FAILURE_THRESHOLD = 3;
const RELAY_COMMAND_COOLDOWN = 3000;
const MAX_RELAY_DIAGNOSTICS = 20;
const MAX_CALL_CONTROL_DIAGNOSTICS = 20;
const RINGING_CALL_STATUSES = new Set(['ring', 'ringing', 'calling']);
const EVENT_CAPABILITIES = {
  VideoMotion: 'alarm_motion',
  VideoBlind: 'alarm_tamper',
  AlarmLocal: 'hik_alarm_local',
  VideoLoss: 'hik_alarm_video_loss',
  LineDetection: 'hik_alarm_line_crossing',
  IntrusionDetection: 'hik_alarm_intrusion',
  RegionEntranceDetection: 'hik_alarm_region_entrance',
  RegionExitingDetection: 'hik_alarm_region_exiting',
};
const MOTION_EVENT_CODES = [
  'VideoMotion',
  'LineDetection',
  'IntrusionDetection',
  'RegionEntranceDetection',
  'RegionExitingDetection',
];
const SNAPSHOT_EVENT_CODES = [...MOTION_EVENT_CODES, 'Doorbell'];
const ALARM_CAPABILITIES = [...new Set(Object.values(EVENT_CAPABILITIES))];

class HikvisionDevice extends Homey.Device {
  async onInit() {
    if (this.getClass() !== 'camera') await this.setClass('camera');
    this.client = null;
    this.initialReconnectTimer = null;
    this.connectionGeneration = 0;
    this.cameraImages = new Map();
    this.cameraVideos = new Map();
    this.videoProfiles = new Map();
    this.cameraImageUpdateTimers = new Map();
    this.snapshotCache = new Map();
    this.snapshotCacheUpdatedAt = new Map();
    this.snapshotRequests = new Map();
    this.snapshotRetryAfter = new Map();
    this.flowSnapshotImages = new Set();
    this.flowSnapshotCleanupTimers = new Map();
    this.ptzOperations = new Map();
    this.ptzDelayTimers = new Map();
    this.lastDoorbellPressAt = new Map();
    this.availableChannels = new Map([[1, 'Camera']]);
    this.ptzChannels = new Set();
    this.doorRelays = new Set();
    this.featureDetection = {
      checkedAt: null,
      channels: 'not-checked',
      ptz: 'not-checked',
      relays: 'not-checked',
    };
    this.lastRelayCommandAt = 0;
    this.relayDiagnostics = [];
    this.callControlDiagnostics = {
      checkedAt: null,
      supported: null,
      commands: [],
      recentAttempts: [],
    };
    this.callStatusPollTimer = null;
    this.callStatusPollRunning = false;
    this.callStatusPollFailureCount = 0;
    this.connectionHealthTimer = null;
    this.connectionHealthCheckRunning = false;
    this.isapiRecoveryTimer = null;
    this.isapiRecoveryRunning = false;
    this.callStatusDiagnostics = {
      eligible: false,
      supported: null,
      polling: false,
      detection: null,
      lastStatus: null,
      lastChecked: null,
      lastError: null,
      lastErrorCode: null,
    };
    this.unhandledEvents = [];
    this.recentEventDiagnostics = [];
    this.motionAlarmStartedAt = 0;
    this.motionAlarmTimer = null;
    this.activeAlarmChannels = new Map(
      Object.keys(EVENT_CAPABILITIES).map(eventCode => [eventCode, new Set()]),
    );
    this.connectionState = false;
    this.connectionFailureCount = 0;
    this.isapiAvailable = null;
    this.eventMonitoringEnabled = this.getStoreValue('event_monitoring_enabled') !== false;
    await this.syncAlarmCapabilities(this.getCapabilityValue('hik_type'));
    if (!this.hasCapability('hik_event_monitoring')) await this.addCapability('hik_event_monitoring');
    await Promise.all([
      this.setCapabilityValue('hik_status', false),
      this.setCapabilityValue('hik_event_monitoring', this.eventMonitoringEnabled),
      ...ALARM_CAPABILITIES.map(capability => this.setCapabilityValue(capability, false)),
    ]).catch(this.error);
    await this.connect();
  }

  createClient(settings = this.getSettings()) {
    return new HikvisionClient({
      host: settings.address,
      port: Number(settings.port),
      ssl: parseBoolean(settings.ssl),
      strict: parseBoolean(settings.strict),
      username: settings.username,
      password: settings.password,
      authMethod: normalizeAuthMethod(settings.auth_method),
      translate: (key, tokens) => this.homey.__(key, tokens),
      log: message => this.log(message),
    });
  }

  async connect(settings = this.getSettings()) {
    this.disconnect();
    const generation = this.connectionGeneration;
    const client = this.createClient(settings);
    this.client = client;
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    client.on('connect', () => {
      if (isCurrent()) {
        this.unsetWarning().catch(this.error);
        this.handleConnected().catch(this.error);
      }
    });
    client.on('alarm-error', error => {
      if (isCurrent()) this.handleAlarmStreamError(error).catch(this.error);
    });
    client.on('alarm', (code, action, channel) => {
      if (isCurrent()) this.handleAlarm(code, action, channel).catch(this.error);
    });
    client.on('unhandled-event', event => {
      if (isCurrent()) this.recordUnhandledEvent(event);
    });
    client.on('event-diagnostic', event => {
      if (isCurrent()) this.recordEventDiagnostic(event);
    });

    try {
      let info;
      let isapiAvailable = true;
      let automaticRtspFallbackError = null;
      const forceRtspOnly = parseBoolean(settings.rtsp_only);
      const cachedType = String(this.getCapabilityValue('hik_type') || '');
      const fallbackType = cachedType && cachedType.toUpperCase() !== 'UNKNOWN' ? cachedType : 'VIS';
      if (forceRtspOnly) {
        isapiAvailable = false;
        info = {
          name: this.getName(),
          id: String(this.getData()?.id || ''),
          type: fallbackType,
          firmwareVersion: String(this.getCapabilityValue('hik_version') || 'Unknown'),
        };
        this.log('RTSP-only mode is enabled; all ISAPI requests are disabled');
      } else {
        try {
          info = await client.getDeviceInfo();
        } catch (error) {
          if (!supportsRtspOnlyFallback(cachedType)) throw error;
          info = this.getCachedDeviceInfo(fallbackType);
          try {
            await client.getCallStatus();
            this.log(`General ISAPI device information is temporarily unavailable, but the video-intercom call-status endpoint works: ${error.message}`);
          } catch (callStatusError) {
            isapiAvailable = false;
            automaticRtspFallbackError = `deviceInfo: ${error.message}; callStatus: ${callStatusError.message}`;
            this.log(`ISAPI is unavailable for this video intercom; continuing with RTSP Live video only: ${error.message}; call-status probe: ${callStatusError.message}`);
          }
        }
      }
      if (!isCurrent()) return;
      this.isapiAvailable = isapiAvailable;
      await Promise.all([
        this.setCapabilityValue('hik_type', info.type),
        this.setCapabilityValue('hik_version', info.firmwareVersion),
      ]);
      await this.syncAlarmCapabilities(info.type);
      if (!isCurrent()) return;
      if (isapiAvailable) {
        await this.registerCameraImages(info.type, client, generation).catch(error => {
          this.error('Camera image registration failed', error);
        });
      }
      if (isCurrent()) {
        await this.registerCameraVideos(info.type, client, generation, { rtspOnly: !isapiAvailable }).catch(error => {
          this.error('Live camera video registration failed', error);
        });
      }
      if (isCurrent() && isapiAvailable) {
        await this.detectDeviceFeatures(info.type, client, generation);
      } else if (isCurrent()) {
        await this.clearDetectedFeatures('isapi-unavailable');
      }
      if (isCurrent()) {
        await this.handleConnected();
        if (isapiAvailable) {
          this.startConnectionHealthChecks(client, generation);
          if (this.eventMonitoringEnabled) {
            client.startAlertStream();
            this.configureCallStatusPolling(info.type, client, generation).catch(error => {
              this.error('Doorbell call-status setup failed', error);
            });
          } else {
            this.callStatusDiagnostics = {
              eligible: isVideoIntercomDevice(info.type),
              supported: null,
              polling: false,
              detection: 'monitoring-disabled',
              lastStatus: null,
              lastChecked: null,
              lastError: null,
              lastErrorCode: null,
            };
          }
        } else {
          this.callStatusDiagnostics = {
            eligible: true,
            supported: false,
            polling: false,
            detection: forceRtspOnly ? 'rtsp-only' : 'automatic-rtsp-fallback',
            lastStatus: null,
            lastChecked: null,
            lastError: forceRtspOnly
              ? 'ISAPI disabled by the RTSP-only setting'
              : automaticRtspFallbackError || 'ISAPI temporarily unavailable; automatic recovery is active',
            lastErrorCode: forceRtspOnly ? 'RTSP_ONLY' : 'ISAPI_UNAVAILABLE',
          };
          if (!forceRtspOnly) this.startIsapiRecoveryChecks(client, generation);
        }
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.connectionFailureCount += 1;
      this.error(`Connection attempt ${this.connectionFailureCount} failed`, error);
      await this.setCapabilityValue('hik_status', false).catch(this.error);
      const userMessage = getUserErrorMessage(error, key => this.homey.__(key));
      if (this.connectionFailureCount >= CONNECTION_FAILURE_THRESHOLD) {
        await this.setUnavailable(userMessage).catch(this.error);
      } else {
        await this.setWarning(this.homey.__('errors.connection_retrying', {
          attempt: this.connectionFailureCount,
          maximum: CONNECTION_FAILURE_THRESHOLD,
        })).catch(this.error);
      }
      const reconnectDelay = this.getReconnectDelay();
      this.initialReconnectTimer = setTimeout(() => {
        this.initialReconnectTimer = null;
        this.connect().catch(this.error);
      }, reconnectDelay);
      if (typeof this.initialReconnectTimer.unref === 'function') this.initialReconnectTimer.unref();
    }
  }

  getCachedDeviceInfo(fallbackType = 'VIS') {
    return {
      name: this.getName(),
      id: String(this.getData()?.id || ''),
      type: fallbackType,
      firmwareVersion: String(this.getCapabilityValue('hik_version') || 'Unknown'),
    };
  }

  async clearDetectedFeatures(reason) {
    this.availableChannels = new Map([[1, 'Camera']]);
    this.ptzChannels.clear();
    this.doorRelays.clear();
    this.featureDetection = {
      checkedAt: new Date().toISOString(),
      channels: reason,
      ptz: reason,
      relays: reason,
    };
  }

  async detectDeviceFeatures(deviceType, client, generation) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    const isNvr = String(deviceType || '').toUpperCase().includes('NVR');
    let channels;
    try {
      channels = isSingleChannelDevice(deviceType) ? new Map([[1, 'Camera']]) : await client.getChannels();
      if (!isCurrent()) return;
      this.availableChannels = channels.size > 0 ? channels : new Map([[1, 'Camera']]);
      this.featureDetection.channels = 'detected';
    } catch (error) {
      this.featureDetection.channels = `error:${getDiagnosticErrorCode(error)}`;
      this.availableChannels = new Map([[1, 'Camera']]);
    }

    try {
      const ptzChannels = await client.getPtzChannels({
        channelIds: [...this.availableChannels.keys()],
        isNvr,
      });
      if (!isCurrent()) return;
      this.ptzChannels = ptzChannels;
      this.featureDetection.ptz = 'detected';
    } catch (error) {
      this.ptzChannels.clear();
      this.featureDetection.ptz = `error:${getDiagnosticErrorCode(error)}`;
    }

    try {
      const doorRelays = await client.getDoorRelays();
      if (!isCurrent()) return;
      this.doorRelays = doorRelays;
      this.featureDetection.relays = 'detected';
    } catch (error) {
      this.doorRelays.clear();
      this.featureDetection.relays = `error:${getDiagnosticErrorCode(error)}`;
    }

    this.featureDetection.checkedAt = new Date().toISOString();
  }

  filterAutocompleteOptions(options, query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return options.filter(option => !normalizedQuery
      || option.name.toLowerCase().includes(normalizedQuery)
      || String(option.id).includes(normalizedQuery));
  }

  getChannelOptions(query = '', { ptzOnly = false } = {}) {
    const options = [...this.availableChannels]
      .filter(([id]) => !ptzOnly || this.ptzChannels.has(id))
      .map(([id, name]) => ({ id, name: `[${id}] ${name}` }));
    return this.filterAutocompleteOptions(options, query);
  }

  getRelayOptions(query = '') {
    const options = [...this.doorRelays].map(id => ({
      id,
      name: this.homey.__('flow.relay_name', { relay: id }),
    }));
    return this.filterAutocompleteOptions(options, query);
  }

  async getPtzPresetOptions(channel, query = '') {
    const channelId = Number(channel?.id ?? channel);
    if (!this.ptzChannels.has(channelId) || !this.client) return [];
    const type = String(this.getCapabilityValue('hik_type') || '').toUpperCase();
    const presets = await this.client.getPtzPresets({ channel: channelId, isNvr: type.includes('NVR') });
    return this.filterAutocompleteOptions([...presets].map(([id, name]) => ({
      id,
      name: `[${id}] ${name}`,
    })), query);
  }

  disconnect() {
    this.connectionGeneration += 1;
    if (this.initialReconnectTimer) clearTimeout(this.initialReconnectTimer);
    this.initialReconnectTimer = null;
    if (this.client) this.client.stop();
    this.client = null;
    this.connectionState = false;
    this.isapiAvailable = null;
    if (this.callStatusPollTimer) clearTimeout(this.callStatusPollTimer);
    this.callStatusPollTimer = null;
    this.callStatusPollRunning = false;
    this.callStatusPollFailureCount = 0;
    this.callStatusDiagnostics.polling = false;
    if (this.connectionHealthTimer) clearInterval(this.connectionHealthTimer);
    this.connectionHealthTimer = null;
    this.connectionHealthCheckRunning = false;
    if (this.isapiRecoveryTimer) clearInterval(this.isapiRecoveryTimer);
    this.isapiRecoveryTimer = null;
    this.isapiRecoveryRunning = false;
    for (const timer of this.cameraImageUpdateTimers.values()) clearInterval(timer);
    this.cameraImageUpdateTimers.clear();
    for (const video of this.cameraVideos.values()) video.unregister().catch(this.error);
    this.cameraVideos.clear();
    this.videoProfiles.clear();
    this.snapshotRequests.clear();
    this.lastDoorbellPressAt.clear();
    this.resetAlarmCapabilities().catch(this.error);
  }

  recordUnhandledEvent(event) {
    this.unhandledEvents.push({
      receivedAt: new Date().toISOString(),
      eventType: String(event.eventType || '').slice(0, 100),
      eventState: String(event.eventState || '').slice(0, 50),
      channel: Number(event.channel) || 0,
    });
    this.unhandledEvents = this.unhandledEvents.slice(-MAX_DIAGNOSTIC_EVENTS);
  }

  recordEventDiagnostic(event) {
    this.recentEventDiagnostics.push({
      receivedAt: new Date().toISOString(),
      eventType: String(event.eventType || '').slice(0, 100),
      mappedType: event.mappedType ? String(event.mappedType).slice(0, 100) : null,
      eventState: String(event.eventState || '').slice(0, 50),
      channel: Number(event.channel) || 0,
      activePostCount: Number.isFinite(event.activePostCount) ? event.activePostCount : null,
    });
    this.recentEventDiagnostics = this.recentEventDiagnostics.slice(-MAX_DIAGNOSTIC_EVENTS);
  }

  async syncAlarmCapabilities(deviceType) {
    const unsupported = getUnsupportedAlarmCapabilities(deviceType);
    for (const capability of ALARM_CAPABILITIES) {
      if (unsupported.includes(capability)) {
        if (this.hasCapability(capability)) await this.removeCapability(capability);
      } else if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  startConnectionHealthChecks(client, generation) {
    if (this.connectionHealthTimer) clearInterval(this.connectionHealthTimer);
    this.connectionHealthTimer = setInterval(() => {
      this.checkConnectionHealth(client, generation).catch(this.error);
    }, CONNECTION_HEALTH_INTERVAL);
    if (typeof this.connectionHealthTimer.unref === 'function') this.connectionHealthTimer.unref();
  }

  startIsapiRecoveryChecks(client, generation) {
    if (this.isapiRecoveryTimer) clearInterval(this.isapiRecoveryTimer);
    this.isapiRecoveryTimer = setInterval(() => {
      this.checkIsapiRecovery(client, generation).catch(this.error);
    }, ISAPI_RECOVERY_INTERVAL);
    if (typeof this.isapiRecoveryTimer.unref === 'function') this.isapiRecoveryTimer.unref();
  }

  async checkIsapiRecovery(client, generation) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    if (!isCurrent() || this.isapiRecoveryRunning || parseBoolean(this.getSettings().rtsp_only)) return;
    this.isapiRecoveryRunning = true;
    try {
      const detection = await client.detectCallStatusSupport();
      if (!isCurrent()) return;
      this.callStatusDiagnostics.supported = detection.supported;
      this.callStatusDiagnostics.detection = `recovery-${detection.source}`;
      this.callStatusDiagnostics.lastStatus = detection.status;
      this.callStatusDiagnostics.lastChecked = new Date().toISOString();
      this.callStatusDiagnostics.lastError = detection.error;
      this.callStatusDiagnostics.lastErrorCode = detection.errorCode;
      if (!detection.supported) return;

      if (this.isapiRecoveryTimer) clearInterval(this.isapiRecoveryTimer);
      this.isapiRecoveryTimer = null;
      this.log('Video-intercom ISAPI has recovered; reconnecting to enable snapshots, events and doorbell polling');
      await this.connect();
    } finally {
      this.isapiRecoveryRunning = false;
    }
  }

  async checkConnectionHealth(client, generation) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    if (!isCurrent() || this.connectionHealthCheckRunning) return;
    this.connectionHealthCheckRunning = true;
    try {
      try {
        await client.getDeviceInfo();
      } catch (error) {
        const deviceType = String(this.getCapabilityValue('hik_type') || '');
        if (!isVideoIntercomDevice(deviceType)) throw error;
        try {
          await client.getCallStatus();
          this.log(`Video-intercom health check uses call status because deviceInfo failed: ${error.message}`);
        } catch {
          throw error;
        }
      }
      if (!isCurrent()) return;
      this.connectionFailureCount = 0;
      await this.unsetWarning().catch(this.error);
      if (!this.connectionState) await this.handleConnected();
    } catch (error) {
      if (!isCurrent()) return;
      this.connectionFailureCount += 1;
      const userMessage = getUserErrorMessage(error, key => this.homey.__(key));
      if (this.connectionFailureCount >= CONNECTION_FAILURE_THRESHOLD) {
        await this.handleDisconnected(error);
        await this.setUnavailable(userMessage).catch(this.error);
      } else {
        await this.setWarning(this.homey.__('errors.connection_retrying', {
          attempt: this.connectionFailureCount,
          maximum: CONNECTION_FAILURE_THRESHOLD,
        })).catch(this.error);
      }
    } finally {
      this.connectionHealthCheckRunning = false;
    }
  }

  async configureCallStatusPolling(deviceType, client, generation) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    const eligible = isVideoIntercomDevice(deviceType);
    this.callStatusDiagnostics = {
      eligible,
      supported: null,
      polling: false,
      detection: null,
      lastStatus: null,
      lastChecked: null,
      lastError: null,
      lastErrorCode: null,
    };
    if (!eligible || !isCurrent()) return;

    try {
      const detection = await client.detectCallStatusSupport();
      if (!isCurrent()) return;
      this.callStatusDiagnostics.supported = detection.supported;
      this.callStatusDiagnostics.detection = detection.source;
      this.callStatusDiagnostics.lastStatus = detection.status;
      this.callStatusDiagnostics.lastError = detection.error;
      this.callStatusDiagnostics.lastErrorCode = detection.errorCode;
      if (!detection.supported) return;
      this.callStatusDiagnostics.polling = true;
      if (detection.status) {
        this.callStatusDiagnostics.lastChecked = new Date().toISOString();
        this.scheduleCallStatusPoll(client, generation);
      } else {
        await this.pollCallStatus(client, generation);
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.callStatusDiagnostics.supported = false;
      this.callStatusDiagnostics.lastError = error.message;
      this.callStatusDiagnostics.lastErrorCode = getDiagnosticErrorCode(error);
      this.log(`Video intercom call status is unavailable: ${error.message}`);
    }
  }

  getReconnectDelay() {
    const exponent = Math.max(0, this.connectionFailureCount - 1);
    const delay = Math.min(CONNECTION_RETRY_MAX, CONNECTION_RETRY_BASE * (2 ** exponent));
    return Math.round(delay * (0.8 + Math.random() * 0.4));
  }

  scheduleCallStatusPoll(client, generation, delay = CALL_STATUS_POLL_INTERVAL) {
    if (this.callStatusPollTimer) clearTimeout(this.callStatusPollTimer);
    this.callStatusPollTimer = setTimeout(() => {
      this.callStatusPollTimer = null;
      this.pollCallStatus(client, generation).catch(this.error);
    }, delay);
    if (typeof this.callStatusPollTimer.unref === 'function') this.callStatusPollTimer.unref();
  }

  async pollCallStatus(client, generation) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    if (!isCurrent() || !this.callStatusDiagnostics.polling || this.callStatusPollRunning) return;
    this.callStatusPollRunning = true;
    try {
      const status = String(await client.getCallStatus()).trim().toLowerCase();
      if (!isCurrent()) return;
      const previousStatus = this.callStatusDiagnostics.lastStatus;
      this.callStatusDiagnostics.lastStatus = status;
      this.callStatusDiagnostics.lastChecked = new Date().toISOString();
      this.callStatusDiagnostics.lastError = null;
      this.callStatusDiagnostics.lastErrorCode = null;
      this.callStatusPollFailureCount = 0;
      if (previousStatus
        && !RINGING_CALL_STATUSES.has(previousStatus)
        && RINGING_CALL_STATUSES.has(status)) {
        await this.handleAlarm('Doorbell', 'Start', 1);
      }
    } catch (error) {
      if (isCurrent()) {
        this.callStatusPollFailureCount += 1;
        this.callStatusDiagnostics.lastChecked = new Date().toISOString();
        this.callStatusDiagnostics.lastError = error.message;
        this.callStatusDiagnostics.lastErrorCode = getDiagnosticErrorCode(error);
      }
    } finally {
      this.callStatusPollRunning = false;
      if (isCurrent() && this.callStatusDiagnostics.polling) {
        const delay = this.callStatusPollFailureCount === 0
          ? CALL_STATUS_POLL_INTERVAL
          : Math.min(
            CALL_STATUS_MAX_BACKOFF,
            CALL_STATUS_POLL_INTERVAL * (2 ** this.callStatusPollFailureCount),
          );
        this.scheduleCallStatusPoll(client, generation, delay);
      }
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    const invalidPort = key => changedKeys.includes(key)
      && (!Number.isInteger(newSettings[key]) || newSettings[key] < 1 || newSettings[key] > 65535);
    if (invalidPort('port') || invalidPort('rtsp_port')) {
      throw new Error(this.homey.__('errors.invalid_port'));
    }
    if (changedKeys.includes('motion_hold_seconds')
      && (!Number.isInteger(newSettings.motion_hold_seconds)
        || newSettings.motion_hold_seconds < 1
        || newSettings.motion_hold_seconds > 300)) {
      throw new Error(this.homey.__('errors.invalid_motion_hold'));
    }
    if (!String(newSettings.address || '').trim() || !String(newSettings.username || '').trim()) {
      throw new Error(this.homey.__('pair.nosettings'));
    }
    if (changedKeys.every(key => key === 'motion_hold_seconds')) return;
    await this.stopAllPtz();
    await this.connect(newSettings);
  }

  async onDeleted() {
    await this.dispose();
  }

  async onUninit() {
    await this.dispose();
  }

  async dispose() {
    await this.stopAllPtz();
    this.disconnect();
    for (const { timer, resolve } of this.ptzDelayTimers.values()) {
      clearTimeout(timer);
      resolve();
    }
    this.ptzDelayTimers.clear();
    for (const timer of this.flowSnapshotCleanupTimers.values()) clearTimeout(timer);
    this.flowSnapshotCleanupTimers.clear();
    await Promise.all([...this.cameraImages.values()].map(image => image.unregister().catch(this.error)));
    await Promise.all([...this.flowSnapshotImages].map(image => image.unregister().catch(this.error)));
    this.cameraImages.clear();
    this.flowSnapshotImages.clear();
    this.snapshotCache.clear();
    this.snapshotCacheUpdatedAt.clear();
    this.snapshotRetryAfter.clear();
  }

  async handleConnected() {
    await this.unsetWarning().catch(this.error);
    if (this.connectionState) return;
    this.connectionState = true;
    this.connectionFailureCount = 0;
    await this.setCapabilityValue('hik_status', true).catch(this.error);
    await this.setAvailable().catch(this.error);
    this.log('Hikvision device connected');
    await this.driver.trigger('OnConnected', this);
  }

  async handleDisconnected(error) {
    if (!this.connectionState) return;
    this.connectionState = false;
    this.ptzOperations.clear();
    await this.resetAlarmCapabilities();
    await this.setCapabilityValue('hik_status', false).catch(this.error);
    this.log(`Hikvision connection closed${error ? `: ${error.message}` : ''}`);
    await this.driver.trigger('OnDisconnected', this);
    if (error) await this.driver.trigger('OnError', this);
  }

  async handleAlarmStreamError(_error) {
    await this.resetAlarmCapabilities();
    const message = this.homey.__('errors.alarm_stream_unavailable');
    this.log(message);
    await this.driver.trigger('OnError', this);
  }

  async handleAlarm(code, action, channel) {
    if (code === 'Doorbell') {
      if (action !== 'Start') return;
      const channelId = Number(channel);
      const now = Date.now();
      const previousPress = this.lastDoorbellPressAt.get(channelId) || 0;
      if (now - previousPress < DOORBELL_DEBOUNCE) return;
      this.lastDoorbellPressAt.set(channelId, now);
      await this.driver.trigger('DoorbellPressed', this, await this.createEventTokens('Doorbell', channelId));
      return;
    }
    const capability = EVENT_CAPABILITIES[code];
    if (capability) {
      const activeChannels = this.activeAlarmChannels.get(code);
      const isActive = updateAlarmState(activeChannels, action, channel);
      if (capability !== 'alarm_motion') {
        await this.setCapabilityValue(capability, isActive).catch(this.error);
      }
      if (MOTION_EVENT_CODES.includes(code)) {
        const isMotionActive = isAnyAlarmActive(this.activeAlarmChannels, MOTION_EVENT_CODES);
        await this.updateHomeyMotionStatus(isMotionActive, action);
      }
    }
    const triggerId = `${code}${action}`;
    const channelId = Number(channel);
    const tokens = action === 'Start'
      ? await this.createEventTokens(code, channelId)
      : { channelID: channelId };
    return this.driver.trigger(triggerId, this, tokens);
  }

  async createEventTokens(code, channelId) {
    const tokens = { channelID: channelId };
    if (!SNAPSHOT_EVENT_CODES.includes(code)) return tokens;
    try {
      tokens.snapshot = await this.createFlowSnapshot(channelId);
    } catch (error) {
      this.error(`Flow-momentopname voor kanaal ${channelId} ophalen is mislukt`, error);
    }
    return tokens;
  }

  getDiagnostics() {
    const doorbellDiagnostics = { ...this.callStatusDiagnostics };
    delete doorbellDiagnostics.lastError;
    const memory = process.memoryUsage();
    const snapshotCacheBytes = [...this.snapshotCache.values()]
      .reduce((total, snapshot) => total + snapshot.length, 0);
    return {
      success: true,
      device: {
        type: this.getCapabilityValue('hik_type'),
        firmwareVersion: this.getCapabilityValue('hik_version'),
        connected: this.connectionState,
        available: this.getAvailable(),
        isapiAvailable: this.isapiAvailable,
        eventMonitoringEnabled: this.eventMonitoringEnabled,
        rtspOnlyConfigured: parseBoolean(this.getSettings().rtsp_only),
      },
      videoProfiles: Object.fromEntries(this.videoProfiles),
      doorbell: doorbellDiagnostics,
      callControl: {
        ...this.callControlDiagnostics,
        commands: [...this.callControlDiagnostics.commands],
        recentAttempts: [...this.callControlDiagnostics.recentAttempts],
      },
      authentication: this.client?.getAuthenticationDiagnostics?.() || null,
      features: {
        ...this.featureDetection,
        availableChannels: [...this.availableChannels].map(([id, name]) => ({ id, name })),
        ptzChannels: [...this.ptzChannels],
        doorRelays: [...this.doorRelays],
      },
      relayControl: {
        cooldownMs: RELAY_COMMAND_COOLDOWN,
        recentAttempts: [...this.relayDiagnostics],
      },
      resources: {
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
        },
        snapshotCache: {
          entries: this.snapshotCache.size,
          bytes: snapshotCacheBytes,
          maximumBytes: MAX_SNAPSHOT_CACHE_BYTES,
        },
        flowSnapshotImages: {
          active: this.flowSnapshotImages.size,
          maximum: MAX_FLOW_SNAPSHOT_IMAGES,
        },
        pendingSnapshotRequests: this.snapshotRequests.size,
        registeredCameraImages: this.cameraImages.size,
        registeredCameraVideos: this.cameraVideos.size,
        imageUpdateTimers: this.cameraImageUpdateTimers.size,
        ptzTimers: this.ptzDelayTimers.size,
      },
      recentEvents: [...this.recentEventDiagnostics],
      unhandledEvents: [...this.unhandledEvents],
    };
  }

  getBugReport() {
    const settings = this.getSettings();
    const data = this.getData();
    const privateValues = [settings.address, settings.username, settings.password, data?.id];
    const manifest = this.homey.manifest || {};
    const capabilityValues = Object.fromEntries(this.getCapabilities().map(capability => [
      capability,
      this.getCapabilityValue(capability),
    ]));
    const report = sanitizeForBugReport({
      reportType: 'Hikvision device bug report',
      createdAt: new Date().toISOString(),
      privacy: {
        note: 'Passwords, IP addresses, hostnames and usernames are removed before this report is shown.',
        addressConfigured: Boolean(settings.address),
        addressHash: hashPrivateValue(settings.address),
        usernameConfigured: Boolean(settings.username),
        passwordConfigured: Boolean(settings.password),
      },
      app: {
        id: manifest.id,
        version: manifest.version,
        sdk: manifest.sdk,
      },
      driver: { id: 'hikvision-camnvr', connection: 'local_isapi' },
      device: { idHash: hashPrivateValue(data?.id) },
      settings: {
        port: Number(settings.port),
        rtspPort: Number(settings.rtsp_port),
        ssl: parseBoolean(settings.ssl),
        strictTls: parseBoolean(settings.strict),
        authMethod: normalizeAuthMethod(settings.auth_method),
        motionHoldSeconds: Number(settings.motion_hold_seconds) || 10,
        liveStream: String(settings.live_stream || 'automatic'),
        rtspOnly: parseBoolean(settings.rtsp_only),
      },
      capabilities: capabilityValues,
      diagnostics: this.getDiagnostics(),
    }, privateValues);

    return { success: true, report: JSON.stringify(report, null, 2) };
  }

  async resetAlarmCapabilities() {
    if (this.motionAlarmTimer) clearTimeout(this.motionAlarmTimer);
    this.motionAlarmTimer = null;
    this.motionAlarmStartedAt = 0;
    for (const activeChannels of this.activeAlarmChannels.values()) resetAlarmState(activeChannels);
    await Promise.all(ALARM_CAPABILITIES
      .filter(capability => this.hasCapability(capability))
      .map(capability => this.setCapabilityValue(capability, false)))
      .catch(this.error);
  }

  async updateHomeyMotionStatus(isActive, action) {
    if (this.motionAlarmTimer) clearTimeout(this.motionAlarmTimer);
    this.motionAlarmTimer = null;

    if (isActive) {
      if (action === 'Start' || !this.motionAlarmStartedAt) this.motionAlarmStartedAt = Date.now();
      await this.setCapabilityValue('alarm_motion', true).catch(this.error);
      return;
    }

    const minimumSeconds = Number(this.getSettings().motion_hold_seconds) || 10;
    const remainingMs = remainingAlarmHoldMs(this.motionAlarmStartedAt, minimumSeconds);
    if (remainingMs <= 0) {
      this.motionAlarmStartedAt = 0;
      await this.setCapabilityValue('alarm_motion', false).catch(this.error);
      return;
    }

    this.motionAlarmTimer = setTimeout(() => {
      this.motionAlarmTimer = null;
      this.motionAlarmStartedAt = 0;
      this.setCapabilityValue('alarm_motion', false).catch(this.error);
    }, remainingMs);
    if (typeof this.motionAlarmTimer.unref === 'function') this.motionAlarmTimer.unref();
  }

  async movePtz({ pan, tilt, zoom, channel, duration = 1 }) {
    if (!this.client) throw new Error(this.homey.__('errors.not_connected'));
    for (const [name, value] of Object.entries({ pan, tilt, zoom })) {
      if (!Number.isFinite(value) || value < -100 || value > 100) {
        throw new Error(this.homey.__('errors.invalid_ptz', { name }));
      }
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > 36) {
      throw new Error(this.homey.__('errors.invalid_channel'));
    }
    if (!this.ptzChannels.has(channel)) {
      throw new Error(this.homey.__('errors.ptz_not_supported'));
    }
    if (!Number.isFinite(duration) || duration < 0.1 || duration > 10) {
      throw new Error(this.homey.__('errors.invalid_duration'));
    }
    const type = String(this.getCapabilityValue('hik_type') || '').toUpperCase();
    const client = this.client;
    const isNvr = type.includes('NVR');
    this.ptzOperations.delete(channel);
    this.cancelPtzDelay(channel);
    await client.movePtz({ pan, tilt, zoom, channel, isNvr });
    if (pan === 0 && tilt === 0 && zoom === 0) {
      this.ptzOperations.delete(channel);
      return true;
    }

    const operation = Symbol(`ptz-${channel}`);
    this.ptzOperations.set(channel, operation);
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.ptzDelayTimers.get(channel)?.timer === timer) this.ptzDelayTimers.delete(channel);
        resolve();
      }, duration * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      this.ptzDelayTimers.set(channel, { timer, resolve });
    });
    if (this.ptzOperations.get(channel) === operation && this.client === client) {
      this.ptzOperations.delete(channel);
      await client.movePtz({ pan: 0, tilt: 0, zoom: 0, channel, isNvr });
    }
    return true;
  }

  async stopPtz(channel) {
    if (!this.client) throw new Error(this.homey.__('errors.not_connected'));
    if (!Number.isInteger(channel) || channel < 1 || channel > 36) {
      throw new Error(this.homey.__('errors.invalid_channel'));
    }
    if (!this.ptzChannels.has(channel)) {
      throw new Error(this.homey.__('errors.ptz_not_supported'));
    }
    this.cancelPtzDelay(channel);
    this.ptzOperations.delete(channel);
    const type = String(this.getCapabilityValue('hik_type') || '').toUpperCase();
    return this.client.movePtz({ pan: 0, tilt: 0, zoom: 0, channel, isNvr: type.includes('NVR') });
  }

  async gotoPtzPreset(channel, preset) {
    if (!this.client || this.isapiAvailable !== true) {
      throw new Error(this.homey.__('errors.isapi_required'));
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > 36) {
      throw new Error(this.homey.__('errors.invalid_channel'));
    }
    if (!this.ptzChannels.has(channel)) {
      throw new Error(this.homey.__('errors.ptz_not_supported'));
    }
    if (!Number.isInteger(preset) || preset < 1 || preset > 300) {
      throw new Error(this.homey.__('errors.invalid_preset'));
    }
    const type = String(this.getCapabilityValue('hik_type') || '').toUpperCase();
    const presets = await this.client.getPtzPresets({ channel, isNvr: type.includes('NVR') });
    if (!presets.has(preset)) {
      throw new Error(this.homey.__('errors.preset_not_available'));
    }
    return this.client.gotoPtzPreset({ channel, preset, isNvr: type.includes('NVR') });
  }

  cancelPtzDelay(channel) {
    const pending = this.ptzDelayTimers.get(channel);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.ptzDelayTimers.delete(channel);
    pending.resolve();
    return true;
  }

  async triggerRelay(relay) {
    if (!this.client || this.isapiAvailable !== true) {
      throw new Error(this.homey.__('errors.isapi_required'));
    }
    if (!Number.isInteger(relay) || relay < 1 || relay > 32) {
      throw new Error(this.homey.__('errors.invalid_relay'));
    }
    if (!this.doorRelays.has(relay)) {
      this.recordRelayAttempt(relay, 'unsupported');
      throw new Error(this.homey.__('errors.relay_not_supported'));
    }
    const now = Date.now();
    if (now - this.lastRelayCommandAt < RELAY_COMMAND_COOLDOWN) {
      this.recordRelayAttempt(relay, 'blocked-cooldown');
      throw new Error(this.homey.__('errors.relay_cooldown'));
    }
    this.lastRelayCommandAt = now;
    try {
      const result = await this.client.triggerRelay(relay);
      this.recordRelayAttempt(relay, 'success');
      return result;
    } catch (error) {
      this.recordRelayAttempt(relay, 'failed', getDiagnosticErrorCode(error));
      throw error;
    }
  }

  recordRelayAttempt(relay, result, errorCode = null) {
    this.relayDiagnostics.push({
      timestamp: new Date().toISOString(),
      relay,
      result,
      errorCode,
    });
    this.relayDiagnostics = this.relayDiagnostics.slice(-MAX_RELAY_DIAGNOSTICS);
  }

  async endIntercomCall() {
    if (!this.client || this.isapiAvailable !== true) {
      throw new Error(this.homey.__('errors.isapi_required'));
    }
    if (!isVideoIntercomDevice(this.getCapabilityValue('hik_type'))) {
      this.recordCallControlAttempt('unsupported-device');
      throw new Error(this.homey.__('errors.call_control_not_supported'));
    }

    try {
      const capabilities = await this.client.getCallSignalCapabilities();
      const commands = capabilities.commands.map(value => String(value));
      const supported = commands.some(value => value.toLowerCase() === 'hangup');
      this.callControlDiagnostics.checkedAt = new Date().toISOString();
      this.callControlDiagnostics.supported = supported;
      this.callControlDiagnostics.commands = commands;
      if (!supported) {
        this.recordCallControlAttempt('unsupported-command');
        throw Object.assign(new Error(this.homey.__('errors.call_control_not_supported')), {
          code: 'ECALLCONTROLUNSUPPORTED',
        });
      }

      const status = String(await this.client.getCallStatus()).trim().toLowerCase();
      if (!RINGING_CALL_STATUSES.has(status)) {
        this.recordCallControlAttempt('blocked-not-ringing', null, status);
        throw Object.assign(new Error(this.homey.__('errors.no_ringing_call')), {
          code: 'ENORINGINGCALL',
        });
      }

      const result = await this.client.hangUpIntercomCall({ capabilitiesChecked: true });
      this.recordCallControlAttempt('success', null, status);
      return result;
    } catch (error) {
      if (!['ECALLCONTROLUNSUPPORTED', 'ENORINGINGCALL'].includes(error.code)) {
        this.recordCallControlAttempt('failed', getDiagnosticErrorCode(error));
      }
      throw error;
    }
  }

  recordCallControlAttempt(result, errorCode = null, callStatus = null) {
    this.callControlDiagnostics.recentAttempts.push({
      timestamp: new Date().toISOString(),
      command: 'hangUp',
      callStatus,
      result,
      errorCode,
    });
    this.callControlDiagnostics.recentAttempts = this.callControlDiagnostics.recentAttempts
      .slice(-MAX_CALL_CONTROL_DIAGNOSTICS);
  }

  async setEventMonitoring(enabled) {
    const nextState = Boolean(enabled);
    if (nextState === this.eventMonitoringEnabled) return true;
    if (nextState && (!this.client || this.isapiAvailable !== true)) {
      throw new Error(this.homey.__('errors.isapi_required'));
    }
    this.eventMonitoringEnabled = nextState;
    await this.setStoreValue('event_monitoring_enabled', nextState);
    await this.setCapabilityValue('hik_event_monitoring', nextState);

    if (!nextState) {
      if (this.callStatusPollTimer) clearTimeout(this.callStatusPollTimer);
      this.callStatusPollTimer = null;
      this.callStatusDiagnostics.polling = false;
      this.callStatusDiagnostics.detection = 'monitoring-disabled';
      this.client?.stopAlertStream();
      await this.resetAlarmCapabilities();
      await this.driver.trigger('EventMonitoringDisabled', this);
      return true;
    }

    const client = this.client;
    const generation = this.connectionGeneration;
    client.startAlertStream();
    await this.configureCallStatusPolling(
      String(this.getCapabilityValue('hik_type') || ''),
      client,
      generation,
    );
    await this.driver.trigger('EventMonitoringEnabled', this);
    return true;
  }

  async stopAllPtz() {
    const channels = [...this.ptzOperations.keys()];
    await Promise.all(channels.map(channel => this.stopPtz(channel).catch(this.error)));
    this.ptzOperations.clear();
  }

  async getWidgetSnapshot(channelId = 1) {
    if (!this.client) throw new Error(this.homey.__('errors.not_connected'));
    const snapshot = await this.getSnapshotBuffer(channelId);
    return {
      name: this.getName(),
      channelId,
      mimeType: 'image/jpeg',
      image: snapshot.toString('base64'),
      timestamp: this.snapshotCacheUpdatedAt.get(channelId) || Date.now(),
    };
  }

  async getSnapshotBuffer(channelId, { forceRefresh = false } = {}) {
    const now = Date.now();
    const cachedSnapshot = this.snapshotCache.get(channelId);
    const cachedAt = this.snapshotCacheUpdatedAt.get(channelId) || 0;
    if (!forceRefresh && cachedSnapshot
      && (now - cachedAt < SNAPSHOT_CACHE_TTL || now < (this.snapshotRetryAfter.get(channelId) || 0))) {
      return cachedSnapshot;
    }

    const pendingRequest = this.snapshotRequests.get(channelId);
    if (pendingRequest) return pendingRequest;

    const client = this.client;
    const request = client.getSnapshot(channelId)
      .then(snapshot => {
        if (this.client === client) {
          this.cacheSnapshot(channelId, snapshot);
          this.snapshotRetryAfter.delete(channelId);
        }
        return snapshot;
      })
      .catch(error => {
        const fallback = this.snapshotCache.get(channelId);
        if (!fallback) throw error;
        this.snapshotRetryAfter.set(channelId, Date.now() + SNAPSHOT_ERROR_BACKOFF);
        this.log(`Laatste geldige snapshot voor kanaal ${channelId} gebruikt; nieuwe poging over 60 seconden: ${error.message}`);
        return fallback;
      })
      .finally(() => {
        if (this.snapshotRequests.get(channelId) === request) this.snapshotRequests.delete(channelId);
      });
    this.snapshotRequests.set(channelId, request);
    return request;
  }

  cacheSnapshot(channelId, snapshot) {
    this.snapshotCache.delete(channelId);
    this.snapshotCacheUpdatedAt.delete(channelId);
    this.snapshotCache.set(channelId, snapshot);
    this.snapshotCacheUpdatedAt.set(channelId, Date.now());

    let totalBytes = [...this.snapshotCache.values()]
      .reduce((total, value) => total + value.length, 0);
    for (const [oldestChannel, value] of this.snapshotCache) {
      if (totalBytes <= MAX_SNAPSHOT_CACHE_BYTES) break;
      if (oldestChannel === channelId && this.snapshotCache.size === 1) break;
      this.snapshotCache.delete(oldestChannel);
      this.snapshotCacheUpdatedAt.delete(oldestChannel);
      this.snapshotRetryAfter.delete(oldestChannel);
      totalBytes -= value.length;
    }
  }

  async unregisterFlowSnapshot(image) {
    const timer = this.flowSnapshotCleanupTimers.get(image);
    if (timer) clearTimeout(timer);
    this.flowSnapshotCleanupTimers.delete(image);
    this.flowSnapshotImages.delete(image);
    await image.unregister().catch(this.error);
  }

  async createFlowSnapshot(channelId) {
    if (!this.client) throw new Error(this.homey.__('errors.not_connected'));
    if (!Number.isInteger(channelId) || channelId < 1 || channelId > 36) {
      throw new Error(this.homey.__('errors.invalid_channel'));
    }
    if (!this.availableChannels.has(channelId)) {
      throw new Error(this.homey.__('errors.channel_not_available'));
    }

    const snapshot = await this.getSnapshotBuffer(channelId, { forceRefresh: true });
    while (this.flowSnapshotImages.size >= MAX_FLOW_SNAPSHOT_IMAGES) {
      const oldestImage = this.flowSnapshotImages.values().next().value;
      await this.unregisterFlowSnapshot(oldestImage);
    }
    const image = await this.homey.images.createImage();
    image.setStream(stream => stream.end(snapshot));
    this.flowSnapshotImages.add(image);

    const cleanupTimer = setTimeout(() => {
      this.unregisterFlowSnapshot(image).catch(this.error);
    }, FLOW_SNAPSHOT_LIFETIME);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
    this.flowSnapshotCleanupTimers.set(image, cleanupTimer);
    return image;
  }

  async registerCameraImages(deviceType, client, generation) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    if (!isCurrent()) return;
    const oldImages = [...this.cameraImages.values()];
    this.cameraImages.clear();
    this.snapshotCache.clear();
    this.snapshotCacheUpdatedAt.clear();
    this.snapshotRetryAfter.clear();
    await Promise.all(oldImages.map(image => image.unregister().catch(this.error)));
    if (!isCurrent()) return;

    const channels = isSingleChannelDevice(deviceType)
      ? new Map([[1, 'Camera']])
      : await client.getChannels();
    if (!isCurrent()) return;
    const selectedChannels = [...channels.entries()].slice(0, MAX_CAMERA_IMAGES);
    for (const [channelId, channelName] of selectedChannels) {
      const image = await this.homey.images.createImage();
      if (!isCurrent()) {
        await image.unregister().catch(this.error);
        return;
      }
      image.setStream(async stream => {
        try {
          const snapshot = await this.getSnapshotBuffer(channelId);
          stream.end(snapshot);
        } catch (error) {
          this.error(`Snapshot voor kanaal ${channelId} ophalen is mislukt`, error);
          stream.destroy(error);
        }
      });
      await this.setCameraImage(`camera_${channelId}`, `[${channelId}] ${channelName}`, image);
      try {
        await this.getSnapshotBuffer(channelId);
      } catch (error) {
        this.log(`Eerste snapshot voor kanaal ${channelId} kon niet worden voorbereid: ${error.message}`);
      }
      await image.update();
      if (!isCurrent()) {
        await image.unregister().catch(this.error);
        return;
      }
      this.cameraImages.set(channelId, image);
      const updateTimer = setInterval(() => {
        if (!isCurrent()) return;
        image.update().catch(error => this.error(`Camera-afbeelding ${channelId} verversen is mislukt`, error));
      }, CAMERA_IMAGE_UPDATE_INTERVAL);
      if (typeof updateTimer.unref === 'function') updateTimer.unref();
      this.cameraImageUpdateTimers.set(channelId, updateTimer);
    }
  }

  async registerCameraVideos(deviceType, client, generation, { rtspOnly = false } = {}) {
    const isCurrent = () => this.client === client && this.connectionGeneration === generation;
    if (!isCurrent()) return;
    const channels = rtspOnly || isSingleChannelDevice(deviceType)
      ? new Map([[1, 'Camera']])
      : await client.getChannels();
    if (!isCurrent()) return;

    for (const [channelId, channelName] of [...channels.entries()].slice(0, MAX_CAMERA_IMAGES)) {
      const preference = String(this.getSettings().live_stream || 'automatic');
      const fallbackStreamIndex = preference === 'main' ? 1 : 2;
      let profile = {
        streamId: Number(`${channelId}0${fallbackStreamIndex}`),
        codec: 'H.264',
        demuxer: 'h264',
        width: null,
        height: null,
      };
      if (!rtspOnly) {
        try {
          profile = await client.getPreferredStreamingProfile(channelId, preference);
        } catch (error) {
          this.log(`Videoprofiel voor kanaal ${channelId} kon niet worden gelezen; stream ${profile.streamId} met H.264 wordt geprobeerd: ${error.message}`);
        }
      }
      if (!isCurrent()) return;

      const video = await this.homey.videos.createVideoRTSP({ demuxer: profile.demuxer });
      video.registerVideoUrlListener(async () => {
        const settings = this.getSettings();
        const username = encodeURIComponent(String(settings.username || ''));
        const password = encodeURIComponent(String(settings.password || ''));
        const address = String(settings.address || '').trim();
        const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
        const port = Number(settings.rtsp_port) || 554;
        return {
          url: `rtsp://${username}:${password}@${host}:${port}/Streaming/Channels/${profile.streamId || Number(`${channelId}01`)}`,
        };
      });
      if (!isCurrent()) {
        await video.unregister().catch(this.error);
        return;
      }
      await this.setCameraVideo(`camera_${channelId}`, `[${channelId}] ${channelName}`, video);
      this.cameraVideos.set(channelId, video);
      this.videoProfiles.set(channelId, {
        streamId: profile.streamId,
        codec: profile.codec,
        width: profile.width,
        height: profile.height,
        preference,
        rtspOnly,
      });
      this.log(`Live video voor kanaal ${channelId} geregistreerd (${profile.codec}${profile.width && profile.height ? `, ${profile.width}x${profile.height}` : ''})`);
    }
  }
}

module.exports = HikvisionDevice;
