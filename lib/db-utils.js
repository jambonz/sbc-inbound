const assert = require('assert');
const CIDRMatcher = require('cidr-matcher');
const {parseUri} = require('drachtio-srf');
const {normalizeDID} = require('./utils');

const sqlSelectSPForAccount = 'SELECT service_provider_sid FROM accounts WHERE account_sid = ?';

const sqlSelectAllCarriersForAccountByRealm =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask, sg.pad_crypto
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.sip_realm = ? 
AND vc.account_sid = acc.account_sid 
AND vc.is_active = 1 
AND sg.inbound = 1 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlSelectAllCarriersForSPByRealm =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask, sg.pad_crypto
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.sip_realm = ? 
AND vc.service_provider_sid = acc.service_provider_sid  
AND vc.account_sid IS NULL 
AND vc.is_active = 1 
AND sg.inbound = 1 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlSelectAllGatewaysForSP =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.service_provider_sid,  
vc.account_sid, vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask, sg.pad_crypto
FROM sip_gateways sg, voip_carriers vc
WHERE sg.voip_carrier_sid = vc.voip_carrier_sid 
AND vc.service_provider_sid IS NOT NULL 
AND vc.is_active = 1 
AND sg.inbound = 1`;

const sqlAccountByRealm = 'SELECT * from accounts WHERE sip_realm = ? AND is_active = 1';
const sqlAccountBySid = 'SELECT * from accounts WHERE account_sid = ?';
const sqlApplicationBySid = 'SELECT * from applications WHERE application_sid = ?';

const sqlQueryApplicationByDid = `
SELECT * FROM phone_numbers 
WHERE number = ? 
AND voip_carrier_sid = ?`;

const sqlQueryAllDidsForCarrier = `
SELECT * FROM phone_numbers 
WHERE voip_carrier_sid = ?`;

const sqlSelectOutboundGatewayForCarrier = `
SELECT ipv4, port, e164_leading_plus  
FROM sip_gateways sg, voip_carriers vc 
WHERE sg.voip_carrier_sid = ? 
AND sg.voip_carrier_sid = vc.voip_carrier_sid 
AND outbound = 1`;

const sqlSelectCarrierRequiringRegistration = `
SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.service_provider_sid, vc.account_sid, 
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask, sg.pad_crypto
FROM sip_gateways sg, voip_carriers vc 
WHERE sg.voip_carrier_sid = vc.voip_carrier_sid 
AND vc.requires_register = 1 
AND vc.is_active = 1 
AND vc.register_sip_realm = ? 
AND vc.register_username = ?`;

const gatewayMatchesSourceAddress = (logger, source_address, gw) => {
  if (32 === gw.netmask && gw.ipv4 === source_address) return true;
  if (gw.netmask < 32) {
    try {
      const matcher = new CIDRMatcher([`${gw.ipv4}/${gw.netmask}`]);
      return matcher.contains(source_address);
    } catch (err) {
      logger.info({err, gw}, 'gatewayMatchesSourceAddress: Error parsing netmask');
    }
  }
  return false;
};

module.exports = (srf, logger) => {
  const {pool}  = srf.locals.dbHelpers;
  const pp = pool.promise();

  const getApplicationBySid = async(application_sid) => {
    const [r] = await pp.query(sqlApplicationBySid, [application_sid]);
    if (0 === r.length) return null;
    return r[0];
  };

  const getSPForAccount = async(account_sid) => {
    const [r] = await pp.query(sqlSelectSPForAccount, [account_sid]);
    if (0 === r.length) return null;
    return r[0].service_provider_sid;
  };

  const getOutboundGatewayForRefer = async(voip_carrier_sid) => {
    try {
      const [r] = await pp.query(sqlSelectOutboundGatewayForCarrier, [voip_carrier_sid]);
      if (0 === r.length) return null;

      /* if multiple, prefer a DNS name */
      const hasDns = r.find((row) => row.ipv4.match(/^[A-Za-z]/));
      return hasDns /* || r[0] */;
    } catch (err) {
      logger.error({err}, 'getOutboundGatewayForRefer');
    }
  };

  /**
   * Retrieves the application for a given DID (phone number) and carrier combination.
   * First attempts an exact DID match, then falls back to pattern/wildcard matching
   * if no exact match is found. Pattern matching is done in order of pattern length
   * (longest/most specific first) and handles both regex and wildcard (*) patterns.
   *
   * @param {Object} req - The request object containing the called number
   * @param {string} voip_carrier_sid - The SID of the VoIP carrier
   * @returns {Promise<(string|Object|null)>} Returns either:
   *   - application_sid (string) if appObject is false
   *   - full application object if appObject is true
   *   - null if no matching application is found
   * @throws {Error} Database errors or other unexpected errors
   */
  // Refactored to handle invalid regular expressions gracefully as part of
  // https://github.com/jambonz/sbc-inbound/issues/201
  const getApplicationForDidAndCarrier = async(req, voip_carrier_sid) => {
    const did = normalizeDID(req.calledNumber) || 'anonymous';

    try {
      /* straight DID match */
      const [r] = await pp.query(sqlQueryApplicationByDid, [did, voip_carrier_sid]);
      if (r.length) return r[0].application_sid;

      /* wildcard / regex match */
      const [r2] = await pp.query(sqlQueryAllDidsForCarrier, [voip_carrier_sid]);
      const patterns = r2
        .filter((o) => o.number.match(/\D/))                  // look at anything with non-digit characters
        .sort((a, b) => b.number.length - a.number.length);
      for (const pattern of patterns) {
        try {
          const regexPattern = pattern.number.endsWith('*') ?
            `${pattern.number.slice(0, -1)}\\d*` :
            pattern.number;
          if (did.match(new RegExp(regexPattern))) {
            logger.debug({voip_carrier_sid, 'pattern':pattern.number, 'did':did}, 'Found a matching pattern');
            return pattern.application_sid;
          }
        } catch (err) {
          logger.warn({err, voip_carrier_sid, pattern: pattern.number}, 'Invalid regex pattern encountered - skipping');
          continue;
        }
      }
      logger.debug({voip_carrier_sid, did}, 'No matching pattern found');
      return null;
    } catch (err) {
      logger.error({err}, 'getApplicationForDidAndCarrier');
    }
  };

  /**
   * Searches for a matching application across multiple carriers using pattern/wildcard matching.
   * This function is similar to getApplicationForDidAndCarrier but operates on multiple carriers
   * simultaneously for better performance. It searches through all patterns from the specified
   * carriers, ordered by pattern length (longest/most specific first).
   *
   * @param {Object} req - The request object containing the called number
   * @param {string} voip_carrier_sids - Comma-separated string of carrier SIDs, formatted for SQL IN clause
   *                                     (e.g., "'carrier1','carrier2'")
   * @returns {Promise<Object|null>} Returns either:
   *   - The matching phone_numbers record containing application_sid, voip_carrier_sid, and account_sid
   *   - null if no matching pattern is found
   * @throws {Error} Database errors or other unexpected errors
   */
  const getApplicationForDidAndCarriers = async(req, voip_carrier_sids) => {
    const did = normalizeDID(req.calledNumber) || 'anonymous';
    const sql = `SELECT * FROM phone_numbers WHERE voip_carrier_sid IN (${voip_carrier_sids})`;

    try {
      /* wildcard / regex match */
      const [r2] = await pp.query(sql);
      const patterns = r2
        .filter((o) => o.number.match(/\D/))                  // look at anything with non-digit characters
        .sort((a, b) => b.number.length - a.number.length);
      for (const pattern of patterns) {
        try {
          const regexPattern = pattern.number.endsWith('*') ?
            `${pattern.number.slice(0, -1)}\\d*` :
            pattern.number;
          if (did.match(new RegExp(regexPattern))) {
            logger.debug({'pattern':pattern.number, 'did':did}, 'Found a matching pattern');
            return pattern;
          }
        } catch (err) {
          logger.warn({err, pattern: pattern.number}, 'Invalid regex pattern encountered - skipping');
          continue;
        }
      }
      logger.debug('No matching pattern found');
      return null;
    } catch (err) {
      logger.error({err}, 'getApplicationForDidAndCarriers');
    }
  };

  const wasOriginatedFromCarrier = async(req) => {
    const failure = {fromCarrier: false};
    const uri = parseUri(req.uri);
    const isDotDecimal = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host);
    const did = normalizeDID(req.calledNumber) || 'anonymous';
    if (!isDotDecimal) {
      /**
       * The host part of the SIP URI is not a dot-decimal IP address,
       * so this can be one of two things:
       * (1) a sip realm value associate with an account, or
       * (2) a carrier name for a carrier that we send outbound registrations to
       *
       * Let's look for case #1 first...
       */

      /* does anyone own this sip realm? */
      const [a] = await pp.query(sqlAccountByRealm, [uri.host]);
      if (a.length) {
        assert(a.length === 1);

        /* yes they do */
        logger.debug(`sip realm is associated with account_sid: ${a[0].account_sid}`);

        /**
         * We have one of two cases:
         * (1a). The user configured his or her carrier to send to their sip realm, or
         * (1b). The user is making a call from a sip device.
         */

        /* get all the carriers and gateways for the account owning this sip realm */
        const [gwAcc] = await pp.query(sqlSelectAllCarriersForAccountByRealm, [uri.host]);
        const [gwSP] = gwAcc.length ? [[]] : await pp.query(sqlSelectAllCarriersForSPByRealm, uri.host);
        const gw = gwAcc
          .concat(gwSP)
          .sort((a, b) => b.netmask - a.netmask);
        const gateways = gw.filter(gatewayMatchesSourceAddress.bind(null, logger, req.source_address));
        let voip_carriers = gateways.map((gw) => {
          return {
            voip_carrier_sid: gw.voip_carrier_sid,
            name: gw.name,
            service_provider_sid: gw.service_provider_sid,
            account_sid: gw.account_sid,
            application_sid: gw.application_sid
          };
        });
        /* remove duplicates, winnow down to voip_carriers, not gateways */
        if (voip_carriers.length > 1) {
          voip_carriers = [...new Set(voip_carriers.map(JSON.stringify))].map(JSON.parse);
        }
        if (voip_carriers.length) {
          /* we have one or more matches.  Now check for one with a provisioned phone number matching the DID */
          const vc_sids = voip_carriers.map((m) => `'${m.voip_carrier_sid}'`).join(',');
          const sql =
            `SELECT * FROM phone_numbers WHERE number = '${did}'
            AND voip_carrier_sid IN (${vc_sids})
            AND account_sid = '${a[0].account_sid}'`;
          logger.debug({voip_carriers, sql, did}, 'looking up DID');

          const [r] = await pp.query(sql);
          if (r.length === 0) {
            // if no matching phone number is found, find whether there are any applications having phone numbers
            // matching the regex pattern or wild card
            logger.debug({isDotDecimal},
              'Did not find a matching phone number, checking for applications with Regex or wildcard');
            const vc_sids = voip_carriers.map((m) => `'${m.voip_carrier_sid}'`).join(',');
            const application = await getApplicationForDidAndCarriers(req, vc_sids);
            if (application) {
              logger.debug({application}, 'sip_realm looking up DID: found application with Regex or wildcard ');
              const gateway = gateways.find((m) => m.voip_carrier_sid === application.voip_carrier_sid);
              // the gateway may belong to "all accounts", so we need to use the account_sid of the application
              gateway.account_sid = gateway.account_sid ? gateway.account_sid : application.account_sid;
              return {
                fromCarrier: true,
                gateway: gateway,
                service_provider_sid: a[0].service_provider_sid,
                account_sid: gateway.account_sid,
                application_sid: application.application_sid,
                account: a[0]
              };
            }
          }
          if (r.length > 1) {
            logger.info({r},
              'multiple carriers with the same gateway have the same number provisioned for the same account'
              + ' -- cannot determine which one to use');
            return {
              fromCarrier: true,
              error: 'Multiple carriers with the same gateway are attempting to route the same number for this account'
            };
          }

          /**
           * We have one or no routes for this phone number, carrier and account combination
           * Either take the matching gateway, or if no route has matched, the first gateway of the ones available.
          */
          const gateway = r[0] ? gateways.find((m) => m.voip_carrier_sid === r[0]?.voip_carrier_sid) : gateways[0];
          return {
            fromCarrier: true,
            gateway: gateway,
            service_provider_sid: a[0].service_provider_sid,
            account_sid: a[0].account_sid,
            application_sid: r[0]?.application_sid || gateway.application_sid,
            account: a[0]
          };
        }
        return failure;
      }


      /* no match, so let's look for case #2 */
      try {
        logger.info({
          host: uri.host,
          user: uri.user
        }, 'sip realm is not associated with an account, checking carriers');
        const [gw] = await pp.query(sqlSelectCarrierRequiringRegistration, [uri.host, uri.user]);
        const matches = gw
          .sort((a, b) => b.netmask - a.netmask)
          .filter(gatewayMatchesSourceAddress.bind(null, logger, req.source_address));
        if (1 === matches.length) {
          // bingo
          //TODO: this assumes the carrier is associate to an account, not an SP
          //if the carrier is associated with an SP (which would mean we
          //must see a dialed number in the To header, not the register username),
          //then we need to look up the account based on the dialed number in the To header
          const [a] = await pp.query(sqlAccountBySid, [[matches[0].account_sid]]);
          if (0 === a.length) return failure;
          logger.debug({matches}, `found registration carrier using ${uri.host} and ${uri.user}`);
          const sql =
            `SELECT application_sid FROM phone_numbers WHERE number = '${did}'
            AND voip_carrier_sid = '${matches[0].voip_carrier_sid}'
            AND account_sid = '${matches[0].account_sid}'`;
          logger.debug({matches: matches[0], sql, did}, 'looking up DID');

          const [r] = await pp.query(sql);
          return {
            fromCarrier: true,
            gateway: matches[0],
            service_provider_sid: a[0].service_provider_sid,
            account_sid: a[0].account_sid,
            application_sid: r[0]?.application_sid || matches[0].application_sid,
            account: a[0]
          };
        }
        else if (matches.length > 1) {
          logger.warn({matches, source_address: req.source_address}, 'multiple gateways match source address');
          return {
            fromCarrier: true,
            error: 'Multiple gateways match registration carrier source address'
          };
        }
      } catch (err) {
        logger.info({err, host: uri.host, user: uri.user}, 'Error looking up carrier by host and user');
      }
      /* no match, so fall through  */
    }

    /* find all carrier entries that have an inbound gateway matching the source IP */
    const [gw] = await pp.query(sqlSelectAllGatewaysForSP);
    //logger.debug({gw}, `checking gateways for source address ${req.source_address}`);
    let matches = gw
      .sort((a, b) => b.netmask - a.netmask)
      .filter(gatewayMatchesSourceAddress.bind(null, logger, req.source_address))
      .map((gw) => {
        return {
          voip_carrier_sid: gw.voip_carrier_sid,
          name: gw.name,
          service_provider_sid: gw.service_provider_sid,
          account_sid: gw.account_sid,
          application_sid: gw.application_sid,
          pad_crypto: gw.pad_crypto
        };
      });
    /* remove duplicates, winnow down to voip_carriers, not gateways */
    if (matches.length > 1) {
      matches = [...new Set(matches.map(JSON.stringify))].map(JSON.parse);
    }
    //logger.debug({matches}, `matches for source address ${req.source_address}`);
    if (matches.length) {
      /* we have one or more matches.  Now check for one with a provisioned phone number matching the DID */
      const vc_sids = matches.map((m) => `'${m.voip_carrier_sid}'`).join(',');
      const sql =  `SELECT * FROM phone_numbers WHERE number = '${did}' AND voip_carrier_sid IN (${vc_sids})`;
      logger.debug({matches, sql, did, vc_sids}, 'looking up DID');
      const [r] = await pp.query(sql);
      if (0 === r.length) {
        // if no matching phone number is found, find whether there are any applications having phone numbers
        // matching the regex pattern or wild card
        logger.debug({isDotDecimal},
          'Did not find a matching phone number, checking for applications with Regex or wildcard');
        const vc_sids = matches.map((m) => `'${m.voip_carrier_sid}'`).join(',');
        const application = await getApplicationForDidAndCarriers(req, vc_sids);
        if (application) {
          logger.debug({application}, 'looking up DID: found application with Regex or wildcard');
          const gateway = matches.find((m) => m.voip_carrier_sid === application.voip_carrier_sid);
          // the gateway may belong to "all accounts", so we need to use the account_sid of the application
          const [a] = await pp.query(sqlAccountBySid, [application.account_sid]);
          return {
            fromCarrier: true,
            gateway: gateway,
            service_provider_sid: gateway.service_provider_sid,
            account_sid: application.account_sid,
            application_sid: application.application_sid,
            account: a[0],
          };
        }

        /* came from a provisioned carrier, but the dialed number is not provisioned.
            check if we have an account with default routing of that carrier to an application
        */
        const accountLevelGateways = matches.filter((m) => m.account_sid && m.application_sid);
        if (accountLevelGateways.length > 1) {
          logger.info({accounts: accountLevelGateways.map((m) => m.account_sid)},
            'multiple accounts have added this carrier with default routing -- cannot determine which to use');
          return {
            fromCarrier: true,
            error: 'Multiple accounts are attempting to default route this carrier'
          };
        }
        else if (accountLevelGateways.length === 1) {
          const [accounts] = await pp.query('SELECT * from accounts where account_sid = ?',
            [accountLevelGateways[0].account_sid]);
          return {
            fromCarrier: true,
            gateway: accountLevelGateways[0],
            service_provider_sid: accountLevelGateways[0].service_provider_sid,
            account_sid: accountLevelGateways[0].account_sid,
            application_sid: accountLevelGateways[0].application_sid,
            account: accounts[0]
          };
        }
        else {
          /* check if we only have a single account, otherwise we have no
-               way of knowing which account this is for
          */
          const [r] = await pp.query('SELECT count(*) as count from accounts where service_provider_sid = ?',
            [matches[0].service_provider_sid]);
          if (r[0].count === 0 || r[0].count > 1) return {fromCarrier: true};
          else {
            const [accounts] = await pp.query('SELECT * from accounts where service_provider_sid = ?',
              [matches[0].service_provider_sid]);
            return {
              fromCarrier: true,
              gateway: matches[0],
              service_provider_sid: accounts[0].service_provider_sid,
              account_sid: accounts[0].account_sid,
              account: accounts[0]
            };
          }
        }
      }
      else if (r.length > 1) {
        logger.info({r},
          'multiple accounts have added this carrier with default routing -- cannot determine which to use');
        return {
          fromCarrier: true,
          error: 'Multiple accounts are attempting to route the same phone number from the same carrier'
        };
      }

      /* we have a route for this phone number and carrier combination */
      const gateway = matches.find((m) => m.voip_carrier_sid === r[0].voip_carrier_sid);
      const [accounts] = await pp.query(sqlAccountBySid, [r[0].account_sid]);
      assert(accounts.length);
      return {
        fromCarrier: true,
        gateway,
        service_provider_sid: accounts[0].service_provider_sid,
        account_sid: r[0].account_sid,
        application_sid: r[0].application_sid,
        account: accounts[0]
      };
    }
    return failure;
  };

  return {
    wasOriginatedFromCarrier,
    getApplicationForDidAndCarrier,
    getApplicationForDidAndCarriers,
    getOutboundGatewayForRefer,
    getSPForAccount,
    getApplicationBySid
  };
};
