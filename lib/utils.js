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
  const srctOpts = srcIsUsingSrtp ? srtpOpts : rtpCharacteristics;
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection']
  };
  return {
    common,
    uas: {
      tag: from.params.tag,
      mediaOpts: srctOpts
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

const makeCallCountKey = (sid) => `${sid}:incalls`;

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

module.exports = {
  isWSS,
  SdpWantsSrtp,
  getAppserver,
  makeRtpEngineOpts,
  makeCallCountKey,
  normalizeDID,
  equalsIgnoreOrder
};
