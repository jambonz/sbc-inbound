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

module.exports = {
  fromInboundTrunk,
  isWSS,
  getAppserver
};
