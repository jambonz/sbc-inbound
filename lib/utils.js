const config = require('config');
let idx = 0;

function fromInboundTrunk(req) {
  const trunks = config.has('trunks.inbound') ?
    config.get('trunks.inbound') : [];
  if (isWSS(req)) return false;
  const trunk = trunks.find((t) => t.host.includes(req.source_address));
  if (!trunk) return false;
  req.carrier_name = trunk.name;
  return true;
}

function isWSS(req) {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
}

function getAppserver() {
  const len = config.get('trunks.appserver').length;
  return config.get('trunks.appserver')[ idx++ % len];
}

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp) {
  const from = req.getParsedHeader('from');
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  const rtpCharacteristics = config.get('transcoding.rtpCharacteristics');
  const srtpCharacteristics = config.get('transcoding.srtpCharacteristics');
  return {
    common,
    offer: Object.assign({'sdp': req.body, 'replace': ['origin', 'session-connection']}, common,
      dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics),
    answer: Object.assign({}, common, srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics)
  };
}

module.exports = {
  fromInboundTrunk,
  isWSS,
  getAppserver,
  makeRtpEngineOpts
};
