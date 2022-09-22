const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');
let idx = 0;

const isWSS = (req) => {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
};

const getAppserver = (srf) => {
  const len = srf.locals.featureServers.length;
  return srf.locals.featureServers[ idx++ % len];
};

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp, teams = false) {
  const from = req.getParsedHeader('from');
  const srtpOpts = teams ? srtpCharacteristics['teams'] : srtpCharacteristics['default'];
  const dstOpts = dstIsUsingSrtp ? srtpOpts : rtpCharacteristics;
  const srcOpts = srcIsUsingSrtp ? srtpOpts : rtpCharacteristics;

  /* webrtc clients (e.g. sipjs) send DMTF via SIP INFO */
  if ((srcIsUsingSrtp || dstIsUsingSrtp) && !teams) {
    dstOpts.flags.push('inject DTMF');
    srcOpts.flags.push('inject DTMF');
  }
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection']
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

const  systemHealth = async(redisClient, ping, getCount) => {
  await Promise.all([redisClient.ping(), ping()]);
  return getCount();
};

const createHealthCheckApp = (port, logger) => {
  const express = require('express');
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  return new Promise((resolve) => {
    app.listen(port, () => {
      logger.info(`Health check server started at http://localhost:${port}`);
      resolve(app);
    });
  });
};

const nudgeCallCounts = async(logger, sids, nudgeOperator, writers) => {
  const {service_provider_sid, account_sid, application_sid} = sids;
  const {writeCallCount, writeCallCountSP, writeCallCountApp} = writers;
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
      service_provider_sid, account_sid, application_sid}, 'call counts after adjustment');
    if (process.env.JAMBONES_TRACK_SP_CALLS) {
      writes.push(writeCallCountSP({service_provider_sid, calls_in_progress: callsSP}));
    }

    if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
      writes.push(writeCallCount({service_provider_sid, account_sid, calls_in_progress: calls}));
    }

    if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
      writes.push(writeCallCountApp({service_provider_sid, account_sid, application_sid, calls_in_progress: callsApp}));
    }

    /* write the call counts to the database */
    Promise.all(writes).catch((err) => logger.error({err}, 'Error writing call counts'));

    return {callsSP, calls, callsApp};
  } catch (err) {
    logger.error(err, 'error incrementing call counts');
  }

  return {callsSP: null, calls: null, callsApp: null};
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


module.exports = {
  isWSS,
  SdpWantsSrtp,
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
  parseConnectionIp
};
