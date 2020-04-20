const contacts = new Map();
const noopLogger = {info: () => {}, error: () => {}};
const debug = require('debug')('jambonz:sbc-inbound');

module.exports = (srf, logger) => {
  logger = logger || noopLogger;
  let dynamic = true;
  let idx = 0;
  const stats = srf.locals.stats;
  const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;

  const {createSet} = require('jambonz-realtimedb-helpers')({
    host: process.env.JAMBONES_REDIS_HOST || 'localhost',
    port: process.env.JAMBONES_REDIS_PORT || 6379
  }, logger);

  srf.options((req, res) => {
    res.send(200);
    if (req.has('X-FS-Status')) {
      const uri = `${req.source_address}:${req.source_port}`;
      const status = req.get('X-FS-Status');
      const calls = req.has('X-FS-Calls') ? parseInt(req.get('X-FS-Calls')) : 0;
      if (status === 'open') {
        if (!contacts.has(uri)) {
          logger.info(`adding feature server at ${uri}`);
          stats.gauge('sbc.featureservers.count', contacts.size + 1);
          const featureServerIps = [...contacts.keys()].map((uri) => {
            const arr = /^(.*):\d+$/.exec(uri);
            return arr[1];
          });
          createSet(setName, new Set(featureServerIps));
        }
        debug(`Feature server at ${uri} has ${calls} calls`);
        contacts.set(uri, {pingTime: new Date(), calls: calls});
      }
      else {
        if (contacts.has(uri)) {
          logger.info(`removing feature server at ${uri}`);
          contacts.delete(uri);
          stats.gauge('sbc.featureservers.count', contacts.size);
          const featureServerIps = [...contacts.keys()].map((uri) => {
            const arr = /^$(.*):\d+$/.exec(uri);
            return arr[1];
          });
          createSet(setName, new Set(featureServerIps));
        }
      }
    }
  });

  if (process.env.JAMBONES_FEATURE_SERVERS) {
    dynamic = false;
    process.env.JAMBONES_FEATURE_SERVERS
      .split(',')
      .map((hp) => hp.trim())
      .forEach((uri) => contacts.set(uri, {active: 0, calls: 0}));
    debug(`using static list of feature servers: ${[ ...contacts]}`);
  }

  if (dynamic) {
    const CHECK_INTERVAL = 35;
    setInterval(() => {
      const dead = [];
      const deadline = Date.now() - 90000;
      for (const obj of contacts) {
        if (obj[1].pingTime.getTime() < deadline) dead.push(obj[0]);
      }
      dead.forEach((uri) => {
        logger.info(`removing feature server at ${uri} due to lack of OPTIONS ping`);
        contacts.delete(uri);
      });

      const keys = [ ...contacts.keys() ];
      debug({keys}, `there are ${keys.length} feature servers online`);
      stats.gauge('sbc.featureservers.count', contacts.size);
    }, CHECK_INTERVAL * 1000);
  }

  return () => {
    let selectedUri;

    if (dynamic) {
      const featureServers = [ ...contacts].map((o) => Object.assign({}, {uri: o[0]}, o[1]));
      debug({featureServers}, 'selecting feature servers with least calls');
      const fs = featureServers.sort((a, b) => (a.calls - b.calls)).shift();
      if (!fs) logger.info('No available feature servers!');
      else selectedUri = fs.uri;
    }
    else {
      const featureServers = [ ...contacts].map((o) => o[0]);
      debug({featureServers}, 'selecting feature servers from static list');
      selectedUri = featureServers[idx++ % featureServers.length];
      debug(`selected ${selectedUri}`);
    }
    return selectedUri;
  };
};
