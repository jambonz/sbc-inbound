const debug = require('debug')('jambonz:sbc-inbound');

module.exports = function(srf, logger) {
  const {lookupSipGatewayBySignalingAddress, lookupAuthHook}  = srf.locals.dbHelpers;
  const authenticator = require('jambonz-http-authenticator')(lookupAuthHook, logger, {blacklistUnknownRealms: true});
  const {stats, activeCallIds} = srf.locals;

  function initLocals(req, res, next) {
    req.locals = req.locals || {};
    const callId = req.get('Call-ID');
    req.on('cancel', () => {
      logger.info({callId}, 'caller hungup before connecting to feature server');
      req.canceled = true;
      const tags = ['canceled:yes', 'sipStatus:487'];
      if (req.locals.originator) tags.push(`originator:${req.locals.originator}`);
      stats.increment('sbc.terminations', tags);
      activeCallIds.delete(callId);
      stats.gauge('sbc.sip.calls.count', activeCallIds.size);
    });
    stats.increment('sbc.invites', ['direction:inbound']);
    next();
  }

  async function challengeDeviceCalls(req, res, next) {
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
      if (gateway.application_sid) req.locals.application_sid = gateway.application_sid;
      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} Error looking up related info for inbound call`);
      res.send(500);
    }
  }

  return {
    initLocals,
    challengeDeviceCalls
  };
};
