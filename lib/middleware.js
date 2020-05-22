const debug = require('debug')('jambonz:sbc-inbound');
const Emitter = require('events');
const parseUri = require('drachtio-srf').parseUri;
const msProxyIps = process.env.MS_TEAMS_SIP_PROXY_IPS ? process.env.MS_TEAMS_SIP_PROXY_IPS.split(',').map((i) => i.trim()) : [];

class AuthOutcomeReporter extends Emitter {
  constructor(stats) {
    super();
    this.on('regHookOutcome', ({rtt, status}) => {
      stats.histogram('app.hook.response_time', rtt, ['hook_type:auth', `status:${status}`]);
    });
  }
}

module.exports = function(srf, logger) {
  const {lookupSipGatewayBySignalingAddress, lookupAuthHook}  = srf.locals.dbHelpers;
  const {stats} = srf.locals;
  const authenticator = require('jambonz-http-authenticator')(lookupAuthHook, logger, {
    blacklistUnknownRealms: true,
    emitter: new AuthOutcomeReporter(stats)
  });

  function initLocals(req, res, next) {
    req.locals = req.locals || {};
    const callId = req.get('Call-ID');
    req.on('cancel', () => {
      logger.info({callId}, 'caller hungup before connecting to feature server');
      req.canceled = true;
      const tags = ['canceled:yes', 'sipStatus:487'];
      if (req.locals.originator) tags.push(`originator:${req.locals.originator}`);
      stats.increment('sbc.terminations', tags);
    });
    stats.increment('sbc.invites', ['direction:inbound']);
    next();
  }

  async function challengeDeviceCalls(req, res, next) {
    try {
      const gateway = await lookupSipGatewayBySignalingAddress(req.source_address, req.source_port);
      if (gateway) {
        debug(`challengeDeviceCalls: call came from gateway: ${JSON.stringify(gateway)}`);
        req.locals.originator = 'trunk';
        req.locals.carrier = gateway.name;
        if (gateway.application_sid) req.locals.application_sid = gateway.application_sid;
        return next();
      }
      if (msProxyIps.includes(req.source_address)) {
        logger.debug({source_address: req.source_address}, 'challengeDeviceCalls: incoming call from Microsoft Teams');
        const uri = parseUri(req.uri);
        req.locals.originator = 'teams';
        req.locals.carrier = 'Microsoft Teams';
        req.locals.msTeamsTenantFqdn = uri.host;
        return next();
      }
      req.locals.originator = 'device';
      return authenticator(req, res, next);
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
