const debug = require('debug')('jambonz:sbc-inbound');

module.exports = function(srf, logger) {
  const {lookupSipGatewayBySignalingAddress, lookupAuthHook}  = srf.locals.dbHelpers;
  const authenticator = require('jambonz-http-authenticator')(lookupAuthHook, logger);

  async function challengeDeviceCalls(req, res, next) {
    req.locals = req.locals || {};
    try {
      const gateway = await lookupSipGatewayBySignalingAddress(req.source_address, req.source_port);
      if (!gateway) {
        // TODO: if uri.host is not a domain, just reject
        req.locals.originator = 'device';
        return authenticator(req, res, next);
      }
      debug(`challengeDeviceCalls: call came from gateway: ${JSON.stringify(gateway)}`);
      req.locals.originator = 'trunk';
      req.locals.carrier = gateway.name;
      next();
    } catch (err) {
      logger.error(err, `${req.get('Call-ID')} Error looking up related info for inbound call`);
      res.send(500);
    }
  }

  return {
    challengeDeviceCalls
  };
};
