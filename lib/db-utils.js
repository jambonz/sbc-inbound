const CIDRMatcher = require('cidr-matcher');
const {parseUri} = require('drachtio-srf');
const sqlSelectAllCarriersForAccountByRealm =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.sip_realm = ? 
AND vc.account_sid = acc.account_sid 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlCarriersForAccountBySid =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.account_sid = ? 
AND vc.account_sid = acc.account_sid 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlCarriersForSPByAccountSid =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc, service_providers sp  
WHERE acc.account_sid = ? 
AND sp.service_provider_sid = acc.service_provider_sid 
AND vc.service_provider_sid = sp.service_provider_sid  
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlAccountByRealm = 'SELECT * from accounts WHERE sip_realm = ?';

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
    const regex = /^\+(\d+)$/;
    const arr = regex.exec(req.calledNumber);
    const did = arr ? arr[1] : req.calledNumber;

    try {
      const [r] = await pp.query(sqlQueryApplicationByDid, [did, voip_carrier_sid]);
      if (0 === r.length) return null;
      return r[0].application_sid;
    } catch (err) {
      logger.error({err}, 'getApplicationForDidAndCarrier');
    }
  };

  const wasOriginatedFromCarrier = async(req) => {
    const uri = parseUri(req.uri);
    const isDotDecimal = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host);

    if (isDotDecimal) {
      /* on the hosted platform, only accounts that have a static IP should get incoming calls to an IP */
      if (process.env.JAMBONES_HOSTING && !process.env.SBC_ACCOUNT_SID) return null;

      /* look for carrier only within that account */
      const [r] = await pp.query(sqlCarriersForAccountBySid,
        [process.env.SBC_ACCOUNT_SID, req.source_address, req.source_port]);
      if (r.length) return r[0];

      /* look at the service provider level */
      const [r2] = await pp.query(sqlCarriersForSPByAccountSid,
        [process.env.SBC_ACCOUNT_SID, req.source_address, req.source_port]);
      if (r2.length) return r2[0];
      return null;
    }

    /* get all the carriers and gateways for the account owning this sip realm */
    const [gw] = await pp.query(sqlSelectAllCarriersForAccountByRealm, uri.host);
    if (0 === gw.length) return null;

    const selected = gw.find(gatewayMatchesSourceAddress.bind(null, req.source_address));
    if (selected) {
      const [a] = await pp.query(sqlAccountByRealm, uri.host);
      return selected ? {...selected, account: a[0]} : null;
    }
    return null;
  };

  return {
    wasOriginatedFromCarrier,
    getApplicationForDidAndCarrier
  };
};
