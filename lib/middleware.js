const {fromInboundTrunk} = require('./utils');
const config = require('config');
const authenticator = require('drachtio-http-authenticator')(config.get('authCallback'));

function auth(req, res, next) {
  if (fromInboundTrunk) return next();
  authenticator(req, res, next);
}

module.exports = {
  auth
};
