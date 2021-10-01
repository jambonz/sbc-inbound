const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR, 'missing JAMBONES_NETWORK_CIDR env var');
const Srf = require('drachtio-srf');
const srf = new Srf('sbc-inbound');
const CIDRMatcher = require('cidr-matcher');
const matcher = new CIDRMatcher([process.env.JAMBONES_NETWORK_CIDR]);
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const {
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: process.env.JAMBONES_TIME_SERIES_HOST,
  commitSize: 50,
  commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
});
const StatsCollector = require('@jambonz/stats-collector');
const stats = new StatsCollector(logger);
const setNameRtp = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
const rtpServers = [];
const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-sip`;

const {
  pool,
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress,
  addSbcAddress,
  lookupAccountByPhoneNumber,
  lookupAppByTeamsTenant,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid
} = require('@jambonz/db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
const {createSet, retrieveSet, addToSet, incrKey, decrKey} = require('@jambonz/realtimedb-helpers')({
  host: process.env.JAMBONES_REDIS_HOST || 'localhost',
  port: process.env.JAMBONES_REDIS_PORT || 6379
}, logger);

const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, {emitter: stats});
srf.locals = {...srf.locals,
  stats,
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType,
  activeCallIds: new Map(),
  getRtpEngine,
  dbHelpers: {
    pool,
    lookupAuthHook,
    lookupSipGatewayBySignalingAddress,
    lookupAccountByPhoneNumber,
    lookupAppByTeamsTenant,
    lookupAccountBySid,
    lookupAccountBySipRealm,
    lookupAccountCapacitiesBySid
  },
  realtimeDbHelpers: {
    createSet,
    incrKey,
    decrKey,
    retrieveSet
  }
};
srf.locals.getFeatureServer = require('./lib/fs-tracking')(srf, logger);
const activeCallIds = srf.locals.activeCallIds;

const {
  initLocals,
  identifyAccount,
  checkLimits,
  challengeDeviceCalls
} = require('./lib/middleware')(srf, logger);
const CallSession = require('./lib/call-session');

if (process.env.DRACHTIO_HOST) {
  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    if (err) return this.logger.error({err}, 'Error connecting to drachtio server');
    logger.info(`connected to drachtio listening on ${hp}`);
    if (process.env.SBC_ACCOUNT_SID) return;

    const hostports = hp.split(',');
    for (const hp of hostports) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
      if (arr && 'udp' === arr[1] && !matcher.contains(arr[2])) {
        logger.info(`adding sbc public address to database: ${arr[2]}`);
        srf.locals.sipAddress = arr[2];
        addSbcAddress(arr[2]);
      }
      else if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        logger.info(`adding sbc private address to redis: ${hostport}`);
        addToSet(setName, hostport);
      }
    }
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

/* install middleware */
srf.use('invite', [initLocals, identifyAccount, checkLimits, challengeDeviceCalls]);

srf.invite((req, res) => {
  if (req.has('Replaces')) {
    const arr = /^(.*);from/.exec(req.get('Replaces'));
    if (arr) logger.info(`replacing call-id ${arr}`);
    else logger.info(`failed parsing ${req.get('Replaces')}`);
    const session = arr ? activeCallIds.get(arr[1]) : null;
    if (!session) {
      logger.info(`failed to find session in Replaces header: ${req.has('Replaces')}`);
      return res.send(404);
    }
    return session.replaces(req, res);
  }
  const session = new CallSession(logger, req, res);
  session.connect();
});

srf.use((req, res, next, err) => {
  logger.error(err, 'hit top-level error handler');
  res.send(500);
});

/* update call stats periodically */
setInterval(() => {
  stats.gauge('sbc.sip.calls.count', activeCallIds.size, ['direction:inbound']);
}, 20000);

const arrayCompare = (a, b) => {
  if (a.length !== b.length) return false;
  const uniqueValues = new Set([...a, ...b]);
  for (const v of uniqueValues) {
    const aCount = a.filter((e) => e === v).length;
    const bCount = b.filter((e) => e === v).length;
    if (aCount !== bCount) return false;
  }
  return true;
};

/* update rtpengines periodically */
if (process.env.JAMBONES_RTPENGINES) {
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
}
else {
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set);
      logger.debug({newArray, rtpServers}, 'getActiveRtpServers');
      if (!arrayCompare(newArray, rtpServers)) {
        logger.info({newArray}, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${process.env.RTPENGINE_PORT || 22222}`));
        rtpServers.length = 0;
        Array.prototype.push.apply(rtpServers, newArray);
      }
    } catch (err) {
      logger.error({err}, 'Error setting new rtpengines');
    }
  };

  setInterval(() => {
    getActiveRtpServers();
  }, 30000);
  getActiveRtpServers();
}

module.exports = {srf, logger};
