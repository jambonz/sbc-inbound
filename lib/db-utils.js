const assert = require('assert');
const CIDRMatcher = require('cidr-matcher');
const {parseUri} = require('drachtio-srf');
const {normalizeDID} = require('./utils');

const sqlSelectAllCarriersForAccountByRealm =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.sip_realm = ? 
AND vc.account_sid = acc.account_sid 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlSelectAllGatewaysForSP =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.service_provider_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc
WHERE sg.voip_carrier_sid = vc.voip_carrier_sid 
AND vc.service_provider_sid IS NOT NULL 
AND vc.is_active = 1`;

const sqlCarriersForAccountBySid =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.account_sid = ? 
AND vc.account_sid = acc.account_sid 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlAccountByRealm = 'SELECT * from accounts WHERE sip_realm = ?';
const sqlAccountBySid = 'SELECT * from accounts WHERE account_sid = ?';

const sqlQueryApplicationByDid = `
SELECT * FROM phone_numbers 
WHERE number = ? 
AND voip_carrier_sid = ?`;

const gatewayMatchesSourceAddress = (source_address, gw) => {
  if (32 === gw.netmask && gw.ipv4 === source_address) return true;
  if (gw.netmask < 32) {
    const matcher = new CIDRMatcher([`${gw.ipv4}/${gw.netmask}`]);
    return matcher.contains(source_address);
  }
  return false;
};

module.exports = (srf, logger) => {
  const {pool}  = srf.locals.dbHelpers;
  const pp = pool.promise();

  const getApplicationForDidAndCarrier = async(req, voip_carrier_sid) => {
    const did = normalizeDID(req.calledNumber);

    try {
      const [r] = await pp.query(sqlQueryApplicationByDid, [did, voip_carrier_sid]);
      if (0 === r.length) return null;
      return r[0].application_sid;
    } catch (err) {
      logger.error({err}, 'getApplicationForDidAndCarrier');
    }
  };

  const wasOriginatedFromCarrier = async(req) => {
    const failure = {fromCarrier: false};
    const uri = parseUri(req.uri);
    const isDotDecimal = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host);

    if (isDotDecimal) {
      if (process.env.JAMBONES_HOSTING) {
        if (!process.env.SBC_ACCOUNT_SID) return failure;

        /* look for carrier only within that account */
        const [r] = await pp.query(sqlCarriersForAccountBySid,
          [process.env.SBC_ACCOUNT_SID, req.source_address, req.source_port]);
        if (0 === r.length) return failure;
        return {fromCarrier: true, gateway: r[0], account_sid: process.env.SBC_ACCOUNT_SID};
      }
      else {
        /* we may have a carrier at the service provider level */
        const [gw] = await pp.query(sqlSelectAllGatewaysForSP);
        const matches = gw.filter(gatewayMatchesSourceAddress.bind(null, req.source_address));
        if (matches.length) {
          /* we have one or more carriers that match.  Now we need to find one with a provisioned phone number */
          const vc_sids = matches.map((m) => `'${m.voip_carrier_sid}'`).join(',');
          const did = normalizeDID(req.calledNumber);
          const sql =  `SELECT * FROM phone_numbers WHERE number = ${did} AND voip_carrier_sid IN (${vc_sids})`;
          logger.debug({matches, sql, did, vc_sids}, 'looking up DID');

          const [r] = await pp.query(sql);
          if (0 === r.length) {
            /* came from a carrier, but number is not provisioned */
            return {fromCarrier: true};
          }
          const gateway = matches.find((m) => m.voip_carrier_sid === r[0].voip_carrier_sid);
          const [accounts] = await pp.query(sqlAccountBySid, r[0].account_sid);
          assert(accounts.length);
          return {
            fromCarrier: true,
            gateway,
            account_sid: r[0].account_sid,
            application_sid: r[0].application_sid,
            account: accounts[0]
          };
        }
        return failure;
      }
    }

    /* get all the carriers and gateways for the account owning this sip realm */
    const [gw] = await pp.query(sqlSelectAllCarriersForAccountByRealm, uri.host);
    const selected = gw.find(gatewayMatchesSourceAddress.bind(null, req.source_address));
    if (selected) {
      const [a] = await pp.query(sqlAccountByRealm, uri.host);
      if (0 === a.length) return failure;
      return {
        fromCarrier: true,
        gateway: selected,
        account_sid: a[0].account_sid,
        application_sid: selected.application_sid,
        account: a[0]
      };
    }
    return failure;
  };

  return {
    wasOriginatedFromCarrier,
    getApplicationForDidAndCarrier
  };
};
