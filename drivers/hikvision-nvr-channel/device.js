'use strict';

const Homey = require('homey');
const {
  ALARM_CAPABILITIES,
  EVENT_CAPABILITIES,
  MOTION_EVENT_CODES,
} = require('../../lib/hikvision-events');
const {
  isAnyAlarmActive,
  remainingAlarmHoldMs,
  resetAlarmState,
  updateAlarmState,
} = require('../../lib/alarm-state');
const { hashPrivateValue, sanitizeForBugReport } = require('../../lib/bug-report');

const CAMERA_IMAGE_UPDATE_INTERVAL = 30000;
const FLOW_SNAPSHOT_LIFETIME = 2 * 60 * 1000;
const MAX_FLOW_SNAPSHOT_IMAGES = 4;
const PARENT_RETRY_INTERVAL = 15000;

class HikvisionNvrChannelDevice extends Homey.Device {
  async onInit() {
    const data = this.getData();
    this.parentId = String(data.parentId || '');
    this.channelId = Number(data.channel);
    this.parentDevice = null;
    this.unsubscribeParent = null;
    this.parentRetryTimer = null;
    this.connectionState = false;
    this.eventMonitoringState = null;
    this.cameraImage = null;
    this.cameraImageTimer = null;
    this.cameraVideo = null;
    this.cameraVideoPromise = null;
    this.videoProfile = null;
    this.flowSnapshotImages = new Set();
    this.flowSnapshotCleanupTimers = new Map();
    this.recordingTokens = new Map();
    this.selectedRecording = null;
    this.recordingVideo = null;
    this.recordingVideoPromise = null;
    this.motionAlarmStartedAt = 0;
    this.motionAlarmTimer = null;
    this.activeAlarmChannels = new Map(
      Object.keys(EVENT_CAPABILITIES).map(eventCode => [eventCode, new Set()]),
    );

    await Promise.all([
      this.setCapabilityValue('hik_status', false),
      this.setCapabilityValue('hik_event_monitoring', false),
      this.setCapabilityValue('hik_type', 'NVR channel'),
      ...ALARM_CAPABILITIES.map(capability => this.setCapabilityValue(capability, false)),
    ]).catch(this.error);
    await this.attachParent();
  }

  getParentDevice() {
    return this.driver.findParentDevice(this.parentId);
  }

  scheduleParentRetry() {
    if (this.parentRetryTimer) return;
    this.parentRetryTimer = setTimeout(() => {
      this.parentRetryTimer = null;
      this.attachParent().catch(this.error);
    }, PARENT_RETRY_INTERVAL);
    if (typeof this.parentRetryTimer.unref === 'function') this.parentRetryTimer.unref();
  }

  async attachParent() {
    const parent = this.getParentDevice();
    if (!parent || typeof parent.subscribeChannel !== 'function') {
      this.unsubscribeParent?.();
      this.unsubscribeParent = null;
      this.parentDevice = null;
      await this.setUnavailable(this.homey.__('errors.parent_nvr_missing')).catch(this.error);
      this.scheduleParentRetry();
      return;
    }
    if (this.parentDevice === parent && this.unsubscribeParent) return;
    if (this.parentRetryTimer) clearTimeout(this.parentRetryTimer);
    this.parentRetryTimer = null;
    this.unsubscribeParent?.();
    this.parentDevice = parent;
    this.unsubscribeParent = parent.subscribeChannel(this.channelId, {
      onState: (state, meta) => this.handleParentState(state, meta),
      onAlarm: (code, action, channelId, tokens) => (
        this.handleParentAlarm(code, action, channelId, tokens)
      ),
      onError: () => this.driver.trigger('OnError', this),
    });
  }

  async handleParentState(state, { initial = false } = {}) {
    const wasConnected = this.connectionState;
    const previousMonitoring = this.eventMonitoringState;
    this.connectionState = Boolean(state.connected && state.available);
    this.eventMonitoringState = Boolean(state.eventMonitoringEnabled);
    await Promise.all([
      this.setCapabilityValue('hik_status', this.connectionState),
      this.setCapabilityValue('hik_event_monitoring', this.eventMonitoringState),
      this.setCapabilityValue('hik_version', String(state.firmwareVersion || 'Unknown')),
    ]).catch(this.error);

    if (this.connectionState) {
      if (this.parentRetryTimer) clearTimeout(this.parentRetryTimer);
      this.parentRetryTimer = null;
      await this.setAvailable().catch(this.error);
      await this.ensureCameraMedia().catch(error => {
        this.error('NVR channel media registration failed', error);
        this.setWarning(error.message).catch(this.error);
      });
      if (this.cameraImage && this.cameraVideo) await this.unsetWarning().catch(this.error);
    } else {
      await this.resetAlarmCapabilities();
      const message = state.available
        ? this.homey.__('errors.parent_nvr_disconnected')
        : this.homey.__('errors.channel_not_available');
      await this.setUnavailable(message).catch(this.error);
      this.scheduleParentRetry();
    }

    if (!wasConnected && this.connectionState) await this.driver.trigger('OnConnected', this);
    if (wasConnected && !this.connectionState) await this.driver.trigger('OnDisconnected', this);
    if (!initial && previousMonitoring !== null && previousMonitoring !== this.eventMonitoringState) {
      await this.driver.trigger(
        this.eventMonitoringState ? 'EventMonitoringEnabled' : 'EventMonitoringDisabled',
        this,
      );
    }
  }

  async handleParentAlarm(code, action, channelId, tokens = {}) {
    if (Number(channelId) !== this.channelId) return;
    if (code === 'Doorbell') {
      if (action === 'Start') await this.driver.trigger('DoorbellPressed', this, tokens);
      return;
    }
    const capability = EVENT_CAPABILITIES[code];
    if (capability) {
      const activeChannels = this.activeAlarmChannels.get(code);
      const isActive = updateAlarmState(activeChannels, action, this.channelId);
      if (capability !== 'alarm_motion' && this.hasCapability(capability)) {
        await this.setCapabilityValue(capability, isActive).catch(this.error);
      }
      if (MOTION_EVENT_CODES.includes(code)) {
        await this.updateHomeyMotionStatus(
          isAnyAlarmActive(this.activeAlarmChannels, MOTION_EVENT_CODES),
          action,
        );
      }
    }
    await this.driver.trigger(`${code}${action}`, this, tokens);
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

  requireParent() {
    const parent = this.parentDevice || this.getParentDevice();
    if (!parent) throw new Error(this.homey.__('errors.parent_nvr_missing'));
    return parent;
  }

  async ensureCameraMedia() {
    if (!this.cameraImage) await this.registerCameraImage();
    if (!this.cameraVideo) await this.registerCameraVideo();
  }

  async registerCameraImage() {
    this.requireParent();
    const image = await this.homey.images.createImage();
    image.setStream(async stream => {
      try {
        stream.end(await this.requireParent().getSnapshotBuffer(this.channelId));
      } catch (error) {
        stream.destroy(error);
      }
    });
    await this.setCameraImage('camera', this.getName(), image);
    this.cameraImage = image;
    await image.update().catch(this.error);
    this.cameraImageTimer = setInterval(() => image.update().catch(this.error), CAMERA_IMAGE_UPDATE_INTERVAL);
    if (typeof this.cameraImageTimer.unref === 'function') this.cameraImageTimer.unref();
  }

  async registerCameraVideo() {
    if (this.cameraVideoPromise) return this.cameraVideoPromise;
    this.cameraVideoPromise = (async () => {
      const parent = this.requireParent();
      if (!parent.client) throw new Error(this.homey.__('errors.parent_nvr_disconnected'));
      const preference = String(this.getSettings().live_stream || 'automatic');
      const videoTransport = String(this.getSettings().video_transport || 'automatic');
      const fallbackStreamIndex = preference === 'main' ? 1 : 2;
      let profile = {
        streamId: Number(`${this.channelId}0${fallbackStreamIndex}`),
        codec: 'H.264',
        demuxer: 'h264',
        width: null,
        height: null,
      };
      try {
        profile = await parent.client.getPreferredStreamingProfile(this.channelId, preference);
      } catch (error) {
        this.log(`Using H.264 fallback profile for NVR channel ${this.channelId}: ${error.message}`);
      }
      const options = { demuxer: profile.demuxer };
      if (videoTransport === 'direct') options.disableWebRTCProxy = true;
      if (videoTransport === 'webrtc') options.disableWebRTCProxy = false;
      const video = await this.homey.videos.createVideoRTSP(options);
      video.registerVideoUrlListener(async () => ({
        url: this.requireParent().getRtspUrl(this.channelId, profile.streamId),
      }));
      await this.setCameraVideo('camera', this.getName(), video);
      this.cameraVideo = video;
      this.videoProfile = {
        streamId: profile.streamId,
        codec: profile.codec,
        width: profile.width,
        height: profile.height,
        preference,
        videoTransport,
      };
    })().finally(() => { this.cameraVideoPromise = null; });
    return this.cameraVideoPromise;
  }

  async recreateCameraVideo() {
    if (this.cameraVideo) await this.cameraVideo.unregister().catch(this.error);
    this.cameraVideo = null;
    this.videoProfile = null;
    if (this.connectionState) await this.registerCameraVideo();
  }

  getChannelOptions(query = '', { ptzOnly = false } = {}) {
    const parent = this.requireParent();
    if (ptzOnly && !parent.ptzChannels.has(this.channelId)) return [];
    const name = `[${this.channelId}] ${parent.availableChannels.get(this.channelId) || this.getName()}`;
    const normalizedQuery = String(query || '').trim().toLowerCase();
    if (normalizedQuery && !name.toLowerCase().includes(normalizedQuery)
      && !String(this.channelId).includes(normalizedQuery)) return [];
    return [{ id: this.channelId, name }];
  }

  getPtzPresetOptions(_channel, query = '') {
    return this.requireParent().getPtzPresetOptions(this.channelId, query);
  }

  movePtz(args) {
    return this.requireParent().movePtz({ ...args, channel: this.channelId });
  }

  stopPtz() {
    return this.requireParent().stopPtz(this.channelId);
  }

  gotoPtzPreset(_channel, preset) {
    return this.requireParent().gotoPtzPreset(this.channelId, preset);
  }

  getRelayOptions(query = '') {
    return this.requireParent().getRelayOptions(query);
  }

  triggerRelay(relay) {
    return this.requireParent().triggerRelay(relay);
  }

  endIntercomCall() {
    return this.requireParent().endIntercomCall();
  }

  setEventMonitoring(enabled) {
    return this.requireParent().setEventMonitoring(enabled);
  }

  async registerFlowSnapshot(snapshot) {
    while (this.flowSnapshotImages.size >= MAX_FLOW_SNAPSHOT_IMAGES) {
      const oldest = this.flowSnapshotImages.values().next().value;
      await this.unregisterFlowSnapshot(oldest);
    }
    const image = await this.homey.images.createImage();
    image.setStream(stream => stream.end(snapshot));
    this.flowSnapshotImages.add(image);
    const timer = setTimeout(() => this.unregisterFlowSnapshot(image).catch(this.error), FLOW_SNAPSHOT_LIFETIME);
    if (typeof timer.unref === 'function') timer.unref();
    this.flowSnapshotCleanupTimers.set(image, timer);
    return image;
  }

  async unregisterFlowSnapshot(image) {
    const timer = this.flowSnapshotCleanupTimers.get(image);
    if (timer) clearTimeout(timer);
    this.flowSnapshotCleanupTimers.delete(image);
    this.flowSnapshotImages.delete(image);
    await image.unregister().catch(this.error);
  }

  async createFlowSnapshot() {
    const snapshot = await this.requireParent().getSnapshotBuffer(this.channelId, { forceRefresh: true });
    return this.registerFlowSnapshot(snapshot);
  }

  getRecordingChannels() {
    const name = this.parentDevice?.availableChannels.get(this.channelId) || this.getName();
    return [{ id: this.channelId, name: `[${this.channelId}] ${name}` }];
  }

  async getWidgetSnapshot(_channelId, options = {}) {
    const result = await this.requireParent().getWidgetSnapshot(this.channelId, options);
    return { ...result, name: this.getName(), channelId: this.channelId };
  }

  async captureWidgetSnapshot() {
    const snapshot = await this.requireParent().getSnapshotBuffer(this.channelId, { forceRefresh: true });
    const image = await this.registerFlowSnapshot(snapshot);
    await this.driver.trigger('SnapshotCaptured', this, { channelID: this.channelId, snapshot: image });
    return {
      name: this.getName(),
      channelId: this.channelId,
      mimeType: 'image/jpeg',
      image: snapshot.toString('base64'),
      timestamp: Date.now(),
    };
  }

  async searchWidgetRecordings({ startTime, endTime } = {}) {
    const result = await this.requireParent().searchWidgetRecordings({
      channel: this.channelId,
      startTime,
      endTime,
    });
    this.recordingTokens.clear();
    const parent = this.requireParent();
    for (const recording of result.recordings) {
      this.recordingTokens.set(
        recording.token,
        parent.getWidgetRecording(recording.token, { allowUnsupported: true }),
      );
    }
    return result;
  }

  getSelectedRecordingUrl() {
    return this.requireParent().getRecordingUrl(this.selectedRecording);
  }

  async ensureRecordingVideo() {
    if (this.recordingVideo) return;
    if (this.recordingVideoPromise) return this.recordingVideoPromise;
    this.recordingVideoPromise = (async () => {
      const video = await this.homey.videos.createVideoRTSP({ demuxer: 'h264' });
      video.registerVideoUrlListener(async () => ({ url: this.getSelectedRecordingUrl() }));
      await this.setCameraVideo('recording', this.homey.__('widget.recordings.video_title'), video);
      this.recordingVideo = video;
    })().finally(() => { this.recordingVideoPromise = null; });
    return this.recordingVideoPromise;
  }

  async selectWidgetRecording(token) {
    const recording = this.recordingTokens.get(String(token || ''));
    if (!recording || recording.expiresAt <= Date.now()) {
      throw new Error(this.homey.__('widget.recordings.selection_expired'));
    }
    if (String(recording.codec || '').toUpperCase().includes('265')) {
      throw new Error(this.homey.__('widget.recordings.h265_unsupported'));
    }
    this.selectedRecording = recording;
    await this.ensureRecordingVideo();
    return { success: true, startTime: recording.startTime, endTime: recording.endTime };
  }

  async getBugReport() {
    const parent = this.requireParent();
    const result = await parent.getBugReport();
    const report = JSON.parse(result.report);
    const rtsp = await parent.getRtspDiagnostics(
      this.channelId,
      this.videoProfile?.streamId,
    );
    report.reportType = 'Hikvision NVR channel bug report';
    report.driver = { id: 'hikvision-nvr-channel', connection: 'shared-parent-nvr' };
    report.device = {
      parentIdHash: hashPrivateValue(this.parentId),
      channelId: this.channelId,
    };
    report.channelDiagnostics = {
      connected: this.connectionState,
      eventMonitoringEnabled: this.eventMonitoringState,
      videoProfile: this.videoProfile,
      resources: {
        cameraImages: this.cameraImage ? 1 : 0,
        cameraVideos: (this.cameraVideo ? 1 : 0) + (this.recordingVideo ? 1 : 0),
        flowSnapshotImages: this.flowSnapshotImages.size,
      },
      rtsp,
    };
    return { success: true, report: JSON.stringify(sanitizeForBugReport(report), null, 2) };
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('motion_hold_seconds')
      && (!Number.isInteger(newSettings.motion_hold_seconds)
        || newSettings.motion_hold_seconds < 1
        || newSettings.motion_hold_seconds > 300)) {
      throw new Error(this.homey.__('errors.invalid_motion_hold'));
    }
    if (changedKeys.includes('live_stream') || changedKeys.includes('video_transport')) {
      await this.recreateCameraVideo();
    }
  }

  async dispose() {
    if (this.parentRetryTimer) clearTimeout(this.parentRetryTimer);
    this.parentRetryTimer = null;
    this.unsubscribeParent?.();
    this.unsubscribeParent = null;
    this.parentDevice = null;
    if (this.motionAlarmTimer) clearTimeout(this.motionAlarmTimer);
    if (this.cameraImageTimer) clearInterval(this.cameraImageTimer);
    this.cameraImageTimer = null;
    if (this.cameraImage) await this.cameraImage.unregister().catch(this.error);
    if (this.cameraVideo) await this.cameraVideo.unregister().catch(this.error);
    if (this.recordingVideo) await this.recordingVideo.unregister().catch(this.error);
    for (const timer of this.flowSnapshotCleanupTimers.values()) clearTimeout(timer);
    await Promise.all([...this.flowSnapshotImages].map(image => image.unregister().catch(this.error)));
    this.flowSnapshotCleanupTimers.clear();
    this.flowSnapshotImages.clear();
    this.recordingTokens.clear();
  }

  async onDeleted() {
    await this.dispose();
  }

  async onUninit() {
    await this.dispose();
  }
}

module.exports = HikvisionNvrChannelDevice;
