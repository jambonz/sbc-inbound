const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_RTPENGINES, 'missing DRACHTIO_SECRET env var');

const Srf = require('drachtio-srf');
const srf = new Srf();
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const StatsCollector = require('jambonz-stats-collector');
const stats = srf.locals.stats = new StatsCollector(logger);
srf.locals.getFeatureServer = require('./lib/fs-tracking')(srf, logger);
const {getRtpEngine} = require('jambonz-rtpengine-utils')(process.env.JAMBONES_RTPENGINES.split(','), {
  emitter: srf.locals.stats
});
srf.locals.getRtpEngine = getRtpEngine;
const activeCallIds = srf.locals.activeCallIds = new Set();
logger.info('starting..');

const {
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress
} = require('jambonz-db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);

srf.locals.dbHelpers = {
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress
};
const {challengeDeviceCalls, initLocals} = require('./lib/middleware')(srf, logger);
const CallSession = require('./lib/call-session');

if (process.env.DRACHTIO_HOST) {
  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);
  });
}
else {
  srf.listen({port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

// challenge calls from devices, let calls from sip gateways through
srf.use('invite', [initLocals, challengeDeviceCalls]);

srf.invite((req, res) => {
  const session = new CallSession(logger, req, res);
  session.connect();
});

srf.use((req, res, next, err) => {
  logger.error(err, 'hit top-level error handler');
  res.send(500);
});

setInterval(() => {
  stats.gauge('sbc.sip.calls.count', activeCallIds.size, ['direction:inbound']);
}, 3000);

module.exports = {srf, logger};
