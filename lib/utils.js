const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');
let idx = 0;

function isWSS(req) {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
}

function getAppserver(srf) {
  const len = srf.locals.featureServers.length;
  return srf.locals.featureServers[ idx++ % len];
}

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp, teams = false) {
  const srtpOpts = teams ? srtpCharacteristics['teams'] : srtpCharacteristics['default'];
  const from = req.getParsedHeader('from');
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  return {
    common,
    offer: Object.assign(
      {'sdp': req.body, 'replace': ['origin', 'session-connection']},
      common,
      dstIsUsingSrtp ? srtpOpts : rtpCharacteristics),
    answer: Object.assign(
      {'replace': ['origin', 'session-connection']},
      common,
      srcIsUsingSrtp ? srtpOpts : rtpCharacteristics)
  };
}

function SdpWantsSrtp(sdp) {
  return /m=audio.*SAVP/.test(sdp);
}

module.exports = {
  isWSS,
  SdpWantsSrtp,
  getAppserver,
  makeRtpEngineOpts
};
