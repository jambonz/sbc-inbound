const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
const assert = require('assert');

assert.ok(!process.env.K8S || process.env.K8S_FEATURE_SERVER_SERVICE_NAME,
  'when running in Kubernetes, an env var K8S_FEATURE_SERVER_SERVICE_NAME is required');

module.exports = (srf, logger) => {
  const {retrieveSet, createSet} = srf.locals.realtimeDbHelpers;
  let idx = 0;

  if ('test' === process.env.NODE_ENV) {
    createSet(setName, [process.env.JAMBONES_FEATURE_SERVERS]);
  }

  return async() => {
    try {
      if (process.env.K8S) {
        return process.env.K8S_FEATURE_SERVER_TRANSPORT ?
          `${process.env.K8S_FEATURE_SERVER_SERVICE_NAME};transport=${process.env.K8S_FEATURE_SERVER_TRANSPORT}` :
          process.env.K8S_FEATURE_SERVER_SERVICE_NAME;
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
