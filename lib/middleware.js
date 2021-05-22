const debug = require('debug')('jambonz:sbc-inbound');
const assert = require('assert');
const Emitter = require('events');
const parseUri = require('drachtio-srf').parseUri;
const {makeCallCountKey} = require('./utils');
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
  class AuthOutcomeReporter extends Emitter {
    constructor(stats) {
      super();
      this
        .on('regHookOutcome', ({rtt, status}) => {
          stats.histogram('app.hook.response_time', rtt, ['hook_type:auth', `status:${status}`]);
        })
        .on('error', async(err, req) => {
          const {account_sid} = req.locals;
          const {writeAlerts, AlertType} = req.srf.locals;
          if (account_sid) {
            let opts = {account_sid};
            if (err.code === 'ECONNREFUSED') {
              opts = {...opts, alert_type: AlertType.WEBHOOK_CONNECTION_FAILURE, url: err.hook};
            }
            else if (err.code === 'ENOTFOUND') {
              opts = {...opts, alert_type: AlertType.WEBHOOK_CONNECTION_FAILURE, url: err.hook};
            }
            else if (err.name === 'StatusError') {
              opts = {...opts, alert_type: AlertType.WEBHOOK_STATUS_FAILURE, url: err.hook, status: err.statusCode};
            }

            if (opts.alert_type) {
              try {
                await writeAlerts(opts);
              } catch (err) {
                logger.error({err, opts}, 'Error writing alert');
              }
            }
          }
        });
    }
  }

  const {
    lookupAuthHook,
    lookupAppByTeamsTenant,
    lookupAccountBySipRealm,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid
  }  = srf.locals.dbHelpers;
  const {stats, writeCdrs} = srf.locals;
  const authenticator = require('@jambonz/http-authenticator')(lookupAuthHook, logger, {
    blacklistUnknownRealms: true,
    emitter: new AuthOutcomeReporter(stats)
  });
  const {wasOriginatedFromCarrier, getApplicationForDidAndCarrier} = require('./db-utils')(srf, logger);


  const initLocals = (req, res, next) => {
    req.locals = req.locals || {};
    req.locals.cdr = initCdr(req);
    const callId = req.get('Call-ID');
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

  const identifyAccount = async(req, res, next) => {
    try {

      const {fromCarrier, gateway, account_sid, application_sid, account} = await wasOriginatedFromCarrier(req);
      /**
       * calls come from 3 sources:
       * (1) A carrier
       * (2) Microsoft Teams
       * (3) A SIP user
       */
      if (fromCarrier) {
        if (!gateway) {
          logger.info('identifyAccount: rejecting call from carrier because DID has not been provisioned');
          return res.send(404, 'Number Not Provisioned');
        }
        logger.debug({gateway}, 'identifyAccount: incoming call from gateway');

        /* check for phone number level routing */
        const sid = application_sid || await getApplicationForDidAndCarrier(req, gateway.voip_carrier_sid);
        req.locals = {
          originator: 'trunk',
          carrier: gateway.name,
          application_sid: sid || gateway.application_sid,
          account_sid,
          account,
          ...req.locals
        };
      }
      else if (msProxyIps.includes(req.source_address)) {
        logger.debug({source_address: req.source_address}, 'identifyAccount: incoming call from Microsoft Teams');
        const uri = parseUri(req.uri);

        const app = await lookupAppByTeamsTenant(uri.host);
        if (!app) {
          stats.increment('sbc.terminations', ['sipStatus:404']);
          return res.send(404, {headers: {'X-Reason': 'no configured application'}});
        }

        req.locals = {
          originator: 'teams',
          carrier: 'Microsoft Teams',
          msTeamsTenantFqdn: uri.host,
          account_sid: app.account_sid,
          ...req.locals
        };
      }
      else {
        req.locals.originator = 'user';
        const uri = parseUri(req.uri);
        logger.debug({source_address: req.source_address, realm: uri.host},
          'identifyAccount: incoming user call');
        const account = await lookupAccountBySipRealm(uri.host);
        if (!account) {
          stats.increment('sbc.terminations', ['sipStatus:404']);
          return res.send(404);
        }

        /* if this is a dedicated SBC (static IP) only take calls for that account's sip realm */
        if (process.env.SBC_ACCOUNT_SID && account.account_sid !== process.env.SBC_ACCOUNT_SID) {
          logger.info(
            `identifyAccount: static IP for ${process.env.SBC_ACCOUNT_SID} but call for ${account.account_sid}`);
          stats.increment('sbc.terminations', ['sipStatus:404']);
          delete req.locals.cdr;
          return res.send(404);
        }
        req.locals = {
          account_sid: account.account_sid,
          account,
          webhook_secret: account.webhook_secret,
          ...req.locals
        };
      }
      assert(req.locals.account_sid);
      req.locals.cdr.account_sid = req.locals.account_sid;

      if (!req.locals.account) {
        req.locals.account = await lookupAccountBySid(req.locals.account_sid);
      }

      if (!req.locals.account.is_active) {
        stats.increment('sbc.terminations', ['sipStatus:503']);
        return res.send(503, {headers: {'X-Reason': 'Account exists but is inactive'}});
      }

      if (req.locals.account.disable_cdrs) {
        logger.info({account_sid: req.locals.account_sid}, 'Not writing CDRs for this account');
        delete req.locals.cdr;
      }

      req.locals.logger = logger.child({callId: req.get('Call-ID'), account_sid: req.locals.account_sid});

      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} database error for inbound call`);
      res.send(500);
    }
  };

  const checkLimits = async(req, res, next) => {
    if (!process.env.JAMBONES_HOSTING) return next(); // skip

    const {incrKey, decrKey} = req.srf.locals.realtimeDbHelpers;
    const {logger, account_sid} = req.locals;
    const {writeAlerts, AlertType} = req.srf.locals;
    assert(account_sid);
    const key = makeCallCountKey(account_sid);

    /* decrement count if INVITE is later rejected */
    res.once('end', ({status}) => {
      if (status > 200) {
        decrKey(key)
          .then((count) => {
            logger.debug({key}, `after rejection there are ${count} active calls for this account`);
            debug({key}, `after rejection there are ${count} active calls for this account`);
            return;
          })
          .catch((err) => logger.error({err}, 'checkLimits: decrKey err'));
      }
    });

    try {
      /* increment the call count */
      const calls = await incrKey(key);

      /* compare to account's limit, though avoid db hit when call count is low */
      const minLimit = process.env.MIN_CALL_LIMIT ?
        parseInt(process.env.MIN_CALL_LIMIT) :
        0;
      logger.debug(`checkLimits: call count is now ${calls}, limit is ${minLimit}`);
      if (calls <= minLimit) return next();

      const capacities = await lookupAccountCapacitiesBySid(account_sid);
      const limit = capacities.find((c) => c.category == 'voice_call_session');
      if (!limit) throw new Error('no account_capacities found');
      const limit_sessions = limit.quantity;
      if (calls > limit_sessions) {
        debug(`checkLimits: limits exceeded: call count ${calls}, limit ${limit_sessions}`);
        logger.info({calls, limit_sessions}, 'checkLimits: limits exceeded');
        writeAlerts({
          alert_type: AlertType.CALL_LIMIT,
          account_sid,
          count: limit_sessions
        }).catch((err) => logger.info({err}, 'checkLimits: error writing alert'));
        return res.send(503, 'Maximum Calls In Progress');
      }
      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error({err}, 'error checking limits error for inbound call');
      res.send(500);
    }
  };

  const challengeDeviceCalls = async(req, res, next) => {
    try {
      /* TODO: check if this is a gateway that we have an ACL for */
      if (req.locals.originator !== 'user') return next();
      return authenticator(req, res, next);
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} Error looking up related info for inbound call`);
      res.send(500);
    }
  };

  return {
    initLocals,
    challengeDeviceCalls,
    identifyAccount,
    checkLimits
  };
};
