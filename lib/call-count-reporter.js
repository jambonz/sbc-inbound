const os = require('os');

/**
 * Periodically report this process's count of calls in progress to redis.
 * A server may host several sbc-inbound and sbc-outbound processes; when one
 * of them handles an autoscale drain it needs to know when the entire server
 * has no calls in progress, not just its own process.  Each process writes
 * its own count under a per-pid key (with a short expiry, so keys from dead
 * processes evaporate) and registers that key in a per-host set that the
 * draining process can enumerate.
 */
const REPORT_INTERVAL = 15000;
const KEY_EXPIRY_SECS = 120;

module.exports = ({logger, addKey, addToSet, getCount}) => {
  const prefix = process.env.JAMBONES_CLUSTER_ID || 'default';
  const setName = `${prefix}:call-count-keys:${os.hostname()}`;
  const key = `${prefix}:call-count:${os.hostname()}:${process.pid}`;

  const report = () => {
    addKey(key, `${getCount()}`, KEY_EXPIRY_SECS)
      .catch((err) => logger.error({err}, 'call-count-reporter: error writing call count'));
  };

  addToSet(setName, key)
    .catch((err) => logger.error({err}, `call-count-reporter: error adding ${key} to ${setName}`));
  setInterval(report, REPORT_INTERVAL);
  report();

  return {key, setName};
};
