const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
const { Resolver } = require('dns').promises;
const resolver = new Resolver();
resolver.setServers(['127.0.0.1']);

module.exports = (srf, logger) => {
  const {retrieveSet, createSet} = srf.locals.realtimeDbHelpers;
  let idx = 0;

  if ('test' === process.env.NODE_ENV) {
    createSet(setName, [process.env.JAMBONES_FEATURE_SERVERS]);
  }

  return async() => {
    try {
      if (process.env.K8S) {
        const name = process.env.K8S_FEATURE_SERVER_SIP_SERVICE_NAME || 'feature-server-sip';
        let results = resolver.resolveSrv(`_sip._udp.${name}`);
        logger.info({results}, `resolved SRV for _sip._udp.${name}`);
        if (!results) {
          results = resolver.resolve4(name);
          logger.info({results}, `resolved A for ${name}`);
        }
        return name;
      }
      else {
        const fs = await retrieveSet(setName);
        if (0 === fs.length) {
          logger.info('No available feature servers to handle incoming call');
          return;
        }
        logger.debug({fs}, `retrieved ${setName}`);
        return fs[idx++ % fs.length];
      }
    } catch (err) {
      logger.error({err}, `Error retrieving ${setName}`);
    }
  };
};
