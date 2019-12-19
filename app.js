const Srf = require('drachtio-srf');
const srf = new Srf();
const config = require('config');
const logger = require('pino')(config.get('logging'));
const {
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress
} = require('jambonz-db-helpers')(config.get('mysql'), logger);
srf.locals.dbHelpers = {
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress
};
const {challengeDeviceCalls} = require('./lib/middleware')(srf, logger);
const CallSession = require('./lib/call-session');

// disable logging in test mode
if (process.env.NODE_ENV === 'test') {
  const noop = () => {};
  logger.info = logger.debug = noop;
  logger.child = () => {return {info: noop, error: noop, debug: noop};};
}

// config dictates whether to use outbound or inbound connections
if (config.has('drachtio.host')) {
  srf.connect(config.get('drachtio'));
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);
  });
}
else {
  logger.info(`listening for drachtio server traffic on ${JSON.stringify(config.get('drachtio'))}`);
  srf.listen(config.get('drachtio'));
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

// challenge calls from devices, let calls from sip gateways through
srf.use('invite', [challengeDeviceCalls]);

srf.invite((req, res) => {
  const session = new CallSession(logger, req, res);
  session.connect();
});

module.exports = {srf};
