'use strict';

const Assert = require('assert');
const Writable = require('stream').Writable;
const Logging = require('@google-cloud/logging');
const Moment = require('moment');
const QS = require('querystring');
const Util = require('util');

const internals = {};

internals.msToNs = function (ms) {

  return {
    seconds: Math.floor(ms / 1000),
    nanos: Math.round(ms % 1000) * 1000000
  };
};


internals.getSeverity = function (tags) {

  let filtered = tags.map((tag) => {

    return tag.toLowerCase();
  }).filter((tag) => {

    return ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(tag);
  });

  return (filtered.length ? filtered[0] : 'info').toUpperCase();
};


exports.register = function (server, options, next) {

  server.on('response', function (request) {

    if (request.headers['x-forwarded-for']) {
      request.info.remoteAddress = request.headers['x-forwarded-for'].split(',').shift().trim();
    }

    if (!request.route.settings.plugins.good) {
      request.route.settings.plugins.good = {};
    }

    Object.assign(request.route.settings.plugins.good, {
      path: request.raw.req.url,
      requestSize: request.headers['content-length'] || 0,
      responseSize: request.response.headers['content-length'] || 0
    });
  });

  server.on('request-error', function (request) {

    if (request.headers['x-forwarded-for']) {
      request.info.remoteAddress = request.headers['x-forwarded-for'].split(',').shift().trim();
    }

    if (!request.route.settings.plugins.good) {
      request.route.settings.plugins.good = {};
    }

    Object.assign(request.route.settings.plugins.good, {
      url: request.raw.req.url,
      userAgent: request.headers['user-agent'],
      referrer: request.info.referrer,
      responseStatusCode: request.response.statusCode,
      remoteIp: request.info.remoteAddress
    });
  });

  next();
};


exports.register.attributes = {
  pkg: require('../package.json')
};


exports.Logger = class extends Writable {
  constructor(options = {}) {

    super({ objectMode: true });
    Assert(typeof options.name === 'string' && options.name !== '', 'name must be a string');
    this.name = options.name;

    if (typeof options.resource === 'object' && options.resource.hasOwnProperty('type')) {
      this.resource = options.resource;
    }
    else if (typeof options.project_id === 'string' && options.project_id !== '') {
      this.resource = {
        type: 'global',
        labels: {
          project_id: this.project_id
        }
      };
    }
    else if (process.env.GCLOUD_PROJECT !== '') {
      this.resource = {
        type: 'global',
        labels: {
          project_id: process.env.GCLOUD_PROJECT
        }
      };
    }

    Assert(typeof this.resource === 'object', `must specify one of 'resource', 'project_id' or export GCLOUD_PROJECT`);

    this.logger = Logging(options.auth).log(this.name, { removeCircular: true });
  }

  _formatEntry(data) {

    let severity = 'INFO';
    let entry;

    if (data.event === 'response') {
      if (data.statusCode >= 400) {
        severity = 'WARNING';
      }

      if (data.statusCode >= 500) {
        severity = 'ERROR';
      }

      const method = data.method.toUpperCase();

      entry = this.logger.entry({
        severity,
        timestamp: new Date(data.timestamp),
        httpRequest: {
          requestMethod: method,
          requestUrl: `${data.instance}${data.config.path}`,
          requestSize: `${data.config.requestSize}`,
          responseSize: `${data.config.responseSize}`,
          status: data.statusCode,
          userAgent: data.source.userAgent,
          remoteIp: data.source.remoteAddress,
          referer: data.source.referer,
          latency: internals.msToNs(data.responseSentTime)
        },
        labels: data.labels.reduce((label, accum) => {

          accum[label] = true;
          return accum;
        }, {}),
        operation: {
          id: data.id,
          producer: this.name
        },
        resource: this.resource
      }, `${data.source.remoteAddress} - - [${Moment(data.timestamp).format('DD/MMM/YYYY:HH:mm:ss ZZ')}] "${method} ${data.path}" ${data.statusCode} ${data.config.responseSize}`);
    }
    else if (data.event === 'request') {
      // request.log()
      severity = internals.getSeverity(data.tags);

      entry = this.logger.entry({
        severity,
        timestamp: new Date(data.timestamp),
        operation: {
          id: data.id,
          producer: this.name
        },
        resource: this.resource
      }, data.data);
    }
    else if (data.event === 'log') {
      // server.log()
      severity = internals.getSeverity(data.tags);

      entry = this.logger.entry({
        severity,
        timestamp: new Date(data.timestamp),
        operation: {
          producer: this.name
        },
        resource: this.resource
      }, data.data);
    }
    else if (data.event === 'error') {
      // server emitted error
      severity = 'error';

      entry = this.logger.entry({
        severity,
        timestamp: new Date(data.timestamp),
        operation: {
          id: data.id,
          producer: this.name
        },
        resource: this.resource
      }, {
        message: data.error.stack,
        serviceContext: {
          service: this.name
        },
        context: {
          httpRequest: {
            method: data.method.toUpperCase(),
            url: data.config.url,
            userAgent: data.config.userAgent,
            referrer: data.config.referrer,
            responseStatusCode: data.config.responseStatusCode,
            remoteIp: data.config.remoteIp
          }
        }
      });
    }
    else if (data.event === 'ops') {
      // events from oppsy
      severity = 'debug';

      entry = this.logger.entry({
        severity,
        timestamp: new Date(data.timestamp),
        operation: {
          producer: this.name
        },
        resource: this.resource
      }, {
        os: data.os,
        proc: data.proc,
        load: data.load
      });
    }
    else {
      // extension related events
      entry = this.logger.entry({
        severity,
        timestamp: new Date(data.timestamp),
        labels: {
          event: data.event
        },
        operation: {
          producer: this.name
        },
        resource: this.resource
      }, data.payload);
    }

    return entry;
  }

  _write(data, encoding, next) {

    if (data.event === 'response' &&
        data.source.userAgent &&
        data.source.userAgent.startsWith('GoogleHC')) {

      return next();
    }

    const entry = this._formatEntry(data);

    this.logger.write(entry, (err) => {

      if (err) {
        // if it crashes, just dump it to the console
        // after all, where else are we going to put it?
        console.error('---');
        console.error(err.stack);
        console.error(Util.inspect(entry, { depth: null }));
        console.error('---');
      }

      return next();
    });
  }

  _writev(chunks, next) {

    const entries = chunks.map((chunk) => {

      return this._formatEntry(chunk);
    });

    this.logger.write(entries, (err) => {

      if (err) {
        // if it crashes, just dump it to the console
        // after all, where else are we going to put it?
        console.error(err.stack);
      }

      return next();
    });
  }
}
