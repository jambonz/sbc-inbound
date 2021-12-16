const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
const dns = require('dns');

module.exports = (srf, logger) => {
  const {retrieveSet, createSet} = srf.locals.realtimeDbHelpers;
  let idx = 0;

  if ('test' === process.env.NODE_ENV) {
    createSet(setName, [process.env.JAMBONES_FEATURE_SERVERS]);
  }

  return async() => {
    if (process.env.K8S) {
      const name = process.env.K8S_FEATURE_SERVER_SIP_SERVICE_NAME || 'feature-server-sip';
      return new Promise((resolve, reject) => {
        dns.resolve(`_sip._udp.${name}`, 'SRV', (err, results) => {
          if (err) {
            logger.info({err}, `No SRV records found for ${name}, check for A records..`);
            dns.resolve(this.domain, 'A', (err, results) => {
              if (err) {
                this.logger.info({err}, `No A records found for ${this.domain} either`);
                return reject(err);
              }
              logger.results({results}, 'found A records');
              resolve(name);
            });
          }
          logger.results({results}, 'found SRV records');
          resolve(name);
        });
      });
    }
    try {
      const fs = await retrieveSet(setName);
      if (0 === fs.length) {
        logger.info('No available feature servers to handle incoming call');
        return;
      }
      logger.debug({fs}, `retrieved ${setName}`);
      return fs[idx++ % fs.length];
    } catch (err) {
      logger.error({err}, `Error retrieving ${setName}`);
    }
  };
};
