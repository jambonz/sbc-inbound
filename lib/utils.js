const config = require('config');
let idx = 0;

function fromInboundTrunk(req) {
  const trunks = config.has('trunks.inbound') ?
    config.get('trunks.inbound') : [];
  if (isWSS(req)) return false;
  return trunks.find((trunk) => trunk.host.includes(req.source_address));
}

function isWSS(req) {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
}

function getAppserver() {
  const len = config.get('trunks.appserver').length;
  return config.get('trunks.appserver')[ idx++ % len];
}

module.exports = {
  fromInboundTrunk,
  isWSS,
  getAppserver
};
