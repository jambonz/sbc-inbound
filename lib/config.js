const assert = require('assert');

const requiredEnvVars = [
  'JAMBONES_MYSQL_HOST',
  'JAMBONES_MYSQL_USER',
  'JAMBONES_MYSQL_PASSWORD',
  'JAMBONES_MYSQL_DATABASE',
  'DRACHTIO_SECRET',
  'JAMBONES_TIME_SERIES_HOST'
];

if (process.env.JAMBONES_REDIS_SENTINELS) {
  requiredEnvVars.push('JAMBONES_REDIS_SENTINEL_MASTER_NAME');
} else {
  requiredEnvVars.push('JAMBONES_REDIS_HOST');
}

if (process.env.DRACHTIO_HOST || process.env.DRACHTIO_PORT) {
  requiredEnvVars.push(process.env.DRACHTIO_HOST ? 'DRACHTIO_HOST' : 'DRACHTIO_PORT');
}

if (process.env.DRACHTIO_HOST && !process.env.K8S) {
  assert.ok(process.env.JAMBONES_NETWORK_CIDR,
    'Missing JAMBONES_NETWORK_CIDR env var (required when DRACHTIO_HOST is set and not in K8S)');
} else if (process.env.K8S && process.env.K8S_FEATURE_SERVER_SERVICE_NAME) {
  requiredEnvVars.push('K8S');
  requiredEnvVars.push('K8S_FEATURE_SERVER_SERVICE_NAME');
} else {
  assert.ok(process.env.K8S && !process.env.K8S_FEATURE_SERVER_SERVICE_NAME,
    'when running in Kubernetes, an env var K8S_FEATURE_SERVER_SERVICE_NAME is required');
}

const validateEnvVars = () => {
  requiredEnvVars.forEach((envVar) => {
    assert.ok(process.env[envVar], `Missing ${envVar} env var`);
  });
};

module.exports = {
  validateEnvVars
};