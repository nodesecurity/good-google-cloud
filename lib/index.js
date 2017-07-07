'use strict';

const Assert = require('assert');
const Writable = require('stream').Writable;
const Logging = require('@google-cloud/logging');
const Moment = require('moment');
const QS = require('querystring');

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
  
  return filtered.length ? filtered[0] : 'info';
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
      path: request.raw.req.url || '/',
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
      url: request.raw.req.url || '/',
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

  _write(data, encoding, next) {

    let level = 'info';
    let entry;

    if (data.event === 'response') {
      // request responses
      if (data.source.userAgent && data.source.userAgent.startsWith('GoogleHC')) {
        return next();
      }

      if (data.statusCode >= 400) {
        level = 'warning';
      }

      if (data.statusCode >= 500) {
        level = 'error';
      }

      const method = data.method.toUpperCase();

      entry = this.logger.entry({
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
          latency: internals.msToNs(data.responseSentTime || data.responseTime)
        },
        labels: data.labels.reduce((accum, label) => {

          accum[label] = "true";
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
      level = internals.getSeverity(data.tags);

      entry = this.logger.entry({
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
      level = internals.getSeverity(data.tags);

      entry = this.logger.entry({
        timestamp: new Date(data.timestamp),
        operation: {
          producer: this.name
        },
        resource: this.resource
      }, data.data);
    }
    else if (data.event === 'error') {
      // server emitted error
      level = 'error';

      entry = this.logger.entry({
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
      level = 'debug';

      entry = this.logger.entry({
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

    this.logger[level](entry).then((response) => {

      next();
    }).catch((err) => {

      // if it crashes, just dump it to the console
      // after all, where else are we going to put it?
      console.error(err.stack);
      next();
    });
  }
}
