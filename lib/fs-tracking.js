const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;

module.exports = (srf, logger) => {
  const {retrieveSet, createSet} = srf.locals.realtimeDbHelpers;
  let idx = 0;

  if ('test' === process.env.NODE_ENV) {
    createSet(setName, [process.env.JAMBONES_FEATURE_SERVERS]);
  }

  return async() => {
    try {
      const fs = await retrieveSet(setName);
      if (0 === fs.length) {
        logger.info('No available feature servers to handle incoming call');
        return;
      }
      return fs[idx++ % fs.length];
    } catch (err) {
      logger.error({err}, `Error retrieving ${setName}`);
    }
  };
};
