const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
if (process.env.JAMBONES_REDIS_SENTINELS) {
  assert.ok(process.env.JAMBONES_REDIS_SENTINEL_MASTER_NAME,
    'missing JAMBONES_REDIS_SENTINEL_MASTER_NAME env var, JAMBONES_REDIS_SENTINEL_PASSWORD env var is optional');
} else {
  assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
}
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env vars');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR || process.env.K8S, 'missing JAMBONES_NETWORK_CIDR env var');

const Srf = require('drachtio-srf');
const srf = new Srf('sbc-inbound');
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const {
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: process.env.JAMBONES_TIME_SERIES_HOST,
  port: process.env.JAMBONES_TIME_SERIES_PORT || 8086,
  commitSize: 50,
  commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
});
const StatsCollector = require('@jambonz/stats-collector');
const CIDRMatcher = require('cidr-matcher');
const stats = new StatsCollector(logger);
const {equalsIgnoreOrder, createHealthCheckApp, systemHealth, parseHostPorts} = require('./lib/utils');
const {LifeCycleEvents} = require('./lib/constants');
const setNameRtp = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
const rtpServers = [];
const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-sip`;

const {
  pool,
  ping,
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress,
  addSbcAddress,
  lookupAccountByPhoneNumber,
  lookupAppByTeamsTenant,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid,
  queryCallLimits,
  lookupClientByAccountAndUsername,
  lookupSystemInformation
} = require('@jambonz/db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  port: process.env.JAMBONES_MYSQL_PORT || 3306,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
const {
  client: redisClient,
  createSet,
  retrieveSet,
  addToSet,
  removeFromSet,
  incrKey,
  decrKey} = require('@jambonz/realtimedb-helpers')({}, logger);

const ngProtocol = process.env.JAMBONES_NG_PROTOCOL || 'udp';
const ngPort = process.env.RTPENGINE_PORT || ('udp' === ngProtocol ? 22222 : 8080);
const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, {
  //emitter: stats,
  dtmfListenPort: process.env.DTMF_LISTEN_PORT || 22224,
  protocol: ngProtocol
});
srf.locals = {...srf.locals,
  stats,
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType,
  activeCallIds: new Map(),
  getRtpEngine,
  privateNetworkCidr: process.env.PRIVATE_VOIP_NETWORK_CIDR || null,
  dbHelpers: {
    pool,
    ping,
    lookupAuthHook,
    lookupSipGatewayBySignalingAddress,
    lookupAccountByPhoneNumber,
    lookupAppByTeamsTenant,
    lookupAccountBySid,
    lookupAccountBySipRealm,
    lookupAccountCapacitiesBySid,
    queryCallLimits,
    lookupClientByAccountAndUsername,
    lookupSystemInformation
  },
  realtimeDbHelpers: {
    createSet,
    incrKey,
    decrKey,
    retrieveSet
  }
};
const {
  getSPForAccount,
  wasOriginatedFromCarrier,
  getApplicationForDidAndCarrier,
  getOutboundGatewayForRefer,
  getApplicationBySid
} = require('./lib/db-utils')(srf, logger);
srf.locals = {
  ...srf.locals,
  getSPForAccount,
  wasOriginatedFromCarrier,
  getApplicationForDidAndCarrier,
  getOutboundGatewayForRefer,
  getFeatureServer: require('./lib/fs-tracking')(srf, logger),
  getApplicationBySid
};
const activeCallIds = srf.locals.activeCallIds;

const {
  initLocals,
  handleSipRec,
  identifyAccount,
  checkLimits,
  challengeDeviceCalls
} = require('./lib/middleware')(srf, logger);
const CallSession = require('./lib/call-session');

if (process.env.DRACHTIO_HOST && !process.env.K8S) {
  const cidrs = process.env.JAMBONES_NETWORK_CIDR
    .split(',')
    .map((s) => s.trim());
  const matcher = new CIDRMatcher(cidrs);

  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp, version, localHostports) => {
    if (err) return this.logger.error({err}, 'Error connecting to drachtio server');
    let addedPrivateIp = false;
    logger.info(`connected to drachtio ${version} listening on ${hp}, local hostports: ${localHostports}`);

    const hostports = hp.split(',');

    if (localHostports) {
      const locals = localHostports.split(',');
      for (const hp of locals) {
        const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
        if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
          const hostport = `${arr[2]}:${arr[3]}`;
          logger.info(`adding sbc private address to redis: ${hostport}`);
          srf.locals.privateSipAddress = hostport;
          srf.locals.addToRedis = () => addToSet(setName, hostport);
          srf.locals.removeFromRedis = () => removeFromSet(setName, hostport);
          srf.locals.addToRedis();
          addedPrivateIp = true;
        }
      }
    }
    for (const hp of hostports) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
      if (arr && 'udp' === arr[1] && !matcher.contains(arr[2])) {
        logger.info(`adding sbc public address to database: ${arr[2]}`);
        srf.locals.sipAddress = arr[2];
        if (!process.env.SBC_ACCOUNT_SID) addSbcAddress(arr[2]);
      }
      else if (!addedPrivateIp && arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        logger.info(`adding sbc private address to redis: ${hostport}`);
        srf.locals.privateSipAddress = hostport;
        srf.locals.addToRedis = () => addToSet(setName, hostport);
        srf.locals.removeFromRedis = () => removeFromSet(setName, hostport);
        srf.locals.addToRedis();
      }
    }
    srf.locals.sbcPublicIpAddress = parseHostPorts(logger, hostports, srf);
  });
}
else {
  srf.on('listening', () => {
    logger.info(`listening in outbound mode on port ${process.env.DRACHTIO_PORT}`);
  });
  srf.listen({port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
  srf.on('connect', (err, hp, version, localHostports) => {
    if (err) return this.logger.error({err}, 'Error connecting to drachtio server');
    logger.info(`connected to drachtio ${version} listening on ${hp}, local hostports: ${localHostports}`);

    if (process.env.K8S_FEATURE_SERVER_TRANSPORT === 'tcp') {
      const matcher = new CIDRMatcher(['192.168.0.0/24', '172.16.0.0/16', '10.0.0.0/8']);
      const hostports = localHostports ? localHostports.split(',') : hp.split(',');
      for (const hp of hostports) {
        const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
        if (arr && matcher.contains(arr[2])) {
          const hostport = `${arr[2]}:${arr[3]}`;
          logger.info(`using sbc private address when sending to feature-server: ${hostport}`);
          srf.locals.privateSipAddress = hostport;
        }
      }
    }
    srf.locals.sbcPublicIpAddress = parseHostPorts(logger, hp, srf);
  });
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

/* install middleware */
srf.use('invite', [
  initLocals,
  handleSipRec,
  identifyAccount,
  checkLimits,
  challengeDeviceCalls
]);

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

if (process.env.K8S || process.env.HTTP_PORT) {
  const PORT = process.env.HTTP_PORT || 3000;
  const healthCheck = require('@jambonz/http-health-check');

  const getCount = () => srf.locals.activeCallIds.size;

  createHealthCheckApp(PORT, logger)
    .then((app) => {
      healthCheck({
        app,
        logger,
        path: '/',
        fn: getCount
      });
      healthCheck({
        app,
        logger,
        path: '/system-health',
        fn: systemHealth.bind(null, redisClient, ping, getCount)
      });
      return;
    })
    .catch((err) => {
      logger.error({err}, 'Error creating health check server');
    });
}
if ('test' !== process.env.NODE_ENV) {
  /* update call stats periodically as well as definition of private network cidr */
  setInterval(async() => {
    stats.gauge('sbc.sip.calls.count', activeCallIds.size,
      ['direction:inbound', `instance_id:${process.env.INSTANCE_ID || 0}`]);

    const r = await lookupSystemInformation();
    if (r) {
      if (r.private_network_cidr !== srf.locals.privateNetworkCidr) {
        logger.info(`updating private network cidr from ${srf.locals.privateNetworkCidr} to ${r.private_network_cidr}`);
        srf.locals.privateNetworkCidr = r.private_network_cidr;
      }
      if (r.log_level) {
        logger.level = r.log_level;
      }
    }
  }, 20000);
}

const lookupRtpServiceEndpoints = (lookup, serviceName) => {
  lookup(serviceName, {family: 4, all: true}, (err, addresses) => {
    if (err) {
      logger.error({err}, `Error looking up ${serviceName}`);
      return;
    }
    logger.debug({addresses, rtpServers}, `dns lookup for ${serviceName} returned`);
    const addrs = addresses.map((a) => a.address);
    if (!equalsIgnoreOrder(addrs, rtpServers)) {
      rtpServers.length = 0;
      Array.prototype.push.apply(rtpServers, addrs);
      logger.info({rtpServers}, 'rtpserver endpoints have been updated');
      setRtpEngines(rtpServers.map((a) => `${a}:${ngPort}`));
    }
  });
};

if (process.env.K8S_RTPENGINE_SERVICE_NAME) {
  /* poll dns for endpoints every so often */
  const arr = /^(.*):(\d+)$/.exec(process.env.K8S_RTPENGINE_SERVICE_NAME);
  const svc = arr[1];
  logger.info(`rtpengine(s) will be found at dns name: ${svc}`);
  const {lookup} = require('dns');
  lookupRtpServiceEndpoints(lookup, svc);
  setInterval(lookupRtpServiceEndpoints.bind(null, lookup, svc), process.env.RTPENGINE_DNS_POLL_INTERVAL || 10000);
}
else if (process.env.JAMBONES_RTPENGINES) {
  /* static list of rtpengines */
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
}
else {
  /* poll redis periodically for rtpengines that have registered via OPTIONS ping */
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set);
      logger.debug({newArray, rtpServers}, 'getActiveRtpServers');
      if (!equalsIgnoreOrder(newArray, rtpServers)) {
        logger.info({newArray}, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${ngPort}`));
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

const {lifecycleEmitter} = require('./lib/autoscale-manager')(logger);

/* if we are scaling in, check every so often if call count has gone to zero */
setInterval(async() => {
  if (lifecycleEmitter.operationalState === LifeCycleEvents.ScaleIn) {
    if (0 === activeCallIds.size) {
      logger.info('scale-in complete now that calls have dried up');
      lifecycleEmitter.scaleIn();
    }
  }
}, 20000);

process.on('SIGUSR2', handle.bind(null, removeFromSet, setName));
process.on('SIGTERM', handle.bind(null, removeFromSet, setName));

function handle(removeFromSet, setName, signal) {
  logger.info(`got signal ${signal}`);
  if (srf.locals.privateSipAddress && setName) {
    logger.info(`removing ${srf.locals.privateSipAddress} from set ${setName}`);
    removeFromSet(setName, srf.locals.privateSipAddress);
  }
  if (process.env.K8S) {
    lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;
    if (0 === activeCallIds.size) {
      logger.info('exiting immediately since we have no calls in progress');
      process.exit(0);
    }
  }
}

module.exports = {srf, logger};
