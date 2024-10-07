const debug = require('debug')('jambonz:sbc-inbound');
const assert = require('assert');
const parseUri = require('drachtio-srf').parseUri;
const {nudgeCallCounts, roundTripTime, isMSTeamsCIDR} = require('./utils');
const digestChallenge = require('@jambonz/digest-utils');
const msProxyIps = process.env.MS_TEAMS_SIP_PROXY_IPS ?
  process.env.MS_TEAMS_SIP_PROXY_IPS.split(',').map((i) => i.trim()) :
  [];

const initCdr = (req) => {
  return {
    from: req.callingNumber,
    to: req.calledNumber,
    sip_callid: req.get('Call-ID'),
    duration: 0,
    attempted_at: Date.now(),
    direction: 'inbound',
    host: req.srf.locals.sipAddress,
    remote_host: req.source_address,
    answered: false
  };
};

module.exports = function(srf, logger) {

  const {
    lookupAppByTeamsTenant,
    lookupAccountBySipRealm,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid,
    queryCallLimits
  }  = srf.locals.dbHelpers;
  const {stats, writeCdrs} = srf.locals;

  const initLocals = (req, res, next) => {
    const callId = req.get('Call-ID');
    req.locals = req.locals || {callId};

    /* check if forwarded by a proxy that applied an X-Forwarded-For Header */
    if (req.has('X-Forwarded-For') || req.has('X-Subspace-Forwarded-For')) {
      const original_source_address = req.get('X-Forwarded-For') || req.get('X-Subspace-Forwarded-For');
      logger.info({
        callId: req.get('Call-ID'),
        original_source_address,
        proxy_source_address: req.source_address,
      }, 'overwriting source address for proxied SIP INVITE');
      req.source_address = original_source_address;
    }
    req.locals.cdr = initCdr(req);
    req.on('cancel', () => {
      logger.info({callId}, 'caller hungup before connecting to feature server');
      req.canceled = true;
      const tags = ['canceled:yes', 'sipStatus:487'];
      if (req.locals.originator) tags.push(`originator:${req.locals.originator}`);
      stats.increment('sbc.terminations', tags);
    });
    stats.increment('sbc.invites', ['direction:inbound']);

    /* write cdr for non-success response here */
    res.once('end', ({status}) => {
      if (req.locals.cdr && req.locals.cdr.account_sid && status > 200  && 401 !== status) {
        const trunk = ['trunk', 'teams'].includes(req.locals.originator) ? req.locals.carrier : req.locals.originator;
        writeCdrs({...req.locals.cdr,
          terminated_at: Date.now(),
          termination_reason: status === 487 === status ? 'caller abandoned' : 'failed',
          sip_status: status,
          trunk
        }).catch((err) => logger.error({err}, 'Error writing cdr for call failure'));
      }
    });

    next();
  };

  const handleSipRec = async(req, res, next) => {
    const {callId} = req.locals;
    if (Array.isArray(req.payload) && req.payload.length > 1) {
      const sdp = req.payload
        .find((p) => p.type === 'application/sdp')
        .content;
      if (!sdp) {
        logger.error({callId}, 'No SDP in multipart sdp');
        return res.send(503);
      }
      const xml = req.payload.find((p) => p.type !== 'application/sdp');
      const endPos = xml.content.indexOf('</recording>');
      xml.content = endPos !== -1 ?
        `${xml.content.substring(0, endPos + 12)}` :
        xml.content;
      logger.debug({callId, xml}, 'incoming call with SIPREC body');
      req.locals = {...req.locals, sdp, siprec: true, xml};
    }
    else req.locals = {...req.locals, sdp: req.body};
    next();
  };

  const identifyAccount = async(req, res, next) => {
    try {
      const {siprec, callId} = req.locals;
      const {getSPForAccount, wasOriginatedFromCarrier, getApplicationForDidAndCarrier, stats} = req.srf.locals;
      const startAt = process.hrtime();
      const {
        fromCarrier,
        gateway,
        account_sid,
        application_sid,
        service_provider_sid,
        account,
        error
      } = await wasOriginatedFromCarrier(req);
      const rtt = roundTripTime(startAt);
      stats.histogram('app.mysql.response_time', rtt, [
        'query:wasOriginatedFromCarrier', 'app:sbc-inbound']);
      /**
       * calls come from 3 sources:
       * (1) A carrier
       * (2) Microsoft Teams
       * (3) A SIP user
       */
      if (fromCarrier) {
        if (error) {
          return res.send(503, {
            headers: {
              'X-Reason': error
            }
          });
        }
        if (!gateway) {
          logger.info('identifyAccount: rejecting call from carrier because DID has not been provisioned');
          return res.send(404, 'Number Not Provisioned');
        }
        logger.info({gateway}, 'identifyAccount: incoming call from gateway');

        let sid;
        if (siprec) {
          if (!account.siprec_hook_sid) {
            logger.info({callId}, 'identifyAccount: rejecting call because SIPREC hook has not been provisioned');
            return res.send(404);
          }
          sid = account.siprec_hook_sid;
        }
        else {
          /* check for phone number level routing */
          sid = application_sid || await getApplicationForDidAndCarrier(req, gateway.voip_carrier_sid);
        }
        req.locals = {
          originator: 'trunk',
          carrier: gateway.name,
          gateway,
          voip_carrier_sid: gateway.voip_carrier_sid,
          application_sid: sid || gateway.application_sid,
          service_provider_sid,
          account_sid,
          account,
          ...req.locals
        };
      }
      else if (msProxyIps.includes(req.source_address) || isMSTeamsCIDR(req.source_address)) {
        logger.info({source_address: req.source_address}, 'identifyAccount: incoming call from Microsoft Teams');
        const uri = parseUri(req.uri);

        const app = await lookupAppByTeamsTenant(uri.host);
        if (!app) {
          stats.increment('sbc.terminations', ['sipStatus:404']);
          res.send(404, {headers: {'X-Reason': 'no configured application'}});
          return req.srf.endSession(req);
        }
        const service_provider_sid = await getSPForAccount(app.account_sid);
        req.locals = {
          originator: 'teams',
          carrier: 'Microsoft Teams',
          msTeamsTenantFqdn: uri.host,
          account_sid: app.account_sid,
          service_provider_sid,
          ...req.locals
        };
      }
      else {
        req.locals.originator = 'user';
        const uri = parseUri(req.uri);
        logger.info({source_address: req.source_address, realm: uri.host},
          'identifyAccount: incoming user call');
        const account = await lookupAccountBySipRealm(uri.host);
        if (!account) {
          stats.increment('sbc.terminations', ['sipStatus:404']);
          res.send(404);
          return req.srf.endSession(req);
        }

        /* if this is a dedicated SBC (static IP) only take calls for that account's sip realm */
        if (process.env.SBC_ACCOUNT_SID && account.account_sid !== process.env.SBC_ACCOUNT_SID) {
          logger.info(
            `identifyAccount: static IP for ${process.env.SBC_ACCOUNT_SID} but call for ${account.account_sid}`);
          stats.increment('sbc.terminations', ['sipStatus:404']);
          delete req.locals.cdr;
          res.send(404);
          return req.srf.endSession(req);
        }
        req.locals = {
          service_provider_sid: account.service_provider_sid,
          account_sid: account.account_sid,
          account,
          application_sid: account.device_calling_application_sid,
          webhook_secret: account.webhook_secret,
          realm: uri.host,
          ...(account.registration_hook && {
            registration_hook_url: account.registration_hook.url,
            registration_hook_method: account.registration_hook.method,
            registration_hook_username: account.registration_hook.username,
            registration_hook_password: account.registration_hook.password
          }),
          ...req.locals
        };
      }
      assert(req.locals.service_provider_sid);
      assert(req.locals.account_sid);
      req.locals.cdr.account_sid = req.locals.account_sid;

      if (!req.locals.account) {
        req.locals.account = await lookupAccountBySid(req.locals.account_sid);
      }
      req.locals.cdr.service_provider_sid = req.locals.account?.service_provider_sid;

      if (!req.locals.account.is_active) {
        stats.increment('sbc.terminations', ['sipStatus:503']);
        return res.send(503, {headers: {'X-Reason': 'Account exists but is inactive'}});
      }

      if (req.locals.account.disable_cdrs) {
        logger.info({account_sid: req.locals.account_sid}, 'Not writing CDRs for this account');
        delete req.locals.cdr;
      }

      req.locals.logger = logger.child({
        callId: req.get('Call-ID'),
        service_provider_sid: req.locals.service_provider_sid,
        account_sid: req.locals.account_sid
      }, {
        ...(req.locals.account.enable_debug_log && {level: 'debug'})
      });

      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} database error for inbound call`);
      res.send(500);
    }
  };

  const checkLimits = async(req, res, next) => {
    const trackingOn = process.env.JAMBONES_TRACK_ACCOUNT_CALLS ||
    process.env.JAMBONES_TRACK_SP_CALLS ||
    process.env.JAMBONES_TRACK_APP_CALLS;
    if (!process.env.JAMBONES_HOSTING && !trackingOn) return next(); // skip

    const {incrKey, decrKey} = req.srf.locals.realtimeDbHelpers;
    const {logger, account_sid, account, service_provider_sid, application_sid} = req.locals;
    const {writeCallCount, writeCallCountSP, writeCallCountApp, writeAlerts, AlertType} = req.srf.locals;
    assert(account_sid);
    assert(service_provider_sid);

    /* decrement count if INVITE is later rejected */
    res.once('end', async({status}) => {
      if (status > 200) {
        nudgeCallCounts(logger, {
          service_provider_sid,
          account_sid,
          application_sid
        }, decrKey, {writeCallCountSP, writeCallCount, writeCallCountApp})
          .catch((err) => logger.error(err, 'Error decrementing call counts'));
      }
    });

    try {
      /* increment the call count */
      const  {callsSP, calls} = await nudgeCallCounts(logger, {
        service_provider_sid,
        account_sid,
        application_sid
      }, incrKey, {writeCallCountSP, writeCallCount, writeCallCountApp});

      /* compare to account's limit, though avoid db hit when call count is low */
      const minLimit = process.env.MIN_CALL_LIMIT ?
        parseInt(process.env.MIN_CALL_LIMIT) :
        0;
      logger.debug(`checkLimits: call count is now ${calls}, limit is ${minLimit}`);
      if (calls <= minLimit) return next();

      if (process.env.JAMBONES_HOSTING) {
        const accountCapacities = await lookupAccountCapacitiesBySid(account_sid);
        const accountLimit = accountCapacities.find((c) => c.category == 'voice_call_session');
        if (accountLimit) {
          /* check account limit */
          const limit_sessions = accountLimit.quantity;
          if (calls > limit_sessions) {
            debug(`checkLimits: limits exceeded: call count ${calls}, limit ${limit_sessions}`);
            logger.info({calls, limit_sessions}, 'checkLimits: limits exceeded');
            writeAlerts({
              alert_type: AlertType.ACCOUNT_CALL_LIMIT,
              service_provider_sid: account.service_provider_sid,
              account_sid,
              count: limit_sessions
            }).catch((err) => logger.info({err}, 'checkLimits: error writing alert'));
            res.send(503, 'Maximum Calls In Progress');
            return req.srf.endSession(req);
          }
        }
      }
      else if (trackingOn) {
        const {account_limit, sp_limit} = await queryCallLimits(service_provider_sid, account_sid);
        if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS && account_limit > 0 && calls > account_limit) {
          logger.info({calls, account_limit}, 'checkLimits: account limits exceeded');
          writeAlerts({
            alert_type: AlertType.ACCOUNT_CALL_LIMIT,
            service_provider_sid: service_provider_sid,
            account_sid,
            count: account_limit
          }).catch((err) => logger.info({err}, 'checkLimits: error writing alert'));
          res.send(503, 'Max Account Calls In Progress', {
            headers: {
              'X-Account-Sid': account_sid,
              'X-Call-Limit': account_limit
            }
          });
          return req.srf.endSession(req);
        }
        if (process.env.JAMBONES_TRACK_SP_CALLS && sp_limit > 0 && callsSP > sp_limit) {
          logger.info({callsSP, sp_limit}, 'checkLimits: service provider limits exceeded');
          writeAlerts({
            alert_type: AlertType.SP_CALL_LIMIT,
            service_provider_sid: service_provider_sid,
            count: sp_limit
          }).catch((err) => logger.info({err}, 'checkLimits: error writing alert'));
          res.send(503, 'Max Service Provider Calls In Progress', {
            headers: {
              'X-Service-Provider-Sid': service_provider_sid,
              'X-Call-Limit': sp_limit
            }
          });
          return req.srf.endSession(req);
        }
      }
      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error({err}, 'error checking limits error for inbound call');
      res.send(500);
      req.srf.endSession(req);
    }
  };

  const challengeDeviceCalls = async(req, res, next) => {
    try {
      /* TODO: check if this is a gateway that we have an ACL for */
      if (req.locals.originator !== 'user') return next();
      return digestChallenge(req, res, next);
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} Error looking up related info for inbound call`);
      res.send(500);
      req.srf.endSession(req);
    }
  };

  return {
    initLocals,
    handleSipRec,
    challengeDeviceCalls,
    identifyAccount,
    checkLimits
  };
};
