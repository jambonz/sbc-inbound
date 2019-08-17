const Srf = require('drachtio-srf');
const srf = new Srf();
const config = require('config');
const logger = require('pino')(config.get('logging'));
const {auth} = require('./lib/middleware');

// disable logging in test mode
if (process.env.NODE_ENV === 'test') {
  const noop = () => {};
  logger.info = logger.debug = noop;
  logger.child = () => {return {info: noop, error: noop, debug: noop};};
}

srf.listen(config.get('drachtio'));

srf.request('invite', auth);
srf.invite(require('./lib/invite')({logger}));

module.exports = {srf};
