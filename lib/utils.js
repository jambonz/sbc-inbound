const CIDRMatcher = require('cidr-matcher');
const express = require('express');
const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');

let idx = 0;

const isWSS = (req) => {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
};

const getAppserver = (srf) => {
  const len = srf.locals.featureServers.length;
  return srf.locals.featureServers[idx++ % len];
};

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp, teams = false) {
  const rtpCopy = JSON.parse(JSON.stringify(rtpCharacteristics));
  const srtpCopy = JSON.parse(JSON.stringify(srtpCharacteristics));
  const from = req.getParsedHeader('from');
  const srtpOpts = teams ? srtpCopy['teams'] : srtpCopy['default'];
  if ((req.locals.gateway?.pad_crypto || 0) > 0) {
    srtpOpts.flags.push('pad crypto');
  }
  const dstOpts = dstIsUsingSrtp ? srtpOpts : rtpCopy;
  const srcOpts = srcIsUsingSrtp ? srtpOpts : rtpCopy;

  /* Allow Feature server to inject DTMF to both leg except call from Teams */
  if (!teams) {
    dstOpts.flags.push('inject DTMF');
    srcOpts.flags.push('inject DTMF');
  }
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection'],
    'record call': process.env.JAMBONES_RECORD_ALL_CALLS ? 'yes' : 'no',
    ...(process.env.JAMBONES_ACCEPT_G729 && { codec: { mask: 'g729', transcode: 'pcmu' } })
  };
  return {
    common,
    uas: {
      tag: from.params.tag,
      mediaOpts: srcOpts
    },
    uac: {
      tag: null,
      mediaOpts: dstOpts
    }
  };
}

const SdpWantsSDES = (sdp) => {
  return /m=audio.*\s+RTP\/SAVP/.test(sdp);
};
const SdpWantsSrtp = (sdp) => {
  return /m=audio.*SAVP/.test(sdp);
};

const makeAccountCallCountKey = (sid) => `incalls:account:${sid}`;
const makeSPCallCountKey = (sid) => `incalls:sp:${sid}:`;
const makeAppCallCountKey = (sid) => `incalls:app${sid}:`;

const normalizeDID = (tel) => {
  const regex = /^\+(\d+)$/;
  const arr = regex.exec(tel);
  return arr ? arr[1] : tel;
};

const equalsIgnoreOrder = (a, b) => {
  if (a.length !== b.length) return false;
  const uniqueValues = new Set([...a, ...b]);
  for (const v of uniqueValues) {
    const aCount = a.filter((e) => e === v).length;
    const bCount = b.filter((e) => e === v).length;
    if (aCount !== bCount) return false;
  }
  return true;
};

const systemHealth = async(redisClient, ping, getCount) => {
  await Promise.all([redisClient.ping(), ping()]);
  return getCount();
};

const doListen = (logger, app, port, resolve) => {
  return app.listen(port, () => {
    logger.info(`Health check server listening on http://localhost:${port}`);
    resolve(app);
  });
};
const handleErrors = (logger, app, resolve, reject, e) => {
  if (e.code === 'EADDRINUSE' &&
    process.env.HTTP_PORT_MAX &&
    e.port < process.env.HTTP_PORT_MAX) {

    logger.info(`Health check server failed to bind port on ${e.port}, will try next port`);
    const server = doListen(logger, app, ++e.port, resolve);
    server.on('error', handleErrors.bind(null, logger, app, resolve, reject));
    return;
  }
  reject(e);
};


const createHealthCheckApp = (port, logger) => {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  return new Promise((resolve, reject) => {
    const server = doListen(logger, app, port, resolve);
    server.on('error', handleErrors.bind(null, logger, app, resolve, reject));
  });
};

const nudgeCallCounts = async(logger, sids, nudgeOperator, writers) => {
  const { service_provider_sid, account_sid, application_sid } = sids;
  const { writeCallCount, writeCallCountSP, writeCallCountApp } = writers;
  const nudges = [];
  const writes = [];

  if (process.env.JAMBONES_TRACK_SP_CALLS) {
    const key = makeSPCallCountKey(service_provider_sid);
    nudges.push(nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
    const key = makeAccountCallCountKey(account_sid);
    nudges.push(nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
    const key = makeAppCallCountKey(application_sid);
    nudges.push(nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  try {
    const [callsSP, calls, callsApp] = await Promise.all(nudges);
    logger.debug({
      calls, callsSP, callsApp,
      service_provider_sid, account_sid, application_sid
    }, 'call counts after adjustment');
    if (process.env.JAMBONES_TRACK_SP_CALLS) {
      writes.push(writeCallCountSP({ service_provider_sid, calls_in_progress: callsSP }));
    }

    if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
      writes.push(writeCallCount({ service_provider_sid, account_sid, calls_in_progress: calls }));
    }

    if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
      writes.push(writeCallCountApp({
        service_provider_sid,
        account_sid, application_sid,
        calls_in_progress: callsApp
      }));
    }

    /* write the call counts to the database */
    Promise.all(writes).catch((err) => logger.error({ err }, 'Error writing call counts'));

    return { callsSP, calls, callsApp };
  } catch (err) {
    logger.error(err, 'error incrementing call counts');
  }

  return { callsSP: null, calls: null, callsApp: null };
};

const roundTripTime = (startAt) => {
  const diff = process.hrtime(startAt);
  const time = diff[0] * 1e3 + diff[1] * 1e-6;
  return time.toFixed(0);
};

const parseConnectionIp = (sdp) => {
  const regex = /c=IN IP4 ([0-9.]+)/;
  const arr = regex.exec(sdp);
  return arr ? arr[1] : null;
};

/**
 * Checks if ip is one of MS Teams sip signalling ips
 * https://learn.microsoft.com/en-us/azure/communication-services/concepts
 * /telephony/direct-routing-infrastructure#sip-signaling-fqdns
 * @param ip IP address, example 172.31.0.1
 * */
const isMSTeamsCIDR = (ip) => {
  const cidrs = [
    '52.112.0.0/14',
    '52.120.0.0/14'
  ];
  const matcher = new CIDRMatcher(cidrs);
  return matcher.contains(ip);
};

const isPrivateVoipNetwork = (ip) => {
  const {srf, logger} = require('..');
  const {privateNetworkCidr} = srf.locals;
  if (privateNetworkCidr) {
    try {
      const matcher = new CIDRMatcher(privateNetworkCidr.split(','));
      return matcher.contains(ip);
    } catch (err) {
      logger.info({err, privateNetworkCidr},
        'Error checking private network CIDR, probably misconfigured must be a comma separated list of CIDRs');
    }
  }
  return false;
};

/**
 * @param hostports can be a string or an array of hostports
 */
const parseHostPorts = (logger, hostports, srf) => {
  typeof hostports === 'string' && (hostports = hostports.split(','));
  const obj = {};
  for (const hp of hostports) {
    const [, protocol, ipv4, port] = hp.match(/^(.*)\/(.*):(\d+)$/);
    if (protocol && ipv4 && port) {
      obj[protocol] = `${ipv4}:${port}`;
    }
  }
  if (!obj.tls) {
    obj.tls = `${srf.locals.sipAddress}:5061`;
  }

  if (!obj.tcp) {
    obj.tcp = `${srf.locals.sipAddress}:5060`;
  }

  logger.info({ obj }, 'sip endpoints');
  return obj;
};


module.exports = {
  isWSS,
  SdpWantsSrtp,
  SdpWantsSDES,
  getAppserver,
  makeRtpEngineOpts,
  makeAccountCallCountKey,
  makeSPCallCountKey,
  makeAppCallCountKey,
  normalizeDID,
  equalsIgnoreOrder,
  systemHealth,
  createHealthCheckApp,
  nudgeCallCounts,
  roundTripTime,
  parseConnectionIp,
  isMSTeamsCIDR,
  isPrivateVoipNetwork,
  parseHostPorts
};

