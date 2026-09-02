'use strict';

const Homey = require('homey');

class HikvisionApp extends Homey.App {
  async onInit() {
    this.log('Hikvision initialized');
  }
}

module.exports = HikvisionApp;
